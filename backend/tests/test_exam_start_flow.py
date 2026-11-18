"""Initial exam budget/mapping and safe saved-attempt resume regressions."""
import json
import os
import sys
import tempfile
import time
import uuid

os.environ.setdefault("DB_PATH", os.path.join(tempfile.mkdtemp(prefix="sb_start_"), "test.db"))
os.environ.setdefault("PBKDF2_ITERATIONS", "1000")
os.environ["SEED_DEMO"] = "false"
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import pytest
from fastapi.testclient import TestClient
import main
import enterprise
import proctoring
from test_exam_policy import build_bank, profile

client = TestClient(main.app)
# Every exam is proctored: consent, all four devices and an identity outcome.
PROCTORED = {"proctoring_consent": proctoring.CONSENT_VERSION,
             "proctoring_ready": {key: True for key in proctoring.REQUIRED},
             "identity_status": "needs_review"}


@pytest.fixture
def candidate(monkeypatch):
    email = uuid.uuid4().hex + "@example.test"
    response = client.post("/api/auth/register", json={"email": email, "name": "Exam Candidate", "password": "Str0ng-Passw0rd-2026"})
    assert response.status_code == 200, response.text
    headers = {"Authorization": "Bearer " + response.json()["token"]}
    assert client.post("/api/consent", json={"lang": "en"}, headers=headers).status_code == 200
    uid = main.one("SELECT id FROM users WHERE email=?", (email,))["id"]
    confirmed = ["python", "javascript", "ai_ml", "docker"]
    main.run("INSERT INTO profiles(user_id,redacted,confirmed) VALUES (?,?,?)", (uid, "[NAME]\nConfirmed technical CV", json.dumps(confirmed)))
    data = profile()
    main.run("INSERT INTO candidate_profiles(user_id,skills,experience,projects,updated) VALUES (?,?,?,?,?)",
             (uid, json.dumps(data["skills"]), json.dumps(data["experience"]), json.dumps(data["projects"]), time.time()))
    original_allr = main.allr
    bank = build_bank()
    monkeypatch.setattr(main, "allr", lambda sql, args=(): bank if sql.startswith("SELECT * FROM question_bank WHERE status='active'") else original_allr(sql, args))
    monkeypatch.setattr(enterprise, "_seed_question_bank", lambda: None)
    return uid, headers


def blueprint(headers, endpoint="initial-blueprint"):
    response = client.post("/api/assessment/" + endpoint, json={"department": "CS/IT"}, headers=headers)
    assert response.status_code == 200, response.text
    assert response.json()["status"] == "ready", response.text
    return response.json()


def start(headers, bp):
    response = client.post("/api/attempts", json={"blueprint_id": bp["blueprint_id"], **PROCTORED}, headers=headers)
    assert response.status_code == 200, response.text
    return response.json()


@pytest.mark.parametrize("endpoint", ["initial-blueprint", "job-blueprint"])
def test_initial_blueprint_alias_public_metadata_and_hard_server_budget(candidate, endpoint):
    uid, headers = candidate
    bp = blueprint(headers, endpoint)
    assert bp["mode"] == "initial_cv_fundamentals" and bp["time_budget_seconds"] == 2400
    assert bp["sections"] == {"fundamentals": 20, "cv_clusters": 16, "project_probes": 4}
    read = client.get("/api/assessment/blueprint/" + bp["blueprint_id"], headers=headers)
    assert read.status_code == 200, read.text
    assert read.json()["fundamental_count"] == 20 and read.json()["cv_count"] == 16
    assert "correct_answer" not in read.text and "reference_answer" not in read.text
    # Authoring times cannot accidentally extend the Initial exam's hard limit.
    payload = json.loads(main.one("SELECT payload FROM assessment_blueprints WHERE id=?", (bp["blueprint_id"],))["payload"])
    payload["estimated_duration_seconds"] = 9000
    main.run("UPDATE assessment_blueprints SET payload=? WHERE id=?", (json.dumps(payload), bp["blueprint_id"]))
    attempt = start(headers, bp)
    assert attempt["kind"] == "pre" and attempt["mode"] == "initial_cv_fundamentals"
    assert attempt["duration_seconds"] == 2400 and 2390 < attempt["remaining"] <= 2400
    assert attempt["department"] == "CS/IT" and attempt["total"] == 40
    assert "correct_answer" not in json.dumps(attempt) and "reference_answer" not in json.dumps(attempt)
    stored = json.loads(main.one("SELECT state FROM attempts WHERE id=? AND user_id=?", (attempt["attempt_id"], uid))["state"])
    assert stored["sections"] == bp["sections"] and stored["policy"]


def test_resume_preserves_questions_answers_and_original_deadline(candidate):
    uid, headers = candidate
    bp = blueprint(headers)
    attempt = start(headers, bp)
    aid = attempt["attempt_id"]
    row = main.one("SELECT * FROM attempts WHERE id=?", (aid,))
    state = json.loads(row["state"])
    state["answers"] = {state["selected_questions"][0]["id"]: "My saved answer"}
    state["question_index"] = 2
    state["current"] = state["selected_questions"][2]["id"]
    started = time.time() - 100
    main.run("UPDATE attempts SET state=?,started=? WHERE id=?", (json.dumps(state), started, aid))
    resumed = client.post("/api/attempts", json={"resume_attempt_id": aid, "blueprint_id": "must-not-be-looked-up", **PROCTORED}, headers=headers)
    assert resumed.status_code == 200, resumed.text
    resumed = resumed.json()
    assert resumed["attempt_id"] == aid and resumed["blueprint_id"] == bp["blueprint_id"]
    assert resumed["answers"] == state["answers"] and resumed["question_index"] == 2
    assert resumed["session_id"] != attempt["session_id"] and resumed["duration_seconds"] == 2400
    assert 2290 < resumed["remaining"] <= 2300
    assert main.one("SELECT started FROM attempts WHERE id=?", (aid,))["started"] == started
    assert main.one("SELECT COUNT(*) AS n FROM attempts WHERE user_id=?", (uid,))["n"] == 1


def test_expired_resume_finishes_without_starting_a_replacement(candidate):
    uid, headers = candidate
    attempt = start(headers, blueprint(headers))
    aid = attempt["attempt_id"]
    main.run("UPDATE attempts SET started=? WHERE id=?", (time.time() - 3000, aid))
    response = client.post("/api/attempts", json={"resume_attempt_id": aid, **PROCTORED}, headers=headers)
    assert response.status_code == 200, response.text
    assert response.json()["status"] == "done" and response.json()["attempt_id"] == aid
    assert main.one("SELECT COUNT(*) AS n FROM attempts WHERE user_id=?", (uid,))["n"] == 1
    assert client.post("/api/attempts", json={"resume_attempt_id": aid, **PROCTORED}, headers=headers).json()["status"] == "done"


def test_resume_cannot_access_another_candidates_attempt(candidate):
    _, headers = candidate
    response = client.post("/api/attempts", json={"resume_attempt_id": "not-owned"}, headers=headers)
    assert response.status_code == 404


def test_new_initial_exam_does_not_inherit_the_demo_unlimited_timer(candidate, monkeypatch):
    uid, headers = candidate
    email = main.one("SELECT email FROM users WHERE id=?", (uid,))["email"]
    monkeypatch.setattr(main, "UNLIMITED_EXAM_EMAILS", {email})
    attempt = start(headers, blueprint(headers))
    assert attempt["unlimited_time"] is False and attempt["remaining"] > 2300
    main.run("UPDATE attempts SET started=? WHERE id=?", (time.time() - 3000, attempt["attempt_id"]))
    resumed = client.post("/api/attempts", json={"resume_attempt_id": attempt["attempt_id"], **PROCTORED}, headers=headers)
    assert resumed.status_code == 200 and resumed.json()["status"] == "done"


def test_profile_blueprint_has_distinct_retake_metadata(candidate):
    _, headers = candidate
    response = client.post("/api/assessment/blueprint", headers=headers)
    assert response.status_code == 200, response.text
    bp = response.json()
    assert bp["mode"] == "profile_retake"
    read = client.get("/api/assessment/blueprint/" + bp["blueprint_id"], headers=headers)
    assert read.status_code == 200 and read.json()["mode"] == "profile_retake"


def test_profile_retake_keeps_its_own_duration_and_existing_review_credit_gates(candidate):
    uid, headers = candidate
    previous = uuid.uuid4().hex
    finished = time.time() - 100 * 86400  # Outside any cooldown/rolling attempt cap.
    result = {"overall": 50, "topics": {"python": {"score": 50}}}
    main.run("INSERT INTO attempts(id,user_id,kind,seed,status,state,started,finished,result) VALUES (?,?,?,?,?,?,?,?,?)",
             (previous, uid, "pre", 1, "done", "{}", finished - 2400, finished, json.dumps(result)))
    questions = build_bank()[:3]
    bp = uuid.uuid4().hex
    main.run("INSERT INTO assessment_blueprints(id,user_id,status,payload,created) VALUES (?,?,?,?,?)",
             (bp, uid, "ready", json.dumps({"questions": questions, "total_questions": 3, "estimated_duration_seconds": 3420, "mode": "profile_retake"}), time.time()))
    request = lambda: client.post("/api/attempts", json={"blueprint_id": bp, **PROCTORED}, headers=headers)
    assert request().json()["detail"] == "result_awaiting_review"
    main.run("INSERT INTO admin_attempt_reviews(attempt_id,decision,reason,reviewer_id,reviewed_at) VALUES (?,?,?,?,?)",
             (previous, "approved", "MOCK approved academic review", uid, time.time()))
    assert request().json()["detail"] == "result_awaiting_honesty_review"
    main.run("INSERT INTO attempt_honesty_reviews(attempt_id,auto_score,score,status,updated_at) VALUES (?,?,?,?,?)",
             (previous, 90, 90, "approved", time.time()))
    assert request().json()["detail"] == "retake_credit_required"
    main.run("INSERT INTO billing_credit_ledger(id,user_id,delta,entry_type,source_ref,reason,actor_id,created) VALUES (?,?,?,?,?,?,?,?)",
             (uuid.uuid4().hex, uid, 100, "admin_adjustment", "MOCK", "MOCK retake credits", uid, time.time()))
    response = request()
    assert response.status_code == 200, response.text
    assert response.json()["kind"] == "post" and response.json()["mode"] == "profile_retake"
    assert response.json()["duration_seconds"] == 3420
