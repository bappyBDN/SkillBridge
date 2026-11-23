"""Privacy regressions: export never leaks answer keys, the deletion/export
registry has no silent typos, application-linked and agent rows are erased,
financial rows are anonymized, stored files are removed by prefix, CV links and
contact schemes never reach an AI provider, and the new CV flow runs the
identity check."""
import json
import os
import sys
import tempfile
import time
import uuid

os.environ.setdefault("DB_PATH", os.path.join(tempfile.mkdtemp(prefix="sb_core_privacy_"), "test.db"))
os.environ.setdefault("PBKDF2_ITERATIONS", "1000")
os.environ["SEED_DEMO"] = "false"
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import pytest
from fastapi.testclient import TestClient

import main
import enterprise  # noqa: F401  (creates the enterprise tables)
import agent_platform
import storage

client = TestClient(main.app)
KEY_FIELDS = ("correct_answer", "reference_answer", "grading_rubric", "expected_keywords")


def candidate(name="Privacy Candidate"):
    email = uuid.uuid4().hex + "@example.com"
    response = client.post("/api/auth/register", json={"email": email, "name": name, "password": "Str0ng-Passw0rd-2026"})
    assert response.status_code == 200, response.text
    headers = {"Authorization": "Bearer " + response.json()["token"]}
    assert client.post("/api/consent", json={"lang": "en"}, headers=headers).status_code == 200
    uid = main.one("SELECT id FROM users WHERE email=?", (email,))["id"]
    return uid, headers, email


def _question(qid):
    return {"id": qid, "question_type": "MCQ", "question_text": "Which structure is LIFO?",
            "options": ["Queue", "Stack"], "answer": 1, "correct_answer": "Stack",
            "reference_answer": "Stack", "grading_rubric": "LIFO means stack", "explanation": "Stack is LIFO",
            "keywords": ["stack"], "marks": 1}


# ------------------------------------------------------------------ 1. export sanitizer
def test_export_strips_answer_keys_from_attempts_and_blueprints(monkeypatch):
    uid, headers, _ = candidate()
    aid = uuid.uuid4().hex
    questions = [_question(aid + "-q1")]
    state = {"graphrag": True, "selected_questions": questions, "answers": {aid + "-q1": "Stack"},
             "blueprint_id": "bp-" + aid}
    result = {"question_results": [{"question_id": aid + "-q1", "answer": "Stack", "correct_answer": "Stack",
                                    "explanation": "Stack is LIFO"}]}
    main.run("INSERT INTO attempts(id,user_id,kind,seed,status,state,started,finished,result) VALUES (?,?,?,?,?,?,?,?,?)",
             (aid, uid, "pre", 1, "done", json.dumps(state), time.time() - 100, time.time(), json.dumps(result)))
    main.run("INSERT INTO assessment_blueprints(id,user_id,status,payload,created) VALUES (?,?,?,?,?)",
             ("bp-" + aid, uid, "ready", json.dumps({"questions": questions, "total_questions": 1}), time.time()))
    main.run("INSERT INTO answer_evaluations(attempt_id,question_id,status,keywords,evaluated_at) VALUES (?,?,?,?,?)",
             (aid, aid + "-q1", "pending_approval", json.dumps({"expected_keywords": ["stack"]}), time.time()))
    # Proctoring evidence is kept, but inline bytes are capped.
    monkeypatch.setattr(main, "EXPORT_EVIDENCE_MAX_BYTES", 10)
    main.run("INSERT INTO exam_evidence(id,attempt_id,event_id,captured_at,mime_type,image_data,size_bytes,expires_at) VALUES (?,?,?,?,?,?,?,?)",
             ("ev-" + aid, aid, 1, time.time(), "image/jpeg", b"\xff\xd8\xff" + b"0" * 64, 67, time.time() + 3600))

    export = client.get("/api/me/export", headers=headers)
    assert export.status_code == 200, export.text
    text = export.text
    for field in KEY_FIELDS:
        assert field not in text, field
    attempt = next(a for a in export.json()["attempts"] if a["id"] == aid)
    exported_state = json.loads(attempt["state"])
    assert exported_state["answers"] == {aid + "-q1": "Stack"}          # the candidate's own answer stays
    assert "answer" not in exported_state["selected_questions"][0]      # the key inside a question does not
    assert exported_state["selected_questions"][0]["question_text"]
    blueprint = next(b for b in export.json()["assessment_blueprints"] if b["id"] == "bp-" + aid)
    assert "Stack is LIFO" not in blueprint["payload"]
    evidence = next(e for e in export.json()["exam_evidence"] if e["id"] == "ev-" + aid)
    assert evidence["image_omitted"] is True and "image_base64" not in evidence
    assert evidence["download_path"].endswith("/evidence/ev-" + aid)


def test_strip_key_material_keeps_candidate_answers():
    data = {"answers": [{"qid": "q", "answer": "my text", "correct": True}],
            "q": {"prompt": "x", "answer": 2, "ref": "SELECT 1"}}
    clean = main.strip_key_material(data)
    assert clean["answers"][0]["answer"] == "my text" and "correct" not in clean["answers"][0]
    assert clean["q"] == {"prompt": "x"}


# ------------------------------------------------------------------ 12. registry
def test_registry_has_no_missing_columns():
    agent_platform.ensure_schema()
    assert main.registry_problems() == []


def test_registry_logs_loudly_on_a_wrong_column(monkeypatch, caplog):
    monkeypatch.setattr(main, "USER_DATA_REGISTRY", main.USER_DATA_REGISTRY + (("consents", "no_such_column", "x"),))
    assert "consents.no_such_column" in main.registry_problems()
    with caplog.at_level("ERROR", logger="skillbridge"):
        list(main._registry_tables())
    assert any("no_such_column" in record.getMessage() for record in caplog.records)


def test_delete_removes_application_agent_rows_and_anonymizes_billing():
    agent_platform.ensure_schema()
    uid, headers, _ = candidate()
    app_id, now = "app-" + uuid.uuid4().hex, time.time()
    main.run("INSERT INTO applications(id,job_id,candidate_id,status,results_shared,created) VALUES (?,?,?,?,?,?)",
             (app_id, "job-x", uid, "submitted", 0, now))
    main.run("INSERT INTO application_history(id,application_id,company_id,actor_id,from_stage,to_stage,reason,created) VALUES (?,?,?,?,?,?,?,?)",
             (uuid.uuid4().hex, app_id, "co", 999999, "submitted", "screening", "", now))
    main.run("INSERT INTO application_notes(id,application_id,company_id,author_id,body,created) VALUES (?,?,?,?,?,?)",
             (uuid.uuid4().hex, app_id, "co", 999999, "Recruiter note about the candidate", now))
    main.run("INSERT INTO agent_runs(id,user_id,role,agent,intent,status,created_at) VALUES (?,?,?,?,?,?,?)",
             ("run-" + app_id, uid, "candidate", "copilot", "chat", "ok", now))
    main.run("INSERT INTO agent_artifacts(id,run_id,user_id,role,kind,title,created_at) VALUES (?,?,?,?,?,?,?)",
             ("art-" + app_id, "run-" + app_id, uid, "candidate", "plan", "Plan", now))
    invoice = "inv-" + app_id
    main.run("INSERT INTO billing_invoices(id,user_id,plan_id,amount_minor,currency,issued_at) VALUES (?,?,?,?,?,?)",
             (invoice, uid, "plan", 1000, "BDT", now))
    main.run("INSERT INTO billing_credit_ledger(id,user_id,delta,entry_type,source_ref,reason,actor_id,created) VALUES (?,?,?,?,?,?,?,?)",
             ("led-" + app_id, uid, -1, "retake_consumption", "a", "MOCK", uid, now))

    export = client.get("/api/me/export", headers=headers).json()
    assert export["application_history"] and export["application_notes"]
    assert export["agent_runs"] and export["billing_invoices"] and export["billing_credits"]

    assert client.delete("/api/me", headers=headers).status_code == 200
    assert main.one("SELECT COUNT(*) AS n FROM application_history WHERE application_id=?", (app_id,))["n"] == 0
    assert main.one("SELECT COUNT(*) AS n FROM application_notes WHERE application_id=?", (app_id,))["n"] == 0
    assert main.one("SELECT COUNT(*) AS n FROM agent_runs WHERE user_id=?", (uid,))["n"] == 0
    assert main.one("SELECT COUNT(*) AS n FROM agent_artifacts WHERE user_id=?", (uid,))["n"] == 0
    # Financial records stay for accounting, without the link to the person.
    inv = main.one("SELECT user_id,amount_minor FROM billing_invoices WHERE id=?", (invoice,))
    assert inv["user_id"] == main.ERASED_USER_ID and inv["amount_minor"] == 1000
    led = main.one("SELECT user_id,actor_id FROM billing_credit_ledger WHERE id=?", ("led-" + app_id,))
    assert led["user_id"] == main.ERASED_USER_ID and led["actor_id"] == main.ERASED_USER_ID


# ------------------------------------------------------------------ 13. stored files
def test_account_deletion_removes_orphaned_stored_files_by_prefix(monkeypatch):
    monkeypatch.setenv("STORAGE_BACKEND", "database")
    storage.reset_storage_for_tests()
    uid, headers, _ = candidate()
    store = storage.get_storage()
    store.put(f"cv/{uid}/orphan.pdf", b"%PDF-1.4 orphan", "application/pdf")
    store.put(f"avatars/{uid}/old.webp", b"RIFFxxxxWEBP", "image/webp")
    neighbour = f"cv/{uid}1/keep.pdf"   # another user's folder sharing the digits
    store.put(neighbour, b"%PDF-1.4 keep", "application/pdf")
    assert client.delete("/api/me", headers=headers).status_code == 200
    left = {r["storage_key"] for r in main.allr("SELECT storage_key FROM stored_files")}
    assert f"cv/{uid}/orphan.pdf" not in left and f"avatars/{uid}/old.webp" not in left
    assert neighbour in left
    store.delete(neighbour)
    storage.reset_storage_for_tests()


def test_failed_storage_delete_is_remembered_and_retried(monkeypatch):
    monkeypatch.setenv("STORAGE_BACKEND", "database")
    storage.reset_storage_for_tests()
    store = storage.get_storage()
    key = f"cv/424242/{uuid.uuid4().hex}.pdf"
    store.put(key, b"%PDF-1.4 x", "application/pdf")
    original = type(store).delete

    def failing(self, k):
        raise storage.StorageError("unreachable")
    monkeypatch.setattr(type(store), "delete", failing)
    assert storage.delete_or_defer(key) is False
    assert main.one("SELECT target FROM storage_pending_deletes WHERE target=?", (key,))
    monkeypatch.setattr(type(store), "delete", original)
    assert storage.retry_pending_deletes() >= 1
    assert main.one("SELECT target FROM storage_pending_deletes WHERE target=?", (key,)) is None
    assert not store.exists(key)
    storage.reset_storage_for_tests()


def test_prefix_must_name_a_folder():
    with pytest.raises(storage.StorageError):
        storage._clean_prefix("")
    with pytest.raises(storage.StorageError):
        storage._clean_prefix("cv")


# ------------------------------------------------------------------ 10. links + PII
def test_contact_schemes_are_not_profile_links():
    assert main._normalize_profile_url("mailto:rahim@example.com") == ""
    assert main._normalize_profile_url("tel:+8801712345678") == ""
    assert main._normalize_profile_url("sms:+8801712345678") == ""
    assert main._normalize_profile_url("rahim@example.com") == ""
    assert main._normalize_profile_url("https://github.com/rahim") == "https://github.com/rahim"
    assert main._normalize_profile_url("www.linkedin.com/in/rahim") == "https://linkedin.com/in/rahim"


CV_TEXT = """Karim Chowdhury
karim@example.org | +8801712345678
LinkedIn: https://www.linkedin.com/in/karim-c
GitHub: github.com/karimc
Summary
Backend engineer building Python and SQL data pipelines for analytics teams.
Skills
Python, SQL, Docker, PostgreSQL
Experience
Data Engineer, Acme Ltd, 2021 - Present
Built ETL pipelines in Python and SQL.
"""


def test_new_cv_flow_redacts_links_for_ai_and_runs_identity_check(monkeypatch):
    import ai_providers
    uid, _headers, email = candidate("Sadia Rahman")
    seen = {}

    def fake_extract(text, identity=None):
        seen["text"] = text
        raise ai_providers.AIExtractionError("offline in tests")
    monkeypatch.setattr(ai_providers, "extract_cv_profile", fake_extract)
    user = dict(main.one("SELECT * FROM users WHERE id=?", (uid,)))
    result = main._extract_cv_upload(user, "cv.txt", CV_TEXT.encode())

    sent = seen["text"]
    for leaked in ("linkedin.com", "github.com", "karim@example.org", "+8801712345678", "mailto:"):
        assert leaked not in sent, leaked
    assert "[URL]" in sent
    # Deterministic profile fields still keep the real profile URLs.
    assert "linkedin.com/in/karim-c" in result["profile"]["linkedin"]
    # Identity: a different person's CV is queued for human review, signal only.
    assert result["identity"]["status"] == "no_match"
    assert "cv_name" not in result["identity"]
    review = main.one("SELECT status,signal FROM identity_reviews WHERE user_id=? AND status='open'", (uid,))
    assert review and "Karim" not in review["signal"]


def test_project_details_survive_extraction_normalization_and_save():
    import ai_providers
    item = ai_providers.normalize_project({
        "name": "Ledger", "project_url": "https://x.test", "description": "Built a ledger",
        "role": "Lead", "technologies": "Python, SQL", "start_date": "2023", "end_date": "2024"})
    assert item == {"name": "Ledger", "url": "https://x.test", "description": "Built a ledger",
                    "role": "Lead", "technologies": ["Python", "SQL"], "start_date": "2023", "end_date": "2024"}
    cleaned = main.clean_profile({"projects": [item]})
    assert cleaned["projects"][0]["description"] == "Built a ledger"
    assert cleaned["projects"][0]["technologies"] == ["Python", "SQL"]
