-- REVIEW ONLY: SQLite requires rebuilding both tables to change INTEGER marks to REAL.
-- Back up the database first. Preserve all indexes/triggers from the live schema before applying.
PRAGMA foreign_keys=OFF;
BEGIN IMMEDIATE;
CREATE TABLE question_bank_new (id TEXT PRIMARY KEY, category_id TEXT NOT NULL, subcategory TEXT NOT NULL DEFAULT '', question_type TEXT NOT NULL, difficulty_level TEXT NOT NULL, question_text TEXT NOT NULL, options TEXT NOT NULL DEFAULT '[]', correct_answer TEXT NOT NULL DEFAULT '', explanation TEXT NOT NULL DEFAULT '', reference_answer TEXT NOT NULL DEFAULT '', grading_rubric TEXT NOT NULL DEFAULT '', marks REAL NOT NULL DEFAULT 1, time_allocation INTEGER NOT NULL DEFAULT 60, status TEXT NOT NULL DEFAULT 'draft', created_by TEXT NOT NULL, created_at REAL NOT NULL, version INTEGER NOT NULL DEFAULT 1);
INSERT INTO question_bank_new SELECT id,category_id,subcategory,question_type,difficulty_level,question_text,options,correct_answer,explanation,reference_answer,grading_rubric,CAST(marks AS REAL),time_allocation,status,created_by,created_at,version FROM question_bank;
DROP TABLE question_bank;
ALTER TABLE question_bank_new RENAME TO question_bank;
CREATE TABLE question_import_staging_new (id TEXT PRIMARY KEY, batch_id TEXT NOT NULL, source_url TEXT NOT NULL DEFAULT '', category_id TEXT NOT NULL DEFAULT '', subcategory TEXT NOT NULL DEFAULT '', question_type TEXT NOT NULL, difficulty_level TEXT NOT NULL, question_text TEXT NOT NULL, options TEXT NOT NULL DEFAULT '[]', correct_answer TEXT NOT NULL DEFAULT '', explanation TEXT NOT NULL DEFAULT '', reference_answer TEXT NOT NULL DEFAULT '', grading_rubric TEXT NOT NULL DEFAULT '', marks REAL NOT NULL DEFAULT 1, time_allocation INTEGER NOT NULL DEFAULT 60, status TEXT NOT NULL DEFAULT 'draft', raw TEXT NOT NULL DEFAULT '', created_by TEXT NOT NULL, created_at REAL NOT NULL);
INSERT INTO question_import_staging_new SELECT id,batch_id,source_url,category_id,subcategory,question_type,difficulty_level,question_text,options,correct_answer,explanation,reference_answer,grading_rubric,CAST(marks AS REAL),time_allocation,status,raw,created_by,created_at FROM question_import_staging;
DROP TABLE question_import_staging;
ALTER TABLE question_import_staging_new RENAME TO question_import_staging;
CREATE INDEX IF NOT EXISTS idx_question_bank_category_status ON question_bank(category_id,status);
CREATE INDEX IF NOT EXISTS idx_question_staging_category ON question_import_staging(category_id);
COMMIT;
PRAGMA foreign_keys=ON;
