# SkillBridge MCP — Implementation Report

**What the MCP tools actually do, and how they work**

| Field | Value |
|---|---|
| Document | MCP_IMPLEMENTATION_REPORT |
| Version | 1.0 |
| Date | 18 November 2026 |
| Status | Implemented (M1 + M2), read-only |
| Scope | Verification MCP (M1) + Candidate Learning MCP (M2) |
| Related | docs/MCP_ROADMAP.md, AGENTS.md, docs/mcp-console.png |

---

## 1. What this actually does (plain language)

**MCP (Model Context Protocol)** is a standard way for AI applications (Claude
Desktop, Cursor, an HR agent, etc.) to *discover and call* a system's tools.

SkillBridge now ships a **read-only MCP server** that exposes two things:

1. **Verification** — anyone (or any AI agent) can verify a signed Skill
   Passport and resolve a free-text skill to a canonical taxonomy id.
2. **Candidate learning** — a signed-in candidate can read their own weak
   topics, curated learning path, and approved practice questions.

In one sentence:

> An AI assistant can now ask SkillBridge, "is this Skill Passport valid?", "what
> are this candidate's weak topics?", and "give me 5 practice questions on
> Python" — and get real answers from the existing engine, **without changing a
> single score, and without ever exposing answer keys.**

What it deliberately does **not** do: it never writes to the database, never
grades, never publishes, never returns `answer` / `reference_answer` /
`explanation` fields, and never exposes candidate data to anyone who is not the
signed-in candidate.

---

## 2. Why it matters

| Today (before) | With MCP |
|---|---|
| A Skill Passport can only be checked by a human on the web page | Any AI agent or employer tool can verify it programmatically |
| A candidate's study data lives only in the app | Their personal AI tutor can be grounded in their *verified* gap |
| Skill data is reachable only through the website | Other tools can consume it over a standard protocol |

This is the "turn the website into a platform" step: the same deterministic
engine, now callable by AI clients.

---

## 3. Architecture

```
MCP host (Claude Desktop / Cursor / HR agent)
        │ stdio                         │ Streamable HTTP  /mcp
        ▼                               ▼
┌─────────────────────────────────────────────────────────────┐
│ backend/mcp_server.py  — FastMCP registry (5 tools, 2 resources) │
└─────────────────────────────────────────────────────────────┘
        │ calls
        ▼
┌─────────────────────────────────────────────────────────────┐
│ backend/mcp_tools.py  — read-only functions                  │
│   verify_passport · lookup_skill · my_weak_topics            │
│   practice_questions · learning_path                         │
└─────────────────────────────────────────────────────────────┘
        │ reuses (lazy import, no circular import)
        ▼
engine.py (signing/verification, gap map) · graphrag.py (skills,
question_page serializer) · content.py (taxonomy) · main.py
(current_user, DB helpers)
        │
        ▼
Postgres / Neon · SQLite (fallback)

In-app browser:
McpConsole.jsx ──► /api/mcp/* (backend/mcp_api.py) ──► mcp_tools.py
```

### Files

| File | Purpose |
|---|---|
| `backend/mcp_server.py` | FastMCP server, tool + resource registration, stdio entrypoint, HTTP mount |
| `backend/mcp_tools.py` | The five read-only tool functions (the actual logic) |
| `backend/mcp_api.py` | REST bridge that powers the in-app console (`/api/mcp/*`) |
| `frontend/src/McpConsole.jsx` | The visual "MCP tools" page in the candidate workspace |
| `frontend/src/mcp-console.css` | Styling for that page |
| `backend/tests/test_mcp.py` | Contract tests (registry, no-answer-leak, auth) |
| `docs/mcp-console.png` | Screenshot of the working console |

---

## 4. The five tools

### M1 — Verification (public, no sign-in)

#### `verify_passport(passport_id_or_link)`
Re-verifies a Skill Passport exactly like `GET /api/public/passport/{pid}`:
checks the HMAC signature, revocation state, expiry and the current review release.

```json
// input: "https://host/#/p/abc123"  or  "abc123"
// not found:
{ "found": false, "reason": "not_found" }

// valid:
{
  "found": true,
  "revoked": false,
  "expired": false,
  "signature_valid": true,
  "signature": "9f3c1a7d2b4e8c60",
  "passport": {
    "holder": "Sadia Rahman",
    "skills": [
      { "skill": "sql", "name": "SQL", "score": 78, "level": "Advanced" }
    ],
    "overall": 74,
    "level": "Advanced",
    "credential_version": "skill-passport-v2"
  }
}
```

#### `lookup_skill(term)`
Resolves free text to canonical taxonomy ids.

```json
// input: "Power BI"
{
  "query": "Power BI",
  "matched": true,
  "skill_ids": ["visualization"],
  "skills": [{ "id": "visualization", "name": "Data Visualization" }]
}
```

### M2 — Candidate learning (requires the signed-in candidate)

> Over **HTTP**, the bearer token identifies the caller (inherits the existing
> session/MFA policy). Over **stdio** (local, trusted), pass `email`.

#### `my_weak_topics`
Weak/unverified topics from the candidate's latest stored result.

```json
{
  "based_on_attempt": "a1b2c3",
  "has_result": true,
  "topics": { "sql": { "score": 55, "level": "Intermediate", "n": 4 } },
  "weak_topics": [
    { "skill": "sql", "name": "SQL", "threshold": 60, "score": 55, "status": "below" }
  ],
  "note": "Weak = below the MOCK job threshold or not yet verified. Scores come from stored answer keys only."
}
```

#### `practice_questions(topic, count=5)`
Up to 10 approved questions for a topic. **Answer fields are never returned** —
questions are serialized by `graphrag.question_page`, which only whitelists public
fields.

```json
{
  "topic": "python",
  "requested": 5,
  "count": 5,
  "questions": [
    {
      "id": "demo-gr-cv-01", "question_type": "MCQ", "difficulty_level": "Easy",
      "question_text": "What does the Python expression [x*x for x in range(3)] produce?",
      "options": ["[1, 4, 9]", "[0, 1, 4]", "[0, 1, 2]", "An error"],
      "marks": 1, "time_allocation": 60
    }
  ],
  "note": "Read-only practice set from the approved bank. Correct answers are intentionally withheld."
}
```

#### `learning_path`
The candidate's curated learning path, mirroring `GET /api/learning-path`. It
requires an approved result release; otherwise it says why.

```json
{ "available": false, "reason": "assessment_required" }
```

### Resources (2)

| URI | Returns |
|---|---|
| `skillbridge://taxonomy` | The closed skill taxonomy (id → display name) |
| `skillbridge://server` | Server description + read-only guarantees + tool list |

---

## 5. Transports

### 5.1 Streamable HTTP — `/mcp`
Mounted on the existing FastAPI app when `MCP_ENABLED=true`, and proxied by nginx
at `http://localhost:8080/mcp`.

Verified handshake (through nginx):

```
POST /mcp/   Accept: application/json, text/event-stream
{ "jsonrpc":"2.0","id":1,"method":"initialize","params":{
    "protocolVersion":"2024-11-05","capabilities":{},
    "clientInfo":{"name":"probe","version":"0"} } }

HTTP/1.1 200 OK
Content-Type: text/event-stream
mcp-session-id: 1cc8b12152c44eb9b57dde391a67b479

event: message
data: {"jsonrpc":"2.0","id":1,"result":{
  "protocolVersion":"2024-11-05",
  "serverInfo":{"name":"skillbridge","version":"1.9.4"},
  "instructions":"Read-only SkillBridge tools. ..."}}
```

After `initialize`, the client sends `notifications/initialized`, then
`tools/list` and `tools/call`, carrying the `Mcp-Session-Id` header. A real MCP
host (Claude Desktop, Cursor) does this automatically.

### 5.2 stdio — `python -m mcp_server`
For local hosts. Run from `backend/`; it loads the repo `.env` so it reaches the
same database.

Example Claude Desktop / Cursor config:

```json
{
  "mcpServers": {
    "skillbridge": {
      "command": "python",
      "args": ["-m", "mcp_server"],
      "cwd": "D:\\skillbridge\\backend"
    }
  }
}
```

Candidate tools over stdio need an identity, for example:
`my_weak_topics(email="you@example.com")`.

### 5.3 In-app console (REST bridge, `/api/mcp/*`)
The visual page in the candidate workspace calls the **same tool functions** so
users and reviewers can see MCP working, with normal session auth:

| Endpoint | Auth | Mirrors |
|---|---|---|
| `GET /api/mcp/status` | public | tool catalogue + transport info |
| `POST /api/mcp/verify` | public | `verify_passport` |
| `GET /api/mcp/lookup?term=` | public | `lookup_skill` |
| `GET /api/mcp/learning` | signed-in | `my_weak_topics` + `learning_path` |
| `POST /api/mcp/practice` | signed-in | `practice_questions` |

---

## 6. Security and guarantees

| Guarantee | How it holds |
|---|---|
| Read-only | No tool performs an `INSERT`/`UPDATE`/`DELETE`. Verification and lookup only read; practice questions are read from the bank. |
| No answer keys | Practice questions use `graphrag.question_page`, which whitelists public fields. A blocking test asserts no `answer`/`reference_answer`/`explanation` keys ever appear. |
| Public vs private | Verification is public. Candidate tools require a valid session (HTTP) or an explicit local email (stdio). |
| No score changes | The scoring path (`engine.py`) is untouched. |
| No PII to third parties | Candidate tools are scoped to the caller; verification returns only the passport payload that is already public. |
| Feature-flagged | The HTTP transport mounts only when `MCP_ENABLED=true`. Off = the app behaves exactly as before. |

### Honest scope note — implemented vs. roadmap

**Implemented now:** the 5 tools, 2 resources, stdio + HTTP transports, the REST
bridge, the in-app console, and the contract tests.

**Not implemented yet** (from the broader roadmap, deliberately deferred):

- per-call audit rows and per-token rate limiting;
- recruiter/admin surfaces (S2/S4) and the external MCP client (S5);
- explicit MFA re-check inside the MCP tool layer (HTTP currently relies on the
  bearer session, which already enforces MFA where configured).

---

## 7. Configuration

```dotenv
# ---- MCP (verification + candidate learning) ----
MCP_ENABLED=true      # mount the Streamable HTTP transport at startup
MCP_HTTP_PATH=/mcp    # HTTP endpoint path
```

`.env.example` documents `MCP_ENABLED=false` as the safe default. Set it to
`true` in `.env` to enable it locally (already done here).

---

## 8. How to use it

1. **In the app:** sign in as a candidate → sidebar → **MCP tools**. Try
   *Load my weak topics & learning path* and *Get 5 questions*.
2. **From an AI host:** add the stdio config above (or point the host at
   `http://localhost:8080/mcp` for HTTP) and use the five tools.
3. **From curl (HTTP):** start with the `initialize` POST shown in §5.1, keep the
   returned `mcp-session-id`, then POST `tools/list` and `tools/call`.

---

## 9. Verification evidence

| Check | Result |
|---|---|
| Backend suite | **198 passed, 1 skipped** (10 new MCP tests) |
| MCP registry | 5 tools + 2 resources discovered |
| HTTP handshake | `initialize` → 200, `text/event-stream`, `mcp-session-id` |
| REST bridge | `GET /api/mcp/status` → `enabled: true`, 5 tools |
| Practice tool | returned **5** approved Python questions, no answers |
| UI | console rendered with live data, **0 page errors** |
| Docker | rebuilt & healthy (`/api/health` → `{"ok":true}`) |
| Visual | `docs/mcp-console.png` |

---

## 10. Limitations

- The HTTP transport is mounted only in the backend process; expose it through
  nginx (already configured) or publish the backend port for external agents.
- stdio is a local, trusted surface: candidate tools identify the caller by
  `email`. It is not meant for multi-tenant remote use.
- Verification reflects the stored passport and current review release; a
  revoked or superseded passport is reported as such, by design.
- No vector retrieval, no external MCP consumption, and no write operations are
  part of this milestone.
