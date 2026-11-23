"""Hiring pipeline, phase-two invitations, recruiter score privacy and notifications."""
import time
import uuid

from test_ent_helpers import (application, attempt, client, company, headers, job, kinds, main,
                              member, notifications, user)

PHASE_TWO = {
    "title": "Take-home SQL exercise", "requirements": "Solve three SQL problems in an hour.",
    "syllabus": ["joins", "aggregation"], "deadline": "2026-12-31",
}


def _setup(status="submitted", shared=True):
    owner = user("company")
    cid = company(owner)
    recruiter = member(cid, "recruiter")
    viewer = member(cid, "viewer")
    candidate = user()
    jid = job(cid)
    aid = application(jid, candidate, status=status, shared=shared)
    return owner, cid, recruiter, viewer, candidate, jid, aid


def test_company_applications_hide_unpublished_scores_and_never_send_trust():
    owner, *_rest, candidate, _jid, aid = _setup()
    attempt(candidate)  # completed but never human-reviewed / published
    items = client.get("/api/company/applications", headers=headers(owner)).json()["items"]
    item = next(i for i in items if i["application_id"] == aid)
    summary = item["latest_assessment"]
    assert summary["overall"] is None and summary["level"] is None
    assert summary["result_status"] == "awaiting_reviews"
    assert "trust" not in summary and summary["topics"] == {}


def test_new_application_notifies_company_pipeline_roles_only():
    owner = user("company")
    cid = company(owner)
    recruiter = member(cid, "recruiter")
    viewer = member(cid, "viewer")
    jid = job(cid)
    candidate = user()
    response = client.post(f"/api/jobs/{jid}/apply", headers=headers(candidate))
    assert response.status_code == 200, response.text
    assert "application_received" in kinds(owner)
    assert "application_received" in kinds(recruiter)
    assert "application_received" not in kinds(viewer)


def test_stage_changes_notify_candidate_and_early_rejection_needs_reason():
    owner, _cid, _r, _v, candidate, _jid, aid = _setup()
    h = headers(owner)
    no_reason = client.patch(f"/api/company/applications/{aid}/stage", headers=h, json={"stage": "rejected"})
    assert no_reason.status_code == 422
    rejected = client.patch(f"/api/company/applications/{aid}/stage", headers=h,
                            json={"stage": "rejected", "reason": "Role requires 3 years of SQL"})
    assert rejected.status_code == 200, rejected.text
    items = [n for n in notifications(candidate) if n["kind"] == "application_stage"]
    assert items and items[0]["link"] == "applications"
    assert "3 years" not in items[0]["body"]  # recruiter reason stays internal
    history = main.allr("SELECT to_stage FROM application_history WHERE application_id=?", (aid,))
    assert [h["to_stage"] for h in history] == ["rejected"]


def test_offer_declined_can_be_closed():
    owner, *_rest, aid = _setup(status="offer_declined")
    closed = client.patch(f"/api/company/applications/{aid}/stage", headers=headers(owner),
                          json={"stage": "closed", "reason": "Candidate declined the offer"})
    assert closed.status_code == 200, closed.text


def test_candidate_can_withdraw_own_application_once():
    owner, _cid, recruiter, _v, candidate, _jid, aid = _setup(status="in_review")
    other = user()
    assert client.post(f"/api/applications/{aid}/withdraw", headers=headers(other)).status_code == 404
    response = client.post(f"/api/applications/{aid}/withdraw", headers=headers(candidate),
                           json={"reason": "Accepted another role"})
    assert response.status_code == 200, response.text
    assert response.json() == {"application_id": aid, "from": "in_review", "status": "withdrawn"}
    assert main.one("SELECT status FROM applications WHERE id=?", (aid,))["status"] == "withdrawn"
    assert "application_withdrawn" in kinds(owner) and "application_withdrawn" in kinds(recruiter)
    assert client.post(f"/api/applications/{aid}/withdraw", headers=headers(candidate)).status_code == 409


def test_legacy_publish_goes_to_review(monkeypatch):
    owner = user("company")
    company(owner)
    body = {"title": "Analyst", "description": "Analyse dashboards and data for the team.", "publish": True}
    monkeypatch.delenv("ALLOW_DIRECT_JOB_PUBLISH", raising=False)
    response = client.post("/api/jobs", headers=headers(owner), json=body)
    assert response.status_code == 200, response.text
    assert response.json()["status"] == "pending_review"
    monkeypatch.setenv("ALLOW_DIRECT_JOB_PUBLISH", "true")
    assert client.post("/api/jobs", headers=headers(owner), json=body).json()["status"] == "published"


def test_phase_two_full_loop_with_needs_changes_and_candidate_response():
    owner, cid, recruiter, _v, candidate, _jid, aid = _setup(status="in_review")
    admin = headers(user("admin", "super_admin"))
    created = client.post(f"/api/company/applications/{aid}/phase-two-invitations",
                          headers=headers(recruiter), json=PHASE_TWO)
    assert created.status_code == 200, created.text
    invite_id = created.json()["id"]
    assert "notification integration" not in created.json()["message"]
    # nothing visible to the candidate before platform approval
    assert client.get("/api/candidate/phase-two-invites", headers=headers(candidate)).json()["items"] == []

    sent_back = client.post(f"/api/admin/phase-two-requests/{invite_id}/decision", headers=admin,
                            json={"decision": "needs_changes", "reason": "Add a rubric for each problem"})
    assert sent_back.status_code == 200, sent_back.text
    assert "phase_two_needs_changes" in kinds(owner)
    edited = client.put(f"/api/company/phase-two/{invite_id}", headers=headers(recruiter),
                        json={**PHASE_TWO, "rubric": [{"criterion": "correctness", "weight": 100}]})
    assert edited.status_code == 200, edited.text
    assert edited.json()["version"] == 2 and edited.json()["status"] == "pending_platform_review"

    approved = client.post(f"/api/admin/phase-two-requests/{invite_id}/decision", headers=admin,
                           json={"decision": "approved", "reason": "Looks fair"})
    assert approved.status_code == 200, approved.text
    again = client.post(f"/api/admin/phase-two-requests/{invite_id}/decision", headers=admin,
                        json={"decision": "rejected", "reason": "Too late"})
    assert again.status_code == 409
    assert "phase_two_invite" in kinds(candidate)
    assert "phase_two_approved" in kinds(recruiter)

    listed = client.get("/api/candidate/phase-two-invites", headers=headers(candidate)).json()["items"]
    assert len(listed) == 1
    item = listed[0]
    assert set(item) == {"id", "application_id", "job_title", "company_name", "title", "requirements",
                         "deadline", "status"}
    assert item["status"] == "approved"
    other = user()
    assert client.post(f"/api/candidate/phase-two-invites/{invite_id}/respond", headers=headers(other),
                       json={"decision": "accept"}).status_code == 404
    assert client.post(f"/api/candidate/phase-two-invites/{invite_id}/respond", headers=headers(candidate),
                       json={"decision": "maybe"}).status_code == 422
    accepted = client.post(f"/api/candidate/phase-two-invites/{invite_id}/respond", headers=headers(candidate),
                           json={"decision": "accept"})
    assert accepted.json() == {"ok": True, "status": "accepted"}
    assert "phase_two_response" in kinds(owner)
    assert client.post(f"/api/candidate/phase-two-invites/{invite_id}/respond", headers=headers(candidate),
                       json={"decision": "decline"}).status_code == 409
    # approved setups can no longer be edited
    assert client.put(f"/api/company/phase-two/{invite_id}", headers=headers(recruiter),
                      json=PHASE_TWO).status_code == 409


def test_company_verification_job_moderation_refund_and_team_notifications():
    admin_id = user("admin", "super_admin")
    admin = headers(admin_id)
    owner = user("company")
    cid = company(owner, verified=False)
    main.run("INSERT INTO company_verification(company_id,legal_name,country,business_id,evidence_note,status,"
             "decision_reason,submitted_at) VALUES (?,?,?,?,?,?,?,?)",
             (cid, "Ent Co Ltd", "BD", "", "Registered business evidence", "pending_review", "", time.time()))
    decided = client.post(f"/api/admin/companies/{cid}/verification-decision", headers=admin,
                          json={"decision": "verified", "reason": "Documents checked"})
    assert decided.status_code == 200, decided.text
    assert "company_verification" in kinds(owner)

    jid = job(cid, status="pending_review")
    moderated = client.post(f"/api/admin/jobs/{jid}/moderation-decision", headers=admin,
                            json={"decision": "needs_changes", "reason": "Add a salary range"})
    assert moderated.status_code == 200, moderated.text
    assert "job_moderation" in kinds(owner)

    payer = user()
    invoice = uuid.uuid4().hex
    main.run("INSERT INTO billing_invoices(id,user_id,plan_id,amount_minor,currency,status,issued_at) VALUES (?,?,?,?,?,?,?)",
             (invoice, payer, "plan", 1000, "BDT", "paid", time.time()))
    refund = client.post("/api/billing/refunds", headers=headers(payer),
                         json={"invoice_id": invoice, "reason": "Charged twice"}).json()
    assert client.post(f"/api/admin/billing/refunds/{refund['id']}/decision", headers=admin,
                       json={"decision": "reject", "reason": "Single charge only"}).status_code == 200
    assert "refund_decision" in kinds(payer)

    joiner = user("company")
    email = main.one("SELECT email FROM users WHERE id=?", (joiner,))["email"]
    invite = client.post("/api/company/team/invitations", headers=headers(owner),
                         json={"email": email, "role": "recruiter"})
    assert invite.status_code == 200, invite.text
    accepted = client.post(f"/api/company/team/accept/{invite.json()['invite_token']}", headers=headers(joiner))
    assert accepted.status_code == 200, accepted.text
    assert "team_invite_accepted" in kinds(owner)
