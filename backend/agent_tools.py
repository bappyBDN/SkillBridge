"""Role-scoped read and draft tools used by the agent specialists.

Read tools never mutate. Draft tools return artifact specs that the orchestrator
stores in the approval queue — they never touch scores, jobs or the question
bank. Tool signatures are LangChain-`StructuredTool`-shaped for future adapters.
"""
import json

import agent_platform


def _main():
    import main

    return main


def _user(ctx):
    return ctx["user"]


def _require_role(ctx, *roles):
    """Role check through enterprise.require_role (applies the production MFA
    gate) — never a direct user_roles read."""
    import enterprise

    if ctx["role"] not in roles:
        raise RuntimeError("role_not_allowed")
    enterprise.require_role(_user(ctx), *roles)


def _flag(name):
    import os

    return os.getenv(name, "false").strip().lower() in {"1", "true", "yes", "on"}


def _require_admin_scope(ctx, scope, flag):
    """Same scoped staff check and feature flag as the admin agent API."""
    import enterprise

    _require_role(ctx, "admin")
    enterprise.admin_only(_user(ctx), scope)
    if not _flag(flag):
        raise RuntimeError("agent_disabled")


def _company_for_applicants(ctx):
    """Verified company + owner/recruiter/hiring_manager before any applicant read."""
    import enterprise

    _require_role(ctx, "company")
    company = enterprise.company_for_access(_user(ctx))
    enterprise.require_company_permission(_user(ctx), company, "owner", "recruiter", "hiring_manager")
    if not company.get("verified"):
        raise RuntimeError("company_verification_required")
    return company


def _llm_polish(ctx, system, payload, max_tokens=400):
    """Optional one-call prose polish. Deterministic output remains the source."""
    if not agent_platform.llm_drafts_enabled() or not ctx["budget"].can_llm():
        return None
    try:
        import agent_llm

        ctx["budget"].llm_calls += 1
        ctx["tokens_in"] += agent_platform.estimate_tokens(payload)
        result = agent_llm.complete_json(system, payload, max_tokens=max_tokens)
        data = result.get("data") or {}
        ctx["tokens_out"] += agent_platform.estimate_tokens(data)
        return data
    except Exception:
        return None


# --------------------------------------------------------------------------- read tools
def profile(ctx):
    _require_role(ctx, "candidate")
    m = _main()
    user = _user(ctx)
    row = m.one("SELECT * FROM candidate_profiles WHERE user_id=?", (user["id"],))
    prof = dict(row) if row else {}
    for key in ("skills", "experience", "projects", "education", "certifications"):
        if isinstance(prof.get(key), str):
            try:
                prof[key] = json.loads(prof[key])
            except (TypeError, ValueError):
                prof[key] = []
    conf = m.one("SELECT confirmed FROM profiles WHERE user_id=?", (user["id"],))
    confirmed = []
    if conf and conf["confirmed"]:
        try:
            confirmed = json.loads(conf["confirmed"])
        except (TypeError, ValueError):
            confirmed = []
    return {"name": user.get("name", ""), "profile": prof, "confirmed_skills": confirmed}


def learning_context(ctx):
    _require_role(ctx, "candidate")
    import mcp_tools as T

    uid = _user(ctx)["id"]
    return {"weak_topics": T.my_weak_topics(uid), "learning_path": T.learning_path(uid)}


def practice_questions(ctx, topic, count=5):
    _require_role(ctx, "candidate")
    import mcp_tools as T

    return T.practice_questions(_user(ctx)["id"], topic, count)


def jobs(ctx, query="", limit=10):
    _require_role(ctx, "candidate")
    m = _main()
    rows = m.allr(
        "SELECT id,title,description,location,employment_type,skills,is_mock "
        "FROM jobs WHERE status='published' ORDER BY created DESC LIMIT ?",
        (max(1, min(int(limit), 20)),),
    )
    items = []
    for row in rows:
        data = dict(row)
        try:
            data["skills"] = json.loads(data.get("skills") or "[]")
        except (TypeError, ValueError):
            data["skills"] = []
        items.append(data)
    if query:
        needle = query.lower()
        items = [i for i in items if needle in (i["title"] + " " + i["description"]).lower()]
    return {"items": items, "count": len(items)}


def application_context(ctx, job_id):
    _require_role(ctx, "candidate")
    m = _main()
    job = m.one(
        "SELECT id,title,description,location,employment_type,skills,is_mock "
        "FROM jobs WHERE id=? AND status='published'",
        (job_id,),
    )
    if not job:
        raise RuntimeError("job_not_found")
    data = dict(job)
    try:
        data["skills"] = json.loads(data.get("skills") or "[]")
    except (TypeError, ValueError):
        data["skills"] = []
    return {"job": data, "profile": profile(ctx)}


def company_context(ctx):
    _require_role(ctx, "company")
    import enterprise

    return enterprise.company_for_access(_user(ctx))


def company_applications(ctx, shared_only=True):
    m = _main()
    company = _company_for_applicants(ctx)
    rows = m.allr(
        """SELECT a.id AS application_id,a.status,a.results_shared,a.created,
                  j.id AS job_id,j.title AS job_title,u.id AS candidate_id,u.name AS candidate_name
           FROM applications a
           JOIN jobs j ON j.id=a.job_id
           JOIN users u ON u.id=a.candidate_id
           WHERE j.company_id=? ORDER BY a.created DESC""",
        (company["id"],),
    )
    items = []
    for row in rows:
        item = dict(row)
        item["results_shared"] = bool(item["results_shared"])
        if shared_only and not item["results_shared"]:
            continue
        items.append(item)
    return {
        "company": {"id": company["id"], "name": company.get("name", "")},
        "items": items,
        "count": len(items),
    }


def skill_coverage(ctx):
    _require_admin_scope(ctx, "questions", "AGENT_QUESTIONS_ENABLED")
    import agent_questions

    return agent_questions.coverage()


def integrity_summary(ctx, attempt_id):
    _require_admin_scope(ctx, "integrity_review", "AGENT_INTEGRITY_ENABLED")
    import agent_integrity

    return agent_integrity.summarize_attempt(attempt_id)


def question_drafts(ctx):
    _require_admin_scope(ctx, "questions", "AGENT_QUESTIONS_ENABLED")
    import agent_questions

    return agent_questions.list_drafts("pending_approval")


# --------------------------------------------------------------------------- draft tools
def draft_study_plan(ctx):
    _require_role(ctx, "candidate")
    context = learning_context(ctx)
    weak = context["weak_topics"]
    path = context["learning_path"]
    topics = weak.get("weak_topics") or []
    weeks = []
    for index, topic in enumerate(topics[:4], 1):
        weeks.append(
            {
                "week": index,
                "focus": topic.get("name") or topic.get("skill"),
                "status": topic.get("status"),
                "target": f"Reach {topic.get('threshold')}% on {topic.get('name')}",
            }
        )
    if not weeks:
        weeks = [
            {
                "week": 1,
                "focus": "Keep verified skills sharp",
                "status": "verified",
                "target": "Practise a weak topic, then re-test to raise it.",
            }
        ]
    return {
        "kind": "study_plan",
        "title": "Week-by-week study plan",
        "body": {
            "weeks": weeks,
            "resources": (path.get("items") or [])[:8],
            "based_on_attempt": weak.get("based_on_attempt"),
            "note": "Advisory plan built from your stored result and the curated catalogue.",
        },
    }


def draft_gap_explainer(ctx):
    _require_role(ctx, "candidate")
    data = learning_context(ctx)
    weak = data["weak_topics"]
    topics = weak.get("topics") or {}
    verified = [
        {"skill": key, **(value if isinstance(value, dict) else {})}
        for key, value in topics.items()
        if isinstance(value, dict) and (value.get("score") or 0) >= 60
    ]
    pending = weak.get("weak_topics") or []
    return {
        "kind": "gap_explain",
        "title": "Verified vs unverified skills",
        "body": {
            "verified": verified,
            "needs_work": pending,
            "fastest_path": [
                f"Practise {t.get('name')} then re-test to lift it above {t.get('threshold')}%."
                for t in pending[:4]
            ],
            "note": "Verified skills come only from approved assessment questions.",
        },
    }


def draft_application_answer(ctx, job_id):
    _require_role(ctx, "candidate")
    data = application_context(ctx, job_id)
    job = data["job"]
    confirmed = data["profile"].get("confirmed_skills") or []
    skills_text = ", ".join(confirmed[:8]) or "the skills in my profile"
    body = {
        "job_id": job["id"],
        "job_title": job["title"],
        "cover_note": (
            f"I am applying for {job['title']}. My verified skills include {skills_text}. "
            "I would welcome the chance to show how they fit this role."
        ),
        "verified_skills": confirmed,
        "note": "Draft only. Review and edit before sending; nothing is sent automatically.",
    }
    polished = _llm_polish(
        ctx,
        "You draft a short, honest cover note using only the provided verified skills. "
        "Never invent experience. Return JSON {\"cover_note\":\"...\"}.",
        {"job": job["title"], "verified_skills": confirmed},
    )
    if polished and isinstance(polished.get("cover_note"), str):
        body["cover_note"] = polished["cover_note"][:2000]
    return {"kind": "application_answer", "title": f"Application draft — {job['title']}", "body": body}


def draft_job_skills(ctx, description):
    import enterprise
    import graphrag as G

    _require_role(ctx, "company")
    company = enterprise.company_for_access(_user(ctx))
    enterprise.require_company_permission(_user(ctx), company, "owner", "recruiter")
    from content import TAXONOMY

    ids = G.canonical_skill_ids(description or "")
    if not ids:
        text = (description or "").lower()
        ids = [
            skill_id
            for skill_id, meta in TAXONOMY.items()
            if any(alias in text for alias in meta.get("aliases", []))
        ]
    skills = [
        {"id": skill_id, "name": TAXONOMY.get(skill_id, {}).get("name", skill_id)}
        for skill_id in dict.fromkeys(ids)
    ]
    return {
        "kind": "job_skills",
        "title": "Job → skills draft",
        "body": {
            "skills": skills,
            "suggested_thresholds": {item["id"]: 60 for item in skills},
            "assessment": {
                "sections": ["fundamentals", "cv_skills"],
                "note": "Draft assessment config; a human publishes it.",
            },
            "note": "Mapped from the JD to the closed taxonomy. Review before use.",
        },
    }


def draft_shortlist(ctx):
    import enterprise

    apps = company_applications(ctx, shared_only=True)
    shortlist = []
    for item in apps["items"][:50]:
        # Same published-only, trust-free summary the recruiter UI uses: scores
        # stay hidden until human review publishes them.
        summary = enterprise.company_assessment_summary(item["candidate_id"])
        if not summary:
            continue
        shortlist.append(
            {
                "candidate_id": item["candidate_id"],
                "application_id": item["application_id"],
                "job_title": item["job_title"],
                "overall": summary["overall"],
                "level": summary["level"],
                "result_status": summary["result_status"],
                "topics": {key: value.get("score") for key, value in summary["topics"].items()},
                "consent": True,
            }
        )
    return {
        "kind": "shortlist",
        "title": "Consent-gated shortlist",
        "body": {
            "shortlist": shortlist,
            "note": (
                "Only applicants who opted into result sharing. Scores appear only after "
                "human review publishes them; they are advisory and no candidate is auto-rejected."
            ),
        },
    }


def draft_feedback(ctx, application_id):
    apps = company_applications(ctx, shared_only=False)
    item = next((a for a in apps["items"] if a["application_id"] == application_id), None)
    if not item:
        raise RuntimeError("application_not_found")
    body = {
        "application_id": application_id,
        "candidate": item["candidate_name"],
        "job_title": item["job_title"],
        "feedback": (
            "Thank you for applying. Your verified skills were reviewed against the role "
            "requirements. [Add specific, evidence-based feedback here.]"
        ),
        "note": "Draft only. A human must review and send; there is no automated outreach.",
    }
    polished = _llm_polish(
        ctx,
        "Draft neutral, specific, non-discriminatory candidate feedback using only the "
        "provided facts. Never infer emotion, personality or identity. "
        "Return JSON {\"feedback\":\"...\"}.",
        {"job": item["job_title"], "status": item["status"]},
    )
    if polished and isinstance(polished.get("feedback"), str):
        body["feedback"] = polished["feedback"][:2000]
    return {
        "kind": "feedback",
        "title": f"Feedback draft — {item['candidate_name']}",
        "body": body,
    }


def draft_integrity_summary(ctx, attempt_id):
    summary = integrity_summary(ctx, attempt_id)
    if not summary:
        raise RuntimeError("attempt_not_found")
    return {
        "kind": "integrity_summary",
        "title": f"Integrity summary — {attempt_id}",
        "body": summary,
    }


def draft_questions(ctx, skill, count=3):
    _require_admin_scope(ctx, "questions", "AGENT_QUESTIONS_ENABLED")
    import agent_questions

    result = agent_questions.create_drafts(
        skill, count, created_by=_user(ctx).get("name") or "question-assist-agent"
    )
    return {
        "kind": "question_drafts",
        "title": f"Question drafts — {result['label']}",
        "body": {
            "skill": result["label"],
            "created": result["created"],
            "drafts": [
                {
                    "id": draft["id"],
                    "question_text": draft["question_text"],
                    "status": draft["status"],
                    "validation": draft["validation"],
                }
                for draft in result["drafts"]
            ],
            "note": (
                "Question drafts live in the question-assist queue. Complete any draft "
                "marked needs_authoring (PATCH /api/admin/agent/questions/drafts/{id}); "
                "approving this artifact approves every listed draft through the same "
                "validated path."
            ),
        },
    }
