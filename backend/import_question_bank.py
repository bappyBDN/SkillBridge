"""Import the SkillBridge question-bank package into the configured database.

Reads ``skillbridge_questionbank_package/skillbridge_question_bank_import.json``
(or a single ``import_batch_*.json``) and inserts every question into
``question_bank`` with ``status='draft'``. Rows are never published
automatically: an admin must review and activate them separately.

Idempotent: an existing question id, or an existing question with the same
normalised text in the same category, is skipped. Rerunning the script is safe.

Usage (from the backend folder):
    python import_question_bank.py                 # import + merge subcategories
    python import_question_bank.py --dry-run       # validate only, no writes
    python import_question_bank.py --file ../skillbridge_questionbank_package/import_batch_01.json

Environment: DATABASE_URL (PostgreSQL) is used when set; otherwise DB_PATH
(default /data/skillbridge.db) for SQLite. A local ``../.env`` file is read as a
fallback so the script works the same way the running app does.
"""
from __future__ import annotations

import argparse
import json
import os
import sqlite3
import sys
import time
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parent
PACKAGE_DIR = BACKEND_DIR.parent / "skillbridge_questionbank_package"
DEFAULT_FILE = PACKAGE_DIR / "skillbridge_question_bank_import.json"
CATEGORY_UPDATES = PACKAGE_DIR / "category_subcategory_updates.json"

ALLOWED_TYPES = {"MCQ", "Coding", "Explainable", "Scenario-Based"}
ALLOWED_DIFFICULTY = {"Easy", "Medium", "Hard"}
ALLOWED_STATUS = {"draft", "active", "archived"}
MIN_MARKS, MAX_MARKS = 0.5, 100

INSERT_SQL = """INSERT INTO question_bank(id,category_id,subcategory,question_type,difficulty_level,
    question_text,options,correct_answer,explanation,reference_answer,grading_rubric,marks,
    time_allocation,status,created_by,created_at,version)
    VALUES ({0},{0},{0},{0},{0},{0},{0},{0},{0},{0},{0},{0},{0},{0},{0},{0},{0})
    ON CONFLICT(id) DO NOTHING"""

COLUMNS = ("id", "category_id", "subcategory", "question_type", "difficulty_level",
           "question_text", "options", "correct_answer", "explanation", "reference_answer",
           "grading_rubric", "marks", "time_allocation", "status", "created_by",
           "created_at", "version")


def _load_env_file() -> None:
    """Load ../.env without overriding variables already set in the process."""
    env_path = BACKEND_DIR.parent / ".env"
    if not env_path.is_file():
        return
    for line in env_path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip())


def _connect():
    database_url = os.getenv("DATABASE_URL", "").strip()
    if database_url:
        import psycopg
        from psycopg.rows import dict_row
        return psycopg.connect(database_url, row_factory=dict_row), True
    db_path = os.getenv("DB_PATH", "/data/skillbridge.db")
    Path(db_path).parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(db_path, timeout=10)
    conn.row_factory = sqlite3.Row
    return conn, False


def _read_questions(path: Path) -> list[dict]:
    data = json.loads(path.read_text(encoding="utf-8-sig"))
    if isinstance(data, list):
        return data
    questions = data.get("questions")
    if not isinstance(questions, list):
        raise SystemExit(f"{path} does not contain a 'questions' list")
    return questions


def _validate(raw: dict, categories: dict[str, set[str]]) -> list[str]:
    errors: list[str] = []
    if not str(raw.get("id") or "").strip():
        errors.append("missing id")
    category_id = str(raw.get("category_id") or "")
    if category_id not in categories:
        errors.append(f"unknown category {raw.get('category_id')!r}")
    else:
        subcategory = str(raw.get("subcategory") or "").strip().lower()
        if not subcategory:
            errors.append("missing subcategory")
        elif subcategory not in categories[category_id]:
            errors.append(f"subcategory {raw.get('subcategory')!r} is not in {category_id}")
    if str(raw.get("question_type") or "") not in ALLOWED_TYPES:
        errors.append(f"invalid question_type {raw.get('question_type')!r}")
    if str(raw.get("difficulty_level") or "") not in ALLOWED_DIFFICULTY:
        errors.append(f"invalid difficulty {raw.get('difficulty_level')!r}")
    if not str(raw.get("question_text") or "").strip():
        errors.append("missing question_text")
    question_type = str(raw.get("question_type") or "")
    options = raw.get("options") if isinstance(raw.get("options"), list) else []
    if question_type == "MCQ":
        if len(options) < 2:
            errors.append("needs at least two options")
        elif len(options) > 10:
            errors.append("more than ten options")
        key = str(raw.get("correct_answer") or "").strip()
        if not key:
            errors.append("missing correct_answer")
        elif len(key) > 1 and key not in [str(x).strip() for x in options]:
            errors.append("correct_answer is not one of the options")
        elif len(key) == 1 and key.upper() not in "ABCDEFGHIJ"[:len(options)]:
            errors.append("letter correct_answer is out of range")
        if len({str(x).strip() for x in options}) != len(options):
            errors.append("duplicate options")
    else:
        if options:
            errors.append("non-MCQ must not have options")
        if not str(raw.get("reference_answer") or "").strip():
            errors.append("missing reference_answer")
        if not str(raw.get("grading_rubric") or "").strip():
            errors.append("missing grading_rubric")
    try:
        marks = float(raw.get("marks"))
        if not MIN_MARKS <= marks <= MAX_MARKS:
            errors.append(f"marks {marks} outside {MIN_MARKS}..{MAX_MARKS}")
    except (TypeError, ValueError):
        errors.append("marks is not numeric")
    try:
        seconds = int(raw.get("time_allocation"))
        if not 15 <= seconds <= 7200:
            errors.append(f"time_allocation {seconds} outside 15..7200")
    except (TypeError, ValueError):
        errors.append("time_allocation is not numeric")
    if str(raw.get("status") or "draft") not in ALLOWED_STATUS:
        errors.append("invalid status")
    return errors


def _normalise(raw: dict, actor: str) -> tuple:
    options = [str(x).strip() for x in raw.get("options") or []]
    correct_answer = str(raw.get("correct_answer") or "").strip()
    # MCQ answer keys must be the option text: the exam UI submits the chosen
    # option string and scoring compares it to correct_answer case-insensitively.
    # Accept letter keys (A-J) from source packages and resolve them here.
    if (str(raw.get("question_type") or "").strip() == "MCQ" and len(correct_answer) == 1
            and correct_answer.upper() in "ABCDEFGHIJ"[:len(options)]):
        correct_answer = options["ABCDEFGHIJ".index(correct_answer.upper())]
    return (
        str(raw["id"]).strip(),
        str(raw["category_id"]).strip(),
        str(raw.get("subcategory") or "General").strip()[:100],
        str(raw["question_type"]).strip(),
        str(raw["difficulty_level"]).strip(),
        str(raw["question_text"]).strip(),
        json.dumps(options, ensure_ascii=False),
        correct_answer,
        str(raw.get("explanation") or ""),
        str(raw.get("reference_answer") or ""),
        str(raw.get("grading_rubric") or ""),
        float(raw.get("marks")),
        int(raw["time_allocation"]),
        "draft",  # imports always enter the review queue as drafts
        str(raw.get("created_by") or actor),
        time.time(),
        1,
    )


def _merge_subcategories(conn, postgres: bool) -> list[str]:
    if not CATEGORY_UPDATES.is_file():
        return []
    proposed = json.loads(CATEGORY_UPDATES.read_text(encoding="utf-8-sig")).get("updates", {})
    merged: list[str] = []
    cursor = conn.cursor() if postgres else conn
    for category_id, additions in proposed.items():
        select_sql = "SELECT subcategories FROM question_categories WHERE id=?"
        if postgres:
            select_sql = select_sql.replace("?", "%s")
        row = cursor.execute(select_sql, (category_id,)).fetchone()
        if not row:
            merged.append(f"{category_id}: category not found, skipped")
            continue
        try:
            current = json.loads(row["subcategories"] if postgres else row["subcategories"]) or []
        except (TypeError, ValueError):
            current = []
        if not isinstance(current, list):
            current = []
        lookup = {str(x).strip().lower() for x in current}
        added = [x for x in additions if str(x).strip().lower() not in lookup]
        if not added:
            merged.append(f"{category_id}: already up to date")
            continue
        merged.append(f"{category_id}: added {', '.join(added)}")
        statement = "UPDATE question_categories SET subcategories=? WHERE id=?"
        args = (json.dumps(current + added, ensure_ascii=False), category_id)
        if postgres:
            cursor.execute(statement.replace("?", "%s"), args)
        else:
            cursor.execute(statement, args)
    return merged


def main() -> int:
    parser = argparse.ArgumentParser(description="Import question-bank package rows as drafts.")
    parser.add_argument("--file", type=Path, default=DEFAULT_FILE)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--actor", default="PDF Import - Review Required")
    parser.add_argument("--skip-subcategories", action="store_true")
    args = parser.parse_args()

    _load_env_file()
    if not args.file.is_file():
        raise SystemExit(f"Import file not found: {args.file}")

    questions = _read_questions(args.file)
    conn, postgres = _connect()
    cursor = conn.cursor() if postgres else conn

    categories = {
        row["id"]: {
            str(value).strip().lower()
            for value in (json.loads(row["subcategories"] or "[]") or [])
            if str(value).strip()
        }
        for row in cursor.execute("SELECT id, subcategories FROM question_categories").fetchall()
    }
    existing_ids = {row["id"] for row in cursor.execute("SELECT id FROM question_bank").fetchall()}
    existing_text = {
        (str(row["question_text"]).strip().lower(), row["category_id"])
        for row in cursor.execute("SELECT question_text, category_id FROM question_bank").fetchall()
    }

    rows: list[tuple] = []
    seen_ids: set[str] = set()
    in_file_text: dict[tuple[str, str], str] = {}
    repeated: list[tuple[str, str]] = []
    skipped = 0
    rejected: list[tuple[str, list[str]]] = []
    for raw in questions:
        errors = _validate(raw, categories)
        if errors:
            rejected.append((str(raw.get("id") or "?"), errors))
            continue
        row = _normalise(raw, args.actor)
        qid, category_id, text = row[0], row[1], row[5]
        dedupe_key = (text.strip().lower(), category_id)
        if qid in existing_ids or qid in seen_ids:
            skipped += 1
            continue
        if dedupe_key in existing_text:
            skipped += 1
            continue
        if dedupe_key in in_file_text:
            # Distinct source questions that happen to share wording: keep both
            # (they keep their source number) but flag them for the reviewer.
            repeated.append((qid, in_file_text[dedupe_key]))
        else:
            in_file_text[dedupe_key] = qid
        seen_ids.add(qid)
        rows.append(row)

    print(f"file: {args.file}")
    print(f"database: {'PostgreSQL' if postgres else 'SQLite'}")
    print(f"questions in file: {len(questions)}")
    print(f"to insert: {len(rows)} | skipped (already in database): {skipped} | rejected: {len(rejected)}")
    if repeated:
        print(f"note: {len(repeated)} source questions share wording with an earlier row "
              f"(kept as separate drafts, e.g. {repeated[0][0]} vs {repeated[0][1]}).")
    for qid, errors in rejected[:20]:
        print(f"  rejected {qid}: {'; '.join(errors)}")
    if rejected:
        print("Aborting: fix the rejected rows before importing so the bank stays clean.")
        conn.rollback()
        conn.close()
        return 1

    if args.dry_run:
        print("dry run: no rows written")
        conn.rollback()
        conn.close()
        return 0

    placeholders = "%s" if postgres else "?"
    statement = INSERT_SQL.format(placeholders)
    if rows:
        cursor.executemany(statement, rows)
    subcategory_report = []
    if not args.skip_subcategories:
        subcategory_report = _merge_subcategories(conn, postgres)
    conn.commit()
    conn.close()

    print(f"inserted: {len(rows)}")
    for line in subcategory_report:
        print(f"category {line}")
    print("status: draft (review and activate in Admin > Questions)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
