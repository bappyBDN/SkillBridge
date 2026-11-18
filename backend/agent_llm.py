"""Redacted JSON LLM helper for the additive agent features.

Reuses the provider configuration in ``ai_providers.py`` without changing it.
Every payload is PII-redacted before it leaves the process. Complex tasks try
DeepSeek first; simpler tasks keep the configured order. A small spend ledger
(``ai_routing``) prevents a small budget from being overrun. Nothing here grades,
writes or publishes anything.
"""
import json
import time
from urllib.parse import quote

import httpx

import ai_routing
import engine as E
from ai_providers import (
    PROVIDERS,
    _provider_order,
    get_provider_keys,
    get_provider_model,
    parse_json_response,
)


class AgentLLMUnavailable(RuntimeError):
    """No configured provider produced a usable response."""


def _redact(payload):
    text = payload if isinstance(payload, str) else json.dumps(payload, ensure_ascii=False)
    clean, _ = E.redact(text, assume_first_line_name=False)
    return clean


def _tokens(text: str) -> int:
    return max(1, len(text or "") // 4)


def complete_json(
    system: str,
    payload,
    *,
    max_tokens: int = 1500,
    timeout_seconds: int = 25,
    complexity: str = "simple",
) -> dict:
    """Call the provider chain and return parsed JSON.

    Returns ``{"provider", "model", "data", "usage"}``. Raises
    ``AgentLLMUnavailable`` when no provider is configured, every attempt fails,
    or the spend budget is exhausted.
    """
    safe_user = _redact(payload)
    tokens_in = _tokens(system) + _tokens(safe_user)
    deadline = time.monotonic() + max(1, timeout_seconds)
    try:
        order = ai_routing.order_for(complexity)
    except Exception:
        try:
            order = _provider_order()
        except Exception as exc:
            raise AgentLLMUnavailable("AI provider configuration is invalid.") from exc

    budget_skipped = False
    for provider in order:
        for api_key in get_provider_keys(provider)[:1]:
            remaining = deadline - time.monotonic()
            if remaining < 1:
                break
            model = get_provider_model(provider)
            projected = ai_routing.estimate_cost(provider, tokens_in, max_tokens)
            if not ai_routing.can_spend(projected):
                budget_skipped = True
                continue
            try:
                if provider == "gemini":
                    url = (
                        "https://generativelanguage.googleapis.com/v1beta/models/"
                        + quote(model, safe="")
                        + ":generateContent"
                    )
                    headers = {"x-goog-api-key": api_key}
                    body = {
                        "systemInstruction": {"parts": [{"text": system}]},
                        "contents": [{"role": "user", "parts": [{"text": safe_user}]}],
                        "generationConfig": {
                            "responseMimeType": "application/json",
                            "temperature": 0,
                            "maxOutputTokens": max_tokens,
                        },
                    }
                else:
                    url = PROVIDERS[provider]["base_url"].rstrip("/") + "/chat/completions"
                    headers = {"Authorization": "Bearer " + api_key}
                    body = {
                        "model": model,
                        "temperature": 0,
                        "max_tokens": max_tokens,
                        "response_format": {"type": "json_object"},
                        "messages": [
                            {"role": "system", "content": system},
                            {"role": "user", "content": safe_user},
                        ],
                    }
                response = httpx.post(url, headers=headers, json=body, timeout=min(20, remaining))
                response.raise_for_status()
                raw = response.json()
                text = (
                    raw["candidates"][0]["content"]["parts"][0]["text"]
                    if provider == "gemini"
                    else raw["choices"][0]["message"]["content"]
                )
                data = parse_json_response(text)
                tokens_out = _tokens(text)
                recorded = ai_routing.record_usage(
                    provider, model, tokens_in, tokens_out,
                    purpose="agent_" + str(complexity)[:20],
                )
                return {
                    "provider": provider,
                    "model": model,
                    "data": data,
                    "usage": {
                        "tokens_in": tokens_in,
                        "tokens_out": tokens_out,
                        "est_cost_usd": recorded["est_cost_usd"],
                    },
                }
            except Exception:
                # Never log or return provider error bodies or the payload.
                continue
    if budget_skipped:
        raise AgentLLMUnavailable("AI budget exhausted for this window.")
    raise AgentLLMUnavailable("No configured AI provider produced a response.")
