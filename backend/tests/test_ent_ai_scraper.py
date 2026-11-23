"""AI spend metering/budget, scraper SSRF hardening and service timeouts."""
import calendar
import datetime
import ipaddress
import os
import threading
import time

import httpx
import pytest

from test_ent_helpers import main  # noqa: F401  (temp DB before ai_routing touches main)

import ai_providers
import ai_routing
import question_scraper as QS


@pytest.fixture
def clean_ledger(monkeypatch):
    ai_routing.ensure_schema()
    main.run("DELETE FROM ai_usage_ledger")
    monkeypatch.delenv("AI_BUDGET_WINDOW_DAYS", raising=False)
    yield


class _Resp:
    def __init__(self, body, status_code=200):
        self._body = body
        self.status_code = status_code
        self.headers = {}

    def json(self):
        return self._body

    def raise_for_status(self):
        if self.status_code >= 400:
            raise httpx.HTTPStatusError("bad", request=None, response=None)


# --------------------------------------------------------------------- item 9
def test_calendar_month_window_by_default(clean_ledger, monkeypatch):
    now = calendar.timegm((2026, 11, 23, 12, 0, 0))
    assert ai_routing.budget_window_start(now) == calendar.timegm((2026, 11, 1, 0, 0, 0))
    assert ai_routing.budget_status()["window"] == "calendar_month"
    monkeypatch.setenv("AI_BUDGET_WINDOW_DAYS", "7")
    assert ai_routing.budget_window_start(now) == now - 7 * 86400
    assert ai_routing.budget_status()["window_days"] == 7


def test_budget_status_fails_closed(clean_ledger, monkeypatch):
    def broken(*args, **kwargs):
        raise RuntimeError("db down")

    monkeypatch.setattr(main, "allr", broken)
    status = ai_routing.budget_status()
    assert status["exhausted"] is True and status["error"] == "budget_unavailable"
    assert ai_routing.can_spend(0) is False


def test_reservation_refuses_overrun_and_is_concurrency_safe(clean_ledger, monkeypatch):
    # Each reservation costs ~0.00011 USD (deepseek, 100 output tokens at 1.10/1M).
    one_call = ai_routing.estimate_cost("deepseek", 0, 100)
    monkeypatch.setenv("AI_MONTHLY_BUDGET_USD", str(one_call * 5 + one_call / 2))
    granted = []

    def worker():
        if ai_routing.reserve("deepseek", "m", 0, 100, "test"):
            granted.append(1)

    threads = [threading.Thread(target=worker) for _ in range(12)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert len(granted) == 5
    assert ai_routing.budget_status()["spent_usd"] <= float(os.environ["AI_MONTHLY_BUDGET_USD"])


def test_metered_post_settles_with_provider_usage_before_parsing(clean_ledger, monkeypatch):
    monkeypatch.setenv("AI_MONTHLY_BUDGET_USD", "100")
    body = {"choices": [{"message": {"content": "not json at all"}}],
            "usage": {"prompt_tokens": 1234, "completion_tokens": 56}}
    monkeypatch.setattr(ai_providers.httpx, "post", lambda *a, **k: _Resp(body))
    response, usage = ai_providers.metered_post("openai", "m", "https://x", headers={}, payload={"a": 1},
                                                timeout=5, purpose="test", max_tokens_out=500)
    assert usage["tokens_in"] == 1234 and usage["tokens_out"] == 56
    row = main.one("SELECT tokens_in,tokens_out,status FROM ai_usage_ledger WHERE purpose='test'")
    assert (row["tokens_in"], row["tokens_out"], row["status"]) == (1234, 56, "settled")
    with pytest.raises(ValueError):  # the caller's parse fails AFTER usage was recorded
        ai_providers.parse_json_response(response.json()["choices"][0]["message"]["content"])


def test_rejected_provider_call_releases_reservation(clean_ledger, monkeypatch):
    monkeypatch.setenv("AI_MONTHLY_BUDGET_USD", "100")
    monkeypatch.setattr(ai_providers.httpx, "post", lambda *a, **k: _Resp({}, status_code=429))
    ai_providers.metered_post("openai", "m", "https://x", headers={}, payload={}, timeout=5,
                              purpose="rejected", max_tokens_out=500)
    row = main.one("SELECT est_cost_usd,status FROM ai_usage_ledger WHERE purpose='rejected'")
    assert row["status"] == "released" and row["est_cost_usd"] == 0


def test_cv_extraction_and_learning_advice_respect_budget(clean_ledger, monkeypatch):
    monkeypatch.setenv("AI_PROVIDER", "openai")
    monkeypatch.setenv("AI_PROVIDER_FALLBACKS", "")
    monkeypatch.setenv("OPENAI_API_KEYS", "test-key")
    monkeypatch.setenv("AI_MONTHLY_BUDGET_USD", "0")
    calls = []
    monkeypatch.setattr(ai_providers.httpx, "post", lambda *a, **k: calls.append(1))
    with pytest.raises(ai_providers.AIExtractionError):  # main.py falls back to the offline parser
        ai_providers.extract_cv_profile("Jane Doe\nPython developer with five years of SQL experience.")
    with pytest.raises(ai_providers.AIExtractionError):
        ai_providers.explain_learning_resources({"gaps": [], "resources": [{"id": "r1"}]})
    assert calls == []


def test_cv_extraction_retries_are_metered(clean_ledger, monkeypatch):
    monkeypatch.setenv("AI_PROVIDER", "openai")
    monkeypatch.setenv("AI_PROVIDER_FALLBACKS", "")
    monkeypatch.setenv("OPENAI_API_KEYS", "test-key")
    monkeypatch.setenv("AI_MONTHLY_BUDGET_USD", "100")
    monkeypatch.setattr(ai_providers.time, "sleep", lambda s: None)
    monkeypatch.setattr(ai_providers.httpx, "post", lambda *a, **k: _Resp({}, status_code=503))
    with pytest.raises(ai_providers.AIExtractionError):
        ai_providers.extract_cv_profile("Jane Doe\nPython developer with five years of SQL experience.")
    rows = main.allr("SELECT status FROM ai_usage_ledger WHERE purpose='cv_extraction'")
    assert len(rows) == 2 and {r["status"] for r in rows} == {"released"}


# --------------------------------------------------------------------- item 8
@pytest.mark.parametrize("addr", ["169.254.169.254", "127.0.0.1", "10.1.2.3", "::1", "fe80::1",
                                  "::ffff:127.0.0.1", "fd00::5", "2002:7f00:1::1", "0.0.0.0"])
def test_blocked_addresses(addr):
    assert QS._ip_blocked(ipaddress.ip_address(addr))


def test_public_address_allowed():
    assert not QS._ip_blocked(ipaddress.ip_address("93.184.216.34"))


def _fake_dns(monkeypatch, mapping):
    def getaddrinfo(host, *args, **kwargs):
        return [(None, None, None, None, (mapping[host], 0))]
    monkeypatch.setattr(QS.socket, "getaddrinfo", getaddrinfo)


_REAL_CLIENT = httpx.Client


def _transport_client(monkeypatch, handler):
    real = _REAL_CLIENT

    def factory(*args, **kwargs):
        assert kwargs.get("follow_redirects") is False
        kwargs["transport"] = httpx.MockTransport(handler)
        return real(*args, **kwargs)

    monkeypatch.setattr(QS.httpx, "Client", factory)


def test_redirect_to_metadata_address_is_blocked(monkeypatch):
    _fake_dns(monkeypatch, {"public.example": "93.184.216.34", "evil.example": "169.254.169.254"})
    seen = []

    def handler(request):
        seen.append(request.url.host)
        if request.url.host == "public.example":
            return httpx.Response(302, headers={"location": "http://evil.example/latest/meta-data"})
        return httpx.Response(200, text="secret")

    _transport_client(monkeypatch, handler)
    with pytest.raises(ValueError, match="private or reserved"):
        QS.scrape_url("http://public.example/quiz")
    assert seen == ["public.example"]


def test_redirect_chain_is_capped_and_body_is_streamed_with_a_cap(monkeypatch):
    _fake_dns(monkeypatch, {"public.example": "93.184.216.34"})
    _transport_client(monkeypatch, lambda request: httpx.Response(302, headers={"location": "/again"}))
    with pytest.raises(ValueError, match="redirected more than"):
        QS.scrape_url("http://public.example/loop")

    def huge(request):
        return httpx.Response(200, content=iter([b"x" * 1_000_000] * 10))

    _transport_client(monkeypatch, huge)
    with pytest.raises(ValueError, match="larger than 5 MB"):
        QS.scrape_url("http://public.example/huge")


def test_followed_public_redirect_returns_records(monkeypatch):
    _fake_dns(monkeypatch, {"a.example": "93.184.216.34", "b.example": "93.184.216.35"})

    def handler(request):
        if request.url.host == "a.example":
            return httpx.Response(301, headers={"location": "https://b.example/page"})
        return httpx.Response(200, text="1. What does SQL stand for?\nA) Structured Query Language\nB) Simple")

    _transport_client(monkeypatch, handler)
    final_url, records = QS.scrape_url("http://a.example/start")
    assert final_url == "https://b.example/page" and records


# --------------------------------------------------------------------- item 17
def test_graph_services_get_short_timeouts(monkeypatch):
    import sys
    import types

    import graphrag as G

    captured = {}
    fake_meili = types.SimpleNamespace(Client=lambda url, key=None, **kw: captured.setdefault("meili", kw))
    monkeypatch.setitem(sys.modules, "meilisearch", fake_meili)
    G._meilisearch_client.cache_clear()
    G._meilisearch_client()
    G._meilisearch_client.cache_clear()
    assert captured["meili"]["timeout"] == 3.0

    class FakeGraphDatabase:
        @staticmethod
        def driver(uri, **kw):
            captured["neo4j"] = kw
            return object()

    monkeypatch.setitem(sys.modules, "neo4j", types.SimpleNamespace(GraphDatabase=FakeGraphDatabase))
    monkeypatch.setenv("NEO4J_TIMEOUT_SECONDS", "2")
    G._neo4j_driver.cache_clear()
    G._neo4j_driver()
    G._neo4j_driver.cache_clear()
    assert captured["neo4j"]["connection_timeout"] == 2.0
