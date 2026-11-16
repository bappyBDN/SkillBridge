"""Team invitations must lead to usable, tenant-scoped workspace access."""
import os
import sys
import tempfile
import uuid

_TMP = tempfile.mkdtemp(prefix="sb_team_")
os.environ.setdefault("DB_PATH", os.path.join(_TMP, "test.db"))
os.environ.setdefault("PBKDF2_ITERATIONS", "1000")
os.environ["SEED_DEMO"] = "false"
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from fastapi.testclient import TestClient
import main

client = TestClient(main.app)


def account(role="company"):
    email = f"team-{uuid.uuid4().hex}@example.com"
    response = client.post("/api/auth/register", json={
        "email": email, "name": "Test Teammate", "password": "Str0ng-Passw0rd-2026", "role": role,
    })
    assert response.status_code == 200, response.text
    return email, {"Authorization": "Bearer " + response.json()["token"]}


def owner():
    email, headers = account()
    response = client.post("/api/company/profile", json={"name": "Test Organisation"}, headers=headers)
    assert response.status_code == 200, response.text
    return email, headers


def invite(headers, email, role="recruiter"):
    response = client.post("/api/company/team/invitations", json={"email": email, "role": role}, headers=headers)
    assert response.status_code == 200, response.text
    return response.json()


def accept(headers, invitation):
    return client.post("/api/company/team/accept/" + invitation["invite_token"], headers=headers)


def test_invitation_discovery_acceptance_and_role_changes():
    _, owner_headers = owner()
    email, teammate = account()
    invitation = invite(owner_headers, "  " + email.upper() + "  ", "hiring_manager")
    pending = client.get("/api/company/invitations", headers=teammate)
    assert pending.status_code == 200
    assert pending.json()["items"][0]["id"] == invitation["id"]
    assert accept(teammate, invitation).status_code == 200
    workspace = client.get("/api/company/workspace", headers=teammate).json()
    assert workspace["company"]["role"] == "hiring_manager"
    assert workspace["permissions"]["manage_pipeline"] is True
    assert workspace["permissions"]["manage_team"] is False
    assert client.get("/api/company/team", headers=teammate).status_code == 403
    assert accept(teammate, invitation).status_code == 404
    assert client.get("/api/company/invitations", headers=teammate).json()["items"] == []
    changed = client.patch("/api/company/team/" + invitation["id"], json={"role": "viewer"}, headers=owner_headers)
    assert changed.status_code == 200
    workspace = client.get("/api/company/workspace", headers=teammate).json()
    assert workspace["permissions"]["manage_pipeline"] is False
    assert workspace["permissions"]["view_reports"] is True


def test_reissued_invites_rotate_tokens_and_revoked_members_need_consent_again():
    _, owner_headers = owner()
    email, teammate = account()
    first = invite(owner_headers, email)
    second = invite(owner_headers, email, "viewer")
    assert first["id"] == second["id"]
    assert first["invite_token"] != second["invite_token"]
    assert accept(teammate, first).status_code == 404
    assert accept(teammate, second).status_code == 200
    duplicate = client.post("/api/company/team/invitations", json={"email": email, "role": "recruiter"}, headers=owner_headers)
    assert duplicate.status_code == 409
    revoked = client.patch("/api/company/team/" + second["id"], json={"role": "revoked"}, headers=owner_headers)
    assert revoked.status_code == 200
    assert client.get("/api/company/workspace", headers=teammate).status_code == 409
    restored = client.patch("/api/company/team/" + second["id"], json={"role": "recruiter"}, headers=owner_headers)
    assert restored.status_code == 409
    third = invite(owner_headers, email)
    assert third["id"] == first["id"]
    assert accept(teammate, third).status_code == 200


def test_invites_and_members_cannot_be_accessed_from_other_tenants():
    _, first_owner = owner()
    _, other_owner = owner()
    email, teammate = account()
    _, stranger = account()
    invitation = invite(first_owner, email)
    assert client.get("/api/company/invitations", headers=stranger).json()["items"] == []
    assert accept(stranger, invitation).status_code == 404
    assert client.patch("/api/company/team/" + invitation["id"], json={"role": "revoked"}, headers=other_owner).status_code == 404
    assert accept(teammate, invitation).status_code == 200
    assert client.post("/api/company/team/invitations", json={"email": "someone@example.com", "role": "recruiter"}, headers=teammate).status_code == 403


def test_revoke_pending_invitation_invalidates_its_token():
    _, owner_headers = owner()
    email, teammate = account()
    invitation = invite(owner_headers, email)
    assert client.patch("/api/company/team/" + invitation["id"], json={"role": "revoked"}, headers=owner_headers).status_code == 200
    assert accept(teammate, invitation).status_code == 404


def test_single_workspace_restriction_does_not_silently_hide_memberships():
    _, first_owner = owner()
    second_email, second_owner = owner()
    assert accept(second_owner, invite(first_owner, second_email)).status_code == 409
    email, teammate = account()
    assert accept(teammate, invite(first_owner, email)).status_code == 200
    assert accept(teammate, invite(second_owner, email)).status_code == 409


def test_invitation_email_role_and_account_validation():
    email, headers = owner()
    for address, role, expected in [("broken-address", "recruiter", 422), (email, "recruiter", 409), ("valid@example.com", "owner", 422)]:
        response = client.post("/api/company/team/invitations", json={"email": address, "role": role}, headers=headers)
        assert response.status_code == expected, response.text
    _, candidate = account("candidate")
    assert client.get("/api/company/invitations", headers=candidate).status_code == 403


def test_unverified_email_cannot_discover_or_accept_team_invitations():
    _, headers = owner()
    email, teammate = account()
    invitation = invite(headers, email)
    main.run("UPDATE users SET email_verified=0 WHERE email=?", (email,))
    assert client.get("/api/company/invitations", headers=teammate).status_code == 403
    assert accept(teammate, invitation).status_code == 403
    row = main.one("SELECT status FROM company_members WHERE id=?", (invitation["id"],))
    assert row["status"] == "invited"
