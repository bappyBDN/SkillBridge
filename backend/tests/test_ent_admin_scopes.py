"""Admin staff scopes, least privilege, lists/pagination and evidence streaming."""
import json
import time
import uuid

from test_ent_helpers import attempt, client, headers, main, user

import enterprise


def test_admin_without_staff_row_has_no_scope():
    bare = user("admin")  # role only, never assigned a staff role
    h = headers(bare)
    for path in ("/api/admin/identity-reviews", "/api/admin/overview", "/api/admin/users",
                 "/api/admin/console/users", "/api/admin/company-verifications"):
        assert client.get(path, headers=h).status_code == 403, path
    me = client.get("/api/admin/console/me", headers=h).json()
    assert me["admin_role"] is None and me["scopes"] == []


def test_legacy_backfill_only_runs_on_an_empty_staff_table():
    user("admin", "super_admin")  # the staff table is no longer empty
    bare = user("admin")
    enterprise.ensure_admin_console_schema()  # staff rows exist -> no backfill
    assert enterprise.staff_role_of(bare) is None


def test_plain_admin_endpoints_now_enforce_scopes():
    support = headers(user("admin", "support_agent"))
    finance = headers(user("admin", "finance_admin"))
    verifier = headers(user("admin", "company_verification_admin"))
    candidate = user()
    # support_agent: users_read only
    assert client.get("/api/admin/users", headers=support).status_code == 200
    assert client.get(f"/api/admin/candidates/{candidate}", headers=support).status_code == 200
    assert client.get("/api/admin/overview", headers=support).status_code == 403
    assert client.get("/api/admin/company-verifications", headers=support).status_code == 403
    assert client.get("/api/admin/job-review-queue", headers=support).status_code == 403
    assert client.get("/api/admin/company-assessments", headers=support).status_code == 403
    # finance_admin cannot read candidates or their CVs
    assert client.get(f"/api/admin/candidates/{candidate}", headers=finance).status_code == 403
    assert client.get(f"/api/admin/candidates/{candidate}/cv", headers=finance).status_code == 403
    assert client.get("/api/admin/users", headers=finance).status_code == 403
    # company verification admin: verification + job moderation queues
    assert client.get("/api/admin/company-verifications", headers=verifier).status_code == 200
    assert client.get("/api/admin/job-review-queue", headers=verifier).status_code == 200
    assert client.get("/api/admin/company-assessments", headers=verifier).status_code == 200


def test_candidate_detail_hides_trust_without_integrity_scope():
    candidate = user()
    attempt(candidate)
    support = headers(user("admin", "support_agent"))
    trust_reviewer = headers(user("admin", "trust_safety_reviewer"))
    hidden = client.get(f"/api/admin/candidates/{candidate}", headers=support).json()
    shown = client.get(f"/api/admin/candidates/{candidate}", headers=trust_reviewer).json()
    assert hidden["attempts"][0]["trust"] is None
    assert shown["attempts"][0]["trust"] == "Needs review"


def test_users_list_paginates_with_total():
    admin = headers(user("admin", "super_admin"))
    for _ in range(3):
        user()
    first = client.get("/api/admin/console/users?limit=2&offset=0", headers=admin).json()
    second = client.get("/api/admin/console/users?limit=2&offset=2", headers=admin).json()
    assert len(first["items"]) == 2 and first["total"] >= 4
    assert {i["id"] for i in first["items"]}.isdisjoint({i["id"] for i in second["items"]})
    legacy = client.get("/api/admin/users?limit=1", headers=admin).json()
    assert len(legacy["items"]) == 1 and legacy["total"] >= 4 and legacy["offset"] == 0


def test_integrity_trust_filter_runs_before_limit():
    admin = headers(user("admin", "super_admin"))
    candidate = user()
    wanted = attempt(candidate, {"trust": "High", "overall": 50})
    for _ in range(3):
        attempt(candidate, {"trust": "Medium", "overall": 50})
    body = client.get("/api/admin/integrity/attempts?trust=High&limit=1", headers=admin).json()
    assert body["total"] >= 1
    assert [item["trust"] for item in body["items"]] == ["High"]
    ids = set()
    offset = 0
    while True:
        page = client.get(f"/api/admin/integrity/attempts?trust=High&limit=1&offset={offset}", headers=admin).json()
        if not page["items"]:
            break
        ids.update(item["id"] for item in page["items"])
        offset += 1
    assert wanted in ids


def test_assessment_review_queue_paginates_and_reads_state_inline():
    admin = headers(user("admin", "super_admin"))
    candidate = user()
    for _ in range(2):
        attempt(candidate, {"overall": 70}, state={"answers": []})
    body = client.get("/api/admin/assessment-reviews?limit=1", headers=admin).json()
    assert len(body["items"]) == 1 and body["total"] >= 2 and body["limit"] == 1
    assert "state" not in body["items"][0]
    appeals = client.get("/api/admin/appeals?limit=5", headers=admin).json()
    assert {"items", "total", "limit", "offset"} <= set(appeals)


def test_attempt_detail_returns_evidence_urls_and_image_endpoint_streams_bytes():
    admin_id = user("admin", "trust_safety_reviewer")
    admin = headers(admin_id)
    candidate = user()
    att = attempt(candidate, {"trust": "High"})
    image = b"\xff\xd8\xff\xe0fakejpegbytes"
    evidence_id = uuid.uuid4().hex
    main.run("INSERT INTO exam_evidence(id,attempt_id,event_id,captured_at,mime_type,image_data,size_bytes,expires_at) "
             "VALUES (?,?,?,?,?,?,?,?)", (evidence_id, att, None, time.time(), "image/jpeg", image, len(image), time.time() + 3600))
    detail = client.get(f"/api/admin/integrity/attempts/{att}", headers=admin).json()
    item = detail["evidence"][0]
    assert "data_url" not in item
    assert item["url"] == f"/api/admin/attempts/{att}/evidence/{evidence_id}"
    streamed = client.get(item["url"], headers=admin)
    assert streamed.status_code == 200 and streamed.content == image
    assert streamed.headers["content-type"] == "image/jpeg"
    assert "no-store" in streamed.headers["cache-control"]
    support = headers(user("admin", "support_agent"))
    assert client.get(item["url"], headers=support).status_code == 403
    assert client.get(f"/api/admin/attempts/{att}/evidence/missing", headers=admin).status_code == 404


def test_hot_indexes_exist():
    names = {row["name"] for row in main.allr("SELECT indexname AS name FROM pg_indexes" if main.DATABASE_URL else "SELECT name FROM sqlite_master WHERE type='index'")}
    assert {"idx_applications_candidate", "idx_applications_job", "idx_jobs_company_status",
            "idx_company_members_user"} <= names


def test_ai_operations_reports_any_provider_and_budget(monkeypatch):
    admin = headers(user("admin", "compliance_officer"))
    monkeypatch.setenv("AI_PROVIDER", "groq")
    monkeypatch.setenv("AI_PROVIDER_FALLBACKS", "")
    monkeypatch.setenv("GROQ_API_KEYS", "test-key")
    body = client.get("/api/admin/ai-operations", headers=admin).json()
    assert body["configured"] is True and body["provider"] == "groq"
    assert "budget" in body and "limit_usd" in body["budget"]
    assert "not instrumented" not in body["note"]
    monkeypatch.setenv("GROQ_API_KEYS", "")
    monkeypatch.setenv("GROQ_API_KEY", "")
    assert client.get("/api/admin/ai-operations", headers=admin).json()["status"] == "fallback_mode"


def test_identity_decision_on_closed_review_conflicts_and_notifies_neutrally():
    admin = headers(user("admin", "trust_safety_reviewer"))
    candidate = user()
    rid = uuid.uuid4().hex
    main.run("INSERT INTO identity_reviews(id,user_id,status,signal,created,note) VALUES (?,?,?,?,?,?)",
             (rid, candidate, "open", json.dumps({"status": "no_match"}), time.time(), ""))
    first = client.post(f"/api/admin/identity-reviews/{rid}/decision", headers=admin,
                        json={"decision": "cleared", "note": "Matched on review"})
    assert first.status_code == 200, first.text
    again = client.post(f"/api/admin/identity-reviews/{rid}/decision", headers=admin,
                        json={"decision": "needs_review", "note": "x"})
    assert again.status_code == 409
    from test_ent_helpers import notifications
    items = [n for n in notifications(candidate) if n["kind"] == "identity_review_cleared"]
    assert len(items) == 1
    assert "Matched on review" not in items[0]["body"] and "no_match" not in items[0]["body"]


def test_upgrade_keeps_existing_admins_without_staff_rows_and_runs_once():
    """First boot of this version writes legacy implicit super admins in
    explicitly; after the marker, a newly added role-only admin gets no scope."""
    import time as _t, uuid as _u
    import enterprise as ent
    legacy = main.run("INSERT INTO users(email,name,salt,pw_hash,created) VALUES (?,?,?,?,?)",
                      (f"legacy-{_u.uuid4().hex}@example.com", "Legacy Admin", "s", "h", _t.time()))
    legacy = legacy or main.one("SELECT max(id) AS id FROM users")["id"]
    main.run("INSERT INTO user_roles(user_id,role) VALUES (?,?)", (legacy, "admin"))
    main.run("DELETE FROM app_migrations WHERE name=?", ("admin_staff_roles_explicit_v1",))
    ent.ensure_admin_console_schema()
    row = main.one("SELECT admin_role FROM admin_staff_roles WHERE user_id=?", (legacy,))
    assert row and row["admin_role"] == "super_admin"
    later = main.run("INSERT INTO users(email,name,salt,pw_hash,created) VALUES (?,?,?,?,?)",
                     (f"later-{_u.uuid4().hex}@example.com", "Later Admin", "s", "h", _t.time()))
    later = later or main.one("SELECT max(id) AS id FROM users")["id"]
    main.run("INSERT INTO user_roles(user_id,role) VALUES (?,?)", (later, "admin"))
    ent.ensure_admin_console_schema()
    assert main.one("SELECT admin_role FROM admin_staff_roles WHERE user_id=?", (later,)) is None
