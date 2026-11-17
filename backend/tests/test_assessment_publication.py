"""Submission -> drafts -> two reviews -> versioned learning/credential release."""
import json
import os
import sys
import tempfile
import uuid

import pytest

_TMP = tempfile.mkdtemp(prefix="sb_publication_")
os.environ.setdefault("DB_PATH", os.path.join(_TMP, "test.db"))
os.environ.setdefault("PBKDF2_ITERATIONS", "1000")
os.environ["SEED_DEMO"] = "false"
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from fastapi.testclient import TestClient
import main
import assessment_workflow as workflow

client = TestClient(main.app)


def account(admin=False):
    email = uuid.uuid4().hex + "@example.com"
    response = client.post("/api/auth/register", json={"email": email, "name": "Review Candidate", "password": "Str0ng-Passw0rd-2026"})
    assert response.status_code == 200, response.text
    headers = {"Authorization": "Bearer " + response.json()["token"]}
    uid = main.one("SELECT id FROM users WHERE email=?", (email,))["id"]
    if admin:
        main.run("UPDATE user_roles SET role='admin' WHERE user_id=?", (uid,))
        main.run("INSERT INTO admin_staff_roles(user_id,admin_role,updated_by,updated_at) VALUES (?,?,?,?)", (uid, "super_admin", uid, 0))
    else:
        assert client.post("/api/consent", json={"lang": "en"}, headers=headers).status_code == 200
    return uid, headers


def assessment():
    uid, headers = account()
    _, admin = account(True)
    aid = uuid.uuid4().hex
    questions = [{"id": aid + "-mcq", "assessment_section": "fundamental", "assessment_topic": "DSA", "assessment_topic_key": "dsa",
                  "question_type": "MCQ", "question_text": "Which data structure is LIFO?", "correct_answer": "Stack", "marks": 2}]
    for suffix, kind in [("explain", "Explanation"), ("code", "Coding"), ("scenario", "Scenario")]:
        questions.append({"id": aid + "-" + suffix, "assessment_section": "cv", "assessment_topic": "Python", "assessment_topic_key": "python",
                          "question_type": kind, "question_text": "Explain a safe Python validation strategy.", "correct_answer": "Validate input types and handle errors safely.",
                          "reference_answer": "Validate input types and handle errors safely.", "grading_rubric": "Input type validation and safe error handling.", "marks": 2})
    state = {"graphrag": True, "blueprint_id": aid, "selected_questions": questions, "question_index": 0,
             "answers": {q["id"]: q["correct_answer"] for q in questions}, "duration_seconds": 600, "seed": 1, "current": None}
    main.run("INSERT INTO attempts(id,user_id,kind,seed,status,state,started) VALUES (?,?,?,?,?,?,?)", (aid, uid, "pre", 1, "active", json.dumps(state), 1))
    main.finalize(dict(main.one("SELECT * FROM attempts WHERE id=?", (aid,))), state)
    return uid, headers, admin, aid, questions


def academic(admin, aid, questions, marks=1):
    response = client.post(f"/api/admin/attempts/{aid}/review", json={"decision": "approved", "reason": "Reviewed each answer against the stored rubric.",
        "evaluations": [{"question_id": q["id"], "marks": marks, "admin_note": "Partial marks based on the answer evidence."} for q in questions[1:]]}, headers=admin)
    assert response.status_code == 200, response.text
    return response.json()


def honesty(admin, aid, score=82, decision="approved"):
    response = client.post(f"/api/admin/integrity/attempts/{aid}/honesty", json={"score": score, "decision": decision, "reason": "Timeline and integrity evidence reviewed by a human."}, headers=admin)
    assert response.status_code == 200, response.text
    return response.json()


def test_every_subjective_format_has_a_draft_but_mcq_feedback_is_not_a_final_score():
    uid, headers, admin, aid, questions = assessment()
    drafts = main.attempt_evaluations(aid)
    assert len(drafts) == 3
    assert all(d["status"] == "pending_approval" and d["ai_marks"] is not None for d in drafts)
    result = client.get(f"/api/attempts/{aid}/result", headers=headers).json()
    assert result["objective_summary"]["mcq_score"] == 100
    assert result["overall"] is None
    assert result["publication"]["pending_evaluations"] == 3
    assert result["topics"]["python"]["score"] is None
    assert result["topics"]["python"]["total_questions"] == 3
    learning = client.get("/api/learning/dashboard", headers=headers).json()
    assert learning["resources"] == [] and learning["learning_plan"] is None
    assert client.get("/api/learning-path", headers=headers).status_code == 409
    assert main.one("SELECT COUNT(*) AS n FROM passports WHERE user_id=?", (uid,))["n"] == 0
    assert main.one("SELECT COUNT(*) AS n FROM assessment_releases WHERE user_id=?", (uid,))["n"] == 0


@pytest.mark.parametrize("academic_first", [True, False])
def test_both_approval_orders_publish_matching_scores_honesty_courses_and_passport(academic_first):
    uid, headers, admin, aid, questions = assessment()
    first = academic(admin, aid, questions) if academic_first else honesty(admin, aid)
    assert first["publication"]["ready"] is False and first["passport_id"] is None
    second = honesty(admin, aid) if academic_first else academic(admin, aid, questions)
    assert second["publication"]["ready"] is True and second["release_id"] and second["passport_id"]
    result = client.get(f"/api/attempts/{aid}/result", headers=headers).json()
    assert result["overall"] == 80 and result["topics"]["python"]["score"] == 50
    assert result["honesty"]["score"] == 82
    learning = client.get("/api/learning/dashboard", headers=headers).json()
    assert learning["approved"] and learning["learning_plan"]["release_id"] == second["release_id"]
    assert any(resource["topic"] == "python" and resource["citation_id"] for resource in learning["resources"])
    public = client.get("/api/public/passport/" + second["passport_id"]).json()
    assert public["signature_valid"] and not public["revoked"]
    passport = public["passport"]
    assert passport["honesty"]["score"] == 82 and passport["assessment"]["overall"] == 80
    assert passport["holder"] == "Review Candidate"
    assert next(skill for skill in passport["skills"] if skill["skill"] == "python")["questions"] == 3
    assert workflow.sync_release(aid)["release_id"] == second["release_id"]
    assert main.one("SELECT COUNT(*) AS n FROM assessment_releases WHERE attempt_id=?", (aid,))["n"] == 1


def test_mark_amendment_withdraws_stale_passport_and_persists_a_new_revision():
    uid, headers, admin, aid, questions = assessment()
    academic(admin, aid, questions)
    published = honesty(admin, aid)
    edit = client.patch(f"/api/admin/attempts/{aid}/evaluations/{questions[1]['id']}", headers=admin,
                        json={"question_id": questions[1]["id"], "marks": 0, "admin_note": "Removed unsupported partial credit.", "status": "approved"})
    assert edit.status_code == 200, edit.text
    assert client.get("/api/public/passport/" + published["passport_id"]).json()["revoked"]
    assert client.get("/api/learning/dashboard", headers=headers).json()["resources"] == []
    reviewed = client.post(f"/api/admin/attempts/{aid}/review", json={"decision": "approved", "reason": "Approved the revised marks after evidence review."}, headers=admin)
    assert reviewed.status_code == 200, reviewed.text
    revised = reviewed.json()
    assert revised["release_id"] != published["release_id"] and revised["passport_id"] != published["passport_id"]
    assert len(client.get("/api/learning/dashboard", headers=headers).json()["release_history"]) == 2
    assert main.one("SELECT COUNT(*) AS n FROM assessment_learning_plans WHERE user_id=?", (uid,))["n"] == 2


def test_honesty_revisions_do_not_change_technical_marks_and_revoke_old_credentials():
    _, headers, admin, aid, questions = assessment()
    academic(admin, aid, questions)
    old = honesty(admin, aid)
    changed = honesty(admin, aid, score=61)
    assert changed["release_id"] != old["release_id"]
    assert client.get("/api/public/passport/" + old["passport_id"]).json()["revoked"]
    assert client.get(f"/api/attempts/{aid}/result", headers=headers).json()["overall"] == 80
    honesty(admin, aid, score=61, decision="pending")
    assert not workflow.review_state(aid)["ready"]
    assert client.get("/api/public/passport/" + changed["passport_id"]).json()["revoked"]
    assert json.loads(main.one("SELECT result FROM attempts WHERE id=?", (aid,))["result"])["overall"] == 80
    restored = honesty(admin, aid, score=61)
    assert restored["passport_id"] and restored["passport_id"] != changed["passport_id"]
    assert restored["release_id"] == changed["release_id"]


def test_holder_revocation_is_not_undone_by_a_publication_retry():
    _, headers, admin, aid, questions = assessment()
    academic(admin, aid, questions)
    publication = honesty(admin, aid)
    assert client.delete("/api/passport/" + publication["passport_id"], headers=headers).status_code == 200
    assert workflow.sync_release(aid)["passport_id"] is None
    assert client.get("/api/public/passport/" + publication["passport_id"]).json()["revoked"]


def test_invalid_overrides_do_not_write_an_approval_or_release():
    uid, _, admin, aid, questions = assessment()
    response = client.post(f"/api/admin/attempts/{aid}/review", json={"decision": "approved", "reason": "Review reason is present.",
        "evaluations": [{"question_id": questions[1]["id"], "marks": 99}]}, headers=admin)
    assert response.status_code == 422
    assert main.one("SELECT * FROM admin_attempt_reviews WHERE attempt_id=?", (aid,)) is None
    assert main.one("SELECT COUNT(*) AS n FROM assessment_releases WHERE user_id=?", (uid,))["n"] == 0


def test_missing_draft_blocks_publication_and_can_be_rebuilt_without_live_ai(monkeypatch):
    import ai_providers as AIP
    _, _, admin, aid, questions = assessment()
    main.run("DELETE FROM answer_evaluations WHERE attempt_id=? AND question_id=?", (aid, questions[2]["id"]))
    blocked = client.post(f"/api/admin/attempts/{aid}/review", headers=admin,
                          json={"decision": "approved", "reason": "Attempted approval before every draft existed."})
    assert blocked.status_code == 409
    assert main.one("SELECT * FROM admin_attempt_reviews WHERE attempt_id=?", (aid,)) is None
    def no_model_calls(*args, **kwargs):
        raise AssertionError("A live model must not grade answers")
    monkeypatch.setattr(AIP.httpx, "post", no_model_calls)
    rebuilt = client.post(f"/api/admin/attempts/{aid}/evaluate", headers=admin, json={"use_llm": True})
    assert rebuilt.status_code == 200, rebuilt.text
    assert rebuilt.json()["llm_calls"] == 0 and len(rebuilt.json()["items"]) == 3


def test_missing_rubric_cannot_be_blindly_approved_as_zero():
    _, _, admin, aid, questions = assessment()
    main.run("UPDATE answer_evaluations SET flags=? WHERE attempt_id=? AND question_id=?",
             (json.dumps(["missing_stored_rubric"]), aid, questions[1]["id"]))
    blocked = client.post(f"/api/admin/attempts/{aid}/review", headers=admin,
                          json={"decision": "approved", "reason": "Review without explicit missing-rubric marks."})
    assert blocked.status_code == 409
    assert main.one("SELECT * FROM admin_attempt_reviews WHERE attempt_id=?", (aid,)) is None
    assert academic(admin, aid, questions)["decision"] == "approved"


def test_admin_can_reduce_objective_marks_with_an_audited_reason():
    _, _, admin, aid, questions = assessment()
    response = client.patch(f"/api/admin/attempts/{aid}/evaluations/{questions[0]['id']}", headers=admin,
                            json={"question_id": questions[0]["id"], "marks": 1, "admin_note": "Question ambiguity reviewed; partial credit approved."})
    assert response.status_code == 200, response.text
    raw = json.loads(main.one("SELECT result FROM attempts WHERE id=?", (aid,))["result"])
    assert raw["question_results"][0]["awarded_marks"] == 1
    assert main.one("SELECT COUNT(*) AS n FROM audit WHERE action='answer_evaluation_edited' AND target LIKE ?", (aid + "%",))["n"] >= 1


def test_export_and_deletion_include_result_and_learning_snapshots():
    uid, headers, admin, aid, questions = assessment()
    academic(admin, aid, questions)
    honesty(admin, aid)
    exported = client.get("/api/me/export", headers=headers).json()
    assert exported["assessment_releases"] and exported["assessment_learning_plans"]
    assert client.delete("/api/me", headers=headers).status_code == 200
    for table in ("assessment_releases", "assessment_learning_plans"):
        assert main.one(f"SELECT COUNT(*) AS n FROM {table} WHERE user_id=?", (uid,))["n"] == 0


def test_ai_study_guidance_is_blocked_before_both_reviews_and_does_not_grade(monkeypatch):
    import ai_providers as AIP
    _, headers, admin, aid, questions = assessment()
    assert client.post("/api/learning/plan/explain", headers=headers).status_code == 409
    academic(admin, aid, questions)
    honesty(admin, aid)
    monkeypatch.setattr(AIP, "any_provider_configured", lambda: False)
    response = client.post("/api/learning/plan/explain", headers=headers)
    assert response.status_code == 200 and response.json()["status"] == "not_configured"
    assert client.get(f"/api/attempts/{aid}/result", headers=headers).json()["overall"] == 80


def test_legacy_anonymous_passport_is_renamed_and_resigned_once():
    uid, _headers = account()
    payload = {"pid": "legacy-anon", "holder": "Anonymous candidate", "skills": []}
    main.run("INSERT INTO passports(id,user_id,payload,signature,created) VALUES (?,?,?,?,?)",
             ("legacy-anon", uid, json.dumps(payload), main.E.sign_payload(payload, main.SECRET), 1))

    main.backfill_passport_holders()
    row = main.one("SELECT payload,signature FROM passports WHERE id=?", ("legacy-anon",))
    updated = json.loads(row["payload"])
    assert updated["holder"] == "Review Candidate"
    assert row["signature"] == main.E.sign_payload(updated, main.SECRET)

    main.backfill_passport_holders()
    again = main.one("SELECT payload,signature FROM passports WHERE id=?", ("legacy-anon",))
    assert json.loads(again["payload"]) == updated
    assert again["signature"] == row["signature"]
