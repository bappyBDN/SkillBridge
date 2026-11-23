const STAGES = {
  in_progress: "Assessment in progress",
  evaluation_pending: "Response drafts await academic review",
  academic_review: "Awaiting academic approval",
  honesty_review: "Awaiting honesty approval",
  published: "Reviewed result published",
  invalidated: "Result withdrawn by a reviewer",
};

export default function AssessmentStatus({ publication, objective, onRefresh }) {
  if (!publication) return null;
  const steps = [
    ["Response evaluation", publication.pending_evaluations === 0, publication.pending_evaluations ? `${publication.pending_evaluations} response marks await approval` : "Stored-key and rubric checks complete"],
    ["Academic review", publication.academic_status === "approved", publication.academic_status?.replaceAll("_", " ") || "pending"],
    ["Honesty review", publication.honesty_status === "approved", publication.honesty_status || "pending"],
    ["Learning & passport", publication.ready, publication.ready ? "Released together" : "Locked until both approvals"],
  ];
  return <section className={`assessment-status ${publication.ready ? "is-ready" : "is-pending"}`} aria-label="Assessment review progress">
    <div className="assessment-status-head"><div><small>Assessment workflow</small><h3>{STAGES[publication.stage] || "Review in progress"}</h3></div>{onRefresh && <button type="button" className="btn ghost sm" onClick={onRefresh}>Refresh status</button>}</div>
    {!publication.ready && <p>Objective questions are checked immediately. Topic percentages, personalized courses and the Skill Passport are published only after all response marks and the honesty report are approved.</p>}
    {objective?.mcq_questions > 0 && !publication.ready && <div className="assessment-objective"><strong>{objective.mcq_score ?? "—"}%</strong><span>MCQ-only score · {objective.mcq_questions} questions<br /><small>Provisional feedback, not your final assessment score.</small></span></div>}
    <ol>{steps.map(([label, done, detail]) => <li key={label} className={done ? "done" : "waiting"}><span aria-hidden="true">{done ? "✓" : "○"}</span><div><b>{label}</b><small>{detail}</small></div></li>)}</ol>
    {publication.honesty && <p className="assessment-honesty-note">Honesty review: <b>{publication.honesty.status === "approved" ? `${publication.honesty.score}/100 · reviewed` : "pending human approval"}</b>. This advisory measure is separate from technical marks and is not an automatic cheating verdict.</p>}
  </section>;
}
