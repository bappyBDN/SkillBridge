# Operations runbook

How SkillBridge / TalentForge is deployed, configured, monitored, backed up and
scaled. Rules in `AGENTS.md` still apply (every exam is proctored; no automatic
fail from integrity flags; scores only from `backend/engine.py`).

## 1. Deployment topology

| Piece | Hosted on | Config | Notes |
|---|---|---|---|
| React SPA | Vercel (root directory `frontend`) | `frontend/vercel.json`, env `VITE_API_BASE_URL` | Static build. Security headers, SPA rewrite and asset caching come from `vercel.json`. |
| FastAPI API | Render web service (Docker) | `render.yaml`, `backend/Dockerfile`, `backend/start.sh` | `uvicorn serve:app`. Free plan: one instance, sleeps when idle. |
| Database | Neon PostgreSQL | `DATABASE_URL` (Render dashboard, `sync: false`) | Source of truth for users, attempts, question bank, CVs/photos (`STORAGE_BACKEND=database`). |
| Self-host option | Any Docker host | `docker-compose.yml` (Neon or `--profile localdb` Postgres), `docker-compose.sqlite.yml` | nginx (`frontend/nginx.conf`) serves the SPA and proxies `/api` and `/mcp` to the backend on one origin. |
| Single-container option | Any Docker host | root `Dockerfile` | Builds the SPA into the API image; `serve.py` serves both. |

Request path on the hosted stack: browser -> Vercel (SPA) and browser -> Render
router -> uvicorn (API, cross-origin, allowed by `CORS_ORIGINS`).

## 2. Environment variables

`.env.example` is the reference for every variable. The operationally important ones:

| Variable | Default | Purpose |
|---|---|---|
| `ENV` | `development` | Set `production` on every public host (MFA for privileged roles, no demo seeding, strict secret checks). |
| `SECRET_KEY` | none | Signs sessions and Skill Passports. At least 32 random characters. The app refuses the placeholder in production. Render generates it (`generateValue: true`). |
| `DATABASE_URL` | empty (SQLite) | Neon connection string with `sslmode=require`. Never commit. |
| `STORAGE_BACKEND` | `database` | `database` (bytes in Postgres), `local` (volume only), `s3` (S3-compatible bucket). Never `local` on Render: the disk is wiped each deploy. |
| `PG_POOL_MAX` | `10` | psycopg pool max size per worker. |
| `WEB_CONCURRENCY` | `1` | uvicorn worker processes (`start.sh`). |
| `TRUSTED_PROXY_HOPS` | `1` | How many proxies' `X-Forwarded-For` entries to trust when deriving the client IP (rate limits, audit). `1` for Render or the compose nginx; `0` if the API is exposed directly. |
| `FORWARDED_ALLOW_IPS` | `127.0.0.1` | Passed to `uvicorn --forwarded-allow-ips`. `render.yaml` and compose set `*` because the container is only reachable through the proxy. With `*` uvicorn believes the left-most forwarded address, so the app's own IP logic must use `TRUSTED_PROXY_HOPS`, not `request.client`. |
| `SEED_QUESTION_BANK_ON_BOOT` | `true` | `true`: run the idempotent GraphRAG seed every start. `false` (Render): seed only when the active bank is empty. |
| `UNLIMITED_EXAM_EMAILS` | empty | Local QA retake exemption. Ignored when `ENV=production`. |
| `AI_MONTHLY_BUDGET_USD` / `AI_BUDGET_WINDOW_DAYS` | `2` / unset | AI spend guard. Unset window = current calendar month; a number = rolling N days. |
| `EVIDENCE_RETENTION_DAYS` | `30` | Exam alert snapshot expiry, clamped to 1-90. |
| `CORS_ORIGINS` | localhost | Exact frontend origins, comma-separated. Add custom Vercel domains here. |
| `SPACY_MODEL` | `blank:en` on Render | No trained model is installed in the image; `blank:en` is the deterministic tokenizer. |

Provider keys (`GROQ_API_KEYS`, `GEMINI_API_KEYS`, `DEEPSEEK_*`, ...) live only on
the backend. Nothing secret goes into `VITE_*` variables: they are compiled into
the public bundle.

## 3. Health vs readiness

- `GET /api/health` - liveness. Cheap, no database round trip. Used by Render's
  `healthCheckPath`, the Docker `HEALTHCHECK`s and compose healthchecks. A failing
  liveness check restarts the container, so it must not depend on Neon (a Neon
  cold start would otherwise cause restart loops).
- `GET /api/ready` - readiness. Returns `503` when the database is unreachable.
  Point external uptime monitoring and alerting at it (e.g. a 1-minute check
  that pages after 3 consecutive failures). On Render's free plan expect the
  first request after idle to be slow (instance spin-up plus Neon compute
  resume).

## 4. Quality gates (CI)

`.github/workflows/ci.yml` runs on every push and pull request (older runs on
the same ref are cancelled):

1. `backend-tests`: installs `backend/requirements.txt`, compiles, runs
   `pytest` with a coverage gate (`--cov-fail-under`, set a few points below the
   measured total; raise it as coverage grows, never above the measured value).
2. `web`: `npm ci`, `npm run lint`, `npm test` (node unit tests), `npm run build`.
3. `e2e`: Playwright (Chromium, desktop + mobile projects). The config starts its
   own Vite server on `PW_PORT`; the specs mock the API. Traces/screenshots are
   uploaded on failure.
4. `dependency-audit`: `pip-audit` and `npm audit --audit-level=high`.
   Non-blocking: read the job log and fix or document findings.

Local equivalents are in `docs/LOCAL_DEVELOPMENT.md`.

## 5. Backups and restore

**Neon point-in-time restore (primary).** Neon keeps WAL history for the
project's history-retention window (plan dependent; check *Project settings ->
Storage*). Set it to at least 7 days for production. To recover from a bad
deploy or accidental delete, create a branch from a timestamp before the
incident, verify it, then either point `DATABASE_URL` at the branch or restore
the parent branch from it.

**Periodic logical dump (secondary, off-Neon).** PITR does not protect against
losing the Neon project or account. Take a nightly `pg_dump` to storage you
control:

```bash
# Run from a trusted machine or a scheduled job; DATABASE_URL from a secret store.
pg_dump "$DATABASE_URL" --format=custom --no-owner --no-privileges \
  --file "skillbridge-$(date -u +%Y%m%dT%H%MZ).dump"
# Encrypt before upload (the dump contains PII, CV bytes and exam evidence).
gpg --symmetric --cipher-algo AES256 skillbridge-*.dump
```

Keep 14 daily + 8 weekly copies, encrypted, with access limited to operators.
Expired dumps must be deleted so retention promises (section 6) still hold.

**Restore drill (quarterly, and after schema changes).**

1. Create an empty Neon branch or a local `postgres:16` container
   (`docker compose --profile localdb up db`).
2. `pg_restore --no-owner --no-privileges --dbname "$RESTORE_URL" skillbridge-<ts>.dump`
3. Start the backend against it with `ENV=development`, `SEED_DEMO=false`,
   `SEED_QUESTION_BANK_ON_BOOT=false` and a throwaway `SECRET_KEY`
   (passport signatures will not verify with a different key; that is expected).
4. Check `GET /api/ready` is 200, row counts of `users`, `attempts`,
   `question_bank`, `cv_files` match the source, and an admin can open a
   candidate record and a CV.
5. Record the time taken (RTO) and the dump age (RPO); delete the restore copy.

## 6. Data retention

| Data | Current behaviour | Gap / action |
|---|---|---|
| Exam evidence snapshots (`exam_evidence`) | Expire after `EVIDENCE_RETENTION_DAYS` (1-90, default 30); an hourly background loop deletes expired rows. | Runs inside the API process; on the free plan it only runs while the instance is awake. Expired rows are deleted on the next wake. |
| CV documents | Per-user pruning keeps the newest `KEEP_CV_DOCUMENTS_PER_USER` (default 3); account deletion removes `cv_files`, extractions and stored files. | No time-based expiry for inactive accounts. Define a policy (e.g. delete CVs N months after last login) before production. |
| Stored files (originals, profile photos) | Kept until replaced/pruned or account deletion. | Same gap as CVs; with `s3`, also add a bucket lifecycle rule for orphaned objects. |
| Audit log (`audit`, admin audit logs) | Kept indefinitely. | Decide a retention period (commonly 1-2 years) and add a purge job; audit rows must not be editable by app users. |
| Backups | Section 5. | Dumps keep deleted data until they age out; document this in the privacy notice. |

## 7. Content-Security-Policy maintenance

The same policy is served by `frontend/vercel.json` (hosted) and
`frontend/nginx.conf` (self-hosted). Current hosted policy:

```
default-src 'self';
script-src 'self' 'wasm-unsafe-eval' 'unsafe-eval' https://cdn.jsdelivr.net;
style-src 'self' 'unsafe-inline' https://fonts.googleapis.com;
font-src 'self' data: https://fonts.gstatic.com;
img-src 'self' data: blob:;
media-src 'self' blob: mediastream:;
connect-src 'self' https://skillbridge.onrender.com https://storage.googleapis.com https://cdn.jsdelivr.net;
worker-src 'self' blob:;
frame-src 'self' blob:;
object-src 'self' blob:;
frame-ancestors 'none'; base-uri 'self'; form-action 'self'
```

Why each non-`'self'` source exists:

- `https://cdn.jsdelivr.net` (script + connect): the code workspace loads Pyodide
  (`CodeWorkspace.jsx`) inside a blob Web Worker; workers created from `blob:`
  inherit the page's CSP.
- `'unsafe-eval'`: the JavaScript runner in the code workspace executes candidate
  code with `new Function` inside a blob worker, which inherits this policy.
  Remove it once that runner moves to a same-origin worker file (or sandboxed
  iframe) served with its own policy. `'wasm-unsafe-eval'` covers MediaPipe,
  tfjs/face-api and Pyodide WebAssembly.
- `https://storage.googleapis.com` (connect): MediaPipe face/object models
  (`proctorModels.js`). Self-hosting the models under `public/` would let you
  drop it.
- Google Fonts (`index.html`): `fonts.googleapis.com` (style) and
  `fonts.gstatic.com` (font).
- `blob:` / `mediastream:`: camera/screen previews, avatars, CV PDF preview
  iframe, downloads. `object-src 'self' blob:` instead of `'none'` because the
  blob PDF preview inherits the policy and Chromium's PDF viewer is an embedded
  plugin; tighten to `'none'` only after confirming CV preview still renders.
- `'unsafe-inline'` in `style-src`: React `style={...}` attributes. Scripts stay
  inline-free.
- `public/agent-console.html` (standalone fallback) has an inline script and is
  given its own policy with `script-src 'self' 'unsafe-inline'` in both files.

**Changing the API origin.** On Vercel the SPA calls the API cross-origin, so
the API origin must be in `connect-src`. If the backend moves (custom domain,
new Render service name), update `VITE_API_BASE_URL` in Vercel **and** replace
`https://skillbridge.onrender.com` in the `connect-src` of both CSP entries in
`frontend/vercel.json`, add the new frontend origin to `CORS_ORIGINS` on the
backend, then redeploy both. Symptoms of a mismatch: every API call fails with
`Refused to connect ... violates the following Content Security Policy
directive: "connect-src ..."` in the browser console. The compose/nginx setup
proxies `/api` same-origin, so `'self'` is enough there.

**Adding a new third-party resource.** Add the narrowest origin to the matching
directive in both files, load the affected screen with DevTools open, and check
for CSP violations (proctoring check, code workspace in Python and JavaScript,
CV preview, avatar upload). To trial a change without breaking users, ship it
first as `Content-Security-Policy-Report-Only` alongside the enforced header.

Other headers: HSTS (1 year, includeSubDomains), `X-Content-Type-Options:
nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy:
strict-origin-when-cross-origin`, and `Permissions-Policy` allowing camera,
microphone, display-capture and fullscreen for `self` only (all required by the
proctored exam). Do not remove those four permissions.

## 8. Rotating SECRET_KEY

`SECRET_KEY` signs login sessions and Skill Passport HMACs. Rotating it:

- logs every user out (sessions become invalid), and
- invalidates the signature of every previously issued Skill Passport link.

Rotate immediately if the key may have leaked. Otherwise schedule it:

1. Generate a new key: `python -c "import secrets;print(secrets.token_urlsafe(48))"`.
2. Announce a short maintenance window; tell candidates passports will need to
   be re-shared (or re-issue them from the admin console after rotation).
3. Set the new value in Render -> Environment (and in your secret store), redeploy.
4. Verify sign-in, MFA, and that a newly issued passport verifies.
5. Never commit the key and never reuse the `.env.example` placeholder; the app
   refuses it in production.

## 9. Scaling notes

- **Workers.** `WEB_CONCURRENCY` uvicorn processes. Each one runs its own copy of
  the startup background loops (hourly evidence purge, notifications) and its
  own Postgres pool. The loops are idempotent, so more workers is safe but
  wasteful; keep 1 on the free plan (512 MB RAM).
- **Pool size vs threadpool.** Sync FastAPI endpoints run in AnyIO's threadpool
  (40 threads by default). Each in-flight DB request holds a pool connection, so
  with `PG_POOL_MAX` below the thread count, extra requests queue for a
  connection rather than opening new ones. Total connections =
  `WEB_CONCURRENCY x PG_POOL_MAX`; keep it below the Neon limit (use Neon's
  pooled `-pooler` host for many workers).
- **Instances.** Multiple Render instances work for the API itself, but each runs
  the background loops and the boot seed. Set `SEED_QUESTION_BANK_ON_BOOT=false`
  and keep `STORAGE_BACKEND` at `database` or `s3` (never `local`).
- **Free plan.** Sleeps when idle; background loops pause while asleep; the
  first request after idle pays the spin-up. Move to a paid instance before real
  exams so heartbeats and timers are not affected by cold starts.
- **Proxies.** If you put Cloudflare or another proxy in front of Render, raise
  `TRUSTED_PROXY_HOPS` to match the number of proxies that append to
  `X-Forwarded-For`, otherwise rate limits and audit IPs see the proxy.
