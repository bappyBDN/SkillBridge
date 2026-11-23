import { useState } from "react";
import { api } from "./api.js";
import { useT } from "./i18n.js";

/**
 * Candidate account actions shown under Settings. Changing a password always
 * requires the current password server-side; the reset link stays a separate
 * one-time email flow for signed-out users.
 */
export default function CandidateAccountSettings({ st, onEditProfile }) {
  const t = useT();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");
  const [resetBusy, setResetBusy] = useState(false);
  const [resetNotice, setResetNotice] = useState("");
  const [resetLink, setResetLink] = useState("");
  const mismatch = Boolean(confirmPassword) && confirmPassword !== newPassword;

  const changePassword = async (event) => {
    event.preventDefault();
    setError("");
    setToast("");
    if (newPassword !== confirmPassword) {
      setError(t("settingsPasswordMismatch"));
      return;
    }
    setBusy(true);
    try {
      const result = await api("/auth/change-password", {
        method: "POST",
        body: { current_password: currentPassword, new_password: newPassword },
      });
      setToast(result.message || t("settingsPasswordUpdated"));
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
    } catch (x) {
      setError(x.message || t("error"));
    } finally {
      setBusy(false);
    }
  };

  const requestReset = async () => {
    setError("");
    setToast("");
    setResetNotice("");
    setResetLink("");
    setResetBusy(true);
    try {
      const result = await api("/auth/forgot-password", {
        method: "POST",
        body: { email: st.user?.email || "" },
      });
      setResetNotice(result.message || t("settingsResetSent"));
      if (result.reset_token) {
        setResetLink(`#/reset-password?token=${encodeURIComponent(result.reset_token)}`);
      }
    } catch (x) {
      setError(x.message || t("error"));
    } finally {
      setResetBusy(false);
    }
  };

  return (
    <section className="sec-panel candidate-settings">
      {toast && (
        <div className="cr-toast" role="status">
          <span>✓</span>
          {toast}
          <button type="button" aria-label="Dismiss" onClick={() => setToast("")}>×</button>
        </div>
      )}
      {error && (
        <div className="cr-error-banner" role="alert">
          {error}
          <button type="button" aria-label="Dismiss" onClick={() => setError("")}>×</button>
        </div>
      )}

      <div className="card">
        <div className="sec-row">
          <div>
            <strong>{t("settingsProfileTitle")}</strong>
            <small>{st.user?.name} · {st.user?.email}</small>
          </div>
          <button type="button" className="btn ghost sm" onClick={onEditProfile}>
            {t("settingsUpdateProfile")}
          </button>
        </div>
        <p className="muted">{t("settingsProfileHelp")}</p>
      </div>

      <div className="card">
        <div className="sec-row">
          <div>
            <strong>{t("settingsChangePassword")}</strong>
            <small>{t("settingsChangePasswordHelp")}</small>
          </div>
        </div>
        <form className="sec-form" onSubmit={changePassword}>
          <label>
            {t("settingsCurrentPassword")}
            <input
              type="password"
              value={currentPassword}
              onChange={(event) => setCurrentPassword(event.target.value)}
              required
              autoComplete="current-password"
              aria-label={t("settingsCurrentPassword")}
            />
          </label>
          <label>
            {t("settingsNewPassword")}
            <input
              type="password"
              value={newPassword}
              onChange={(event) => setNewPassword(event.target.value)}
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
          <div className="row">
            <button className="btn" disabled={busy || mismatch || newPassword.length < 8}>
              {busy ? t("saving") : t("settingsSavePassword")}
            </button>
          </div>
        </form>
      </div>

      <div className="card">
        <div className="sec-row">
          <div>
            <strong>{t("settingsForgotPassword")}</strong>
            <small>{t("settingsForgotPasswordHelp")}</small>
          </div>
          <button type="button" className="btn ghost sm" onClick={requestReset} disabled={resetBusy}>
            {resetBusy ? t("saving") : t("settingsSendReset")}
          </button>
        </div>
        {resetNotice && <p className="note" role="status">{resetNotice}</p>}
        {resetLink && (
          <p className="note">
            <a href={resetLink}>{t("settingsResetDevLink")}</a>
          </p>
        )}
      </div>
    </section>
  );
}
