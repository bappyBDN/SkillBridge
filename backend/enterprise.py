"""Initial hiring workflow APIs for SkillBridge PRD."""
import json, time, uuid, os
from typing import Optional, List
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from main import current_user, one, allr, run, audit

router = APIRouter(tags=["hiring"])

def role_of(user):
    row = one("SELECT role FROM user_roles WHERE user_id=?", (user["id"],))
    return row["role"] if row else "candidate"

def require_role(user, *roles):
    if role_of(user) not in roles:
        raise HTTPException(403, "This action is not allowed for your account role")

def company_for(user):
    company = one("SELECT * FROM companies WHERE owner_user_id=?", (user["id"],))
    if company:
        return dict(company)
    # Membership lookup is tenant-scoped; company role alone never grants access.
    member = one("""SELECT c.* FROM companies c JOIN company_members m ON m.company_id=c.id
                    WHERE m.user_id=? AND m.status='active' LIMIT 1""", (user["id"],))
    if not member:
        raise HTTPException(409, "Your account is not connected to an organisation yet")
    return dict(member)

class CompanyProfile(BaseModel):
    name: str = Field(min_length=2, max_length=120)
    website: Optional[str] = Field(default=None, max_length=240)
class JobCreate(BaseModel):
    title: str = Field(min_length=3, max_length=140)
    description: str = Field(min_length=20, max_length=8000)
    location: str = Field(default="Remote", max_length=120)
    employment_type: str = Field(default="Full-time", max_length=40)
    skills: List[str] = Field(default_factory=list, max_length=30)
    publish: bool = False
class ShareResults(BaseModel):
    share: bool
class CompanyAssessmentCreate(BaseModel):
    title: str = Field(min_length=3, max_length=140)
    requirements: str = Field(min_length=10, max_length=5000)
    questions: List[dict] = Field(default_factory=list, max_length=100)
    job_id: Optional[str] = None


class EducationItem(BaseModel):
    institution: str = Field(min_length=2, max_length=160)
    degree: str = Field(default="", max_length=160)
    field: str = Field(default="", max_length=160)
    start_year: str = Field(default="", max_length=10)
    end_year: str = Field(default="", max_length=10)
    details: str = Field(default="", max_length=1000)

class ExperienceItem(BaseModel):
    company: str = Field(min_length=2, max_length=160)
    title: str = Field(min_length=2, max_length=160)
    employment_type: str = Field(default="", max_length=60)
    start_date: str = Field(default="", max_length=20)
    end_date: str = Field(default="", max_length=20)
    current: bool = False
    description: str = Field(default="", max_length=2000)

class ProjectItem(BaseModel):
    name: str = Field(min_length=2, max_length=160)
    description: str = Field(default="", max_length=2000)
    technologies: List[str] = Field(default_factory=list, max_length=30)
    url: str = Field(default="", max_length=300)

class CandidateProfileUpdate(BaseModel):
    headline: str = Field(default="", max_length=180)
    phone: str = Field(default="", max_length=40)
    location: str = Field(default="", max_length=160)
    summary: str = Field(default="", max_length=3000)
    linkedin: str = Field(default="", max_length=300)
    github: str = Field(default="", max_length=300)
    portfolio: str = Field(default="", max_length=300)
    education: List[EducationItem] = Field(default_factory=list, max_length=12)
    experience: List[ExperienceItem] = Field(default_factory=list, max_length=20)
    projects: List[ProjectItem] = Field(default_factory=list, max_length=20)
    preferences: dict = Field(default_factory=dict)

@router.get("/api/candidate/profile")
def get_candidate_profile(user=Depends(current_user)):
    require_role(user, "candidate")
    row = one("SELECT * FROM candidate_profiles WHERE user_id=?", (user["id"],))
    cv = one("SELECT extracted,confirmed,source,redaction FROM profiles WHERE user_id=?", (user["id"],))
    result = {
        "user": {"name": user["name"], "email": user["email"]},
        "profile": {
            "headline": "", "phone": "", "location": "", "summary": "",
            "linkedin": "", "github": "", "portfolio": "",
            "education": [], "experience": [], "projects": [],
            "preferences": {"job_types": ["Internship", "Full-time"], "work_mode": "Any", "locations": []},
            "updated": None,
        },
        "cv": {"uploaded": bool(cv and cv["extracted"]), "source": cv["source"] if cv else None,
               "skills": json.loads(cv["confirmed"]) if cv and cv["confirmed"] else [],
               "extracted_skills": json.loads(cv["extracted"]) if cv and cv["extracted"] else [],
               "redaction": json.loads(cv["redaction"]) if cv and cv["redaction"] else {}},
    }
    if row:
        p = dict(row)
        for key in ("education", "experience", "projects", "preferences"):
            p[key] = json.loads(p[key] or ("{}" if key == "preferences" else "[]"))
        result["profile"].update({k: p[k] for k in ("headline","phone","location","summary","linkedin","github","portfolio","education","experience","projects","preferences","updated")})
    return result

@router.put("/api/candidate/profile")
def update_candidate_profile(body: CandidateProfileUpdate, user=Depends(current_user)):
    require_role(user, "candidate")
    preferences = body.preferences if isinstance(body.preferences, dict) else {}
    allowed_types = {"Internship", "Full-time", "Part-time", "Contract", "Temporary"}
    allowed_modes = {"Any", "Remote", "Hybrid", "On-site"}
    preferences["job_types"] = [x for x in preferences.get("job_types", []) if x in allowed_types][:5]
    preferences["work_mode"] = preferences.get("work_mode", "Any") if preferences.get("work_mode", "Any") in allowed_modes else "Any"
    preferences["locations"] = [str(x)[:100] for x in preferences.get("locations", [])[:10] if str(x).strip()]
    run("""INSERT INTO candidate_profiles(user_id,headline,phone,location,summary,linkedin,github,portfolio,education,experience,projects,preferences,updated)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT(user_id) DO UPDATE SET headline=excluded.headline,phone=excluded.phone,location=excluded.location,
           summary=excluded.summary,linkedin=excluded.linkedin,github=excluded.github,portfolio=excluded.portfolio,
           education=excluded.education,experience=excluded.experience,projects=excluded.projects,
           preferences=excluded.preferences,updated=excluded.updated""",
        (user["id"],body.headline.strip(),body.phone.strip(),body.location.strip(),body.summary.strip(),
         body.linkedin.strip(),body.github.strip(),body.portfolio.strip(),
         json.dumps([x.model_dump() for x in body.education]),json.dumps([x.model_dump() for x in body.experience]),
         json.dumps([x.model_dump() for x in body.projects]),json.dumps(preferences),time.time()))
    audit(user["id"], "candidate_profile_updated")
    return {"ok": True, "updated": time.time()}

@router.get("/api/enterprise/me")
def enterprise_me(user=Depends(current_user)):
    return {"user":{"id":user["id"],"name":user["name"],"email":user["email"]},"role":role_of(user)}

@router.get("/api/jobs")
def public_jobs():
    rows=allr("SELECT j.id,j.title,j.description,j.location,j.employment_type,j.skills,j.status,j.is_mock,j.created,c.name AS company_name FROM jobs j JOIN companies c ON c.id=j.company_id WHERE j.status='published' ORDER BY j.created DESC")
    return {"items":[{**dict(r),"skills":json.loads(r["skills"]),"is_mock":bool(r["is_mock"])} for r in rows]}

@router.post("/api/company/profile")
def create_company_profile(body:CompanyProfile,user=Depends(current_user)):
    require_role(user,"company")
    current=one("SELECT id FROM companies WHERE owner_user_id=?",(user["id"],))
    if current:
        run("UPDATE companies SET name=?,website=? WHERE owner_user_id=?",(body.name.strip(),body.website,user["id"]))
    else:
        membership=one("SELECT id FROM company_members WHERE user_id=? AND status='active' LIMIT 1",(user["id"],))
        if membership:
            raise HTTPException(403,"Only the organisation owner can create or edit company identity details")
        run("INSERT INTO companies(id,owner_user_id,name,website,verified,created) VALUES (?,?,?,?,?,?)",(uuid.uuid4().hex,user["id"],body.name.strip(),body.website,0,time.time()))
    audit(user["id"],"company_profile_saved",body.name.strip())
    return {"ok":True,"company":dict(one("SELECT id,name,website,verified FROM companies WHERE owner_user_id=?",(user["id"],)))}

@router.post("/api/jobs")
def create_job(body:JobCreate,user=Depends(current_user)):
    require_role(user,"company"); company=company_for(user); jid=uuid.uuid4().hex
    if body.publish and not company["verified"]:
        raise HTTPException(403, "Company verification is required before publishing jobs")
    skills=list(dict.fromkeys(s.strip() for s in body.skills if s.strip()))
    run("INSERT INTO jobs(id,company_id,title,description,location,employment_type,skills,status,is_mock,created) VALUES (?,?,?,?,?,?,?,?,?,?)",
        (jid,company["id"],body.title.strip(),body.description.strip(),body.location.strip(),body.employment_type.strip(),json.dumps(skills),"published" if body.publish else "draft",0,time.time()))
    audit(user["id"],"job_created",jid)
    return {"id":jid,"status":"published" if body.publish else "draft"}

@router.get("/api/company/jobs")
def company_jobs(user=Depends(current_user)):
    require_role(user,"company"); company=company_for(user)
    rows=allr("SELECT * FROM jobs WHERE company_id=? ORDER BY created DESC",(company["id"],))
    items=[]
    for row in rows:
        item=dict(row); item["skills"]=json.loads(item["skills"] or "[]"); item["is_mock"]=bool(item["is_mock"])
        detail=one("SELECT details_json,revision,updated FROM job_details WHERE job_id=?",(item["id"],))
        item["details"]=json.loads(detail["details_json"]) if detail else {}
        item["revision"]=detail["revision"] if detail else 1
        items.append(item)
    return {"items":items}

@router.post("/api/jobs/{job_id}/apply")
def apply_to_job(job_id:str,user=Depends(current_user)):
    require_role(user,"candidate")
    if not one("SELECT id FROM jobs WHERE id=? AND status='published'",(job_id,)): raise HTTPException(404,"Published job not found")
    existing=one("SELECT id FROM applications WHERE job_id=? AND candidate_id=?",(job_id,user["id"]))
    if existing: return {"application_id":existing["id"],"status":"already_applied"}
    aid=uuid.uuid4().hex
    run("INSERT INTO applications(id,job_id,candidate_id,status,results_shared,created) VALUES (?,?,?,?,?,?)",(aid,job_id,user["id"],"submitted",0,time.time()))
    audit(user["id"],"job_applied",job_id)
    return {"application_id":aid,"status":"submitted"}

@router.get("/api/applications/mine")
def my_applications(user=Depends(current_user)):
    require_role(user,"candidate")
    rows=allr("SELECT a.id AS application_id,a.status,a.results_shared,a.created,j.id AS job_id,j.title,j.location,j.employment_type,c.name AS company_name FROM applications a JOIN jobs j ON j.id=a.job_id JOIN companies c ON c.id=j.company_id WHERE a.candidate_id=? ORDER BY a.created DESC",(user["id"],))
    return {"items":[{**dict(r),"results_shared":bool(r["results_shared"])} for r in rows]}

@router.put("/api/applications/{application_id}/share-results")
def share_results(application_id:str,body:ShareResults,user=Depends(current_user)):
    require_role(user,"candidate")
    if not one("SELECT id FROM applications WHERE id=? AND candidate_id=?",(application_id,user["id"])): raise HTTPException(404,"Application not found")
    run("UPDATE applications SET results_shared=? WHERE id=? AND candidate_id=?",(1 if body.share else 0,application_id,user["id"]))
    audit(user["id"],"application_results_sharing_changed",application_id)
    return {"application_id":application_id,"results_shared":body.share}

@router.get("/api/company/applications")
def company_applications(user=Depends(current_user)):
    require_role(user,"company"); company=company_for(user)
    if not company["verified"]:
        raise HTTPException(403, "Company verification is required before accessing applicant records")
    rows=allr("SELECT a.id AS application_id,a.status,a.results_shared,a.created,j.id AS job_id,j.title AS job_title,u.id AS candidate_id,u.name AS candidate_name FROM applications a JOIN jobs j ON j.id=a.job_id JOIN users u ON u.id=a.candidate_id WHERE j.company_id=? ORDER BY a.created DESC",(company["id"],))
    items=[]
    for row in rows:
        item=dict(row); item["results_shared"]=bool(item["results_shared"]); item["latest_assessment"]=None
        if item["results_shared"]:
            att=one("SELECT result,finished FROM attempts WHERE user_id=? AND status='done' ORDER BY finished DESC LIMIT 1",(item["candidate_id"],))
            if att and att["result"]:
                result=json.loads(att["result"]); item["latest_assessment"]={"overall":result.get("overall"),"level":result.get("level"),"trust":result.get("trust"),"finished":att["finished"]}
        items.append(item)
    return {"items":items}

@router.post("/api/company/assessments")
def request_company_assessment(body:CompanyAssessmentCreate,user=Depends(current_user)):
    require_role(user,"company"); company=company_for(user)
    if body.job_id and not one("SELECT id FROM jobs WHERE id=? AND company_id=?",(body.job_id,company["id"])): raise HTTPException(404,"Job not found for this company")
    aid=uuid.uuid4().hex
    run("INSERT INTO company_assessments(id,company_id,job_id,title,requirements,questions,status,created) VALUES (?,?,?,?,?,?,?,?)",(aid,company["id"],body.job_id,body.title.strip(),body.requirements.strip(),json.dumps(body.questions),"requested",time.time()))
    audit(user["id"],"company_assessment_requested",aid)
    return {"id":aid,"status":"requested"}

@router.get("/api/admin/overview")
def admin_overview(user=Depends(current_user)):
    require_role(user,"admin")
    counts={"users":one("SELECT COUNT(*) AS n FROM users")["n"],"candidates":one("SELECT COUNT(*) AS n FROM user_roles WHERE role='candidate'")["n"],"companies":one("SELECT COUNT(*) AS n FROM companies")["n"],"jobs":one("SELECT COUNT(*) AS n FROM jobs")["n"],"applications":one("SELECT COUNT(*) AS n FROM applications")["n"],"attempts":one("SELECT COUNT(*) AS n FROM attempts")["n"],"assessment_requests":one("SELECT COUNT(*) AS n FROM company_assessments WHERE status='requested'")["n"]}
    return {"counts":counts,"demo_data":True,"note":"Counts may include explicitly labelled synthetic demo records."}

@router.get("/api/admin/users")
def admin_users(user=Depends(current_user)):
    require_role(user,"admin")
    rows=allr("SELECT u.id,u.name,u.email,COALESCE(r.role,'candidate') AS role,u.created FROM users u LEFT JOIN user_roles r ON r.user_id=u.id ORDER BY u.created DESC LIMIT 500")
    return {"items":[dict(r) for r in rows]}

@router.get("/api/admin/company-assessments")
def admin_company_assessments(user=Depends(current_user)):
    require_role(user,"admin")
    rows=allr("SELECT a.id,a.title,a.requirements,a.questions,a.status,a.created,c.name AS company_name FROM company_assessments a JOIN companies c ON c.id=a.company_id ORDER BY a.created DESC")
    return {"items":[{**dict(r),"questions":json.loads(r["questions"])} for r in rows]}


# ---------------------------------------------------------------------------
# Company / recruiter workspace — PRD v2.0 implementation slice.
# These tables are tenant-scoped and intentionally keep candidate evidence
# separate from recruiter notes and assessment integrity data.
def ensure_company_workspace_schema():
    statements = [
        """CREATE TABLE IF NOT EXISTS company_verification (
            company_id TEXT PRIMARY KEY, legal_name TEXT NOT NULL, country TEXT NOT NULL,
            business_id TEXT NOT NULL DEFAULT '', evidence_note TEXT NOT NULL DEFAULT '',
            status TEXT NOT NULL DEFAULT 'pending_review', decision_reason TEXT NOT NULL DEFAULT '',
            submitted_at REAL NOT NULL, reviewed_at REAL, reviewed_by INTEGER)""",
        """CREATE TABLE IF NOT EXISTS job_details (
            job_id TEXT PRIMARY KEY, details_json TEXT NOT NULL DEFAULT '{}',
            revision INTEGER NOT NULL DEFAULT 1, updated REAL NOT NULL)""",
        """CREATE TABLE IF NOT EXISTS job_revisions (
            id TEXT PRIMARY KEY, job_id TEXT NOT NULL, revision INTEGER NOT NULL,
            snapshot_json TEXT NOT NULL, actor_id INTEGER NOT NULL, created REAL NOT NULL)""",
        """CREATE TABLE IF NOT EXISTS application_notes (
            id TEXT PRIMARY KEY, application_id TEXT NOT NULL, company_id TEXT NOT NULL,
            author_id INTEGER NOT NULL, body TEXT NOT NULL, created REAL NOT NULL)""",
        """CREATE TABLE IF NOT EXISTS application_history (
            id TEXT PRIMARY KEY, application_id TEXT NOT NULL, company_id TEXT NOT NULL,
            actor_id INTEGER NOT NULL, from_stage TEXT NOT NULL, to_stage TEXT NOT NULL,
            reason TEXT NOT NULL DEFAULT '', created REAL NOT NULL)""",
        """CREATE TABLE IF NOT EXISTS company_members (
            id TEXT PRIMARY KEY, company_id TEXT NOT NULL, user_id INTEGER,
            email TEXT NOT NULL, company_role TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'invited',
            invite_token TEXT NOT NULL, created REAL NOT NULL, UNIQUE(company_id,email))""",
        """CREATE TABLE IF NOT EXISTS phase_two_invites (
            id TEXT PRIMARY KEY, company_id TEXT NOT NULL, job_id TEXT NOT NULL,
            application_id TEXT NOT NULL, title TEXT NOT NULL, requirements TEXT NOT NULL,
            config_json TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1,
            status TEXT NOT NULL DEFAULT 'pending_platform_review', deadline TEXT NOT NULL DEFAULT '',
            created REAL NOT NULL, updated REAL NOT NULL)"""
    ]
    for statement in statements:
        run(statement)

ensure_company_workspace_schema()


def company_for_access(user):
    require_role(user, "company")
    company = one("SELECT * FROM companies WHERE owner_user_id=?", (user["id"],))
    if company:
        return dict(company)
    member = one("""SELECT c.* FROM companies c JOIN company_members m ON m.company_id=c.id
                    WHERE m.user_id=? AND m.status='active' LIMIT 1""", (user["id"],))
    if not member:
        raise HTTPException(409, "Your account is not connected to an organisation yet")
    return dict(member)


def company_role_for(user, company):
    if company["owner_user_id"] == user["id"]:
        return "owner"
    member = one("SELECT company_role FROM company_members WHERE company_id=? AND user_id=? AND status='active'",
                 (company["id"], user["id"]))
    return member["company_role"] if member else None


def require_company_permission(user, company, *roles):
    role = company_role_for(user, company)
    if role not in roles:
        raise HTTPException(403, "Your organisation role does not allow this action")
    return role


def company_job(company_id, job_id):
    row = one("SELECT * FROM jobs WHERE id=? AND company_id=?", (job_id, company_id))
    if not row:
        raise HTTPException(404, "Job not found")
    return dict(row)


class CompanyVerificationInput(BaseModel):
    legal_name: str = Field(min_length=2, max_length=180)
    country: str = Field(min_length=2, max_length=80)
    business_id: str = Field(default="", max_length=100)
    evidence_note: str = Field(min_length=10, max_length=2000)


class CompanyJobInput(BaseModel):
    title: str = Field(min_length=3, max_length=140)
    description: str = Field(min_length=20, max_length=8000)
    location: str = Field(default="Remote", max_length=120)
    employment_type: str = Field(default="Full-time", max_length=40)
    work_mode: str = Field(default="Remote", max_length=30)
    experience_level: str = Field(default="Any", max_length=40)
    salary_min: Optional[int] = None
    salary_max: Optional[int] = None
    salary_currency: str = Field(default="BDT", max_length=8)
    deadline: str = Field(default="", max_length=30)
    required_skills: List[str] = Field(default_factory=list, max_length=30)
    preferred_skills: List[str] = Field(default_factory=list, max_length=30)
    eligibility: str = Field(default="", max_length=2000)
    hard_requirements: List[str] = Field(default_factory=list, max_length=20)
    match_weights: dict = Field(default_factory=dict)


class CompanyJobStatus(BaseModel):
    status: str
    reason: str = Field(default="", max_length=1000)


class ApplicationStageUpdate(BaseModel):
    stage: str
    reason: str = Field(default="", max_length=1000)


class RecruiterNote(BaseModel):
    body: str = Field(min_length=2, max_length=3000)


class TeamInviteInput(BaseModel):
    email: str = Field(min_length=5, max_length=254)
    role: str


class TeamRoleUpdate(BaseModel):
    role: str


class PhaseTwoInviteInput(BaseModel):
    title: str = Field(min_length=3, max_length=140)
    requirements: str = Field(min_length=10, max_length=5000)
    syllabus: List[str] = Field(default_factory=list, max_length=40)
    question_types: List[str] = Field(default_factory=list, max_length=8)
    duration_minutes: int = Field(default=60, ge=10, le=360)
    difficulty: dict = Field(default_factory=lambda: {"easy": 30, "medium": 50, "hard": 20})
    rubric: List[dict] = Field(default_factory=list, max_length=30)
    deadline: str = Field(default="", max_length=30)
    allowed_resources: List[str] = Field(default_factory=list, max_length=20)
    attempt_count: int = Field(default=1, ge=1, le=3)
    integrity_mode: str = Field(default="light")
    accommodations: str = Field(default="", max_length=1000)
    credit_cost: int = Field(default=0, ge=0, le=10000)


@router.get("/api/company/workspace")
def company_workspace(user=Depends(current_user)):
    company = company_for_access(user)
    role = company_role_for(user, company)
    jobs = allr("SELECT status,COUNT(*) AS n FROM jobs WHERE company_id=? GROUP BY status", (company["id"],))
    apps = allr("""SELECT a.status,COUNT(*) AS n FROM applications a JOIN jobs j ON j.id=a.job_id
                   WHERE j.company_id=? GROUP BY a.status""", (company["id"],))
    verification = one("SELECT status,decision_reason,submitted_at,reviewed_at FROM company_verification WHERE company_id=?",
                       (company["id"],))
    recent = allr("""SELECT a.id AS application_id,a.status,a.created,j.title AS job_title,u.name AS candidate_name
                     FROM applications a JOIN jobs j ON j.id=a.job_id JOIN users u ON u.id=a.candidate_id
                     WHERE j.company_id=? ORDER BY a.created DESC LIMIT 6""", (company["id"],)) if company["verified"] else []
    return {
        "company": {"id": company["id"], "name": company["name"], "website": company["website"] or "",
                    "verified": bool(company["verified"]), "role": role},
        "verification": dict(verification) if verification else {"status": "not_submitted", "decision_reason": ""},
        "jobs": {r["status"]: r["n"] for r in jobs},
        "applications": {r["status"]: r["n"] for r in apps},
        "recent_applications": [dict(r) for r in recent],
        "permissions": {"manage_company": role == "owner", "manage_team": role == "owner",
                        "manage_jobs": role in ("owner", "recruiter"), "manage_pipeline": role in ("owner", "recruiter", "hiring_manager"),
                        "view_reports": role in ("owner", "recruiter", "hiring_manager", "viewer")}
    }


@router.get("/api/company/verification")
def get_company_verification(user=Depends(current_user)):
    company = company_for_access(user)
    row = one("SELECT legal_name,country,business_id,evidence_note,status,decision_reason,submitted_at,reviewed_at FROM company_verification WHERE company_id=?",
              (company["id"],))
    return {"company": {"name": company["name"], "website": company["website"] or "", "verified": bool(company["verified"])},
            "verification": dict(row) if row else {"status": "not_submitted"}}


@router.post("/api/company/verification")
def submit_company_verification(body: CompanyVerificationInput, user=Depends(current_user)):
    company = company_for_access(user)
    require_company_permission(user, company, "owner")
    now = time.time()
    run("""INSERT INTO company_verification(company_id,legal_name,country,business_id,evidence_note,status,decision_reason,submitted_at,reviewed_at,reviewed_by)
           VALUES (?,?,?,?,?,'pending_review','',?,NULL,NULL)
           ON CONFLICT(company_id) DO UPDATE SET legal_name=excluded.legal_name,country=excluded.country,
           business_id=excluded.business_id,evidence_note=excluded.evidence_note,status='pending_review',
           decision_reason='',submitted_at=excluded.submitted_at,reviewed_at=NULL,reviewed_by=NULL""",
        (company["id"], body.legal_name.strip(), body.country.strip(), body.business_id.strip(), body.evidence_note.strip(), now))
    run("UPDATE companies SET verified=0 WHERE id=?", (company["id"],))
    audit(user["id"], "company_verification_submitted", company["id"])
    return {"status": "pending_review", "message": "Verification request submitted for review."}


@router.get("/api/company/jobs")
def company_jobs_v2(user=Depends(current_user)):
    company = company_for_access(user)
    rows = allr("SELECT * FROM jobs WHERE company_id=? ORDER BY created DESC", (company["id"],))
    items = []
    for row in rows:
        item = dict(row)
        item["skills"] = json.loads(item["skills"] or "[]")
        detail = one("SELECT details_json,revision,updated FROM job_details WHERE job_id=?", (item["id"],))
        item["details"] = json.loads(detail["details_json"]) if detail else {}
        item["revision"] = detail["revision"] if detail else 1
        items.append(item)
    return {"items": items}


@router.post("/api/company/jobs")
def create_company_job(body: CompanyJobInput, user=Depends(current_user)):
    company = company_for_access(user)
    require_company_permission(user, company, "owner", "recruiter")
    if body.salary_min is not None and body.salary_max is not None and body.salary_max < body.salary_min:
        raise HTTPException(422, "Salary maximum must be greater than salary minimum")
    jid, now = uuid.uuid4().hex, time.time()
    skills = list(dict.fromkeys([s.strip() for s in body.required_skills + body.preferred_skills if s.strip()]))
    details = body.model_dump()
    run("""INSERT INTO jobs(id,company_id,title,description,location,employment_type,skills,status,is_mock,created)
           VALUES (?,?,?,?,?,?,?,?,?,?)""",
        (jid, company["id"], body.title.strip(), body.description.strip(), body.location.strip(),
         body.employment_type.strip(), json.dumps(skills), "draft", 0, now))
    run("INSERT INTO job_details(job_id,details_json,revision,updated) VALUES (?,?,1,?)", (jid, json.dumps(details), now))
    snapshot = {"title": body.title, "description": body.description, **details, "status": "draft"}
    run("INSERT INTO job_revisions(id,job_id,revision,snapshot_json,actor_id,created) VALUES (?,?,?,?,?,?)",
        (uuid.uuid4().hex, jid, 1, json.dumps(snapshot), user["id"], now))
    audit(user["id"], "company_job_created", jid)
    return {"id": jid, "status": "draft", "revision": 1}


@router.patch("/api/company/jobs/{job_id}")
def update_company_job(job_id: str, body: CompanyJobInput, user=Depends(current_user)):
    company = company_for_access(user)
    require_company_permission(user, company, "owner", "recruiter")
    job = company_job(company["id"], job_id)
    if job["status"] not in ("draft", "needs_changes", "paused"):
        raise HTTPException(409, "Only draft, needs-changes or paused jobs can be edited")
    if body.salary_min is not None and body.salary_max is not None and body.salary_max < body.salary_min:
        raise HTTPException(422, "Salary maximum must be greater than salary minimum")
    now = time.time()
    old = one("SELECT revision FROM job_details WHERE job_id=?", (job_id,))
    revision = (old["revision"] if old else 1) + 1
    skills = list(dict.fromkeys([s.strip() for s in body.required_skills + body.preferred_skills if s.strip()]))
    run("UPDATE jobs SET title=?,description=?,location=?,employment_type=?,skills=? WHERE id=? AND company_id=?",
        (body.title.strip(), body.description.strip(), body.location.strip(), body.employment_type.strip(), json.dumps(skills), job_id, company["id"]))
    run("""INSERT INTO job_details(job_id,details_json,revision,updated) VALUES (?,?,?,?)
           ON CONFLICT(job_id) DO UPDATE SET details_json=excluded.details_json,revision=excluded.revision,updated=excluded.updated""",
        (job_id, json.dumps(body.model_dump()), revision, now))
    snapshot = {"title": body.title, "description": body.description, **body.model_dump(), "status": job["status"]}
    run("INSERT INTO job_revisions(id,job_id,revision,snapshot_json,actor_id,created) VALUES (?,?,?,?,?,?)",
        (uuid.uuid4().hex, job_id, revision, json.dumps(snapshot), user["id"], now))
    audit(user["id"], "company_job_updated", job_id)
    return {"id": job_id, "revision": revision, "status": job["status"]}


@router.post("/api/company/jobs/{job_id}/publish")
def publish_company_job(job_id: str, user=Depends(current_user)):
    company = company_for_access(user)
    require_company_permission(user, company, "owner", "recruiter")
    job = company_job(company["id"], job_id)
    if not company["verified"]:
        raise HTTPException(403, "Company verification is required before a job can be published")
    if job["status"] not in ("draft", "needs_changes", "paused"):
        raise HTTPException(409, "This job cannot be submitted from its current state")
    direct = os.getenv("ALLOW_DIRECT_JOB_PUBLISH", "false").lower() == "true"
    status = "published" if direct else "pending_review"
    run("UPDATE jobs SET status=? WHERE id=? AND company_id=?", (status, job_id, company["id"]))
    audit(user["id"], "company_job_submitted", job_id)
    return {"id": job_id, "status": status, "direct_publish_policy": direct}


@router.post("/api/company/jobs/{job_id}/status")
def change_company_job_status(job_id: str, body: CompanyJobStatus, user=Depends(current_user)):
    company = company_for_access(user)
    require_company_permission(user, company, "owner", "recruiter")
    job = company_job(company["id"], job_id)
    allowed = {"paused", "closed", "draft"}
    if body.status not in allowed:
        raise HTTPException(422, "Status must be paused, closed or draft")
    if body.status == "draft" and job["status"] not in ("paused", "needs_changes"):
        raise HTTPException(409, "Only paused or needs-changes jobs can return to draft")
    run("UPDATE jobs SET status=? WHERE id=? AND company_id=?", (body.status, job_id, company["id"]))
    audit(user["id"], "company_job_status_changed", job_id + ":" + body.status + ":" + body.reason)
    return {"id": job_id, "status": body.status}


@router.get("/api/company/analytics")
def company_analytics(user=Depends(current_user)):
    company = company_for_access(user)
    require_company_permission(user, company, "owner", "recruiter", "hiring_manager", "viewer")
    totals = {
        "jobs": one("SELECT COUNT(*) AS n FROM jobs WHERE company_id=?", (company["id"],))["n"],
        "published_jobs": one("SELECT COUNT(*) AS n FROM jobs WHERE company_id=? AND status='published'", (company["id"],))["n"],
        "applicants": one("""SELECT COUNT(*) AS n FROM applications a JOIN jobs j ON j.id=a.job_id
                             WHERE j.company_id=?""", (company["id"],))["n"],
        "shared_results": one("""SELECT COUNT(*) AS n FROM applications a JOIN jobs j ON j.id=a.job_id
                                 WHERE j.company_id=? AND a.results_shared=1""", (company["id"],))["n"]
    }
    stages = allr("""SELECT a.status,COUNT(*) AS n FROM applications a JOIN jobs j ON j.id=a.job_id
                     WHERE j.company_id=? GROUP BY a.status ORDER BY n DESC""", (company["id"],))
    job_performance = allr("""SELECT j.id,j.title,j.status,COUNT(a.id) AS applicants FROM jobs j
                              LEFT JOIN applications a ON a.job_id=j.id WHERE j.company_id=?
                              GROUP BY j.id,j.title,j.status ORDER BY applicants DESC,j.created DESC""", (company["id"],))
    return {"totals": totals, "stages": [dict(r) for r in stages], "jobs": [dict(r) for r in job_performance]}


@router.get("/api/company/applications/{application_id}")
def company_application_detail(application_id: str, user=Depends(current_user)):
    company = company_for_access(user)
    require_company_permission(user, company, "owner", "recruiter", "hiring_manager", "viewer")
    if not company["verified"]:
        raise HTTPException(403, "Company verification is required before accessing applicant records")
    row = one("""SELECT a.id AS application_id,a.status,a.results_shared,a.created,j.id AS job_id,j.title AS job_title,
                 j.skills AS job_skills,u.id AS candidate_id,u.name AS candidate_name
                 FROM applications a JOIN jobs j ON j.id=a.job_id JOIN users u ON u.id=a.candidate_id
                 WHERE a.id=? AND j.company_id=?""", (application_id, company["id"]))
    if not row:
        raise HTTPException(404, "Application not found")
    item = dict(row)
    item["results_shared"] = bool(item["results_shared"])
    item["required_skills"] = json.loads(item.pop("job_skills") or "[]")
    item["assessment_history"] = []
    if item["results_shared"]:
        attempts = allr("SELECT id,result,finished FROM attempts WHERE user_id=? AND status='done' ORDER BY finished DESC",
                        (item["candidate_id"],))
        for attempt in attempts:
            if not attempt["result"]:
                continue
            result = json.loads(attempt["result"])
            item["assessment_history"].append({
                "attempt_id": attempt["id"], "score": result.get("overall"),
                "scale": "0–100", "finished": attempt["finished"],
                "topics": result.get("topics", {}), "result_status": "prototype",
                "integrity_summary": "No recruiter-facing integrity evidence is available; human review status is not asserted."
            })
    notes = allr("SELECT id,body,author_id,created FROM application_notes WHERE application_id=? AND company_id=? ORDER BY created DESC",
                 (application_id, company["id"]))
    history = allr("SELECT from_stage,to_stage,reason,actor_id,created FROM application_history WHERE application_id=? AND company_id=? ORDER BY created DESC",
                   (application_id, company["id"]))
    item["notes"] = [dict(n) for n in notes]
    item["history"] = [dict(h) for h in history]
    item["profile_visibility"] = "Candidate profile details are not exposed by this prototype unless a dedicated sharing flow is implemented."
    return item


@router.patch("/api/company/applications/{application_id}/stage")
def update_application_stage(application_id: str, body: ApplicationStageUpdate, user=Depends(current_user)):
    company = company_for_access(user)
    require_company_permission(user, company, "owner", "recruiter", "hiring_manager")
    row = one("""SELECT a.status FROM applications a JOIN jobs j ON j.id=a.job_id
                 WHERE a.id=? AND j.company_id=?""", (application_id, company["id"]))
    if not row:
        raise HTTPException(404, "Application not found")
    current = row["status"]
    target = body.stage
    transitions = {
        "submitted": {"preliminary_assessment", "in_review", "withdrawn"},
        "applied": {"preliminary_assessment", "in_review", "withdrawn"},
        "preliminary_assessment": {"in_review", "phase_two_invited", "human_interview", "withdrawn"},
        "in_review": {"preliminary_assessment", "phase_two_invited", "human_interview", "withdrawn"},
        "phase_two_invited": {"human_interview", "further_review", "withdrawn"},
        "further_review": {"human_interview", "withdrawn"},
        "human_interview": {"offer", "rejected", "on_hold"},
        "on_hold": {"human_interview", "rejected"},
        "offer": {"hired", "offer_declined", "offer_withdrawn"},
        "offer_withdrawn": {"human_interview", "closed"},
        "hired": {"closed"}, "rejected": {"closed"},
        "withdrawn": {"closed"}
    }
    if target not in transitions.get(current, set()):
        raise HTTPException(409, "This pipeline transition is not allowed")
    if target in ("rejected", "hired", "offer_declined", "closed") and len(body.reason.strip()) < 3:
        raise HTTPException(422, "A structured human decision reason is required for this stage")
    now = time.time()
    run("UPDATE applications SET status=? WHERE id=?", (target, application_id))
    run("INSERT INTO application_history(id,application_id,company_id,actor_id,from_stage,to_stage,reason,created) VALUES (?,?,?,?,?,?,?,?)",
        (uuid.uuid4().hex, application_id, company["id"], user["id"], current, target, body.reason.strip(), now))
    audit(user["id"], "application_stage_changed", application_id + ":" + current + "->" + target)
    return {"application_id": application_id, "from": current, "stage": target}


@router.post("/api/company/applications/{application_id}/notes")
def add_application_note(application_id: str, body: RecruiterNote, user=Depends(current_user)):
    company = company_for_access(user)
    require_company_permission(user, company, "owner", "recruiter", "hiring_manager")
    if not one("""SELECT a.id FROM applications a JOIN jobs j ON j.id=a.job_id
                  WHERE a.id=? AND j.company_id=?""", (application_id, company["id"])):
        raise HTTPException(404, "Application not found")
    nid = uuid.uuid4().hex
    run("INSERT INTO application_notes(id,application_id,company_id,author_id,body,created) VALUES (?,?,?,?,?,?)",
        (nid, application_id, company["id"], user["id"], body.body.strip(), time.time()))
    audit(user["id"], "recruiter_note_added", application_id)
    return {"id": nid}


@router.get("/api/company/team")
def company_team(user=Depends(current_user)):
    company = company_for_access(user)
    require_company_permission(user, company, "owner", "recruiter", "hiring_manager", "viewer")
    rows = allr("SELECT id,email,company_role,status,created FROM company_members WHERE company_id=? ORDER BY created",
                (company["id"],))
    return {"owner": {"name": one("SELECT name FROM users WHERE id=?", (company["owner_user_id"],))["name"]},
            "role": company_role_for(user, company), "items": [dict(r) for r in rows]}


@router.post("/api/company/team/invitations")
def invite_company_member(body: TeamInviteInput, user=Depends(current_user)):
    company = company_for_access(user)
    require_company_permission(user, company, "owner")
    roles = {"recruiter", "hiring_manager", "viewer"}
    email = body.email.strip().lower()
    if body.role not in roles:
        raise HTTPException(422, "Choose Recruiter, Hiring Manager or Viewer")
    existing = one("SELECT id FROM company_members WHERE company_id=? AND email=?", (company["id"], email))
    if existing:
        raise HTTPException(409, "This email already has a membership or invitation")
    token = secrets.token_urlsafe(24)
    mid = uuid.uuid4().hex
    run("INSERT INTO company_members(id,company_id,user_id,email,company_role,status,invite_token,created) VALUES (?,?,NULL,?,?, 'invited',?,?)",
        (mid, company["id"], email, body.role, token, time.time()))
    audit(user["id"], "company_member_invited", email + ":" + body.role)
    return {"id": mid, "status": "invited", "invite_token": token,
            "delivery": "manual_link", "message": "No email provider is configured; share this invitation token through your approved channel."}


@router.post("/api/company/team/accept/{token}")
def accept_company_invitation(token: str, user=Depends(current_user)):
    require_role(user, "company")
    row = one("SELECT * FROM company_members WHERE invite_token=? AND status='invited'", (token,))
    if not row or row["email"].lower() != user["email"].lower():
        raise HTTPException(404, "Invitation not found for this account")
    run("UPDATE company_members SET user_id=?,status='active',invite_token='' WHERE id=?", (user["id"], row["id"]))
    audit(user["id"], "company_invitation_accepted", row["company_id"])
    return {"status": "active", "company_id": row["company_id"], "role": row["company_role"]}


@router.patch("/api/company/team/{member_id}")
def update_company_member(member_id: str, body: TeamRoleUpdate, user=Depends(current_user)):
    company = company_for_access(user)
    require_company_permission(user, company, "owner")
    row = one("SELECT id FROM company_members WHERE id=? AND company_id=?", (member_id, company["id"]))
    if not row:
        raise HTTPException(404, "Team member not found")
    if body.role not in ("recruiter", "hiring_manager", "viewer", "revoked"):
        raise HTTPException(422, "Unsupported team role")
    if body.role == "revoked":
        run("UPDATE company_members SET status='revoked' WHERE id=?", (member_id,))
    else:
        run("UPDATE company_members SET company_role=? WHERE id=?", (body.role, member_id))
    audit(user["id"], "company_member_permission_changed", member_id + ":" + body.role)
    return {"id": member_id, "role": body.role}


@router.get("/api/company/phase-two")
def list_phase_two(user=Depends(current_user)):
    company = company_for_access(user)
    require_company_permission(user, company, "owner", "recruiter", "hiring_manager", "viewer")
    rows = allr("""SELECT p.*,j.title AS job_title,a.status AS application_status,u.name AS candidate_name
                   FROM phase_two_invites p JOIN jobs j ON j.id=p.job_id
                   JOIN applications a ON a.id=p.application_id JOIN users u ON u.id=a.candidate_id
                   WHERE p.company_id=? ORDER BY p.created DESC""", (company["id"],))
    return {"items": [{**dict(r), "config": json.loads(r["config_json"])} for r in rows]}


@router.post("/api/company/applications/{application_id}/phase-two-invitations")
def create_phase_two_invitation(application_id: str, body: PhaseTwoInviteInput, user=Depends(current_user)):
    company = company_for_access(user)
    require_company_permission(user, company, "owner", "recruiter")
    if not company["verified"]:
        raise HTTPException(403, "Company verification is required before inviting candidates to assessments")
    row = one("""SELECT a.id,a.job_id,a.status FROM applications a JOIN jobs j ON j.id=a.job_id
                 WHERE a.id=? AND j.company_id=?""", (application_id, company["id"]))
    if not row:
        raise HTTPException(404, "Application not found")
    if row["status"] not in ("submitted", "preliminary_assessment", "in_review", "phase_two_invited"):
        raise HTTPException(409, "This application is not eligible for a second phase")
    if body.integrity_mode not in ("light", "standard", "strict"):
        raise HTTPException(422, "Unsupported integrity mode")
    if sum(body.difficulty.values()) != 100 or any(v < 0 for v in body.difficulty.values()):
        raise HTTPException(422, "Difficulty distribution must total 100")
    if not body.syllabus:
        raise HTTPException(422, "Add at least one syllabus topic")
    now, iid = time.time(), uuid.uuid4().hex
    config = body.model_dump()
    run("""INSERT INTO phase_two_invites(id,company_id,job_id,application_id,title,requirements,config_json,version,status,deadline,created,updated)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
        (iid, company["id"], row["job_id"], application_id, body.title.strip(), body.requirements.strip(),
         json.dumps(config), 1, "pending_platform_review", body.deadline, now, now))
    run("UPDATE applications SET status='phase_two_invited' WHERE id=?", (application_id,))
    run("INSERT INTO application_history(id,application_id,company_id,actor_id,from_stage,to_stage,reason,created) VALUES (?,?,?,?,?,?,?,?)",
        (uuid.uuid4().hex, application_id, company["id"], user["id"], row["status"], "phase_two_invited",
         "Second-phase setup submitted for platform review", now))
    audit(user["id"], "phase_two_invitation_requested", iid)
    return {"id": iid, "status": "pending_platform_review",
            "message": "Configuration is saved. Candidate delivery remains pending platform approval and notification integration."}


@router.get("/api/company/jobs/{job_id}/revisions")
def company_job_revisions(job_id: str, user=Depends(current_user)):
    company = company_for_access(user)
    require_company_permission(user, company, "owner", "recruiter", "hiring_manager", "viewer")
    company_job(company["id"], job_id)
    rows = allr("SELECT revision,snapshot_json,actor_id,created FROM job_revisions WHERE job_id=? ORDER BY revision DESC",
                (job_id,))
    return {"items": [{**dict(r), "snapshot": json.loads(r["snapshot_json"])} for r in rows]}


# Platform review endpoints required to complete the company verification/job moderation loop.
class CompanyReviewDecision(BaseModel):
    decision: str
    reason: str = Field(min_length=3, max_length=1500)


@router.get("/api/admin/company-verifications")
def admin_company_verifications(user=Depends(current_user)):
    require_role(user, "admin")
    rows = allr("""SELECT v.company_id,v.legal_name,v.country,v.business_id,v.evidence_note,v.status,
                   v.decision_reason,v.submitted_at,c.name AS company_name,c.website
                   FROM company_verification v JOIN companies c ON c.id=v.company_id
                   ORDER BY v.submitted_at DESC""")
    return {"items": [dict(r) for r in rows]}


@router.post("/api/admin/companies/{company_id}/verification-decision")
def admin_company_verification_decision(company_id: str, body: CompanyReviewDecision, user=Depends(current_user)):
    require_role(user, "admin")
    if body.decision not in ("verified", "needs_information", "rejected"):
        raise HTTPException(422, "Decision must be verified, needs_information or rejected")
    row = one("SELECT company_id FROM company_verification WHERE company_id=?", (company_id,))
    if not row:
        raise HTTPException(404, "Verification request not found")
    now = time.time()
    run("""UPDATE company_verification SET status=?,decision_reason=?,reviewed_at=?,reviewed_by=?
           WHERE company_id=?""", (body.decision, body.reason.strip(), now, user["id"], company_id))
    run("UPDATE companies SET verified=? WHERE id=?", (1 if body.decision == "verified" else 0, company_id))
    audit(user["id"], "company_verification_decision", company_id + ":" + body.decision + ":" + body.reason.strip())
    return {"company_id": company_id, "status": body.decision}


@router.get("/api/admin/job-review-queue")
def admin_job_review_queue(user=Depends(current_user)):
    require_role(user, "admin")
    rows = allr("""SELECT j.id,j.title,j.description,j.location,j.employment_type,j.created,c.name AS company_name,c.id AS company_id
                   FROM jobs j JOIN companies c ON c.id=j.company_id
                   WHERE j.status='pending_review' ORDER BY j.created ASC""")
    return {"items": [dict(r) for r in rows]}


@router.post("/api/admin/jobs/{job_id}/moderation-decision")
def admin_job_moderation_decision(job_id: str, body: CompanyReviewDecision, user=Depends(current_user)):
    require_role(user, "admin")
    if body.decision not in ("published", "needs_changes", "rejected", "paused"):
        raise HTTPException(422, "Unsupported moderation decision")
    row = one("SELECT id FROM jobs WHERE id=?", (job_id,))
    if not row:
        raise HTTPException(404, "Job not found")
    run("UPDATE jobs SET status=? WHERE id=?", (body.decision, job_id))
    audit(user["id"], "job_moderation_decision", job_id + ":" + body.decision + ":" + body.reason.strip())
    return {"job_id": job_id, "status": body.decision}
