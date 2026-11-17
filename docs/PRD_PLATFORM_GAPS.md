# SkillBridge R0.1 - Platform Gaps PRD

**MCP, Documentation and Evaluation Additions Without Regression**

| Field | Value |
|---|---|
| Document | PRD_PLATFORM_GAPS |
| Version | 1.0 (Draft for review) |
| Date | 17 November 2026 |
| Owner | SkillBridge engineering |
| Status | Proposed - not implemented |
| Baseline | SkillBridge R0 (commit at time of writing) |
| Related | AGENTS.md, README.md, docs/R0_TRACEABILITY.md, docs/SQA_REMEDIATION.md |

---

## 1. Summary

This PRD defines how to add the capabilities SkillBridge currently lacks - most
notably MCP servers and clients, a live documentation module, and a real
evaluation harness - without touching the scoring path, the answer-key
boundary, or any feature that already works.

Every item is additive, feature-flagged, and reversable by environment variable.
No existing endpoint changes behaviour when a flag is off. The 148 existing
backend tests must pass unmodified.

---

## 2. Background

An audit of the build against the submission forms produced a short, concrete
gap list. Each gap below is evidence-based, not aspirational:

- MCP: zero servers, zero clients, zero transports. README.md line 141
  explicitly lists "MCP servers" as roadmap. No mcp import exists in the repo.
- Live documentation: no /docs product page. FastAPI already serves Swagger UI
  at /docs, so the route collides and must be resolved deliberately.
- Evaluation: prompt quality is regression-tested but not benchmarked. The
  prompt file itself records "Golden-CV eval set is on the roadmap".
- Prompt versioning: only prompts/skill_extract.v1.md is externalised. The two
  large prompts in ai_providers.py are inline and unversioned.
- Retrieval: no vector index. pgvector is documented as roadmap in content.py.
- Automation: no scheduler platform; one asyncio retention loop and CI only.
- Local LLMs, fine-tuning, agent frameworks: none, and intentionally so.

The purpose of this PRD is to close the gaps that are genuinely valuable and
verifiable, and to explicitly decline the rest with a reason.

---

## 3. Goals and non-goals

### 3.1 Goals

1. Ship one production-quality MCP server with two transports.
2. Ship a live documentation page judges can open in one click.
3. Add a golden-set evaluation harness that measures prompt quality.
4. Version every prompt through a registry instead of file-name convention.
5. Keep all of the above read-only with respect to scores and answer keys.
6. Preserve 100% of current behaviour when flags are off.

### 3.2 Non-goals

- No change to how marks are computed. engine.py scoring stays authoritative.
- No model gains write access to attempts, marks or publication state.
- No new runtime dependency for the documentation page.
- No rewrite of the existing REST API surface.
- No change to the Meilisearch/Neo4j fallback behaviour.

---

## 4. Hard constraints (invariants)

These are non-negotiable and are copied from AGENTS.md. Every feature below is
reviewed against this list before merge.

1. Scores come only from engine.py using stored answer keys. No live AI grading.
2. No automatic fail or rejection from integrity flags.
3. engine.redact runs before any text reaches an LLM.
4. engine.public_question is the only serializer for question payloads.
5. No emotion, personality or demographic inference.
6. Curated or mock content stays labelled MOCK in the UI.
7. backend pytest must pass before any commit.

Two additional invariants are introduced by this PRD:

8. Every new capability is disabled unless its environment flag is explicitly
   enabled.
9. Any new module that imports main must do so lazily inside a function, the
   same pattern used by assessment_workflow.py.

---

## 5. Feature catalogue

| ID | Feature | Priority | Effort | Score impact |
|---|---|---|---|---|
| F1 | MCP server (stdio + Streamable HTTP) | P0 | 3 days | High |
| F2 | Live documentation module | P0 | 1 day | High |
| F3 | Golden-set evaluation harness | P1 | 2 days | Medium |
| F4 | Prompt registry and versioning | P1 | 1 day | Medium |
| F5 | MCP client / admin copilot | P1 | 2 days | Medium |
| F6 | pgvector hybrid retrieval | P2 | 3 days | Low-Medium |
| F7 | n8n operations automation | P2 | 1 day | Low |
| F8 | Prompt caching and token budget | P2 | 1 day | Low |

Recommended order: F2, F1, F3, F4, then F5-F8 as time allows. F2 first because
it is the cheapest and it makes every later feature legible to judges.

---

## 6. F1 - MCP server (skillbridge-knowledge)

### 6.1 Problem

The product has real, well-shaped tools (GraphRAG retrieval, skill extraction,
redaction, taxonomy validation) but exposes them only as authenticated REST
endpoints. No external agent can discover or call them.

### 6.2 Scope

One server, one tool registry, two transport bindings:

- stdio: for local hosts such as Claude Desktop or Cursor.
- Streamable HTTP: mounted on the existing FastAPI app at /mcp.

SSE is explicitly out of scope. It is a legacy transport and claiming it would
add risk without adding capability.

### 6.3 Tools (six)

| Tool | Backing function | Returns |
|---|---|---|
| search_questions(query, category_id, difficulty, limit) | Meilisearch, falling back to _topic_match | Public question fields only |
| get_blueprint(blueprint_id) | assessment_blueprints | Topics, counts, shortages |
| get_skill_coverage() | graphrag.skill_coverage | Covered/pending per skill |
| extract_skills(cv_text) | graphrag.extract_cv_skills | Canonical ids and evidence |
| redact_text(text) | engine.redact | Redacted text only |
| validate_skill_ids(ids) | content.TAXONOMY | Accepted and rejected ids |

### 6.4 Resources (two)

- skillbridge://taxonomy - the closed skill taxonomy
- skillbridge://coverage - the current coverage report

### 6.5 Security design

- Read-only by construction: no tool writes to the database.
- Answer-key isolation: every question payload is produced by
  engine.public_question. A contract test asserts that the strings "answer"
  and "ref" never appear as top-level keys in any tool response.
- Auth on HTTP: bearer token resolved through the existing current_user
  dependency, so MCP inherits session validity and MFA policy.
- stdio: local-only, bound to a read-only service identity.
- Rate limit: 60 calls per minute per token.
- Audit: one audit row per tool call (tool name, actor, duration, status).
  No argument payloads are logged, because arguments may contain CV text.
- PII: redact_text exists so hosts can redact before retrying. extract_skills
  redacts internally and refuses raw CV echo in errors.

### 6.6 Configuration

    MCP_ENABLED=false            # master switch, default off
    MCP_HTTP_PATH=/mcp
    MCP_TOKEN_TTL_SECONDS=3600
    MCP_RATE_LIMIT_PER_MIN=60

### 6.7 Files

- backend/mcp_server.py (new) - registry, stdio entrypoint, HTTP router
- backend/mcp_tools.py (new) - tool implementations, pure functions
- backend/main.py - one guarded include_router call
- backend/tests/test_mcp_server.py (new) - contract and isolation tests

### 6.8 Acceptance criteria

1. With MCP_ENABLED unset, the app boots and all existing tests pass unchanged.
2. stdio server starts, lists six tools and two resources.
3. HTTP transport responds at /mcp with a valid initialize handshake.
4. No tool output contains an answer or reference answer field.
5. Tools work with Meilisearch and Neo4j absent, using the SQL fallback.
6. Rate limit returns a structured error, not a stack trace.
7. Every tool call produces exactly one audit row.

---

## 7. F2 - Live documentation module

### 7.1 Problem

Judges have minutes, not hours. There is no single page that explains the
product, the architecture, the guardrails and the honest limitations. There is
also a route collision to fix.

### 7.2 Route decision

FastAPI already serves Swagger UI at /docs. Do not fight it:

- Move the API spec to /api/docs via FastAPI(docs_url="/api/docs",
  openapi_url="/api/openapi.json").
- Publish the product documentation at /docs.
- Add a permanent redirect from the old /docs Swagger path is not required;
  the API spec stays reachable at /api/docs and is linked from the docs page.

### 7.3 Content sections

1. What SkillBridge does, in three sentences.
2. Architecture diagram: browser, API, SQLite/Postgres, Meilisearch, Neo4j,
   LLM providers, with the deterministic boundary marked.
3. The assessment pipeline, from CV upload to published result.
4. The four-layer quality stack (regression suite, contract validation,
   ensemble with disagreement detection, human approval).
5. Guardrails and privacy, mapped to the AGENTS.md rules.
6. Provenance: data sources, models, limitations.
7. Built vs roadmap table, copied from README.md.
8. Links to traceability and SQA documents.

### 7.4 Implementation

- Static route serving a single HTML document, or a React route if the SPA
  router already owns everything.
- No new dependency. Inline SVG for the diagram.
- Content authored from existing docs/ files, not invented.
- Must render without JavaScript as a fallback, so a crawler sees the text.

### 7.5 Acceptance criteria

1. GET /docs returns 200 with the product page, not Swagger.
2. GET /api/docs returns Swagger UI.
3. The page states at least three limitations explicitly.
4. No claim on the page contradicts README.md line 141.

---

## 8. F3 - Golden-set evaluation harness

### 8.1 Problem

Prompt changes are currently validated by unit tests that mock the provider.
Nothing measures extraction quality against known-good inputs.

### 8.2 Scope

- A golden set of 40 synthetic CVs, each with expected skill ids and the
  supporting snippet. Synthetic only, so no real candidate data is stored.
- A runner that executes a prompt against the golden set and reports:
  precision, recall, evidence-match rate, and injection-resistance rate.
- A second report joining stored answer_evaluations with the AI draft marks:
  mean absolute difference and within-one-mark agreement rate.

### 8.3 Non-goals

- Not part of the blocking CI suite. Marked with pytest marker "eval" and run
  nightly or on demand, because it needs provider credentials.

### 8.4 Files

- backend/tests/goldens/cv/*.json (new, synthetic)
- backend/tests/eval_cv.py (new, opt-in runner)
- docs/EVAL_REPORT.md (generated, committed on each run)

### 8.5 Acceptance criteria

1. Runner produces a JSON and markdown report with the four metrics.
2. Runs with AI_PROVIDER unset by falling back to the rule-based extractor.
3. No golden file contains real personal data.
4. Report is published unedited, including bad numbers.

---

## 9. F4 - Prompt registry and versioning

### 9.1 Problem

Only one prompt is externalised. The two large prompts in ai_providers.py are
inline, unversioned, and impossible to diff meaningfully.

### 9.2 Scope

- Move the CV extraction SYSTEM_PROMPT and the learning-advice prompt into
  backend/prompts/ as v1 files.
- Add backend/prompts/manifest.json with id, version, file, sha256 and
  changelog per prompt.
- Add backend/prompts.py with get_prompt(id) that raises on unknown ids and
  verifies the sha256.
- Loader is cached with lru_cache so behaviour matches today.

### 9.3 Acceptance criteria

1. Loaded prompt text is byte-identical to the current inline constant
   (snapshot test on sha256).
2. get_prompt raises a clear error for an unknown id.
3. Changing a prompt file without updating the manifest fails a test.
4. skill_extract.v1.md keeps its existing header format.

---

## 10. F5 - MCP client / admin copilot (after F1)

### 10.1 Scope

A read-only internal client that consumes the F1 server, used by admins to ask
questions such as "which skills are under-covered for Hard difficulty". It can
only call the six tools; it cannot write.

### 10.2 Constraints

- Two tool calls maximum per interaction.
- No access to candidate CVs, answers or integrity evidence.
- Suggestions are advisory and must be rendered as such.

### 10.3 Acceptance criteria

1. Copilot output cites a tool call for every factual claim.
2. Attempting a write action fails closed.
3. Disabling MCP_ENABLED removes the copilot UI entirely.

---

## 11. F6 - pgvector hybrid retrieval (optional)

### 11.1 Problem

Keyword plus graph retrieval cannot match paraphrases. A CV saying "built
dashboards" will not retrieve visualization questions unless an alias exists.

### 11.2 Scope

- New table question_embeddings(question_id, embedding vector(N)).
- Embedding provider configurable, disabled by default.
- Retrieval fuses vector, keyword and graph results with the existing RRF
  function, extending _rrf_order rather than replacing it.

### 11.3 Constraints

- Postgres only. SQLite deployments keep the current path.
- VECTOR_RETRIEVAL=false by default. When off, code paths are untouched.

### 11.4 Acceptance criteria

1. With the flag off, retrieval output is byte-identical to today for the same
   input and seed. This is a regression test.
2. With the flag on, recall@10 improves on the F3 golden set, or F6 is not
   shipped.

---

## 12. F7 - n8n operations automation (optional)

### 12.1 Scope

A self-hosted n8n instance used only for operations:

- nightly question-bank reindex
- weekly coverage report email
- retention purge verification

### 12.2 Constraints

- No candidate PII enters n8n.
- No scoring or publication path is automated.
- n8n calls the same authenticated admin endpoints a human would.

### 12.3 Honest framing

This is optional. It does not improve the product, only the operational story.
Ship it only if the core features are complete.

---

## 13. F8 - Prompt caching and token budget

### 13.1 Scope

- Add provider-native prompt caching for the system prompt where supported
  (Anthropic cache_control), behind a flag.
- Centralise max_tokens and character caps into one settings module so they
  stop drifting between call sites.
- Emit a per-call token and latency line to the log without content.

### 13.2 Acceptance criteria

1. With caching off, request bodies are unchanged.
2. Cost per extraction measured before and after; no unverified claims.
3. No prompt text or CV content appears in logs.

---

## 14. Explicitly out of scope

| Capability | Decision | Reason |
|---|---|---|
| Fine-tuning / LoRA | Declined | No golden set to evaluate it; unmeasurable change |
| Local LLM runtimes | Declined | Hosted inference is cheaper at this volume |
| Agent frameworks | Declined | Fixed three-step pipeline; framework adds opacity |
| Agentic write access to scores | Forbidden | Violates invariant 1 |
| Visual app builders | Not a code change | Process claim only |
| Tunnelling tools | Dev-only | Not part of the shipped product |
| SSE transport | Declined | Legacy; Streamable HTTP is current |
| Second MCP server | Deferred | One well-built server beats two thin ones |

---

## 15. Non-regression strategy

R1. Additive only. New behaviour lives in new files. Edits to existing files
    are limited to guarded registration, a config read, and a route constant.

R2. Flags default off. Every feature is inert unless its environment variable
    is enabled in the deployment.

R3. Import hygiene. New modules import main lazily inside functions, matching
    assessment_workflow.py. No new module-level circular imports.

R4. Scoring untouched. engine.py scoring functions are not edited. A diff to
    engine.py outside validate_llm_skills fails review.

R5. Serializer monopoly. No new code path may build a question dict by hand.
    engine.public_question remains the only serializer.

R6. Test gate. The 148 existing tests must pass unchanged. New tests live in
    new files. CI coverage floor stays at 60 and may only be raised.

R7. Reversibility. Every feature can be turned off without a code change and
    without a database migration rollback, except F6 which adds a table.

R8. Review checklist. Each PR states which feature ID it implements and
    confirms R1-R7 in the description.

---

## 16. Security review checklist (MCP specific)

- Authentication enforced on the HTTP transport, not only at the host.
- Token scope limited to read; no tool performs a write.
- Rate limit per token, with a structured 429 response.
- Audit row per call, without argument payloads.
- No answer or reference answer in any response, enforced by test.
- Error messages never echo CV text, keys or provider bodies.
- stdio transport refuses to start when MCP_ENABLED is false.
- Denial-of-service bound: limit parameter clamped server-side, result caps.

---

## 17. Configuration additions

    # MCP (F1, F5)
    MCP_ENABLED=false
    MCP_HTTP_PATH=/mcp
    MCP_TOKEN_TTL_SECONDS=3600
    MCP_RATE_LIMIT_PER_MIN=60

    # Docs (F2)
    DOCS_PRODUCT_PAGE_ENABLED=true

    # Evaluation (F3)
    EVAL_GOLDEN_DIR=tests/goldens/cv

    # Vector retrieval (F6)
    VECTOR_RETRIEVAL=false
    EMBEDDING_PROVIDER=
    EMBEDDING_MODEL=

    # Caching (F8)
    PROMPT_CACHE_ENABLED=false

All defaults preserve current behaviour.

---

## 18. Test plan

| Area | Test | Type |
|---|---|---|
| F1 | tools listed over stdio | integration |
| F1 | no answer/ref key in any tool output | contract, blocking |
| F1 | works with Meili/Neo4j absent | integration |
| F1 | rate limit returns structured 429 | unit |
| F1 | app boots with MCP_ENABLED unset | regression |
| F2 | /docs is product page, /api/docs is Swagger | integration |
| F3 | runner emits four metrics | unit |
| F3 | golden files contain no PII | unit |
| F4 | prompt sha256 matches manifest | unit |
| F4 | unknown prompt id raises | unit |
| F6 | flag off produces identical retrieval | regression, blocking |

Definition of done: all new tests green, all existing tests green, coverage not
reduced, and a manual smoke test of the deployed build with every flag on.

---

## 19. Rollout plan

| Milestone | Content | Duration |
|---|---|---|
| M0 | Branch, flags, config docs, no behaviour change | 0.5 day |
| M1 | F2 documentation page and route split | 1 day |
| M2 | F1 stdio server, six tools, contract test | 2 days |
| M3 | F1 Streamable HTTP transport, auth, audit, rate limit | 1 day |
| M4 | F3 golden set and eval runner | 2 days |
| M5 | F4 prompt registry migration | 1 day |
| M6 | F5 admin copilot | 2 days |
| M7 | F6 pgvector behind flag | 3 days |
| M8 | F7 / F8 if time remains | 1-2 days |

Ship after M3. Everything after that is additive value.

---

## 20. Risk register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Answer key leaks through MCP | Low | Critical | public_question only, blocking contract test, read-only tools |
| Circular imports destabilise boot | Medium | High | lazy imports, guard flag, boot test in CI |
| Route clash on /docs | Certain | Low | move Swagger to /api/docs in the same PR |
| Prompt refactor changes behaviour | Medium | High | sha256 snapshot test, byte-identical requirement |
| Vector work delays shipping | Medium | Medium | P2, behind flag, dropped if recall does not improve |
| Scope creep into scoring | Medium | Critical | invariant review on every PR |
| Eval set contains real PII | Low | Critical | synthetic only, PII test in CI |

---

## 21. Success metrics

1. Existing suite: 148 tests pass, unchanged, on every milestone.
2. Boot time with all flags off: unchanged within 5%.
3. MCP: six tools discoverable, zero answer-key fields in output, audit row per
   call.
4. Documentation: one URL that explains the system in under five minutes, with
   limitations stated.
5. Evaluation: four metrics reported, published unedited.
6. Provenance: every claim on the docs page traceable to code or an existing
   document.

---

## 22. Scoring impact map

| Form section | Evidence this PRD creates |
|---|---|
| MCP usage | One server, two transports, six tools, two resources, reuse across two hosts |
| Data lifecycle | Documentation of sources, parsing, storage and governance |
| Evaluation and quality | Golden set, four metrics, agreement report |
| Prompt usage | Registry with versions, hashes and changelogs |
| RAG architecture | Optional vector upgrade with a measured gate |
| Workflow automation | Optional n8n for operations only |
| AI-DLC | AGENTS.md invariants carried into review checklist |

Items deliberately left at zero remain at zero, with a stated reason.

---

## 23. Open questions

1. Should the HTTP MCP transport be public, or admin-only behind the existing
   MFA policy? Recommendation: admin-only for R0.1.
2. Should the documentation page live in the SPA or be served statically?
   Recommendation: static with an SPA fallback, so crawlers and judges see text.
3. Do we ship the second MCP server (assessment) in this cycle? Recommendation:
   no.
4. Does F6 justify its cost before a golden set exists? Recommendation: no -
   sequence F3 before F6.

---

## 24. Appendix - file inventory

New files:

- backend/mcp_server.py
- backend/mcp_tools.py
- backend/prompts.py
- backend/prompts/manifest.json
- backend/prompts/cv_extract.v1.md
- backend/prompts/learning_advice.v1.md
- backend/tests/test_mcp_server.py
- backend/tests/eval_cv.py
- backend/tests/goldens/cv/*.json
- frontend/src/DocsPage.jsx (or static docs/index.html)
- docs/EVAL_REPORT.md

Modified files:

- backend/main.py - guarded MCP router include, docs_url change
- backend/ai_providers.py - load prompts via registry instead of constants
- .env.example - new flags, defaults preserving behaviour
- README.md - roadmap table updated only after each item ships

No changes to engine.py scoring logic, engine.public_question, or any existing
migration.
