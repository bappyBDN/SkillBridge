"""Always-on proctoring: consent/permission gating and scoped evidence storage."""
import io
import json
import os
import sys
import tempfile
import time
import uuid

os.environ.setdefault("DB_PATH", os.path.join(tempfile.mkdtemp(prefix="sb_proctor_"), "test.db"))
os.environ.setdefault("PBKDF2_ITERATIONS", "1000")
os.environ["SEED_DEMO"] = "false"
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import pytest
from PIL import Image
import main
import proctoring as P
from test_exam_start_flow import candidate, blueprint, client  # noqa: F401 - shared synthetic-bank fixture


@pytest.fixture
def proctored(candidate):
    uid, headers = candidate
    bp = blueprint(headers)
    body = {"blueprint_id": bp["blueprint_id"], "proctoring_consent": P.CONSENT_VERSION,
            "proctoring_ready": {key: True for key in P.REQUIRED}, "identity_status": "needs_review"}
    return uid, headers, body


def start(proctored):
    _, headers, body = proctored
    response = client.post("/api/attempts", json=body, headers=headers)
    assert response.status_code == 200, response.text
    return response.json()


def signal(headers, attempt, kind, seq, metadata=None):
    response = client.post(f"/api/attempts/{attempt['attempt_id']}/event", headers=headers,
                           json={"type": kind, "session_id": attempt["session_id"], "seq": seq, "metadata": metadata or {}})
    assert response.status_code == 200, response.text
    return seq


def ready(headers, attempt):
    for seq, kind in enumerate(("screen_share_started", "fullscreen_enter", "camera_started", "microphone_started"), 1):
        signal(headers, attempt, kind, seq, {"surface": "monitor"} if seq == 1 else {})


def jpeg():
    output = io.BytesIO()
    Image.new("RGB", (20, 20), (50, 80, 100)).save(output, format="JPEG")
    return output.getvalue()


def upload(headers, attempt, seq=5, source="camera", payload=None, kind="ai_audio_level"):
    return client.post(f"/api/attempts/{attempt['attempt_id']}/evidence", headers=headers,
                       data={"session_id": attempt["session_id"], "event_seq": str(seq), "event_type": kind,
                             "confidence": "0", "source": source},
                       files={"image": ("snapshot.jpg", payload if payload is not None else jpeg(), "image/jpeg")})


def test_every_exam_is_proctored_without_any_mode_switch(candidate, monkeypatch):
    # The old environment switch no longer turns the camera off.
    monkeypatch.setenv("ASSESSMENT_PROCTORING_MODE", "r0")
    uid, headers = candidate
    policy = client.get("/api/state", headers=headers).json()["proctoring_policy"]
    assert policy["mode"] == "proctored"
    assert policy["required"] == ["screen", "fullscreen", "camera", "microphone"]
    response = client.post("/api/attempts", json={"blueprint_id": blueprint(headers)["blueprint_id"]}, headers=headers)
    assert response.status_code == 409
    assert response.json()["detail"] == "proctoring_consent_required"
    assert main.one("SELECT COUNT(*) AS n FROM attempts WHERE user_id=?", (uid,))["n"] == 0


def test_attempts_saved_with_the_old_label_stay_proctored():
    legacy_mode, legacy_consent = "r1", "r1-proctoring-v1"  # labels stored on older attempts
    assert P.is_proctored({"mode": legacy_mode}) and P.is_proctored({"mode": "proctored"})
    assert not P.is_proctored({"mode": "legacy_unproctored"}) and not P.is_proctored(None)
    assert P.consent_ok(legacy_consent) and P.consent_ok(P.CONSENT_VERSION)


def test_all_four_permissions_and_versioned_consent_are_required_before_creation(proctored):
    uid, headers, body = proctored
    for field in ("proctoring_consent", "identity_status"):
        bad = {**body, field: None}
        assert client.post("/api/attempts", json=bad, headers=headers).status_code == 409
    for key in P.REQUIRED:
        bad = {**body, "proctoring_ready": {**body["proctoring_ready"], key: False}}
        assert client.post("/api/attempts", json=bad, headers=headers).status_code == 409
    assert main.one("SELECT COUNT(*) AS n FROM attempts WHERE user_id=?", (uid,))["n"] == 0
    attempt = start(proctored)
    assert attempt["proctoring"]["mode"] == "proctored" and attempt["proctoring"]["consented_at"]
    assert attempt["duration_seconds"] == 2400


def test_permission_interruptions_pause_answers_until_restoration_without_failing(proctored):
    _, headers, _ = proctored
    attempt = start(proctored)
    aid = attempt["attempt_id"]
    answer_headers = {**headers, "X-Exam-Session": attempt["session_id"]}
    body = {"question_id": attempt["question"]["id"], "answer": "MOCK answer"}
    answer = lambda: client.post(f"/api/attempts/{aid}/answer", json=body, headers=answer_headers)
    assert answer().status_code == 409
    ready(headers, attempt)
    assert answer().status_code == 200
    signal(headers, attempt, "microphone_stopped", 5)
    assert answer().status_code == 409
    signal(headers, attempt, "microphone_started", 6)
    assert answer().status_code == 200
    signal(headers, attempt, "camera_stopped", 7)
    assert answer().status_code == 409
    signal(headers, attempt, "camera_started", 8)
    assert answer().status_code == 200
    signal(headers, attempt, "screen_share_started", 9, {"surface": "window"})
    assert answer().json()["detail"] == "entire_screen_required"
    assert main.one("SELECT status FROM attempts WHERE id=?", (aid,))["status"] == "active"
    # Quitting must work even when a required permission is missing.
    assert client.post(f"/api/attempts/{aid}/quit", json={"session_id": attempt["session_id"]}, headers=headers).status_code == 200


def test_resuming_requires_fresh_permission_attestation_and_new_session_events(proctored):
    uid, headers, body = proctored
    attempt = start(proctored)
    ready(headers, attempt)
    response = client.post("/api/attempts", headers=headers, json={"resume_attempt_id": attempt["attempt_id"]})
    assert response.status_code == 409
    resumed = client.post("/api/attempts", headers=headers, json={**body, "resume_attempt_id": attempt["attempt_id"]})
    assert resumed.status_code == 200, resumed.text
    resumed = resumed.json()
    assert resumed["session_id"] != attempt["session_id"]
    body = {"question_id": attempt["question"]["id"], "answer": "MOCK"}
    url = f"/api/attempts/{attempt['attempt_id']}/answer"
    assert client.post(url, json=body, headers={**headers, "X-Exam-Session": attempt["session_id"]}).status_code == 409
    assert client.post(url, json=body, headers={**headers, "X-Exam-Session": resumed["session_id"]}).status_code == 409
    ready(headers, resumed)
    assert client.post(url, json=body, headers={**headers, "X-Exam-Session": resumed["session_id"]}).status_code == 200
    assert main.one("SELECT COUNT(*) AS n FROM attempts WHERE user_id=?", (uid,))["n"] == 1


def test_sound_flag_links_camera_and_screen_snapshots_with_factual_notes_and_retention(proctored):
    _, headers, _ = proctored
    attempt = start(proctored)
    ready(headers, attempt)
    signal(headers, attempt, "ai_audio_level", 5, {"level": .12, "threshold": .028, "duration_ms": 1200})
    assert upload(headers, attempt, seq=99).status_code == 409
    saved = upload(headers, attempt)
    assert saved.status_code == 200, saved.text
    second = upload(headers, attempt, source="screen")
    assert second.status_code == 200, second.text
    assert upload(headers, attempt).status_code == 409
    rows = main.allr("SELECT * FROM exam_evidence WHERE attempt_id=?", (attempt["attempt_id"],))
    assert len(rows) == 2 and rows[0]["event_id"] == rows[1]["event_id"]
    for row in rows:
        note = json.loads(row["vision_json"])
        assert note["advisory"] is True and "not speech recognition" in note["summary"]
        assert note["level"] == .12 and note["source"] in ("camera", "screen")
        assert row["expires_at"] > time.time() + 29 * 86400
    own = client.get(f"/api/attempts/{attempt['attempt_id']}/evidence/{saved.json()['evidence_id']}", headers=headers)
    assert own.status_code == 200 and own.headers["cache-control"] == "no-store"
    assert own.content.startswith(b"\xff\xd8\xff")
    export = client.get("/api/me/export", headers=headers)
    assert export.status_code == 200 and len(export.json()["exam_evidence"]) == 2


def test_invalid_jpeg_evidence_limit_and_expiry_are_enforced(proctored):
    _, headers, _ = proctored
    attempt = start(proctored)
    ready(headers, attempt)
    signal(headers, attempt, "ai_audio_level", 5)
    assert upload(headers, attempt, payload=b"\xff\xd8\xffnot-a-jpeg").status_code == 415
    assert upload(headers, attempt, payload=b"\xff\xd8\xff" + b"x" * main.MAX_EVIDENCE_BYTES).status_code == 413
    row = main.one("SELECT state FROM attempts WHERE id=?", (attempt["attempt_id"],))
    state = json.loads(row["state"])
    state["proctoring"]["max_snapshots"] = 1
    main.run("UPDATE attempts SET state=? WHERE id=?", (json.dumps(state), attempt["attempt_id"]))
    saved = upload(headers, attempt)
    assert saved.status_code == 200
    assert upload(headers, attempt, source="screen").status_code == 429
    evidence_id = saved.json()["evidence_id"]
    main.run("UPDATE exam_evidence SET expires_at=? WHERE id=?", (time.time() - 1, evidence_id))
    assert client.get(f"/api/attempts/{attempt['attempt_id']}/evidence/{evidence_id}", headers=headers).status_code == 404


def test_other_candidates_cannot_access_evidence_and_account_deletion_removes_it(proctored):
    uid, headers, _ = proctored
    attempt = start(proctored)
    ready(headers, attempt)
    signal(headers, attempt, "ai_audio_level", 5)
    saved = upload(headers, attempt).json()
    registered = client.post("/api/auth/register", json={"email": uuid.uuid4().hex + "@example.test", "name": "Other Candidate", "password": "Str0ng-Passw0rd-2026"})
    other = {"Authorization": "Bearer " + registered.json()["token"]}
    assert client.get(f"/api/attempts/{attempt['attempt_id']}/evidence/{saved['evidence_id']}", headers=other).status_code == 404
    assert client.delete("/api/me", headers=headers).status_code == 200
    assert main.one("SELECT COUNT(*) AS n FROM exam_evidence WHERE attempt_id=?", (attempt["attempt_id"],))["n"] == 0
