"""Core platform regressions: transactions, pool exhaustion, readiness, client IP,
login timing, session tokens, production secret, audit PII, upload bounds, indexes,
legacy LLM budget guard."""
import base64
import hashlib
import hmac
import inspect
import json
import os
import sys
import tempfile
import time
import uuid

os.environ.setdefault("DB_PATH", os.path.join(tempfile.mkdtemp(prefix="sb_core_platform_"), "test.db"))
os.environ.setdefault("PBKDF2_ITERATIONS", "1000")
os.environ["SEED_DEMO"] = "false"
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from starlette.requests import Request

import main

client = TestClient(main.app)
PASSWORD = "Str0ng-Passw0rd-2026"


def register():
    email = uuid.uuid4().hex + "@example.com"
    response = client.post("/api/auth/register", json={"email": email, "name": "Core Platform", "password": PASSWORD})
    assert response.status_code == 200, response.text
    uid = main.one("SELECT id FROM users WHERE email=?", (email,))["id"]
    return email, uid, {"Authorization": "Bearer " + response.json()["token"]}


# ------------------------------------------------------------------ 2. transactions
class _FakeCursor:
    rowcount = 1

    def fetchone(self):
        return {"id": 1}


class _FakeConn:
    def __init__(self):
        self.statements = []
        self.closed = False

    def execute(self, sql, args=()):
        self.statements.append(sql.strip().split()[0].upper() if sql.strip() else sql)
        return _FakeCursor()

    def close(self):
        self.closed = True


def test_transaction_issues_begin_commit_on_postgres(monkeypatch):
    fake = _FakeConn()
    monkeypatch.setattr(main, "DATABASE_URL", "postgresql://fake")
    monkeypatch.setattr(main, "db", lambda: fake)
    with main.transaction() as conn:
        conn.execute("SELECT id FROM users WHERE id=? FOR UPDATE", (1,))
        conn.execute("INSERT INTO attempts(id) VALUES (?)", ("a",))
    assert fake.statements == ["BEGIN", "SELECT", "INSERT", "COMMIT"]
    assert fake.closed


def test_transaction_rolls_back_on_http_error_on_postgres(monkeypatch):
    fake = _FakeConn()
    monkeypatch.setattr(main, "DATABASE_URL", "postgresql://fake")
    monkeypatch.setattr(main, "db", lambda: fake)
    with pytest.raises(HTTPException):
        with main.transaction() as conn:
            conn.execute("SELECT 1")
            raise HTTPException(409, "active_attempt_exists")
    assert fake.statements == ["BEGIN", "SELECT", "ROLLBACK"]
    assert fake.closed


def test_transaction_rolls_back_on_sqlite():
    key = "core-tx-" + uuid.uuid4().hex
    with pytest.raises(HTTPException):
        with main.transaction() as conn:
            conn.execute("INSERT INTO auth_throttle(key,failures) VALUES (?,1)", (key,))
            raise HTTPException(409, "boom")
    assert main.one("SELECT 1 AS x FROM auth_throttle WHERE key=?", (key,)) is None
    with main.transaction() as conn:
        conn.execute("INSERT INTO auth_throttle(key,failures) VALUES (?,1)", (key,))
    assert main.one("SELECT 1 AS x FROM auth_throttle WHERE key=?", (key,)) is not None


def test_pool_exhaustion_returns_503_without_unpooled_connection(monkeypatch):
    class _Pool:
        def getconn(self, timeout=None):
            raise TimeoutError("pool exhausted")

    import psycopg
    monkeypatch.setattr(main, "DATABASE_URL", "postgresql://fake")
    monkeypatch.setattr(main, "_connection_pool", lambda: _Pool())
    monkeypatch.setattr(psycopg, "connect", lambda *a, **k: pytest.fail("must not open an unpooled connection"))
    with pytest.raises(HTTPException) as raised:
        main.db()
    assert raised.value.status_code == 503
    assert main.PG_POOL_MAX >= 2 and main.PG_POOL_TIMEOUT_SECONDS <= 15


# ------------------------------------------------------------------ 15. readiness
def test_ready_reports_database_state(monkeypatch):
    assert client.get("/api/health").status_code == 200
    ok = client.get("/api/ready")
    assert ok.status_code == 200 and ok.json()["ready"] is True

    def broken():
        raise RuntimeError("database down")
    monkeypatch.setattr(main, "_database_ping", broken)
    down = client.get("/api/ready")
    assert down.status_code == 503 and down.json()["ready"] is False


# ------------------------------------------------------------------ 16. client IP
def _request(xff=None, peer="10.0.0.9"):
    headers = [(b"x-forwarded-for", xff.encode())] if xff is not None else []
    return Request({"type": "http", "headers": headers, "client": (peer, 1234), "method": "GET", "path": "/"})


def test_client_ip_ignores_spoofed_left_entries(monkeypatch):
    monkeypatch.delenv("TRUSTED_PROXY_HOPS", raising=False)
    assert main._client_ip(_request("6.6.6.6, 203.0.113.7")) == "203.0.113.7"
    monkeypatch.setenv("TRUSTED_PROXY_HOPS", "2")
    assert main._client_ip(_request("6.6.6.6, 203.0.113.7, 10.1.1.1")) == "203.0.113.7"
    assert main._client_ip(_request("203.0.113.7")) == "10.0.0.9"  # fewer entries than hops
    monkeypatch.setenv("TRUSTED_PROXY_HOPS", "0")
    assert main._client_ip(_request("6.6.6.6")) == "10.0.0.9"
    monkeypatch.setenv("TRUSTED_PROXY_HOPS", "1")
    assert main._client_ip(_request()) == "10.0.0.9"


# ------------------------------------------------------------------ 17 + 19. login
def test_unknown_email_login_still_runs_password_hash_and_audits_a_hash(monkeypatch):
    calls = []
    original = main.SEC.verify_password

    def counting(stored, password, legacy_salt=None):
        calls.append(stored)
        return original(stored, password, legacy_salt)
    monkeypatch.setattr(main.SEC, "verify_password", counting)
    email = "nobody-" + uuid.uuid4().hex + "@Example.com"
    response = client.post("/api/auth/login", json={"email": email, "password": "wrong-password-1"})
    assert response.status_code == 401
    assert len(calls) == 1 and calls[0].startswith(main.SEC._SCHEME)
    row = main.one("SELECT target FROM audit WHERE action='login_failed' ORDER BY id DESC LIMIT 1")
    assert email.lower() not in row["target"] and "@" not in row["target"]
    assert row["target"] == main.email_fingerprint(email)
    assert row["target"] == "email-sha256:" + hashlib.sha256(email.lower().encode()).hexdigest()[:16]


# ------------------------------------------------------------------ 18. tokens + secret
def test_token_without_session_id_is_rejected():
    _email, uid, headers = register()
    assert client.get("/api/state", headers=headers).status_code == 200
    payload = {"uid": uid, "mfa": False, "exp": time.time() + 3600}  # no "sid"
    body = base64.urlsafe_b64encode(json.dumps(payload).encode()).decode()
    token = body + "." + hmac.new(main.SECRET.encode(), body.encode(), hashlib.sha256).hexdigest()
    response = client.get("/api/state", headers={"Authorization": "Bearer " + token})
    assert response.status_code == 401


def test_issued_tokens_always_carry_a_session_id():
    _email, uid, _headers = register()
    token = main.make_token(uid)
    data = json.loads(base64.urlsafe_b64decode(token.split(".")[0]))
    assert data["sid"] and main.one("SELECT id FROM auth_sessions WHERE id=?", (data["sid"],))


def test_production_refuses_weak_or_placeholder_secret(monkeypatch):
    assert main._production_secret_problem("") and main._production_secret_problem(None)
    assert main._production_secret_problem("change-me-to-a-long-random-string")
    assert main._production_secret_problem("short-secret")
    assert main._production_secret_problem("x" * 40) is None
    monkeypatch.setattr(main, "IS_PRODUCTION", True)
    monkeypatch.setenv("SECRET_KEY", main.SECRET_KEY_PLACEHOLDER)
    with pytest.raises(RuntimeError):
        main._secret()
    monkeypatch.delenv("SECRET_KEY")
    with pytest.raises(RuntimeError):
        main._secret()
    monkeypatch.setenv("SECRET_KEY", "k" * 48)
    assert main._secret() == "k" * 48


# ------------------------------------------------------------------ 11. blocking work
def test_upload_endpoints_do_not_run_on_the_event_loop():
    for endpoint in (main.upload_cv, main.upload_cv_profile, main.update_cv_profile, main.upload_exam_evidence):
        assert not inspect.iscoroutinefunction(endpoint), endpoint.__name__


def test_legacy_cv_upload_is_bounded_to_5mb():
    _email, uid, headers = register()
    assert client.post("/api/consent", json={"lang": "en"}, headers=headers).status_code == 200
    big = b"a" * (main.MAX_CV_UPLOAD_BYTES + 10)
    response = client.post("/api/cv", files={"file": ("cv.txt", big, "text/plain")}, headers=headers)
    assert response.status_code == 413


# ------------------------------------------------------------------ 14. indexes
def test_hot_path_indexes_exist():
    names = {r["name"] for r in main.allr("SELECT indexname AS name FROM pg_indexes" if main.DATABASE_URL else "SELECT name FROM sqlite_master WHERE type='index'")}
    for index in ("idx_consents_user_version", "idx_auth_sessions_user", "idx_passports_user",
                  "idx_exam_evidence_expires", "idx_exam_evidence_attempt"):
        assert index in names, index


# ------------------------------------------------------------------ 20. read_upload footer
def test_read_upload_strips_the_link_footer():
    text = ("Rahim Uddin\nData engineer with Python and SQL experience.\n"
            "Portfolio: https://github.com/rahim and www.example.org/me\n").encode()
    out = main.read_upload("cv.txt", text)
    assert "LINKS FOUND IN DOCUMENT" not in out
    assert "Python and SQL" in out


# ------------------------------------------------------------------ 21. llm budget
def test_legacy_llm_extract_respects_ai_budget(monkeypatch):
    import ai_routing
    monkeypatch.setattr(ai_routing, "can_spend", lambda cost: False)
    monkeypatch.setattr(main.httpx, "post", lambda *a, **k: pytest.fail("no paid call over budget"))
    assert main.llm_extract("[NAME]\nPython and SQL") is None


def test_legacy_llm_extract_records_usage(monkeypatch):
    import ai_routing
    recorded = []
    monkeypatch.setattr(ai_routing, "can_spend", lambda cost: True)
    monkeypatch.setattr(ai_routing, "record_usage", lambda *a, **k: recorded.append((a, k)))

    class _Resp:
        def raise_for_status(self):
            pass

        def json(self):
            return {"usage": {"input_tokens": 120, "output_tokens": 30},
                    "content": [{"text": json.dumps({"skills": []})}]}
    monkeypatch.setattr(main.httpx, "post", lambda *a, **k: _Resp())
    main.llm_extract("[NAME]\nPython and SQL")
    assert recorded and recorded[0][0][0] == "anthropic" and recorded[0][0][2] == 120


def test_postgres_real_columns_are_promoted_to_double_precision():
    """On PostgreSQL no timestamp column may stay a 4-byte REAL (128 s resolution)."""
    if not main.DATABASE_URL:
        assert main.promote_real_columns_to_double() == []
        return
    rows = main.allr("SELECT table_name, column_name FROM information_schema.columns "
                     "WHERE table_schema=current_schema() AND data_type='real' AND table_name IN "
                     "(SELECT table_name FROM information_schema.columns WHERE table_schema=current_schema() "
                     "GROUP BY table_name HAVING SUM(CASE WHEN data_type='bytea' THEN 1 ELSE 0 END)=0)")
    assert rows == []
