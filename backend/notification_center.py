"""In-app notification center for every role (candidate, company, admin).

Any backend decision that the other party must learn about calls ``notify``:
application stage changes, phase-two invites, company verification, job
moderation, identity decisions, refunds, assessment publication, appeals.

Contract used by the frontend bell:

  GET  /api/notifications?limit=50   -> {"items": [...], "unread": int}
  POST /api/notifications/read       body {"ids": [...]} or {"all": true}
                                      -> {"ok": true, "unread": int}

Each item: {id, kind, title, body, link, created, read_at}. ``link`` is an
in-app hint such as "applications" or "exams", never an external URL.

Notifications carry no scores before human publication and no integrity
evidence (AGENTS.md); callers pass short, already-public text only.
"""
from __future__ import annotations

import logging
import time
import uuid
from typing import Iterable, List, Optional

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

log = logging.getLogger("skillbridge.notifications")

SCHEMA = [
    """CREATE TABLE IF NOT EXISTS notifications(
        id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, kind TEXT NOT NULL,
        title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', link TEXT NOT NULL DEFAULT '',
        dedupe_key TEXT, created REAL NOT NULL, read_at REAL)""",
    "CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, created)",
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_dedupe ON notifications(user_id, dedupe_key)",
]


def _m():
    import main  # lazy: main imports this module
    return main


def ensure_schema() -> None:
    for statement in SCHEMA:
        _m().run(statement)


def notify(user_id: Optional[int], kind: str, title: str, body: str = "", link: str = "",
           dedupe_key: Optional[str] = None) -> bool:
    """Record one notification. Never raises: a failed notification must not
    roll back the business decision that triggered it. ``dedupe_key`` makes
    the call idempotent per user (a retried request does not notify twice)."""
    if not user_id:
        return False
    try:
        m = _m()
        if dedupe_key and m.one("SELECT 1 AS seen FROM notifications WHERE user_id=? AND dedupe_key=?",
                                (int(user_id), dedupe_key)):
            return False
        m.run("INSERT INTO notifications(id,user_id,kind,title,body,link,dedupe_key,created,read_at) "
              "VALUES (?,?,?,?,?,?,?,?,NULL)",
              (uuid.uuid4().hex, int(user_id), str(kind)[:60], str(title)[:200], str(body)[:1000],
               str(link)[:120], dedupe_key[:200] if dedupe_key else None, time.time()))
        return True
    except Exception as exc:  # pragma: no cover - logged, never propagated
        log.warning("notification %s for user %s not stored: %s", kind, user_id, type(exc).__name__)
        return False


def notify_many(user_ids: Iterable[int], kind: str, title: str, body: str = "", link: str = "",
                dedupe_key: Optional[str] = None) -> int:
    return sum(1 for uid in set(user_ids) if notify(uid, kind, title, body, link, dedupe_key))


def list_for(user_id: int, limit: int = 50) -> dict:
    m = _m()
    limit = max(1, min(int(limit or 50), 200))
    rows = m.allr("SELECT id,kind,title,body,link,created,read_at FROM notifications "
                  "WHERE user_id=? ORDER BY created DESC LIMIT ?", (user_id, limit))
    unread = m.one("SELECT COUNT(*) AS n FROM notifications WHERE user_id=? AND read_at IS NULL", (user_id,))
    return {"items": [dict(r) for r in rows], "unread": int((unread or {"n": 0})["n"])}


def mark_read(user_id: int, ids: Optional[List[str]] = None, all_items: bool = False) -> int:
    m = _m()
    now = time.time()
    if all_items:
        m.run("UPDATE notifications SET read_at=? WHERE user_id=? AND read_at IS NULL", (now, user_id))
    else:
        for nid in (ids or [])[:200]:
            m.run("UPDATE notifications SET read_at=? WHERE id=? AND user_id=? AND read_at IS NULL",
                  (now, str(nid), user_id))
    return list_for(user_id, 1)["unread"]


# ------------------------------------------------------------------ API
class ReadBody(BaseModel):
    ids: List[str] = Field(default_factory=list, max_length=200)
    all: bool = False


def bind(current_user) -> APIRouter:
    """Build the router with main.current_user (main imports this module)."""
    api = APIRouter()

    @api.get("/api/notifications")
    def notifications(limit: int = 50, user=Depends(current_user)):
        return list_for(user["id"], limit)

    @api.post("/api/notifications/read")
    def notifications_read(body: ReadBody, user=Depends(current_user)):
        return {"ok": True, "unread": mark_read(user["id"], body.ids, body.all)}

    return api
