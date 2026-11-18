# SkillBridge Agent Platform — Spec

**One orchestrator, three role-scoped copilots, draft-only writes**

| Field | Value |
|---|---|
| Document | AGENT_PLATFORM |
| Version | 1.0 |
| Date | 18 November 2026 |
| Status | P0–P4 implemented (backend + native chat UI); LangChain adapters pending |
| Related | AGENTS.md, docs/MCP_ROADMAP.md, docs/AI_AGENT_FEATURES.md, docs/AI_PROVIDERS.md |

### Implementation status (this build)

- **Orchestrator + budget + cache + run log + artifacts:** `backend/agent_platform.py`
- **Tools:** `backend/agent_tools.py` · **Specialists:** `backend/agent_specialists.py`
- **API:** `backend/agent_console_api.py` → `/api/agent/*`
- **Native UI:** `frontend/src/AgentConsole.jsx` renders a chat copilot in the
  candidate ("AI Copilot"), company ("AI Copilot") and admin ("AI Agents") panels.
  Natural-language messages auto-detect the intent; role-aware suggestion chips,
  rich human-readable result cards (no raw JSON), live telemetry and the approval
  queue. The standalone `frontend/public/agent-console.html` stays as a fallback.
- **Model routing:** complex agent tasks (question generation, integrity summary)
  prefer DeepSeek; other calls keep the Groq → DeepSeek → Gemini chain. See
  `docs/AI_PROVIDERS.md`.
- **Billing:** the Admin Billing page embeds `frontend/src/AiUsagePanel.jsx`, which
  shows estimated AI spend, remaining budget, tokens and per-provider costs from
  `ai_usage_ledger`.
- **Screenshots:** `docs/agent-console.png`, `docs/admin-agent-tab.png`,
  `docs/candidate-agent-tab.png`, `docs/company-agent-tab.png`,
  `docs/admin-billing-ai.png`.
- **Tests:** 8 platform tests; full suite **224 passed, 1 skipped**.
- **LangChain:** not installed; tools are `StructuredTool`-shaped for a later adapter.
  No new dependency was added, so FastAPI/pydantic stay intact.

---

## 1. What this is

A single **agent platform** that powers AI copilots in all three panels without
adding a second scoring path:

| Panel | Agent | Intents |
|---|---|---|
| Candidate | Career Coach | `study_plan`, `gap_explain`, `practice_hint`, `application_draft` |
| Company | Hiring Copilot | `job_skills`, `shortlist`, `feedback_draft`, `evidence_summary` |
| Admin | Governance Copilot | `question_coverage`, `question_draft`, `integrity_summary` |

Everything the agents produce is a **draft** stored in an approval queue. No tool
writes to scores, marks, publication, jobs or the question bank directly.

### 1.1 In-app chat UI (what users see)

The copilot is a native chat in each panel, not a JSON form:

- **Composer** — type in plain language (Enter to send, Shift+Enter for a new line).
- **Intent detection** — client-side routing maps requests such as "Draft 1 Python
  question for the bank" or "Build me a study plan" to the role's allowed intents;
  suggestion chips pin a specific intent.
- **Rich replies** — study plans render as week-by-week cards, job→skills as skill
  chips and thresholds, shortlists as candidate rows, integrity summaries as review
  signals. Raw JSON only appears behind a collapsed *Technical details* toggle.
- **Telemetry** — status, tool calls, latency and token counts per run.
- **Approval queue** — a sticky side panel with human-readable draft previews and
  Approve / Reject actions (existing `/api/agent/artifacts/*` endpoints).

No draft is applied automatically; a human approves every artifact.

### 1.2 Billing visibility

`frontend/src/AiUsagePanel.jsx` is embedded in **Admin → Billing** and reads the
existing `/api/agent/status` payload (`ai_budget`), backed by `ai_usage_ledger`:

- estimated spend and remaining budget for the window;
- total tokens in / out;
- a per-provider table (tokens, estimated cost, share of spend);
- an "exhausted" notice when the budget is reached.

It is read-only and never calls a provider or edits an invoice. Costs are
estimates; provider dashboards remain authoritative. See `docs/AI_PROVIDERS.md`.

---

## 2. Architecture

```
Browser / AI host
      │
      ▼
Agent console (/api/agent/*)  ──►  Orchestrator
                                      │  role + consent + budget
                                      ├─ CandidateAgent
                                      ├─ CompanyAgent
                                      └─ AdminAgent
                                      │  tool calls (bounded, logged)
                                      ▼
        ┌───────────────┬───────────────┬──────────────────┐
        │ read tools    │ draft tools   │ existing modules │
        │ profile, weak │ study plan,   │ mcp_tools,       │
        │ topics, jobs, │ job skills,   │ agent_questions, │
        │ coverage,     │ shortlist,    │ agent_integrity, │
        │ integrity     │ feedback      │ graphrag,        │
        └───────────────┴───────────────┴──────────────────┘
                      │
                      ▼
        agent_runs (audit) + agent_artifacts (approval queue)
```

### Multi-agent model

- **Orchestrator** = one entry point. It resolves the caller's role, enforces
  consent and budget, dispatches to exactly one specialist agent, and records the
  run.
- **Specialist agents** own their intents and tool plans. They are deterministic
  first and use the LLM only to polish prose, never to decide facts.
- **Tools** are small, named functions (`name`, `description`, `args`) — the same
  shape LangChain's `StructuredTool` expects, so they can be wrapped later
  without a rewrite. No LangChain dependency is required to ship.

---

## 3. Token optimization

| Technique | Where |
|---|---|
| Deterministic fast paths | Study plans, coverage, shortlists and gap explanations are computed from the DB; the LLM is optional. |
| Per-run budget | `max_tool_calls`, `max_llm_calls`, `max_tokens`, `deadline` enforced by the orchestrator. |
| Input truncation | Lists capped (top N), CV/JD text capped, only scores/skills sent. |
| Output caps | `max_tokens` per call; responses must be JSON and are schema-filtered. |
| Provider fallback | Reuses `agent_llm` → `ai_providers` failover. |
| Response cache | Short-TTL in-process cache keyed by `(agent, intent, payload hash)` for deterministic intents. |
| No answer keys in prompts | Practice questions are serialized with answers withheld. |

Every run records `tokens_in`, `tokens_out`, `tool_calls`, `latency_ms` — no PII.

---

## 4. Tools

### Read (role-scoped)
| Tool | Role | Returns |
|---|---|---|
| `profile` | candidate | own profile + confirmed skills |
| `learning_context` | candidate | weak topics + curated learning path |
| `practice_questions` | candidate | approved questions, answers withheld |
| `jobs` | candidate | published jobs |
| `application_context` | candidate | own profile + one job |
| `company_applications` | company | own applications, consent flags |
| `skill_coverage` | admin | per-skill coverage |
| `integrity_summary` | admin | advisory integrity summary |
| `question_drafts` | admin | pending question drafts |

### Draft (write to `agent_artifacts` only)
| Tool | Role | Artifact kind |
|---|---|---|
| `draft_study_plan` | candidate | `study_plan` |
| `draft_gap_explainer` | candidate | `gap_explain` |
| `draft_application_answer` | candidate | `application_answer` |
| `draft_job_skills` | company | `job_skills` |
| `draft_shortlist` | company | `shortlist` |
| `draft_feedback` | company | `feedback` |
| `draft_integrity_summary` | admin | `integrity_summary` |
| `draft_questions` | admin | `question_drafts` (delegates to F-B) |

---

## 5. Data model (new, additive)

`agent_runs` — one row per orchestration:
`id, user_id, role, agent, intent, status, tool_calls, tokens_in, tokens_out,
latency_ms, error, created_at`.

`agent_artifacts` — the approval queue:
`id, run_id, user_id, role, kind, title, body (JSON), status
(pending_approval|approved|rejected), created_at, reviewed_by, reviewed_at`.

Question drafts stay in the existing `agent_question_drafts` (F-B) and are linked
from the run; the console shows both.

Both tables are created with `CREATE TABLE IF NOT EXISTS` in a new module. The
existing schema is untouched.

---

## 6. Guardrails

- **Role-scoped**: candidate → own data; company → own organisation + consent;
  admin → existing admin scopes.
- **Consent**: company tools only see candidates who applied to the company's
  jobs **and** set `results_shared=1`.
- **No answer leakage**: practice questions use `graphrag.question_page`.
- **PII redaction** before any LLM (`agent_llm` → `engine.redact`).
- **No auto-apply / auto-reject / auto-send / auto-publish**.
- **Advisory labels** on every response; every artifact is `pending_approval`.
- **Audited**: one `agent_runs` row per run, one audit row per approval.
- **Flag-gated**: `AGENT_PLATFORM_ENABLED=false` by default.

---

## 7. API

```
GET    /api/agent/status
POST   /api/agent/run                 {intent, payload}
GET    /api/agent/runs
GET    /api/agent/artifacts?status=pending_approval
POST   /api/agent/artifacts/{id}/approve
DELETE /api/agent/artifacts/{id}
```

Non-mutating except approve/reject, which only change artifact status and write
an audit row.

---

## 8. Files

**New**
- `backend/agent_platform.py` — orchestrator, budget, cache, artifacts, run log
- `backend/agent_tools.py` — read + draft tools (role-scoped)
- `backend/agent_specialists.py` — candidate/company/admin agents
- `backend/agent_console_api.py` — `/api/agent/*`
- `backend/tests/test_agent_platform.py`
- `frontend/public/agent-console.html` — standalone visual console (no app edits)

**Modified (minimal)**
- `backend/main.py` — one guarded `include_router`
- `.env.example` — flags

**Unchanged:** `engine.py`, scoring, question bank, candidate/company/admin flows.

---

## 9. Acceptance criteria

1. `GET /api/agent/status` returns the caller's role + intents.
2. Candidate `study_plan` creates a `study_plan` artifact, never touches scores.
3. Company `shortlist` returns only consenting applicants.
4. Admin `integrity_summary` reuses F-A and is advisory.
5. Admin `question_draft` reuses F-B drafts (not active questions).
6. All artifacts start `pending_approval`; approve/reject only change status + audit.
7. Flag off → 503; wrong role → 403.
8. No answer-key fields in any response; no PII in run logs.
9. Deterministic intents work with no LLM configured.
10. Existing suite stays green.

---

## 10. Roadmap

| Phase | Content |
|---|---|
| P0 | Orchestrator, budget, run log, artifacts, status |
| P1 | Candidate intents |
| P2 | Company intents (consent-gated) |
| P3 | Admin intents (reuse F-A/F-B) |
| P4 | Standalone console + optional LLM prose |
| P5 | LangChain `StructuredTool` adapters + eval |
