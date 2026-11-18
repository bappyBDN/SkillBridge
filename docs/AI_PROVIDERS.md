# AI Providers — Groq → DeepSeek → Gemini

**Secondary model, complex-task routing and a small spend guard**

| Field | Value |
|---|---|
| Document | AI_PROVIDERS |
| Version | 1.0 |
| Date | 18 November 2026 |
| Status | Implemented (additive) |
| Related | AGENTS.md, docs/AGENT_PLATFORM.md, docs/AI_AGENT_FEATURES.md |

---

## 1. What changed

Nothing in the existing scoring or candidate flow. Two additive capabilities:

1. **DeepSeek as the secondary provider.** If Groq is rate-limited, out of
   quota, or errors, existing AI calls automatically try DeepSeek next.
2. **Complex-task routing + a spend guard.** New agent LLM calls (question
   generation, integrity analysis) prefer DeepSeek, and a small ledger stops
   spending when the configured budget is used.

---

## 2. Provider order

```dotenv
AI_PROVIDER=groq
AI_PROVIDER_FALLBACKS=deepseek,gemini
AI_COMPLEX_PROVIDER=deepseek
```

- **Simple / existing calls** (CV extraction, learning advice) use the order
  `groq → deepseek → gemini`. The existing `ai_providers.extract_cv_profile`
  loop already rotates through this order on HTTP 429/5xx or any provider error,
  so **no code change is needed for Groq-limit failover**.
- **Complex agent calls** (`complexity="complex"`) use
  `deepseek → groq → gemini`.

---

## 3. Enabling DeepSeek

Add your key to `.env` (single key or a comma-separated rotation list):

```dotenv
DEEPSEEK_API_KEYS=sk-...your-deepseek-key...
# or DEEPSEEK_API_KEY=sk-...
DEEPSEEK_MODEL=deepseek-flash
AI_COMPLEX_PROVIDER=deepseek
```

- `DEEPSEEK_MODEL` defaults to `deepseek-flash` here. DeepSeek's public API also
  exposes `deepseek-chat`; if your account rejects `deepseek-flash`, set
  `DEEPSEEK_MODEL=deepseek-chat`.
- Keys stay on the backend only. Never put them in frontend/Vite variables.
- With no key set, DeepSeek is skipped and Gemini remains the fallback — nothing
  breaks.

---

## 4. Spend guard (the $2 budget)

New additive table: `ai_usage_ledger`
(`provider, model, tokens_in, tokens_out, est_cost_usd, purpose, created_at`).

```dotenv
AI_MONTHLY_BUDGET_USD=2
AI_BUDGET_WINDOW_DAYS=60
```

- Before an agent LLM call, the projected cost is checked against the remaining
  window budget. If it would exceed the limit, the call is skipped and the agent
  falls back to its **deterministic** output (which always works).
- After a successful call, an estimated cost is recorded.
- `GET /api/agent/status` exposes `ai_budget`:
  `{limit_usd, spent_usd, remaining_usd, window_days, exhausted, providers}`.
- Prices are **estimates** and overridable:

```dotenv
AI_PRICE_DEEPSEEK_INPUT_PER_1M=0.27
AI_PRICE_DEEPSEEK_OUTPUT_PER_1M=1.10
AI_PRICE_GROQ_INPUT_PER_1M=0.15
AI_PRICE_GROQ_OUTPUT_PER_1M=0.60
```

> $2 is a conservative demo budget. The ledger is an estimate, not an invoice —
> check the provider dashboards for authoritative spend.

### 4.1 Billing visibility (Admin → Billing)

The Admin Billing page embeds `frontend/src/AiUsagePanel.jsx`, which reads the
existing `/api/agent/status` payload (`ai_budget`) and renders:

- estimated AI spend for the window and the remaining budget;
- total tokens in / out;
- a per-provider table (tokens, estimated cost, share of spend);
- a "budget paused" notice when the limit is reached.

It is read-only: it never calls a provider or edits an invoice. The screenshot is
`docs/admin-billing-ai.png`. This gives finance/ops a single place to see how much
of the $2 budget the copilot and CV extraction have used, broken down by provider.

---

## 5. What routes where

| Call | Order | Why |
|---|---|---|
| CV profile extraction (existing) | groq → deepseek → gemini | unchanged logic; failover only |
| Learning advice (existing) | groq → deepseek → gemini | unchanged |
| Agent question generation | **deepseek** → groq → gemini | complex |
| Agent integrity narrative | **deepseek** → groq → gemini | complex |
| Agent application/feedback polish | groq → deepseek → gemini | simple |

All agent features still work **without any provider** (deterministic paths).

---

## 6. Files

**New**
- `backend/ai_routing.py` — provider order, price estimates, spend ledger/guard
- `backend/tests/test_ai_routing.py`
- `frontend/src/AiUsagePanel.jsx` — Admin Billing AI usage panel
- `docs/admin-billing-ai.png` — screenshot of the billing panel

**Modified (additive only)**
- `backend/agent_llm.py` — `complexity` routing, budget check, usage recording
- `backend/agent_questions.py` — question generation requests `complexity="complex"`
- `backend/agent_integrity.py` — integrity narrative requests `complexity="complex"`
- `backend/agent_console_api.py` — `ai_budget` in `/api/agent/status`
- `frontend/src/App.jsx` — mounts the AI usage panel in the Billing tab
- `.env` / `.env.example` — fallback order, DeepSeek model, budget vars

**Unchanged:** `ai_providers.py` logic, `engine.py`, scoring, candidate flow.

---

## 7. Tests

`backend/tests/test_ai_routing.py` (6 tests): simple/complex order, cost
estimate, ledger sum, budget exhaustion, and a mocked call proving complex tasks
try DeepSeek first.

Full suite: **224 passed, 1 skipped**.
