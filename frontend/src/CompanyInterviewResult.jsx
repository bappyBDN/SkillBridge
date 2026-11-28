import { useEffect, useState } from "react";
import { api } from "./api.js";

const STATUS_LABEL = {
  invited: "Invitation sent",
  in_progress: "Candidate is taking the interview",
  submitted: "Awaiting admin review",
  in_review: "Awaiting admin review",
  approved: "Approved — results available",
  rejected: "Rejected after human review",
  redo_requested: "Redo requested",
  expired: "Expired before completion",
};

function stamp(value) {
  return value ? new Date(Number(value) * 1000).toLocaleString() : "—";
}

/**
 * Company-facing AI interview results. Before approval this only shows status:
 * the result endpoint stays locked (403) until an admin releases it.
 */
export default function CompanyInterviewResult({ applicationId, interview }) {
  const invite = interview?.invite || null;
  const method = interview?.method || interview?.interview_method || "none";
  const [result, setResult] = useState(null);
  const [status, setStatus] = useState("idle");
  const [error, setError] = useState("");

  useEffect(() => {
    setResult(null);
    setError("");
    if (!invite?.result_available) {
      setStatus("locked");
      return undefined;
    }
    let cancelled = false;
    setStatus("loading");
    api(`/company/applications/${applicationId}/interview/result`)
      .then((data) => {
        if (!cancelled) {
          setResult(data);
          setStatus("ready");
        }
      })
      .catch((e) => {
        if (!cancelled) {
          setError(e?.message || "Results could not be loaded.");
          setStatus("error");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [applicationId, invite?.result_available, invite?.status]);

  if (!invite && method !== "zoom") return null;

  return (
    <div className="cr-report-section ci-result">
      <h3>Interview</h3>

      {method === "zoom" && interview?.zoom && (
        <div className="ci-zoom-box">
          <strong>Manual / Zoom interview</strong>
          <p>
            <a href={interview.zoom.meeting_url} target="_blank" rel="noreferrer">
              {interview.zoom.meeting_url}
            </a>
          </p>
          <p>Scheduled: {interview.zoom.scheduled_at || "—"}</p>
          {interview.zoom.note && <p>{interview.zoom.note}</p>}
        </div>
      )}

      {!invite && method !== "zoom" && (
        <p className="cr-muted-box">No interview has been set up for this application.</p>
      )}

      {invite && (
        <>
          <div className="ci-status">
            <span
              className={
                "status-pill " +
                (invite.status === "approved"
                  ? "status-valid"
                  : invite.status === "rejected" || invite.status === "expired"
                    ? "status-invalid"
                    : "status-review")
              }
            >
              {STATUS_LABEL[invite.status] || invite.status}
            </span>
            <span className="ci-meta">
              {invite.language === "bn-BD" ? "বাংলা" : "English"} · deadline{" "}
              {stamp(invite.deadline_at)} · {invite.asked || 0} of {invite.max_questions} asked
            </span>
          </div>

          {!invite.result_available && (
            <p className="cr-muted-box">
              {invite.status === "rejected"
                ? "A human reviewer rejected this interview. No AI score was produced."
                : invite.status === "expired"
                  ? "The candidate did not finish before the deadline. Partial answers remain with the platform reviewer."
                  : "The answers are visible only after a platform admin reviews and releases them."}
            </p>
          )}

          {status === "loading" && <p className="cr-footnote">Loading the reviewed answers…</p>}
          {status === "error" && (
            <p className="ci-error" role="alert">
              {error}
            </p>
          )}

          {status === "ready" && result && (
            <div className="ci-result-body">
              {result.integrity && (
                <div className="ci-integrity" role="status">
                  <span className={
                    "status-pill " +
                    (result.integrity.label === "Needs review"
                      ? "status-review"
                      : result.integrity.label === "Medium"
                        ? "status-review"
                        : "status-valid")
                  }>
                    {result.integrity.label}
                  </span>
                  <span>
                    Confirmed flags: {result.integrity.confirmed_flags ?? 0}
                  </span>
                  <p className="cr-footnote">
                    Advisory human-review label only. The AI never scored, judged or failed the
                    candidate, and no images or raw events are shared with your organisation.
                  </p>
                  {(result.integrity.reviewer_notes || []).map((note, index) => (
                    <p key={index} className="ci-admin-note">Reviewer note: {note}</p>
                  ))}
                </div>
              )}
              <p className="cr-footnote">
                Human marks and notes are shown as entered by the platform reviewer. The AI
                never scored or judged this interview.
              </p>
              {result.audio_mode === "transcript_only" && (
                <p className="cr-footnote">
                  Transcript-only deployment: audio was not stored for this interview.
                </p>
              )}
              <ol className="ci-turn-list">
                {(result.turns || []).map((turn) => (
                  <li key={turn.turn_id} className="ci-turn">
                    <div className="ci-turn-head">
                      <strong>Q{turn.turn_no}</strong>
                      <span className="ci-source">{String(turn.source).replaceAll("_", " ")}</span>
                      <span className="ci-turn-time">{stamp(turn.asked_at)}</span>
                    </div>
                    <p className="ci-question">{turn.question}</p>
                    <div className="ci-answer">
                      {turn.transcript ? (
                        turn.transcript
                      ) : (
                        <span className="cr-footnote">No transcript was captured.</span>
                      )}
                    </div>
                    <div className="ci-turn-foot">
                      <span>Answered {stamp(turn.answered_at)}</span>
                      {turn.answer_ms ? (
                        <span>{Math.round(turn.answer_ms / 1000)}s answer</span>
                      ) : null}
                      {turn.admin_mark != null && <span>Human mark: {turn.admin_mark}/5</span>}
                    </div>
                    {turn.admin_note && <p className="ci-admin-note">Reviewer note: {turn.admin_note}</p>}
                    {turn.audio_url && (
                      <audio controls preload="none" src={turn.audio_url} className="ci-audio">
                        Your browser cannot play this audio.
                      </audio>
                    )}
                  </li>
                ))}
              </ol>
            </div>
          )}
        </>
      )}
    </div>
  );
}
