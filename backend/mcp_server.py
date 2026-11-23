"""SkillBridge MCP server (M1 verification + M2 candidate learning).

One read-only tool registry, two transports:

- stdio:            ``python -m mcp_server``  (Claude Desktop / Cursor)
- Streamable HTTP:  mounted on the FastAPI app at ``MCP_HTTP_PATH`` (``/mcp``)

No tool writes to the database or the scoring path. Question payloads never
include answer keys. ``main`` is only imported lazily inside ``mcp_tools``.
"""
import os

from mcp.server.fastmcp import Context, FastMCP

import mcp_tools as T

mcp = FastMCP(
    "skillbridge",
    instructions=(
        "Read-only SkillBridge tools. Verify signed Skill Passports and read a "
        "candidate's saved learning data. No tool writes to scores, marks or "
        "publication state."
    ),
)


# --------------------------------------------------------------------- S1: verification
@mcp.tool()
def verify_passport(passport_id_or_link: str) -> dict:
    """Verify a Skill Passport by id or share link.

    Returns HMAC signature validity, revocation status and the verified skills
    inside the credential. Public: no sign-in required.
    """
    return T.verify_passport(passport_id_or_link)


@mcp.tool()
def lookup_skill(term: str) -> dict:
    """Resolve a free-text skill term (for example "Power BI") to canonical ids."""
    return T.lookup_skill(term)


# --------------------------------------------------------------------- S3: candidate learning
@mcp.tool()
def my_weak_topics(email: str = "", ctx: Context = None) -> dict:
    """Return the caller's weak/unverified topics from their latest result.

    Over HTTP a bearer token is required; only the local stdio transport may pass ``email``.
    """
    try:
        user = T.authorize_call("my_weak_topics", email, ctx)
    except ValueError as exc:
        return {"error": str(exc)}
    return T.my_weak_topics(user["id"])


@mcp.tool()
def practice_questions(topic: str, count: int = 5, email: str = "", ctx: Context = None) -> dict:
    """Return up to ``count`` approved practice questions for a topic.

    Answer keys are never returned; questions come from the practice pool, never live exam items.
    """
    try:
        user = T.authorize_call("practice_questions", email, ctx)
    except ValueError as exc:
        return {"error": str(exc)}
    return T.practice_questions(user["id"], topic, count)


@mcp.tool()
def learning_path(email: str = "", ctx: Context = None) -> dict:
    """Return the caller's curated learning path from their latest approved result."""
    try:
        user = T.authorize_call("learning_path", email, ctx)
    except ValueError as exc:
        return {"error": str(exc)}
    return T.learning_path(user["id"])


# --------------------------------------------------------------------- resources
@mcp.resource("skillbridge://taxonomy")
def taxonomy_resource() -> str:
    """The closed SkillBridge skill taxonomy (id -> display name)."""
    import json

    return json.dumps(T.taxonomy_snapshot(), indent=2)


@mcp.resource("skillbridge://server")
def server_resource() -> str:
    """A short description of this server and its read-only guarantees."""
    import json

    return json.dumps(
        {
            "server": "skillbridge",
            "surfaces": ["verification", "candidate_learning"],
            "read_only": True,
            "tools": [
                "verify_passport",
                "lookup_skill",
                "my_weak_topics",
                "practice_questions",
                "learning_path",
            ],
        },
        indent=2,
    )


def run_stdio() -> None:
    """Run the server over stdio for a local MCP host.

    Only this transport may identify a user by ``email`` (trusted local host);
    the HTTP transport always requires a bearer token.
    """
    T.enable_stdio_transport()
    mcp.run(transport="stdio")


def mount_mcp(app) -> None:
    """Mount the Streamable HTTP transport on a FastAPI/Starlette app.

    The session manager is started and stopped with the app's own startup and
    shutdown events, so this adds behaviour without changing the app lifespan.
    """
    http_path = (os.getenv("MCP_HTTP_PATH", "/mcp") or "/mcp").strip()
    if not http_path.startswith("/"):
        http_path = "/" + http_path

    # Build the SDK's Streamable HTTP app once so its lazily-created session
    # manager exists. We mount our own thin ASGI delegate below, so the SDK's
    # nested mount path does not double up (it would otherwise serve /mcp/mcp).
    mcp.streamable_http_app()

    class _McpHttpEndpoint:
        async def __call__(self, scope, receive, send):
            await mcp.session_manager.handle_request(scope, receive, send)

    app.mount(http_path, _McpHttpEndpoint())

    @app.on_event("startup")
    async def _mcp_startup():
        sm = mcp.session_manager
        if getattr(sm, "_has_started", False):
            return  # already running in this process (e.g. TestClient reuse)
        cm = sm.run()
        await cm.__aenter__()
        app.state._mcp_session_cm = cm
        print("[mcp] Streamable HTTP transport ready at " + http_path)

    @app.on_event("shutdown")
    async def _mcp_shutdown():
        cm = getattr(app.state, "_mcp_session_cm", None)
        if cm is not None:
            await cm.__aexit__(None, None, None)


if __name__ == "__main__":
    # Load the repo .env so the stdio entrypoint can reach the same database the
    # API uses (Neon DATABASE_URL, SECRET_KEY, ...) without extra exports.
    try:
        from dotenv import load_dotenv

        for _candidate in (
            os.path.join(os.path.dirname(__file__), "..", ".env"),
            os.path.join(os.path.dirname(__file__), ".env"),
        ):
            if os.path.exists(_candidate):
                load_dotenv(_candidate)
                break
    except ImportError:
        pass
    run_stdio()
