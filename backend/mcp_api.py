"""Read-only REST bridge that mirrors the MCP tools for the in-app console.

The SPA calls these handlers to *show* the exact same read-only tool outputs the
MCP server exposes over stdio and Streamable HTTP. This is a display layer only:
the MCP endpoint at ``/mcp`` remains the real protocol surface.

Every handler is read-only. Candidate handlers reuse ``main.current_user`` so the
bridge inherits the existing session, role and MFA policy.
"""
from __future__ import annotations

import os
from typing import Optional

from fastapi import APIRouter, Depends, Header, HTTPException
from pydantic import BaseModel, Field

import mcp_tools as T

router = APIRouter(prefix="/api/mcp", tags=["mcp"])

TOOL_CATALOG = [
    {
        "name": "verify_passport",
        "surface": "verification",
        "auth": "public",
        "description": "Re-verify a Skill Passport's HMAC signature, revocation and skills.",
    },
    {
        "name": "lookup_skill",
        "surface": "verification",
        "auth": "public",
        "description": "Resolve a free-text skill term to canonical taxonomy ids.",
    },
    {
        "name": "my_weak_topics",
        "surface": "candidate_learning",
        "auth": "signed-in",
        "description": "Weak or unverified topics from the candidate's latest result.",
    },
    {
        "name": "practice_questions",
        "surface": "candidate_learning",
        "auth": "signed-in",
        "description": "Approved practice questions for a topic (answers withheld).",
    },
    {
        "name": "learning_path",
        "surface": "candidate_learning",
        "auth": "signed-in",
        "description": "Curated learning path derived from the latest approved result.",
    },
]


def mcp_enabled() -> bool:
    return os.getenv("MCP_ENABLED", "false").strip().lower() in {"1", "true", "yes", "on"}


def _require_enabled() -> None:
    if not mcp_enabled():
        raise HTTPException(503, "mcp_disabled")


def _user(authorization: Optional[str] = Header(None)):
    import main

    return main.current_user(authorization)


class VerifyBody(BaseModel):
    passport_id: str = Field(default="", max_length=200)


class PracticeBody(BaseModel):
    topic: str = Field(min_length=1, max_length=80)
    count: int = 5


@router.get("/status")
def status() -> dict:
    """Availability and the tool catalogue. Safe to call without sign-in."""
    return {
        "enabled": mcp_enabled(),
        "server": "skillbridge",
        "read_only": True,
        "transports": {
            "stdio": "python -m mcp_server",
            "http": os.getenv("MCP_HTTP_PATH", "/mcp"),
        },
        "surfaces": [
            {
                "id": "verification",
                "label": "Verification (public)",
                "tools": ["verify_passport", "lookup_skill"],
            },
            {
                "id": "candidate_learning",
                "label": "Candidate learning (signed in)",
                "tools": ["my_weak_topics", "practice_questions", "learning_path"],
            },
        ],
        "tools": TOOL_CATALOG,
    }


@router.post("/verify")
def verify(body: VerifyBody) -> dict:
    """Public verification — mirrors the verify_passport MCP tool."""
    _require_enabled()
    return T.verify_passport(body.passport_id)


@router.get("/lookup")
def lookup(term: str = "") -> dict:
    """Mirror of the lookup_skill MCP tool."""
    _require_enabled()
    return T.lookup_skill(term)


@router.get("/learning")
def learning(u=Depends(_user)) -> dict:
    """Mirror of my_weak_topics + learning_path for the signed-in candidate."""
    _require_enabled()
    return {
        "weak_topics": T.my_weak_topics(u["id"]),
        "learning_path": T.learning_path(u["id"]),
    }


@router.post("/practice")
def practice(body: PracticeBody, u=Depends(_user)) -> dict:
    """Mirror of practice_questions for the signed-in candidate."""
    _require_enabled()
    return T.practice_questions(u["id"], body.topic, body.count)
