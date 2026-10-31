# SkillBridge Global: R0 prototype

AI-native skill verification loop for one role (**Junior Data Analyst**):
**CV → skills → gap → adaptive SQL/MCQ test → learning path → re-test → Skill Passport**, with Bangla/English UI, consent screen, trust label and PII redaction.
Built from the *SkillBridge Global BRD & PRD v1.0* (Release **R0**, PRD §11) and the *SkillBridge BD* report.

- **Frontend:** React 18 + Vite (served by nginx)
- **Backend:** FastAPI + PostgreSQL 16 (Docker volume); SQLite remains available for lightweight local engine tests when DATABASE_URL is unset
- **Run / deploy:** Docker Compose

## Run

```bash
cp .env.example .env          # change SECRET_KEY and POSTGRES_PASSWORD outside local demos
# Docker Compose wires the backend to PostgreSQL
docker compose up --build
# open http://localhost:8080   (health check: http://localhost:8080/api/health)
```

Dev without Docker:

```bash
cd backend && pip install -r requirements.txt && DB_PATH=./dev.db uvicorn main:app --reload      # :8000
cd frontend && npm install && npm run dev                                                         # :5173 (proxies /api)
```

Deploy on any VPS with Docker: clone, create `.env` (strong `SECRET_KEY`), `docker compose up -d --build`, put HTTPS (Caddy/Traefik/Cloudflare) in front of port 8080. Set `RETEST_COOLDOWN_HOURS=336` for the spec's 14-day cooldown (0 is for demos).

## Deploy on Render (one click)

The repo has a `render.yaml` Blueprint plus a single-container `Dockerfile` that serves the built frontend and the API from one process.

1. Push this repo to GitHub.
2. Render dashboard → **New → Blueprint** → connect the GitHub repo. Render reads `render.yaml` and creates one **web service** (free plan).
3. During setup, Render asks for the optional `ANTHROPIC_API_KEY` (leave empty to use the offline rule-based skill extractor). `SECRET_KEY` is auto-generated.
4. On first deploy the container **seeds a demo account** (`SEED_DEMO=true`):

   - **Email:** `demo@skillbridge.test`
   - **Password:** `demo12345`

   That account already has a consented profile, a pre assessment (55%), a post assessment (92%) with uplift, and a valid Skill Passport — so every screen is populated. Create a fresh account to walk the full flow yourself.

Notes:
- `healthCheckPath` is `/api/health`.
- Free plan: the SQLite DB lives on the instance's ephemeral disk, so it resets on each redeploy (the demo account is re-seeded automatically). Add a persistent disk or Render Postgres for real persistence.
- Free services sleep after ~15 min idle and wake on the next request (a short cold start).
- Set `RETEST_COOLDOWN_HOURS=336` in Render's environment to enforce the spec's 14-day re-test cooldown (it is `0` for demos).

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


## PRD implementation branch: PostgreSQL + hiring workflow

Branch: feature/prd-postgres-enterprise

This branch adds a PostgreSQL 16 service, persistent storage, a health check, a psycopg-backed database adapter (SQLite fallback for engine tests), and the first company/job/application API slice.

### Hiring API slice
- Candidate and company account roles; public registration cannot assign the admin role.
- Company profile and job publishing.
- Candidate job applications and opt-in, revocable sharing of assessment results with the employer.
- Recruiter application listing; assessment scores are omitted unless the candidate has opted in.
- Admin-only overview, user list and company-specific assessment request list.

### Synthetic demo data
When SEED_DEMO=true, synthetic demo accounts are seeded (password demo12345):
- Candidate: demo@skillbridge.test
- Recruiter: recruiter@skillbridge.test
- Admin: admin@skillbridge.test

Demo jobs are explicitly marked MOCK and are not real vacancies. These credentials are local-demo-only; do not enable public demo accounts in production.

### Known remaining PRD work
This is an initial vertical slice, not a completed production platform. Alembic migrations, complete authorization/security tests, DeepSeek provider integration, pgvector RAG, payment webhooks, official score review, OCR fallback, hardened code execution and end-to-end production deployment remain future work.


## Candidate workspace UI

The candidate experience now has a dedicated responsive workspace with:
- Overview dashboard and progress cards.
- Editable professional profile: headline, contact/location, summary, LinkedIn/GitHub/portfolio.
- Repeatable education, experience and project entries.
- Job-search preferences (employment type, work mode and locations).
- CV upload/analysis and skill confirmation, preserving the existing skill-verification journey.
- Job marketplace search/filter, applications list and candidate-controlled assessment-result sharing.
- Skill Gap, assessment, learning path, re-test, Skill Passport, and data export/deletion sections.
- Responsive desktop/mobile navigation and explicit MOCK labelling for synthetic jobs.

Candidate profile fields are persisted through `/api/candidate/profile` and the `candidate_profiles` PostgreSQL table. This is still an implementation milestone: verify the full PostgreSQL runtime, authorization, browser accessibility and end-to-end flows before production use.
