# TalentForge Global: R0 prototype

AI-native skill verification loop for one role (**Junior Data Analyst**):
**CV → skills → gap → adaptive SQL/MCQ test → learning path → re-test → Skill Passport**, with Bangla/English UI, consent screen, trust label and PII redaction.
Built from the *TalentForge Global BRD & PRD v1.0* (Release **R0**, PRD §11) and the *TalentForge BD* report.

- **Frontend:** React 18 + Vite (Vercel in the hosted deployment; nginx for self-hosting)
- **Backend:** FastAPI + PostgreSQL (Neon in the hosted deployment, or the optional local Postgres 16 container); SQLite is used for tests and lightweight local runs when `DATABASE_URL` is unset
- **Run / deploy:** Vercel + Render + Neon (hosted), or Docker Compose (self-hosted). Operations runbook: [`docs/OPERATIONS.md`](docs/OPERATIONS.md)

## Run

```bash
cp .env.example .env          # SECRET_KEY must be >= 32 random chars outside local demos; change POSTGRES_PASSWORD
# Docker Compose wires the backend to PostgreSQL
docker compose up --build
# open http://localhost:8080   (health check: http://localhost:8080/api/health)
```

Dev without Docker:

```bash
cd backend && pip install -r requirements.txt && DB_PATH=./dev.db uvicorn main:app --reload      # :8000
cd frontend && npm install && npm run dev                                                         # :5173 (proxies /api)
```

For scanned PDF CVs when running the backend outside Docker, install Tesseract OCR and the language packs listed by `TESSERACT_LANG` (defaults to `eng+ben`). Docker installs English and Bangla packs for you.

Deploy on any VPS with Docker: clone, create `.env` (strong `SECRET_KEY`), `docker compose up -d --build`, put HTTPS (Caddy/Traefik/Cloudflare) in front of port 8080. Set `RETEST_COOLDOWN_HOURS=336` for the spec's 14-day cooldown (0 is for demos).

## Deploy: Vercel frontend + Render API

The frontend and FastAPI backend are separate deployments. The Vercel project should use the `frontend` directory (`frontend/vercel.json` adds the security headers, SPA rewrite and asset caching); Render runs the API; the database is an external Neon PostgreSQL project. Topology, backups and scaling: [`docs/OPERATIONS.md`](docs/OPERATIONS.md).

### 1. Deploy the backend on Render

1. Open Render Dashboard → **New → Blueprint** and connect this repository. Render reads the root `render.yaml`.
2. Review the resources before confirming. The Blueprint creates a single Render web service on the free plan (it may sleep when idle). It does **not** create a database: set `DATABASE_URL` to your Neon connection string (`...?sslmode=require`) in the Render dashboard.
3. The backend service uses `backend/Dockerfile`, uses `/api/health` as its liveness check (`/api/ready` additionally checks the database), generates `SECRET_KEY`, and allows the current Vercel origin through CORS.
4. Wait for the Render service to finish deploying. Its default URL is `https://skillbridge.onrender.com`. Verify `https://skillbridge.onrender.com/api/health` returns JSON with `"ok": true`.

### 2. Connect the Vercel frontend

In Vercel → TalentForge project → **Settings → Environment Variables**, add:

- **Name:** `VITE_API_BASE_URL`
- **Value:** `https://skillbridge.onrender.com`
- **Environments:** Production, Preview, and Development as needed.

Keep **Root Directory** set to `frontend`. Redeploy the Vercel project so Vite includes the new build-time variable. The frontend API client now prefixes every `/api` request with this origin. If you use a custom Vercel domain, add that exact origin to Render's `CORS_ORIGINS` environment variable (comma-separated), then redeploy the backend.

### 3. Create your Super Admin account

After the Render backend is live, open the service's **Shell** and run:

```bash
cd /app
python create_admin.py
```

Enter your own email and a unique password of at least 8 characters when prompted. Do not put the password in source code or commit it. Then sign in from the Vercel site; the Admin Console is shown for the provisioned admin account.

> 🔐 On production (`ENV=production`) admins and company owners must enable two-factor authentication: open **Security & MFA** in the console, add the secret to an authenticator app and confirm a 6-digit code. Otherwise privileged endpoints return `mfa_enrollment_required`. The same screen lists active sessions and can revoke any of them.

> ✅ `SEED_DEMO` is `false` in `render.yaml` and both seeders refuse to run when `ENV=production`. Demo credentials are generated per deployment and are never committed (SB-006).

### 4. Production settings

- Keep `SECRET_KEY` generated and stable; do not rotate it casually because it signs active login tokens and Skill Passports.
- Keep `DATABASE_URL` connected to Neon PostgreSQL. Do not use SQLite on an ephemeral web-service filesystem for production. Keep `STORAGE_BACKEND=database` (or `s3`) so CVs and photos survive redeploys.
- The Blueprint sets `RETEST_COOLDOWN_HOURS=336` and `SEED_DEMO=false`. Seeding is opt-in and refuses to run with `ENV=production`.
- Set `ENV=production` on any public deployment. It enables the MFA requirement for admin and company-owner accounts and blocks seeding.
- Configure `SMTP_HOST`, `SMTP_FROM` (plus optional `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`) to send email-verification messages. Without SMTP the deployment verifies addresses automatically and says so, so demos keep working.
- Add any additional frontend domains to `CORS_ORIGINS` and redeploy the API.
- Add `ANTHROPIC_API_KEY` in Render only if you want the optional LLM extraction path.
- For CV-to-profile extraction, set `AI_PROVIDER` and the matching provider API key/model (`OPENAI_*`, `GEMINI_*`, `GROK_*`, or `DEEPSEEK_*`) in the backend environment. `AI_PROVIDER_FALLBACKS` may list additional configured providers. Never put these keys in frontend/Vite environment variables. If no provider is configured, CV profile extraction reports an error and candidates can still create a profile manually.

## Demo path (about 5 minutes)
1. Create account → accept consent. 2. **Use sample CV** → Analyse (see what was redacted) → confirm skills.
3. **Gap** shows the MOCK role vs. your claimed skills. 4. **Verify**: the standard server-timed 10-question adaptive assessment (20 minutes). Difficulty adapts to candidate answers; correct answers remain hidden during the test.
5. Result with topic scores and trust label. 6. **Learn**: cited resources for weak topics. 7. **Re-test** → uplift. 8. **Passport**: choose skills, share link, revoke.

## Verify exam integrity controls

Every exam is proctored (see `docs/PROCTORED_EXAM.md`): the candidate Verify flow requires camera, microphone, entire-screen sharing and full-screen mode before starting or resuming an attempt. Candidates pick the screen in the browser's native permission picker; window/tab sharing is rejected where the browser reports the surface. If sharing stops or full-screen mode is exited, the UI warns the candidate and disables SQL execution and answer submission until the required state is restored.

During an active attempt, the frontend blocks ordinary copy, cut, paste, keyboard clipboard shortcuts and the context menu, and records copy/cut/paste attempts, window blur, hidden-tab events, full-screen exits and screen-sharing interruptions. The backend stores event counts with the attempt and includes them in the advisory trust label. Integrity signals do not change the score or automatically fail a candidate; the existing appeal and human-review approach remains.

**Browser-enforced limits:** browsers do not let a website silently start screen sharing. The candidate must approve the browser prompt, and the browser may allow sharing a single tab/window instead of the entire desktop. A web page cannot reliably prevent screenshots, another device, OS-level shortcuts, developer tools, browser extensions or a determined user from bypassing client-side controls. The API also checks that the latest reported screen-sharing event is active before accepting an answer or running SQL. This is a consistency check, not cryptographic proof: browser telemetry is client-reported and a determined user can forge requests. These controls are deterrents and review signals, not a secure remote-proctoring system. The webcam stream (required) is used for on-device AI analysis. Before an assessment starts, the candidate also completes an on-device identity check: a face-recognition model compares the live webcam frame with the candidate's uploaded profile photo. Only the resulting similarity/distance event is stored — no biometric template or continuous video is uploaded. Webcam frames are not continuously uploaded or recorded. Only limited JPEG snapshots associated with selected AI alerts may be uploaded. Microphone monitoring is required before an assessment starts but stays on-device: it measures a loudness level only to show a "speaking detected" review signal, and audio is never recorded, stored or uploaded. Use HTTPS (or localhost for development) and test in supported desktop browsers.

## Phase 1 exam-integrity update

The Phase 1 implementation on `feature/exam-integrity-monitoring` now includes:

- Server-owned assessment deadline and per-question timing; submitted answer durations are calculated by the API, not accepted from the browser.
- Per-attempt session tokens. Resuming an active attempt rotates the token and invalidates older tabs. Answer, SQL, event and heartbeat requests must use the current token.
- Event allowlist, monotonically increasing sequence numbers, replay/gap rejection, server timestamps, bounded metadata, and a per-attempt event rate limit.
- IP and user-agent observation. An IP change is recorded as a network event; it is a review signal and is not treated as proof of misconduct.
- A 10-second heartbeat. Gaps greater than 30 seconds are recorded as monitoring gaps, explicitly not as proof of cheating.
- A client-side event queue that retries after connection recovery and flushes pending events with `sendBeacon` when the page is closing.
- Browser checks for desktop support, network availability, full-screen mode and the browser's reported screen-share surface. The browser must report the full monitor surface; tab/window sharing is rejected where the browser exposes that setting.
- Clipboard actions are blocked outside the SQL editor; ordinary copy/cut/paste remains available inside the editor. Browser telemetry remains advisory.
- Versioned, explainable trust rules in `backend/engine.py`, with configurable-in-code weights, incident grouping, duration treatment and caps. Integrity points never alter technical scores or automatically fail a candidate.

**Limitations:** A browser cannot prove that the user is not using another device, cannot reliably detect every form of tampering, and does not expose the selected share surface consistently in every browser. An unknown surface is rejected rather than assumed to be a monitor. The application does not record or upload continuous screen video or microphone audio. Phase 2 adds local webcam inference and limited alert snapshots; see the Phase 2 section below. These controls improve observability but are not a secure remote-proctoring guarantee.

**Verification status:** Covered by the backend suite (`tests/test_proctoring.py`, `tests/test_exam_start_flow.py`, `tests/test_api_hardening.py`) and the frontend build, which run in CI on every push. Manual multi-browser and offline testing is still required before high-stakes use.
## Phase 2: browser-local AI monitoring

On `feature/exam-integrity-monitoring`, Phase 2 adds a browser-side MediaPipe Tasks Vision integration:

- The candidate explicitly enables the webcam through the browser permission prompt. Before the assessment starts, a browser-side face-recognition model compares the live frame with the candidate's profile photo and records a pass/mismatch event. This is a heuristic, on-device review signal, not a certified biometric identity check, and a mismatch never blocks the candidate automatically — it can be continued with an explicit acknowledgement and is surfaced to a human reviewer.
- Face Landmarker runs locally in the browser and estimates face presence, multiple visible faces and a rough head/gaze direction signal.
- The same on-device monitor runs for **both** the standard adaptive assessment and the CV-based GraphRAG assessment, so a candidate who leaves the frame, shows a second face or a phone produces a stored flag in either path.
- MediaPipe Object Detector attempts to identify a phone in the webcam view. If that model cannot load, face analysis continues and the UI reports the object detector as unavailable.
- Detection runs against the live webcam stream in the browser. Raw frames are not sent to the backend as a stream and no camera video or microphone audio is recorded.
- When a supported alert triggers, the browser creates a small JPEG snapshot (maximum 180 KB) and sends it with a short event record. Uploads are throttled per alert type, and the API limits evidence to 20 snapshots per attempt.
- Snapshots are stored outside the event JSON in the `exam_evidence` table, with a configurable expiry. `EVIDENCE_RETENTION_DAYS` defaults to 30 and is clamped to 1–90 days; an hourly cleanup task deletes expired snapshots.
- Admin assessment review includes the AI event timeline and available evidence snapshots. AI signals use low, capped advisory trust weights; they are not hard flags, cannot automatically invalidate an attempt, and do not change technical scores.
- **Optional second-pass vision check:** when `EVIDENCE_VISION_PROVIDER=groq`, each stored alert JPEG can be sent to the configured Groq vision model for an advisory phone / face / person-count verdict. It runs in the background after the snapshot is saved, is stored next to the snapshot (`vision_json`, `vision_model`, `vision_at`) and is shown in the admin evidence gallery. It never triggers an automatic failure. Leave the setting empty to keep all analysis on-device.

**Interpretation and limitations:** A single webcam view cannot reliably prove gaze intent, detect every phone, or establish that another person is helping. Head pose is only a rough gaze proxy. Lighting, camera quality, occlusion, model download failure and device performance can affect results. The object model may be unavailable in some browsers or networks. An alert should prompt human review, not an automatic penalty. Microphone monitoring is required before an assessment starts and stays on-device: it only measures loudness to flag possible speaking, and audio, speech content and voice characteristics are never recorded, stored or uploaded. Continuous webcam recording and live-screen AI classifiers are not implemented in this phase. The screen-share stream remains a browser-enforced share-status requirement and is not uploaded or analyzed frame-by-frame.

**Deployment:** The frontend downloads the MediaPipe JavaScript package and model assets at runtime. A production deployment should pin and self-host reviewed model assets, verify model licences and hashes, test GPU/CPU fallback, and configure HTTPS. Evidence images are sensitive personal data; disclose the collection and retention period before enabling this feature in a real exam.

**Verification status:** Backend tests (including trust scoring and evidence handling) and the Vite build run in CI. Real webcam inference, model loading on a range of devices and end-to-end evidence upload against Postgres still need manual verification per release.
 
## What is real vs. mock (honest list)
| Area | R0 status |
|---|---|
| Server-side scoring from stored answer keys, adaptive difficulty | **Real** (`backend/engine.py`, unit-tested) |
| SQL sandbox (SELECT-only, authorizer, op limit, graded on 2 generated datasets) | **Real**, in-process SQLite. Python sandbox: not in R0 |
| PII redaction before AI | **Real** (regex + name heuristics; not perfect) |
| Skill extraction | Rule-based offline by default. **LLM path exists** (schema-validated, falls back to rules) and runs only if `ANTHROPIC_API_KEY` is set. Not exercised in CI |
| CV-to-profile extraction | PDF/DOCX/TXT/MD parsing with OCR for scanned PDF pages, a shared validated profile schema for OpenAI/Gemini/Grok/DeepSeek, evidence-backed editable drafts, and candidate-only confirmation. Provider calls receive PII-redacted text; provider API keys stay on the backend. |
| Trust label (paste, tab-blur, fast-perfect signals) | **Real**, never pass/fail; appeal is stored |
| Learning path | Curated index, topic/level retrieval with source + licence. **Not** pgvector RAG yet. Curator must verify links/licences |
| Skill Passport | **Real**: HMAC-signed, revocable, public verify page. Signature is server-secret HMAC, not public-key |
| Job profile, question pool (25 items), percentile | **MOCK / tiny**. Percentile intentionally not shown |
| Bangla | UI + explanations. Question text is English only |
| Company / recruiter / admin roles | **Real**: tenant-scoped company workspace and admin console (`backend/enterprise.py`) |
| Camera + microphone + screen proctoring | **Real**, on-device inference; advisory flags only (`docs/PROCTORED_EXAM.md`) |
| MCP server | **Real**, read-only (verification + candidate learning), off by default (`MCP_ENABLED`) |
| Billing | Invoice records only; live checkout/payment confirmation disabled |
| Not built (roadmap) | AI interviewer, pgvector RAG, SSO, virus scan |

## Optional GraphRAG assessment prototype

The repository includes an experimental GraphRAG blueprint path built around the existing, curator-governed `question_bank`. It is separate from the standard candidate assessment. The standard candidate flow uses the existing server-timed 10-question adaptive engine (20 minutes) and does not require CV confirmation, a complete GraphRAG bank, Meilisearch, or Neo4j.

The experimental GraphRAG blueprint path is built around the existing, curator-governed `question_bank`. It retrieves and assembles approved questions; it does **not** fabricate assessment questions or answers at exam time.

### Assessment blueprint

- **Fundamental section:** 25 questions across DSA (5), OOP (4), Networking (4), Coding (5), Database (5), and Critical Thinking (2).
- **Difficulty:** 40/30/30 is not an exact integer split for 25 questions. The engine uses the nearest whole-question allocation: 10 Easy, 8 Medium, 7 Hard. The per-topic matrix is returned with every blueprint.
- **CV section:** five questions per candidate-confirmed CV/profile skill: 1 Easy, 2 Medium, 2 Hard. Skills are resolved through the single `content.TAXONOMY` catalogue used by the candidate profile, skill journey, admin coverage view and company application view, so free-text skills such as "Django", "React" or "Power BI" map to the same canonical ids everywhere. A confirmed skill without a complete approved-question quota is reported as `question_bank_pending` instead of being silently dropped; the rest of the assessment still runs.
- **Question formats:** the approved bank must cover scenario-based, explanation, SQL and coding questions in the fundamental section. Each assessable CV skill should have practical (coding/SQL) and scenario/explanation coverage.
- **Duration:** the server calculates the assessment duration by summing each selected question's configured `time_allocation`; it is not a fixed exam duration.
- **Candidate experience:** five questions are shown per page in a table, with previous/next page navigation, per-question answer saving, a server-side timer and post-submit answer review. Correct answers are not exposed during the exam. Topic scores are stored under canonical skill ids so the learning path, uplift and Skill Passport stay aligned with the skill journey.
- **Auditability:** each generated blueprint stores the selected question IDs, CV skill evidence, covered and pending skills, retrieval trace, provider status, quota gaps and retrieval latency. Attempt answers and submission results are stored in the existing attempt record. MCQs and SQL questions with a canonical reference query are automatically graded. Coding, scenario, descriptive and analytical responses get an **advisory hybrid draft** (expected-keyword coverage + reference-answer similarity + an optional PII-redacted LLM opinion) with partial marks. The draft is always stored as `pending_approval`; an administrator must approve or edit it before it affects the score, and every edit is audited.

### Retrieval architecture

```
Redacted CV
   └─ spaCy tokenization + explicit skill alias extraction
        └─ Pydantic CVSkill schema + candidate skill confirmation
             └─ Assessment planner / quota validation
                  ├─ Meilisearch: fast keyword recall
                  └─ Neo4j: Skill → RELATED_TO → Topic → HAS_QUESTION
                       └─ Reciprocal-rank fusion + deterministic quota selection
                            └─ Approved question-bank snapshot → Assessment attempt
```

The relational question bank remains the source of truth. Meilisearch and Neo4j are optional retrieval accelerators; if either is not configured or unavailable, the selector falls back to deterministic question-bank filtering and reports the active provider status. The retrieval step is designed to complete quickly, but actual latency depends on question-bank size and external service availability; the measured `retrieval_ms` is stored and returned rather than promising a fixed 1–2 minute SLA.

### Required question-bank preparation

The fundamental selector fails closed when a required quota is missing. For the CV section, the same coverage calculation reports each confirmed skill as covered or pending: pending skills are listed in the blueprint and candidate journey, and are not fabricated or silently hidden. Admins must create/import questions, set the correct category and subcategory, difficulty, question type, answer key/reference answer, explanation/rubric and per-question time allocation, then mark reviewed questions **Active**. For SQL questions to be automatically graded, put a canonical SQL query in the Reference answer field; the SQL grader checks it against two generated datasets using the built-in customers/orders schema. Subcategory labels should use the canonical technology names (Python, Git, AI & Machine Learning, SQL, JavaScript, Java, Docker, and so on). Do not activate unreviewed questions. The Admin → Question Governance screen exposes GraphRAG readiness, per-skill coverage and a **Rebuild search + graph index** action.

### Seed a synthetic GraphRAG assessment bank for testing

The repository includes an explicit, repeatable seed script with **100 synthetic questions**:
- 10 fundamental questions per topic across DSA, OOP, Networking, Coding, Database and Critical Thinking (60 total).
- 10 questions each for Python, Git, AI & Machine Learning and SQL (40 total).
- A normal blueprint selects 25 fundamental questions and five per assessable CV skill (for example Python, Git, AI & Machine Learning and SQL = 45 questions). The surplus is what lets the retake filter serve fresh questions without repeating anything the candidate has already seen.
- Per-skill difficulty in the CV bank: 2 Easy, 4 Medium, 4 Hard, so a 1/2/2 selection is available for two attempts.
- Includes MCQ, coding, SQL, scenario and explanation formats, answer keys/reference solutions, rubrics and per-question time allocations.

`backend/start.sh` runs this seed at startup, controlled by `SEED_QUESTION_BANK_ON_BOOT`:

- `true` (default, docker-compose): seed on every start.
- `false` (set in `render.yaml`): seed only when the active question bank is empty, so ordinary restarts skip it.

The seed uses stable IDs and `ON CONFLICT DO NOTHING`, so a repeated run does not duplicate or overwrite these seeded records. A seed failure is logged and the API still starts. After seeding, rebuild search + graph index from Admin → Question Governance.

The script is idempotent: it uses stable question IDs and `ON CONFLICT DO NOTHING`, so rerunning it will not duplicate or overwrite existing questions. It does not create candidate accounts or write candidate data. Existing question-bank records are preserved.

After seeding:
1. Sign in with an admin account that has Question Governance permission.
2. Open **Admin → Question Governance** and check that the 25-question fundamental quota is ready.
3. Select **Rebuild search + graph index**. If Meilisearch/Neo4j are not configured, the relational retrieval fallback remains available for testing.
4. Upload or use a test CV that explicitly mentions Python, Git, machine learning and SQL, confirm those detected skills, and generate the assessment.
5. Confirm the blueprint contains 45 questions, with 25 fundamental and five per confirmed skill. The seed's CI test validates this exact test scenario.

Do not run this seed on a production database containing live assessment content unless you explicitly want these demo questions to become active and visible in its question bank.

### Configure external retrieval services

Set these on the backend service (Render for the current deployment):

- `MEILISEARCH_URL`, `MEILISEARCH_API_KEY`, `MEILISEARCH_QUESTION_INDEX`
- `NEO4J_URI`, `NEO4J_USERNAME`, `NEO4J_PASSWORD`, `NEO4J_DATABASE`
- `SPACY_MODEL` (`blank:en` in `render.yaml` and `.env.example`: spaCy's blank English tokenizer plus deterministic alias matching. No trained model is installed in the image; to use one, install it in the Dockerfile and set e.g. `en_core_web_sm`. A missing model falls back to blank English.)

After configuring both services, sign in as an admin, open **Question Governance**, and select **Rebuild search + graph index**. The Admin GraphRAG status endpoint reports question coverage and service configuration. Keep service credentials in Render environment variables, never in the frontend or repository.

### API endpoints

- `POST /api/assessment/blueprint` — create and persist a candidate-specific blueprint after CV skill confirmation.
- `GET /api/assessment/blueprint/{blueprint_id}` — retrieve blueprint readiness metadata for its owner.
- `GET /api/skill-journey` — the candidate's canonical profile/CV skills with verified, ready, pending-review and question-bank-pending status.
- `POST /api/attempts` with `{"blueprint_id":"..." }` — start/resume the official attempt and consume existing retake credits under the existing policy.
- `POST /api/attempts/{attempt_id}/answer` — save a question answer without revealing correctness.
- `POST /api/attempts/{attempt_id}/navigate` — navigate to a question index.
- `POST /api/attempts/{attempt_id}/submit` - submit the assessment; requires every question to be answered unless the server timer expires.
- `POST /api/admin/attempts/{attempt_id}/evaluate` - run the advisory hybrid keyword + similarity + LLM evaluation for descriptive answers (admin only).
- `PATCH /api/admin/attempts/{attempt_id}/evaluations/{question_id}` - edit the awarded partial marks, administrator note and additional audit information for one answer.
- `POST /api/admin/attempts/{attempt_id}/review` - approve, request more information or invalidate the result; approving folds administrator-approved partial marks into the final score.
- `GET /api/admin/assessment/graphrag/status` and `POST /api/admin/assessment/graphrag/reindex` — admin readiness and index maintenance.

This implementation is an initial GraphRAG assessment slice. Meilisearch/Neo4j must be provisioned and configured separately, the approved question bank must meet every quota, and production end-to-end testing is still required before public use.

## Layout
```
backend/   main.py (API) · engine.py (scoring, redaction, SQL sandbox) · ai_interview.py (Voice AI interview) · content.py (taxonomy, questions, resources) · prompts/ · tests/
frontend/  src/App.jsx (all screens) · interviewMachine.js + VoiceInterview.jsx · i18n.js (EN/BN) · styles.css · nginx.conf · Dockerfile
docker-compose.yml · .env.example · .github/workflows/ci.yml
```

## Tests
`cd backend && python -m pytest -q tests` covers redaction, SQL sandbox (including DROP and infinite recursion), grading on hidden datasets, adaptivity, retest freshness, trust label, learning-path honesty, signing, proctoring/session controls, tenant isolation and MCP.

## Voice AI interviews (zero / ultra-low cost)

A company can shortlist an applicant and choose **Manual / Zoom** (meeting link, time, note; a provider seam in `backend/interview_providers.py` is where a real Zoom integration lands) or an **AI interview**. The candidate answers by voice from the Assessments page; a platform admin reviews every interview before the company can read it.

**Product rules enforced in code**
- The AI only asks questions. It never scores, judges or fails anyone; there is no score field anywhere and admin marks (1–5) are human-entered.
- The client state machine (`frontend/src/interviewMachine.js`) makes it impossible to enter `ASKING` while `LISTENING`. Listening ends only on **Done** or a 6-second silence that opens a **cancellable 5-second countdown**. No speech for 20 seconds shows “Still there?” and never advances. The hard cap is 3 minutes (warning at 2:30). `speechSynthesis.cancel()` is only called by the candidate’s own **Skip reading**.
- TTS is browser `speechSynthesis`; the question text is always shown. Bangla (`bn-BD`) and English (`en-US`) are selectable per invite, and a missing voice cleanly falls back to text-only.
- Each answer is recorded with MediaRecorder (Opus WebM, low bitrate), transcribed server-side by Groq Whisper (browser SpeechRecognition is the live preview and fallback), and stored as text plus an audio object key.
- Audio goes to S3-compatible storage only (`STORAGE_BACKEND=s3`); it is never stored in PostgreSQL. Without S3 the session runs in transcript-only mode and the admin/company UI says so.
- Every turn stores question, source (`opening`, `follow_up`, `company_custom`), transcript, original transcript after an admin edit, audio key, timings and durations.
- Company “must ask” questions are inserted at fixed server-chosen positions; the LLM cannot remove them. Optional customs are asked at the end if the question budget allows.
- One plan LLM call at session creation (redacted CV + job circular), one follow-up decision per answer. Outputs are schema-validated, retried once, then fall back to the precomputed plan, so an LLM/network outage never blocks the candidate.
- CV/job/answer text is always data, never instructions; PII is redacted before any LLM call.

**Endpoints** (`backend/ai_interview.py`)
| Role | Endpoint |
|---|---|
| Company | `POST /api/company/applications/{id}/shortlist`, `POST .../interview`, `GET .../interview/result` (403 until approved) |
| Candidate | `GET /api/interviews`, `POST /api/interviews/{id}/consent`, `/start`, `/answer` (multipart) |
| Admin | `GET /api/admin/interviews`, `GET/PATCH .../{id}`, `POST .../{id}/decision` |

The answer endpoint is rate-limited, caps uploads at 5 MB, checks the audio container signature and ignores any client-supplied question text.

**Configuration** (all documented in `.env.example`)
- `GROQ_API_KEY`, `GROQ_STT_MODEL` (`whisper-large-v3-turbo`), optional `GROQ_LLM_MODEL` alias for chat; text LLM calls fail over Groq → DeepSeek through `AI_PROVIDER_FALLBACKS`.
- `STORAGE_BACKEND=s3` plus `S3_BUCKET`, `S3_ENDPOINT_URL`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` (aliases `S3_ENDPOINT`, `S3_ACCESS_KEY`, `S3_SECRET_KEY` are accepted).
- `AI_INTERVIEW_RETENTION_DAYS` (default 90), `AI_INTERVIEW_MAX_AUDIO_BYTES`, `AI_INTERVIEW_ANSWER_RATE_LIMIT`, `INTERVIEW_MEETING_PROVIDER=stub`.

**Retention and deletion.** The hourly maintenance loop removes sessions/turns, review notes and audio older than `AI_INTERVIEW_RETENTION_DAYS`, keeping only the invite status as non-content history. A candidate account deletion (`DELETE /api/me`) erases their interviews and audio too, and `/api/me/export` includes their transcripts.

## Proctoring for AI interviews (advisory only)

AI interviews can run at `off`, `light` (browser events), `standard` (+ camera analysis and fullscreen), or `strict` (+ screen sharing). The company chooses the level and whether gaze analysis is enabled; the candidate sees it before accepting and can request an accommodation or a manual/Zoom alternative.

**Nothing here scores or fails a candidate.** Flags are factual, advisory observations; a human reviewer dismisses or confirms each one. The AI interview content, answers, and the candidate’s ability to finish never depend on a flag, a missing model, a lost camera or a fullscreen exit.

**Pre-check (before question 1, repeated on resume).** Browser/device check, camera and microphone permission, live “face detected / lighting” feedback, a 5-second neutral-pose calibration, one baseline photo for human comparison, fullscreen test, strict-level screen-share test, and a versioned interview-proctoring consent covering audio, on-device analysis, snapshots, retention, appeals and deletion.

**Runtime.**
- Fullscreen exit, camera loss, strict-level share loss and a second tab show a blocking overlay. The AI stays silent (TTS is paused, never cancelled by the overlay); the interviewer state machine does not advance; recording and the 3-minute answer cap continue.
- Tab visibility, window focus, copy/cut/paste, context menu, PrintScreen, F12 and developer-tools shortcuts are logged only — never claimed to be fully preventable.
- Keyboard Lock (`navigator.keyboard.lock(["Escape"])`) is best-effort and Chromium-only; MDN marks it experimental and it requires HTTPS + transient user activation + fullscreen.
- Second-tab detection uses `BroadcastChannel` and logs `second_tab`; no forced close.

**On-device camera analysis.** MediaPipe `FaceLandmarker` from `@mediapipe/tasks-vision` runs at ~2.5 fps (slower when frames are expensive, paused when the tab is hidden). It derives face count, head yaw/pitch relative to calibration and gaze from blendshape coefficients; no video is recorded or uploaded. A JPEG snapshot is captured only when a medium/high flag fires. If the model cannot load, a camera is absent or the gaze blendshapes are unavailable, `camera_analysis_unavailable` is recorded and browser-event proctoring continues.

**Rules and label** live in `backend/interview_integrity.py` (`PROCTOR_RULES`, `rule_version = interview-proctor-v1`). Defaults: face absent ≥4 s (medium) / ≥12 s (high), multiple faces ≥2 s (high), head turned ≥5 s (medium), gaze away ≥5 s continuous or ≥12 s cumulative in 30 s (low), suppression 3 s after each question, three sustained gaze episodes per answer → one `gaze_pattern` (medium). Server-side cooldown is 30 s per type, max 40 events and 25 snapshots per session. Severity is always recomputed on the server; client severity is ignored.

Labels: **High trust** 0–3, **Medium** 4–8, **Needs review** 9+ or any confirmed high. The company sees only the after-review label, confirmed-flag count and reviewer notes — never events, images or the baseline.

**Storage and retention.** Snapshots go to S3-compatible storage when configured, otherwise to `ai_interview_flag_shots.image_bytes` (≤60 KB each). Uploads must be `image/jpeg`, ≤150 KB, are re-encoded to strip EXIF, and are served by 10-minute signed URLs (or an authenticated data URL in DB mode). Snapshots are deleted after `AI_INTERVIEW_SHOT_RETENTION_DAYS` (default 30), but are held while a session is under review or an appeal is unresolved; the retention clock restarts after a decision. Session deletion removes proctor events, calibration, snapshots and their storage objects; account deletion and `/api/me/export` include the candidate’s own flags and accommodation requests.

**Model hosting.** Defaults are the public MediaPipe `face_landmarker.task` and the wasm at `/mediapipe/wasm`. For privacy-sensitive deployments, self-host both and set `VITE_FACE_LANDMARKER_MODEL` / `VITE_MEDIAPIPE_WASM_PATH` at build time. The model is downloaded to the candidate’s browser and runs locally; no frames leave the device except the flag snapshots.

## Quality gates

Every push and pull request runs `.github/workflows/ci.yml`:

| Gate | Command (local equivalent) |
|---|---|
| Backend tests + coverage gate | `cd backend && python -m pytest -q tests --cov=. --cov-fail-under=72` |
| Frontend lint | `cd frontend && npm run lint` |
| Frontend unit tests | `cd frontend && npm test` |
| Frontend production build | `cd frontend && npm run build` |
| End-to-end (Playwright, API mocked) | `cd frontend && npx playwright install chromium && npx playwright test` |
| Dependency audit (non-blocking) | `pip-audit -r backend/requirements.txt`, `cd frontend && npm audit --audit-level=high` |

Run the backend gate before committing (`AGENTS.md`). Deployment, health/readiness, backups, retention, CSP and secret rotation are in [`docs/OPERATIONS.md`](docs/OPERATIONS.md).

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
Seeding is opt-in and disabled in production. Both seeders refuse to run when
`ENV=production`, and neither one ships a hardcoded password (SB-006).

```bash
SEED_DEMO=true SEED_DEMO_PASSWORD='<unique-strong-password>' python seed_demo.py
SEED_DEMO=true SEED_DEMO_PASSWORD='<unique-strong-password>' python seed_enterprise.py
```

When `SEED_DEMO_PASSWORD` is omitted a random password is generated and printed
once by the seeder. Accounts created with `SEED_DEMO=true`:

- Candidate: demo@skillbridge.test
- Recruiter: recruiter@skillbridge.test
- Admin: admin@skillbridge.test

Create real administrators with `python create_admin.py`; no fixed admin
credential exists anywhere in the repository.

### Known remaining PRD work
This is an initial vertical slice, not a completed production platform. Alembic migrations, complete authorization/security tests, DeepSeek provider integration, pgvector RAG, payment webhooks, official score review, OCR fallback, hardened code execution and end-to-end production deployment remain future work.


## CV storage and sharing

- An uploaded CV is parsed for skills, and a **PDF version is stored in the
  database** (`cv_files` table, `BYTEA`). PDF uploads are kept byte-for-byte;
  DOCX/TXT/pasted CVs get a generated PDF rendering, so admin and recruiter views
  always have a file to open and never depend on ephemeral container storage.
- The original upload is still kept in the configured storage backend
  (`database` by default, or `local` / `s3`), and the existing per-user
  pruning/retention applies.
- **Admin console**: *Users & accounts → View candidate* opens the candidate
  record with the stored CV, structured profile, CV-extracted skills, every
  assessment score, the Skill Passport and the application history.
- **Company workspace**: a company can open the CV of a candidate **only when
  that candidate applied to one of its own job posts**. The endpoint is scoped by
  company, so another company receives `404`.
- Assessment scores and the Skill Passport in the company view stay gated by the
  candidate's per-application result-sharing switch. The consent screen now
  states both rules.
- Deleting an account removes `cv_files`, extractions and stored files
  (covered by `backend/tests/test_cv_sharing.py`).

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

## Verified result → learning path → automatic Skill Passport

The candidate journey is now:

**Profile → Verify (fundamental + CV-skill assessment) → Results & gap → Learn → Re-take → Skill Passport**

- The assessment result screen shows the score, per-topic performance and whether the result is awaiting human review. GraphRAG results use a documented **60% fundamentals / 40% CV & development** scorecard: DSA, SQL, Networking, OOP, Database, Coding and Critical Thinking form the 60% bucket (SQL is counted here even though its questions live in the CV-technology bank), while all other confirmed CV skills are merged into the 40% bucket. Per-skill topic scores remain visible for the journey and passport.
- The learning dashboard is generated from the latest exam performance (fundamental and CV-skill topics). If no approved result exists yet it shows provisional recommendations so the candidate can start learning immediately.
- An admin with assessment-review permission can approve the result. Approval records the reviewer and reason, marks the result as verified, refreshes the learning path and automatically issues a signed Skill Passport for the approved attempt.
- Invalidating or requesting more information revokes any auto-issued passport for that attempt.
- Retakes unlock after the current result has a human-review decision, so Verify, Gap, Learn and Passport always describe the same result while it is pending.
- The passport is linked to its source attempt, is idempotent (re-approval does not duplicate it) and follows the existing revocable public-link model.
- The built-in curated resource catalogue is seeded as approved for the prototype; admin-added resources still require explicit review, and admins can quarantine or retire any resource.



## Exam integrity monitoring (Phase 1 — advisory)

The candidate Verify flow requires camera, microphone, entire-screen sharing and full-screen mode before an assessment can start or resume. The candidate must approve the browser's native sharing picker; window/tab sharing is rejected where the browser reports the surface. If sharing stops or full-screen mode is exited, the candidate UI disables answer saving, question navigation, SQL execution and submission until the required state is restored.

During an active attempt, the frontend blocks ordinary copy, cut, paste, clipboard keyboard shortcuts and the context menu, and records browser-reported clipboard, focus, visibility, full-screen and screen-sharing events. The backend stores event timestamps and calculates a versioned, explainable trust label separately from the technical score. The same integrity gate is applied to the standard adaptive assessment and the optional GraphRAG assessment routes. Administrators with the appropriate integrity-review permission can inspect attempt summaries, event timelines and available answer timing evidence.

**Privacy and browser limits:** TalentForge does not record, upload or store the screen stream or camera video. Microphone monitoring is required, but only an on-device loudness level is computed to flag possible speaking; audio is never recorded, stored or uploaded. A browser page cannot reliably prevent screenshots, another device, OS-level shortcuts, developer tools, extensions or a determined user from bypassing client-side controls. Event telemetry is client-reported; a malicious client can forge requests. Browser screen sharing is not proof of full-desktop visibility. Trust labels are review signals only: they do not change technical marks or automatically fail candidates. Candidates can appeal.

**Implemented since Phase 1** (see the Phase 1 update above): per-attempt session tokens with single-session invalidation on resume, monotonic event sequence numbers with replay/gap rejection, a server-side per-attempt event rate limit, 10-second heartbeats with gap detection, client event buffering with `sendBeacon` flush, full-monitor surface validation where the browser exposes it, and a step-by-step pre-exam device check. **Not implemented:** cryptographically signed event sequencing and clipboard-origin tracking for code editors. These controls are not a secure remote-proctoring system and must not be treated as proof of misconduct.
