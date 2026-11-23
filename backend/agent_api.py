"""Admin API for the additive agent features (F-A integrity, F-B question assist).

Every endpoint reuses the existing admin scope checks in ``enterprise.py`` and is
disabled unless its feature flag is enabled. Nothing here changes scoring.
"""
import os
from typing import List, Optional

from fastapi import APIRouter, Depends, Header, HTTPException
from pydantic import BaseModel, Field

import agent_integrity as integrity
import agent_questions as questions

router = APIRouter(prefix="/api/admin/agent", tags=["agent"])


def _user(authorization: Optional[str] = Header(None)):
    import main

    return main.current_user(authorization)


def _integrity_admin(user=Depends(_user)):
    import enterprise

    enterprise.admin_only(user, "integrity_review")
    return user


def _questions_admin(user=Depends(_user)):
    import enterprise

    enterprise.admin_only(user, "questions")
    return user


def _flag(name: str) -> bool:
    return os.getenv(name, "false").strip().lower() in {"1", "true", "yes", "on"}


def _require_integrity() -> None:
    if not _flag("AGENT_INTEGRITY_ENABLED"):
        raise HTTPException(503, "agent_disabled")


def _require_questions() -> None:
    if not _flag("AGENT_QUESTIONS_ENABLED"):
        raise HTTPException(503, "agent_disabled")


class DraftBody(BaseModel):
    skill: str = Field(min_length=1, max_length=80)
    count: int = 3
    difficulty: Optional[str] = None


# --------------------------------------------------------------------------- F-A
@router.get("/integrity/{attempt_id}")
def integrity_summary(attempt_id: str, user=Depends(_integrity_admin)):
    """Short, advisory integrity/honesty summary for one attempt."""
    _require_integrity()
    summary = integrity.summarize_attempt(attempt_id)
    if not summary:
        raise HTTPException(404, "attempt_not_found")
    return summary


# --------------------------------------------------------------------------- F-B
@router.get("/question-coverage")
def question_coverage(user=Depends(_questions_admin)):
    """Which taxonomy skills can currently be assessed from the active bank."""
    _require_questions()
    return questions.coverage()


@router.get("/question-coverage/candidate/{user_id}")
def candidate_question_coverage(user_id: int, user=Depends(_questions_admin)):
    """Coverage for one candidate's confirmed CV skills."""
    _require_questions()
    return questions.candidate_coverage(user_id)


@router.post("/questions/draft")
def create_question_drafts(body: DraftBody, user=Depends(_questions_admin)):
    """Draft questions for a skill. Never activates anything."""
    _require_questions()
    return questions.create_drafts(
        body.skill,
        body.count,
        body.difficulty,
        created_by=user.get("name") or "question-assist-agent",
    )


@router.get("/questions/drafts")
def list_question_drafts(status: str = "pending_approval", user=Depends(_questions_admin)):
    """List drafts (default: the pending-approval queue)."""
    _require_questions()
    return questions.list_drafts(status)


@router.post("/questions/drafts/{draft_id}/approve")
def approve_question_draft(draft_id: str, user=Depends(_questions_admin)):
    """Approve one draft into the active question bank (explicit human action)."""
    _require_questions()
    status, question_id, errors = questions.approve_draft(draft_id, user)
    if status == "not_found":
        raise HTTPException(404, "draft_not_found")
    if status == "conflict":
        raise HTTPException(409, "draft_not_pending")
    if status == "invalid":
        raise HTTPException(422, {"errors": errors})
    if status == "duplicate":
        raise HTTPException(409, {"detail": "duplicate_question", "question_id": question_id})
    return {"approved": True, "question_id": question_id}


class DraftEditBody(BaseModel):
    """Fields an administrator may complete on a pending draft (all optional)."""
    question_type: Optional[str] = Field(default=None, max_length=40)
    difficulty_level: Optional[str] = Field(default=None, max_length=20)
    question_text: Optional[str] = Field(default=None, max_length=4000)
    options: Optional[List[str]] = Field(default=None, max_length=10)
    correct_answer: Optional[str] = Field(default=None, max_length=1000)
    explanation: Optional[str] = Field(default=None, max_length=4000)
    reference_answer: Optional[str] = Field(default=None, max_length=4000)
    grading_rubric: Optional[str] = Field(default=None, max_length=4000)
    marks: Optional[float] = Field(default=None, ge=0.5, le=10, allow_inf_nan=False)
    time_allocation: Optional[int] = Field(default=None, ge=30, le=600)
    category_id: Optional[str] = Field(default=None, max_length=40)
    subcategory: Optional[str] = Field(default=None, max_length=80)


@router.patch("/questions/drafts/{draft_id}")
def edit_question_draft(draft_id: str, body: DraftEditBody, user=Depends(_questions_admin)):
    """Complete a pending draft (e.g. a needs_authoring scaffold). Validation is
    recomputed and returned; approval re-validates before anything is active."""
    _require_questions()
    status, draft = questions.update_draft(draft_id, body.model_dump(exclude_none=True), user)
    if status == "not_found":
        raise HTTPException(404, "draft_not_found")
    if status == "conflict":
        raise HTTPException(409, "draft_not_pending")
    return {"draft": draft, "validation": draft["validation"], "approvable": not draft["validation"]}


@router.delete("/questions/drafts/{draft_id}")
def reject_question_draft(draft_id: str, user=Depends(_questions_admin)):
    """Reject a pending draft. The question bank is never touched."""
    _require_questions()
    status, _ = questions.reject_draft(draft_id, user)
    if status == "not_found":
        raise HTTPException(404, "draft_not_found")
    if status == "conflict":
        raise HTTPException(409, "draft_not_pending")
    return {"rejected": True}
