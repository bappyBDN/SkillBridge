"""Learning narration is source-restricted and cannot grade or expose identity."""
import json
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import ai_providers as AIP


def test_learning_narrative_uses_only_retrieved_ids_and_redacts_text(monkeypatch):
    monkeypatch.setattr(AIP, "_provider_order", lambda: ["openai"])
    monkeypatch.setattr(AIP, "get_provider_keys", lambda provider: ["synthetic-test-key"])
    sent = []

    class Response:
        def raise_for_status(self):
            pass

        def json(self):
            return {"choices": [{"message": {"content": json.dumps({"recommendations": [
                {"resource_id": "invented", "reason": "Unapproved course."},
                {"resource_id": "course-1", "reason": "Practice input validation with the exercises in this course."},
                {"resource_id": "course-1", "reason": "Duplicate advice."},
                {"resource_id": "course-2", "reason": "Visit https://invented.example/course"},
            ]})}}]}

    def post(url, **kwargs):
        sent.append(kwargs["json"])
        return Response()

    monkeypatch.setattr(AIP.httpx, "post", post)
    result = AIP.explain_learning_resources({"gaps": [{"topic": "python", "score": 50}], "resources": [
        {"id": "course-1", "title": "Training contact trainer@example.com", "topic": "python"},
        {"id": "course-2", "title": "Reviewed Python course", "topic": "python"},
    ]})
    assert [item["resource_id"] for item in result["recommendations"]] == ["course-1"]
    assert "trainer@example.com" not in json.dumps(sent)
    assert "grade or change scores" in sent[0]["messages"][0]["content"]


def test_learning_model_failure_is_a_safe_optional_failure(monkeypatch):
    monkeypatch.setattr(AIP, "_provider_order", lambda: ["openai"])
    monkeypatch.setattr(AIP, "get_provider_keys", lambda provider: [])
    with pytest.raises(AIP.AIExtractionError, match="reviewed courses remain available"):
        AIP.explain_learning_resources({"resources": []})
