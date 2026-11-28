import { useEffect, useState } from "react";
import { api } from "./api.js";

const EMPTY_CUSTOM = { text: "", must_ask: false };

/**
 * Company interview setup: manual/Zoom details or an AI interview schedule.
 * The AI interview only schedules questions; a human reviews the result before
 * the company can read it.
 */
export default function CompanyInterviewModal({ application, onClose, onSaved }) {
  const appId = application?.application_id;
  const [detail, setDetail] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [method, setMethod] = useState("ai");
  const [zoom, setZoom] = useState({ meeting_url: "", scheduled_at: "", note: "" });
  const [ai, setAi] = useState({
    deadline_days: 1,
    language: "en-US",
    topics_count: 5,
    max_questions: 10,
  });
  const [custom, setCustom] = useState([]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api(`/company/applications/${appId}`)
      .then((data) => {
        if (cancelled) return;
        setDetail(data);
        const summary = data.interview || {};
        if (summary.zoom) {
          setZoom({
            meeting_url: summary.zoom.meeting_url || "",
            scheduled_at: summary.zoom.scheduled_at || "",
            note: summary.zoom.note || "",
          });
          setMethod("zoom");
        } else if (summary.invite) {
          setMethod("ai");
        }
      })
      .catch((e) => {
        if (!cancelled) setError(e?.message || "Could not load this application.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [appId]);

  const interview = detail?.interview || {};
  const existingInvite = interview.invite || null;
  const activeInvite =
    existingInvite && !["rejected", "expired"].includes(existingInvite.status)
      ? existingInvite
      : null;

  const setField = (key, value) => setAi((current) => ({ ...current, [key]: value }));
  const updateCustom = (index, patch) =>
    setCustom((items) => items.map((item, i) => (i === index ? { ...item, ...patch } : item)));

  const submit = async (event) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      let body;
      if (method === "zoom") {
        body = { method: "zoom", ...zoom };
      } else {
        const questions = custom
          .map((item) => ({ text: item.text.trim(), must_ask: Boolean(item.must_ask) }))
          .filter((item) => item.text.length >= 3);
        body = { method: "ai", ...ai, custom_questions: questions };
      }
      await api(`/company/applications/${appId}/interview`, { method: "POST", body });
      onSaved?.();
      onClose?.();
    } catch (e) {
      setError(e?.message || "The interview could not be saved.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="ci-modal" role="dialog" aria-modal="true" aria-labelledby="ci-modal-title">
      <div className="ci-modal-shell">
        <header className="ci-modal-head">
          <div>
            <span className="eyebrow">Interview setup</span>
            <h2 id="ci-modal-title">{application?.candidate_name || "Candidate"}</h2>
            <p>{application?.job_title || "Role"}</p>
          </div>
          <button type="button" className="cr-text-btn" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>

        {loading && <p className="cr-footnote">Loading…</p>}
        {error && (
          <p className="ci-error" role="alert">
            {error}
          </p>
        )}

        {!loading && activeInvite && (
          <div className="ci-existing">
            <strong>
              AI interview already created · {String(activeInvite.status).replaceAll("_", " ")}
            </strong>
            <p>
              {activeInvite.language === "bn-BD" ? "বাংলা" : "English"} ·{" "}
              {activeInvite.max_questions} questions ·{" "}
              {activeInvite.result_available
                ? "results released to your workspace"
                : "awaiting platform admin review"}
            </p>
            <p className="cr-footnote">
              You can read the answers from the applicant page only after a human reviewer
              approves them.
            </p>
            <button type="button" className="cr-outline-btn" onClick={onClose}>
              Close
            </button>
          </div>
        )}

        {!loading && !activeInvite && (
          <form onSubmit={submit} className="ci-form">
            <fieldset className="ci-methods">
              <legend>Interview method</legend>
              <label className={method === "ai" ? "selected" : ""}>
                <input
                  type="radio"
                  name="method"
                  value="ai"
                  checked={method === "ai"}
                  onChange={() => setMethod("ai")}
                />
                <span>
                  <strong>AI interview</strong>
                  <small>
                    Spoken questions, transcript and optional audio. Human review before you
                    can read the answers.
                  </small>
                </span>
              </label>
              <label className={method === "zoom" ? "selected" : ""}>
                <input
                  type="radio"
                  name="method"
                  value="zoom"
                  checked={method === "zoom"}
                  onChange={() => setMethod("zoom")}
                />
                <span>
                  <strong>Manual / Zoom</strong>
                  <small>Add a meeting link and time. A human runs the interview.</small>
                </span>
              </label>
            </fieldset>

            {method === "zoom" ? (
              <div className="ci-grid">
                <label className="ci-span-2">
                  Meeting URL
                  <input
                    type="url"
                    required
                    placeholder="https://zoom.us/j/…"
                    value={zoom.meeting_url}
                    onChange={(e) => setZoom({ ...zoom, meeting_url: e.target.value })}
                  />
                </label>
                <label>
                  Scheduled at
                  <input
                    type="datetime-local"
                    required
                    value={zoom.scheduled_at}
                    onChange={(e) => setZoom({ ...zoom, scheduled_at: e.target.value })}
                  />
                </label>
                <label className="ci-span-2">
                  Note for the candidate
                  <textarea
                    rows="2"
                    value={zoom.note}
                    onChange={(e) => setZoom({ ...zoom, note: e.target.value })}
                    placeholder="What to prepare, who will join, time zone…"
                  />
                </label>
              </div>
            ) : (
              <>
                <div className="ci-grid">
                  <label>
                    Deadline
                    <select
                      value={ai.deadline_days}
                      onChange={(e) => setField("deadline_days", Number(e.target.value))}
                    >
                      <option value={1}>1 day</option>
                      <option value={2}>2 days</option>
                      <option value={3}>3 days</option>
                    </select>
                  </label>
                  <label>
                    Interview language
                    <select
                      value={ai.language}
                      onChange={(e) => setField("language", e.target.value)}
                    >
                      <option value="en-US">English</option>
                      <option value="bn-BD">বাংলা</option>
                    </select>
                  </label>
                  <label>
                    Main topics
                    <input
                      type="number"
                      min="1"
                      max="8"
                      value={ai.topics_count}
                      onChange={(e) => setField("topics_count", Number(e.target.value))}
                    />
                  </label>
                  <label>
                    Max questions (incl. follow-ups)
                    <input
                      type="number"
                      min="6"
                      max="15"
                      value={ai.max_questions}
                      onChange={(e) => setField("max_questions", Number(e.target.value))}
                    />
                  </label>
                </div>

                <div className="ci-custom-head">
                  <div>
                    <strong>Your own questions (optional, max 5)</strong>
                    <p className="cr-footnote">
                      “Must ask” questions are inserted at fixed positions by the platform, not
                      chosen by the AI.
                    </p>
                  </div>
                  <button
                    type="button"
                    className="cr-outline-btn"
                    disabled={custom.length >= 5}
                    onClick={() => setCustom((items) => [...items, { ...EMPTY_CUSTOM }])}
                  >
                    Add question
                  </button>
                </div>
                {custom.map((item, index) => (
                  <div className="ci-custom-row" key={index}>
                    <input
                      value={item.text}
                      maxLength={500}
                      placeholder="Question for the candidate"
                      onChange={(e) => updateCustom(index, { text: e.target.value })}
                    />
                    <label className="ci-check-inline">
                      <input
                        type="checkbox"
                        checked={item.must_ask}
                        onChange={(e) => updateCustom(index, { must_ask: e.target.checked })}
                      />
                      Must ask
                    </label>
                    <button
                      type="button"
                      className="cr-text-btn"
                      onClick={() => setCustom((items) => items.filter((_, i) => i !== index))}
                    >
                      Remove
                    </button>
                  </div>
                ))}
              </>
            )}

            <div className="ci-modal-actions">
              <button type="button" className="btn ghost" onClick={onClose} disabled={busy}>
                Cancel
              </button>
              <button type="submit" className="btn" disabled={busy}>
                {busy ? "Saving…" : method === "ai" ? "Create AI interview" : "Save meeting details"}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
