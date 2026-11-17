"""Candidate state exposes only that candidate's own attempt events.

The notification panel filters these rows; this contract test makes sure the
server never mixes candidates and never publishes an unfinished attempt.
"""
import json
import os
import sys
import tempfile
import time
import uuid

from fastapi.testclient import TestClient

_TMP = tempfile.mkdtemp(prefix="sb_notifications_")
os.environ.setdefault("DB_PATH", os.path.join(_TMP, "test.db"))
os.environ.setdefault("PBKDF2_ITERATIONS", "1000")
os.environ["SEED_DEMO"] = "false"
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import main

client = TestClient(main.app)


def account(name="Notification Candidate"):
    email = uuid.uuid4().hex + "@example.com"
    response = client.post("/api/auth/register", json={
        "email": email, "name": name, "password": "Str0ng-Passw0rd-2026"})
    assert response.status_code == 200, response.text
    headers = {"Authorization": "Bearer " + response.json()["token"]}
    uid = main.one("SELECT id FROM users WHERE email=?", (email,))["id"]
    assert client.post("/api/consent", json={"lang": "en"}, headers=headers).status_code == 200
    return uid, headers


def scored_result(overall):
    return {"overall": overall, "topics": {"sql": {"score": overall, "level": "Intermediate"}},
            "question_results": [], "section_scores": {"sql": {"score": overall}}}


def attempt_row(uid, status, *, overall=None):
    aid = uuid.uuid4().hex
    result = json.dumps(scored_result(overall)) if overall is not None else (json.dumps({}) if status == "done" else None)
    main.run("""INSERT INTO attempts(id,user_id,kind,seed,status,state,started,finished,result,appeal)
                VALUES (?,?,?,?,?,?,?,?,?,NULL)""",
             (aid, uid, "pre", 1, status, json.dumps({}), 1, 2 if status == "done" else None, result))
    return aid


def test_state_keeps_attempt_events_scoped_to_the_candidate():
    uid, headers = account()
    other_uid, other_headers = account("Other Candidate")

    active = attempt_row(uid, "active")
    waiting = attempt_row(uid, "done", overall=70)
    rejected = attempt_row(uid, "done", overall=60)
    published = attempt_row(uid, "done", overall=80)
    other_candidate_attempt = attempt_row(other_uid, "active")

    now = time.time()
    main.run("""INSERT INTO admin_attempt_reviews(attempt_id,decision,reason,reviewer_id,reviewed_at)
                VALUES (?,?,?,?,?)""", (rejected, "invalidated", "Answer matched a published source.", uid, now))
    main.run("""INSERT INTO admin_attempt_reviews(attempt_id,decision,reason,reviewer_id,reviewed_at)
                VALUES (?,?,?,?,?)""", (published, "approved", "Reviewed against the stored rubric.", uid, now))
    main.run("""INSERT INTO attempt_honesty_reviews(attempt_id,auto_score,score,status,reason,reviewer_id,reviewed_at,updated_at)
                VALUES (?,?,?,?,?,?,?,?)""", (published, 90, 88, "approved", "Reviewed by a human.", uid, now, now))

    state = client.get("/api/state", headers=headers).json()
    by_id = {item["id"]: item for item in state["attempts"]}

    assert set(by_id) == {active, waiting, rejected, published}
    assert other_candidate_attempt not in by_id
    other_state = client.get("/api/state", headers=other_headers).json()
    assert {item["id"] for item in other_state["attempts"]} == {other_candidate_attempt}

    assert by_id[active]["status"] == "active"
    assert by_id[active]["publication"]["stage"] == "in_progress"
    assert by_id[active]["finalized"] is False
    assert by_id[active]["review_decision"] is None
    assert by_id[active]["overall"] is None

    assert by_id[waiting]["publication"]["stage"] == "academic_review"
    assert by_id[waiting]["finalized"] is False
    assert by_id[waiting]["review_decision"] is None
    assert by_id[waiting]["overall"] is None

    assert by_id[rejected]["publication"]["stage"] == "invalidated"
    assert by_id[rejected]["finalized"] is False
    assert by_id[rejected]["review_decision"] == "invalidated"
    assert by_id[rejected]["review_reason"] == "Answer matched a published source."
    assert by_id[rejected]["overall"] is None

    assert by_id[published]["publication"]["stage"] == "published"
    assert by_id[published]["finalized"] is True
    assert by_id[published]["review_decision"] == "approved"
    assert by_id[published]["overall"] == 80
    assert by_id[published]["honesty"]["status"] == "approved"
