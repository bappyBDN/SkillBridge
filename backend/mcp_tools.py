"""Read-only tool implementations shared by the MCP server and the in-app console.

Design rules (see AGENTS.md and docs/MCP_ROADMAP.md):
- Tools are read-only. The only write is one audit row per authenticated
  candidate tool call (``authorize_call``); scores and content never change.
- ``main`` is imported lazily inside functions (invariant 9) so importing this
  module never creates a circular import.
- Question payloads are produced by :func:`graphrag.question_page`, which only
  whitelists public fields. Answer and reference-answer columns are never
  returned, so the "no answer/ref" contract holds by construction.
"""
import hashlib
import os
import threading
import time
from typing import Any

ANSWER_FIELDS = {"answer", "correct_answer", "reference_answer", "ref", "explanation", "grading_rubric"}


def _main():
    import main  # lazy: avoid a module-level circular import
    return main


# --------------------------------------------------------------------------- helpers
def _normalize_passport_id(value: str) -> str:
    """Accept a bare passport id or a share link such as ``https://host/#/p/<id>``."""
    text = (value or "").strip()
    if not text:
        return ""
    if "/p/" in text:
        text = text.split("/p/", 1)[1]
    text = text.split("?", 1)[0].split("#", 1)[0]
    return text.strip("/ ")


def _bearer_token(ctx: Any) -> str | None:
    """Read the bearer token from the MCP HTTP request, if this is an HTTP call."""
    try:
        request = ctx.request_context.request if ctx is not None else None
    except Exception:
        request = None
    if request is None:
        return None
    try:
        header = request.headers.get("authorization", "")
    except Exception:
        return None
    if isinstance(header, str) and header.lower().startswith("bearer "):
        return header[7:].strip()
    return None


# Set only by mcp_server.run_stdio(): the local, trusted stdio transport. The
# HTTP app never calls run_stdio, so this stays False in the web process.
_STDIO_TRANSPORT = False


def enable_stdio_transport() -> None:
    global _STDIO_TRANSPORT
    _STDIO_TRANSPORT = True


def _has_http_request(ctx: Any) -> bool:
    try:
        return ctx is not None and ctx.request_context.request is not None
    except Exception:
        return False


def transport_of(ctx: Any) -> str:
    """'http' when the call arrived over Streamable HTTP; 'stdio' only when the
    process runs the stdio transport and no HTTP request is attached."""
    if _has_http_request(ctx):
        return "http"
    return "stdio" if _STDIO_TRANSPORT else "unknown"


# --------------------------------------------------------------------------- rate limit
_RATE_WINDOW_SECONDS = 60.0
_rate_hits: dict = {}
_rate_lock = threading.Lock()


def _rate_limit() -> int:
    try:
        return max(1, int(os.getenv("MCP_RATE_LIMIT_PER_MINUTE", "60")))
    except (TypeError, ValueError):
        return 60


def _check_rate(key: str) -> None:
    """Simple in-process sliding window (per token / per stdio user)."""
    now = time.monotonic()
    with _rate_lock:
        hits = [t for t in _rate_hits.get(key, []) if now - t < _RATE_WINDOW_SECONDS]
        if len(hits) >= _rate_limit():
            _rate_hits[key] = hits
            raise ValueError("rate_limited")
        hits.append(now)
        _rate_hits[key] = hits
        if len(_rate_hits) > 10_000:  # bound memory: drop idle keys
            for stale in [k for k, v in _rate_hits.items() if not v or now - v[-1] >= _RATE_WINDOW_SECONDS]:
                _rate_hits.pop(stale, None)


def resolve_user(email: str = "", ctx: Any = None) -> dict:
    """Resolve the acting user for a candidate tool.

    HTTP transport: a valid bearer token is REQUIRED (the MCP inherits the
    existing session and MFA policy); an ``email`` argument is ignored there,
    so nobody can act as another user by naming their address. Only the local
    stdio transport (trusted host process) may identify the user by ``email``.
    """
    m = _main()
    transport = transport_of(ctx)
    token = _bearer_token(ctx)
    if transport == "http" or token:
        if not token:
            raise ValueError("authentication_required")
        _check_rate("token:" + hashlib.sha256(token.encode()).hexdigest()[:24])
        try:
            return dict(m.current_user("Bearer " + token))
        except Exception as exc:  # invalid or expired session
            raise ValueError("invalid_session") from exc
    if email and transport == "stdio":
        row = m.one("SELECT * FROM users WHERE lower(email)=lower(?)", (email.strip(),))
        if not row:
            raise ValueError("unknown_email")
        _check_rate("stdio:" + str(row["id"]))
        return dict(row)
    raise ValueError("authentication_required")


def authorize_call(tool: str, email: str = "", ctx: Any = None) -> dict:
    """Resolve the caller for one tool call and write one audit row."""
    user = resolve_user(email, ctx)
    try:
        _main().audit(user["id"], "mcp_tool_call", f"{tool}:{transport_of(ctx)}")
    except Exception:
        pass
    return user


# --------------------------------------------------------------------------- S1: verification
def verify_passport(passport_id_or_link: str) -> dict:
    """Re-verify a Skill Passport exactly as the public share endpoint does."""
    m = _main()
    pid = _normalize_passport_id(passport_id_or_link)
    if not pid:
        return {"found": False, "reason": "missing_passport_id"}
    try:
        result = m.public_passport(pid)
    except Exception as exc:  # HTTPException(404) for an unknown id
        if getattr(exc, "status_code", None) == 404:
            return {"found": False, "reason": "not_found"}
        raise
    return {"found": True, **result}


def lookup_skill(term: str) -> dict:
    """Resolve a free-text skill term to canonical SkillBridge taxonomy ids."""
    import graphrag as G
    from content import TAXONOMY

    ids = G.canonical_skill_ids(term or "")
    return {
        "query": term,
        "matched": bool(ids),
        "skill_ids": ids,
        "skills": [
            {"id": skill_id, "name": TAXONOMY.get(skill_id, {}).get("name", skill_id)}
            for skill_id in ids
        ],
    }


# --------------------------------------------------------------------------- S3: candidate learning
def my_weak_topics(user_id: int) -> dict:
    """Weak or unverified topics from the candidate's latest stored result."""
    m = _main()
    attempt = m.latest_done(user_id)
    topics = m.topic_scores(user_id) if attempt else {}
    gaps = m.E.gap_map(topics or {})
    weak = [row for row in gaps if row.get("status") in {"below", "unverified"}]
    return {
        "based_on_attempt": attempt["id"] if attempt else None,
        "has_result": bool(attempt),
        "topics": topics,
        "weak_topics": weak,
        "note": "Weak = below the MOCK job threshold or not yet verified. Scores come from stored answer keys only.",
    }


# Practice items are a separate pool. Live exam items (status='active') are
# NEVER served here: candidates could otherwise rehearse the exact questions
# the exam selector draws from. The pool is status='practice' (never selected
# for exams, which use status='active'). If a topic has no practice items yet,
# retired exam items (status='archived', no longer selectable) are used as a
# labelled fallback. Drafts are never served.
PRACTICE_POOLS = (("practice", "practice"), ("archived", "retired"))


def _topic_rows(topic: str, status: str = "practice") -> list[dict]:
    """Rows of one non-exam pool for a topic, matched by canonical subcategory."""
    import graphrag as G
    from content import TAXONOMY

    if status not in {pool for pool, _ in PRACTICE_POOLS}:
        raise ValueError("unsupported_practice_pool")
    m = _main()
    rows = m.allr(
        "SELECT * FROM question_bank WHERE status=? AND subcategory != 'Legacy curated'", (status,)
    )
    ids = G.canonical_skill_ids(topic) or [str(topic or "").strip().lower()]
    wanted: set[str] = set()
    for skill_id in ids:
        wanted.add(G._norm(skill_id.replace("_", " ")))
        meta = TAXONOMY.get(skill_id) or {}
        if meta.get("name"):
            wanted.add(G._norm(meta["name"]))
        for alias in meta.get("aliases", []) or []:
            wanted.add(G._norm(alias))
    wanted.discard("")

    matched: list[dict] = []
    for row in rows:
        record = G._record(row)
        subcategory = G._norm(str(record.get("subcategory", "")))
        if subcategory and (subcategory in wanted or any(w in subcategory for w in wanted)):
            matched.append(record)
    return matched


def practice_questions(user_id: int, topic: str, count: int = 5) -> dict:
    """Practice-pool questions for a topic (never live exam items). Answers are never returned."""
    import graphrag as G

    try:
        size = max(1, min(int(count), 10))
    except (TypeError, ValueError):
        size = 5
    questions, pool = [], "none"
    for status, label in PRACTICE_POOLS:
        questions = _topic_rows(topic, status)[:size]
        if questions:
            pool = label
            break
    page = G.question_page(questions, 0, {}) if questions else {"questions": []}
    public = page["questions"]
    return {
        "topic": topic,
        "requested": size,
        "count": len(public),
        "pool": pool,
        "questions": public,
        "note": (
            "Read-only practice set from the practice pool (MOCK curated practice items, or retired "
            "exam items when no practice items exist). Live exam questions are never served. "
            "Correct answers are withheld."
        ),
    }


def learning_path(user_id: int) -> dict:
    """The candidate's curated learning path, mirroring GET /api/learning-path."""
    m = _main()
    attempt = m.latest_done(user_id)
    if not attempt:
        return {"available": False, "reason": "assessment_required"}
    import assessment_workflow as workflow

    release = workflow.current_release(attempt["id"])
    if not release:
        return {"available": False, "reason": "learning_requires_academic_and_honesty_approval"}
    plan = workflow.ensure_learning_plan(release["id"])
    return {
        "available": True,
        "based_on": attempt["id"],
        "release_id": release["id"],
        "gaps": [gap["skill"] for gap in plan["gaps"]],
        "items": plan["resources"],
        "note": "Curated, human-reviewed resources only. Missing coverage is reported, not fabricated.",
    }


def taxonomy_snapshot() -> dict:
    """A small, stable snapshot of the closed skill taxonomy (a resource)."""
    from content import TAXONOMY

    return {key: {"name": value["name"]} for key, value in TAXONOMY.items()}


def assert_no_answer_fields(payload: Any) -> None:
    """Raise if a tool payload contains any answer-ish key. Used by tests."""
    if isinstance(payload, dict):
        leaked = ANSWER_FIELDS.intersection(payload.keys())
        if leaked:
            raise AssertionError(f"answer field leaked: {sorted(leaked)}")
        for value in payload.values():
            assert_no_answer_fields(value)
    elif isinstance(payload, (list, tuple)):
        for item in payload:
            assert_no_answer_fields(item)
