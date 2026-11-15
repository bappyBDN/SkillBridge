"""Idempotent synthetic demo data for the hiring workflow.

SB-006: this module must never create an account with a known password, and it
refuses to run against a production deployment.

    SEED_DEMO=true python seed_enterprise.py

The demo password comes from ``SEED_DEMO_PASSWORD``. When that variable is
absent a random password is generated and printed once, so the seed still works
for local demos without shipping a shared credential in source control.
"""
import json
import os
import secrets
import sys
import time
import uuid

from main import ENVIRONMENT, IS_PRODUCTION, hash_pw, init_db, one, run

PASSWORD_ENV = "SEED_DEMO_PASSWORD"


def _guard():
    """Refuse to seed production, or when seeding was not explicitly enabled."""
    if IS_PRODUCTION:
        raise SystemExit(
            "Refusing to seed demo accounts: ENV=production. "
            "Create administrators with create_admin.py instead."
        )
    if os.getenv("SEED_DEMO", "false").strip().lower() != "true":
        raise SystemExit(
            "Refusing to seed demo accounts. Set SEED_DEMO=true to opt in."
        )


def _demo_password() -> tuple[str, bool]:
    supplied = os.getenv(PASSWORD_ENV, "").strip()
    if supplied:
        return supplied, False
    return secrets.token_urlsafe(18), True


def create_user(email, name, role, password):
    row = one("SELECT id FROM users WHERE email=?", (email,))
    if row:
        uid = row["id"]
        run(
            "INSERT INTO user_roles(user_id,role) VALUES (?,?) "
            "ON CONFLICT(user_id) DO UPDATE SET role=excluded.role",
            (uid, role),
        )
        return uid
    salt = secrets.token_hex(16)
    uid = run(
        "INSERT INTO users(email,name,salt,pw_hash,created,email_verified) VALUES (?,?,?,?,?,?)",
        (email, name, salt, hash_pw(password), time.time(), time.time()),
    )
    run("INSERT INTO user_roles(user_id,role) VALUES (?,?)", (uid, role))
    return uid


def seed():
    _guard()
    init_db()
    password, generated = _demo_password()
    accounts = [
        ("demo@skillbridge.test", "Demo Candidate (Synthetic)", "candidate"),
        ("recruiter@skillbridge.test", "Demo Recruiter (Synthetic)", "company"),
        ("admin@skillbridge.test", "Demo Admin (Synthetic)", "admin"),
    ]
    recruiter = None
    for email, name, role in accounts:
        uid = create_user(email, name, role, password)
        if role == "company":
            recruiter = uid
    from enterprise import ensure_admin_console_schema
    ensure_admin_console_schema()
    run(
        """INSERT INTO admin_staff_roles(user_id,admin_role,updated_by,updated_at)
           VALUES (?, 'super_admin', ?, ?)
           ON CONFLICT(user_id) DO UPDATE SET admin_role='super_admin'""",
        (one("SELECT id FROM users WHERE email='admin@skillbridge.test'")["id"],
         one("SELECT id FROM users WHERE email='admin@skillbridge.test'")["id"], time.time()),
    )
    row = one("SELECT id FROM companies WHERE owner_user_id=?", (recruiter,))
    if row:
        cid = row["id"]
    else:
        cid = uuid.uuid4().hex
        run(
            "INSERT INTO companies(id,owner_user_id,name,website,verified,created) VALUES (?,?,?,?,?,?)",
            (cid, recruiter, "Northstar Analytics (DEMO)", "https://example.com", 0, time.time()),
        )
    jobs = [
        ("Junior Data Analyst",
         "Entry-level role using SQL, Python, Excel and dashboards. Synthetic demo posting.",
         ["SQL", "Python", "Excel", "Data visualization"]),
        ("Backend Engineer Intern",
         "Learning-focused internship using Python, FastAPI, PostgreSQL and REST APIs. Synthetic demo posting.",
         ["Python", "FastAPI", "PostgreSQL", "REST API"]),
        ("AI Engineer Intern",
         "Synthetic internship involving LLM applications, evaluation and retrieval augmented generation.",
         ["Python", "LLM", "RAG", "Evaluation"]),
    ]
    for title, desc, skills in jobs:
        if one("SELECT id FROM jobs WHERE company_id=? AND title=?", (cid, title)):
            continue
        run(
            "INSERT INTO jobs(id,company_id,title,description,location,employment_type,skills,status,is_mock,created) "
            "VALUES (?,?,?,?,?,?,?,?,?,?)",
            (uuid.uuid4().hex, cid, title, desc, "Dhaka / Hybrid", "Internship",
             json.dumps(skills), "published", 1, time.time()),
        )
    print(f"[seed-enterprise] synthetic candidate, recruiter, admin and job records ready (ENV={ENVIRONMENT})")
    if generated:
        print(f"[seed-enterprise] generated demo password (shown once): {password}")
        print("[seed-enterprise] set SEED_DEMO_PASSWORD to reuse a fixed demo password.")


if __name__ == "__main__":
    try:
        seed()
    except SystemExit as ex:
        print(f"[seed-enterprise] {ex}", file=sys.stderr)
        raise
