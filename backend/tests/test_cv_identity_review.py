"""CV identity review: queueing, candidate confirmation and admin decisions."""
import os
import sys
import tempfile
import uuid

from fastapi.testclient import TestClient

_TMP = tempfile.mkdtemp(prefix="sb_cv_identity_")
os.environ.setdefault("DB_PATH", os.path.join(_TMP, "test.db"))
os.environ.setdefault("PBKDF2_ITERATIONS", "1000")
os.environ["SEED_DEMO"] = "false"
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import main

client = TestClient(main.app)


def account(admin=False):
    email = uuid.uuid4().hex + "@example.com"
    response = client.post("/api/auth/register", json={
        "email": email, "name": "Identity Candidate" if not admin else "Identity Admin",
        "password": "Str0ng-Passw0rd-2026"})
    assert response.status_code == 200, response.text
    headers = {"Authorization": "Bearer " + response.json()["token"]}
    uid = main.one("SELECT id FROM users WHERE email=?", (email,))["id"]
    if admin:
        # Production provisioning always assigns an explicit staff role (staff
        # console / create_admin.py); a role-only admin has no admin scope.
        main.run("UPDATE user_roles SET role='admin' WHERE user_id=?", (uid,))
        main.run("INSERT INTO admin_staff_roles(user_id,admin_role,updated_by,updated_at) VALUES (?,?,?,?)",
                 (uid, "trust_safety_reviewer", uid, 0))
    else:
        assert client.post("/api/consent", json={"lang": "en"}, headers=headers).status_code == 200
    return uid, headers


def upload(headers, text):
    response = client.post("/api/cv", data={"text": text}, headers=headers)
    assert response.status_code == 200, response.text
    return response.json()


def reviews(admin):
    response = client.get("/api/admin/identity-reviews", headers=admin)
    assert response.status_code == 200, response.text
    return response.json()["items"]


def review_for(admin, uid):
    return next(item for item in reviews(admin) if item["user_id"] == uid)


def test_mismatched_cv_is_queued_and_candidate_must_confirm_ownership():
    uid, headers = account()
    _, admin = account(True)
    uploaded = upload(headers, "Karim Chowdhury\nkarim@example.org\nSkills: Java, SQL")
    assert uploaded["identity"]["status"] == "no_match"
    assert uploaded["identity"]["email_match"] is False

    row = review_for(admin, uid)
    assert row["status"] == "open"
    assert row["signal"]["status"] == "no_match"
    assert row["signal"]["cv_name"] == "Karim Chowdhury"
    assert row["signal"]["confirmed"] is False
    assert row["account_name"] == "Identity Candidate"

    blocked = client.put("/api/skills", json={"skills": ["sql"]}, headers=headers)
    assert blocked.status_code == 409
    assert "Confirm" in blocked.json()["detail"] or "confirm" in blocked.json()["detail"]

    allowed = client.put("/api/skills", json={"skills": ["sql"], "cv_identity_confirmed": True}, headers=headers)
    assert allowed.status_code == 200, allowed.text
    row = review_for(admin, uid)
    assert row["status"] == "open"
    assert row["signal"]["confirmed"] is True


def test_a_later_matching_cv_supersedes_the_open_review():
    uid, headers = account()
    _, admin = account(True)
    upload(headers, "Someone Else\nelse@example.org\nSkills: Java")
    assert review_for(admin, uid)["status"] == "open"

    matched = upload(headers, "Identity Candidate\nSkills: SQL, Python")
    assert matched["identity"]["status"] == "match"
    row = review_for(admin, uid)
    assert row["status"] == "superseded"
    assert "matched" in row["note"].lower()
    assert review_for(admin, uid)["status"] != "open"


def test_unknown_identity_cv_is_queued_for_advisory_review_without_blocking():
    uid, headers = account()
    _, admin = account(True)
    uploaded = upload(headers, "Skills: SQL, Python\nExperience: class project")
    assert uploaded["identity"]["status"] == "unknown"
    row = review_for(admin, uid)
    assert row["status"] == "open"
    assert row["signal"]["status"] == "unknown"
    assert row["signal"]["confirmed"] is False

    # A missing name is ambiguous, not a mismatch: queue it for a human but do
    # not block the candidate's own skill confirmation.
    assert client.put("/api/skills", json={"skills": ["sql"]}, headers=headers).status_code == 200
    assert review_for(admin, uid)["signal"]["confirmed"] is False


def test_admin_decision_is_recorded_with_reviewer_and_note():
    uid, headers = account()
    _, admin = account(True)
    upload(headers, "Someone Else\nelse@example.org\nSkills: Java")
    row = review_for(admin, uid)

    needs = client.post(f"/api/admin/identity-reviews/{row['id']}/decision",
                        headers=admin, json={"decision": "needs_review",
                                             "note": "Please check the previous CV revision."})
    assert needs.status_code == 200, needs.text
    assert review_for(admin, uid)["status"] == "needs_review"

    decided = client.post(f"/api/admin/identity-reviews/{row['id']}/decision",
                          headers=admin, json={"decision": "cleared",
                                               "note": "Candidate supplied a matching account email."})
    assert decided.status_code == 200, decided.text
    updated = review_for(admin, uid)
    assert updated["status"] == "cleared"
    assert updated["note"] == "Candidate supplied a matching account email."
    assert updated["reviewed_by_name"] == "Identity Admin"
    assert updated["reviewed_at"]

    # A cleared review is closed: it cannot be re-decided.
    reopened = client.post(f"/api/admin/identity-reviews/{row['id']}/decision",
                           headers=admin, json={"decision": "needs_review", "note": "late"})
    assert reopened.status_code == 409

    assert client.post(f"/api/admin/identity-reviews/{row['id']}/decision",
                       headers=admin, json={"decision": "not-a-decision", "note": "x"}).status_code == 422
    assert client.get("/api/admin/identity-reviews", headers=headers).status_code == 403
