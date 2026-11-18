"""Shared agent platform: orchestrator, budget, cache, run log and approval queue.

Additive by design. It never scores, publishes or edits an existing record; the
only writes are to the two new tables created here (`agent_runs`,
`agent_artifacts`) and the existing audit table.
"""
import hashlib
import json
import os
import secrets
import threading
import time

_schema_ready = False
_cache = {}
_cache_lock = threading.Lock()
CACHE_TTL_SECONDS = 600


def _main():
    import main

    return main


def enabled() -> bool:
    return os.getenv("AGENT_PLATFORM_ENABLED", "false").strip().lower() in {"1", "true", "yes", "on"}


def llm_drafts_enabled() -> bool:
    return os.getenv("AGENT_LLM_DRAFTS", "false").strip().lower() in {"1", "true", "yes", "on"}


def ensure_schema() -> None:
    global _schema_ready
    if _schema_ready:
        return
    m = _main()
    m.run(
        """CREATE TABLE IF NOT EXISTS agent_runs (
            id TEXT PRIMARY KEY,
            user_id INTEGER NOT NULL,
            role TEXT NOT NULL,
            agent TEXT NOT NULL,
            intent TEXT NOT NULL,
            status TEXT NOT NULL,
            tool_calls TEXT NOT NULL DEFAULT '[]',
            tokens_in INTEGER NOT NULL DEFAULT 0,
            tokens_out INTEGER NOT NULL DEFAULT 0,
            latency_ms INTEGER NOT NULL DEFAULT 0,
            error TEXT NOT NULL DEFAULT '',
            created_at REAL NOT NULL
        )"""
    )
    m.run(
        """CREATE TABLE IF NOT EXISTS agent_artifacts (
            id TEXT PRIMARY KEY,
            run_id TEXT NOT NULL,
            user_id INTEGER NOT NULL,
            role TEXT NOT NULL,
            kind TEXT NOT NULL,
            title TEXT NOT NULL,
            body TEXT NOT NULL DEFAULT '{}',
            status TEXT NOT NULL DEFAULT 'pending_approval',
            created_at REAL NOT NULL,
            reviewed_by INTEGER,
            reviewed_at REAL
        )"""
    )
    m.run("CREATE INDEX IF NOT EXISTS idx_agent_runs_user ON agent_runs(user_id, created_at)")
    m.run(
        "CREATE INDEX IF NOT EXISTS idx_agent_artifacts_scope "
        "ON agent_artifacts(role, user_id, status, created_at)"
    )
    _schema_ready = True


# --------------------------------------------------------------------------- cache
def cache_get(key):
    with _cache_lock:
        entry = _cache.get(key)
        if not entry:
            return None
        value, expires = entry
        if expires < time.time():
            _cache.pop(key, None)
            return None
        return value


def cache_put(key, value, ttl: int = CACHE_TTL_SECONDS) -> None:
    with _cache_lock:
        _cache[key] = (value, time.time() + ttl)


def cache_key(*parts) -> str:
    raw = json.dumps(parts, sort_keys=True, default=str).encode()
    return hashlib.sha256(raw).hexdigest()


def estimate_tokens(value) -> int:
    text = value if isinstance(value, str) else json.dumps(value, default=str)
    return max(1, len(text) // 4)


# --------------------------------------------------------------------------- budget
class Budget:
    def __init__(self, max_tool_calls: int = 6, max_llm_calls: int = 2, max_seconds: int = 20):
        self.max_tool_calls = max_tool_calls
        self.max_llm_calls = max_llm_calls
        self.deadline = time.monotonic() + max_seconds
        self.tool_calls = 0
        self.llm_calls = 0

    def can_tool(self) -> bool:
        return self.tool_calls < self.max_tool_calls and not self.expired()

    def can_llm(self) -> bool:
        return self.llm_calls < self.max_llm_calls and not self.expired()

    def expired(self) -> bool:
        return time.monotonic() >= self.deadline


def call_tool(ctx, name, fn, *args, **kwargs):
    """Run one tool, enforce the budget and record a PII-free call log."""
    budget = ctx["budget"]
    if not budget.can_tool():
        raise RuntimeError("agent_budget_exhausted")
    started = time.monotonic()
    ok = True
    try:
        return fn(ctx, *args, **kwargs)
    except Exception:
        ok = False
        raise
    finally:
        budget.tool_calls += 1
        ctx["tool_calls"].append(
            {"tool": name, "ok": ok, "ms": int((time.monotonic() - started) * 1000)}
        )


# --------------------------------------------------------------------------- run log
def record_run(*, user_id, role, agent, intent, status, tool_calls, tokens_in=0, tokens_out=0, latency_ms=0, error=""):
    m = _main()
    run_id = "run-" + secrets.token_hex(8)
    m.run(
        """INSERT INTO agent_runs(
            id,user_id,role,agent,intent,status,tool_calls,tokens_in,tokens_out,latency_ms,error,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
        (
            run_id, user_id, role, agent, intent, status, json.dumps(tool_calls),
            int(tokens_in), int(tokens_out), int(latency_ms), str(error)[:500], time.time(),
        ),
    )
    return run_id


def list_runs(user_id: int, limit: int = 20) -> dict:
    ensure_schema()
    rows = _main().allr(
        "SELECT id,role,agent,intent,status,tool_calls,tokens_in,tokens_out,latency_ms,created_at "
        "FROM agent_runs WHERE user_id=? ORDER BY created_at DESC LIMIT ?",
        (user_id, max(1, min(int(limit), 50))),
    )
    items = []
    for row in rows:
        data = dict(row)
        try:
            data["tool_calls"] = json.loads(data.get("tool_calls") or "[]")
        except (TypeError, ValueError):
            data["tool_calls"] = []
        items.append(data)
    return {"items": items, "count": len(items)}


# --------------------------------------------------------------------------- artifacts
def _row_to_artifact(row) -> dict:
    data = dict(row)
    try:
        data["body"] = json.loads(data.get("body") or "{}")
    except (TypeError, ValueError):
        data["body"] = {}
    return data


def create_artifact(*, run_id, user_id, role, kind, title, body) -> dict:
    m = _main()
    artifact_id = "art-" + secrets.token_hex(8)
    m.run(
        """INSERT INTO agent_artifacts(id,run_id,user_id,role,kind,title,body,status,created_at)
        VALUES (?,?,?,?,?,?,?,'pending_approval',?)""",
        (artifact_id, run_id, user_id, role, kind, str(title)[:200], json.dumps(body), time.time()),
    )
    return get_artifact(artifact_id)


def get_artifact(artifact_id: str):
    row = _main().one("SELECT * FROM agent_artifacts WHERE id=?", (artifact_id,))
    return _row_to_artifact(row) if row else None


def list_artifacts(role: str, user_id: int, status: str = "pending_approval", admin: bool = False) -> dict:
    ensure_schema()
    m = _main()
    if admin:
        rows = m.allr(
            "SELECT * FROM agent_artifacts WHERE status=? ORDER BY created_at DESC", (status,)
        )
    else:
        rows = m.allr(
            "SELECT * FROM agent_artifacts WHERE role=? AND user_id=? AND status=? "
            "ORDER BY created_at DESC",
            (role, user_id, status),
        )
    items = [_row_to_artifact(row) for row in rows]
    return {"items": items, "count": len(items)}


def _decide(artifact_id, reviewer, status, *, admin, user_id, action):
    m = _main()
    artifact = get_artifact(artifact_id)
    if not artifact:
        return ("not_found", None)
    if artifact["status"] != "pending_approval":
        return ("conflict", None)
    if not admin and artifact["user_id"] != user_id:
        return ("not_found", None)
    m.run(
        "UPDATE agent_artifacts SET status=?, reviewed_by=?, reviewed_at=? WHERE id=?",
        (status, reviewer.get("id"), time.time(), artifact_id),
    )
    m.audit(reviewer.get("id"), action, artifact_id + ":" + artifact["kind"])
    return ("ok", get_artifact(artifact_id))


def approve_artifact(artifact_id, reviewer, *, admin=False, user_id=None):
    return _decide(artifact_id, reviewer, "approved", admin=admin, user_id=user_id, action="agent_artifact_approved")


def reject_artifact(artifact_id, reviewer, *, admin=False, user_id=None):
    return _decide(artifact_id, reviewer, "rejected", admin=admin, user_id=user_id, action="agent_artifact_rejected")


# --------------------------------------------------------------------------- orchestrator
def run(user, role: str, intent: str, payload: dict) -> dict:
    """Resolve the role's specialist agent, run it under a budget, log the run."""
    import agent_specialists

    ensure_schema()
    started = time.monotonic()
    ctx = {
        "user": user,
        "role": role,
        "budget": Budget(),
        "tool_calls": [],
        "tokens_in": 0,
        "tokens_out": 0,
    }
    agent = agent_specialists.AGENTS.get(role)
    if not agent:
        raise ValueError("unsupported_role")
    status, error = "ok", ""
    try:
        result = agent.run(intent, payload or {}, ctx)
    except Exception as exc:
        result = {"summary": "The agent could not complete this request.", "artifacts": [], "data": {}}
        status, error = "error", type(exc).__name__ + ": " + str(exc)[:300]
    latency = int((time.monotonic() - started) * 1000)
    run_id = record_run(
        user_id=user["id"], role=role, agent=getattr(agent, "NAME", role), intent=intent,
        status=status, tool_calls=ctx["tool_calls"], tokens_in=ctx["tokens_in"],
        tokens_out=ctx["tokens_out"], latency_ms=latency, error=error,
    )
    artifacts = []
    for spec in result.get("artifacts", []):
        artifacts.append(
            create_artifact(
                run_id=run_id, user_id=user["id"], role=role,
                kind=spec["kind"], title=spec.get("title", spec["kind"]), body=spec.get("body", {}),
            )
        )
    return {
        "run_id": run_id,
        "agent": getattr(agent, "NAME", role),
        "role": role,
        "intent": intent,
        "status": status,
        "summary": result.get("summary", ""),
        "data": result.get("data", {}),
        "artifacts": artifacts,
        "tool_calls": ctx["tool_calls"],
        "usage": {
            "tool_calls": len(ctx["tool_calls"]),
            "tokens_in": ctx["tokens_in"],
            "tokens_out": ctx["tokens_out"],
            "latency_ms": latency,
        },
        "advisory": True,
        "note": "Advisory output. Writes are drafts pending human approval; scores are never changed.",
    }
