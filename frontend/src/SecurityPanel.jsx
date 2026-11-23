import { useCallback, useEffect, useState } from "react";
import { api, setToken } from "./api.js";

/**
 * Shared account-security panel (SB-003): TOTP enrolment plus a revocable
 * session list. Used by both the admin console and the company workspace.
 *
 * ``S`` is the localised string bundle (admin.security / company.security).
 */
export default function SecurityPanel({ S, email }) {
  const [status, setStatus] = useState(null);
  const [sessions, setSessions] = useState([]);
  const [mode, setMode] = useState("idle");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [enrolment, setEnrolment] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");

  const load = useCallback(async () => {
    try {
      const [me, list] = await Promise.all([
        api("/auth/mfa/status"),
        api("/auth/sessions"),
      ]);
      setStatus(me);
      setSessions(list.sessions || []);
    } catch (e) {
      setError(e.message || "Could not load security settings.");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const startEnrolment = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const result = await api("/auth/mfa/enroll", {
        method: "POST",
        body: { email: email || status?.email || "", password },
      });
      setEnrolment(result);
      setPassword("");
      setMode("activate");
    } catch (x) {
      setError(x.message || "Could not start two-factor setup.");
    } finally {
      setBusy(false);
    }
  };

  const activate = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const result = await api("/auth/mfa/activate", {
        method: "POST",
        body: { challenge: enrolment?.challenge, code },
      });
      if (result.token) setToken(result.token);
      setToast(S.activated);
      setMode("idle");
      setEnrolment(null);
      setCode("");
      await load();
    } catch (x) {
      setError(x.message || "That code is not valid.");
    } finally {
      setBusy(false);
    }
  };

  const disable = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api("/auth/mfa/disable", {
        method: "POST",
        body: { email: email || status?.email || "", password },
      });
      setToast(S.disabled);
      setPassword("");
      setMode("idle");
      await load();
    } catch (x) {
      setError(x.message || "Could not turn off two-factor authentication.");
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (sid) => {
    try {
      await api("/auth/sessions/" + encodeURIComponent(sid), { method: "DELETE" });
      setToast(S.sessionRevoked);
      await load();
    } catch (x) {
      setError(x.message || "Could not sign that session out.");
    }
  };

  const copy = async (value) => {
    try {
      await navigator.clipboard.writeText(value);
      setToast(S.copied);
    } catch {
      setError("Copy failed. Select the text and copy it manually.");
    }
  };

  const when = (value) =>
    value ? new Date(value * 1000).toLocaleString() : "—";

  return (
    <section className="sec-panel">
      <header>
        <h2>{S.title}</h2>
        <p>{S.subtitle}</p>
      </header>

      {toast && (
        <div className="cr-toast" role="status">
          <span>✓</span>
          {toast}
          <button onClick={() => setToast("")}>×</button>
        </div>
      )}
      {error && (
        <div className="cr-error-banner" role="alert">
          {error}
          <button onClick={() => setError("")}>×</button>
        </div>
      )}

      <div className="card">
        <div className="sec-row">
          <div>
            <strong>{S.mfaTitle}</strong>
            <small>
              {status?.enabled ? S.mfaOn : S.mfaOff} ·{" "}
              {status?.required ? S.required : S.optional}
            </small>
          </div>
          {status?.enabled ? (
            <span className="sec-badge on">{S.mfaOn}</span>
          ) : (
            <span className="sec-badge">{S.mfaOff}</span>
          )}
        </div>

        {mode === "idle" && !status?.enabled && (
          <form className="sec-form" onSubmit={(e) => { e.preventDefault(); setMode("enroll"); }}>
            <p className="muted">{S.enrollHelp}</p>
            <button className="btn" type="submit">
              {S.enrollStart}
            </button>
          </form>
        )}

        {mode === "enroll" && (
          <form className="sec-form" onSubmit={startEnrolment}>
            <label>
              {S.password}
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                autoComplete="current-password"
                placeholder={S.passwordPh}
              />
            </label>
            <div className="row">
              <button className="btn" disabled={busy}>
                {busy ? "…" : S.continue}
              </button>
              <button type="button" className="btn ghost" onClick={() => setMode("idle")}>
                {S.cancel || "Cancel"}
              </button>
            </div>
          </form>
        )}

        {mode === "activate" && enrolment && (
          <form className="sec-form" onSubmit={activate}>
            <div className="sec-secret">
              <span>{S.secret}</span>
              <code>{enrolment.secret}</code>
              <button type="button" className="btn ghost sm" onClick={() => copy(enrolment.secret)}>
                {S.copy}
              </button>
            </div>
            {enrolment.otpauth_url && (
              <a className="sec-link" href={enrolment.otpauth_url}>
                {S.otpauth} ↗
              </a>
            )}
            <div>
              <strong>{S.recovery}</strong>
              <div className="sec-codes">
                {(enrolment.recovery_codes || []).map((value) => (
                  <code key={value}>{value}</code>
                ))}
              </div>
            </div>
            <label>
              {S.code}
              <input
                value={code}
                onChange={(e) => setCode(e.target.value)}
                required
                inputMode="numeric"
                autoComplete="one-time-code"
                placeholder="123456"
              />
            </label>
            <div className="row">
              <button className="btn" disabled={busy}>
                {S.activate}
              </button>
              <button type="button" className="btn ghost" onClick={() => { setMode("idle"); setEnrolment(null); }}>
                {S.cancel || "Cancel"}
              </button>
            </div>
          </form>
        )}

        {mode === "idle" && status?.enabled && (
          <form className="sec-form" onSubmit={disable}>
            <p className="muted">
              {S.recovery}: {status.recovery_codes_remaining}
            </p>
            <label>
              {S.password}
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                autoComplete="current-password"
              />
            </label>
            <button className="btn ghost" disabled={busy || status?.required}>
              {S.disable}
            </button>
          </form>
        )}
      </div>

      <div className="card">
        <div className="sec-row">
          <div>
            <strong>{S.sessionsTitle}</strong>
            <small>{S.sessionsHelp}</small>
          </div>
        </div>
        <table className="ad-table">
          <thead>
            <tr>
              <th>{S.lastSeen}</th>
              <th>{S.created}</th>
              <th>IP</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {sessions.map((session) => (
              <tr key={session.id}>
                <td>
                  {when(session.last_seen)}
                  {session.current && <span className="sec-badge on">{S.sessionCurrent}</span>}
                </td>
                <td>{when(session.created)}</td>
                <td className="mono">{session.ip || "—"}</td>
                <td>
                  {!session.current && !session.revoked && (
                    <button className="btn ghost sm" onClick={() => revoke(session.id)}>
                      {S.sessionRevoke}
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {!sessions.length && (
              <tr>
                <td colSpan={4}>—</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
