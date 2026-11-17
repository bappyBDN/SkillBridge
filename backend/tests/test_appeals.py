"""Candidate appeal lifecycle: invalidate -> appeal -> uphold / overturn / more info."""
import json
import os
import sys
import tempfile
import uuid

from fastapi.testclient import TestClient

_TMP = tempfile.mkdtemp(prefix="sb_appeals_")
os.environ.setdefault("DB_PATH", os.path.join(_TMP, "test.db"))
os.environ.setdefault("PBKDF2_ITERATIONS", "1000")
os.environ["SEED_DEMO"] = "false"
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import main
import enterprise

client = TestClient(main.app)


def account(admin=False):
    email = uuid.uuid4().hex + "@example.com"
    response = client.post("/api/auth/register", json={
        "email": email, "name": "Appeal Candidate", "password": "Str0ng-Passw0rd-2026"})
    assert response.status_code == 200, response.text
    headers = {"Authorization": "Bearer " + response.json()["token"]}
    uid = main.one("SELECT id FROM users WHERE email=?", (email,))["id"]
    if admin:
        main.run("UPDATE user_roles SET role='admin' WHERE user_id=?", (uid,))
        main.run("INSERT INTO admin_staff_roles(user_id,admin_role,updated_by,updated_at) VALUES (?,?,?,?)",
                 (uid, "super_admin", uid, 0))
    else:
        assert client.post("/api/consent", json={"lang": "en"}, headers=headers).status_code == 200
    return uid, headers


def assessment():
    uid, headers = account()
    _, admin = account(True)
    aid = uuid.uuid4().hex
    questions = [{
        "id": aid + "-mcq", "assessment_section": "fundamental", "assessment_topic": "DSA",
        "assessment_topic_key": "dsa", "question_type": "MCQ",
        "question_text": "Which data structure is LIFO?", "correct_answer": "Stack", "marks": 2,
    }]
    for suffix, kind in [("explain", "Explanation"), ("code", "Coding"), ("scenario", "Scenario")]:
        questions.append({
            "id": aid + "-" + suffix, "assessment_section": "cv", "assessment_topic": "Python",
            "assessment_topic_key": "python", "question_type": kind,
            "question_text": "Explain a safe Python validation strategy.",
            "correct_answer": "Validate input types and handle errors safely.",
            "reference_answer": "Validate input types and handle errors safely.",
            "grading_rubric": "Input type validation and safe error handling.", "marks": 2,
        })
    state = {"graphrag": True, "blueprint_id": aid, "selected_questions": questions,
             "question_index": 0, "answers": {q["id"]: q["correct_answer"] for q in questions},
             "duration_seconds": 600, "seed": 1, "current": None}
    main.run("INSERT INTO attempts(id,user_id,kind,seed,status,state,started) VALUES (?,?,?,?,?,?,?)",
             (aid, uid, "pre", 1, "active", json.dumps(state), 1))
    main.finalize(dict(main.one("SELECT * FROM attempts WHERE id=?", (aid,))), state)
    return uid, headers, admin, aid, questions


def academic(admin, aid, questions):
    response = client.post(f"/api/admin/attempts/{aid}/review", headers=admin, json={
        "decision": "approved", "reason": "Reviewed each answer against the stored rubric.",
        "evaluations": [{"question_id": q["id"], "marks": 1,
                         "admin_note": "Partial marks based on the answer evidence."}
                        for q in questions[1:]],
    })
    assert response.status_code == 200, response.text
    return response.json()


def honesty(admin, aid):
    response = client.post(f"/api/admin/integrity/attempts/{aid}/honesty", headers=admin,
                           json={"score": 82, "decision": "approved",
                                 "reason": "Timeline and integrity evidence reviewed by a human."})
    assert response.status_code == 200, response.text
    return response.json()


def invalidate(admin, aid, reason="The stored answer evidence did not support the submitted result."):
    response = client.post(f"/api/admin/attempts/{aid}/review", headers=admin,
                           json={"decision": "invalidated", "reason": reason})
    assert response.status_code == 200, response.text
    return response.json()


def appeal(headers, aid, note="My saved answer was submitted before the timer ended."):
    response = client.post(f"/api/attempts/{aid}/appeal", headers=headers, json={"note": note})
    assert response.status_code == 200, response.text
    return response.json()


def appeal_row(admin, aid):
    rows = client.get("/api/admin/appeals", headers=admin).json()["items"]
    return next(row for row in rows if row["attempt_id"] == aid)


def decide(admin, aid, decision, reason="Independent appeal review completed with evidence."):
    return client.post(f"/api/admin/appeals/{aid}/decision", headers=admin,
                       json={"decision": decision, "reason": reason})


def test_separate_admin_can_overturn_and_the_candidate_result_is_restored():
    uid, headers, admin1, aid, questions = assessment()
    academic(admin1, aid, questions)
    published = honesty(admin1, aid)
    assert published["passport_id"]
    invalidate(admin1, aid)
    assert client.get(f"/api/attempts/{aid}/result", headers=headers).json()["overall"] is None
    appeal(headers, aid)

    _, admin2 = account(True)
    row = appeal_row(admin2, aid)
    assert row["can_decide"] is True
    assert row["original_reviewer_name"] == "Appeal Candidate"

    overturned = decide(admin2, aid, "overturned", "The network interruption is confirmed by session logs.")
    assert overturned.status_code == 200, overturned.text
    body = overturned.json()
    assert body["decision"] == "overturned"
    assert body["publication"]["ready"] is True
    assert body["passport_id"]

    state = client.get("/api/state", headers=headers).json()
    item = next(a for a in state["attempts"] if a["id"] == aid)
    assert item["review_decision"] == "approved"
    assert item["finalized"] is True
    assert item["appeal_decision"] == "overturned"
    assert item["overall"] == 80

    public = client.get("/api/public/passport/" + body["passport_id"]).json()
    assert public["revoked"] is False
    assert public["passport"]["assessment"]["overall"] == 80


def test_original_reviewer_is_blocked_only_when_another_admin_exists():
    _, headers, admin1, aid, questions = assessment()
    academic(admin1, aid, questions)
    honesty(admin1, aid)
    invalidate(admin1, aid)
    appeal(headers, aid)

    blocked = decide(admin1, aid, "upheld")
    assert blocked.status_code == 409
    assert "separation of duties" in blocked.json()["detail"].lower()

    _, admin2 = account(True)
    allowed = decide(admin2, aid, "upheld")
    assert allowed.status_code == 200, allowed.text
    assert allowed.json()["decision"] == "upheld"

    result = client.get(f"/api/attempts/{aid}/result", headers=headers).json()
    assert result["review_decision"] == "invalidated"
    assert result["appeal_decision"] == "upheld"
    assert result["overall"] is None


def test_single_admin_deployment_records_an_explicit_override(monkeypatch):
    _, headers, admin1, aid, questions = assessment()
    admin_uid = client.get("/api/admin/console/me", headers=admin1).json()["user_id"]
    academic(admin1, aid, questions)
    honesty(admin1, aid)
    invalidate(admin1, aid)
    appeal(headers, aid)

    monkeypatch.setattr(enterprise, "_appeals_eligible_admin_ids", lambda: {admin_uid})
    allowed = decide(admin1, aid, "upheld")
    assert allowed.status_code == 200, allowed.text
    assert allowed.json()["single_admin_override"] is True
    assert main.one("SELECT COUNT(*) AS n FROM audit WHERE action='appeal_single_admin_override' AND target=?",
                    (aid,))["n"] == 1


def test_more_info_reopens_the_appeal_so_the_candidate_can_answer():
    _, headers, admin1, aid, questions = assessment()
    academic(admin1, aid, questions)
    honesty(admin1, aid)
    invalidate(admin1, aid)
    appeal(headers, aid, "The system reloaded while I was answering.")
    _, admin2 = account(True)

    more = decide(admin2, aid, "needs_more_info", "Please add the approximate reload time and browser.")
    assert more.status_code == 200, more.text
    row = appeal_row(admin2, aid)
    assert row["open"] is True and row["can_decide"] is True

    resubmitted = client.post(f"/api/attempts/{aid}/appeal", headers=headers,
                              json={"note": "It reloaded around 14:12 in Chrome."})
    assert resubmitted.status_code == 200, resubmitted.text
    assert resubmitted.json()["resubmitted"] is True

    row = appeal_row(admin2, aid)
    assert row["decision"] is None
    assert "14:12" in row["appeal"] and "system reloaded" in row["appeal"].lower()

    overturned = decide(admin2, aid, "overturned", "Reload time matches the integrity timeline.")
    assert overturned.status_code == 200, overturned.text
    assert overturned.json()["publication"]["ready"] is True


def test_overturn_never_promotes_unapproved_ai_drafts():
    _, headers, admin1, aid, questions = assessment()
    invalidate(admin1, aid, "The draft responses need a full academic review before publication.")
    appeal(headers, aid)
    _, admin2 = account(True)

    overturned = decide(admin2, aid, "overturned", "The invalidation reason did not apply.")
    assert overturned.status_code == 200, overturned.text
    publication = overturned.json()["publication"]
    assert publication["ready"] is False
    assert publication["pending_evaluations"] >= 1
    assert overturned.json()["passport_id"] is None
    result = client.get(f"/api/attempts/{aid}/result", headers=headers).json()
    assert result["overall"] is None


def test_open_appeal_count_excludes_final_decisions_but_keeps_more_info():
    _, headers, admin1, aid, questions = assessment()
    academic(admin1, aid, questions)
    honesty(admin1, aid)
    invalidate(admin1, aid)
    appeal(headers, aid)
    _, admin2 = account(True)

    before = client.get("/api/admin/console/overview", headers=admin2).json()["counts"]["open_appeals"]
    assert before >= 1
    decide(admin2, aid, "needs_more_info", "Need the candidate's approximate reload time.")
    during = client.get("/api/admin/console/overview", headers=admin2).json()["counts"]["open_appeals"]
    assert during >= 1
    decide(admin2, aid, "upheld", "Evidence does not support the appeal.")
    after = client.get("/api/admin/console/overview", headers=admin2).json()["counts"]["open_appeals"]
    assert after == before - 1
