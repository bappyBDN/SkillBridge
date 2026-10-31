"""Idempotent synthetic demo data for the hiring workflow."""
import json, time, uuid, secrets
from main import hash_pw, init_db, one, run

PASSWORD = "demo12345"

def create_user(email, name, role):
    row = one("SELECT id FROM users WHERE email=?", (email,))
    if row:
        uid = row["id"]
        run("INSERT INTO user_roles(user_id,role) VALUES (?,?) ON CONFLICT(user_id) DO UPDATE SET role=excluded.role", (uid, role))
        return uid
    salt = secrets.token_hex(16)
    uid = run("INSERT INTO users(email,name,salt,pw_hash,created) VALUES (?,?,?,?,?)", (email, name, salt, hash_pw(PASSWORD, salt), time.time()))
    run("INSERT INTO user_roles(user_id,role) VALUES (?,?)", (uid, role))
    return uid

def seed():
    init_db()
    create_user("demo@skillbridge.test", "Demo Candidate (Synthetic)", "candidate")
    recruiter = create_user("recruiter@skillbridge.test", "Demo Recruiter (Synthetic)", "company")
    create_user("admin@skillbridge.test", "Demo Admin (Synthetic)", "admin")
    row = one("SELECT id FROM companies WHERE owner_user_id=?", (recruiter,))
    if row:
        cid = row["id"]
    else:
        cid = uuid.uuid4().hex
        run("INSERT INTO companies(id,owner_user_id,name,website,verified,created) VALUES (?,?,?,?,?,?)", (cid, recruiter, "Northstar Analytics (DEMO)", "https://example.com", 0, time.time()))
    jobs = [
        ("Junior Data Analyst", "Entry-level role using SQL, Python, Excel and dashboards. Synthetic demo posting.", ["SQL", "Python", "Excel", "Data visualization"]),
        ("Backend Engineer Intern", "Learning-focused internship using Python, FastAPI, PostgreSQL and REST APIs. Synthetic demo posting.", ["Python", "FastAPI", "PostgreSQL", "REST API"]),
        ("AI Engineer Intern", "Synthetic internship involving LLM applications, evaluation and retrieval augmented generation.", ["Python", "LLM", "RAG", "Evaluation"])
    ]
    for title, desc, skills in jobs:
        if one("SELECT id FROM jobs WHERE company_id=? AND title=?", (cid, title)):
            continue
        run("INSERT INTO jobs(id,company_id,title,description,location,employment_type,skills,status,is_mock,created) VALUES (?,?,?,?,?,?,?,?,?,?)", (uuid.uuid4().hex, cid, title, desc, "Dhaka / Hybrid", "Internship", json.dumps(skills), "published", 1, time.time()))
    print("[seed-enterprise] synthetic candidate, recruiter, admin and job records ready")

if __name__ == "__main__":
    seed()
