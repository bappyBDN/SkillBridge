"""Reviewer follow-ups: candidate replies, expired attempts, honesty-rejected appeals, practice seed."""
import json
import time
import uuid

from test_ent_helpers import attempt, client, headers, main, user

import enterprise
import mcp_tools as T


def test_review_response_is_shown_in_detail_and_queue():
    admin = headers(user("admin", "super_admin"))
    candidate = user()
    att = attempt(candidate, {"overall": 70, "trust": "High"}, state={"answers": []})
    main.run("INSERT INTO attempt_review_responses(id,attempt_id,user_id,note,created) VALUES (?,?,?,?,?)",
             (uuid.uuid4().hex, att, candidate, "I used the allowed calculator.", time.time()))
    detail = client.get(f"/api/admin/integrity/attempts/{att}", headers=admin).json()
    assert detail["review_response"]["note"] == "I used the allowed calculator."
    queue = client.get("/api/admin/assessment-reviews?limit=500", headers=admin).json()["items"]
    item = next(i for i in queue if i["id"] == att)
    assert item["review_response"]["note"] == "I used the allowed calculator."
    other = attempt(candidate, {"overall": 60}, state={"answers": []})
    assert client.get(f"/api/admin/integrity/attempts/{other}", headers=admin).json()["review_response"] is None


def test_admin_queues_finalize_expired_attempts_first(monkeypatch):
    admin = headers(user("admin", "super_admin"))
    calls = []
    monkeypatch.setattr(main, "finalize_expired_attempts", lambda *a, **k: calls.append(1) or 0)
    assert client.get("/api/admin/integrity/attempts", headers=admin).status_code == 200
    assert client.get("/api/admin/assessment-reviews", headers=admin).status_code == 200
    assert len(calls) == 2


def test_overturning_an_honesty_rejected_appeal_resets_the_honesty_review():
    reviewer_id = user("admin", "trust_safety_reviewer")
    appeal_admin = headers(user("admin", "super_admin"))
    candidate = user()
    att = attempt(candidate, {"overall": 80, "level": "Advanced", "trust": "Needs review",
                              "topics": {"sql": {"score": 80, "level": "Advanced"}}})
    now = time.time()
    main.run("INSERT INTO admin_attempt_reviews(attempt_id,decision,reason,reviewer_id,reviewed_at) VALUES (?,?,?,?,?)",
             (att, "approved", "Marks checked", reviewer_id, now))
    main.run("INSERT INTO attempt_honesty_reviews(attempt_id,auto_score,score,status,reason,reviewer_id,reviewed_at,updated_at) "
             "VALUES (?,?,?,?,?,?,?,?)", (att, 40, 40, "rejected", "Second person visible", reviewer_id, now, now))
    main.run("UPDATE attempts SET appeal=? WHERE id=?", ("My sibling walked in briefly.", att))
    import assessment_workflow as workflow
    assert workflow.review_state(att)["stage"] == "honesty_rejected"

    listed = client.get("/api/admin/appeals", headers=appeal_admin).json()["items"]
    entry = next(i for i in listed if i["attempt_id"] == att)
    assert entry["can_decide"] is True and entry["appealed_outcome"] == "honesty_rejected"
    # the honesty reviewer cannot decide the appeal against their own review
    own = client.post(f"/api/admin/appeals/{att}/decision", headers=headers(reviewer_id),
                      json={"decision": "overturned", "reason": "x" * 5})
    assert own.status_code == 409

    decided = client.post(f"/api/admin/appeals/{att}/decision", headers=appeal_admin,
                          json={"decision": "overturned", "reason": "Brief, explained interruption"})
    assert decided.status_code == 200, decided.text
    honesty = main.one("SELECT status,reason FROM attempt_honesty_reviews WHERE attempt_id=?", (att,))
    assert honesty["status"] == "approved" and honesty["reason"].startswith("Appeal overturned")
    academic = main.one("SELECT decision FROM admin_attempt_reviews WHERE attempt_id=?", (att,))
    assert academic["decision"] == "approved"
    assert workflow.review_state(att)["stage"] != "honesty_rejected"


def test_fresh_install_has_a_practice_only_pool():
    rows = main.allr("SELECT status FROM question_bank WHERE id LIKE 'practice-%'")
    assert rows and {r["status"] for r in rows} == {"practice"}
    assert len(rows) == len(enterprise.PRACTICE_SEED)
    served = T.practice_questions(1, "SQL", 5)
    assert served["pool"] == "practice" and served["count"] >= 1
    active_ids = {r["id"] for r in main.allr("SELECT id FROM question_bank WHERE status='active'")}
    assert active_ids.isdisjoint({q["id"] for q in served["questions"]})
