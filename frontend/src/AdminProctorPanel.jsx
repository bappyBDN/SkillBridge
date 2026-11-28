import { useCallback, useEffect, useState } from "react";
import { api } from "./api.js";

const TYPE_LABEL = {
  face_absent: "Face not visible",
  multiple_faces: "More than one face",
  head_turned: "Head turned away",
  gaze_away: "Gaze away",
  gaze_pattern: "Gaze pattern",
  camera_analysis_unavailable: "Camera analysis unavailable",
  camera_lost: "Camera stopped",
  tab_hidden: "Tab hidden",
  tab_visible: "Tab visible",
  window_blur: "Window blur",
  window_blur_end: "Window focus returned",
  fullscreen_exit: "Full screen exited",
  fullscreen_enter: "Full screen entered",
  copy: "Copy", cut: "Cut", paste: "Paste",
  context_menu: "Context menu",
  printscreen: "Print screen",
  devtools_shortcut: "DevTools shortcut",
  second_tab: "Second tab",
  beforeunload: "Leave page",
  screen_share_started: "Screen share started",
  screen_share_stopped: "Screen share stopped",
  screen_share_unavailable: "Screen share unavailable",
};

function stamp(value) {
  return value ? new Date(Number(value) * 1000).toLocaleString() : "—";
}

/**
 * Admin Proctoring tab: baseline, timeline, signed thumbnails, per-flag human
 * review, appeals, caps and raw/after-review labels.
 */
export default function AdminProctorPanel({ inviteId, onNotice }) {
  const [data, setData] = useState(null);
  const [status, setStatus] = useState("loading");
  const [error, setError] = useState("");
  const [drafts, setDrafts] = useState({});
  const [busy, setBusy] = useState("");
  const [accommodation, setAccommodation] = useState({
    gaze_enabled: true, proctoring_level: "", note: "",
  });
  const [accommodationBusy, setAccommodationBusy] = useState(false);

  const load = useCallback(async () => {
    setStatus("loading");
    setError("");
    try {
      const result = await api(`/admin/interviews/${inviteId}/proctor`);
      setData(result);
      setDrafts(Object.fromEntries((result.events || []).map((event) => [
        event.event_id,
        { review_status: event.review_status || "unreviewed", note: event.review_note || "" },
      ])));
      setAccommodation({
        gaze_enabled: Boolean(result.gaze_enabled),
        proctoring_level: result.proctoring_level || "",
        note: "",
      });
      setStatus("ready");
    } catch (e) {
      setError(e?.message || "The proctoring timeline could not be loaded.");
      setStatus("error");
    }
  }, [inviteId]);

  useEffect(() => {
    load();
  }, [load]);

  const review = async (event) => {
    const draft = drafts[event.event_id] || {};
    setBusy(event.event_id);
    setError("");
    try {
      await api(`/admin/interviews/${inviteId}/proctor/events/${event.event_id}`, {
        method: "PATCH",
        body: { review_status: draft.review_status || "unreviewed", note: draft.note || "" },
      });
      onNotice?.("Flag reviewed. The integrity label was recomputed.");
      await load();
    } catch (e) {
      setError(e?.message || "The flag could not be reviewed.");
    } finally {
      setBusy("");
    }
  };

  const applyAccommodation = async () => {
    setAccommodationBusy(true);
    setError("");
    try {
      await api(`/admin/interviews/${inviteId}/proctor/accommodation`, {
        method: "POST",
        body: {
          gaze_enabled: accommodation.gaze_enabled,
          ...(accommodation.proctoring_level
            ? { proctoring_level: accommodation.proctoring_level } : {}),
          note: accommodation.note || "Reviewed with the candidate request.",
        },
      });
      onNotice?.("Accommodation applied and the candidate was notified.");
      await load();
    } catch (e) {
      setError(e?.message || "The accommodation could not be applied.");
    } finally {
      setAccommodationBusy(false);
    }
  };

  if (status === "loading") return <p className="cr-footnote">Loading proctoring timeline…</p>;
  if (status === "error") {
    return (
      <div>
        <p className="ci-error" role="alert">{error}</p>
        <button type="button" className="btn ghost sm" onClick={load}>Retry</button>
      </div>
    );
  }
  if (!data) return null;

  const raw = data.trust?.raw || {};
  const after = data.trust?.after_review || {};
  const counts = data.counts || {};
  const requests = data.accommodation_requests || [];

  return (
    <div className="ai-proctor">
      <div className="ai-proctor-summary">
        <div className="ai-proctor-label">
          <span className="cr-footnote">Raw label</span>
          <strong>{raw.label || "—"}</strong>
          <small>{raw.points ?? 0} points</small>
        </div>
        <div className="ai-proctor-label">
          <span className="cr-footnote">After human review</span>
          <strong className={after.label === "Needs review" ? "bad" : "ok"}>
            {after.label || "—"}
          </strong>
          <small>{after.points ?? 0} points · company sees this</small>
        </div>
        <div className="ai-proctor-counters">
          <span>Events {counts.events}/{counts.max_events}{data.events_capped_at ? " (capped)" : ""}</span>
          <span>Snapshots {counts.shots}/{counts.max_shots}{data.shots_capped_at ? " (capped)" : ""}</span>
          <span>ML unavailable {counts.camera_analysis_unavailable || 0}</span>
          <span>Appeals open {data.unresolved_appeals || 0}</span>
          <span>Storage: {data.shot_storage_mode}</span>
        </div>
      </div>

      <div className="ai-proctor-baseline">
        <div>
          <h3>Baseline photo</h3>
          <p className="cr-footnote">
            Human comparison only. The company never sees this image. Level:{" "}
            {String(data.proctoring_level).replaceAll("_", " ")} · gaze{" "}
            {data.gaze_enabled ? "enabled" : "disabled"}
          </p>
          {data.calibration?.baseline_url ? (
            <img src={data.calibration.baseline_url} alt="Candidate baseline for human review" />
          ) : (
            <p className="cr-muted-box">No baseline photo was captured.</p>
          )}
        </div>
        <div className="ai-proctor-consent">
          <h3>Consent</h3>
          <p className="cr-footnote">
            {data.consent_version || "No proctor consent recorded"}
            {data.consent_at ? ` · ${stamp(data.consent_at)}` : ""}
          </p>
          <p className="cr-footnote">Rule version: {data.rule_version}</p>
        </div>
      </div>

      {requests.length > 0 && (
        <div className="ai-proctor-requests">
          <h3>Accommodation requests</h3>
          {requests.map((request) => (
            <div key={request.id} className="ai-proctor-request">
              <strong>{String(request.status).replaceAll("_", " ")}</strong>
              <p>{request.note}</p>
              <small>
                {stamp(request.created_at)}
                {request.prefer_manual ? " · prefers manual/Zoom" : ""}
                {request.gaze_enabled === 0 ? " · requested gaze off" : ""}
              </small>
            </div>
          ))}
        </div>
      )}

      <div className="ai-proctor-apply">
        <h3>Apply an accommodation</h3>
        <label className="ci-check-inline">
          <input
            type="checkbox"
            checked={accommodation.gaze_enabled}
            onChange={(e) => setAccommodation({ ...accommodation, gaze_enabled: e.target.checked })}
          />
          Gaze analysis enabled
        </label>
        <label>
          Proctoring level
          <select
            value={accommodation.proctoring_level}
            onChange={(e) => setAccommodation({ ...accommodation, proctoring_level: e.target.value })}
          >
            <option value="">Keep current</option>
            <option value="off">Off</option>
            <option value="light">Light</option>
            <option value="standard">Standard</option>
            <option value="strict">Strict</option>
          </select>
        </label>
        <label>
          Note (audited)
          <input
            value={accommodation.note}
            maxLength={1000}
            onChange={(e) => setAccommodation({ ...accommodation, note: e.target.value })}
          />
        </label>
        <button type="button" className="btn ghost sm" disabled={accommodationBusy}
                onClick={applyAccommodation}>
          {accommodationBusy ? "Saving…" : "Apply accommodation"}
        </button>
      </div>

      <h3>Event timeline</h3>
      {error && <p className="ci-error" role="alert">{error}</p>}
      {!data.events.length && <p className="cr-muted-box">No proctoring events were recorded.</p>}
      <ol className="ai-proctor-events">
        {data.events.map((event) => {
          const draft = drafts[event.event_id] || { review_status: "unreviewed", note: "" };
          return (
            <li key={event.event_id} className={"ai-proctor-event " + event.severity}>
              <div className="ai-proctor-event-head">
                <strong>{TYPE_LABEL[event.type] || event.type}</strong>
                <span className={"vi-flag-severity " + event.severity}>{event.severity}</span>
                <span className="cr-footnote">
                  Q{event.turn_no || "—"} · {stamp(event.server_ts)}
                </span>
              </div>
              {Object.keys(event.detail || {}).length > 0 && (
                <p className="cr-footnote">
                  {Object.entries(event.detail)
                    .filter(([, value]) => value !== null && value !== "")
                    .map(([key, value]) => `${key}: ${value}`)
                    .join(" · ")}
                </p>
              )}
              {event.shot_url && (
                <img className="ai-proctor-shot" src={event.shot_url}
                     alt={`Snapshot for ${event.type}`} />
              )}
              {event.appeal_text && (
                <div className="ai-proctor-appeal">
                  <strong>Candidate appeal</strong>
                  <p>{event.appeal_text}</p>
                  <small>{stamp(event.appeal_at)}</small>
                </div>
              )}
              <div className="ai-proctor-review">
                <select
                  value={draft.review_status}
                  onChange={(e) => setDrafts((current) => ({
                    ...current,
                    [event.event_id]: { ...draft, review_status: e.target.value },
                  }))}
                >
                  <option value="unreviewed">Unreviewed</option>
                  <option value="dismissed">Dismiss</option>
                  <option value="confirmed">Confirm</option>
                </select>
                <input
                  value={draft.note}
                  maxLength={2000}
                  placeholder="Reviewer note (audited)"
                  onChange={(e) => setDrafts((current) => ({
                    ...current,
                    [event.event_id]: { ...draft, note: e.target.value },
                  }))}
                />
                <button type="button" className="cr-outline-btn"
                        disabled={busy === event.event_id}
                        onClick={() => review(event)}>
                  {busy === event.event_id ? "Saving…" : "Save review"}
                </button>
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
