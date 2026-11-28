"""Voice AI interview: state, deadline, authorization, review gate and fallbacks.

The LLM is always stubbed: these tests prove the server logic, not a provider.
They run on the same throwaway SQLite database as the other test_ent_* modules.
"""
import json
import time

import pytest

from test_ent_helpers import (application, client, company, headers, job, main, member,
                              user)
import ai_interview

PLAN = [
    {"topic": "Motivation", "question": "What interests you about this role?"},
    {"topic": "Recent work", "question": "Tell me about your most recent project."},
    {"topic": "Teamwork", "question": "How do you work with other people?"},
    {"topic": "Problem solving", "question": "Walk me through a difficult problem you solved."},
    {"topic": "Learning", "question": "What did you learn recently?"},
]


def _company_setup(verified=True):
    owner = user("company")
    cid = company(owner, verified=verified)
    candidate = user()
    jid = job(cid)
    aid = application(jid, candidate)
    return owner, cid, candidate, jid, aid


def _shortlist(owner, aid):
    response = client.post(f"/api/company/applications/{aid}/shortlist",
                           headers=headers(owner), json={})
    assert response.status_code == 200, response.text


def _create_invite(owner, aid, **overrides):
    _shortlist(owner, aid)
    body = {"method": "ai", **overrides}
    response = client.post(f"/api/company/applications/{aid}/interview",
                           headers=headers(owner), json=body)
    return response


def _start(candidate, invite_id):
    return client.post(f"/api/interviews/{invite_id}/start", headers=headers(candidate))


def _consent(candidate, invite_id):
    return client.post(f"/api/interviews/{invite_id}/consent",
                       headers=headers(candidate), json={})


def _answer(candidate, invite_id, turn_id, transcript="I built the data pipeline myself."):
    return client.post(
        f"/api/interviews/{invite_id}/answer",
        headers=headers(candidate),
        data={"turn_id": turn_id, "browser_transcript": transcript,
              "audio_ms": "4000", "speech_detected": "true"},
    )


def _fake_llm(plan_topics=None, decision=None, invalid=False, fail=False):
    topics = plan_topics if plan_topics is not None else PLAN

    def fake(system, payload, **kwargs):
        if fail:
            raise ai_interview.AgentLLMUnavailable("stubbed outage")
        if system == ai_interview.PLAN_SYSTEM:
            return {"topics": topics}
        if invalid:
            return {"action": "follow_up"}  # missing a question: invalid twice
        chosen = decision or "next_topic"
        return {"action": chosen,
                "question": "What did you personally do there?" if chosen == "follow_up" else "",
                "focus": "detail"}

    return fake


def _walk_keys(value, out):
    if isinstance(value, dict):
        for key, item in value.items():
            out.add(str(key).lower())
            _walk_keys(item, out)
    elif isinstance(value, list):
        for item in value:
            _walk_keys(item, out)
    return out


# --------------------------------------------------------------------------- deadline


def test_deadline_days_are_capped_at_three():
    owner, _cid, _candidate, _jid, aid = _company_setup()
    too_long = _create_invite(owner, aid, deadline_days=4)
    assert too_long.status_code == 422
    ok = _create_invite(owner, aid, deadline_days=3)
    assert ok.status_code == 200, ok.text
    body = ok.json()
    assert body["deadline_days"] == 3
    remaining = body["deadline_at"] - time.time()
    assert 3 * 86400 - 60 <= remaining <= 3 * 86400 + 60
    assert body["max_questions"] == 10 and body["language"] == "en-US"


def test_question_budget_bounds_are_enforced():
    owner, _cid, _candidate, _jid, aid = _company_setup()
    assert _create_invite(owner, aid, max_questions=5).status_code == 422
    assert _create_invite(owner, aid, max_questions=16).status_code == 422
    assert _create_invite(owner, aid, language="fr-FR").status_code == 422


def test_expired_invite_is_marked_and_start_is_rejected(monkeypatch):
    owner, _cid, candidate, _jid, aid = _company_setup()
    invite_id = _create_invite(owner, aid).json()["invite_id"]
    main.run("UPDATE ai_interview_invites SET deadline_at=? WHERE id=?", (time.time() - 5, invite_id))
    listed = client.get("/api/interviews", headers=headers(candidate)).json()["items"]
    assert [item["status"] for item in listed if item["invite_id"] == invite_id] == ["expired"]
    assert _start(candidate, invite_id).status_code == 410


# --------------------------------------------------------------------------- authorization


def test_authorization_matrix(monkeypatch):
    monkeypatch.setattr(ai_interview, "_llm_json", _fake_llm())
    owner, _cid, candidate, _jid, aid = _company_setup()
    other_owner, _c2, other_candidate, _j2, _a2 = _company_setup()
    invite_id = _create_invite(owner, aid).json()["invite_id"]

    # Candidate cannot act as a company and vice versa.
    assert client.post(f"/api/company/applications/{aid}/shortlist",
                       headers=headers(candidate), json={}).status_code == 403
    assert client.post(f"/api/company/applications/{aid}/interview",
                       headers=headers(other_owner), json={"method": "ai"}).status_code == 404
    assert _start(other_candidate, invite_id).status_code == 404
    assert client.get("/api/company/applications", headers=headers(candidate)).status_code == 403

    # Admin routes need an admin with an explicit staff scope.
    assert client.get("/api/admin/interviews", headers=headers(owner)).status_code == 403
    plain_admin = user("admin")
    assert client.get("/api/admin/interviews", headers=headers(plain_admin)).status_code == 403

    # Consent is per candidate and required before any question is served.
    assert _consent(other_candidate, invite_id).status_code == 404
    assert _start(candidate, invite_id).status_code == 403
    assert _consent(candidate, invite_id).status_code == 200
    assert _start(candidate, invite_id).status_code == 200


def test_unverified_company_cannot_use_the_pipeline():
    owner = user("company")
    cid = company(owner, verified=False)
    candidate = user()
    jid = job(cid)
    aid = application(jid, candidate)
    response = client.post(f"/api/company/applications/{aid}/shortlist",
                           headers=headers(owner), json={})
    assert response.status_code == 403


# --------------------------------------------------------------------------- happy path


def test_full_flow_review_gate_and_human_marks(monkeypatch):
    monkeypatch.setattr(ai_interview, "_llm_json", _fake_llm(decision="next_topic"))
    owner, _cid, candidate, _jid, aid = _company_setup()
    invite_id = _create_invite(owner, aid).json()["invite_id"]
    assert _consent(candidate, invite_id).json()["audio_mode"] == "transcript_only"

    started = _start(candidate, invite_id).json()
    assert started["finished"] is False
    assert started["question"]["text"] == PLAN[0]["question"]

    finished = False
    for _ in range(12):
        question = started["question"]
        answered = _answer(candidate, invite_id, question["turn_id"])
        assert answered.status_code == 200, answered.text
        payload = answered.json()
        if payload["finished"]:
            finished = True
            break
        started = {"question": payload["question"]}
    assert finished, "the interview should finish within the question budget"

    # Company results are blocked before a human decision.
    blocked = client.get(f"/api/company/applications/{aid}/interview/result",
                         headers=headers(owner))
    assert blocked.status_code == 403
    assert blocked.json()["detail"] == "awaiting_admin_review"

    detail = client.get(f"/api/company/applications/{aid}", headers=headers(owner)).json()
    assert detail["interview"]["invite"]["review_pending"] is True
    assert "turns" not in detail["interview"]

    admin = user("admin", staff_role="trust_safety_reviewer")
    queue = client.get("/api/admin/interviews?status=submitted", headers=headers(admin))
    assert queue.status_code == 200, queue.text
    assert any(row["invite_id"] == invite_id for row in queue.json()["items"])

    admin_detail = client.get(f"/api/admin/interviews/{invite_id}", headers=headers(admin)).json()
    assert len(admin_detail["turns"]) == 5
    first_turn = admin_detail["turns"][0]
    assert first_turn["source"] == "opening"
    assert first_turn["transcript"]

    edited = client.patch(
        f"/api/admin/interviews/{invite_id}/turns/{first_turn['turn_id']}",
        headers=headers(admin),
        json={"transcript": "Corrected transcript.", "mark": 4, "note": "Clear ownership."},
    )
    assert edited.status_code == 200, edited.text
    after_edit = client.get(f"/api/admin/interviews/{invite_id}", headers=headers(admin)).json()
    edited_turn = after_edit["turns"][0]
    assert edited_turn["transcript"] == "Corrected transcript."
    assert edited_turn["original_transcript"] == first_turn["transcript"]
    assert edited_turn["transcript_source"] == "edited"
    assert edited_turn["mark"] == 4

    decided = client.post(f"/api/admin/interviews/{invite_id}/decision",
                          headers=headers(admin), json={"decision": "approve"})
    assert decided.status_code == 200, decided.text

    result = client.get(f"/api/company/applications/{aid}/interview/result",
                        headers=headers(owner))
    assert result.status_code == 200, result.text
    body = result.json()
    assert len(body["turns"]) == 5
    assert body["turns"][0]["admin_mark"] == 4
    assert body["turns"][0]["admin_note"] == "Clear ownership."
    assert body["audio_mode"] == "transcript_only"

    # No automatic score exists anywhere in the result payload.
    keys = _walk_keys(body, set())
    assert not [key for key in keys if "score" in key]

    # Another company cannot read this result.
    other_owner, *_rest = _company_setup()
    assert client.get(f"/api/company/applications/{aid}/interview/result",
                      headers=headers(other_owner)).status_code == 404


def test_duplicate_answer_for_the_same_turn_is_rejected(monkeypatch):
    monkeypatch.setattr(ai_interview, "_llm_json", _fake_llm(decision="next_topic"))
    owner, _cid, candidate, _jid, aid = _company_setup()
    invite_id = _create_invite(owner, aid).json()["invite_id"]
    _consent(candidate, invite_id)
    question = _start(candidate, invite_id).json()["question"]
    assert _answer(candidate, invite_id, question["turn_id"]).status_code == 200
    replay = _answer(candidate, invite_id, question["turn_id"])
    assert replay.status_code == 409


# --------------------------------------------------------------------------- must ask


def test_must_ask_questions_are_inserted_deterministically(monkeypatch):
    monkeypatch.setattr(ai_interview, "_llm_json", _fake_llm(decision="next_topic"))
    owner, _cid, candidate, _jid, aid = _company_setup()
    created = _create_invite(
        owner, aid, topics_count=3, max_questions=8,
        custom_questions=[
            {"text": "Why this company specifically?", "must_ask": True},
            {"text": "What salary range do you expect?", "must_ask": True},
            {"text": "Do you have any questions for us?", "must_ask": False},
        ],
    )
    assert created.status_code == 200, created.text
    invite_id = created.json()["invite_id"]
    _consent(candidate, invite_id)

    asked = []
    payload = _start(candidate, invite_id).json()
    asked.append(payload["question"]["text"])
    for _ in range(10):
        answered = _answer(candidate, invite_id, payload["question"]["turn_id"]).json()
        if answered["finished"]:
            break
        asked.append(answered["question"]["text"])
        payload = {"question": answered["question"]}

    must_one = "Why this company specifically?"
    must_two = "What salary range do you expect?"
    assert asked.count(must_one) == 1
    assert asked.count(must_two) == 1
    assert asked.index(must_one) < asked.index(must_two)
    assert asked.index(must_one) > 0  # not before the first opening question
    assert "Do you have any questions for us?" in asked  # optional asked when budget allows


# --------------------------------------------------------------------------- fallbacks


def test_llm_outage_falls_back_to_planned_questions(monkeypatch):
    monkeypatch.setattr(ai_interview, "_llm_json", _fake_llm(fail=True))
    owner, _cid, candidate, _jid, aid = _company_setup()
    invite_id = _create_invite(owner, aid).json()["invite_id"]
    _consent(candidate, invite_id)
    payload = _start(candidate, invite_id).json()
    assert payload["finished"] is False
    assert payload["question"]["text"]  # static fallback plan produced a question

    for _ in range(10):
        answered = _answer(candidate, invite_id, payload["question"]["turn_id"])
        assert answered.status_code == 200, answered.text
        body = answered.json()
        if body["finished"]:
            break
        assert body["question"]["text"]
        payload = {"question": body["question"]}
    else:
        pytest.fail("the interview never finished during an LLM outage")


def test_invalid_json_is_retried_once_then_falls_back(monkeypatch):
    calls = {"decide": 0}

    def fake(system, payload, **kwargs):
        if system == ai_interview.PLAN_SYSTEM:
            return {"topics": PLAN}
        calls["decide"] += 1
        return {"action": "follow_up"}  # invalid: no question

    monkeypatch.setattr(ai_interview, "_llm_json", fake)
    owner, _cid, candidate, _jid, aid = _company_setup()
    invite_id = _create_invite(owner, aid, topics_count=2, max_questions=6).json()["invite_id"]
    _consent(candidate, invite_id)
    payload = _start(candidate, invite_id).json()
    body = _answer(candidate, invite_id, payload["question"]["turn_id"]).json()
    # Two attempts for this answer, then the next planned opening question.
    assert calls["decide"] == 2
    assert body["finished"] is False
    assert body["question"]["kind"] == "opening"
    assert body["question"]["text"] == PLAN[1]["question"]


def test_bad_audio_type_is_rejected(monkeypatch):
    monkeypatch.setattr(ai_interview, "_llm_json", _fake_llm(decision="next_topic"))
    owner, _cid, candidate, _jid, aid = _company_setup()
    invite_id = _create_invite(owner, aid).json()["invite_id"]
    _consent(candidate, invite_id)
    question = _start(candidate, invite_id).json()["question"]
    response = client.post(
        f"/api/interviews/{invite_id}/answer",
        headers=headers(candidate),
        data={"turn_id": question["turn_id"], "browser_transcript": "hello"},
        files={"audio": ("answer.txt", b"not audio", "text/plain")},
    )
    assert response.status_code == 415


# --------------------------------------------------------------------------- redo / schema


def _finish_interview(candidate, invite_id, monkeypatch, decision="next_topic"):
    monkeypatch.setattr(ai_interview, "_llm_json", _fake_llm(decision=decision))
    payload = _start(candidate, invite_id).json()
    for _ in range(12):
        body = _answer(candidate, invite_id, payload["question"]["turn_id"]).json()
        if body["finished"]:
            return
        payload = {"question": body["question"]}
    raise AssertionError("interview did not finish")


def test_redo_is_allowed_only_once(monkeypatch):
    owner, _cid, candidate, _jid, aid = _company_setup()
    invite_id = _create_invite(owner, aid, topics_count=2, max_questions=6).json()["invite_id"]
    _consent(candidate, invite_id)
    _finish_interview(candidate, invite_id, monkeypatch)
    admin = user("admin", staff_role="trust_safety_reviewer")

    first = client.post(f"/api/admin/interviews/{invite_id}/decision",
                        headers=headers(admin),
                        json={"decision": "redo", "note": "Microphone quality was poor."})
    assert first.status_code == 200, first.text
    new_id = first.json()["new_invite_id"]
    assert new_id and new_id != invite_id
    assert main.one("SELECT redo_of FROM ai_interview_invites WHERE id=?", (new_id,))["redo_of"] == invite_id

    _consent(candidate, new_id)
    _finish_interview(candidate, new_id, monkeypatch)
    second = client.post(f"/api/admin/interviews/{new_id}/decision",
                         headers=headers(admin),
                         json={"decision": "redo", "note": "Try once more."})
    assert second.status_code == 409


def test_audio_signature_must_match_the_declared_type(monkeypatch):
    monkeypatch.setattr(ai_interview, "_llm_json", _fake_llm(decision="next_topic"))
    owner, _cid, candidate, _jid, aid = _company_setup()
    invite_id = _create_invite(owner, aid).json()["invite_id"]
    _consent(candidate, invite_id)
    question = _start(candidate, invite_id).json()["question"]
    response = client.post(
        f"/api/interviews/{invite_id}/answer",
        headers=headers(candidate),
        data={"turn_id": question["turn_id"], "browser_transcript": "hello"},
        files={"audio": ("answer.webm", b"not really a webm file", "audio/webm")},
    )
    assert response.status_code == 415


def test_retention_deletes_transcripts_audio_keys_and_review_notes(monkeypatch):
    monkeypatch.setattr(ai_interview, "_llm_json", _fake_llm(decision="next_topic"))
    owner, _cid, candidate, _jid, aid = _company_setup()
    invite_id = _create_invite(owner, aid, topics_count=1, max_questions=6).json()["invite_id"]
    _consent(candidate, invite_id)
    question = _start(candidate, invite_id).json()["question"]
    _answer(candidate, invite_id, question["turn_id"])

    session = main.one("SELECT id FROM ai_interview_sessions WHERE invite_id=?", (invite_id,))
    turn = main.one("SELECT id FROM ai_interview_turns WHERE session_id=?", (session["id"],))
    main.run("INSERT INTO ai_interview_turn_marks(turn_id,reviewer_id,mark,note,updated_at) "
             "VALUES (?,?,?,?,?)", (turn["id"], 1, 4, "personal note", time.time()))
    main.run("UPDATE ai_interview_sessions SET submitted_at=? WHERE id=?",
             (time.time() - 91 * 86400, session["id"]))
    main.run("UPDATE ai_interview_invites SET status='approved' WHERE id=?", (invite_id,))

    result = ai_interview.purge_expired(now=time.time())
    assert result["sessions"] >= 1
    assert not main.one("SELECT id FROM ai_interview_sessions WHERE id=?", (session["id"],))
    assert not main.one("SELECT id FROM ai_interview_turns WHERE id=?", (turn["id"],))
    assert not main.one("SELECT turn_id FROM ai_interview_turn_marks WHERE turn_id=?", (turn["id"],))
    # The invite and its status remain as non-content history.
    assert main.one("SELECT id FROM ai_interview_invites WHERE id=?", (invite_id,))


def test_candidate_export_reaches_interviews_and_account_delete_purges_them(monkeypatch):
    monkeypatch.setattr(ai_interview, "_llm_json", _fake_llm(decision="next_topic"))
    owner, _cid, candidate, _jid, aid = _company_setup()
    invite_id = _create_invite(owner, aid, topics_count=1, max_questions=6).json()["invite_id"]
    _consent(candidate, invite_id)
    question = _start(candidate, invite_id).json()["question"]
    _answer(candidate, invite_id, question["turn_id"])

    exported = client.get("/api/me/export", headers=headers(candidate))
    assert exported.status_code == 200, exported.text
    rows = exported.json()["ai_interviews"]
    assert any(row["invite"]["id"] == invite_id for row in rows)
    assert rows[0]["turns"][0]["answer_transcript"]

    purged = ai_interview.purge_for_candidate(candidate)
    assert purged["invites"] >= 1
    assert not main.one("SELECT id FROM ai_interview_invites WHERE id=?", (invite_id,))
    assert client.get("/api/me/export", headers=headers(candidate)).json()["ai_interviews"] == []


def test_groq_llm_model_alias_is_honoured(monkeypatch):
    import ai_providers
    monkeypatch.setenv("GROQ_LLM_MODEL", "openai/gpt-oss-20b")
    assert ai_providers.get_provider_model("groq") == "openai/gpt-oss-20b"


# --------------------------------------------------------------------------- schema


def test_zoom_method_uses_the_provider_seam_and_reaches_the_candidate():
    owner, _cid, candidate, _jid, aid = _company_setup()
    _shortlist(owner, aid)
    bad = client.post(f"/api/company/applications/{aid}/interview", headers=headers(owner),
                      json={"method": "zoom", "meeting_url": "not a link",
                            "scheduled_at": "2026-12-01T10:00:00Z"})
    assert bad.status_code == 422
    good = client.post(f"/api/company/applications/{aid}/interview", headers=headers(owner),
                       json={"method": "zoom", "meeting_url": "https://zoom.us/j/123456",
                             "scheduled_at": "2026-12-01T10:00:00Z", "note": "Bring your CV."})
    assert good.status_code == 200, good.text
    assert good.json()["provider"]["provider"] == "stub"
    mine = client.get("/api/applications/mine", headers=headers(candidate)).json()["items"]
    row = next(item for item in mine if item["application_id"] == aid)
    assert row["interview_method"] == "zoom"
    assert row["zoom"]["meeting_url"] == "https://zoom.us/j/123456"


def test_schema_uses_portable_sql_and_python_ids():
    for statement in ai_interview.SCHEMA:
        upper = statement.upper()
        assert "AUTOINCREMENT" not in upper
        assert "SERIAL" not in upper
        assert "RETURNING" not in upper
    assert "id TEXT PRIMARY KEY" in ai_interview.SCHEMA[0]
    assert ai_interview._invite_or_404  # module-level helpers use the ? placeholder layer

# --------------------------------------------------------------------------- proctoring

import io

from PIL import Image

import interview_integrity as integrity


def _jpeg(width=800, height=600, with_exif=False):
    image = Image.new("RGB", (width, height), (120, 150, 170))
    buffer = io.BytesIO()
    kwargs = {"format": "JPEG", "quality": 85}
    if with_exif:
        exif = Image.Exif()
        exif[0x010F] = "SkillBridgeTest"  # Make
        kwargs["exif"] = exif
    image.save(buffer, **kwargs)
    return buffer.getvalue()


def _precheck(candidate, invite_id, *, baseline=None, camera_unavailable=False,
              calibration=None):
    data = {
        "consent_version": integrity.PROCTOR_CONSENT_VERSION,
        "calibration": json.dumps(calibration or {
            "yaw": 0.2, "pitch": -0.1, "gaze_x": 0.01, "gaze_y": -0.02,
        }),
        "camera_analysis_unavailable": "true" if camera_unavailable else "false",
    }
    files = {"baseline": ("baseline.jpg", baseline, "image/jpeg")} if baseline else {}
    return client.post(f"/api/interviews/{invite_id}/precheck", headers=headers(candidate),
                       data=data, files=files)


def _proctor_event(candidate, invite_id, event_type, duration_ms=None, **detail):
    payload = {
        "type": event_type, "turn_no": 1, "client_ts": time.time(),
        "duration_ms": duration_ms, "detail": detail,
    }
    return client.post(f"/api/interviews/{invite_id}/proctor/events",
                       headers=headers(candidate), data={"event": json.dumps(payload)})


def _proctor_ready(monkeypatch, *, level="standard", baseline=True,
                   camera_unavailable=False, topics=1):
    monkeypatch.setattr(ai_interview, "_llm_json", _fake_llm(decision="next_topic"))
    owner, _cid, candidate, _jid, aid = _company_setup()
    created = _create_invite(owner, aid, topics_count=topics, max_questions=6,
                             proctoring_level=level)
    assert created.status_code == 200, created.text
    invite_id = created.json()["invite_id"]
    assert _consent(candidate, invite_id).status_code == 200
    pre = _precheck(candidate, invite_id,
                    baseline=_jpeg() if baseline else None,
                    camera_unavailable=camera_unavailable)
    assert pre.status_code == 200, pre.text
    started = _start(candidate, invite_id)
    assert started.status_code == 200, started.text
    return owner, candidate, invite_id, started.json()["question"], aid


def test_proctor_thresholds_and_severity_are_recomputed_server_side():
    assert integrity.evaluate_event("face_absent", 3999) is None
    assert integrity.evaluate_event("face_absent", 4000)["severity"] == "medium"
    assert integrity.evaluate_event("face_absent", 12000)["severity"] == "high"
    assert integrity.evaluate_event("multiple_faces", 1999) is None
    assert integrity.evaluate_event("multiple_faces", 2000)["severity"] == "high"
    assert integrity.evaluate_event("head_turned", 4999) is None
    assert integrity.evaluate_event("head_turned", 5000)["severity"] == "medium"
    assert integrity.evaluate_event("gaze_away", 4999) is None
    assert integrity.evaluate_event("gaze_away", 5000)["severity"] == "low"
    assert integrity.evaluate_event("gaze_away", 1000, {"cumulative_ms": 12000})["severity"] == "low"
    assert integrity.evaluate_event("gaze_pattern", 9999) is None  # server-owned
    assert integrity.evaluate_event("not_a_real_event", 9999) is None
    assert integrity.evaluate_event("camera_analysis_unavailable")["severity"] == "info"


def test_proctor_event_api_recomputes_severity_and_dedupes(monkeypatch):
    _owner, candidate, invite_id, _q, _aid = _proctor_ready(monkeypatch, level="light")
    first = _proctor_event(candidate, invite_id, "face_absent", 5000)
    assert first.status_code == 200, first.text
    assert first.json()["severity"] == "medium"  # client claimed nothing; server derived it
    second = _proctor_event(candidate, invite_id, "face_absent", 12000)
    assert second.json().get("deduped") is True
    # A different type is outside the per-type cooldown.
    other = _proctor_event(candidate, invite_id, "multiple_faces", 2500)
    assert other.json()["severity"] == "high"


def test_proctor_cooldown_and_event_cap(monkeypatch):
    _owner, candidate, invite_id, _q, _aid = _proctor_ready(monkeypatch, level="light")
    monkeypatch.setitem(integrity.PROCTOR_RULES, "event_cooldown_seconds", 0)
    monkeypatch.setitem(integrity.PROCTOR_RULES, "max_events_per_session", 1)
    first = _proctor_event(candidate, invite_id, "tab_hidden", 0)
    assert first.status_code == 200 and not first.json().get("capped")
    second = _proctor_event(candidate, invite_id, "window_blur", 0)
    assert second.json().get("capped") is True


def test_gaze_pattern_escalates_from_three_sustained_episodes(monkeypatch):
    _owner, candidate, invite_id, _q, _aid = _proctor_ready(monkeypatch, level="light")
    monkeypatch.setitem(integrity.PROCTOR_RULES, "event_cooldown_seconds", 0)
    responses = [_proctor_event(candidate, invite_id, "gaze_away", 5000) for _ in range(3)]
    assert responses[0].json()["severity"] == "low"
    assert responses[2].json()["gaze_pattern_event_id"]
    mine = client.get(f"/api/interviews/{invite_id}/proctor/mine",
                      headers=headers(candidate)).json()
    kinds = [event["type"] for event in mine["events"]]
    assert kinds.count("gaze_away") == 3
    assert kinds.count("gaze_pattern") == 1
    # A single glance below the threshold is dropped, never a flag.
    dropped = _proctor_event(candidate, invite_id, "gaze_away", 1200)
    assert dropped.json().get("dropped") is True


def test_trust_label_raw_vs_after_review():
    events = [
        {"type": "gaze_away", "severity": "low", "review_status": "dismissed"},
        {"type": "face_absent", "severity": "medium", "review_status": "unreviewed"},
        {"type": "multiple_faces", "severity": "high", "review_status": "confirmed"},
    ]
    label = integrity.trust_label(events)
    assert label["raw"]["points"] == 7
    assert label["raw"]["label"] == "Medium"
    assert label["after_review"]["points"] == 6
    assert label["after_review"]["confirmed_high"] is True
    assert label["after_review"]["label"] == "Needs review"
    # Dismissed events alone must not create a label.
    low = integrity.trust_label([{"type": "tab_hidden", "severity": "low",
                                  "review_status": "dismissed"}])
    assert low["after_review"]["label"] == "High trust"
    assert low["after_review"]["points"] == 0


def test_proctor_authorization_and_company_cannot_read_evidence(monkeypatch):
    owner, candidate, invite_id, _q, _aid = _proctor_ready(monkeypatch, level="light")
    other_owner, _c, other_candidate, _j, _a = _company_setup()
    assert client.get(f"/api/admin/interviews/{invite_id}/proctor",
                      headers=headers(candidate)).status_code == 403
    assert client.get(f"/api/admin/interviews/{invite_id}/proctor",
                      headers=headers(owner)).status_code == 403
    assert client.get(f"/api/interviews/{invite_id}/proctor/mine",
                      headers=headers(other_candidate)).status_code == 404
    config = client.get(f"/api/interviews/{invite_id}/proctor/config",
                        headers=headers(candidate))
    assert config.status_code == 200
    assert config.json()["rule_version"] == integrity.rule_version()
    # The company result endpoint is locked until approval and never carries events/shots.
    blocked = client.get(f"/api/company/applications/{_aid}/interview/result",
                         headers=headers(owner))
    assert blocked.status_code == 403
    assert "events" not in blocked.text and "shot" not in blocked.text


def test_proctor_upload_validation_and_exif_stripping(monkeypatch):
    monkeypatch.setattr(ai_interview, "_llm_json", _fake_llm(decision="next_topic"))
    owner, _cid, candidate, _jid, aid = _company_setup()
    invite_id = _create_invite(owner, aid, topics_count=1, max_questions=6,
                               proctoring_level="light").json()["invite_id"]
    _consent(candidate, invite_id)
    bad_type = client.post(f"/api/interviews/{invite_id}/precheck",
                           headers=headers(candidate),
                           data={"consent_version": integrity.PROCTOR_CONSENT_VERSION},
                           files={"baseline": ("base.txt", b"not an image", "text/plain")})
    assert bad_type.status_code == 415
    fake = client.post(f"/api/interviews/{invite_id}/precheck", headers=headers(candidate),
                       data={"consent_version": integrity.PROCTOR_CONSENT_VERSION},
                       files={"baseline": ("base.jpg", b"not a jpeg", "image/jpeg")})
    assert fake.status_code == 415
    ok = _precheck(candidate, invite_id, baseline=_jpeg(with_exif=True))
    assert ok.status_code == 200, ok.text
    admin = user("admin", staff_role="trust_safety_reviewer")
    detail = client.get(f"/api/admin/interviews/{invite_id}/proctor",
                        headers=headers(admin)).json()
    assert detail["calibration"]["baseline_mode"] == "database"
    assert detail["calibration"]["baseline_url"].startswith("data:image/jpeg;base64,")
    import base64
    raw = base64.b64decode(detail["calibration"]["baseline_url"].split(",", 1)[1])
    assert raw.startswith(b"\xff\xd8\xff")
    assert b"Exif" not in raw and b"SkillBridgeTest" not in raw


def test_ml_unavailable_still_lets_the_candidate_finish(monkeypatch):
    _owner, candidate, invite_id, question, _aid = _proctor_ready(
        monkeypatch, level="standard", baseline=False, camera_unavailable=True)
    mine = client.get(f"/api/interviews/{invite_id}/proctor/mine",
                      headers=headers(candidate)).json()
    types = [event["type"] for event in mine["events"]]
    assert "camera_analysis_unavailable" in types
    answered = _answer(candidate, invite_id, question["turn_id"])
    assert answered.status_code == 200, answered.text
    assert answered.json()["finished"] is True


def test_high_flags_never_block_answers_or_finish(monkeypatch):
    _owner, candidate, invite_id, question, _aid = _proctor_ready(monkeypatch, level="light")
    flagged = _proctor_event(candidate, invite_id, "multiple_faces", 2500)
    assert flagged.json()["severity"] == "high"
    answered = _answer(candidate, invite_id, question["turn_id"])
    assert answered.status_code == 200, answered.text
    assert answered.json()["finished"] is True


def test_shot_retention_holds_under_review_and_deletes_after_decision(monkeypatch):
    _owner, candidate, invite_id, _q, _aid = _proctor_ready(monkeypatch, level="light")
    session = main.one("SELECT id FROM ai_interview_sessions WHERE invite_id=?", (invite_id,))
    shot = main.one("SELECT id FROM ai_interview_flag_shots WHERE session_id=? AND kind='baseline'",
                    (session["id"],))
    assert shot
    main.run("UPDATE ai_interview_flag_shots SET delete_after=? WHERE id=?",
             (time.time() - 10, shot["id"]))
    main.run("UPDATE ai_interview_invites SET status='in_review' WHERE id=?", (invite_id,))
    held = ai_interview.purge_expired_shots(now=time.time())
    assert held["held"] >= 1
    assert main.one("SELECT id FROM ai_interview_flag_shots WHERE id=?", (shot["id"],))
    main.run("UPDATE ai_interview_invites SET status='approved' WHERE id=?", (invite_id,))
    deleted = ai_interview.purge_expired_shots(now=time.time())
    assert deleted["deleted"] >= 1
    assert not main.one("SELECT id FROM ai_interview_flag_shots WHERE id=?", (shot["id"],))


def test_unresolved_appeal_blocks_approval_without_confirmation(monkeypatch):
    _owner, candidate, invite_id, _q, _aid = _proctor_ready(monkeypatch, level="light")
    flagged = _proctor_event(candidate, invite_id, "tab_hidden", 0).json()
    _finish_interview(candidate, invite_id, monkeypatch)
    appeal = client.post(
        f"/api/interviews/{invite_id}/proctor/events/{flagged['event_id']}/appeal",
        headers=headers(candidate), json={"note": "I looked at my notes for the deadline."})
    assert appeal.status_code == 200, appeal.text
    admin = user("admin", staff_role="trust_safety_reviewer")
    blocked = client.post(f"/api/admin/interviews/{invite_id}/decision",
                          headers=headers(admin),
                          json={"decision": "approve", "note": "Reviewed."})
    assert blocked.status_code == 409
    allowed = client.post(f"/api/admin/interviews/{invite_id}/decision",
                          headers=headers(admin),
                          json={"decision": "approve", "note": "Reviewed with the appeal.",
                                "confirm_appeals": True})
    assert allowed.status_code == 200, allowed.text
    result = client.get(f"/api/company/applications/{_aid}/interview/result",
                        headers=headers(_owner))
    assert result.status_code == 200
    body = result.json()
    assert "events" not in body and "shots" not in body
    assert body["integrity"]["label"] in {"High trust", "Medium", "Needs review"}


def test_proctor_schema_is_portable():
    for statement in ai_interview.SCHEMA:
        upper = statement.upper()
        assert "AUTOINCREMENT" not in upper
        assert "SERIAL" not in upper
        assert "RETURNING" not in upper

def test_accommodation_request_reaches_admin_and_is_applied(monkeypatch):
    monkeypatch.setattr(ai_interview, "_llm_json", _fake_llm(decision="next_topic"))
    owner, _cid, candidate, _jid, aid = _company_setup()
    invite_id = _create_invite(owner, aid, proctoring_level="standard").json()["invite_id"]
    _consent(candidate, invite_id)
    other = user()
    cross = client.post(f"/api/interviews/{invite_id}/proctor/accommodation-request",
                        headers=headers(other),
                        json={"note": "Please disable gaze.", "gaze_enabled": False})
    assert cross.status_code == 404
    requested = client.post(f"/api/interviews/{invite_id}/proctor/accommodation-request",
                            headers=headers(candidate),
                            json={"note": "Please disable gaze analysis and use Zoom.",
                                  "gaze_enabled": False, "prefer_manual": True})
    assert requested.status_code == 200, requested.text
    admin = user("admin", staff_role="trust_safety_reviewer")
    detail = client.get(f"/api/admin/interviews/{invite_id}/proctor",
                        headers=headers(admin)).json()
    assert detail["accommodation_requests"][0]["note"].startswith("Please disable gaze")
    assert detail["accommodation_requests"][0]["status"] == "requested"
    applied = client.post(f"/api/admin/interviews/{invite_id}/proctor/accommodation",
                          headers=headers(admin),
                          json={"gaze_enabled": False, "note": "Granted as an accommodation."})
    assert applied.status_code == 200, applied.text
    assert main.one("SELECT gaze_enabled FROM ai_interview_invites WHERE id=?",
                    (invite_id,))["gaze_enabled"] == 0
    detail = client.get(f"/api/admin/interviews/{invite_id}/proctor",
                        headers=headers(admin)).json()
    assert detail["accommodation_requests"][0]["status"] == "resolved"
    # Company still cannot read the proctor timeline or requests.
    assert client.get(f"/api/admin/interviews/{invite_id}/proctor",
                      headers=headers(owner)).status_code == 403

def test_session_retention_removes_proctor_rows_and_flags_are_exported(monkeypatch):
    import base64
    _owner, candidate, invite_id, _q, _aid = _proctor_ready(monkeypatch, level="light")
    session = main.one("SELECT id FROM ai_interview_sessions WHERE invite_id=?", (invite_id,))
    event = _proctor_event(candidate, invite_id, "tab_hidden", 0).json()
    assert event.get("event_id")
    exported = client.get("/api/me/export", headers=headers(candidate)).json()
    row = next(item for item in exported["ai_interviews"] if item["invite"]["id"] == invite_id)
    assert any(flag["type"] == "tab_hidden" for flag in row["proctor_flags"])

    main.run("UPDATE ai_interview_sessions SET submitted_at=? WHERE id=?",
             (time.time() - 91 * 86400, session["id"]))
    main.run("UPDATE ai_interview_invites SET status='approved' WHERE id=?", (invite_id,))
    ai_interview.purge_expired(now=time.time())
    assert not main.one("SELECT id FROM ai_interview_sessions WHERE id=?", (session["id"],))
    assert not main.one("SELECT id FROM ai_interview_proctor_events WHERE session_id=?",
                        (session["id"],))
    assert not main.one("SELECT id FROM ai_interview_flag_shots WHERE session_id=?",
                        (session["id"],))
    assert not main.one("SELECT session_id FROM ai_interview_calibration WHERE session_id=?",
                        (session["id"],))
