"""Super-admin management of provisioned admin accounts."""
import os
import sys
import tempfile
import uuid

from fastapi.testclient import TestClient

_TMP = tempfile.mkdtemp(prefix="sb_admin_staff_")
os.environ.setdefault("DB_PATH", os.path.join(_TMP, "test.db"))
os.environ.setdefault("PBKDF2_ITERATIONS", "1000")
os.environ["SEED_DEMO"] = "false"
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import main
import enterprise

client = TestClient(main.app)
PASSWORD = "Str0ng-Admin-Passw0rd-2026"


def super_admin():
    email = uuid.uuid4().hex + "@example.com"
    response = client.post("/api/auth/register", json={
        "email": email, "name": "Super Admin", "password": "Str0ng-Passw0rd-2026"})
    assert response.status_code == 200, response.text
    token = response.json().get("token") or client.post(
        "/api/auth/login", json={"email": email, "password": "Str0ng-Passw0rd-2026"}).json()["token"]
    uid = main.one("SELECT id FROM users WHERE email=?", (email,))["id"]
    main.run("UPDATE user_roles SET role='admin' WHERE user_id=?", (uid,))
    main.run("INSERT INTO admin_staff_roles(user_id,admin_role,updated_by,updated_at) VALUES (?,?,?,?)",
             (uid, "super_admin", uid, 0))
    headers = {"Authorization": "Bearer " + token}
    assert client.get("/api/admin/console/me", headers=headers).status_code == 200
    return uid, headers


def create_staff(headers, role="support_agent"):
    email = uuid.uuid4().hex + "@example.com"
    response = client.post("/api/admin/console/staff", headers=headers, json={
        "name": "Provisioned Admin", "email": email, "password": PASSWORD, "admin_role": role})
    assert response.status_code == 200, response.text
    return {**response.json(), "email": email}


def login(email, password=PASSWORD):
    response = client.post("/api/auth/login", json={"email": email, "password": password})
    assert response.status_code == 200, response.text
    return {"Authorization": "Bearer " + response.json()["token"]}


def staff_ids(headers):
    items = client.get("/api/admin/console/staff", headers=headers).json()["items"]
    return {item["id"] for item in items}


def test_super_admin_can_revoke_admin_access_and_delete_the_account():
    _, admin = super_admin()
    revoked = create_staff(admin, "trust_safety_reviewer")
    old_session = login(revoked["email"])
    assert client.get("/api/admin/console/me", headers=old_session).status_code == 200

    response = client.post(f"/api/admin/console/staff/{revoked['user_id']}/revoke", headers=admin)
    assert response.status_code == 200, response.text
    assert response.json()["revoked"] is True
    assert revoked["user_id"] not in staff_ids(admin)
    assert client.get("/api/admin/console/me", headers=old_session).status_code == 401

    # The person still has an account but no admin access.
    new_session = login(revoked["email"])
    assert client.get("/api/admin/console/me", headers=new_session).status_code == 403
    assert main.one("SELECT id FROM users WHERE id=?", (revoked["user_id"],)) is not None
    assert main.one("SELECT COUNT(*) AS n FROM audit WHERE action='admin_staff_revoked' AND target LIKE ?",
                    (str(revoked["user_id"]) + ":%",))["n"] == 1

    deleted = create_staff(admin, "support_agent")
    deleted_session = login(deleted["email"])
    response = client.delete(f"/api/admin/console/staff/{deleted['user_id']}", headers=admin)
    assert response.status_code == 200, response.text
    assert response.json()["deleted"] is True
    assert deleted["user_id"] not in staff_ids(admin)
    assert main.one("SELECT id FROM users WHERE id=?", (deleted["user_id"],)) is None
    assert client.get("/api/admin/console/me", headers=deleted_session).status_code == 401
    assert client.post("/api/auth/login", json={
        "email": deleted["email"], "password": PASSWORD}).status_code == 401
    assert main.one("SELECT COUNT(*) AS n FROM audit WHERE action='admin_staff_deleted' AND target LIKE ?",
                    (str(deleted["user_id"]) + ":%",))["n"] == 1


def test_super_admin_cannot_revoke_or_delete_their_own_account():
    uid, admin = super_admin()
    assert client.post(f"/api/admin/console/staff/{uid}/revoke", headers=admin).status_code == 409
    assert client.delete(f"/api/admin/console/staff/{uid}", headers=admin).status_code == 409
    assert main.one("SELECT id FROM users WHERE id=?", (uid,)) is not None


def test_only_super_admin_scope_can_revoke_or_delete_admins():
    _, admin = super_admin()
    reviewer = create_staff(admin, "trust_safety_reviewer")
    reviewer_headers = login(reviewer["email"])
    target = create_staff(admin, "support_agent")

    assert client.post(f"/api/admin/console/staff/{target['user_id']}/revoke",
                       headers=reviewer_headers).status_code == 403
    assert client.delete(f"/api/admin/console/staff/{target['user_id']}",
                         headers=reviewer_headers).status_code == 403
    assert main.one("SELECT id FROM users WHERE id=?", (target["user_id"],)) is not None


def test_last_active_super_admin_cannot_be_revoked_or_deleted(monkeypatch):
    _, admin = super_admin()
    target = create_staff(admin, "super_admin")
    monkeypatch.setattr(enterprise, "_super_admin_ids", lambda: {target["user_id"]})

    assert client.post(f"/api/admin/console/staff/{target['user_id']}/revoke",
                       headers=admin).status_code == 409
    assert client.delete(f"/api/admin/console/staff/{target['user_id']}",
                         headers=admin).status_code == 409
    assert main.one("SELECT id FROM users WHERE id=?", (target["user_id"],)) is not None
