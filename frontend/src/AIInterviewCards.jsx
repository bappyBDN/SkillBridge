import { useCallback, useEffect, useState } from "react";
import { api } from "./api.js";
import { canStartInterview, deadlineRemaining, formatRemaining } from "./interviewMachine.js";

const STATUS_LABEL = {
  invited: "Not started",
  in_progress: "In progress",
  submitted: "Awaiting human review",
  in_review: "Awaiting human review",
  approved: "Review complete",
  rejected: "Not selected",
  redo_requested: "Redo requested",
  expired: "Expired",
};

function statusTone(status) {
  if (status === "approved") return "valid";
  if (status === "rejected" || status === "expired") return "invalid";
  if (status === "submitted" || status === "in_review" || status === "redo_requested") {
    return "review";
  }
  return "review";
}

/**
 * Candidate "AI Interview" cards for the Assessments page.
 *
 * Shows the company, job, deadline countdown and Start/Resume. The server owns
 * status and consent; nothing is scored here.
 */
export default function AIInterviewCards({ onOpen, refreshKey = 0 }) {
  const [items, setItems] = useState([]);
  const [status, setStatus] = useState("loading");
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(async () => {
    try {
      const result = await api("/interviews");
      setItems(Array.isArray(result?.items) ? result.items : []);
      setStatus("ready");
    } catch (error) {
      if (error?.status === 404 || error?.status === 405) {
        setItems([]);
        setStatus("unavailable");
      } else {
        setStatus("error");
      }
    }
  }, []);

  useEffect(() => {
    load();
  }, [load, refreshKey]);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  if (status === "unavailable" || !items.length) return null;

  return (
    <section className="ai-invites" aria-labelledby="ai-invites-title">
      <div className="section-toolbar">
        <div>
          <h2 id="ai-invites-title">AI interviews</h2>
          <p>
            Spoken interviews requested by a company. The AI only asks questions; a person
            reviews everything before the company sees it.
          </p>
        </div>
        {status === "error" && (
          <button type="button" className="btn ghost sm" onClick={load}>
            Retry
          </button>
        )}
      </div>
      <div className="ai-invite-grid">
        {items.map((invite) => {
          const remaining = deadlineRemaining(invite.deadline_at, now);
          const open = canStartInterview(invite, now);
          const label = STATUS_LABEL[invite.status] || invite.status;
          const actionable =
            invite.status === "in_progress" ? "Resume interview" : "Start interview";
          return (
            <article className="ai-invite-card" key={invite.invite_id}>
              <div className="ai-invite-top">
                <span className="ai-invite-logo" aria-hidden="true">
                  AI
                </span>
                <div>
                  <h3>{invite.job_title || "Interview"}</h3>
                  <p>{invite.company_name || "Company"}</p>
                </div>
                <span className={`status-pill status-${statusTone(invite.status)}`}>{label}</span>
              </div>
              <dl className="ai-invite-meta">
                <div>
                  <dt>Language</dt>
                  <dd>{invite.language === "bn-BD" ? "বাংলা" : "English"}</dd>
                </div>
                <div>
                  <dt>Questions</dt>
                  <dd>
                    {invite.asked || 0} of {invite.max_questions}
                  </dd>
                </div>
                <div>
                  <dt>Time left</dt>
                  <dd className={remaining > 0 ? "" : "expired"}>
                    {formatRemaining(remaining)}
                  </dd>
                </div>
              </dl>
              {invite.status === "submitted" || invite.status === "in_review" ? (
                <p className="ai-invite-note">
                  Your answers are waiting for a human reviewer. No AI score exists.
                </p>
              ) : invite.status === "approved" ? (
                <p className="ai-invite-note">The company can now read your interview.</p>
              ) : invite.status === "expired" ? (
                <p className="ai-invite-note">
                  The deadline passed. Answers you already submitted are kept for review.
                </p>
              ) : (
                <p className="ai-invite-note">
                  You can pause between questions and resume until the deadline.
                </p>
              )}
              <div className="ai-invite-actions">
                {open ? (
                  <button type="button" className="btn sm" onClick={() => onOpen?.(invite)}>
                    {invite.consent_required ? "Review & start" : actionable}
                  </button>
                ) : (
                  <button type="button" className="btn ghost sm" onClick={() => onOpen?.(invite)}>
                    View details
                  </button>
                )}
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}
