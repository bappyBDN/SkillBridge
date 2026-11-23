"""`/api/agent/*` — one entry point for the role-scoped copilots.

Additive. Every write is a draft in the approval queue; scores and existing
records are never changed. Disabled unless ``AGENT_PLATFORM_ENABLED`` is on.
"""
from typing import Optional

from fastapi import APIRouter, Depends, Header, HTTPException
from pydantic import BaseModel, Field

import agent_platform
import agent_specialists

router = APIRouter(prefix="/api/agent", tags=["agent"])


def _user(authorization: Optional[str] = Header(None)):
    import main

    return main.current_user(authorization)


def _role(user) -> str:
    import main

    row = main.one("SELECT role FROM user_roles WHERE user_id=?", (user["id"],))
    return row["role"] if row else "candidate"


def _require_enabled() -> None:
    if not agent_platform.enabled():
        raise HTTPException(503, "agent_disabled")


class RunBody(BaseModel):
    intent: str = Field(min_length=1, max_length=60)
    payload: dict = Field(default_factory=dict)


@router.get("/status")
def status(user=Depends(_user)) -> dict:
    """Role, available intents and feature flags (safe to call while disabled)."""
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
        "intents": agent_specialists.intents_for(role),
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
    if body.intent not in agent_specialists.intents_for(role):
        raise HTTPException(422, "unsupported_intent_for_role")
    return agent_platform.run(user, role, body.intent, body.payload)


@router.get("/runs")
def runs(limit: int = 20, user=Depends(_user)) -> dict:
    _require_enabled()
    return agent_platform.list_runs(user["id"], limit)


@router.get("/artifacts")
def artifacts(status: str = "pending_approval", user=Depends(_user)) -> dict:
    _require_enabled()
    allowed = {"pending_approval", "approved", "rejected"}
    if status not in allowed:
        raise HTTPException(422, "invalid_status")
    return agent_platform.list_artifacts(_role(user), user["id"], status, admin=False)


@router.post("/artifacts/{artifact_id}/approve")
def approve(artifact_id: str, user=Depends(_user)) -> dict:
    _require_enabled()
    result, artifact = agent_platform.approve_artifact(
        artifact_id, user, admin=False, user_id=user["id"]
    )
    if result == "not_found":
        raise HTTPException(404, "artifact_not_found")
    if result == "conflict":
        raise HTTPException(409, "artifact_not_pending")
    return {"approved": True, "artifact": artifact}


@router.delete("/artifacts/{artifact_id}")
def reject(artifact_id: str, user=Depends(_user)) -> dict:
    _require_enabled()
    result, artifact = agent_platform.reject_artifact(
        artifact_id, user, admin=False, user_id=user["id"]
    )
    if result == "not_found":
        raise HTTPException(404, "artifact_not_found")
    if result == "conflict":
        raise HTTPException(409, "artifact_not_pending")
    return {"rejected": True, "artifact": artifact}
