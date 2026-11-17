# TalentForge / SkillBridge — Inspection Report & 60-Second Demonstration

## Delivered artefact

- **`demo/skillbridge-60s-demo.html`** — standalone, silent, self-contained 60-second product demonstration.
- No backend, login, external fonts, CDN, or network request is required.
- Press **PLAY · 60 SECONDS**. A virtual cursor operates the real UI. A **REPLAY 60s** control appears at the end.
- There is no voiceover, narration, tutorial copy, or explanatory overlay. The only additions are a thin progress bar, the requested play/replay control, and the simulated cursor/click indicator.

## What the software actually does

TalentForge is an evidence-led hiring prototype for a **Junior Data Analyst** role. It connects:

**CV → extracted skills → candidate confirmation → gap view → adaptive assessment → human academic review → human honesty review → published result → learning path → Skill Passport → employer sharing.**

Scoring is deterministic and server-owned. AI is optional and never assigns final marks. A human approves academic marks and the advisory honesty report before any verified score, learning path, or credential is released. Integrity signals are advisory and never auto-reject a candidate.

## User roles

| Role | Main capabilities |
|---|---|
| **Candidate** | Account/consent, CV upload or paste, PII-redacted profile, skill confirmation, identity confirmation for mismatched CVs, skill journey, adaptive assessment, results, appeals, learning path, re-test, Skill Passport sharing/revocation, settings, data export/deletion |
| **Company / employer** | Company onboarding and verification, job posting and moderation flow, applicant pipeline, candidate CV, shared assessment results, shared Skill Passport, team invitations and least-privilege roles |
| **Admin** | Platform overview, user/account management, admin staff creation/role change/revoke/delete, company verification, job moderation, assessment academic review, exam integrity/honesty review, CV identity review, candidate appeals, question governance, learning resources, AI operations, billing, privacy, quality metrics, audit trail, security/MFA |
| **Super Admin** | Full admin scope, staff administration, security, audit, privileged decisions |

## Feature inventory found in the codebase

### Candidate
- Registration, consent, email verification, login, MFA, password reset/change.
- CV upload/paste, PII redaction before AI, deterministic fallback extraction, editable profile.
- CV identity signal (name/email match, weak/no-match/unknown) and explicit ownership confirmation.
- Candidate profile editor: contact details, headline, experience, education, skills, certifications, projects, languages, references, achievements, volunteering, links, job preferences.
- Adaptive assessment: server deadline, question palette, MCQ/SQL/descriptive formats, trust signals, integrity events, identity/photo check.
- Result gate: MCQ-only provisional feedback; final scores withheld until review.
- Academic + honesty review, appeal, appeal outcomes, result restoration on overturn.
- Learning path with curated resources, progress and feedback.
- Re-test and measured uplift (single-user, not a validated study).
- Automatic Skill Passport after review; public signed credential, share/copy/print/revoke.
- Candidate notifications for reviewed, rejected, more-info and appeal outcomes.
- Settings: profile shortcut, password change, emailed reset link, export/delete account.
- Jobs and applications with explicit result-sharing consent.

### Company
- Company verification form and status.
- Job creation, draft/publish/moderation states.
- Applicant pipeline and application report drawer.
- Candidate CV preview, required skills, shared evidence.
- Shared assessment scores and Skill Passport only when the candidate opts in.
- Team invitations, role assignment and revocation; security/MFA panel.

### Admin
- Overview metrics and action queues.
- Users/accounts; suspend/reactivate.
- Staff administration, role changes, revoke/delete with last-super-admin protection.
- Company verification queue.
- Job moderation queue.
- Assessment review with per-question stored-rubric drafts, editable marks, audit reason, academic decision.
- Exam integrity: advisory trust signals, honesty score, flags, evidence timeline, approval/rejection.
- CV identity review: filters, candidate confirmation, reviewer, notes, decisions.
- Candidate appeals: uphold/overturn/needs-more-info, separated duties, single-admin override, result restoration.
- Question governance and import/staging tools.
- Learning resource verification.
- AI operations/status, billing, privacy, fairness/quality, audit, security.

### Engine / trust controls
- Stored answer keys; no live AI grading.
- Deterministic scoring, server-side deadlines and attempt tokens.
- Explainable trust rules; no automatic fail.
- PII redaction and advisory identity signals.
- Immutable assessment releases and signed, revocable credentials.
- Human academic + honesty gates for publication.

## Chosen 60-second demo journey

Rationale: the strongest differentiator is not a dashboard or a CRUD screen. It is the complete trust loop:

**A real candidate proves skills through an assessment, a human reviewer approves the evidence, and the same evidence becomes a portable credential an employer can trust.**

The demonstration therefore follows one coherent candidate:
1. Candidate dashboard.
2. CV analysis with PII redaction and the identity-ownership confirmation.
3. Adaptive assessment question.
4. Pending result with the human-review gates.
5. Admin assessment report and academic approval.
6. Admin honesty approval.
7. Published verified result.
8. Automatically issued Skill Passport.
9. Public signed credential.
10. Employer viewing the candidate-shared passport.

This covers candidate, admin, and employer roles without spending the minute on login, settings, billing, or configuration screens.

## 60-second timeline

| Time | Scene | Actions shown |
|---|---|---|
| 0–3s | Candidate dashboard | Opens **Skill Journey** |
| 3–6s | Skill journey | Loads sample CV, starts analysis |
| 6–10s | CV analysis | Views redacted text, identity signal, confirms ownership |
| 10–13s | Skills | Confirms extracted skills |
| 13–25s | Adaptive assessment | Answers 3 questions, palette updates, timer runs, submits |
| 25–30s | Pending result | Sees provisional MCQ feedback and locked academic/honesty gates |
| 30–36s | Admin assessment review | Opens question evidence, approves academic marks with a reason |
| 36–40s | Admin exam integrity | Reviews honesty score/flags and approves honesty |
| 40–47s | Published result | 86/100, High trust, published workflow, topic scores |
| 47–50s | Skill Passport | Automatic issuance notice, verified skills, link |
| 50–54s | Public credential | Signed credential page, academic/honesty scores, topic evidence |
| 54–60s | Employer view | Applicant pipeline, shared-evidence drawer, verified passport |
| 60s | End | Replay control; app remains visible |

## Implementation notes

- The HTML embeds the real project CSS (`styles.css`, `workspace.css`, `assessment.css`, `avatar.css`) and reuses the actual class structure, labels, navigation, and section layouts from the React frontend.
- Screens are recreated as static DOM, not screenshots. The cursor moves, clicks, types, opens modals, submits decisions, and changes pages.
- No original project files were modified. The demo is a separate new file under `demo/`.
- The HTML is self-contained at ~339 KB.

## Verification performed

- Opened the local file in Chromium at 1440×900.
- Pressed PLAY; ran the complete 60-second timeline repeatedly.
- Captured and reviewed dashboard, CV analysis, exam, pending result, admin review modal, admin action modal, integrity approval, published result, passport, public credential, employer drawer, and end state.
- Confirmed:
  - no JavaScript page errors,
  - no console errors,
  - no network dependency,
  - cursor interactions align with target controls,
  - modals open/close,
  - typing and approvals complete,
  - progress reaches 100% at 60 seconds,
  - replay control appears without hiding the final UI.
