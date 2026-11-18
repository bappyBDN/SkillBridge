"""F-A integrity analyst tests (additive)."""
import json
import os
import sys
import tempfile
import time

_TMP = tempfile.mkdtemp(prefix="sb_agent_int_")
os.environ.setdefault("DB_PATH", os.path.join(_TMP, "test.db"))
os.environ["SEED_DEMO"] = "false"
os.environ.setdefault("PBKDF2_ITERATIONS", "1000")
os.environ["AGENT_INTEGRITY_ENABLED"] = "true"
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import agent_integrity
import main


def _user(email, role="candidate"):
    uid = main.run(
        "INSERT INTO users(email,name,salt,pw_hash,created) VALUES (?,?,?,?,?)",
        (email, "Agent Test", "salt", main.hash_pw("Str0ng-Passw0rd-2026"), time.time()),
    )
    main.run("INSERT INTO user_roles(user_id,role) VALUES (?,?)", (uid, role))
    if role == "admin":
        main.run(
            "INSERT INTO admin_staff_roles(user_id,admin_role,updated_by,updated_at) VALUES (?,?,?,?)",
            (uid, "super_admin", uid, 0),
        )
    return uid


def _attempt(attempt_id, user_id, result):
    main.run(
        "INSERT INTO attempts(id,user_id,kind,seed,status,state,started,finished,result) VALUES (?,?,?,?,?,?,?,?,?)",
        (attempt_id, user_id, "pre", 1, "done", "{}", 1000.0, 2200.0, json.dumps(result)),
    )


def test_summary_is_advisory_and_needs_review():
    uid = _user("agent-int-1@example.com")
    _attempt(
        "att-int-1",
        uid,
        {
            "trust": "Needs review",
            "trust_points": 8.0,
            "trust_rule_version": "phase2-v1",
            "trust_reasons": [
                {"key": "leave_window", "n": 1, "points": 4, "duration_seconds": 192},
                {"key": "fast", "n": 2, "points": 2},
                {"key": "ai_phone_detected", "n": 1, "points": 1, "advisory": True},
            ],
            "trust_hard_flags": ["devtools_open"],
        },
    )
    main.run("INSERT INTO events(attempt_id,type,ts) VALUES (?,?,?)", ("att-int-1", "blur", 1100.0))
    main.run("INSERT INTO events(attempt_id,type,ts) VALUES (?,?,?)", ("att-int-1", "ai_phone_detected", 1200.0))

    summary = agent_integrity.summarize_attempt("att-int-1")

    assert summary["advisory"] is True
    assert summary["risk_level"] == "needs_review"
    assert summary["flags"] == ["devtools_open"]
    assert summary["timing"]["fast_answers"] == 2
    assert summary["timing"]["leave_minutes"] == 3.2
    assert summary["source"] == "deterministic"
    assert "prove misconduct" in summary["recommendation"].lower()
    keys = {point["key"] for point in summary["focus_points"]}
    assert {"leave_window", "fast", "ai_phone_detected"} <= keys


def test_summary_is_stable_across_reads():
    uid = _user("agent-int-2@example.com")
    _attempt(
        "att-int-2",
        uid,
        {"trust": "Medium", "trust_points": 3.0, "trust_reasons": [{"key": "fullscreen_exit", "n": 1, "points": 1}], "trust_hard_flags": []},
    )
    first = agent_integrity.summarize_attempt("att-int-2")
    second = agent_integrity.summarize_attempt("att-int-2")
    assert first["risk_level"] == second["risk_level"] == "medium"
    assert first["headline"] == second["headline"]
    assert first["summary"] == second["summary"]


def test_unknown_attempt_returns_none():
    assert agent_integrity.summarize_attempt("does-not-exist") is None


def test_endpoint_requires_admin():
    from fastapi.testclient import TestClient

    candidate = _user("agent-int-cand@example.com", "candidate")
    client = TestClient(main.app)
    token = main.make_token(candidate)
    response = client.get("/api/admin/agent/integrity/att-int-1", headers={"Authorization": "Bearer " + token})
    assert response.status_code == 403


def test_endpoint_works_for_admin_and_flags_off(monkeypatch):
    from fastapi.testclient import TestClient

    admin = _user("agent-int-admin@example.com", "admin")
    client = TestClient(main.app)
    headers = {"Authorization": "Bearer " + main.make_token(admin)}

    monkeypatch.setenv("AGENT_INTEGRITY_ENABLED", "true")
    ok = client.get("/api/admin/agent/integrity/att-int-1", headers=headers)
    assert ok.status_code == 200, ok.text
    assert ok.json()["advisory"] is True

    missing = client.get("/api/admin/agent/integrity/missing-attempt", headers=headers)
    assert missing.status_code == 404

    monkeypatch.setenv("AGENT_INTEGRITY_ENABLED", "false")
    off = client.get("/api/admin/agent/integrity/att-int-1", headers=headers)
    assert off.status_code == 503
