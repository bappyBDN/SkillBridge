import { useState } from "react";
import { api } from "./api.js";
import { useT } from "./i18n.js";

function readToken(hash) {
  const query = (hash || "").split("?")[1] || "";
  return new URLSearchParams(query).get("token") || "";
}

/** Public route for requesting and completing a password reset by email. */
export default function PasswordReset({ hash }) {
  const t = useT();
  const token = readToken(hash);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [devLink, setDevLink] = useState("");
  const [done, setDone] = useState(false);
  const mismatch = Boolean(confirmPassword) && confirmPassword !== password;

  const request = async (event) => {
    event.preventDefault();
    setError("");
    setNotice("");
    setDevLink("");
    setBusy(true);
    try {
      const result = await api("/auth/forgot-password", { method: "POST", body: { email } });
      setNotice(result.message || t("settingsResetSent"));
      if (result.reset_token) {
        setDevLink(`#/reset-password?token=${encodeURIComponent(result.reset_token)}`);
      }
    } catch (x) {
      setError(x.message || t("error"));
    } finally {
      setBusy(false);
    }
  };

  const reset = async (event) => {
    event.preventDefault();
    setError("");
    if (password !== confirmPassword) {
      setError(t("settingsPasswordMismatch"));
      return;
    }
    setBusy(true);
    try {
      await api("/auth/reset-password", { method: "POST", body: { token, password } });
      setDone(true);
      setPassword("");
      setConfirmPassword("");
    } catch (x) {
      setError(x.status === 400 ? t("resetInvalid") : (x.message || t("error")));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="wrap">
      <section className="card narrow">
        <h2>{t("resetTitle")}</h2>
        {done ? (
          <>
            <p className="success-note">{t("resetDone")}</p>
            <a className="btn" href="#signin">{t("resetBack")}</a>
          </>
        ) : token ? (
          <>
            <p className="muted">{t("resetHelp")}</p>
            <form className="sec-form" onSubmit={reset}>
              <label>
                {t("settingsNewPassword")}
                <input
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  required
                  minLength={8}
                  maxLength={128}
                  autoComplete="new-password"
                  aria-label={t("settingsNewPassword")}
                />
                <small className="muted">{t("settingsPasswordHint")}</small>
              </label>
              <label>
                {t("settingsConfirmPassword")}
                <input
                  type="password"
                  value={confirmPassword}
                  onChange={(event) => setConfirmPassword(event.target.value)}
                  required
                  autoComplete="new-password"
                  aria-label={t("settingsConfirmPassword")}
                />
                {mismatch && <small className="err">{t("settingsPasswordMismatch")}</small>}
              </label>
              {error && <p className="err" role="alert">{error}</p>}
              <div className="row">
                <button className="btn" disabled={busy || mismatch || password.length < 8}>
                  {busy ? t("saving") : t("resetSubmit")}
                </button>
                <a className="btn ghost" href="#signin">{t("resetBack")}</a>
              </div>
            </form>
          </>
        ) : (
          <>
            <p className="muted">{t("resetRequestHelp")}</p>
            <form className="sec-form" onSubmit={request}>
              <label>
                {t("resetEmail")}
                <input
                  type="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  required
                  autoComplete="email"
                  aria-label={t("resetEmail")}
                />
              </label>
              {error && <p className="err" role="alert">{error}</p>}
              {notice && <p className="success-note" role="status">{notice}</p>}
              {devLink && <p className="note"><a href={devLink}>{t("settingsResetDevLink")}</a></p>}
              <div className="row">
                <button className="btn" disabled={busy}>{busy ? t("saving") : t("resetSend")}</button>
                <a className="btn ghost" href="#signin">{t("resetBack")}</a>
              </div>
            </form>
          </>
        )}
      </section>
    </main>
  );
}
