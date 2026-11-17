-- REVIEW ONLY: SkillBridge fractional marks migration. Not executed.
BEGIN;
ALTER TABLE question_bank ALTER COLUMN marks TYPE NUMERIC(5,1) USING marks::numeric;
ALTER TABLE question_import_staging ALTER COLUMN marks TYPE NUMERIC(5,1) USING marks::numeric;
COMMIT;
