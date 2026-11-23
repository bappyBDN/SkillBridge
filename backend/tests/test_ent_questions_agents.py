"""Question import validation, practice pool, question-assist drafts and agent console scopes."""
import json
import os
import time
import uuid

os.environ.setdefault("AGENT_PLATFORM_ENABLED", "true")
for _key in ("GROQ_API_KEYS", "GROQ_API_KEY", "GEMINI_API_KEYS", "GEMINI_API_KEY", "OPENAI_API_KEYS",
             "OPENAI_API_KEY", "DEEPSEEK_API_KEYS", "DEEPSEEK_API_KEY", "QUESTION_ASSIST_MCP_URL",
             "QUESTION_ASSIST_WEB_MCP_URL"):
    os.environ[_key] = ""

import pytest

from test_ent_helpers import application, attempt, client, company, headers, job, main, member, user

import enterprise
import mcp_tools as T


MCQ = {"category": "SQL", "question_text": "Which clause filters grouped rows?", "question_type": "MCQ",
       "options": ["WHERE", "HAVING", "ORDER BY"], "correct_answer": "B", "difficulty": "Easy",
       "marks": 1, "time_allocation": 60}


@pytest.fixture
def qadmin():
    return headers(user("admin", "question_content_admin"))


def _question(status, subcategory="Python", text=None):
    qid = "q-" + uuid.uuid4().hex[:10]
    main.run("""INSERT INTO question_bank(id,category_id,subcategory,question_type,difficulty_level,question_text,
                options,correct_answer,explanation,reference_answer,grading_rubric,marks,time_allocation,status,
                created_by,created_at,version) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
             (qid, "CAT-10", subcategory, "MCQ", "Easy", text or ("Q " + qid), '["a","b"]', "a", "x", "", "",
              1, 60, status, "test", time.time(), 1))
    return qid


# --------------------------------------------------------------------- item 6
def test_import_commit_validates_forces_draft_and_ignores_client_ids(qadmin):
    payload = {"questions": [
        {**MCQ, "id": "client-chosen-id", "status": "active"},
        {**MCQ, "question_text": "MCQ without a key?", "correct_answer": ""},
        {**MCQ, "question_text": "MCQ with a wrong key?", "correct_answer": "DISTINCT"},
        {"category": "SQL", "question_text": "Explain indexing trade-offs in OLTP systems.",
         "question_type": "Explainable"},
        {"category": "SQL", "question_text": "Explain normal forms with an example table.",
         "question_type": "Explainable", "grading_rubric": "Mentions 1NF, 2NF, 3NF"},
    ]}
    response = client.post("/api/admin/questions/import/commit", headers=qadmin, json=payload)
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["added"] == 2 and body["rejected"] == 3
    assert {item["index"] for item in body["rejected_items"]} == {1, 2, 3}
    assert not main.one("SELECT id FROM question_bank WHERE id='client-chosen-id'")
    rows = [main.one("SELECT * FROM question_bank WHERE id=?", (qid,)) for qid in body["imported_ids"]]
    assert all(row["status"] == "draft" for row in rows)
    mcq = next(row for row in rows if row["question_type"] == "MCQ")
    assert mcq["correct_answer"] == "HAVING"  # letter key mapped onto the option text


def test_import_commit_is_all_or_nothing(qadmin, monkeypatch):
    original = enterprise._insert_question
    calls = {"n": 0}

    def flaky(conn, payload, actor):
        calls["n"] += 1
        if calls["n"] == 2:
            raise RuntimeError("disk full")
        return original(conn, payload, actor)

    monkeypatch.setattr(enterprise, "_insert_question", flaky)
    texts = ["Atomic import question one?", "Atomic import question two?"]
    local = client.__class__(main.app, raise_server_exceptions=False)
    response = local.post("/api/admin/questions/import/commit", headers=qadmin,
                          json={"questions": [{**MCQ, "question_text": t} for t in texts]})
    assert response.status_code == 500
    for text in texts:
        assert not main.one("SELECT id FROM question_bank WHERE question_text=?", (text,))


def test_create_is_draft_and_activation_requires_answer_key(qadmin):
    created = client.post("/api/admin/questions", headers=qadmin,
                          json={**MCQ, "question_text": "Draft-only create?", "correct_answer": "", "status": "active",
                                "id": "my-own-id"})
    assert created.status_code == 200, created.text
    item = created.json()
    assert item["status"] == "draft" and item["id"] != "my-own-id" and item["content_errors"]
    blocked = client.put(f"/api/admin/questions/{item['id']}", headers=qadmin, json={"status": "active"})
    assert blocked.status_code == 422
    fixed = client.put(f"/api/admin/questions/{item['id']}", headers=qadmin,
                       json={"status": "active", "correct_answer": "HAVING"})
    assert fixed.status_code == 200, fixed.text
    assert fixed.json()["status"] == "active"


def test_preview_is_sync_bounded_and_reports_key_errors(qadmin):
    data = json.dumps([{**MCQ, "question_text": "Preview me?", "correct_answer": ""}]).encode()
    response = client.post("/api/admin/questions/import/preview", headers=qadmin,
                           files={"file": ("q.json", data, "application/json")})
    assert response.status_code == 200, response.text
    assert response.json()["invalid"] == 1
    big = client.post("/api/admin/questions/import/preview", headers=qadmin,
                      files={"file": ("q.json", b"[" + b" " * 5_000_100 + b"]", "application/json")})
    assert big.status_code == 413


# --------------------------------------------------------------------- item 5
def test_practice_never_serves_live_exam_items():
    topic = "Kotlin"
    active = _question("active", topic)
    result = T.practice_questions(1, topic, 5)
    assert active not in {q.get("id") for q in result["questions"]}
    retired = _question("archived", topic)
    fallback = T.practice_questions(1, topic, 5)
    assert fallback["pool"] == "retired" and {q["id"] for q in fallback["questions"]} == {retired}
    practice = _question("practice", topic)
    served = T.practice_questions(1, topic, 5)
    assert served["pool"] == "practice" and {q["id"] for q in served["questions"]} == {practice}
    T.assert_no_answer_fields(served)


# --------------------------------------------------------------------- item 7
def test_needs_authoring_draft_can_be_completed_then_approved(monkeypatch):
    monkeypatch.setenv("AGENT_QUESTIONS_ENABLED", "true")
    admin = headers(user("admin", "question_content_admin"))
    created = client.post("/api/admin/agent/questions/draft", headers=admin, json={"skill": "python", "count": 1})
    assert created.status_code == 200, created.text
    draft = created.json()["drafts"][0]
    assert "needs_authoring" in draft["validation"]
    blocked = client.post(f"/api/admin/agent/questions/drafts/{draft['id']}/approve", headers=admin)
    assert blocked.status_code == 422
    edited = client.patch(f"/api/admin/agent/questions/drafts/{draft['id']}", headers=admin, json={
        "question_text": "Explain how Python list comprehensions differ from generator expressions.",
        "reference_answer": "Lists are eager; generators are lazy.",
        "grading_rubric": "Mentions eager vs lazy evaluation and memory use."})
    assert edited.status_code == 200, edited.text
    assert edited.json()["approvable"] is True and edited.json()["validation"] == []
    approved = client.post(f"/api/admin/agent/questions/drafts/{draft['id']}/approve", headers=admin)
    assert approved.status_code == 200, approved.text
    assert client.patch(f"/api/admin/agent/questions/drafts/{draft['id']}", headers=admin,
                        json={"question_text": "late"}).status_code == 409
    assert client.patch("/api/admin/agent/questions/drafts/missing", headers=admin,
                        json={"question_text": "x"}).status_code == 404


def test_console_question_artifact_approval_uses_validated_path(monkeypatch):
    monkeypatch.setenv("AGENT_QUESTIONS_ENABLED", "true")
    monkeypatch.setenv("AGENT_PLATFORM_ENABLED", "true")
    admin = headers(user("admin", "question_content_admin"))
    run = client.post("/api/agent/run", headers=admin,
                      json={"intent": "question_draft", "payload": {"skill": "python", "count": 1}})
    assert run.status_code == 200, run.text
    artifact = run.json()["artifacts"][0]
    blocked = client.post(f"/api/agent/artifacts/{artifact['id']}/approve", headers=admin)
    assert blocked.status_code == 422
    assert blocked.json()["detail"]["results"][0]["status"] == "invalid"
    draft_id = artifact["body"]["drafts"][0]["id"]
    client.patch(f"/api/admin/agent/questions/drafts/{draft_id}", headers=admin, json={
        "question_text": "Explain Python decorators and give one practical use.",
        "reference_answer": "A decorator wraps a callable.", "grading_rubric": "Explains wrapping and a use."})
    approved = client.post(f"/api/agent/artifacts/{artifact['id']}/approve", headers=admin)
    assert approved.status_code == 200, approved.text
    assert approved.json()["question_results"][0]["status"] == "ok"
    qid = approved.json()["question_results"][0]["question_id"]
    assert main.one("SELECT status FROM question_bank WHERE id=?", (qid,))["status"] == "active"


# --------------------------------------------------------------------- item 2
def test_agent_console_enforces_admin_scopes_and_flags(monkeypatch):
    monkeypatch.setenv("AGENT_PLATFORM_ENABLED", "true")
    monkeypatch.setenv("AGENT_QUESTIONS_ENABLED", "true")
    monkeypatch.setenv("AGENT_INTEGRITY_ENABLED", "false")
    finance = headers(user("admin", "finance_admin"))
    assert client.post("/api/agent/run", headers=finance, json={"intent": "question_coverage"}).status_code == 403
    assert client.get("/api/agent/status", headers=finance).json()["intents"] == []
    reviewer = headers(user("admin", "trust_safety_reviewer"))
    off = client.post("/api/agent/run", headers=reviewer,
                      json={"intent": "integrity_summary", "payload": {"attempt_id": "x"}})
    assert off.status_code == 503
    bare = headers(user("admin"))
    assert client.post("/api/agent/run", headers=bare, json={"intent": "question_coverage"}).status_code == 403


def test_agent_console_company_intents_need_verification_and_pipeline_role(monkeypatch):
    monkeypatch.setenv("AGENT_PLATFORM_ENABLED", "true")
    owner = user("company")
    cid = company(owner, verified=False)
    assert client.post("/api/agent/run", headers=headers(owner), json={"intent": "shortlist"}).status_code == 403
    verified_owner = user("company")
    vcid = company(verified_owner)
    viewer = member(vcid, "viewer")
    assert client.post("/api/agent/run", headers=headers(viewer), json={"intent": "shortlist"}).status_code == 403
    assert "shortlist" not in client.get("/api/agent/status", headers=headers(viewer)).json()["intents"]


def test_shortlist_hides_unpublished_scores_and_trust(monkeypatch):
    monkeypatch.setenv("AGENT_PLATFORM_ENABLED", "true")
    owner = user("company")
    cid = company(owner)
    candidate = user()
    application(job(cid), candidate, shared=True)
    attempt(candidate)
    run = client.post("/api/agent/run", headers=headers(owner), json={"intent": "shortlist"})
    assert run.status_code == 200, run.text
    entry = run.json()["artifacts"][0]["body"]["shortlist"][0]
    assert entry["overall"] is None and entry["result_status"] == "awaiting_reviews"
    assert "trust" not in json.dumps(entry)


# --------------------------------------------------------------------- item 4
class _Req:
    def __init__(self, auth=""):
        self.headers = {"authorization": auth} if auth else {}


class _Ctx:
    def __init__(self, request):
        self.request_context = type("RC", (), {"request": request})()


def test_mcp_email_fallback_only_on_stdio(monkeypatch):
    candidate = user()
    email = main.one("SELECT email FROM users WHERE id=?", (candidate,))["email"]
    monkeypatch.setattr(T, "_STDIO_TRANSPORT", False)
    with pytest.raises(ValueError, match="authentication_required"):
        T.resolve_user(email, None)
    with pytest.raises(ValueError, match="authentication_required"):
        T.resolve_user(email, _Ctx(_Req()))  # HTTP request without a bearer token
    token = main.make_token(candidate)
    assert T.resolve_user("someone-else@example.com", _Ctx(_Req("Bearer " + token)))["id"] == candidate
    monkeypatch.setattr(T, "_STDIO_TRANSPORT", True)
    with pytest.raises(ValueError, match="authentication_required"):
        T.resolve_user(email, _Ctx(_Req()))  # still HTTP: email ignored
    assert T.resolve_user(email, None)["id"] == candidate


def test_mcp_calls_are_audited_and_rate_limited(monkeypatch):
    candidate = user()
    token = main.make_token(candidate)
    monkeypatch.setenv("MCP_RATE_LIMIT_PER_MINUTE", "2")
    monkeypatch.setattr(T, "_rate_hits", {})
    ctx = _Ctx(_Req("Bearer " + token))
    T.authorize_call("learning_path", "", ctx)
    T.authorize_call("learning_path", "", ctx)
    with pytest.raises(ValueError, match="rate_limited"):
        T.authorize_call("learning_path", "", ctx)
    rows = main.allr("SELECT target FROM audit WHERE actor=? AND action='mcp_tool_call'", (candidate,))
    assert [r["target"] for r in rows] == ["learning_path:http", "learning_path:http"]
