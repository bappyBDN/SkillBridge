# Assessment evaluation, review and publication

## Authoritative flow

1. Submitting an assessment stores the original answers and finishes the attempt. MCQ and reference-query SQL checks run immediately. Explanation, coding, scenario and other descriptive responses receive deterministic stored-rubric drafts from `backend/engine.py`, stored in `answer_evaluations` as `pending_approval`.
2. Candidates can see explicitly labelled **MCQ-only provisional feedback**. Incomplete percentages are not presented as verified topic/overall scores. Unapproved responses are not scored as zero; their topics remain visible with pending status.
3. In **Admin → Assessment reviews**, the reviewer examines the question, stored reference/rubric, original response, draft evidence and marks. Marks can be increased or reduced within `0..question maximum`, including reasoned MCQ adjustments. Negative totals and non-finite/out-of-range values are rejected. A missing stored rubric requires explicit human marks and a note, not blind acceptance of a zero-valued draft.
4. In **Admin → Exam integrity**, the reviewer examines the honesty report, adjusts its advisory `0..100` score and records a reasoned approval/decision. This does not alter technical marks and is not an automatic cheating verdict or rejection.
5. Either approval may happen first. Only completed academic evaluation **and** approved academic/honesty reviews can publish a result. Academic approval alone does not release recommendations or a passport.
6. A released result creates an immutable `assessment_releases` snapshot and a matching `assessment_learning_plans` snapshot. The passport copies the same topic percentages, question counts and approved honesty score. Public verification checks the current review state, revision and signature; it never trusts only an old signed snapshot.

## Changes after approval

- Editing approved marks withdraws existing credentials and reopens academic review. Re-approval publishes a new content revision and learning plan; older snapshots remain in history.
- Editing/reopening honesty review withdraws the verified result until the honesty review is approved again. Technical marks do not change.
- Repeating an identical publication does not create duplicate result snapshots. A credential withdrawn by review can be reissued when approval is restored. A holder's deliberate revocation is not automatically undone. The existing integer passport `revoked` field uses `0` for active, `1` for holder revocation and `2` for review withdrawal; all nonzero states are revoked publicly.
- A missing historical grading record is not fabricated. The admin can rerun the stored-rubric evaluator for a submitted GraphRAG attempt or request more information.
- Candidate result, Gap, Learning, Passport and employer shared-result views use the same publication gate. Candidate sharing consent remains required for employer scores/passports.

## Retrieval-grounded learning and optional AI

The saved plan retrieves up to three human-reviewed catalogue resources per assessed weak topic, using the approved score and course level. It stores source IDs, URLs and the reason for each match. Unassessed topics and incomplete results are not used to invent weaknesses or courses. Missing resource coverage is reported honestly. Started/completed course progress remains tracked separately from exam marks.

After publication, **Explain my study plan with AI** optionally uses the existing backend `AI_PROVIDER`, matching provider keys/model, and fallback settings. It receives only PII-redacted approved topic scores and retrieved course metadata—not the candidate's identity, CV, submitted answers, honesty score or integrity evidence. Output IDs must cite retrieved sources; invented IDs, duplicate IDs and arbitrary URLs are discarded. Explanations are cached against the result revision, rate-limited and optional: missing credentials/provider failures do not break the retrieved course plan. Responses returning after a result is changed are discarded.

**Project grading policy is unchanged:** no live LLM grading. The obsolete admin call to an undefined `grade_descriptive_answer` provider method is removed from the scoring path. Course explanations cannot edit grades or approve results. Coding drafts compare stored references/rubrics; they are not a secure executable-code correctness certification and require human review.

## Tracking, privacy and migration

The new tables are additive/idempotent on startup. Existing academic-only approvals require a separate honesty approval before verified publication; previously created passports without a matching dual-approved release no longer verify. Original question/answer records are preserved. Release and learning snapshots are included in account export and removed on account deletion.

The redesigned public passport includes topic scores, question counts, separate academic/honesty scores, dates, revision, signature status, revocable verification link and print/save-PDF controls. It remains explicitly labelled as an R0 prototype, not an accredited qualification.

## Verification

```powershell
cd backend
.\.venv\Scripts\python.exe -m pytest -q tests
cd ../frontend
npm test
npm run test:e2e
npm run lint
npm run build
```

Backend integration tests cover both approval orders, incomplete-score masking, source-grounded retrieval, mark/honesty amendments, stale credential withdrawal, holder revocation, invalid mark rejection, export/deletion and provider-safe learning explanations. Browser tests use synthetic mocked API fixtures and cover review gates, learning guidance/citations and desktop/mobile passport rendering. Live PostgreSQL, deployed provider credentials and production MFA still require staging checks.
