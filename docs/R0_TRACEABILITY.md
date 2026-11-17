# R0 traceability (PRD §11, R0 scope)
| R0 item | Where |
|---|---|
| One role (Data Analyst) complete loop | `content.JOB`, UI steps Profile→Passport |
| CV → skills | `POST /api/cv`, `engine.redact`, `engine.rule_extract`, optional `llm_extract` (PRF-02/03/10) |
| Skills start Claimed, user confirms | `PUT /api/skills`; Verified only via attempt (PRF-04) |
| SQL/MCQ test, adaptive, stored key | `engine.pick_question/record_answer/grade_sql` (ASM-01/02/03/04/07) |
| Trust label, no auto-fail, appeal | `engine.trust_label`, `/attempts/{id}/appeal` (INTG-05/06) |
| Consent screen | `Consent` component, `POST /api/consent` (INTG-01) |
| Learning path with sources, honest empty | `engine.build_path` (LRN-01/02/03) |
| Re-test, uplift, immutable result per attempt | `/api/uplift`, attempts stored separately (LRN-06, ASM-12) |
| Skill Passport auto-issued after review, shareable/revocable/signed | `assessment_workflow.sync_release`, `main.create_passport_for_attempt`, `DELETE /api/passport/{id}`, `/api/public/passport/{id}` (PSP-01/03) |
| Bangla/English toggle | `frontend/src/i18n.js` (L10N-01) |
| Data export/delete | `/api/me/export`, `DELETE /api/me` (AUTH-08) |
| Mock items labelled | Banner + `chip-mock` |
