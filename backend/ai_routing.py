"""Provider routing and a small cost guard for AI calls.

Additive. It does not change ``ai_providers`` defaults or behaviour; it only
provides (a) a per-task provider order and (b) an estimated spend ledger so a
small budget (for example $2) is not silently overrun.

- Simple tasks keep the configured order (``AI_PROVIDER`` then fallbacks).
- Complex tasks try ``AI_COMPLEX_PROVIDER`` first (DeepSeek by default).
- Every recorded call adds an estimated cost to ``ai_usage_ledger``.
"""
import json
import os
import secrets
import time

from ai_providers import PROVIDERS, _provider_order

# Rough per-1M-token estimates; override with AI_PRICE_<PROVIDER>_* env vars.
DEFAULT_PRICES = {
    "deepseek": {"input": 0.27, "output": 1.10},
    "groq": {"input": 0.15, "output": 0.60},
    "gemini": {"input": 0.30, "output": 2.50},
    "openai": {"input": 0.15, "output": 0.60},
    "grok": {"input": 0.30, "output": 0.50},
}

_schema_ready = False


def _main():
    import main

    return main


def ensure_schema() -> None:
    global _schema_ready
    if _schema_ready:
        return
    _main().run(
        """CREATE TABLE IF NOT EXISTS ai_usage_ledger (
            id TEXT PRIMARY KEY,
            provider TEXT NOT NULL,
            model TEXT NOT NULL,
            tokens_in INTEGER NOT NULL DEFAULT 0,
            tokens_out INTEGER NOT NULL DEFAULT 0,
            est_cost_usd REAL NOT NULL DEFAULT 0,
            purpose TEXT NOT NULL DEFAULT '',
            created_at REAL NOT NULL
        )"""
    )
    _main().run(
        "CREATE INDEX IF NOT EXISTS idx_ai_usage_created ON ai_usage_ledger(created_at)"
    )
    _schema_ready = True


# --------------------------------------------------------------------------- pricing
def _price(provider: str) -> tuple:
    defaults = DEFAULT_PRICES.get(provider, {"input": 0.5, "output": 1.5})
    prefix = "AI_PRICE_" + provider.upper()
    try:
        price_in = float(os.getenv(prefix + "_INPUT_PER_1M", defaults["input"]))
        price_out = float(os.getenv(prefix + "_OUTPUT_PER_1M", defaults["output"]))
    except (TypeError, ValueError):
        price_in, price_out = defaults["input"], defaults["output"]
    return price_in, price_out


def estimate_cost(provider: str, tokens_in: int, tokens_out: int) -> float:
    price_in, price_out = _price(provider)
    cost = (max(0, tokens_in) / 1_000_000) * price_in + (max(0, tokens_out) / 1_000_000) * price_out
    return round(cost, 6)


# --------------------------------------------------------------------------- routing
def complex_provider() -> str:
    return os.getenv("AI_COMPLEX_PROVIDER", "deepseek").strip().lower()


def order_for(complexity: str = "simple") -> list:
    """Return the provider order for a task. Complex tasks prefer DeepSeek."""
    base = _provider_order()
    if str(complexity).lower() != "complex":
        return base
    preferred = complex_provider()
    if preferred not in PROVIDERS:
        return base
    if preferred in base:
        return [preferred] + [provider for provider in base if provider != preferred]
    return [preferred] + base


# --------------------------------------------------------------------------- budget
def budget_limit() -> float:
    try:
        return float(os.getenv("AI_MONTHLY_BUDGET_USD", "2"))
    except (TypeError, ValueError):
        return 2.0


def budget_window_days() -> int:
    try:
        return max(1, int(os.getenv("AI_BUDGET_WINDOW_DAYS", "60")))
    except (TypeError, ValueError):
        return 60


def record_usage(provider: str, model: str, tokens_in: int, tokens_out: int, purpose: str = "") -> dict:
    ensure_schema()
    entry = {
        "id": "aiu-" + secrets.token_hex(8),
        "provider": provider,
        "model": model,
        "tokens_in": int(tokens_in),
        "tokens_out": int(tokens_out),
        "est_cost_usd": estimate_cost(provider, tokens_in, tokens_out),
        "purpose": str(purpose)[:80],
        "created_at": time.time(),
    }
    try:
        _main().run(
            """INSERT INTO ai_usage_ledger(
                id,provider,model,tokens_in,tokens_out,est_cost_usd,purpose,created_at)
            VALUES (?,?,?,?,?,?,?,?)""",
            (
                entry["id"], entry["provider"], entry["model"], entry["tokens_in"],
                entry["tokens_out"], entry["est_cost_usd"], entry["purpose"], entry["created_at"],
            ),
        )
    except Exception:
        # Usage accounting must never break an AI response.
        pass
    return entry


def budget_status() -> dict:
    try:
        ensure_schema()
        since = time.time() - budget_window_days() * 86400
        rows = _main().allr(
            "SELECT provider, SUM(est_cost_usd) AS cost, SUM(tokens_in) AS tin, "
            "SUM(tokens_out) AS tout FROM ai_usage_ledger WHERE created_at>=? GROUP BY provider",
            (since,),
        )
        providers = []
        spent = 0.0
        for row in rows:
            cost = float(row["cost"] or 0)
            spent += cost
            providers.append(
                {
                    "provider": row["provider"],
                    "est_cost_usd": round(cost, 6),
                    "tokens_in": int(row["tin"] or 0),
                    "tokens_out": int(row["tout"] or 0),
                }
            )
        limit = budget_limit()
        return {
            "limit_usd": limit,
            "spent_usd": round(spent, 6),
            "remaining_usd": round(max(0.0, limit - spent), 6),
            "window_days": budget_window_days(),
            "exhausted": spent >= limit,
            "providers": sorted(providers, key=lambda item: item["est_cost_usd"], reverse=True),
            "estimate": True,
        }
    except Exception:
        return {
            "limit_usd": budget_limit(),
            "spent_usd": 0.0,
            "remaining_usd": budget_limit(),
            "window_days": budget_window_days(),
            "exhausted": False,
            "providers": [],
            "estimate": True,
        }


def can_spend(estimated_cost: float) -> bool:
    status = budget_status()
    return (status["spent_usd"] + max(0.0, float(estimated_cost))) <= status["limit_usd"]
