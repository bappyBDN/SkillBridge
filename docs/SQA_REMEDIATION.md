# SQA Remediation Report — response to the TalentForge SQA review (13 Nov 2026)

Source: `docs/Project Name_ TalentForge-sqa-reports.pdf` (11 defects: 2 Critical,
1 High, 6 Medium, 2 Low).

Every defect was re-checked against the current tree before changing code. Some
items had already been corrected since the review; they are listed as
**verified** with the evidence that closes them.

## Status board

| ID | Severity | Status | What changed |
| --- | --- | --- | --- |
| SB-001 | Medium | **Partial → mechanism fixed** | Landing page and candidate workspace chrome now translate; language switches through React context instead of `location.reload()`. Remaining English: company workspace, admin console and long-form content. |
| SB-002 | Low | **Fixed** | Hero shortened to headline + one sentence + one primary CTA; the three-point list and avatar strip removed; both value-card buttons now scroll to the single auth card instead of duplicating the form. |
| SB-003 | High | **Fixed** | Password policy: minimum 8 characters (product decision — no composition rules); confirm-password field; PBKDF2 raised to 600k with rehash-on-login; login/registration/MFA throttling with backoff; revocable sessions; email verification; TOTP MFA (mandatory for admin/company-owner roles when `ENV=production`); duplicate registration no longer reveals account existence. |
| SB-004 | Medium | **Fixed** | Raw CV identity (name, emails, phones) extracted *before* redaction and compared with the account; weak/missing match requires an explicit "this CV is mine" confirmation and queues an admin review. Signal only — never an automatic rejection, and no demographic inference. |
| SB-005 | Critical | **Verified + guarded** | `restartShare` is defined inside `Exam` and no longer returned by `useExamIntegrity`, so the ReferenceError is gone. Added a React error boundary and ESLint `no-undef` in CI to stop the class of bug recurring. |
| SB-006 | Critical | **Fixed** | `admin@test.com` / `12345678` removed. Seeders take `SEED_DEMO_PASSWORD` or generate a random one, print it once, and refuse to run when `ENV=production` or `SEED_DEMO` is not `true`. `render.yaml` sets `SEED_DEMO=false` and `ENV=production`; `start.sh` double-guards the production case. |
| SB-007 | Medium | **Fixed** | One deadline helper (`attempt_seconds` / `attempt_deadline` / `attempt_expired`) reads each attempt's own `state.duration_seconds`; resume, answer, navigate, submit and quit all use it. Unit test covers a 5,010-second blueprint. |
| SB-008 | Medium | **Fixed** | `USER_DATA_REGISTRY` now drives both export and deletion across app, learning, billing, admin, session and company tables; attempt-scoped rows are removed; owned companies and their jobs/applications are removed; the audit log is kept with a pseudonymised actor. Test asserts no registry row survives deletion. |
| SB-009 | Low | **Verified** | `seed_demo.py` consumes the `trust_label` dictionary correctly and imports `CONSENT_VERSION` from the app, so the demo candidate is fully seeded. New seed smoke test runs it end to end. |
| SB-010 | Medium | **Mitigated + wording fixed** | Server already keeps sequence-signed per-attempt events, session ownership, heartbeats and a 180-events/minute rate limit. UI wording no longer claims enforcement: screen share, full-screen and the microphone are labelled advisory, and the integrity text says signals are reviewed by a person. |
| SB-011 | Medium | **Fixed** | Added `tests/test_api_hardening.py` (auth, throttling, revocation, deletion, identity, deadlines), `tests/test_security.py` and `tests/test_seed_smoke.py`; CI runs the suite with a 60% coverage gate plus ESLint (`no-undef`) and the Vite build. |

## Exit-criteria check

| Criterion | Status |
| --- | --- |
| Critical/High defects fixed, retested | SB-005/006 fixed; SB-003 fixed and covered by tests. Manual browser matrix still required. |
| CI runs unit + API + lint + smoke | Yes: pytest (with coverage gate), ESLint, Vite build. |
| No default or hardcoded credentials in code or config | Yes — password generated per deployment, seeders block production. |
| Full flow in English and Bangla | Mechanism complete; candidate surfaces translated. Company/admin surfaces still English (tracked below). |
| Cross-company access tests and deletion test | Deletion covered. Tenant isolation remains covered by the existing enterprise tests; expanding the cross-company matrix is the next increment. |

## Still open (honest remainder)

1. **SB-001 completion** — navigation, headings, primary actions, statuses and
   the security/identity panels are translated. Long-form panel copy inside the
   company and admin workspaces is still English; `frontend/src/consoleI18n.js`
   is the file to extend.
2. **Browser retest** — Chrome, Firefox, Safari and Android Chrome must be run
   against the fixed build before sign-off. No browser matrix was executed here.
3. **Tenant-isolation matrix** — the suite exercises owner isolation and privacy
   paths; an explicit two-company access matrix per endpoint is the next step.

## Delivered after the first pass

### CV storage and sharing

- Uploaded CVs are now stored **as PDFs in the database** (`cv_files`), with the
  original file kept in the storage backend. Pasted text and DOCX/TXT uploads get
  a generated PDF rendering, so a viewable file always exists.
- **Admin Console → Users & accounts → View candidate**: full candidate record
  with the CV, structured profile, CV-extracted skills, scores, passport and
  application history (`GET /api/admin/candidates/{id}`,
  `GET /api/admin/candidates/{id}/cv`).
- **Company workspace**: applicant drawer shows the CV of candidates who applied
  to that company's own job, plus score and Skill Passport when shared
  (`GET /api/company/applications/{id}/cv`, scoped by company).
- Consent copy now discloses the employer CV visibility and the result-sharing
  rule. Tests: `backend/tests/test_cv_sharing.py`.

- **Admin identity-review queue** (`Admin Console → CV identity review`): lists
  CVs whose name is missing, partially matched or different from the account.
  The candidate must explicitly confirm ownership for weak/no-match CVs before
  continuing; a missing-name CV is queued for advisory review without blocking.
  The queue supports status filters, search and refresh, shows the CV name,
  similarity, email match, candidate confirmation and reasons, and records a
  reasoned cleared / needs-review / escalated decision with reviewer and time.
  A later matching CV supersedes the old signal instead of leaving a stale row.
- **Security & MFA screens** in both workspaces (`Security & MFA`):
  - TOTP enrolment with secret, `otpauth://` link, one-time recovery codes and
    activation by 6-digit code.
  - Live session list with per-session revocation and a "this device" marker.
  - MFA state and whether it is required for the signed-in role.
- **API additions**: `GET /api/auth/mfa/status`, `GET /api/auth/sessions`,
  `DELETE /api/auth/sessions/{id}`, `POST /api/auth/change-password`,
  `POST /api/auth/forgot-password`, `POST /api/auth/reset-password`,
  `POST /api/admin/console/staff/{id}/revoke`, `DELETE /api/admin/console/staff/{id}`,
  `GET /api/admin/identity-reviews`,
  `POST /api/admin/identity-reviews/{id}/decision`.
- **Candidate settings** (`Settings`): profile shortcut, current-password-verified
  password change that signs out other devices, and a one-time emailed reset
  link. Reset tokens are hashed, expire after one hour and revoke every session.
- **Central staff administration** (Super Admin → Admin staff & roles): create
  admins, change their scope, **revoke admin access** (account kept, sessions
  revoked) or **delete the admin account**. Self-revocation, self-deletion and
  removal of the last active Super Admin are blocked.
- **Bengali coverage** for both console shells, navigation, page headings,
  overview metrics, company onboarding/verification banner, recruitment stages
  and the security/identity panels.

## Verification commands

```bash
cd backend && python -m pytest -q tests --cov=. --cov-fail-under=60
cd frontend && npm run lint && npm run build
```

Latest local run: **125 passed, 1 skipped**, coverage **71%**; frontend lint
**0 errors**; production build succeeds.
