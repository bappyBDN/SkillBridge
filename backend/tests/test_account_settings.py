"""Account settings: authenticated password change and email reset flow."""
import os
import sys
import tempfile
import time
import uuid
import hashlib

from fastapi.testclient import TestClient

_TMP = tempfile.mkdtemp(prefix="sb_account_settings_")
os.environ.setdefault("DB_PATH", os.path.join(_TMP, "test.db"))
os.environ.setdefault("PBKDF2_ITERATIONS", "1000")
os.environ["SEED_DEMO"] = "false"
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import main

client = TestClient(main.app)
PASSWORD = "Str0ng-Passw0rd-2026"
NEW_PASSWORD = "N3w-Str0ng-Passw0rd-2027"


def account():
    email = uuid.uuid4().hex + "@example.com"
    response = client.post("/api/auth/register", json={
        "email": email, "name": "Settings Candidate", "password": PASSWORD})
    assert response.status_code == 200, response.text
    token = response.json().get("token")
    if not token:
        token = client.post("/api/auth/login", json={"email": email, "password": PASSWORD}).json()["token"]
    return email, token, {"Authorization": "Bearer " + token}


def login(email, password):
    return client.post("/api/auth/login", json={"email": email, "password": password})


def test_change_password_requires_current_password_and_revokes_other_sessions():
    email, token, headers = account()
    other = login(email, PASSWORD).json()["token"]
    other_headers = {"Authorization": "Bearer " + other}

    wrong = client.post("/api/auth/change-password", headers=headers,
                        json={"current_password": "Wr0ng-Passw0rd-2026", "new_password": NEW_PASSWORD})
    assert wrong.status_code == 401

    weak = client.post("/api/auth/change-password", headers=headers,
                       json={"current_password": PASSWORD, "new_password": "short"})
    assert weak.status_code == 422

    same = client.post("/api/auth/change-password", headers=headers,
                       json={"current_password": PASSWORD, "new_password": PASSWORD})
    assert same.status_code == 422

    changed = client.post("/api/auth/change-password", headers=headers,
                          json={"current_password": PASSWORD, "new_password": NEW_PASSWORD})
    assert changed.status_code == 200, changed.text
    assert changed.json()["ok"] is True

    # The current session survives; every other device is revoked.
    assert client.get("/api/auth/sessions", headers=headers).status_code == 200
    assert client.get("/api/auth/sessions", headers=other_headers).status_code == 401

    assert login(email, PASSWORD).status_code == 401
    assert login(email, NEW_PASSWORD).status_code == 200


def test_forgot_password_token_is_single_use_and_resets_the_account():
    email, _token, headers = account()
    forgot = client.post("/api/auth/forgot-password", json={"email": email})
    assert forgot.status_code == 200, forgot.text
    token = forgot.json()["reset_token"]
    assert token
    stored = main.one("SELECT token_hash FROM password_resets WHERE user_id=(SELECT id FROM users WHERE email=?)",
                      (email,))["token_hash"]
    assert stored == hashlib.sha256(token.encode()).hexdigest()
    assert token not in stored

    weak = client.post("/api/auth/reset-password", json={"token": token, "password": "short"})
    assert weak.status_code == 422

    reset = client.post("/api/auth/reset-password", json={"token": token, "password": NEW_PASSWORD})
    assert reset.status_code == 200, reset.text
    assert reset.json()["ok"] is True

    # Every existing session is revoked, including the pre-reset bearer token.
    assert client.get("/api/state", headers=headers).status_code == 401
    assert login(email, PASSWORD).status_code == 401
    assert login(email, NEW_PASSWORD).status_code == 200

    reused = client.post("/api/auth/reset-password", json={"token": token, "password": PASSWORD})
    assert reused.status_code == 400


def test_forgot_password_does_not_reveal_unknown_addresses():
    response = client.post("/api/auth/forgot-password",
                           json={"email": "no-such-account@example.com"})
    assert response.status_code == 200
    assert response.json()["ok"] is True
    assert "reset_token" not in response.json()


def test_expired_reset_token_is_rejected():
    email, _token, _headers = account()
    raw = main._issue_password_reset(
        main.one("SELECT id FROM users WHERE email=?", (email,))["id"], email)
    main.run("UPDATE password_resets SET expires=? WHERE used IS NULL", (time.time() - 1,))
    response = client.post("/api/auth/reset-password", json={"token": raw, "password": NEW_PASSWORD})
    assert response.status_code == 400
    assert login(email, PASSWORD).status_code == 200


def test_changing_password_clears_outstanding_reset_links():
    email, _token, headers = account()
    client.post("/api/auth/forgot-password", json={"email": email})
    changed = client.post("/api/auth/change-password", headers=headers,
                          json={"current_password": PASSWORD, "new_password": NEW_PASSWORD})
    assert changed.status_code == 200, changed.text
    assert main.one("SELECT COUNT(*) AS n FROM password_resets WHERE user_id=(SELECT id FROM users WHERE email=?)",
                    (email,))["n"] == 0


def test_account_deletion_removes_pending_reset_links():
    email, _token, headers = account()
    uid = main.one("SELECT id FROM users WHERE email=?", (email,))["id"]
    client.post("/api/auth/forgot-password", json={"email": email})
    assert client.delete("/api/me", headers=headers).status_code == 200
    assert main.one("SELECT COUNT(*) AS n FROM password_resets WHERE user_id=?", (uid,))["n"] == 0
