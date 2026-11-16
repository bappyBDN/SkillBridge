"""Review-gated, versioned assessment publication and grounded learning plans.

This module never grades answers. engine.py owns scoring; admins own approval.
Imports main lazily because both API modules use the same database helpers.
"""
import hashlib
import json
import time
import uuid

import engine as E

_UNSET = object()


def _m():
    import main
    return main


def ensure_schema():
    for statement in (
        """CREATE TABLE IF NOT EXISTS assessment_releases (
            id TEXT PRIMARY KEY, attempt_id TEXT NOT NULL, user_id INTEGER NOT NULL,
            fingerprint TEXT NOT NULL, result_json TEXT NOT NULL, honesty_json TEXT NOT NULL,
            academic_json TEXT NOT NULL, created REAL NOT NULL,
            UNIQUE(attempt_id,fingerprint))""",
        "CREATE INDEX IF NOT EXISTS idx_assessment_releases_attempt ON assessment_releases(attempt_id,created)",
        "CREATE INDEX IF NOT EXISTS idx_assessment_releases_user ON assessment_releases(user_id,created)",
        """CREATE TABLE IF NOT EXISTS assessment_learning_plans (
            id TEXT PRIMARY KEY, release_id TEXT NOT NULL UNIQUE, user_id INTEGER NOT NULL,
            payload TEXT NOT NULL, created REAL NOT NULL)""",
    ):
        _m().run(statement)


def _load(value, default):
    if isinstance(value, (dict, list)):
        return value
    try:
        return json.loads(value) if value else default
    except (ValueError, TypeError):
        return default


def review_state(attempt_id, *, attempt=None, academic=_UNSET, honesty=_UNSET, evaluations=_UNSET):
    m = _m()
    attempt = dict(attempt) if attempt else m.one("SELECT * FROM attempts WHERE id=?", (attempt_id,))
    if not attempt:
        return {"stage": "not_found", "ready": False, "pending_evaluations": 0}
    attempt = dict(attempt)
    result = _load(attempt.get("result"), {})
    if academic is _UNSET:
        academic = m.one("SELECT decision,reason,reviewer_id,reviewed_at FROM admin_attempt_reviews WHERE attempt_id=?", (attempt_id,))
    if honesty is _UNSET:
        honesty = m.one("SELECT auto_score,score,status,reason,reviewer_id,reviewed_at FROM attempt_honesty_reviews WHERE attempt_id=?", (attempt_id,))
    if evaluations is _UNSET:
        evaluations = m.allr("SELECT question_id,status,final_marks FROM answer_evaluations WHERE attempt_id=?", (attempt_id,))
    evaluations = {row["question_id"]: dict(row) for row in evaluations}
    subjective = [q for q in result.get("question_results", []) if not q.get("objective", m._question_is_objective(q))]
    pending = sum(1 for q in subjective if evaluations.get(q["question_id"], {}).get("status") != "approved" or evaluations.get(q["question_id"], {}).get("final_marks") is None)
    academic_status = academic["decision"] if academic else "pending"
    honesty_status = honesty["status"] if honesty else "pending"
    has_scores = isinstance(result.get("overall"), (int, float)) and any(isinstance(topic, dict) and topic.get("score") is not None for topic in result.get("topics", {}).values())
    ready = bool(attempt["status"] == "done" and academic_status == "approved" and honesty_status == "approved" and pending == 0 and has_scores)
    stage = ("in_progress" if attempt["status"] != "done" else
             "invalidated" if academic_status == "invalidated" else
             "evaluation_pending" if pending or not has_scores else
             "academic_review" if academic_status != "approved" else
             "honesty_review" if honesty_status != "approved" else "published")
    return {"stage": stage, "ready": ready, "academic_status": academic_status,
            "honesty_status": honesty_status, "pending_evaluations": pending,
            "honesty": {"score": honesty["score"] if honesty else E.honesty_score(result.get("trust_points", 0), result.get("trust_hard_flags", [])),
                        "status": honesty_status, "reviewed_at": honesty["reviewed_at"] if honesty else None,
                        "advisory": True},
            "academic_reviewed_at": academic["reviewed_at"] if academic else None}


def _fingerprint(result, academic, honesty):
    # Timestamps may change on an identical retry; the published content does not.
    content = {
        "overall": result.get("overall"), "topics": result.get("topics"),
        "sections": result.get("section_scores"), "trust": result.get("trust"),
        "questions": [{k: q.get(k) for k in ("question_id", "awarded_marks", "max_marks", "evaluation_status")} for q in result.get("question_results", [])],
        "academic": {k: academic.get(k) for k in ("decision", "reason", "reviewer_id")},
        "honesty": {k: honesty.get(k) for k in ("score", "status", "reason", "reviewer_id")},
    }
    return hashlib.sha256(json.dumps(content, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def current_release(attempt_id):
    m = _m()
    if not review_state(attempt_id)["ready"]:
        return None
    attempt = m.one("SELECT result FROM attempts WHERE id=?", (attempt_id,))
    academic = dict(m.one("SELECT * FROM admin_attempt_reviews WHERE attempt_id=?", (attempt_id,)))
    honesty = dict(m.one("SELECT * FROM attempt_honesty_reviews WHERE attempt_id=?", (attempt_id,)))
    fingerprint = _fingerprint(_load(attempt["result"], {}), academic, honesty)
    row = m.one("SELECT * FROM assessment_releases WHERE attempt_id=? AND fingerprint=?", (attempt_id, fingerprint))
    return dict(row) if row else None


def sync_release(attempt_id):
    """Either withdraw current credentials or publish a complete review snapshot.

    Called after either review, independent of approval order. Immutable releases
    retain previous scores; stale public credentials are never silently rewritten.
    """
    m = _m()
    state = review_state(attempt_id)
    attempt = m.one("SELECT * FROM attempts WHERE id=?", (attempt_id,))
    if not attempt:
        return {"publication": state, "passport_id": None, "release_id": None}
    if not state["ready"]:
        # Existing integer flag: 1 = holder revoked, 2 = withdrawn by review.
        # Both are revoked publicly; only review withdrawal may be reissued.
        m.run("UPDATE passports SET revoked=2 WHERE source_attempt=? AND revoked=0", (attempt_id,))
        return {"publication": state, "passport_id": None, "release_id": None}
    result = _load(attempt["result"], {})
    academic = dict(m.one("SELECT * FROM admin_attempt_reviews WHERE attempt_id=?", (attempt_id,)))
    honesty = dict(m.one("SELECT * FROM attempt_honesty_reviews WHERE attempt_id=?", (attempt_id,)))
    fingerprint = _fingerprint(result, academic, honesty)
    release = m.one("SELECT id FROM assessment_releases WHERE attempt_id=? AND fingerprint=?", (attempt_id, fingerprint))
    if release:
        release_id = release["id"]
    else:
        release_id = uuid.uuid4().hex
        m.run("""INSERT INTO assessment_releases(id,attempt_id,user_id,fingerprint,result_json,honesty_json,academic_json,created)
                 VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(attempt_id,fingerprint) DO NOTHING""",
              (release_id, attempt_id, attempt["user_id"], fingerprint, json.dumps(result), json.dumps(honesty), json.dumps(academic), time.time()))
        release_id = m.one("SELECT id FROM assessment_releases WHERE attempt_id=? AND fingerprint=?", (attempt_id, fingerprint))["id"]
        # Previously shared passports represent an older result revision.
        m.run("UPDATE passports SET revoked=2 WHERE source_attempt=? AND revoked=0", (attempt_id,))
        m.audit(attempt["user_id"], "assessment_released", attempt_id + ":" + release_id)
    ensure_learning_plan(release_id)
    passport_id = m.create_passport_for_attempt(attempt["user_id"], attempt_id, release_id=release_id)
    return {"publication": state, "passport_id": passport_id, "release_id": release_id}


def ensure_learning_plan(release_id):
    m = _m()
    existing = m.one("SELECT * FROM assessment_learning_plans WHERE release_id=?", (release_id,))
    if existing:
        return {"id": existing["id"], **_load(existing["payload"], {})}
    release = m.one("SELECT * FROM assessment_releases WHERE id=?", (release_id,))
    if not release:
        return None
    result = _load(release["result_json"], {})
    catalogue = [dict(row) for row in m.allr("SELECT * FROM learning_resources WHERE verification_status='verified'")]
    plan = E.retrieve_learning_plan(result.get("topics", {}), catalogue)
    plan.update({"release_id": release_id, "based_on": release["attempt_id"], "created": time.time(),
                 "method": "approved_catalogue_retrieval_v1", "ai_generated": False})
    plan_id = uuid.uuid4().hex
    m.run("""INSERT INTO assessment_learning_plans(id,release_id,user_id,payload,created)
             VALUES (?,?,?,?,?) ON CONFLICT(release_id) DO NOTHING""",
          (plan_id, release_id, release["user_id"], json.dumps(plan), time.time()))
    saved = m.one("SELECT id,payload FROM assessment_learning_plans WHERE release_id=?", (release_id,))
    return {"id": saved["id"], **_load(saved["payload"], {})}


def candidate_summary(attempt_id, result):
    """Do not present an objective-only percentage as a final skill score."""
    state = review_state(attempt_id)
    clean = json.loads(json.dumps(result))
    clean["publication"] = state
    clean["honesty"] = state.get("honesty")
    clean["finalized"] = state["ready"]
    if not state["ready"]:
        clean["overall"] = None
        clean["level"] = None
        clean["topics"] = {key: {**topic, "score": None, "level": None, "provisional": True} for key, topic in clean.get("topics", {}).items()}
        clean["section_scores"] = {key: {**section, "score": None} for key, section in (clean.get("section_scores") or {}).items()} or None
    return clean
