import { useCallback, useEffect, useState } from "react";
import { api } from "./api.js";
import AdminProctorPanel from "./AdminProctorPanel.jsx";

const STATUS_OPTIONS = [
  ["submitted,in_review", "Awaiting review"],
  ["approved", "Approved"],
  ["rejected", "Rejected"],
  ["redo_requested", "Redo requested"],
  ["expired", "Expired"],
];

const SOURCE_LABEL = {
  opening: "Opening",
  follow_up: "Follow-up",
  company_custom: "Company question",
};

function stamp(value) {
  return value ? new Date(Number(value) * 1000).toLocaleString() : "—";
}

function duration(ms) {
  if (!ms) return "—";
  const seconds = Math.round(Number(ms) / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/**
 * Admin human-review queue for Voice AI interviews.
 *
 * The reviewer edits transcript typos, adds an optional 1–5 mark and note, then
 * approves (releases to the company), requests one redo, or rejects with a
 * reason. Nothing here is automatic and no AI score exists.
 */
export default function AdminInterviews() {
  const [statusFilter, setStatusFilter] = useState(STATUS_OPTIONS[0][0]);
  const [items, setItems] = useState([]);
  const [queueStatus, setQueueStatus] = useState("loading");
  const [queueError, setQueueError] = useState("");
  const [selectedId, setSelectedId] = useState("");
  const [detail, setDetail] = useState(null);
  const [detailStatus, setDetailStatus] = useState("idle");
  const [detailError, setDetailError] = useState("");
  const [drafts, setDrafts] = useState({});
  const [turnBusy, setTurnBusy] = useState("");
  const [decisionNote, setDecisionNote] = useState("");
  const [decisionBusy, setDecisionBusy] = useState("");
  const [notice, setNotice] = useState("");
  const [tab, setTab] = useState("interview");

  const loadQueue = useCallback(async () => {
    setQueueStatus("loading");
    setQueueError("");
    try {
      const data = await api(`/admin/interviews?status=${encodeURIComponent(statusFilter)}`);
      setItems(Array.isArray(data?.items) ? data.items : []);
      setQueueStatus("ready");
    } catch (e) {
      setQueueError(e?.message || "The review queue could not be loaded.");
      setQueueStatus("error");
    }
  }, [statusFilter]);

  useEffect(() => {
    loadQueue();
  }, [loadQueue]);

  const loadDetail = useCallback(async (inviteId) => {
    if (!inviteId) {
      setDetail(null);
      return;
    }
    setDetailStatus("loading");
    setDetailError("");
    try {
      const data = await api(`/admin/interviews/${inviteId}`);
      setDetail(data);
      setDecisionNote("");
      setDrafts(
        Object.fromEntries(
          (data.turns || []).map((turn) => [
            turn.turn_id,
            {
              transcript: turn.transcript || "",
              mark: turn.mark == null ? "" : String(turn.mark),
              note: turn.note || "",
            },
          ]),
        ),
      );
      setDetailStatus("ready");
    } catch (e) {
      setDetailError(e?.message || "This interview could not be loaded.");
      setDetailStatus("error");
    }
  }, []);

  const select = (inviteId) => {
    setSelectedId(inviteId);
    setNotice("");
    setTab("interview");
    loadDetail(inviteId);
  };


  const saveTurn = async (turn) => {
    const draft = drafts[turn.turn_id];
    if (!draft) return;
    setTurnBusy(turn.turn_id);
    setNotice("");
    try {
      await api(`/admin/interviews/${selectedId}/turns/${turn.turn_id}`, {
        method: "PATCH",
        body: {
          transcript: draft.transcript,
          ...(draft.mark ? { mark: Number(draft.mark) } : {}),
          note: draft.note,
        },
      });
      setNotice(`Turn ${turn.turn_no} saved. The original transcript is kept.`);
      await loadDetail(selectedId);
    } catch (e) {
      setDetailError(e?.message || "The turn could not be saved.");
    } finally {
      setTurnBusy("");
    }
  };

  const decide = async (decision) => {
    if (decisionBusy) return;
    const note = decisionNote.trim();
    if ((decision === "redo" || decision === "reject") && note.length < 3) {
      setDetailError("A short reason is required for a redo or rejection.");
      return;
    }
    const verb = decision === "approve" ? "release the results to the company" : decision === "redo" ? "issue one new interview invitation" : "reject this interview";
    if (!window.confirm(`Are you sure you want to ${verb}?`)) return;
    setDecisionBusy(decision);
    setDetailError("");
    setNotice("");
    try {
      const send = (confirmAppeals) => api(`/admin/interviews/${selectedId}/decision`, {
        method: "POST",
        body: { decision, note, confirm_appeals: Boolean(confirmAppeals) },
      });
      let result;
      try {
        result = await send(false);
      } catch (first) {
        if (decision === "approve" && first?.status === 409
            && String(first?.message || "").includes("unresolved_appeals")) {
          const proceed = window.confirm(
            "This interview has unresolved flag appeals. Approve and release anyway? "
            + "The appeal text and your decision are kept in the audit trail.",
          );
          if (!proceed) {
            setDecisionBusy("");
            return;
          }
          result = await send(true);
        } else {
          throw first;
        }
      }
      setNotice(
        decision === "approve"
          ? "Approved. The company can now read the reviewed answers."
          : decision === "redo"
            ? `Redo requested. New invitation ${result.new_invite_id}.`
            : "Rejected. The reason was recorded in the audit trail.",
      );
      setDecisionNote("");
      await loadQueue();
      await loadDetail(selectedId);
    } catch (e) {
      setDetailError(e?.message || "The decision could not be saved.");
    } finally {
      setDecisionBusy("");
    }
  };

  const turnDraft = (turn) => drafts[turn.turn_id] || { transcript: "", mark: "", note: "" };
  const editable = detail && ["submitted", "in_review"].includes(detail.status);

  return (
    <div className="ai-review">
      <div className="cr-page-heading">
        <div>
          <div className="cr-kicker">Human review gate</div>
          <h1>Voice AI interviews</h1>
          <p>
            Read the questions and transcripts, correct transcription typos and add optional
            human marks. The company sees nothing until you approve.
          </p>
        </div>
      </div>

      {notice && (
        <p className="success-note" role="status">
          {notice}
        </p>
      )}

      <div className="ai-review-layout">
        <section className="cr-panel ai-review-queue" aria-label="Interview review queue">
          <div className="cr-panel-head">
            <div>
              <h2>Queue</h2>
              <p>{items.length} interviews</p>
            </div>
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              aria-label="Filter by status"
            >
              {STATUS_OPTIONS.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </div>
          {queueStatus === "loading" && <p className="cr-footnote">Loading…</p>}
          {queueError && (
            <p className="ci-error" role="alert">
              {queueError}
            </p>
          )}
          {queueStatus === "ready" && !items.length && (
            <p className="cr-muted-box">No interviews in this queue.</p>
          )}
          <ul className="ai-review-list">
            {items.map((row) => (
              <li key={row.invite_id}>
                <button
                  type="button"
                  className={selectedId === row.invite_id ? "active" : ""}
                  onClick={() => select(row.invite_id)}
                >
                  <span>
                    <strong>{row.candidate_name}</strong>
                    <small>
                      {row.job_title} · {row.company_name}
                    </small>
                  </span>
                  <span className="ai-review-list-meta">
                    <span>{row.answered}/{row.asked} answered</span>
                    <small>{stamp(row.submitted_at)}</small>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>

        <section className="cr-panel ai-review-detail" aria-live="polite">
          {!selectedId && <p className="cr-muted-box">Select an interview from the queue.</p>}
          {selectedId && detailStatus === "loading" && <p className="cr-footnote">Loading interview…</p>}
          {selectedId && detailStatus === "error" && (
            <p className="ci-error" role="alert">
              {detailError}
            </p>
          )}

          {detail && detailStatus === "ready" && (
            <>
              <header className="ai-review-detail-head">
                <div>
                  <h2>{detail.candidate_name}</h2>
                  <p>
                    {detail.job_title} · {detail.company_name} ·{" "}
                    {detail.language === "bn-BD" ? "বাংলা" : "English"}
                  </p>
                  <p className="cr-footnote">
                    Submitted {stamp(detail.submitted_at)} · {detail.turns.length} turns ·
                    audio mode: {String(detail.audio_mode).replaceAll("_", " ")}
                  </p>
                </div>
                <span
                  className={
                    "status-pill " +
                    (detail.status === "approved"
                      ? "status-valid"
                      : detail.status === "rejected"
                        ? "status-invalid"
                        : "status-review")
                  }
                >
                  {String(detail.status).replaceAll("_", " ")}
                </span>
              </header>

              <div className="ai-review-tabs" role="tablist" aria-label="Review sections">
                <button type="button" role="tab" aria-selected={tab === "interview"}
                        className={tab === "interview" ? "active" : ""}
                        onClick={() => setTab("interview")}>
                  Interview
                </button>
                <button type="button" role="tab" aria-selected={tab === "proctor"}
                        className={tab === "proctor" ? "active" : ""}
                        onClick={() => setTab("proctor")}>
                  Proctoring
                </button>
              </div>

              {tab === "proctor" && (
                <AdminProctorPanel inviteId={selectedId} onNotice={setNotice} />
              )}

              {tab === "interview" && (
                <>
              {detailError && (
                <p className="ci-error" role="alert">
                  {detailError}
                </p>
              )}

              <ol className="ai-review-turns">
                {detail.turns.map((turn) => {
                  const draft = turnDraft(turn);
                  const answered = Boolean(turn.answered_at);
                  return (
                    <li key={turn.turn_id} className="ai-review-turn">
                      <div className="ai-review-turn-head">
                        <strong>Q{turn.turn_no}</strong>
                        <span className="ci-source">
                          {SOURCE_LABEL[turn.source] || String(turn.source).replaceAll("_", " ")}
                        </span>
                        <span className="cr-footnote">
                          Asked {stamp(turn.asked_at)} · Answered {stamp(turn.answered_at)} ·{" "}
                          {duration(turn.audio_ms)}
                        </span>
                      </div>
                      <p className="ci-question">{turn.question}</p>

                      {!answered ? (
                        <p className="cr-muted-box">The candidate did not answer this question.</p>
                      ) : (
                        <>
                          <label className="ai-review-field">
                            Transcript
                            <textarea
                              rows="4"
                              value={draft.transcript}
                              onChange={(e) =>
                                setDrafts((current) => ({
                                  ...current,
                                  [turn.turn_id]: { ...draft, transcript: e.target.value },
                                }))
                              }
                            />
                          </label>
                          {turn.original_transcript &&
                            turn.original_transcript !== draft.transcript && (
                              <details className="ai-review-original">
                                <summary>Original transcript (kept)</summary>
                                <p>{turn.original_transcript}</p>
                              </details>
                            )}
                          <div className="ai-review-mark-row">
                            <label>
                              Human mark (optional)
                              <select
                                value={draft.mark}
                                onChange={(e) =>
                                  setDrafts((current) => ({
                                    ...current,
                                    [turn.turn_id]: { ...draft, mark: e.target.value },
                                  }))
                                }
                              >
                                <option value="">No mark</option>
                                {[1, 2, 3, 4, 5].map((value) => (
                                  <option key={value} value={value}>
                                    {value} / 5
                                  </option>
                                ))}
                              </select>
                            </label>
                            <label className="ai-review-note">
                              Reviewer note
                              <input
                                value={draft.note}
                                maxLength={2000}
                                onChange={(e) =>
                                  setDrafts((current) => ({
                                    ...current,
                                    [turn.turn_id]: { ...draft, note: e.target.value },
                                  }))
                                }
                              />
                            </label>
                            <button
                              type="button"
                              className="cr-outline-btn"
                              disabled={!editable || turnBusy === turn.turn_id}
                              onClick={() => saveTurn(turn)}
                            >
                              {turnBusy === turn.turn_id ? "Saving…" : "Save turn"}
                            </button>
                          </div>
                        </>
                      )}

                      {turn.audio_url ? (
                        <audio controls preload="none" src={turn.audio_url} className="ci-audio">
                          Your browser cannot play this audio.
                        </audio>
                      ) : (
                        <p className="cr-footnote">
                          {detail.audio_mode === "stored"
                            ? "Audio is no longer available for this answer."
                            : "Transcript-only deployment: no audio was stored."}
                        </p>
                      )}
                    </li>
                  );
                })}
              </ol>

              {editable ? (
                <div className="ai-review-decision">
                  <h3>Review decision</h3>
                  <p className="cr-footnote">
                    Approve releases the Q/A pairs, your marks and notes to the company. A redo
                    is allowed once. No score is generated by AI.
                  </p>
                  <label>
                    Reason / note (required for redo or reject)
                    <textarea
                      rows="3"
                      value={decisionNote}
                      maxLength={3000}
                      onChange={(e) => setDecisionNote(e.target.value)}
                    />
                  </label>
                  <div className="ai-review-actions">
                    <button
                      type="button"
                      className="btn"
                      disabled={Boolean(decisionBusy)}
                      onClick={() => decide("approve")}
                    >
                      {decisionBusy === "approve" ? "Approving…" : "Approve & release"}
                    </button>
                    <button
                      type="button"
                      className="btn ghost"
                      disabled={Boolean(decisionBusy)}
                      onClick={() => decide("redo")}
                    >
                      {decisionBusy === "redo" ? "Saving…" : "Request redo"}
                    </button>
                    <button
                      type="button"
                      className="btn danger"
                      disabled={Boolean(decisionBusy)}
                      onClick={() => decide("reject")}
                    >
                      {decisionBusy === "reject" ? "Saving…" : "Reject"}
                    </button>
                  </div>
                </div>
              ) : (
                <div className="ai-review-decision">
                  <h3>Decision history</h3>
                  {(detail.reviews || []).length ? (
                    <ul className="ai-review-history">
                      {detail.reviews.map((review, index) => (
                        <li key={index}>
                          <strong>{String(review.decision).replaceAll("_", " ")}</strong>
                          <span>{stamp(review.created_at)}</span>
                          {review.note && <p>{review.note}</p>}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="cr-footnote">No decision recorded.</p>
                  )}
                </div>
              )}
                </>
              )}
            </>
          )}
        </section>
      </div>
    </div>
  );
}
