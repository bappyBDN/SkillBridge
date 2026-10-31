"""Initial hiring workflow APIs for SkillBridge PRD."""
import json, time, uuid
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
    if not company: raise HTTPException(409, "Create your company profile first")
    return dict(company)

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
    if current: run("UPDATE companies SET name=?,website=? WHERE owner_user_id=?",(body.name.strip(),body.website,user["id"]))
    else: run("INSERT INTO companies(id,owner_user_id,name,website,verified,created) VALUES (?,?,?,?,?,?)",(uuid.uuid4().hex,user["id"],body.name.strip(),body.website,0,time.time()))
    audit(user["id"],"company_profile_saved",body.name.strip())
    return {"ok":True,"company":dict(one("SELECT id,name,website,verified FROM companies WHERE owner_user_id=?",(user["id"],)))}

@router.post("/api/jobs")
def create_job(body:JobCreate,user=Depends(current_user)):
    require_role(user,"company"); company=company_for(user); jid=uuid.uuid4().hex
    skills=list(dict.fromkeys(s.strip() for s in body.skills if s.strip()))
    run("INSERT INTO jobs(id,company_id,title,description,location,employment_type,skills,status,is_mock,created) VALUES (?,?,?,?,?,?,?,?,?,?)",
        (jid,company["id"],body.title.strip(),body.description.strip(),body.location.strip(),body.employment_type.strip(),json.dumps(skills),"published" if body.publish else "draft",0,time.time()))
    audit(user["id"],"job_created",jid)
    return {"id":jid,"status":"published" if body.publish else "draft"}

@router.get("/api/company/jobs")
def company_jobs(user=Depends(current_user)):
    require_role(user,"company"); company=company_for(user)
    rows=allr("SELECT * FROM jobs WHERE company_id=? ORDER BY created DESC",(company["id"],))
    return {"items":[{**dict(r),"skills":json.loads(r["skills"]),"is_mock":bool(r["is_mock"])} for r in rows]}

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
