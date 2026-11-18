"""Agent platform tests: role scoping, consent, drafts, approval, flags."""
import json
import os
import sys
import tempfile
import time

_TMP = tempfile.mkdtemp(prefix="sb_agent_platform_")
os.environ.setdefault("DB_PATH", os.path.join(_TMP, "test.db"))
os.environ["SEED_DEMO"] = "false"
os.environ.setdefault("PBKDF2_ITERATIONS", "1000")
os.environ["AGENT_PLATFORM_ENABLED"] = "true"
os.environ["AGENT_LLM_DRAFTS"] = "false"
# Keep tests offline.
for _key in ("GROQ_API_KEYS", "GROQ_API_KEY", "GEMINI_API_KEYS", "GEMINI_API_KEY",
             "OPENAI_API_KEYS", "OPENAI_API_KEY", "QUESTION_ASSIST_MCP_URL",
             "QUESTION_ASSIST_WEB_MCP_URL"):
    os.environ[_key] = ""
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

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


def _client():
    from fastapi.testclient import TestClient

    return TestClient(main.app)


def _headers(uid):
    return {"Authorization": "Bearer " + main.make_token(uid)}


def _company(owner_id, company_id="co-agent-1"):
    main.run(
        "INSERT INTO companies(id,owner_user_id,name,website,verified,created) VALUES (?,?,?,?,?,?)",
        (company_id, owner_id, "Agent Test Co", "", 1, time.time()),
    )
    return company_id


def _job(company_id, job_id="job-agent-1"):
    main.run(
        "INSERT INTO jobs(id,company_id,title,description,location,employment_type,skills,status,is_mock,created) "
        "VALUES (?,?,?,?,?,?,?,?,?,?)",
        (job_id, company_id, "Junior Data Analyst", "SQL Python dashboards", "Remote",
         "Full-time", "[]", "published", 1, time.time()),
    )
    return job_id


def _application(application_id, job_id, candidate_id, shared):
    main.run(
        "INSERT INTO applications(id,job_id,candidate_id,status,results_shared,created) VALUES (?,?,?,?,?,?)",
        (application_id, job_id, candidate_id, "submitted", 1 if shared else 0, time.time()),
    )


def _attempt(attempt_id, user_id, overall=80, sql=85):
    main.run(
        "INSERT INTO attempts(id,user_id,kind,seed,status,state,started,finished,result) "
        "VALUES (?,?,?,?,?,?,?,?,?)",
        (attempt_id, user_id, "pre", 1, "done", "{}", 0.0, 1200.0,
         json.dumps({"overall": overall, "level": "Advanced",
                     "topics": {"sql": {"score": sql, "level": "Advanced"}}})),
    )


def test_status_returns_role_and_intents():
    candidate = _user("agent-p-status@example.com")
    response = _client().get("/api/agent/status", headers=_headers(candidate))
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["role"] == "candidate"
    assert "study_plan" in body["intents"]
    assert body["advisory"] is True


def test_candidate_study_plan_creates_draft_artifact():
    candidate = _user("agent-p-study@example.com")
    _attempt("att-agent-study", candidate)
    response = _client().post(
        "/api/agent/run", json={"intent": "study_plan"}, headers=_headers(candidate)
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["status"] == "ok"
    assert body["artifacts"], body
    artifact = body["artifacts"][0]
    assert artifact["kind"] == "study_plan"
    assert artifact["status"] == "pending_approval"
    assert artifact["body"]["weeks"]


def test_practice_hint_never_returns_answers():
    candidate = _user("agent-p-practice@example.com")
    main.run(
        """INSERT INTO question_bank(
               id,category_id,subcategory,question_type,difficulty_level,question_text,
               options,correct_answer,explanation,reference_answer,grading_rubric,marks,
               time_allocation,status,created_by,created_at,version)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT(id) DO NOTHING""",
        ("agent-practice-q", "CAT-10", "Python", "MCQ", "Easy",
         "Which keyword defines a function?", '["def","func","lambda","define"]', "def",
         "def defines a function", "", "", 1, 60, "active", "test", 0, 1),
    )
    response = _client().post(
        "/api/agent/run",
        json={"intent": "practice_hint", "payload": {"topic": "python", "count": 3}},
        headers=_headers(candidate),
    )
    assert response.status_code == 200, response.text
    questions = response.json()["data"]["practice"]["questions"]
    for question in questions:
        assert "correct_answer" not in question
        assert "reference_answer" not in question
        assert "explanation" not in question


def test_company_job_skills_maps_taxonomy():
    owner = _user("agent-p-company@example.com", "company")
    _company(owner)
    response = _client().post(
        "/api/agent/run",
        json={"intent": "job_skills", "payload": {"description": "We need SQL and Python for dashboards"}},
        headers=_headers(owner),
    )
    assert response.status_code == 200, response.text
    artifact = response.json()["artifacts"][0]
    ids = {item["id"] for item in artifact["body"]["skills"]}
    assert {"sql", "python"} <= ids


def test_shortlist_respects_result_sharing_consent():
    owner = _user("agent-p-hiring@example.com", "company")
    company_id = _company(owner, "co-agent-2")
    job_id = _job(company_id, "job-agent-2")
    consenting = _user("agent-p-consent@example.com")
    private = _user("agent-p-private@example.com")
    _application("app-agent-1", job_id, consenting, shared=True)
    _application("app-agent-2", job_id, private, shared=False)
    _attempt("att-agent-consent", consenting, overall=82)
    _attempt("att-agent-private", private, overall=91)

    response = _client().post(
        "/api/agent/run", json={"intent": "shortlist"}, headers=_headers(owner)
    )
    assert response.status_code == 200, response.text
    shortlist = response.json()["artifacts"][0]["body"]["shortlist"]
    ids = {item["candidate_id"] for item in shortlist}
    assert consenting in ids
    assert private not in ids


def test_admin_integrity_summary_and_question_draft():
    admin = _user("agent-p-admin@example.com", "admin")
    candidate = _user("agent-p-admin-cand@example.com")
    main.run(
        "INSERT INTO attempts(id,user_id,kind,seed,status,state,started,finished,result) "
        "VALUES (?,?,?,?,?,?,?,?,?)",
        ("att-agent-int", candidate, "pre", 1, "done", "{}", 0.0, 1200.0,
         json.dumps({"trust": "Needs review", "trust_points": 8,
                     "trust_reasons": [{"key": "leave_window", "n": 1, "points": 4, "duration_seconds": 120}],
                     "trust_hard_flags": ["devtools_open"]})),
    )
    client = _client()
    integrity = client.post(
        "/api/agent/run",
        json={"intent": "integrity_summary", "payload": {"attempt_id": "att-agent-int"}},
        headers=_headers(admin),
    )
    assert integrity.status_code == 200, integrity.text
    artifact = integrity.json()["artifacts"][0]
    assert artifact["kind"] == "integrity_summary"
    assert artifact["body"]["advisory"] is True

    drafts = client.post(
        "/api/agent/run",
        json={"intent": "question_draft", "payload": {"skill": "python", "count": 1}},
        headers=_headers(admin),
    )
    assert drafts.status_code == 200, drafts.text
    assert drafts.json()["artifacts"][0]["kind"] == "question_drafts"


def test_artifact_approve_and_reject():
    candidate = _user("agent-p-approve@example.com")
    client = _client()
    created = client.post(
        "/api/agent/run", json={"intent": "gap_explain"}, headers=_headers(candidate)
    )
    artifact_id = created.json()["artifacts"][0]["id"]

    approved = client.post(f"/api/agent/artifacts/{artifact_id}/approve", headers=_headers(candidate))
    assert approved.status_code == 200, approved.text
    assert approved.json()["artifact"]["status"] == "approved"

    again = client.post(f"/api/agent/artifacts/{artifact_id}/approve", headers=_headers(candidate))
    assert again.status_code == 409


def test_wrong_role_intent_and_flag_off(monkeypatch):
    candidate = _user("agent-p-guard@example.com")
    client = _client()
    wrong = client.post("/api/agent/run", json={"intent": "shortlist"}, headers=_headers(candidate))
    assert wrong.status_code == 422

    monkeypatch.setenv("AGENT_PLATFORM_ENABLED", "false")
    off = client.post("/api/agent/run", json={"intent": "study_plan"}, headers=_headers(candidate))
    assert off.status_code == 503
