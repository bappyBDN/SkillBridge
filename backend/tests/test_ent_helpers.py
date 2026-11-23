"""Shared fixtures for the test_ent_* regression tests (no tests in this module).

Every test_ent_* module sets a temporary SQLite DB before importing main, the
same pattern as the existing tests; the production .env is never loaded.
"""
import json
import os
import sys
import tempfile
import time
import uuid

_TMP = tempfile.mkdtemp(prefix="sb_ent_")
os.environ.setdefault("DB_PATH", os.path.join(_TMP, "test.db"))
os.environ["SEED_DEMO"] = "false"
os.environ.setdefault("PBKDF2_ITERATIONS", "1000")
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import main  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

client = TestClient(main.app)


def user(role="candidate", staff_role=None, name="Ent Test"):
    email = uuid.uuid4().hex[:12] + "@example.com"
    uid = main.run(
        "INSERT INTO users(email,name,salt,pw_hash,created,email_verified) VALUES (?,?,?,?,?,?)",
        (email, name, "salt", main.hash_pw("Str0ng-Passw0rd-2026", "salt"), time.time(), time.time()),
    )
    main.run("INSERT INTO user_roles(user_id,role) VALUES (?,?)", (uid, role))
    if staff_role:
        main.run(
            "INSERT INTO admin_staff_roles(user_id,admin_role,updated_by,updated_at) VALUES (?,?,?,?)",
            (uid, staff_role, uid, 0),
        )
    return uid


def headers(uid):
    return {"Authorization": "Bearer " + main.make_token(uid)}


def company(owner_id, verified=True):
    cid = "co-" + uuid.uuid4().hex[:10]
    main.run(
        "INSERT INTO companies(id,owner_user_id,name,website,verified,created) VALUES (?,?,?,?,?,?)",
        (cid, owner_id, "Ent Co", "", 1 if verified else 0, time.time()),
    )
    if verified:
        main.run(
            "INSERT INTO company_verification(company_id,legal_name,country,business_id,evidence_note,status,"
            "decision_reason,submitted_at) VALUES (?,?,?,?,?,?,?,?)",
            (cid, "Ent Co Ltd", "BD", "", "Registered business evidence", "verified", "", time.time()),
        )
    return cid


def member(company_id, role):
    uid = user("company")
    main.run(
        "INSERT INTO company_members(id,company_id,user_id,email,company_role,status,invite_token,created) "
        "VALUES (?,?,?,?,?,?,?,?)",
        (uuid.uuid4().hex, company_id, uid, uuid.uuid4().hex[:8] + "@example.com", role, "active", "", time.time()),
    )
    return uid


def job(company_id, status="published", title="Data Analyst"):
    jid = "job-" + uuid.uuid4().hex[:10]
    main.run(
        "INSERT INTO jobs(id,company_id,title,description,location,employment_type,skills,status,is_mock,created) "
        "VALUES (?,?,?,?,?,?,?,?,?,?)",
        (jid, company_id, title, "SQL and Python dashboards for the team", "Remote", "Full-time",
         json.dumps(["SQL"]), status, 0, time.time()),
    )
    return jid


def application(job_id, candidate_id, status="submitted", shared=True):
    aid = "app-" + uuid.uuid4().hex[:10]
    main.run(
        "INSERT INTO applications(id,job_id,candidate_id,status,results_shared,created) VALUES (?,?,?,?,?,?)",
        (aid, job_id, candidate_id, status, 1 if shared else 0, time.time()),
    )
    return aid


def attempt(user_id, result=None, state=None):
    att = "att-" + uuid.uuid4().hex[:10]
    main.run(
        "INSERT INTO attempts(id,user_id,kind,seed,status,state,started,finished,result) VALUES (?,?,?,?,?,?,?,?,?)",
        (att, user_id, "pre", 1, "done", json.dumps(state or {}), time.time() - 100, time.time(),
         json.dumps(result if result is not None else {
             "overall": 88, "level": "Advanced", "trust": "Needs review",
             "topics": {"sql": {"score": 90, "level": "Advanced"}}})),
    )
    return att


def notifications(uid):
    response = client.get("/api/notifications", headers=headers(uid))
    assert response.status_code == 200, response.text
    return response.json()["items"]


def kinds(uid):
    return [item["kind"] for item in notifications(uid)]
