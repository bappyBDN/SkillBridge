"""`/api/agent/*` — one entry point for the role-scoped copilots.

Additive. Every write is a draft in the approval queue; scores and existing
records are never changed. Disabled unless ``AGENT_PLATFORM_ENABLED`` is on.

Authorization reuses ``enterprise``: ``require_role`` (which applies the
production MFA gate), the scoped admin staff check (``admin_only``) per admin
intent, the per-feature flags honoured by ``agent_api`` and, for company
intents, company verification plus organisation-role permission.
"""
import os
from typing import Optional

from fastapi import APIRouter, Depends, Header, HTTPException
from pydantic import BaseModel, Field

import agent_platform
import agent_specialists

router = APIRouter(prefix="/api/agent", tags=["agent"])

# Admin intents -> (admin staff scope, feature flag) — same pairs as agent_api.
ADMIN_INTENT_RULES = {
    "question_coverage": ("questions", "AGENT_QUESTIONS_ENABLED"),
    "question_draft": ("questions", "AGENT_QUESTIONS_ENABLED"),
    "integrity_summary": ("integrity_review", "AGENT_INTEGRITY_ENABLED"),
}
# Company intents -> organisation roles allowed (company must be verified for
# any intent that reads applicant records).
COMPANY_INTENT_RULES = {
    "job_skills": (("owner", "recruiter"), False),
    "shortlist": (("owner", "recruiter", "hiring_manager"), True),
    "feedback_draft": (("owner", "recruiter", "hiring_manager"), True),
    "evidence_summary": (("owner", "recruiter", "hiring_manager"), True),
}
# Approving these artifact kinds performs a real, validated domain action.
QUESTION_ARTIFACT_KIND = "question_drafts"


def _user(authorization: Optional[str] = Header(None)):
    import main

    return main.current_user(authorization)


def _flag(name: str) -> bool:
    return os.getenv(name, "false").strip().lower() in {"1", "true", "yes", "on"}


def _role(user) -> str:
    """Account role through enterprise.require_role, so privileged roles are
    subject to the production MFA gate before any agent access."""
    import enterprise

    role = enterprise.role_of(user)
    enterprise.require_role(user, role)
    return role


def _require_enabled() -> None:
    if not agent_platform.enabled():
        raise HTTPException(503, "agent_disabled")


def authorize_intent(user, role: str, intent: str) -> None:
    """Raise HTTPException unless ``user`` may run ``intent`` right now."""
    import enterprise

    if intent not in agent_specialists.intents_for(role):
        raise HTTPException(422, "unsupported_intent_for_role")
    if role == "admin":
        scope, flag = ADMIN_INTENT_RULES[intent]
        enterprise.admin_only(user, scope)
        if not _flag(flag):
            raise HTTPException(503, "agent_disabled")
    elif role == "company":
        roles, needs_verified = COMPANY_INTENT_RULES[intent]
        company = enterprise.company_for_access(user)
        enterprise.require_company_permission(user, company, *roles)
        if needs_verified and not company.get("verified"):
            raise HTTPException(403, "Company verification is required before accessing applicant records")


def _allowed_intents(user, role: str) -> list:
    allowed = []
    for intent in agent_specialists.intents_for(role):
        try:
            authorize_intent(user, role, intent)
        except HTTPException:
            continue
        allowed.append(intent)
    return allowed


class RunBody(BaseModel):
    intent: str = Field(min_length=1, max_length=60)
    payload: dict = Field(default_factory=dict)


@router.get("/status")
def status(user=Depends(_user)) -> dict:
    """Role, the intents this account may run, and feature flags."""
    role = _role(user)
    try:
        import ai_routing

        ai_budget = ai_routing.budget_status()
    except Exception:
        ai_budget = None
    return {
        "enabled": agent_platform.enabled(),
        "llm_drafts": agent_platform.llm_drafts_enabled(),
        "role": role,
        "intents": _allowed_intents(user, role),
        "agents": {
            "candidate": agent_specialists.CandidateAgent.INTENTS,
            "company": agent_specialists.CompanyAgent.INTENTS,
            "admin": agent_specialists.AdminAgent.INTENTS,
        },
        "budget": {"max_tool_calls": 6, "max_llm_calls": 2, "max_seconds": 20},
        "ai_budget": ai_budget,
        "advisory": True,
        "note": "Read-only or draft-only. No tool changes a score or publishes content.",
    }


@router.post("/run")
def run(body: RunBody, user=Depends(_user)) -> dict:
    _require_enabled()
    role = _role(user)
    authorize_intent(user, role, body.intent)
    return agent_platform.run(user, role, body.intent, body.payload)


@router.get("/runs")
def runs(limit: int = 20, user=Depends(_user)) -> dict:
    _require_enabled()
    _role(user)
    return agent_platform.list_runs(user["id"], limit)


@router.get("/artifacts")
def artifacts(status: str = "pending_approval", user=Depends(_user)) -> dict:
    _require_enabled()
    allowed = {"pending_approval", "approved", "rejected"}
    if status not in allowed:
        raise HTTPException(422, "invalid_status")
    return agent_platform.list_artifacts(_role(user), user["id"], status, admin=False)


def _approve_question_drafts(artifact, user) -> dict:
    """Approving a question-draft artifact runs the real approve_draft path for
    every draft it lists, so validation is always enforced."""
    import agent_questions
    import enterprise

    enterprise.admin_only(user, "questions")
    if not _flag("AGENT_QUESTIONS_ENABLED"):
        raise HTTPException(503, "agent_disabled")
    results, failed = [], False
    for draft in (artifact.get("body") or {}).get("drafts") or []:
        draft_id = str(draft.get("id") or "")
        status, question_id, errors = agent_questions.approve_draft(draft_id, user)
        if status == "conflict":
            current = agent_questions.get_draft(draft_id) or {}
            status = "already_" + str(current.get("status") or "decided")
        if status in ("invalid", "duplicate", "not_found"):
            failed = True
        results.append({"draft_id": draft_id, "status": status, "question_id": question_id, "errors": errors})
    if failed:
        raise HTTPException(422, {
            "detail": "question_drafts_invalid",
            "message": "Complete the listed drafts (PATCH /api/admin/agent/questions/drafts/{id}) and approve again.",
            "results": results,
        })
    return {"question_results": results}


@router.post("/artifacts/{artifact_id}/approve")
def approve(artifact_id: str, user=Depends(_user)) -> dict:
    _require_enabled()
    role = _role(user)
    current = agent_platform.get_artifact(artifact_id)
    if not current or current["user_id"] != user["id"] or current["role"] != role:
        raise HTTPException(404, "artifact_not_found")
    if current["status"] != "pending_approval":
        raise HTTPException(409, "artifact_not_pending")
    extra = {}
    if current["kind"] == QUESTION_ARTIFACT_KIND:
        extra = _approve_question_drafts(current, user)
    result, artifact = agent_platform.approve_artifact(
        artifact_id, user, admin=False, user_id=user["id"]
    )
    if result == "not_found":
        raise HTTPException(404, "artifact_not_found")
    if result == "conflict":
        raise HTTPException(409, "artifact_not_pending")
    return {"approved": True, "artifact": artifact, **extra}


@router.delete("/artifacts/{artifact_id}")
def reject(artifact_id: str, user=Depends(_user)) -> dict:
    _require_enabled()
    _role(user)
    result, artifact = agent_platform.reject_artifact(
        artifact_id, user, admin=False, user_id=user["id"]
    )
    if result == "not_found":
        raise HTTPException(404, "artifact_not_found")
    if result == "conflict":
        raise HTTPException(409, "artifact_not_pending")
    return {"rejected": True, "artifact": artifact}
