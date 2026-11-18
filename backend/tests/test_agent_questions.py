"""F-B question assist tests (additive). No external calls: keys/URLs are blanked."""
import json
import os
import sys
import tempfile
import time

_TMP = tempfile.mkdtemp(prefix="sb_agent_q_")
os.environ.setdefault("DB_PATH", os.path.join(_TMP, "test.db"))
os.environ["SEED_DEMO"] = "false"
os.environ.setdefault("PBKDF2_ITERATIONS", "1000")
os.environ["AGENT_QUESTIONS_ENABLED"] = "true"
# Force the deterministic scaffold path so tests never hit a provider or network.
for _key in ("GROQ_API_KEYS", "GROQ_API_KEY", "GEMINI_API_KEYS", "GEMINI_API_KEY",
             "OPENAI_API_KEYS", "OPENAI_API_KEY", "GROK_API_KEYS", "GROK_API_KEY",
             "DEEPSEEK_API_KEYS", "DEEPSEEK_API_KEY",
             "QUESTION_ASSIST_MCP_URL", "QUESTION_ASSIST_WEB_MCP_URL"):
    os.environ[_key] = ""
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import agent_questions
import enterprise
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


def _bank_count():
    enterprise._seed_question_bank()
    return main.one("SELECT COUNT(*) AS n FROM question_bank")["n"]


def test_scaffold_drafts_do_not_touch_bank():
    before = _bank_count()
    result = agent_questions.create_drafts("python", 2)
    after = _bank_count()
    assert result["created"] >= 1
    assert after == before
    assert all(draft["status"] == "pending_approval" for draft in result["drafts"])
    assert all(draft["source"] in {"scaffold", "llm", "mcp_bank", "web_mcp"} for draft in result["drafts"])


def test_approve_valid_draft_inserts_into_bank():
    agent_questions.ensure_schema()
    draft_id = "aqd-test-valid"
    main.run(
        """INSERT INTO agent_question_drafts(
            id,skill_id,category_id,subcategory,question_type,difficulty_level,question_text,
            options,correct_answer,explanation,reference_answer,grading_rubric,marks,time_allocation,
            status,source,source_url,provider,model,generated,provenance,validation,created_by,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (
            draft_id, "python", "CAT-10", "Python", "MCQ", "Easy",
            "Agent test: which keyword defines a function?",
            json.dumps(["def", "func", "lambda", "define"]), "def", "def defines a function",
            "", "", 1, 60, "pending_approval", "llm", "", "groq", "test-model", 1,
            "{}", "[]", "tester", time.time(),
        ),
    )
    admin = {"id": _user("agent-q-admin@example.com", "admin"), "name": "Admin"}
    status, question_id, errors = agent_questions.approve_draft(draft_id, admin)
    assert status == "ok", errors
    assert question_id
    row = main.one("SELECT status,created_by FROM question_bank WHERE id=?", (question_id,))
    assert row["status"] == "active"
    assert row["created_by"] == "question-assist-agent"
    assert agent_questions.get_draft(draft_id)["status"] == "approved"


def test_approve_invalid_scaffold_is_rejected():
    result = agent_questions.create_drafts("git", 1)
    draft = result["drafts"][0]
    status, question_id, errors = agent_questions.approve_draft(draft["id"], {"id": 1, "name": "Admin"})
    assert status == "invalid"
    assert question_id is None
    assert errors


def test_reject_draft_leaves_bank_unchanged():
    before = _bank_count()
    result = agent_questions.create_drafts("go", 1)
    draft = result["drafts"][0]
    status, _ = agent_questions.reject_draft(draft["id"], {"id": 1, "name": "Admin"})
    assert status == "ok"
    assert agent_questions.get_draft(draft["id"])["status"] == "rejected"
    assert _bank_count() == before


def test_coverage_reports_skills_and_gaps():
    cov = agent_questions.coverage()
    assert cov["total"] > 0
    assert cov["covered"] + cov["pending"] == cov["total"]
    assert isinstance(cov["gaps"], list)


def test_candidate_coverage_uses_confirmed_skills():
    uid = _user("agent-q-cand@example.com")
    main.run(
        "INSERT INTO profiles(user_id,confirmed) VALUES (?,?)",
        (uid, json.dumps(["python", "sql"])),
    )
    result = agent_questions.candidate_coverage(uid)
    ids = {item["skill_id"] for item in result["skills"]}
    assert {"python", "sql"} <= ids


def test_endpoints_require_admin_and_flag(monkeypatch):
    from fastapi.testclient import TestClient

    candidate = _user("agent-q-cand2@example.com", "candidate")
    admin = _user("agent-q-admin2@example.com", "admin")
    client = TestClient(main.app)

    denied = client.get(
        "/api/admin/agent/question-coverage",
        headers={"Authorization": "Bearer " + main.make_token(candidate)},
    )
    assert denied.status_code == 403

    headers = {"Authorization": "Bearer " + main.make_token(admin)}
    monkeypatch.setenv("AGENT_QUESTIONS_ENABLED", "true")
    ok = client.get("/api/admin/agent/question-coverage", headers=headers)
    assert ok.status_code == 200, ok.text

    draft = client.post(
        "/api/admin/agent/questions/draft",
        json={"skill": "python", "count": 1},
        headers=headers,
    )
    assert draft.status_code == 200, draft.text
    assert draft.json()["created"] >= 1

    monkeypatch.setenv("AGENT_QUESTIONS_ENABLED", "false")
    off = client.get("/api/admin/agent/question-coverage", headers=headers)
    assert off.status_code == 503
