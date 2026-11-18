# SkillBridge AI Agent Features — Spec

**Integrity Report Analyst + Question Assist Agent (additive, human-in-the-loop)**

| Field | Value |
|---|---|
| Document | AI_AGENT_FEATURES |
| Version | 1.0 |
| Date | 18 November 2026 |
| Status | P0–P1 implemented (backend); admin UI pending |
| Scope | Two agentic features: honesty/integrity summary (F-A), question assist (F-B) |
| Related | AGENTS.md, docs/MCP_ROADMAP.md, docs/MCP_IMPLEMENTATION_REPORT.md |

---

## 1. Summary

Two new, **additive** agent features, built without changing any existing
feature or the scoring path:

- **F-A — Integrity Report Analyst.** Reads the stored trust/integrity signals
  (AI flags + timing flags + event counts) for one attempt and produces a short,
  impactful, **advisory** summary for a human reviewer. It never changes a score
  and never fails anyone.
- **F-B — Question Assist Agent.** Detects where a candidate's CV-based skills
  have no approved questions, then **drafts** questions from (in order) a
  configured external MCP question bank, a web-search MCP, a configured LLM, or a
  deterministic authoring scaffold. Every draft is `pending_approval`; a human
  curator approves it before it ever enters the active question bank.

Both features are **flag-gated** and live in **new files**. Existing endpoints,
tables, scoring and the candidate flow are untouched.

### Implementation status (this build)

- **F-A:** implemented in `backend/agent_integrity.py` + `agent_llm.py`, exposed at
  `GET /api/admin/agent/integrity/{attempt_id}`, covered by
  `tests/test_agent_integrity.py`.
- **F-B:** implemented in `backend/agent_questions.py` (coverage, scaffold/LLM/MCP
  source chain, drafts, approve/reject), exposed under
  `/api/admin/agent/questions/*`, covered by `tests/test_agent_questions.py`.
- **Flags:** `AGENT_INTEGRITY_ENABLED`, `AGENT_INTEGRITY_LLM`,
  `AGENT_QUESTIONS_ENABLED`.
- **Admin UI panel:** not built yet (backend-only this milestone); the endpoints
  are ready for it.
- **Full suite:** 210 passed, 1 skipped (12 new agent tests).

---

## 2. Non-negotiables (from AGENTS.md)

1. Scores come only from `engine.py` + stored answer keys. No live AI grading.
2. No automatic fail/rejection from integrity signals — advisory only.
3. `engine.redact` before any text reaches an LLM.
4. `engine.public_question` remains the only question serializer for candidates.
5. No emotion/personality/demographic inference.
6. MOCK / AI-generated / imported content stays labelled.
7. `backend` pytest must pass before any commit.

Additional invariants:

8. Both features are disabled unless their env flag is enabled.
9. New modules import `main` / `enterprise` lazily inside functions.
10. F-B can only create **drafts**; nothing becomes scoreable without an explicit
    human approval that uses the existing question-bank insert path.

---

## 3. F-A — Integrity Report Analyst

### 3.1 Problem

The integrity data exists (event timeline, trust label, points, reasons, hard
flags, honesty score, AI signals, fast-answer timing) but a reviewer must read it
raw. Reviewers need a **short, defensible summary** that says what the signals
show — and explicitly what they do **not** prove.

### 3.2 Inputs (read-only)

| Source | Used for |
|---|---|
| `attempts.result` → `trust`, `trust_points`, `trust_reasons`, `trust_hard_flags`, `trust_rule_version` | The versioned trust label and its reasons |
| `events` (type, ts, metadata) | Event counts (clipboard, blur, tab hidden, fullscreen, screen share, heartbeat, AI signals) |
| `attempt_honesty_reviews` | Honesty score + human status |
| `admin_attempt_reviews` | Academic decision |
| `attempts.started/finished` | Exam duration and timing context |

### 3.3 Output schema

```json
{
  "attempt_id": "a1b2c3",
  "advisory": true,
  "risk_level": "low | medium | needs_review",
  "trust_label": "High trust | Medium | Needs review",
  "trust_points": 4.0,
  "rule_version": "phase2-v1",
  "honesty_score": 60,
  "honesty_status": "pending | approved | rejected",
  "academic_status": "pending_review | approved | invalidated",
  "headline": "4 advisory points from leave-window time and fast answers.",
  "summary": "Short 2-4 sentence, plain-language narrative.",
  "focus_points": [
    { "key": "leave_window", "label": "Left the exam window", "detail": "2 incidents, 3m 12s total", "points": 2 }
  ],
  "timing": { "exam_seconds": 1200, "fast_answers": 1, "leave_minutes": 3.2 },
  "flags": [],
  "recommendation": "Human review of the timeline; this is not proof of misconduct.",
  "source": "deterministic | llm",
  "generated_at": 1763500000.0,
  "note": "Advisory summary. It never changes scores and never fails an attempt."
}
```

### 3.4 Algorithm

1. Load the attempt, result, events, honesty review and academic review.
2. Build **deterministic focus points** from `trust_reasons`:
   - `external_clipboard`, `leave_window` (with duration), `fullscreen_exit`,
     `screen_share_stopped`, `wrong_share_surface`, `heartbeat_gap`, `fast`,
     and each `ai_*` / `identity_mismatch` / `microphone_stopped` signal.
3. Compute `timing` from the `fast` and `leave_window` reasons.
4. Compute `risk_level` from the deterministic rules already stored
   (`hard_flags` or `points >= 7` → `needs_review`; `points >= 3` → `medium`).
5. **Optional LLM narrative** (`AGENT_INTEGRITY_LLM=true` and a provider is
   configured): send only the redacted structured signals (no CV, no answers,
   no identity) and ask for a JSON `{headline, summary, recommendation}`.
   Instruct the model that this is advisory and must not assert misconduct.
   On any failure/timeout, keep the deterministic output.

### 3.5 API (new, admin only)

```
GET /api/admin/agent/integrity/{attempt_id}
```

Requires admin scope `integrity_review` (reuses `enterprise.admin_only`).

### 3.6 Guardrails

- Advisory only; no write, no score change, no auto-fail.
- No emotional/personality/demographic inference; describe events, not people.
- Never assert cheating. Use "review signal", "does not prove misconduct".
- Redact before any LLM call; never send answers, CV text or identity data.
- If the flag is off → `503 agent_disabled`.

### 3.7 Acceptance criteria

1. Summarises an attempt with events into the schema above.
2. `hard_flags` or `points >= 7` → `risk_level = needs_review`.
3. Two identical reads return the same deterministic output.
4. Works with no LLM configured (deterministic path).
5. Flag off → 503; non-admin → 403; unknown attempt → 404.
6. No candidate PII in the LLM payload (redacted).

---

## 4. F-B — Question Assist Agent

### 4.1 Problem

When a candidate confirms a CV skill that has no (or too few) approved questions,
the blueprint reports `question_bank_pending` and cannot assess that skill. The
agent should help a curator fill the gap — **without inventing an assessment at
exam time** and **without auto-activating anything**.

### 4.2 Source chain (first available wins)

1. **External MCP question bank** — `QUESTION_ASSIST_MCP_URL` (+ optional token /
   tool name). Uses the existing `mcp` client to call a `search_questions` /
   `find_questions` tool. Imported items keep their source URL.
2. **Web-search MCP** — `QUESTION_ASSIST_WEB_MCP_URL` (+ token). Finds public
   question sources; only URL + note is kept as provenance. Imported content is
   still a draft.
3. **Configured LLM** — uses the existing provider chain (Groq/Gemini/etc.).
   Generates a question from **skill + taxonomy + difficulty only** (no
   candidate PII) with a strict JSON schema: prompt, options, correct answer,
   explanation, reference answer, rubric, time allocation.
4. **Deterministic scaffold** — if nothing is configured, create an empty draft
   skeleton marked `needs_authoring` so a human can finish it. This guarantees
   the feature works with zero external dependencies and stays honest.

> No source is queried at exam time. Sources fill a **draft queue** only.

### 4.3 Coverage detection

Uses the existing `graphrag.skill_coverage(active_rows)`:
- `GET /api/admin/agent/question-coverage` → every taxonomy skill with
  `covered`, `active_questions`, `counts`, `missing`, `formats`.
- `GET /api/admin/agent/question-coverage/candidate/{user_id}` → the candidate's
  confirmed skills, each marked covered / pending, using the same canonical ids
  as the skill journey.

### 4.4 Draft storage (new additive table)

```sql
CREATE TABLE IF NOT EXISTS agent_question_drafts (
  id TEXT PRIMARY KEY,
  skill_id TEXT NOT NULL,
  category_id TEXT NOT NULL DEFAULT 'CAT-10',
  subcategory TEXT NOT NULL,
  question_type TEXT NOT NULL,
  difficulty_level TEXT NOT NULL,
  question_text TEXT NOT NULL,
  options TEXT NOT NULL DEFAULT '[]',
  correct_answer TEXT NOT NULL DEFAULT '',
  explanation TEXT NOT NULL DEFAULT '',
  reference_answer TEXT NOT NULL DEFAULT '',
  grading_rubric TEXT NOT NULL DEFAULT '',
  marks REAL NOT NULL DEFAULT 1,
  time_allocation INTEGER NOT NULL DEFAULT 60,
  status TEXT NOT NULL DEFAULT 'pending_approval',
  source TEXT NOT NULL DEFAULT 'scaffold',
  source_url TEXT NOT NULL DEFAULT '',
  provider TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  generated INTEGER NOT NULL DEFAULT 0,
  provenance TEXT NOT NULL DEFAULT '{}',
  validation TEXT NOT NULL DEFAULT '[]',
  created_by TEXT NOT NULL,
  created_at REAL NOT NULL,
  reviewed_by INTEGER,
  reviewed_at REAL
);
```

This table is created by the agent module (`CREATE TABLE IF NOT EXISTS`). It does
**not** alter `question_bank`. Drafts are invisible to the exam selector, which
only reads `question_bank.status = 'active'`.

### 4.5 API (new, admin only)

```
GET    /api/admin/agent/question-coverage
GET    /api/admin/agent/question-coverage/candidate/{user_id}
POST   /api/admin/agent/questions/draft            {skill, count, difficulty?}
GET    /api/admin/agent/questions/drafts
POST   /api/admin/agent/questions/drafts/{id}/approve
DELETE /api/admin/agent/questions/drafts/{id}
```

Requires admin scope `questions` (reuses `enterprise.admin_only`).

**Approve** is the only path into the bank. It:
1. Re-validates the draft (options/answer/rubric).
2. De-duplicates against `question_bank` by normalised text + category.
3. Inserts into `question_bank` with `status='active'`,
   `created_by='question-assist-agent'`.
4. Marks the draft `approved`, records `reviewed_by`/`reviewed_at`,
   and writes an audit row.

### 4.6 Validation rules

- MCQ: ≥ 2 options and a correct answer that matches one option.
- SQL: a non-empty `reference_answer`.
- Coding/Explanation/Scenario: a non-empty `reference_answer` and rubric.
- Reject empty prompt; clamp `marks` to 1–10 and `time_allocation` to 30–600s.
- Never store `answer`/`ref` in a candidate-facing payload (drafts are admin-only).

### 4.7 Guardrails

- Draft-only; nothing is scoreable until approved.
- AI-generated and external-imported content is labelled with `source`,
  `provider`, `model`, `generated`, `source_url`.
- No PII sent to any external source (skill + taxonomy only).
- Licence/source attribution is stored; the curator is responsible for verifying
  it before approval.
- Human-in-the-loop: the agent cannot approve its own drafts.
- Flag off → `503 agent_disabled`.

### 4.8 Acceptance criteria

1. Coverage endpoint reports per-skill gaps from the real bank.
2. Draft creation produces rows in `agent_question_drafts`, never in
   `question_bank`.
3. The exam selector still sees only active `question_bank` rows (drafts inert).
4. Approve inserts into `question_bank` once (idempotent-ish, de-duplicated) and
   audits the reviewer.
5. Reject/delete leaves the bank unchanged.
6. Works with no external source/LLM (scaffold path).
7. Flag off → 503; non-admin → 403.
8. Generated questions never appear in a candidate-facing payload before approval.

---

## 5. Configuration

```dotenv
# F-A
AGENT_INTEGRITY_ENABLED=false
AGENT_INTEGRITY_LLM=false

# F-B
AGENT_QUESTIONS_ENABLED=false
QUESTION_ASSIST_MCP_URL=
QUESTION_ASSIST_MCP_TOKEN=
QUESTION_ASSIST_MCP_TOOL=search_questions
QUESTION_ASSIST_WEB_MCP_URL=
QUESTION_ASSIST_WEB_MCP_TOKEN=
```

Defaults preserve current behaviour. Set the `*_ENABLED` flags to `true` to use.

---

## 6. Files

**New**
- `backend/agent_llm.py` — redacted JSON LLM helper (reuses provider config)
- `backend/agent_integrity.py` — F-A logic
- `backend/agent_questions.py` — F-B logic (coverage, sources, drafts, approve)
- `backend/agent_api.py` — admin router for both features
- `backend/tests/test_agent_integrity.py`
- `backend/tests/test_agent_questions.py`
- `docs/mcp-agent-console.png` (optional visual)

**Modified (minimal, additive)**
- `backend/main.py` — one guarded `include_router(agent_router)`
- `.env.example` — new flags
- (optional) admin UI panel to call the endpoints

**Not modified:** `engine.py`, `question_bank` schema, scoring, candidate flow.

---

## 7. Test plan

| Area | Test |
|---|---|
| F-A | summary schema for an attempt with events |
| F-A | hard flags → needs_review |
| F-A | deterministic output stable |
| F-A | flag off → 503; non-admin → 403; unknown → 404 |
| F-B | coverage reflects missing skills |
| F-B | draft creation writes drafts, not `question_bank` |
| F-B | active selector ignores drafts |
| F-B | approve inserts into bank + audits |
| F-B | reject leaves bank unchanged |
| F-B | validation rejects malformed drafts |
| F-B | flag off → 503; non-admin → 403 |

---

## 8. Rollout

| Phase | Content |
|---|---|
| P0 | agent_llm + integrity analyst + tests |
| P1 | question coverage + scaffold drafts + approve/reject + tests |
| P2 | external MCP / web-search sources (config-gated) |
| P3 | LLM question generation (config-gated) |
| P4 | admin UI panel + email/notification hooks |

Ship P0–P1 first: they are fully functional with no external services and prove
the human-in-the-loop path end to end.
