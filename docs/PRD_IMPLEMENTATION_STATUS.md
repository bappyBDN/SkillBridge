# PRD implementation status

## Delivered in feature/prd-postgres-enterprise
- PostgreSQL 16 is the default Docker Compose database, with a health check and persistent volume.
- FastAPI database helpers support PostgreSQL through psycopg 3 and retain SQLite fallback for engine tests.
- Candidate/company role selection at registration; admin is not self-assignable.
- Company profile, job publishing, candidate applications and opt-in result sharing APIs.
- Recruiter application list is company-scoped; assessment scores are omitted unless the candidate opted in.
- Admin-only overview, user list and company-specific assessment request list.
- Idempotent synthetic demo seed for candidate, recruiter, admin and three explicitly mock jobs.
- Existing skill-assessment journey remains available to candidates.

## Next implementation slices
1. Add Alembic migrations, authorization tests, rate limits, email verification and structured error handling.
2. Build normalized CV profile editing, OCR fallback and extraction confidence.
3. Add admin score-review queue, immutable official results and candidate appeals.
4. Add a DeepSeek provider adapter, PII-redaction tests and optional pgvector RAG.
5. Add payment-provider abstraction and idempotent webhook handling for paid retakes.
6. Add safe isolated code execution, backups, observability, accessibility and privacy/legal review.

## Safety and correctness decisions
- Integrity events are review signals, not proof of cheating or automatic failure.
- No inference of honesty, ability, personality or intent from facial expression, voice tone, blinking or demographic traits.
- Candidate result sharing is opt-in and revocable.
- Seeded identities, companies and jobs are synthetic and labelled as demo content.
- Demo credentials are unsuitable for production. Disable SEED_DEMO on public deployments.
