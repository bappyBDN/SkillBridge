"""Provider routing and a small cost guard for AI calls.

Additive. It does not change ``ai_providers`` defaults or behaviour; it only
provides (a) a per-task provider order and (b) an estimated spend ledger so a
small budget (for example $2) is not silently overrun.

- Simple tasks keep the configured order (``AI_PROVIDER`` then fallbacks).
- Complex tasks try ``AI_COMPLEX_PROVIDER`` first (DeepSeek by default).
- Every provider call (CV extraction, learning explanations, agent drafts) goes
  through ``ai_providers.metered_post``: it RESERVES the worst-case cost here
  before the request (atomically, so concurrent calls cannot overrun the
  budget) and SETTLES the row with the provider's reported token usage (or an
  estimate) right after the response, before any JSON parsing.
- Budget window: the current calendar month (UTC) by default. Setting
  ``AI_BUDGET_WINDOW_DAYS`` switches to a rolling window of that many days.
- Fail closed: if the ledger cannot be read, the budget counts as exhausted
  and paid calls are skipped (callers fall back to offline behaviour).
"""
import calendar
import datetime
import json
import logging
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
log = logging.getLogger("skillbridge.ai_routing")
# Constant key for the PostgreSQL transaction-scoped advisory lock that
# serialises budget reservations across processes.
_PG_BUDGET_LOCK_KEY = 7331002


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
    m = _main()
    if m.DATABASE_URL:
        columns = {row["column_name"] for row in m.allr(
            "SELECT column_name FROM information_schema.columns "
            "WHERE table_schema=current_schema() AND table_name='ai_usage_ledger'")}
    else:
        columns = {row["name"] for row in m.allr("PRAGMA table_info(ai_usage_ledger)")}
    if "status" not in columns:
        m.run("ALTER TABLE ai_usage_ledger ADD COLUMN status TEXT NOT NULL DEFAULT 'settled'")
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


def budget_window_days():
    """Rolling-window override in days, or None for the calendar month."""
    raw = os.getenv("AI_BUDGET_WINDOW_DAYS", "").strip()
    if not raw:
        return None
    try:
        return max(1, int(raw))
    except (TypeError, ValueError):
        return None


def budget_window_start(now: float = None) -> float:
    """Unix time where the current budget window starts."""
    now = time.time() if now is None else now
    days = budget_window_days()
    if days:
        return now - days * 86400
    current = datetime.datetime.fromtimestamp(now, tz=datetime.timezone.utc)
    return calendar.timegm((current.year, current.month, 1, 0, 0, 0))


def _window_label() -> str:
    return "rolling_days" if budget_window_days() else "calendar_month"


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


def reserve(provider: str, model: str, tokens_in: int, max_tokens_out: int, purpose: str = ""):
    """Atomically check the budget and reserve the worst-case cost of one call.

    Returns a reservation id, or None when the call would exceed the budget or
    the ledger is unavailable (fail closed). The check and the insert run in
    one write transaction (BEGIN IMMEDIATE on SQLite, an advisory lock on
    PostgreSQL), so concurrent callers cannot all pass the same check.
    """
    projected = estimate_cost(provider, tokens_in, max_tokens_out)
    limit = budget_limit()
    reservation_id = "aiu-" + secrets.token_hex(8)
    try:
        ensure_schema()
        m = _main()
        conn = m.db()
        try:
            conn.execute("BEGIN" if m.DATABASE_URL else "BEGIN IMMEDIATE")
            if m.DATABASE_URL:
                conn.execute("SELECT pg_advisory_xact_lock(?)", (_PG_BUDGET_LOCK_KEY,))
            row = conn.execute(
                "SELECT COALESCE(SUM(est_cost_usd),0) AS spent FROM ai_usage_ledger WHERE created_at>=?",
                (budget_window_start(),),
            ).fetchone()
            spent = float(row["spent"] or 0)
            if spent + projected > limit:
                conn.execute("ROLLBACK")
                return None
            conn.execute(
                """INSERT INTO ai_usage_ledger(
                    id,provider,model,tokens_in,tokens_out,est_cost_usd,purpose,created_at,status)
                VALUES (?,?,?,?,?,?,?,?,'reserved')""",
                (reservation_id, provider, model, int(tokens_in), int(max_tokens_out),
                 projected, str(purpose)[:80], time.time()),
            )
            conn.execute("COMMIT")
            return reservation_id
        except Exception:
            try:
                conn.execute("ROLLBACK")
            except Exception:
                pass
            raise
        finally:
            conn.close()
    except Exception as exc:
        log.error("AI budget reservation failed; treating the budget as exhausted (%s)", type(exc).__name__)
        return None


def settle(reservation_id: str, provider: str, tokens_in: int, tokens_out: int) -> float:
    """Replace a reservation with the actual usage. If this write fails the
    reservation keeps its worst-case cost (fail closed). Returns the cost."""
    cost = estimate_cost(provider, tokens_in, tokens_out)
    try:
        _main().run(
            "UPDATE ai_usage_ledger SET tokens_in=?, tokens_out=?, est_cost_usd=?, status='settled' WHERE id=?",
            (int(max(0, tokens_in)), int(max(0, tokens_out)), cost, reservation_id),
        )
    except Exception as exc:
        log.error("AI usage could not be settled for %s (%s)", reservation_id, type(exc).__name__)
    return cost


def release(reservation_id: str) -> None:
    """Drop a reservation for a call the provider rejected (nothing billed)."""
    try:
        _main().run(
            "UPDATE ai_usage_ledger SET tokens_in=0, tokens_out=0, est_cost_usd=0, status='released' WHERE id=?",
            (reservation_id,),
        )
    except Exception as exc:
        log.error("AI reservation could not be released for %s (%s)", reservation_id, type(exc).__name__)


def budget_status() -> dict:
    try:
        ensure_schema()
        since = budget_window_start()
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
            "window": _window_label(),
            "window_start": since,
            "exhausted": spent >= limit,
            "providers": sorted(providers, key=lambda item: item["est_cost_usd"], reverse=True),
            "estimate": True,
        }
    except Exception as exc:
        # Fail CLOSED: an unreadable ledger must not allow unbounded paid calls.
        log.error("AI budget status unavailable; treating budget as exhausted (%s)", type(exc).__name__)
        return {
            "limit_usd": budget_limit(),
            "spent_usd": None,
            "remaining_usd": 0.0,
            "window_days": budget_window_days(),
            "window": _window_label(),
            "exhausted": True,
            "error": "budget_unavailable",
            "providers": [],
            "estimate": True,
        }


def can_spend(estimated_cost: float) -> bool:
    status = budget_status()
    if status.get("error") or status["spent_usd"] is None:
        return False
    return (status["spent_usd"] + max(0.0, float(estimated_cost))) <= status["limit_usd"]
