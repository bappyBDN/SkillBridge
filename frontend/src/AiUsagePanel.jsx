import { useEffect, useState } from "react";
import { api } from "./api.js";

/**
 * AI provider usage for the Admin Billing page.
 *
 * Reads the existing `/api/agent/status` payload (`ai_budget`), which is backed
 * by the `ai_usage_ledger` table. Read-only; no billing or provider calls.
 */
export default function AiUsagePanel() {
  const [status, setStatus] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const load = async () => {
    setBusy(true);
    setError("");
    try {
      setStatus(await api("/agent/status"));
    } catch (e) {
      setError(
        e.status === 401
          ? "Sign in as an administrator to view AI usage."
          : e.message || "Could not load AI provider usage.",
      );
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const budget = status?.ai_budget;
  const providers = budget?.providers || [];
  const spent = Number(budget?.spent_usd || 0);
  const limit = Number(budget?.limit_usd || 0);
  const remaining = Number(budget?.remaining_usd || 0);
  const tokensIn = providers.reduce((sum, row) => sum + Number(row.tokens_in || 0), 0);
  const tokensOut = providers.reduce((sum, row) => sum + Number(row.tokens_out || 0), 0);

  return (
    <div className="ad-panel">
      <div className="ad-panel-head">
        <div>
          <h3>AI provider usage</h3>
          <p>
            Estimated API spend and token usage across the configured AI providers
            (Groq, DeepSeek, Gemini, …).
          </p>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          {budget && (
            <span className="ad-count">
              {budget.exhausted ? "BUDGET PAUSED" : "WITHIN BUDGET"}
            </span>
          )}
          <button
            type="button"
            onClick={load}
            disabled={busy}
            style={{
              padding: "7px 13px",
              borderRadius: 8,
              border: "1px solid #dfe7e4",
              background: "#fff",
              color: "#0c6558",
              fontWeight: 700,
              fontSize: 12.5,
              cursor: busy ? "not-allowed" : "pointer",
              opacity: busy ? 0.6 : 1,
            }}
          >
            {busy ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      </div>

      {error && <div className="ad-billing-empty">{error}</div>}
      {!budget && !error && <div className="ad-billing-empty">Loading AI usage…</div>}

      {budget && (
        <>
          <div className="ad-billing-metrics" style={{ marginBottom: 14 }}>
            <article>
              <small>Estimated AI spend</small>
              <strong>${spent.toFixed(4)}</strong>
              <span>Last {budget.window_days} days</span>
            </article>
            <article>
              <small>Remaining budget</small>
              <strong>${remaining.toFixed(4)}</strong>
              <span>of ${limit.toFixed(2)} configured</span>
            </article>
            <article>
              <small>Total tokens</small>
              <strong>{(tokensIn + tokensOut).toLocaleString()}</strong>
              <span>
                {tokensIn.toLocaleString()} in · {tokensOut.toLocaleString()} out
              </span>
            </article>
            <article>
              <small>Providers billed</small>
              <strong>{providers.length}</strong>
              <span>Grouped from the usage ledger</span>
            </article>
          </div>

          <div className="ad-table-wrap">
            <table className="ad-table">
              <thead>
                <tr>
                  <th>Provider</th>
                  <th>Tokens in</th>
                  <th>Tokens out</th>
                  <th>Estimated cost</th>
                  <th>Share of spend</th>
                </tr>
              </thead>
              <tbody>
                {providers.map((row) => {
                  const cost = Number(row.est_cost_usd || 0);
                  const share = spent > 0 ? (cost / spent) * 100 : 0;
                  return (
                    <tr key={row.provider}>
                      <td>
                        <b style={{ textTransform: "capitalize" }}>{row.provider}</b>
                      </td>
                      <td>{Number(row.tokens_in || 0).toLocaleString()}</td>
                      <td>{Number(row.tokens_out || 0).toLocaleString()}</td>
                      <td>${cost.toFixed(6)}</td>
                      <td>{share.toFixed(1)}%</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {!providers.length && (
            <div className="ad-billing-empty">
              No AI calls recorded in this window yet. Usage appears here after the
              copilot or CV extraction uses a provider.
            </div>
          )}

          {budget.exhausted && (
            <div className="ad-billing-notice" style={{ marginTop: 12 }}>
              <b>Budget reached.</b>
              <span>
                Agent LLM calls now fall back to deterministic output until the
                window resets or the budget is raised.
              </span>
            </div>
          )}

          <p
            style={{
              margin: "12px 2px 0",
              fontSize: 12,
              lineHeight: 1.6,
              color: "#65738a",
            }}
          >
            Costs are estimates from token counts and configurable per-token prices
            (<code>AI_PRICE_*</code> env vars). Provider dashboards are the
            authoritative invoice. Source: <code>ai_usage_ledger</code>.
          </p>
        </>
      )}
    </div>
  );
}
