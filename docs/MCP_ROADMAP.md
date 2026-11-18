# SkillBridge MCP Roadmap

**Impact-first plan for exposing SkillBridge to AI agents via the Model Context Protocol**

| Field | Value |
|---|---|
| Document | MCP_ROADMAP |
| Version | 1.0 (Draft for review) |
| Date | 18 November 2026 |
| Owner | SkillBridge engineering |
| Status | Proposed - not implemented |
| Related | AGENTS.md, README.md, docs/PROCTORED_EXAM.md, docs/R0_TRACEABILITY.md |

---

## 1. Summary

SkillBridge's core asset is **verified, portable proof of skill**: a deterministic
scoring engine, a curator-governed question bank, and an HMAC-signed, revocable
Skill Passport.

MCP's value is not "add a protocol". Its value is that **other AI agents can talk
to that asset natively**. This roadmap turns SkillBridge from a **website** into a
**platform** that recruiters' assistants, candidates' tutors and employers' HR
agents can build on - with verified skills as the currency.

Five MCP surfaces are proposed. Every one is read-only or draft-only. No tool
writes to scores, marks or publication state.

---

## 2. Current state (evidence-based)

- **Zero MCP today.** No `mcp` import exists in the repository and `mcp` is not
  in `backend/requirements.txt`. README lists "MCP servers" as roadmap.
- The ingredients already exist and are well-shaped:
  - `graphrag.extract_cv_skills()`, `graphrag.skill_coverage()`,
    `graphrag.canonical_skill_ids()`
  - `engine.redact()` (PII redaction), `engine.public_question()` (the only
    question serializer)
  - `main.current_user()` (bearer-token auth), Meilisearch/Neo4j with a
    deterministic SQL fallback
  - HMAC-signed, revocable Skill Passports
- Building an MCP surface is therefore mostly **wiring existing pure functions
  behind a protocol**, not new business logic.

---

## 3. Principles

1. **One server, role-scoped tool groups, two transports.** Simpler to operate
   than many thin servers, and one auth model.
   - `stdio` - for local hosts such as Claude Desktop or Cursor.
   - Streamable HTTP - mounted on the existing FastAPI app at `/mcp`.
2. **Read-only or draft-only by construction.** No tool writes to attempts,
   scores, marks or publication state. Human approval stays mandatory.
3. **Feature-flagged and additive.** Every surface is inert unless its
   environment flag is enabled. No existing endpoint changes behaviour when a
   flag is off.
4. **Lazy imports.** Any new module that imports `main` does so inside a
   function, matching `assessment_workflow.py`, to avoid circular imports.

---

## 4. Non-negotiables (from AGENTS.md)

- Scores come only from `engine.py` using stored answer keys. No live AI grading.
- No automatic fail or rejection from integrity flags.
- `engine.redact` runs before any text reaches an LLM.
- `engine.public_question` is the only serializer for question payloads.
- No emotion, personality or demographic inference.
- Curated or mock content stays labelled MOCK in the UI.
- `backend` pytest must pass before any commit.

Two invariants specific to this roadmap:

8. Every surface is disabled unless its environment flag is explicitly enabled.
9. No tool response may contain an `answer` or `ref` field. This is enforced by a
   blocking contract test.

---

## 5. The five surfaces

| ID | Surface | Auth | Priority | Effort | Impact |
|---|---|---|---|---|---|
| S1 | Verification MCP | none (public) | P0 | 1 day | Highest |
| S2 | Recruiter / Hiring MCP | token + role | P1 | 2 days | High |
| S3 | Candidate Learning MCP | token (self) | P1 | 2 days | High |
| S4 | Admin Governance MCP | token + role + MFA | P2 | 2 days | Medium |
| S5 | External MCP connect (client) | per-service | P2 | 2 days | Medium |

---

### 5.1 S1 - Public Verification MCP (P0)

**Problem.** The Skill Passport is signed and revocable, but only a human on a
browser can verify it. An employer's AI agent cannot.

**Tools**

| Tool | Returns |
|---|---|
| `verify_passport(link_or_id)` | Re-verified HMAC status, skills, source attempt, revocation status |
| `lookup_skill(term)` | Canonical taxonomy id (accepted / rejected) |

**Why it matters.** This makes the passport a **machine-verifiable credential**
any agent can check in one call. Zero auth, no PII beyond what the passport
already publishes. It reuses the existing signing code, so it is the smallest
high-impact surface.

**Acceptance criteria**

1. Valid passport returns verified skills; tampered signature returns invalid.
2. A revoked passport is reported as revoked.
3. No candidate PII beyond the passport payload is returned.
4. Works without any external service configured.

---

### 5.2 S2 - Recruiter / Hiring MCP (P1)

**Problem.** Companies can list candidates and applications, but only through the
web UI. Recruiting tools cannot query verified skills.

**Tools**

| Tool | Returns |
|---|---|
| `search_verified_candidates(skill_ids, min_score)` | Only candidates who opted into result sharing |
| `match_job_to_skills(description)` | JD mapped to taxonomy skills + coverage (advisory) |
| `draft_job_post(role, skills)` | A **draft** job, never auto-published; synthetic = MOCK |

**Constraints**

- Respect the existing per-application result-sharing consent. Candidates who
  have not opted in are never returned with scores.
- `draft_job_post` always lands as `draft`; publishing is a human action.
- Output that is synthetic must be labelled MOCK.

**Acceptance criteria**

1. A candidate without sharing consent never appears with a score.
2. Drafted posts are `draft` status and clearly labelled.
3. Results are scoped to the authenticated company.

---

### 5.3 S3 - Candidate Learning MCP (P1)

**Problem.** The learn/retake loop is good but web-only. A candidate's personal
tutor cannot see their verified gap.

**Tools**

| Tool | Returns |
|---|---|
| `my_weak_topics()` | Topics below threshold from the latest result |
| `practice_questions(topic, n)` | Approved questions via `public_question` (no answers) |
| `learning_path()` | Curated resources with source + licence citations |

**Constraints**

- Strictly self-scoped: a token can only read its own `user_id`.
- Never returns answer keys; all questions go through `public_question`.

**Acceptance criteria**

1. A token cannot read another user's data (returns 403/empty).
2. No `answer`/`ref` fields in any practice question.
3. Resources carry source and licence metadata.

---

### 5.4 S4 - Admin Governance MCP (P2)

**Problem.** Admin review is the bottleneck in the approval loop. Admins need an
assistant that drafts and summarises, while every decision stays human.

**Tools**

| Tool | Returns / action |
|---|---|
| `coverage_report()` | GraphRAG readiness per skill |
| `draft_question(...)` | Creates a `pending_approval` question, never auto-active |
| `review_evidence(attempt_id)` | Integrity timeline, **advisory only** |

**Constraints**

- `draft_question` can never set a question to `active`.
- `review_evidence` never changes a score and never auto-fails an attempt.
- Requires admin role and MFA, matching the existing policy.

**Acceptance criteria**

1. Drafted questions are `pending_approval` and require a human to activate.
2. Integrity output is advisory text only; no state change.
3. Access is denied without admin role + MFA.

---

### 5.5 S5 - External MCP connect (client) (P2)

**Problem.** Two things decay without upkeep: the curated learning-resource
catalogue and the job marketplace.

**Scope - SkillBridge as an MCP client**

- Connect to a docs/courses MCP to fetch and licence-check learning resources.
- Connect to a jobs MCP to import real listings (real vs MOCK clearly labelled).

**Constraints**

- No candidate PII leaves SkillBridge.
- Imported resources still require curator approval before they are served.
- Only ship this if it directly feeds learning or jobs; otherwise it is noise.

**Acceptance criteria**

1. Imported resources enter a pending-review state, not the live catalogue.
2. Imported jobs are labelled real vs MOCK.
3. Disabling the flag removes the client entirely.

---

## 6. Architecture

```
MCP host (Claude Desktop / Cursor / HR agent)
        │  stdio                         │  Streamable HTTP (/mcp)
        ▼                                ▼
┌──────────────────────────────────────────────────────────┐
│                 SkillBridge MCP server                    │
│  role-scoped tool groups:                                 │
│    verification · recruiter · candidate · admin           │
└──────────────────────────────────────────────────────────┘
        │                    │                      │
        ▼                    ▼                      ▼
  engine.py            graphrag.py            main.py auth
  (scores, redact,     (skills, coverage,     (current_user,
   public_question)     retrieval)             roles, MFA)
        │
        ▼
  Postgres / SQLite · Meilisearch · Neo4j (optional)
```

**Auth model**

| Tool group | Auth | Data boundary |
|---|---|---|
| Verification | none | passport payload only |
| Recruiter | bearer token + company role | consent-gated candidate data |
| Candidate | bearer token (own id) | self data only |
| Admin | bearer token + admin role + MFA | draft / read-only |

---

## 7. Roadmap

| Milestone | Ships | Impact | Est. |
|---|---|---|---|
| M1 | S1 Verification MCP | verifiable-credential story, zero PII risk | 1 day |
| M2 | S3 Candidate Learning MCP | guided learning loop | 2 days |
| M3 | S2 Recruiter / Hiring MCP | scriptable, verified hiring | 2 days |
| M4 | S4 Admin Governance MCP | faster human-approval loop | 2 days |
| M5 | S5 External MCP connect | fresh resources + jobs | 2 days |

Ship M1-M2 first: they are small, self-contained, and prove the MCP story
end-to-end before touching company or admin data.

---

## 8. Configuration additions (all default to current behaviour)

```
# MCP transport
MCP_ENABLED=false
MCP_HTTP_PATH=/mcp
MCP_RATE_LIMIT_PER_MIN=60

# Surfaces
MCP_VERIFICATION_ENABLED=false
MCP_RECRUITER_ENABLED=false
MCP_CANDIDATE_ENABLED=false
MCP_ADMIN_ENABLED=false
MCP_EXTERNAL_CLIENT_ENABLED=false
```

---

## 9. Test plan

| Area | Test | Type |
|---|---|---|
| S1 | valid / tampered / revoked passport | integration |
| S1 | no PII beyond passport payload | contract |
| S2 | candidate without consent never returns a score | security, blocking |
| S3 | token cannot read another user | security, blocking |
| S3 | no `answer`/`ref` in practice questions | contract, blocking |
| S4 | drafted question stays `pending_approval` | integration |
| S4 | admin tool denied without MFA | security |
| all | app boots with `MCP_ENABLED` unset | regression, blocking |
| all | rate limit returns structured 429 | unit |

Definition of done: all new tests green, the existing suite green and unmodified,
and a manual smoke test from a real MCP host (Claude Desktop or Cursor).

---

## 10. Risk register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Answer key leaks through a tool | Low | Critical | `public_question` only; blocking contract test; read-only tools |
| Consent bypass in recruiter surface | Medium | Critical | filter by sharing consent at the query, test as blocking |
| Cross-user access in candidate surface | Medium | Critical | self-scoped queries, 403 tests |
| Circular imports destabilise boot | Medium | High | lazy imports, flags off by default, boot test |
| Scope creep into scoring | Medium | Critical | invariant review on every PR |

---

## 11. Open decisions

1. **One server or two?** Recommended: one server, role-scoped groups. A public
   verification server could be split out since it is zero-auth.
2. **First surface?** Recommended: S1 (Verification MCP) - smallest, highest
   impact, no sensitive data.
3. **Public HTTP verification endpoint?** Recommended: yes, read-only and
   rate-limited; all other surfaces admin/company/candidate scoped.

---

## 12. Appendix - proposed file inventory

New files:

- `backend/mcp_server.py` - registry, stdio entrypoint, HTTP router
- `backend/mcp_tools.py` - tool implementations (pure functions)
- `backend/tests/test_mcp_verification.py`
- `backend/tests/test_mcp_candidate.py`
- `backend/tests/test_mcp_recruiter.py`
- `backend/tests/test_mcp_contract.py` - no `answer`/`ref` leak

Modified files:

- `backend/main.py` - one guarded `include_router` per enabled surface
- `backend/requirements.txt` - add the official Python `mcp` SDK
- `.env.example` - new flags, defaults preserving behaviour
- `README.md` - roadmap table updated only after each surface ships

No changes to `engine.py` scoring logic, `engine.public_question`, or any existing
migration.
