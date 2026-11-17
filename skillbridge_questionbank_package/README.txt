# SkillBridge Question Bank Package

## Source and extraction
- Source: Bangladesh Software Engineer Interview Master Handbook - Book.pdf (455 PDF pages).
- Numbered questions actually present: 1070 (Q1–Q770 and Q791–Q1090).
- Missing source numbers: Q771–Q790 (20 numbers are absent from the uploaded PDF). No questions were fabricated for these gaps.
- All 1070 extracted items contain four MCQ options and a source answer key. The source does not contain standalone coding or explainable prompts; scenario-style items with four options remain MCQs.
- Source explanations are absent for 158 questions; these explanation fields are left blank rather than invented.

## Assessment rules applied
- MCQ Easy: 1 mark / 45 sec; Medium: 1.5 marks / 60 sec; Hard: 2 marks / 80 sec.
- Coding Easy: 7 marks / 600 sec; Medium: 10 marks / 900 sec; Hard not used.
- Explainable and scenario explanation: 5 marks / 300 sec. These latter two rules are included in the policy but are not used because the PDF questions are MCQs.
- Difficulty is explicit in the PDF for 254 questions, star-only for 10, section note mapped for 19, and conservatively inferred for 787. See validation_report.json.

## Import compatibility blockers
- The current schema defines question_bank.marks and question_import_staging.marks as INTEGER.
- The current _question_payload converts marks with int(...), which would truncate 1.5.
- GraphRAG QuestionRecord declares marks as int.
- Apply the relevant database migration and importer_patch.diff before importing. Do not import the 1.5-mark values before this fix.
- The JSON is split into two batches because the current QuestionImportCommit limit is 1,000 questions: batch 1 = 1,000; batch 2 = 70.
- Import rows have status=draft. The admin bulk JSON endpoint writes to question_bank (not question_import_staging), but keeps the questions draft. Review and approve separately.

## Graph RAG
- skillbridge_graphrag_sidecar.json contains Category → Subcategory → Section → Question → Skill/Concept nodes and related-question edges.
- Skill/concept tags and same-section related-question links are enrichment, not literal PDF fields.
- The current SkillBridge GraphRAG indexer indexes active questions only and does not automatically ingest every field in this sidecar. Keep drafts out of retrieval until approved and graph ingestion is explicitly implemented.

## Files
- skillbridge_question_bank_import.json: full 1,070-row import payload.
- import_batch_01.json / import_batch_02.json: API-sized import batches.
- skillbridge_graphrag_sidecar.json: Graph RAG nodes and edges.
- source_audit.json: extracted source text per question for review.
- validation_report.json: counts, gaps, and section mapping.
- migration_postgresql.sql / migration_sqlite.sql: review-only schema migrations; not executed.
- importer_patch.diff: review-only importer/model changes; not applied.
- category_subcategory_updates.json: additions to existing category taxonomy.

No repository files were changed, no database writes were made, and no commit or push was performed.
