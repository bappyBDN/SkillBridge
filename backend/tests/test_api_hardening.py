"""API hardening checks: password policy, throttling, revocation, privacy (SB-003/004/007/008/011)."""
import os
import sys
import tempfile
import time

_TMP = tempfile.mkdtemp(prefix="sb_api_")
os.environ.setdefault("DB_PATH", os.path.join(_TMP, "test.db"))
os.environ["SEED_DEMO"] = "false"
# Hashing cost is exercised by test_security.py; keep the API suite fast.
os.environ.setdefault("PBKDF2_ITERATIONS", "1000")
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from fastapi.testclient import TestClient
import identity as ID
import main

client = TestClient(main.app)

STRONG = "Str0ng-Passw0rd-2026"


def _register(email, name="Test Candidate", password=STRONG, role="candidate"):
    return client.post("/api/auth/register", json={"email": email, "name": name,
                                                   "password": password, "role": role})


def _token(email, password=STRONG):
    r = client.post("/api/auth/login", json={"email": email, "password": password})
    assert r.status_code == 200, r.text
    return r.json()["token"]


def _headers(token):
    return {"Authorization": "Bearer " + token}


def test_weak_password_is_rejected():
    r = _register("weak@example.com", password="password123")
    assert r.status_code == 422
    assert "common" in r.text.lower() or "symbol" in r.text.lower() or "12" in r.text


def test_short_password_is_rejected():
    assert _register("short@example.com", password="Ab1!xy").status_code == 422


def test_registration_never_reveals_an_existing_account():
    first = _register("dup@example.com")
    assert first.status_code == 200 and first.json().get("token")
    second = _register("dup@example.com")
    assert second.status_code == 200
    assert "token" not in second.json()
    assert "already" not in second.text.lower()


def test_login_is_throttled_after_repeated_failures():
    main.run("DELETE FROM auth_throttle")
    _register("throttle@example.com")
    for _ in range(5):
        r = client.post("/api/auth/login", json={"email": "throttle@example.com", "password": "Wr0ng-Passw0rd!!"})
        assert r.status_code == 401
    locked = client.post("/api/auth/login", json={"email": "throttle@example.com", "password": "Wr0ng-Passw0rd!!"})
    assert locked.status_code == 429
    main.run("DELETE FROM auth_throttle")


def test_a_revoked_session_stops_working_immediately():
    main.run("DELETE FROM auth_throttle")
    _register("logout@example.com")
    token = _token("logout@example.com")
    assert client.get("/api/state", headers=_headers(token)).status_code == 200
    assert client.post("/api/auth/logout", headers=_headers(token)).status_code == 200
    assert client.get("/api/state", headers=_headers(token)).status_code == 401
    main.run("DELETE FROM auth_throttle")


def test_password_hash_is_upgraded_on_login():
    _register("rehash@example.com", password="Legacy-Passw0rd-2026")
    row = main.one("SELECT id, salt, pw_hash FROM users WHERE email=?", ("rehash@example.com",))
    import hashlib
    legacy = hashlib.pbkdf2_hmac("sha256", b"Legacy-Passw0rd-2026", bytes.fromhex(row["salt"]), 200_000).hex()
    main.run("UPDATE users SET pw_hash=? WHERE id=?", (legacy, row["id"]))
    assert client.post("/api/auth/login", json={"email": "rehash@example.com",
                                                "password": "Legacy-Passw0rd-2026"}).status_code == 200
    upgraded = main.one("SELECT pw_hash FROM users WHERE id=?", (row["id"],))["pw_hash"]
    assert upgraded.startswith("pbkdf2_sha256$")


def test_account_deletion_removes_every_linked_row():
    _register("privacy@example.com")
    token = _token("privacy@example.com")
    headers = _headers(token)
    assert client.post("/api/consent", json={"lang": "en"}, headers=headers).status_code == 200
    uid = main.one("SELECT id FROM users WHERE email=?", ("privacy@example.com",))["id"]
    main.run("INSERT INTO profiles(user_id,redacted) VALUES (?,?)", (uid, "cv text"))
    main.run("INSERT INTO passports(id,user_id,payload,signature,created) VALUES (?,?,?,?,?)",
             ("psp-test", uid, "{}", "sig", time.time()))
    export = client.get("/api/me/export", headers=headers)
    assert export.status_code == 200
    assert export.json()["profiles"], "export must include CV profile data"

    assert client.delete("/api/me", headers=headers).status_code == 200
    assert main.one("SELECT id FROM users WHERE id=?", (uid,)) is None
    for table, column, _label in main._registry_tables():
        row = main.one(f"SELECT COUNT(*) AS n FROM {table} WHERE {column}=?", (uid,))
        assert (row["n"] if row else 0) == 0, f"{table} still references the deleted user"


def test_attempt_deadline_uses_the_attempts_own_budget():
    long_blueprint = {"duration_seconds": 5010}
    assert main.attempt_seconds(long_blueprint) == 5010
    att = {"started": time.time(), "state": '{"duration_seconds": 5010}'}
    assert main.attempt_deadline(att) > time.time() + 4000
    assert not main.attempt_expired(att)
    short = {"started": time.time() - 3000, "state": '{"duration_seconds": 600}'}
    assert main.attempt_expired(short)


def test_identity_signal_tolerates_variants_but_flags_a_different_person():
    account = {"name": "Sadia Rahman", "email": "sadia@example.com"}
    own_cv = ID.extract_identity("Sadia Rahman\nDhaka\nsadia@example.com\nSkills: SQL")
    assert ID.compare(account, own_cv)["status"] == "match"

    initials = ID.extract_identity("S. Rahman\nSkills: Python")
    assert ID.compare(account, initials)["status"] in ("match", "weak")

    someone_else = ID.extract_identity("Karim Chowdhury\nkarim@example.org\nSkills: Java")
    signal = ID.compare(account, someone_else)
    assert signal["status"] == "no_match"
    assert signal["email_match"] is False


def test_mismatched_cv_requires_an_explicit_confirmation():
    _register("identity@example.com")
    headers = _headers(_token("identity@example.com"))
    assert client.post("/api/consent", json={"lang": "en"}, headers=headers).status_code == 200
    upload = client.post("/api/cv", data={"text": "Karim Chowdhury\nkarim@example.org\n"
                                                 "Skills: Java, Spring, SQL, Git, Docker"}, headers=headers)
    assert upload.status_code == 200, upload.text
    assert upload.json()["identity"]["status"] == "no_match"

    blocked = client.put("/api/skills", json={"skills": ["sql"]}, headers=headers)
    assert blocked.status_code == 409
    allowed = client.put("/api/skills", json={"skills": ["sql"], "cv_identity_confirmed": True}, headers=headers)
    assert allowed.status_code == 200
    review = main.one("SELECT * FROM identity_reviews WHERE user_id=(SELECT id FROM users WHERE email=?)",
                      ("identity@example.com",))
    assert review is not None
