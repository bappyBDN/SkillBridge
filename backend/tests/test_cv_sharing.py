"""CV storage in the database and its admin/company visibility rules.

Covers the requested behaviour:
* the uploaded CV is stored as a PDF in the database,
* an administrator can open the candidate, the CV and their results,
* a company can open the CV of a candidate who applied to its own job only,
* scores and the Skill Passport stay gated by the candidate's results sharing.
"""
import io
import json
import os
import sys
import tempfile

_TMP = tempfile.mkdtemp(prefix="sb_cvshare_")
os.environ.setdefault("DB_PATH", os.path.join(_TMP, "test.db"))
os.environ.setdefault("PBKDF2_ITERATIONS", "1000")
os.environ["SEED_DEMO"] = "false"
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from fastapi.testclient import TestClient
import pypdf

import main
import pdf as PDF

client = TestClient(main.app)
PASSWORD = "Str0ng-Passw0rd-2026"

CV_TEXT = (
    "Rafi Ahmed\nDhaka, Bangladesh\nrafi.cv@example.com\n\n"
    "Summary: Backend engineer working with Python and PostgreSQL.\n"
    "Skills: Python, SQL, Docker, FastAPI, Git.\n"
    "Projects: Built an inventory API used by three internal teams.\n"
)


def _user(email, name="Rafi Ahmed", role="candidate", verified=True):
    r = client.post("/api/auth/register", json={"email": email, "name": name,
                                               "password": PASSWORD, "role": role})
    assert r.status_code == 200, r.text
    token = r.json().get("token") or client.post(
        "/api/auth/login", json={"email": email, "password": PASSWORD}).json()["token"]
    headers = {"Authorization": "Bearer " + token}
    if role == "candidate":
        assert client.post("/api/consent", json={"lang": "en"}, headers=headers).status_code == 200
    row = main.one("SELECT id FROM users WHERE email=?", (email,))
    return row["id"], headers


def _company(email, name, company_id, verified=1):
    uid, headers = _user(email, name=name, role="company")
    main.run("INSERT INTO companies(id,owner_user_id,name,website,verified,created) VALUES (?,?,?,?,?,?)",
             (company_id, uid, name, "https://example.test", verified, 0))
    return uid, headers


def _admin(email):
    uid, headers = _user(email, name="Admin", role="candidate")
    main.run("UPDATE user_roles SET role='admin' WHERE user_id=?", (uid,))
    main.run("INSERT INTO admin_staff_roles(user_id,admin_role,updated_by,updated_at) VALUES (?,?,?,?) "
             "ON CONFLICT(user_id) DO UPDATE SET admin_role=excluded.admin_role",
             (uid, "super_admin", uid, 0))
    return uid, headers


def test_cv_pdf_reader_works_without_pymupdf():
    """PDF CVs must parse even when the optional PyMuPDF/OCR stack is absent."""
    raw, info = main.read_profile_cv("rafi.pdf", PDF.text_to_pdf(CV_TEXT))
    assert "Rafi Ahmed" in raw
    assert "SQL" in raw
    assert info["parser"] in ("pymupdf", "pypdf")


def test_profile_extract_accepts_a_pdf_upload():
    _, headers = _user("cv-pdf-profile@example.com")
    response = client.post(
        "/api/cv/profile-extract",
        files={"file": ("profile.pdf", PDF.text_to_pdf(CV_TEXT), "application/pdf")},
        headers=headers,
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["profile"]["name"] == "Rafi Ahmed"
    assert body["extraction"]["parser"] in ("pymupdf", "pypdf")


def test_cv_pdf_is_stored_in_the_database_and_served_to_admin_and_company():
    candidate_id, candidate_headers = _user("cv-candidate@example.com")
    upload = client.post(
        "/api/cv",
        files={"file": ("rafi-cv.pdf", PDF.text_to_pdf(CV_TEXT), "application/pdf")},
        headers=candidate_headers,
    )
    assert upload.status_code == 200, upload.text
    document = upload.json()["document"]
    assert document and document["filename"] == "rafi-cv.pdf"

    stored = main.one("SELECT * FROM cv_files WHERE user_id=?", (candidate_id,))
    assert stored is not None, "the PDF must be stored in the database"
    assert bytes(stored["data"]).startswith(b"%PDF-")

    # Candidate can open their own file back.
    own = client.get("/api/cv/file", headers=candidate_headers)
    assert own.status_code == 200 and own.content.startswith(b"%PDF-")

    # A completed attempt + passport for the admin view.
    main.run(
        """INSERT INTO attempts(id,user_id,kind,seed,status,state,started,finished,result,appeal)
           VALUES (?,?,?,?,?,?,?,?,?,NULL)""",
        ("cv-share-attempt", candidate_id, "pre", 1, "done", "{}", 0, 1,
         json.dumps({"overall": 82, "level": "Advanced", "trust": "High trust",
                     "topics": {"python": {"score": 86, "level": "Advanced", "n": 5},
                                "sql": {"score": 78, "level": "Advanced", "n": 5}}})),
    )
    main.run("INSERT INTO passports(id,user_id,payload,signature,created) VALUES (?,?,?,?,?)",
             ("cv-share-passport", candidate_id,
              json.dumps({"issued": "2026-11-15", "expires": "2027-11-15", "holder": "Rafi Ahmed",
                          "skills": [{"skill": "python", "name": "Python", "score": 86}],
                          "uplift": {"pre": 40, "post": 82, "delta": 42}}),
              "sig", 0))

    admin_id, admin_headers = _admin("cv-admin@example.com")
    detail = client.get(f"/api/admin/candidates/{candidate_id}", headers=admin_headers)
    assert detail.status_code == 200, detail.text
    detail = detail.json()
    assert detail["cv"]["has_pdf"] is True
    assert detail["cv"]["documents"][0]["filename"] == "rafi-cv.pdf"
    assert detail["attempts"][0]["overall"] == 82
    assert detail["passports"][0]["pid"] == "cv-share-passport"
    # The CV-derived skills are visible even before the candidate builds a profile.
    assert detail["journey"]["extracted"]

    admin_cv = client.get(detail["cv"]["pdf_url"], headers=admin_headers)
    assert admin_cv.status_code == 200
    assert admin_cv.headers["content-type"].startswith("application/pdf")
    parsed = pypdf.PdfReader(io.BytesIO(admin_cv.content))
    assert "Rafi Ahmed" in (parsed.pages[0].extract_text() or "")

    # Two companies: only the one the candidate applied to may read the CV.
    _, applied_headers = _company("cv-company-a@example.com", "Applied Co", "cv-company-a")
    _, other_headers = _company("cv-company-b@example.com", "Other Co", "cv-company-b")
    main.run("""INSERT INTO jobs(id,company_id,title,description,location,employment_type,skills,status,is_mock,created)
                VALUES (?,?,?,?,?,?,?,?,?,?)""",
             ("cv-job-a", "cv-company-a", "Backend Engineer", "Build APIs", "Remote",
              "Full-time", json.dumps(["Python", "SQL"]), "published", 0, 0))
    main.run("INSERT INTO applications(id,job_id,candidate_id,status,results_shared,created) VALUES (?,?,?,?,?,?)",
             ("cv-app-a", "cv-job-a", candidate_id, "submitted", 0, 0))

    detail_a = client.get("/api/company/applications/cv-app-a", headers=applied_headers)
    assert detail_a.status_code == 200, detail_a.text
    detail_a = detail_a.json()
    assert detail_a["candidate_cv"]["available"] is True
    # Not shared yet: no scores, no passport.
    assert detail_a["results_shared"] is False
    assert detail_a["assessment_history"] == []
    assert detail_a["passport"] is None

    company_cv = client.get("/api/company/applications/cv-app-a/cv", headers=applied_headers)
    assert company_cv.status_code == 200 and company_cv.content.startswith(b"%PDF-")

    # A different company cannot reach this application or its CV.
    assert client.get("/api/company/applications/cv-app-a", headers=other_headers).status_code == 404
    assert client.get("/api/company/applications/cv-app-a/cv", headers=other_headers).status_code == 404

    # Once the candidate shares results, the same company also sees the score and passport.
    main.run("UPDATE applications SET results_shared=1 WHERE id=?", ("cv-app-a",))
    shared = client.get("/api/company/applications/cv-app-a", headers=applied_headers).json()
    assert shared["assessment_history"][0]["score"] == 82
    assert shared["passport"]["pid"] == "cv-share-passport"


def test_admin_candidate_endpoint_requires_admin():
    candidate_id, candidate_headers = _user("cv-plain@example.com")
    assert client.get(f"/api/admin/candidates/{candidate_id}", headers=candidate_headers).status_code == 403
    assert client.get(f"/api/company/applications/nope/cv", headers=candidate_headers).status_code in (403, 409)


def test_deleting_an_account_removes_the_stored_pdf():
    candidate_id, headers = _user("cv-delete@example.com")
    client.post("/api/cv", files={"file": ("cv.pdf", PDF.text_to_pdf(CV_TEXT), "application/pdf")},
                headers=headers)
    assert main.one("SELECT COUNT(*) AS n FROM cv_files WHERE user_id=?", (candidate_id,))["n"] == 1
    assert client.delete("/api/me", headers=headers).status_code == 200
    assert main.one("SELECT COUNT(*) AS n FROM cv_files WHERE user_id=?", (candidate_id,))["n"] == 0
