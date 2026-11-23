"""MCP M1 (verification) + M2 (candidate learning) contract tests.

These are additive: they do not change any existing test. They assert the two
security-critical properties from the roadmap:
  * the tool registry exposes the five read-only tools; and
  * no practice-question payload ever contains an answer or reference field.
"""
import os
import sys
import tempfile

_TMP = tempfile.mkdtemp(prefix="sb_mcp_")
os.environ.setdefault("DB_PATH", os.path.join(_TMP, "test.db"))
os.environ["SEED_DEMO"] = "false"
os.environ.setdefault("PBKDF2_ITERATIONS", "1000")
os.environ["MCP_ENABLED"] = "true"
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import asyncio

import mcp_server as S
import mcp_tools as T


def test_tool_registry_exposes_five_tools():
    names = {tool.name for tool in asyncio.run(S.mcp.list_tools())}
    assert {
        "verify_passport",
        "lookup_skill",
        "my_weak_topics",
        "practice_questions",
        "learning_path",
    } <= names


def test_resources_are_registered():
    uris = {str(resource.uri) for resource in asyncio.run(S.mcp.list_resources())}
    assert "skillbridge://taxonomy" in uris
    assert "skillbridge://server" in uris


def test_lookup_skill_matches_taxonomy():
    result = T.lookup_skill("Power BI")
    assert result["matched"] is True
    assert "visualization" in result["skill_ids"]


def test_lookup_skill_unknown_term_is_not_invented():
    result = T.lookup_skill("underwater basket weaving")
    assert result["matched"] is False
    assert result["skill_ids"] == []


def test_verify_passport_missing_and_not_found():
    assert T.verify_passport("")["reason"] == "missing_passport_id"
    assert T.verify_passport("does-not-exist")["reason"] == "not_found"


def test_normalize_passport_id_accepts_share_link():
    assert T._normalize_passport_id("https://host/#/p/abc123?x=1") == "abc123"
    assert T._normalize_passport_id("abc123") == "abc123"


def test_practice_questions_never_leak_answer_fields():
    import enterprise
    import main

    enterprise._seed_question_bank()
    main.run(
        """INSERT INTO question_bank(
               id,category_id,subcategory,question_type,difficulty_level,question_text,
               options,correct_answer,explanation,reference_answer,grading_rubric,marks,
               time_allocation,status,created_by,created_at,version)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT(id) DO NOTHING""",
        (
            "mcp-test-q1", "CAT-10", "Python", "MCQ", "Easy",
            "Which keyword defines a function?", '["A","B"]', "def",
            "def defines a function", "", "", 1, 60, "active", "test", 0, 1,
        ),
    )
    result = T.practice_questions(1, "Python", 5)
    assert result["count"] >= 1
    T.assert_no_answer_fields(result)
    for question in result["questions"]:
        assert "correct_answer" not in question
        assert "reference_answer" not in question
        assert "explanation" not in question


def test_status_endpoint_lists_tools():
    from fastapi.testclient import TestClient

    import main

    client = TestClient(main.app)
    response = client.get("/api/mcp/status")
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["server"] == "skillbridge"
    assert body["read_only"] is True
    names = {tool["name"] for tool in body["tools"]}
    assert {"verify_passport", "lookup_skill", "learning_path"} <= names


def test_learning_endpoint_requires_auth():
    from fastapi.testclient import TestClient

    import main

    client = TestClient(main.app)
    assert client.get("/api/mcp/learning").status_code == 401


def test_mcp_disabled_reads_flag_at_call_time(monkeypatch):
    import mcp_api

    monkeypatch.setenv("MCP_ENABLED", "false")
    assert mcp_api.mcp_enabled() is False
    monkeypatch.setenv("MCP_ENABLED", "true")
    assert mcp_api.mcp_enabled() is True
