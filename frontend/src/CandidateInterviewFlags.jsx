import { useCallback, useEffect, useState } from "react";
import { api } from "./api.js";

const TYPE_LABEL = {
  face_absent: "Face not visible",
  multiple_faces: "More than one face",
  head_turned: "Head turned away",
  gaze_away: "Gaze away from screen",
  gaze_pattern: "Repeated gaze-away pattern",
  camera_analysis_unavailable: "Camera analysis unavailable",
  camera_lost: "Camera stopped",
  tab_hidden: "Tab hidden",
  window_blur: "Window lost focus",
  fullscreen_exit: "Full screen exited",
  copy: "Copy attempt",
  cut: "Cut attempt",
  paste: "Paste attempt",
  context_menu: "Context menu",
  printscreen: "Print screen key",
  devtools_shortcut: "Developer tools shortcut",
  second_tab: "Second tab opened",
  beforeunload: "Tried to leave the page",
  screen_share_started: "Screen sharing started",
  screen_share_stopped: "Screen sharing stopped",
  screen_share_unavailable: "Screen sharing unavailable",
};

function stamp(value) {
  return value ? new Date(Number(value) * 1000).toLocaleString() : "—";
}

/**
 * Candidate transparency: their own advisory flags after submission, each with
 * an appeal box, plus an accommodation request. Never shows images or other
 * candidates' data.
 */
export default function CandidateInterviewFlags({ inviteId }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [drafts, setDrafts] = useState({});
  const [busyId, setBusyId] = useState("");
  const [accommodation, setAccommodation] = useState({
    note: "", gaze_enabled: false, prefer_manual: false,
  });
  const [accommodationBusy, setAccommodationBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const result = await api(`/interviews/${inviteId}/proctor/mine`);
      setData(result);
      setError("");
    } catch (e) {
      setError(e?.message || "Your flag list could not be loaded.");
    }
  }, [inviteId]);

  useEffect(() => {
    load();
  }, [load]);

  const appeal = async (eventId) => {
    const note = (drafts[eventId] || "").trim();
    if (note.length < 3) {
      setError("Write a short explanation before sending an appeal.");
      return;
    }
    setBusyId(eventId);
    setError("");
    try {
      await api(`/interviews/${inviteId}/proctor/events/${eventId}/appeal`, {
        method: "POST", body: { note },
      });
      setNotice("Appeal sent to the human reviewer. It does not change your answers.");
      setDrafts((current) => ({ ...current, [eventId]: "" }));
      await load();
    } catch (e) {
      setError(e?.message || "The appeal could not be sent.");
    } finally {
      setBusyId("");
    }
  };

  const requestAccommodation = async (event) => {
    event.preventDefault();
    if (accommodation.note.trim().length < 3) {
      setError("Describe the accommodation you need in a short sentence.");
      return;
    }
    setAccommodationBusy(true);
    setError("");
    try {
      await api(`/interviews/${inviteId}/proctor/accommodation-request`, {
        method: "POST",
        body: {
          note: accommodation.note.trim(),
          gaze_enabled: accommodation.gaze_enabled ? false : null,
          prefer_manual: accommodation.prefer_manual,
        },
      });
      setNotice("Accommodation request sent to the platform reviewer.");
      setAccommodation({ note: "", gaze_enabled: false, prefer_manual: false });
    } catch (e) {
      setError(e?.message || "The accommodation request could not be sent.");
    } finally {
      setAccommodationBusy(false);
    }
  };

  if (error && !data) return <p className="vi-error" role="alert">{error}</p>;
  if (!data) return <p className="cr-footnote">Loading your flags…</p>;

  const events = data.events || [];
  const submitted = Boolean(data.submitted);
  const label = data.trust?.after_review?.label || "High trust";

  return (
    <section className="vi-flags" aria-labelledby="vi-flags-title">
      <div className="vi-flags-head">
        <div>
          <h3 id="vi-flags-title">Your interview flags</h3>
          <p className="cr-footnote">
            These are advisory observations for the human reviewer. They never change your
            answers, never fail you, and the company never sees this list or any images.
          </p>
        </div>
        <span className={"status-pill " + (label === "Needs review" ? "status-review" : "status-valid")}>
          {label}
        </span>
      </div>

      {notice && <p className="success-note" role="status">{notice}</p>}
      {error && <p className="vi-error" role="alert">{error}</p>}
      {!events.length && <p className="cr-muted-box">No flags were recorded.</p>}

      {events.length > 0 && (
        <ol className="vi-flag-list">
          {events.map((event) => {
            const appealed = Boolean(event.appeal_text);
            const canAppeal = submitted && !appealed;
            return (
              <li key={event.event_id} className="vi-flag">
                <div className="vi-flag-head">
                  <strong>{TYPE_LABEL[event.type] || event.type}</strong>
                  <span className={"vi-flag-severity " + event.severity}>{event.severity}</span>
                  <span className="cr-footnote">
                    Question {event.turn_no || "—"} · {stamp(event.server_ts)}
                  </span>
                </div>
                <p className="cr-footnote">
                  Reviewer status: {String(event.review_status).replaceAll("_", " ")}
                </p>
                {appealed ? (
                  <div className="vi-appeal-sent">
                    <strong>Your appeal</strong>
                    <p>{event.appeal_text}</p>
                    <small>Sent {stamp(event.appeal_at)}</small>
                  </div>
                ) : canAppeal ? (
                  <div className="vi-appeal-box">
                    <label>
                      Appeal this flag
                      <textarea
                        rows="2"
                        maxLength={2000}
                        value={drafts[event.event_id] || ""}
                        placeholder="Explain what happened, for example lighting, glasses or a short glance."
                        onChange={(e) => setDrafts((current) => ({
                          ...current, [event.event_id]: e.target.value,
                        }))}
                      />
                    </label>
                    <button
                      type="button"
                      className="btn ghost sm"
                      disabled={busyId === event.event_id}
                      onClick={() => appeal(event.event_id)}
                    >
                      {busyId === event.event_id ? "Sending…" : "Send appeal"}
                    </button>
                  </div>
                ) : (
                  <p className="cr-footnote">
                    {submitted ? "Appeals are available after submission." : "The interview is still open."}
                  </p>
                )}
              </li>
            );
          })}
        </ol>
      )}

      <form className="vi-accommodation" onSubmit={requestAccommodation}>
        <h4>Request an accommodation</h4>
        <p className="cr-footnote">
          A platform reviewer handles this request. The company is told only that an
          accommodation was requested, never the reason.
        </p>
        <textarea
          rows="2"
          maxLength={1000}
          value={accommodation.note}
          placeholder="For example: please disable gaze analysis or offer a manual/Zoom interview."
          onChange={(e) => setAccommodation({ ...accommodation, note: e.target.value })}
        />
        <label className="ci-check-inline">
          <input
            type="checkbox"
            checked={accommodation.gaze_enabled}
            onChange={(e) => setAccommodation({ ...accommodation, gaze_enabled: e.target.checked })}
          />
          Disable gaze analysis
        </label>
        <label className="ci-check-inline">
          <input
            type="checkbox"
            checked={accommodation.prefer_manual}
            onChange={(e) => setAccommodation({ ...accommodation, prefer_manual: e.target.checked })}
          />
          Prefer a manual/Zoom interview
        </label>
        <button type="submit" className="btn ghost sm" disabled={accommodationBusy}>
          {accommodationBusy ? "Sending…" : "Send accommodation request"}
        </button>
      </form>
    </section>
  );
}
