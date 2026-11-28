"""Seed a local-only demo for the Voice AI interview flow.

Run:
    python seed_interview_demo.py

Accounts printed at the end. Uses backend/data/demo_interview.db only.
"""
import os
import sys
import time
import uuid
from pathlib import Path

BACKEND = Path(__file__).resolve().parent
DB = BACKEND / "data" / "demo_interview.db"
os.environ["DB_PATH"] = str(DB)
os.environ["SEED_DEMO"] = "false"
os.environ.pop("DATABASE_URL", None)
sys.path.insert(0, str(BACKEND))

import main  # noqa: E402  (loads .env-free local SQLite schema)
import interview_integrity as integrity  # noqa: E402
import ai_interview  # noqa: E402

CANDIDATE_EMAIL = "candidate.demo@skillbridge.local"
CANDIDATE_PASSWORD = "Candidate#2026"
COMPANY_EMAIL = "company.demo@skillbridge.local"
COMPANY_PASSWORD = "Company#2026"
ADMIN_EMAIL = "admin.demo@skillbridge.local"
ADMIN_PASSWORD = "Admin#2026"


def upsert_user(email, name, role, password):
    row = main.one("SELECT id FROM users WHERE email=?", (email,))
    if row:
        uid = row["id"]
        main.run("UPDATE users SET name=?,pw_hash=?,email_verified=?,mfa_enabled=0 WHERE id=?",
                 (name, main.hash_pw(password), time.time(), uid))
    else:
        uid = main.run(
            "INSERT INTO users(email,name,salt,pw_hash,created,email_verified) VALUES (?,?,?,?,?,?)",
            (email, name, "salt", main.hash_pw(password), time.time(), time.time()))
    main.run("INSERT INTO user_roles(user_id,role) VALUES (?,?) "
             "ON CONFLICT(user_id) DO UPDATE SET role=excluded.role", (uid, role))
    return uid


candidate_id = upsert_user(CANDIDATE_EMAIL, "Sadia Rahman", "candidate", CANDIDATE_PASSWORD)
company_owner_id = upsert_user(COMPANY_EMAIL, "Demo Recruiter", "company", COMPANY_PASSWORD)
admin_id = upsert_user(ADMIN_EMAIL, "Demo Admin", "admin", ADMIN_PASSWORD)
main.run("INSERT INTO admin_staff_roles(user_id,admin_role,updated_by,updated_at) VALUES (?,?,?,?) "
         "ON CONFLICT(user_id) DO UPDATE SET admin_role='super_admin'",
         (admin_id, "super_admin", admin_id, time.time()))

# Candidate profile so the workspace opens on the Assessments page.
main.run("INSERT INTO candidate_profiles(user_id,name,email,headline,summary,updated) "
         "VALUES (?,?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET name=excluded.name,"
         "email=excluded.email,headline=excluded.headline,summary=excluded.summary,updated=excluded.updated",
         (candidate_id, "Sadia Rahman", CANDIDATE_EMAIL, "Junior data analyst",
          "SQL, Python and dashboard experience from university projects.", time.time()))

company = main.one("SELECT id FROM companies WHERE owner_user_id=?", (company_owner_id,))
if company:
    company_id = company["id"]
    main.run("UPDATE companies SET name=?,website=?,verified=1 WHERE id=?",
             ("Northstar Analytics", "https://example.com", company_id))
else:
    company_id = "demo-company-" + uuid.uuid4().hex[:8]
    main.run("INSERT INTO companies(id,owner_user_id,name,website,verified,created) VALUES (?,?,?,?,?,?)",
             (company_id, company_owner_id, "Northstar Analytics", "https://example.com", 1, time.time()))
main.run("INSERT INTO company_verification(company_id,legal_name,country,business_id,evidence_note,"
         "status,decision_reason,submitted_at,reviewed_at,reviewed_by) VALUES (?,?,?,?,?,?,?,?,?,?) "
         "ON CONFLICT(company_id) DO UPDATE SET status='verified',reviewed_at=excluded.reviewed_at",
         (company_id, "Northstar Analytics Ltd", "BD", "DEMO-1234", "Local demo company",
          "verified", "", time.time(), time.time(), admin_id))

job_id = "demo-job-ai-interview"
main.run("INSERT INTO jobs(id,company_id,title,description,location,employment_type,skills,status,is_mock,created) "
         "VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status='published',title=excluded.title",
         (job_id, company_id, "Junior Data Analyst",
          "Join our analytics team. You will write SQL, build dashboards and explain findings to non-technical colleagues. "
          "We value clear thinking and honest communication.",
          "Dhaka, Bangladesh (Hybrid)", "Full-time", '["SQL", "Python", "Data visualisation"]',
          "published", 1, time.time()))
main.run("INSERT INTO job_details(job_id,details_json,revision,updated) VALUES (?,?,1,?) "
         "ON CONFLICT(job_id) DO UPDATE SET details_json=excluded.details_json,updated=excluded.updated",
         (job_id, __import__("json").dumps({
             "required_skills": ["SQL", "Python", "Data visualisation"],
             "preferred_skills": ["Power BI"],
             "eligibility": "Final-year student or recent graduate.",
             "hard_requirements": [],
             "work_mode": "Hybrid",
         }), time.time()))

application_id = "demo-application-ai"
main.run("INSERT INTO applications(id,job_id,candidate_id,status,results_shared,created,shortlisted,interview_method) "
         "VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET shortlisted=1,interview_method='ai'",
         (application_id, job_id, candidate_id, "submitted", 0, time.time(), 1, "ai"))

invite_id = "demo-ai-invite"
session_row = main.one("SELECT id FROM ai_interview_sessions WHERE invite_id=?", (invite_id,))
if session_row:
    with main.transaction() as conn:
        turn_ids = [row["id"] for row in conn.execute(
            "SELECT id FROM ai_interview_turns WHERE session_id=?", (session_row["id"],)).fetchall()]
        for turn_id in turn_ids:
            conn.execute("DELETE FROM ai_interview_turn_marks WHERE turn_id=?", (turn_id,))
        conn.execute("DELETE FROM ai_interview_turns WHERE session_id=?", (session_row["id"],))
        conn.execute("DELETE FROM ai_interview_proctor_events WHERE session_id=?", (session_row["id"],))
        conn.execute("DELETE FROM ai_interview_flag_shots WHERE session_id=?", (session_row["id"],))
        conn.execute("DELETE FROM ai_interview_calibration WHERE session_id=?", (session_row["id"],))
        conn.execute("DELETE FROM ai_interview_sessions WHERE id=?", (session_row["id"],))
main.run("DELETE FROM ai_interview_reviews WHERE session_id IN "
         "(SELECT id FROM ai_interview_sessions WHERE invite_id=?)", (invite_id,))

deadline_at = time.time() + 3 * 86400
main.run("""INSERT INTO ai_interview_invites(
    id,application_id,company_id,job_id,candidate_id,language,deadline_at,deadline_days,
    topics_count,max_questions,status,proctoring_level,gaze_enabled,proctor_rule_version,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,'invited',?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET status='invited',deadline_at=excluded.deadline_at,
    language=excluded.language,proctoring_level=excluded.proctoring_level,gaze_enabled=excluded.gaze_enabled,
    proctor_rule_version=excluded.proctor_rule_version,updated_at=excluded.updated_at""",
    (invite_id, application_id, company_id, job_id, candidate_id, "en-US", deadline_at, 3,
     3, 8, "standard", 1, integrity.rule_version(), time.time(), time.time()))
main.run("DELETE FROM ai_interview_custom_questions WHERE invite_id=?", (invite_id,))
main.run("INSERT INTO ai_interview_custom_questions(id,invite_id,text,must_ask,position,created_at) "
         "VALUES (?,?,?,?,?,?)",
         (uuid.uuid4().hex, invite_id,
          "Which part of your data work are you most proud of, and what did you personally do?",
          1, 0, time.time()))

print("=" * 72)
print("LOCAL DEMO READY")
print("Frontend:  http://localhost:5173/#signin")
print("API:       http://localhost:8000/api/health")
print()
print("Candidate: ", CANDIDATE_EMAIL, "/", CANDIDATE_PASSWORD)
print("Company:   ", COMPANY_EMAIL, "/", COMPANY_PASSWORD)
print("Admin:     ", ADMIN_EMAIL, "/", ADMIN_PASSWORD)
print()
print("Invite:", invite_id, "| Application:", application_id, "| Job:", job_id)
print("DB:", DB)
print("=" * 72)
