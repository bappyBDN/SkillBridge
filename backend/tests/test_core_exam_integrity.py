"""Exam integrity regressions: quit-and-restart abuse, single finalize, expired
attempts, the unlimited-timer rule, the answered count, terminal honesty
rejection and the candidate reply to "needs more information"."""
import json
import os
import sys
import tempfile
import time
import uuid

os.environ.setdefault("DB_PATH", os.path.join(tempfile.mkdtemp(prefix="sb_core_exam_"), "test.db"))
os.environ.setdefault("PBKDF2_ITERATIONS", "1000")
os.environ["SEED_DEMO"] = "false"
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

import main
import enterprise  # noqa: F401
import assessment_workflow as workflow
from test_exam_start_flow import PROCTORED, blueprint, candidate, start  # noqa: F401  (fixture)

client = TestClient(main.app)


def account(name="Integrity Candidate"):
    email = uuid.uuid4().hex + "@example.com"
    response = client.post("/api/auth/register", json={"email": email, "name": name, "password": "Str0ng-Passw0rd-2026"})
    assert response.status_code == 200, response.text
    headers = {"Authorization": "Bearer " + response.json()["token"]}
    assert client.post("/api/consent", json={"lang": "en"}, headers=headers).status_code == 200
    return main.one("SELECT id FROM users WHERE email=?", (email,))["id"], headers, email


def graphrag_attempt(uid, *, answers=None, started=None, status="active", mode="initial_cv_fundamentals"):
    aid = uuid.uuid4().hex[:12]
    questions = [{"id": aid + "-q1", "assessment_section": "fundamental", "assessment_topic": "DSA",
                  "assessment_topic_key": "dsa", "question_type": "MCQ", "question_text": "LIFO?",
                  "options": ["Queue", "Stack"], "correct_answer": "Stack", "marks": 1},
                 {"id": aid + "-q2", "assessment_section": "fundamental", "assessment_topic": "DSA",
                  "assessment_topic_key": "dsa", "question_type": "MCQ", "question_text": "FIFO?",
                  "options": ["Queue", "Stack"], "correct_answer": "Queue", "marks": 1}]
    state = {"graphrag": True, "blueprint_id": "bp-" + aid, "selected_questions": questions, "mode": mode,
             "question_index": 0, "answers": answers if answers is not None else {}, "duration_seconds": 600,
             "seed": 1, "current": questions[0]["id"]}
    main.run("INSERT INTO attempts(id,user_id,kind,seed,status,state,started) VALUES (?,?,?,?,?,?,?)",
             (aid, uid, "pre", 1, status, json.dumps(state), started if started is not None else time.time()))
    return aid, state


def row(aid):
    return dict(main.one("SELECT * FROM attempts WHERE id=?", (aid,)))


# ------------------------------------------------------------------ 3. quit abuse
def test_quit_questions_are_never_reserved(candidate):
    uid, headers = candidate
    bp = blueprint(headers)
    attempt = start(headers, bp)
    quit_response = client.post(f"/api/attempts/{attempt['attempt_id']}/quit",
                                json={"session_id": attempt["session_id"]}, headers=headers)
    assert quit_response.status_code == 200, quit_response.text
    assert quit_response.json()["status"] == "quit"
    assert quit_response.json()["counts_toward_attempt_cap"] is False   # first quit: honest-path allowance
    shown = {q["id"] for q in attempt["all_questions"]}
    assert shown <= main.asked_question_ids(uid)
    # Reusing the old blueprint would re-serve the same questions.
    again = client.post("/api/attempts", json={"blueprint_id": bp["blueprint_id"], **PROCTORED}, headers=headers)
    assert again.status_code == 409 and again.json()["detail"] == "blueprint_contains_seen_questions"
    fresh = client.post("/api/assessment/initial-blueprint", json={"department": "CS/IT"}, headers=headers)
    assert fresh.status_code == 200, fresh.text
    if fresh.json()["status"] == "ready":
        payload = json.loads(main.one("SELECT payload FROM assessment_blueprints WHERE id=?",
                                      (fresh.json()["blueprint_id"],))["payload"])
        assert not shown & {q["id"] for q in payload["questions"]}


def _policy_max_attempts():
    policy = main.one("SELECT max_attempts_90d FROM learning_retake_policy WHERE id=1")
    return int(policy["max_attempts_90d"]) if policy else main.MAX_ATTEMPTS_90D


def _insert_quits(uid, count):
    for _ in range(count):
        main.run("INSERT INTO attempts(id,user_id,kind,seed,status,state,started,finished) VALUES (?,?,?,?,?,?,?,?)",
                 (uuid.uuid4().hex[:12], uid, "pre", 1, "quit", "{}", time.time() - 60, time.time() - 30))


def test_quits_beyond_the_allowance_count_toward_the_attempt_cap(candidate, monkeypatch):
    uid, headers = candidate
    monkeypatch.setattr(main, "QUIT_ALLOWANCE_90D", 0)
    _insert_quits(uid, _policy_max_attempts())
    response = client.post("/api/attempts", json={"blueprint_id": blueprint(headers)["blueprint_id"], **PROCTORED},
                           headers=headers)
    assert response.status_code == 429 and response.json()["detail"] == "attempt_cap"


def test_quits_within_the_allowance_do_not_block_a_fresh_start(candidate, monkeypatch):
    uid, headers = candidate
    limit = _policy_max_attempts()
    monkeypatch.setattr(main, "QUIT_ALLOWANCE_90D", limit)
    _insert_quits(uid, limit)
    assert start(headers, blueprint(headers))["status"] == "active"


# ------------------------------------------------------------------ 4. finalize race
def test_finalize_grades_once_and_late_writes_are_refused():
    uid, headers, _ = account()
    aid, state = graphrag_attempt(uid, answers={})
    att = row(aid)
    assert main.finalize(att, json.loads(att["state"])) is True
    first = row(aid)
    assert main.finalize(att, json.loads(att["state"])) is False      # double submit
    assert row(aid)["result"] == first["result"] and row(aid)["finished"] == first["finished"]
    assert main.one("SELECT COUNT(*) AS n FROM audit WHERE action='attempt_done' AND target=?", (aid,))["n"] == 1
    late = dict(state, answers={state["selected_questions"][0]["id"]: "Stack"})
    with pytest.raises(HTTPException) as raised:
        main.save(aid, late)
    assert raised.value.status_code == 409
    assert json.loads(row(aid)["state"])["answers"] == {}
    repeat = client.post(f"/api/attempts/{aid}/submit", headers=headers)
    assert repeat.status_code == 200 and repeat.json()["status"] == "done"
    answer = client.post(f"/api/attempts/{aid}/answer", json={"question_id": aid + "-q1", "answer": "x"}, headers=headers)
    assert answer.status_code == 409


# ------------------------------------------------------------------ 5. expired attempts
def test_state_finalizes_an_expired_attempt_on_read():
    uid, headers, _ = account()
    aid, _ = graphrag_attempt(uid, started=time.time() - 10_000)
    response = client.get("/api/state", headers=headers)
    assert response.status_code == 200
    item = next(a for a in response.json()["attempts"] if a["id"] == aid)
    assert item["status"] == "done"


def test_sweeper_finalizes_expired_attempts_and_notifies():
    uid, _headers, _ = account()
    aid, _ = graphrag_attempt(uid, started=time.time() - 10_000)
    live, _ = graphrag_attempt(account()[0])
    assert main.finalize_expired_attempts() >= 1
    assert row(aid)["status"] == "done" and row(live)["status"] == "active"
    assert main.one("SELECT 1 AS x FROM notifications WHERE user_id=? AND kind='assessment_time_ended'", (uid,))


def test_unlimited_timer_is_env_driven_and_ignored_in_production(monkeypatch):
    assert "i@gmail.com" not in main.UNLIMITED_EXAM_EMAILS
    uid, _headers, email = account()
    aid, _ = graphrag_attempt(uid, started=time.time() - 10_000, mode="profile_retake")
    monkeypatch.setattr(main, "UNLIMITED_EXAM_EMAILS", {email})
    assert main.attempt_timed_out(row(aid)) is False
    monkeypatch.setattr(main, "IS_PRODUCTION", True)
    assert main.attempt_timed_out(row(aid)) is True
    monkeypatch.setattr(main, "IS_PRODUCTION", False)
    initial, _ = graphrag_attempt(uid, started=time.time() - 10_000)
    assert main.attempt_timed_out(row(initial)) is True       # Initial exams never get the bypass


# ------------------------------------------------------------------ 6. answered count
def test_blank_answers_are_not_counted_as_answered():
    uid, _headers, _ = account()
    aid, state = graphrag_attempt(uid)
    answers = {state["selected_questions"][0]["id"]: "   ", state["selected_questions"][1]["id"]: "Queue"}
    main.run("UPDATE attempts SET state=? WHERE id=?", (json.dumps(dict(state, answers=answers)), aid))
    assert main.view(row(aid))["answered"] == 1
    att = row(aid)
    main.finalize(att, json.loads(att["state"]))
    assert json.loads(row(aid)["result"])["answered_questions"] == 1


# ------------------------------------------------------------------ 7. honesty rejected
def _done_with_reviews(uid, academic="approved", honesty="rejected"):
    aid, _ = graphrag_attempt(uid, answers={})
    att = row(aid)
    main.finalize(att, json.loads(att["state"]))
    main.run("INSERT INTO admin_attempt_reviews(attempt_id,decision,reason,reviewer_id,reviewed_at) VALUES (?,?,?,?,?)",
             (aid, academic, "Reviewed by a human.", uid, time.time() - 10))
    if honesty:
        main.run("INSERT INTO attempt_honesty_reviews(attempt_id,auto_score,score,status,reason,reviewer_id,reviewed_at,updated_at) "
                 "VALUES (?,?,?,?,?,?,?,?)", (aid, 40, 40, honesty, "Timeline reviewed by a human.", uid, time.time(), time.time()))
    return aid


def test_honesty_rejection_is_terminal_visible_and_appealable():
    uid, headers, _ = account()
    aid = _done_with_reviews(uid)
    state = workflow.review_state(aid)
    assert state["stage"] == "honesty_rejected" and state["terminal"] and state["appealable"]
    item = next(a for a in client.get("/api/state", headers=headers).json()["attempts"] if a["id"] == aid)
    assert item["publication_stage"] == "honesty_rejected" and item["terminal"] is True
    assert item["appealable"] is True and item["honesty_status"] == "rejected"
    assert item["honesty_reason"] == "Timeline reviewed by a human."
    assert item["publication"]["stage"] == "honesty_rejected"          # existing field still present
    appeal = client.post(f"/api/attempts/{aid}/appeal", json={"note": "Please re-check my timeline."}, headers=headers)
    assert appeal.status_code == 200, appeal.text
    item = next(a for a in client.get("/api/state", headers=headers).json()["attempts"] if a["id"] == aid)
    assert item["appealable"] is False


def test_honesty_rejection_does_not_block_a_retake_forever(candidate):
    uid, headers = candidate
    _done_with_reviews(uid)
    response = client.post("/api/attempts", json={"blueprint_id": blueprint(headers)["blueprint_id"], **PROCTORED},
                           headers=headers)
    assert response.json().get("detail") != "result_awaiting_honesty_review"


# ------------------------------------------------------------------ 8. needs-more-info reply
def test_candidate_can_reply_once_per_needs_more_info_request():
    uid, headers, _ = account()
    aid = _done_with_reviews(uid, academic="needs_more_info", honesty=None)
    other_uid, other_headers, _ = account()
    assert client.post(f"/api/attempts/{aid}/review-response", json={"note": "Not mine"},
                       headers=other_headers).status_code == 404
    assert client.post(f"/api/attempts/{aid}/review-response", json={"no": "x"}, headers=headers).status_code == 422
    first = client.post(f"/api/attempts/{aid}/review-response",
                        json={"note": "I used the standard library only; see my SQL answer."}, headers=headers)
    assert first.status_code == 200, first.text
    second = client.post(f"/api/attempts/{aid}/review-response", json={"note": "Again"}, headers=headers)
    assert second.status_code == 409 and second.json()["detail"] == "review_response_already_submitted"
    item = next(a for a in client.get("/api/state", headers=headers).json()["attempts"] if a["id"] == aid)
    assert item["review_response"]["note"].startswith("I used the standard library")
    assert item["review_response_allowed"] is False
    assert main.attempt_review_response(aid)["note"] == item["review_response"]["note"]
    # The reviewer asks again: one more reply is allowed.
    main.run("UPDATE admin_attempt_reviews SET reviewed_at=? WHERE attempt_id=?", (time.time() + 5, aid))
    item = next(a for a in client.get("/api/state", headers=headers).json()["attempts"] if a["id"] == aid)
    assert item["review_response_allowed"] is True
    # Exported with the account and erased with it.
    export = client.get("/api/me/export", headers=headers).json()
    assert export["attempt_review_responses"]
    assert client.delete("/api/me", headers=headers).status_code == 200
    assert main.one("SELECT COUNT(*) AS n FROM attempt_review_responses WHERE attempt_id=?", (aid,))["n"] == 0


def test_reply_requires_a_needs_more_info_decision():
    uid, headers, _ = account()
    aid = _done_with_reviews(uid, academic="approved", honesty=None)
    response = client.post(f"/api/attempts/{aid}/review-response", json={"note": "Hello there"}, headers=headers)
    assert response.status_code == 409 and response.json()["detail"] == "review_response_not_requested"
