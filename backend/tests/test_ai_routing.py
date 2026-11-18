"""Provider routing and AI spend-guard tests (additive)."""
import os
import sys
import tempfile

_TMP = tempfile.mkdtemp(prefix="sb_ai_routing_")
os.environ.setdefault("DB_PATH", os.path.join(_TMP, "test.db"))
os.environ["SEED_DEMO"] = "false"
os.environ.setdefault("PBKDF2_ITERATIONS", "1000")
os.environ["AI_PROVIDER"] = "groq"
os.environ["AI_PROVIDER_FALLBACKS"] = "deepseek,gemini"
os.environ["AI_COMPLEX_PROVIDER"] = "deepseek"
os.environ["AI_MONTHLY_BUDGET_USD"] = "2"
os.environ["AI_BUDGET_WINDOW_DAYS"] = "60"
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import ai_routing
import main


def test_simple_order_keeps_configured_chain():
    assert ai_routing.order_for("simple") == ["groq", "deepseek", "gemini"]


def test_complex_order_prefers_deepseek():
    order = ai_routing.order_for("complex")
    assert order[0] == "deepseek"
    assert set(order) == {"groq", "deepseek", "gemini"}


def test_estimate_cost_is_positive_and_scales():
    small = ai_routing.estimate_cost("deepseek", 1000, 1000)
    large = ai_routing.estimate_cost("deepseek", 1_000_000, 1_000_000)
    assert small > 0
    assert large > small


def test_ledger_records_and_sums_spend():
    before = ai_routing.budget_status()
    ai_routing.record_usage("deepseek", "deepseek-flash", 1000, 500, purpose="test")
    after = ai_routing.budget_status()
    assert after["spent_usd"] >= before["spent_usd"]
    assert after["window_days"] == 60
    assert after["limit_usd"] == 2.0


def test_budget_blocks_when_spent(monkeypatch):
    monkeypatch.setenv("AI_MONTHLY_BUDGET_USD", "0.000001")
    ai_routing.record_usage("deepseek", "deepseek-flash", 1_000_000, 1_000_000, purpose="test")
    status = ai_routing.budget_status()
    assert status["exhausted"] is True
    assert ai_routing.can_spend(0) is False


def test_complete_json_uses_deepseek_first_for_complex(monkeypatch):
    import agent_llm

    monkeypatch.setenv("DEEPSEEK_API_KEYS", "test-key")
    monkeypatch.setenv("GROQ_API_KEYS", "test-key")
    monkeypatch.setenv("GEMINI_API_KEYS", "")
    monkeypatch.setenv("AI_MONTHLY_BUDGET_USD", "100")
    calls = []

    class FakeResponse:
        def raise_for_status(self):
            return None

        def json(self):
            return {"choices": [{"message": {"content": '{"ok": true}'}}]}

    def fake_post(url, headers=None, json=None, timeout=None):
        calls.append((url, json.get("model")))
        return FakeResponse()

    monkeypatch.setattr(agent_llm.httpx, "post", fake_post)
    result = agent_llm.complete_json("system", {"task": "question"}, max_tokens=20, complexity="complex")
    assert result["provider"] == "deepseek"
    assert calls and "deepseek" in calls[0][0]
    assert result["usage"]["est_cost_usd"] >= 0
