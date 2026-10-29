# SkillBridge Global: R0 prototype

AI-native skill verification loop for one role (**Junior Data Analyst**):
**CV → skills → gap → adaptive SQL/MCQ test → learning path → re-test → Skill Passport**, with Bangla/English UI, consent screen, trust label and PII redaction.
Built from the *SkillBridge Global BRD & PRD v1.0* (Release **R0**, PRD §11) and the *SkillBridge BD* report.

- **Frontend:** React 18 + Vite (served by nginx)
- **Backend:** FastAPI + SQLite (single file DB in a Docker volume)
- **Run / deploy:** Docker Compose

## Run

```bash
cp .env.example .env          # set SECRET_KEY; ANTHROPIC_API_KEY is optional
docker compose up --build
# open http://localhost:8080      (API docs: http://localhost:8080/api/docs is not proxied; use http://localhost:8000 only in dev)
```

Dev without Docker:

```bash
cd backend && pip install -r requirements.txt && DB_PATH=./dev.db uvicorn main:app --reload      # :8000
cd frontend && npm install && npm run dev                                                         # :5173 (proxies /api)
```

Deploy on any VPS with Docker: clone, create `.env` (strong `SECRET_KEY`), `docker compose up -d --build`, put HTTPS (Caddy/Traefik/Cloudflare) in front of port 8080. Set `RETEST_COOLDOWN_HOURS=336` for the spec's 14-day cooldown (0 is for demos).

## Demo path (about 5 minutes)
1. Create account → accept consent. 2. **Use sample CV** → Analyse (see what was redacted) → confirm skills.
3. **Gap** shows the MOCK role vs. your claimed skills. 4. **Verify**: 10 adaptive questions (MCQ + hands-on SQL), server-timed.
5. Result with topic scores and trust label. 6. **Learn**: cited resources for weak topics. 7. **Re-test** → uplift. 8. **Passport**: choose skills, share link, revoke.

## What is real vs. mock (honest list)
| Area | R0 status |
|---|---|
| Server-side scoring from stored answer keys, adaptive difficulty | **Real** (`backend/engine.py`, unit-tested) |
| SQL sandbox (SELECT-only, authorizer, op limit, graded on 2 generated datasets) | **Real**, in-process SQLite. Python sandbox: not in R0 |
| PII redaction before AI | **Real** (regex + name heuristics; not perfect) |
| Skill extraction | Rule-based offline by default. **LLM path exists** (schema-validated, falls back to rules) and runs only if `ANTHROPIC_API_KEY` is set. Not exercised in CI |
| Trust label (paste, tab-blur, fast-perfect signals) | **Real**, never pass/fail; appeal is stored |
| Learning path | Curated index, topic/level retrieval with source + licence. **Not** pgvector RAG yet. Curator must verify links/licences |
| Skill Passport | **Real**: HMAC-signed, revocable, public verify page. Signature is server-secret HMAC, not public-key |
| Job profile, question pool (25 items), percentile | **MOCK / tiny**. Percentile intentionally not shown |
| Bangla | UI + explanations. Question text is English only |
| Not built (roadmap) | Recruiter/company/admin roles, camera proctoring, AI interviewer, MCP servers, pgvector, billing, SSO, virus scan |

## Layout
```
backend/   main.py (API) · engine.py (scoring, redaction, SQL sandbox) · content.py (taxonomy, questions, resources) · prompts/ · tests/
frontend/  src/App.jsx (all screens) · i18n.js (EN/BN) · styles.css · nginx.conf · Dockerfile
docker-compose.yml · .env.example · .github/workflows/ci.yml
```

## Tests
`cd backend && python -m pytest -q tests` covers redaction, SQL sandbox (including DROP and infinite recursion), grading on hidden datasets, adaptivity, retest freshness, trust label, learning-path honesty, signing.

## Compliance notes
Planning prototype, not legal advice. Confirm privacy/employment-AI obligations with counsel per market (BRD §12). Third-party resource terms must be checked before launch.
