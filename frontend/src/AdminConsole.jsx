import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api.js";
import { useSetLang, useLangValue } from "./i18n.js";
import SecurityPanel from "./SecurityPanel.jsx";
import { useConsoleT } from "./consoleI18n.js";
import { CvPreview, WorkspaceIcon, WorkspaceLoading, WorkspaceSearch } from "./WorkspaceUI.jsx";
import AssessmentStatus from "./AssessmentStatus.jsx";
import { sentenceCase, statusTone } from "./status.js";
import { EvidenceImage } from "./AdminEvidence.jsx";
import { NotificationBell } from "./NotificationCenter.jsx";
import { fmt } from "./format.js";

// Heavy, rarely opened panels load on demand.
const AgentConsole = lazy(() => import("./AgentConsole.jsx"));
const AiUsagePanel = lazy(() => import("./AiUsagePanel.jsx"));

/* ---------- platform administration ---------- */
/** Open an authenticated PDF in a new tab (the API requires the bearer token). */
async function openAuthedPdf(url) {
  // Reserve the tab during the user gesture, before fetching authenticated bytes.
  const tab = window.open("about:blank", "_blank");
  if (tab) tab.opener = null;
  try {
    const blob = await api(url, { responseType: "blob" });
    const objectUrl = URL.createObjectURL(blob);
    if (tab) tab.location.replace(objectUrl);
    else {
      URL.revokeObjectURL(objectUrl);
      throw new Error("Your browser blocked the PDF tab. Allow pop-ups for this site, or use the CV preview download.");
    }
    setTimeout(() => URL.revokeObjectURL(objectUrl), 60000);
  } catch (e) {
    tab?.close();
    alert(e.message || "Could not open that file.");
  }
}

function CandidateDetailModal({ userId, onClose }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const dialog = useRef(null);
  useEffect(() => { dialog.current?.showModal(); }, []);

  useEffect(() => {
    let alive = true;
    api(`/admin/candidates/${userId}`)
      .then((result) => alive && setData(result))
      .catch((e) => alive && setError(e.message || "Could not load this candidate."));
    return () => {
      alive = false;
    };
  }, [userId]);

  const when = (value) => (value ? new Date(value * 1000).toLocaleString() : "—");

  return (
    <dialog ref={dialog} className="ws-candidate-dialog" aria-labelledby="candidate-record-title" onCancel={onClose} onClick={(event) => { if (event.target === dialog.current) onClose(); }}>
      <div className="ad-candidate-modal">
        <header>
          <div>
            <div className="ad-eyebrow">Candidate record</div>
            <h2 id="candidate-record-title">{data?.user?.name || "Loading…"}</h2>
            <p>{data?.user?.email}</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close candidate record">×</button>
        </header>
        {error && <div className="ad-error" role="alert">{error}</div>}
        {data && (
          <div className="ad-candidate-body">
            <section>
              <h3>CV on file</h3>
              {data.cv?.has_pdf ? (
                <CvPreview url={data.cv.pdf_url} filename={data.cv.filename} />
              ) : (
                <p className="muted">No CV uploaded yet.</p>
              )}
              {data.cv?.documents?.length > 1 && (
                <ul className="ad-doc-list">
                  {data.cv.documents.slice(1).map((doc) => (
                    <li key={doc.id}>
                      {doc.filename} · {when(doc.created)}
                      <button
                        className="btn ghost sm"
                        onClick={() =>
                          openAuthedPdf(`/admin/candidates/${userId}/cv?document_id=${doc.id}`)
                        }
                      >
                        Open
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section>
              <h3>Profile</h3>
              {data.profile ? (
                <dl className="ad-dl">
                  <dt>Headline</dt><dd>{data.profile.headline || "—"}</dd>
                  <dt>Location</dt><dd>{data.profile.location || "—"}</dd>
                  <dt>Phone</dt><dd>{data.profile.phone || "—"}</dd>
                  <dt>Summary</dt><dd>{data.profile.summary || "—"}</dd>
                  <dt>Skills</dt>
                  <dd>
                    {(data.profile.skills || []).map((s) => (typeof s === "string" ? s : s.name)).join(", ") || "—"}
                  </dd>
                </dl>
              ) : (
                <p className="muted">
                  No structured profile yet. CV-extracted skills:{" "}
                  {(data.journey?.extracted || []).map((s) => s.name).join(", ") || "—"}
                </p>
              )}
            </section>

            <section>
              <h3>Assessments</h3>
              {data.attempts.length ? (
                <table className="ad-table">
                  <thead>
                    <tr><th>Kind</th><th>Score</th><th>Level</th><th>Trust</th><th>Finished</th></tr>
                  </thead>
                  <tbody>
                    {data.attempts.map((a) => (
                      <tr key={a.attempt_id}>
                        <td>{a.kind}</td>
                        <td>{a.overall ?? "—"}</td>
                        <td>{a.level || "—"}</td>
                        <td>{a.trust || "—"}</td>
                        <td>{when(a.finished)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <p className="muted">No assessment attempts yet.</p>
              )}
            </section>

            <section>
              <h3>Skill Passport</h3>
              {data.passports.length ? (
                data.passports.map((passport) => (
                  <div className="ad-passport" key={passport.pid}>
                    <strong>{passport.holder || data.user.name}</strong>
                    <small>
                      Issued {passport.issued} · expires {passport.expires}
                      {passport.revoked ? " · revoked" : ""}
                    </small>
                    <div className="cr-tags">
                      {(passport.skills || []).map((s) => (
                        <span key={s.skill}>
                          {s.name} · {s.score}%
                        </span>
                      ))}
                    </div>
                    <a href={passport.public_url} target="_blank" rel="noreferrer">
                      Open public passport ↗
                    </a>
                  </div>
                ))
              ) : (
                <p className="muted">No passport issued yet.</p>
              )}
            </section>

            <section>
              <h3>Applications</h3>
              {data.applications.length ? (
                <ul className="ad-doc-list">
                  {data.applications.map((a) => (
                    <li key={a.id}>
                      {a.job_title} · {a.company_name} · {a.status}
                      {a.results_shared ? " · results shared" : ""}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="muted">No applications yet.</p>
              )}
            </section>
          </div>
        )}
      </div>
    </dialog>
  );
}

function IdentityReviewQueue({ A, onFlash, onError }) {
  const I = A.identity;
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState("");
  const [notes, setNotes] = useState({});
  const [filter, setFilter] = useState("all");
  const [search, setSearch] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await api("/admin/identity-reviews");
      setItems(result.items || []);
    } catch (e) {
      onError?.(e.message || "Could not load identity reviews.");
    } finally {
      setLoading(false);
    }
  }, [onError]);

  useEffect(() => {
    load();
  }, [load]);

  const decide = async (id, decision) => {
    setBusyId(id);
    try {
      await api("/admin/identity-reviews/" + encodeURIComponent(id) + "/decision", {
        method: "POST",
        body: { decision, note: notes[id] || "" },
      });
      onFlash?.(I.decided);
      await load();
    } catch (e) {
      onError?.(e.message || "Could not save that decision.");
    } finally {
      setBusyId("");
    }
  };

  const signalLabel = (value) => I.signals[value] || value || "—";
  const counts = {
    all: items.length,
    open: items.filter((x) => x.status === "open").length,
    cleared: items.filter((x) => x.status === "cleared").length,
    needs_review: items.filter((x) => x.status === "needs_review").length,
    escalated: items.filter((x) => x.status === "escalated").length,
    superseded: items.filter((x) => x.status === "superseded").length,
  };
  const query = search.trim().toLowerCase();
  const visible = items.filter((item) => {
    if (filter !== "all" && item.status !== filter) return false;
    if (!query) return true;
    const signal = item.signal || {};
    return [item.account_name, item.account_email, signal.cv_name]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(query));
  });
  const filters = [
    ["all", I.filters.all, counts.all],
    ["open", I.filters.open, counts.open],
    ["cleared", I.filters.cleared, counts.cleared],
    ["needs_review", I.filters.needsReview, counts.needs_review],
    ["escalated", I.filters.escalated, counts.escalated],
    ["superseded", I.filters.superseded, counts.superseded],
  ];
  const reasonText = (signal) => (signal.reasons || [])
    .map((reason) => I.reasons[reason] || reason)
    .join(" · ");

  return (
    <section className="ad-panel">
      <div className="ad-panel-head">
        <div>
          <h2>{I.title}</h2>
          <p>{I.subtitle}</p>
        </div>
        <span className="ad-count">
          {counts.open} {I.statuses.open} · {counts.all} {I.total}
        </span>
        <button type="button" className="ad-mini-primary" onClick={load} disabled={loading}>
          ↻ {I.refresh}
        </button>
      </div>
      <div className="ad-toolbar">
        <input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder={I.searchPlaceholder}
          aria-label={I.searchPlaceholder}
        />
        <select
          className="ad-role-select"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          aria-label={I.filterLabel}
        >
          {filters.map(([id, label, count]) => (
            <option key={id} value={id}>{label} ({count})</option>
          ))}
        </select>
      </div>
      {loading ? (
        <div className="ad-loading">{A.loading || "Loading…"}</div>
      ) : (
        <div className="ad-table-wrap">
          <table className="ad-table">
            <thead>
              <tr>
                <th>{I.account}</th>
                <th>{I.cvName}</th>
                <th>{I.status}</th>
                <th>{I.submitted}</th>
                <th>{I.decision}</th>
                <th>{I.actions}</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((item) => {
                const signal = item.signal || {};
                const pending = item.status === "open" || item.status === "needs_review";
                const detected = item.created
                  ? new Date(item.created * 1000).toLocaleString()
                  : "—";
                const decided = item.reviewed_at
                  ? new Date(item.reviewed_at * 1000).toLocaleString()
                  : "";
                return (
                  <tr key={item.id}>
                    <td>
                      <b>{item.account_name}</b>
                      <small>{item.account_email}</small>
                      <small>ID {item.user_id}</small>
                    </td>
                    <td>
                      {signal.cv_name || "—"}
                      <small>{signal.confirmed ? I.candidateConfirmed : I.notConfirmed}</small>
                    </td>
                    <td>
                      <span className={"ad-pill " + (signal.status || "")}>
                        {signalLabel(signal.status)}
                      </span>
                      <small>
                        {I.emailMatch}: {signal.email_match ? A.yes : A.no} · {I.similarity}:{" "}
                        {typeof signal.score === "number"
                          ? Math.round(signal.score * 100) + "%"
                          : "—"}
                      </small>
                      {reasonText(signal) && <small>{reasonText(signal)}</small>}
                    </td>
                    <td>{detected}</td>
                    <td>
                      <b>{I.statuses[item.status] || item.status}</b>
                      {item.reviewed_at && (
                        <small>
                          {I.decidedBy}: {item.reviewed_by_name || "—"} · {decided}
                        </small>
                      )}
                      {item.note && <small>{item.note}</small>}
                    </td>
                    <td>
                      {pending ? (
                        <div className="ad-identity-actions">
                          <input
                            value={notes[item.id] || ""}
                            onChange={(event) =>
                              setNotes((current) => ({ ...current, [item.id]: event.target.value }))
                            }
                            placeholder={I.notePlaceholder}
                          />
                          <div className="row">
                            <button
                              type="button"
                              className="btn sm"
                              disabled={busyId === item.id}
                              onClick={() => decide(item.id, "cleared")}
                            >
                              {I.clear}
                            </button>
                            <button
                              type="button"
                              className="btn ghost sm"
                              disabled={busyId === item.id}
                              onClick={() => decide(item.id, "needs_review")}
                            >
                              {I.review}
                            </button>
                            <button
                              type="button"
                              className="btn ghost sm"
                              disabled={busyId === item.id}
                              onClick={() => decide(item.id, "escalated")}
                            >
                              {I.escalate}
                            </button>
                          </div>
                        </div>
                      ) : (
                        <span className="muted">{I.noAction}</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {!visible.length && (
            <div className="ad-empty">{items.length ? I.emptyFiltered : I.empty}</div>
          )}
        </div>
      )}
    </section>
  );
}

const ADMIN_PAGE_SIZE = 100;
const ADMIN_PAGED_ENDPOINTS = {
  users: "/admin/console/users",
  assessments: "/admin/assessment-reviews",
  integrity: "/admin/integrity/attempts",
  appeals: "/admin/appeals",
};

export default function AdminConsole({ onLogout }) {
  const C = useConsoleT();
  const A = C.admin;
  const lang = useLangValue();
  const setLang = useSetLang();
  const [page, setPage] = useState("overview");
  const [adminRole, setAdminRole] = useState("super_admin");
  const [data, setData] = useState({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const [action, setAction] = useState(null);
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [adminDraft, setAdminDraft] = useState({
    name: "",
    email: "",
    password: "",
    admin_role: "support_agent",
  });
  const [creatingAdmin, setCreatingAdmin] = useState(false);
  const [adminEmail, setAdminEmail] = useState("");
  const [adminId, setAdminId] = useState(null);
  const [candidateView, setCandidateView] = useState(null);
  const [integrityDetail, setIntegrityDetail] = useState(null),
    [integrityLoading, setIntegrityLoading] = useState(false);
  const [honestyDraft, setHonestyDraft] = useState({ score: "", reason: "" });
  const [honestyBusy, setHonestyBusy] = useState(false);
  const [honestyError, setHonestyError] = useState("");
  const [integrityStatus, setIntegrityStatus] = useState("all"),
    [integrityKind, setIntegrityKind] = useState("all"),
    [integrityTrust, setIntegrityTrust] = useState("all");
  const [selectedReport, setSelectedReport] = useState(null);
  const [reportEvaluations, setReportEvaluations] = useState({});
  const [evaluationBusy, setEvaluationBusy] = useState(false);
  const [evaluationError, setEvaluationError] = useState("");
  const [questionCategory, setQuestionCategory] = useState("all"),
    [questionQuery, setQuestionQuery] = useState(""),
    [questionStatus, setQuestionStatus] = useState("all");
  const [questionModal, setQuestionModal] = useState(false),
    [questionEditing, setQuestionEditing] = useState(null),
    [questionSaving, setQuestionSaving] = useState(false);
  const [questionDraft, setQuestionDraft] = useState({
    category_id: "CAT-01",
    subcategory: "",
    question_type: "MCQ",
    difficulty_level: "Medium",
    question_text: "",
    options: "",
    correct_answer: "",
    explanation: "",
    reference_answer: "",
    grading_rubric: "",
    marks: 2,
    time_minutes: 2,
    status: "draft",
  });
  const [importFile, setImportFile] = useState(null),
    [importCategory, setImportCategory] = useState(""),
    [importPreview, setImportPreview] = useState(null),
    [importResult, setImportResult] = useState(null),
    [importBusy, setImportBusy] = useState(false);
  const [scrapeUrl, setScrapeUrl] = useState(""),
    [scrapeHtml, setScrapeHtml] = useState(""),
    [scrapeMode, setScrapeMode] = useState("url"),
    [scrapeCategory, setScrapeCategory] = useState(""),
    [scrapeNewCategory, setScrapeNewCategory] = useState(""),
    [scrapeSubcategory, setScrapeSubcategory] = useState(""),
    [scrapeBusy, setScrapeBusy] = useState(false);
  const [categoryDraft, setCategoryDraft] = useState(""),
    [categoryBusy, setCategoryBusy] = useState(false);
  const [stagingSelected, setStagingSelected] = useState({}),
    [stagingBusy, setStagingBusy] = useState(false);
  const nav = [
    ["overview", A.nav.overview, "overview"],
    ["users", A.nav.users, "team"],
    ["staff", A.nav.staff, "staff"],
    ["companies", A.nav.companies, "building"],
    ["jobs", A.nav.jobs, "jobs"],
    ["assessments", A.nav.assessments, "exams"],
    ["integrity", A.nav.integrity, "integrity"],
    ["identity", A.nav.identity, "identity"],
    ["appeals", A.nav.appeals, "appeals"],
    ["questions", A.nav.questions, "questions"],
    ["learning", A.nav.learning, "learning"],
    ["ai", A.nav.ai, "ai"],
    ["agent", "AI Agents", "agent"],
    ["billing", A.nav.billing, "billing"],
    ["privacy", A.nav.privacy, "privacy"],
    ["quality", A.nav.quality, "quality"],
    ["audit", A.nav.audit, "audit"],
    ["security", A.nav.security, "security"],
  ];
  const load = async () => {
    setBusy(true);
    setError("");
    try {
      const me = await api("/admin/console/me");
      // A staff account without a role must not fall back to super admin.
      setAdminRole(me.admin_role ?? null);
      setAdminId(me.user_id ?? null);
      if (!adminEmail) {
        api("/enterprise/me")
          .then((identity) => setAdminEmail(identity?.user?.email || ""))
          .catch(() => {});
      }
    } catch (x) {
      setError(x.message || "Admin identity unavailable");
      setBusy(false);
      return;
    }
    const endpoints = {
      overview: "/admin/console/overview",
      users: `/admin/console/users?limit=${ADMIN_PAGE_SIZE}&offset=0`,
      staff: "/admin/console/staff",
      companies: "/admin/console/company-verifications",
      jobs: "/admin/console/job-review-queue",
      assessments: `/admin/assessment-reviews?limit=${ADMIN_PAGE_SIZE}&offset=0`,
      integrity: `/admin/integrity/attempts?limit=${ADMIN_PAGE_SIZE}&offset=0`,
      appeals: `/admin/appeals?limit=${ADMIN_PAGE_SIZE}&offset=0`,
      questions: "/admin/questions",
      graphrag: "/admin/assessment/graphrag/status",
      staging: "/admin/questions/staging",
      learning: "/admin/learning",
      ai: "/admin/ai-operations",
      billing: "/admin/billing",
      privacy: "/admin/privacy",
      quality: "/admin/quality",
      audit: "/admin/audit-logs",
      phaseTwo: "/admin/phase-two-requests",
    };
    const keys = Object.keys(endpoints);
    const results = await Promise.allSettled(
      keys.map((k) => api(endpoints[k])),
    );
    const next = {};
    results.forEach((r, i) => {
      if (r.status === "fulfilled") next[keys[i]] = r.value;
      else next[keys[i]] = { error: r.reason?.message || "Unavailable" };
    });
    setData(next);
    const failures = results.filter((r) => r.status === "rejected");
    if (failures.length === keys.length)
      setError(
        "Admin services could not be reached. Check your session and backend connection.",
      );
    setBusy(false);
  };
  useEffect(() => {
    load();
    // Load once on mount; later reloads are explicit (refresh button, actions).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const flash = (s) => {
    setToast(s);
    setError("");
  };
  const createAdmin = async (e) => {
    e.preventDefault();
    setCreatingAdmin(true);
    setError("");
    try {
      await api("/admin/console/staff", { method: "POST", body: adminDraft });
      setAdminDraft({
        name: "",
        email: "",
        password: "",
        admin_role: "support_agent",
      });
      await load();
      flash(
        "Admin account created. Share the credentials securely with the new admin.",
      );
    } catch (x) {
      setError(x.message || "Could not create admin account.");
    } finally {
      setCreatingAdmin(false);
    }
  };
  const revokeAdmin = async (staff) => {
    if (!window.confirm(
      `Revoke admin access for ${staff.name} (${staff.email})? ` +
      "Their account and history stay, but they lose every admin permission and are signed out.",
    )) return;
    setError("");
    try {
      await api(`/admin/console/staff/${staff.id}/revoke`, { method: "POST" });
      await load();
      flash(`Admin access revoked for ${staff.name}.`);
    } catch (x) {
      setError(x.message || "Could not revoke this admin.");
    }
  };
  const deleteAdmin = async (staff) => {
    if (!window.confirm(
      `Permanently delete ${staff.name} (${staff.email})? ` +
      "This removes the admin account and its linked data and cannot be undone.",
    )) return;
    setError("");
    try {
      await api(`/admin/console/staff/${staff.id}`, { method: "DELETE" });
      await load();
      flash(`Admin account deleted: ${staff.name}.`);
    } catch (x) {
      setError(x.message || "Could not delete this admin.");
    }
  };
  const syncEvaluationEdits = (report) => {
    const next = {};
    (report?.answer_evidence || []).forEach((q) => {
      if (!q.evaluation && !q.objective) return;
      next[q.question_id] = {
        marks:
          !q.evaluation ? (q.awarded_marks ?? 0) : q.evaluation.final_marks != null
            ? q.evaluation.final_marks
            : q.evaluation.ai_marks,
        admin_note: q.evaluation?.admin_note || "",
        additional_info: q.evaluation?.additional_info || "",
      };
    });
    setReportEvaluations(next);
  };
  const runEvaluation = async (report) => {
    if (!report) return;
    setEvaluationBusy(true);
    setEvaluationError("");
    try {
      const res = await api(
        "/admin/attempts/" + encodeURIComponent(report.id) + "/evaluate",
        { method: "POST", body: {} },
      );
      const byId = {};
      (res.items || []).forEach((item) => {
        byId[item.question_id] = item;
      });
      const merged = {
        ...report,
        evaluations: res.items || [],
        evaluation_summary: {
          ...(report.evaluation_summary || {}),
          llm_configured: res.llm_configured,
        },
        answer_evidence: (report.answer_evidence || []).map((q) => {
          const evaluation = byId[q.question_id] || q.evaluation;
          if (!evaluation) return q;
          return {
            ...q,
            evaluation,
            max_marks: evaluation.max_marks,
            ai_marks: evaluation.ai_marks,
            awarded_marks:
              evaluation.status === "approved"
                ? evaluation.final_marks
                : q.awarded_marks,
            evaluation_status: evaluation.status,
          };
        }),
      };
      setSelectedReport(merged);
      syncEvaluationEdits(merged);
      await load();
    } catch (x) {
      setEvaluationError(x.message || "Could not run the AI evaluation.");
    } finally {
      setEvaluationBusy(false);
    }
  };
  const openReport = (report) => {
    setSelectedReport(report);
    setEvaluationError("");
    syncEvaluationEdits(report);
  };
  const saveEvaluation = async (report, questionId) => {
    const edit = reportEvaluations[questionId];
    if (!edit) return;
    setEvaluationBusy(true);
    setEvaluationError("");
    try {
      const saved = await api(
        "/admin/attempts/" +
          encodeURIComponent(report.id) +
          "/evaluations/" +
          encodeURIComponent(questionId),
        {
          method: "PATCH",
          body: {
            question_id: questionId,
            marks: edit.marks === "" ? null : Number(edit.marks),
            admin_note: edit.admin_note || "",
            additional_info: edit.additional_info || "",
            status: "approved",
          },
        },
      );
      const merged = {
        ...report,
        answer_evidence: (report.answer_evidence || []).map((q) =>
          q.question_id === questionId
            ? {
                ...q,
                evaluation: saved,
                awarded_marks: saved.final_marks,
                evaluation_status: saved.status,
                review_status: "human_approved",
              }
            : q,
        ),
        evaluations: (report.evaluations || []).map((e) =>
          e.question_id === questionId ? saved : e,
        ),
      };
      const queue = await api("/admin/assessment-reviews");
      const currentReport = queue.items.find((item) => item.id === report.id) || merged;
      setSelectedReport(currentReport);
      syncEvaluationEdits(currentReport);
      flash("Mark saved. Approve the revised academic result to publish it; previous credentials are withdrawn when marks change.");
      await load();
    } catch (x) {
      setEvaluationError(x.message || "Could not save this evaluation.");
    } finally {
      setEvaluationBusy(false);
    }
  };
  const openAction = (kind, id, decision) => {
    setAction({ kind, id, decision });
    setReason("");
  };
  const openIntegrityDetail = async (id) => {
    setIntegrityLoading(true);
    setIntegrityDetail(null);
    setHonestyError("");
    try {
      const detail = await api(
        "/admin/integrity/attempts/" + encodeURIComponent(id),
      );
      setIntegrityDetail(detail);
      setHonestyDraft({
        score: String(detail.honesty?.score ?? ""),
        reason: detail.honesty?.reason || "",
      });
    } catch (x) {
      setError(x.message || "Could not load attempt details.");
    } finally {
      setIntegrityLoading(false);
    }
  };
  const saveHonesty = async (decision) => {
    if (!integrityDetail) return;
    setHonestyBusy(true);
    setHonestyError("");
    try {
      const next = await api(
        "/admin/integrity/attempts/" +
          encodeURIComponent(integrityDetail.id) +
          "/honesty",
        {
          method: "POST",
          body: {
            score: honestyDraft.score === "" ? null : Number(honestyDraft.score),
            decision,
            reason: honestyDraft.reason.trim(),
          },
        },
      );
      setIntegrityDetail((current) =>
        current ? { ...current, honesty: next.honesty, publication: next.publication } : current,
      );
      setHonestyDraft({
        score: String(next.honesty.score),
        reason: next.honesty.reason || "",
      });
      // Refresh only the integrity queue instead of every admin endpoint.
      const list = await api("/admin/integrity/attempts");
      setData((prev) => ({ ...prev, integrity: list }));
    } catch (x) {
      setHonestyError(x.message || "Could not save the honesty score.");
    } finally {
      setHonestyBusy(false);
    }
  };
  const submitAction = async (e) => {
    e.preventDefault();
    if (!action || reason.trim().length < 3) return;
    setSaving(true);
    try {
      const body = { reason: reason.trim() };
      let actionResult = null;
      if (action.kind === "user") {
        body.status = action.decision;
        await api("/admin/users/" + action.id + "/status", {
          method: "POST",
          body,
        });
      }
      if (action.kind === "company") {
        body.decision = action.decision;
        await api("/admin/companies/" + action.id + "/verification-decision", {
          method: "POST",
          body,
        });
      }
      if (action.kind === "job") {
        body.decision = action.decision;
        await api("/admin/jobs/" + action.id + "/moderation-decision", {
          method: "POST",
          body,
        });
      }
      if (action.kind === "assessment") {
        body.decision = action.decision;
        if (action.evaluations) body.evaluations = action.evaluations;
        if (selectedReport?.id === action.id) {
          body.evaluations = Object.entries(reportEvaluations).filter(([questionId]) => selectedReport.evaluations?.some((evaluation) => evaluation.question_id === questionId)).map(
            ([question_id, edit]) => ({
              question_id,
              marks: edit.marks === "" ? null : Number(edit.marks),
              admin_note: edit.admin_note || "",
              additional_info: edit.additional_info || "",
              status: "approved",
            }),
          );
        }
        actionResult = await api("/admin/attempts/" + action.id + "/review", {
          method: "POST",
          body,
        });
      }
      if (action.kind === "appeal") {
        body.decision = action.decision;
        actionResult = await api("/admin/appeals/" + action.id + "/decision", {
          method: "POST",
          body,
        });
      }
      if (action.kind === "phase") {
        body.decision = action.decision;
        await api("/admin/phase-two-requests/" + action.id + "/decision", {
          method: "POST",
          body,
        });
      }
      if (action.kind === "learning-resource") {
        body.status = action.decision;
        await api("/admin/learning/resources/" + action.id, {
          method: "PATCH",
          body,
        });
      }
      setAction(null);
      const appealMessage = action.kind === "appeal"
        ? (action.decision === "overturned"
            ? (actionResult?.publication?.ready
                ? (actionResult?.passport_id
                    ? "Appeal overturned. The assessment was republished and a new Skill Passport was issued."
                    : "Appeal overturned. The assessment was republished.")
                : "Appeal overturned. The academic decision is restored; publication still needs honesty and evaluation approval.")
            : action.decision === "upheld"
              ? "Appeal upheld. The original assessment decision stands."
              : "More information requested. The candidate can add details and the appeal returns to the queue.")
          + (actionResult?.single_admin_override
              ? " Single-admin override recorded in the audit trail."
              : "")
        : "";
      flash(
        appealMessage ||
        (actionResult?.passport_id
          ? "Result approved. The learning path is now verified and a Skill Passport was created automatically."
          : actionResult?.learning_path_updated
            ? "Result approved. The candidate learning path has been updated."
             : actionResult?.publication?.stage === "honesty_review" ? "Academic marks approved. Learning and the passport remain locked until honesty approval." : "Decision saved and recorded in the audit trail."),
      );
      await load();
    } catch (x) {
      setError(x.message || "Action failed.");
    } finally {
      setSaving(false);
    }
  };
  const openQuestionEditor = (question = null) => {
    setQuestionEditing(question);
    setQuestionDraft(
      question
        ? {
            ...question,
            options: (question.options || []).join("\n"),
            time_minutes: Math.round((question.time_allocation || 60) / 60),
          }
        : {
            category_id:
              questionCategory === "all" ? "CAT-01" : questionCategory,
            subcategory: "",
            question_type: "MCQ",
            difficulty_level: "Medium",
            question_text: "",
            options: "",
            correct_answer: "",
            explanation: "",
            reference_answer: "",
            grading_rubric: "",
            marks: 2,
            time_minutes: 2,
            status: "draft",
          },
    );
    setQuestionModal(true);
  };
  const saveQuestion = async (e) => {
    e.preventDefault();
    setQuestionSaving(true);
    setError("");
    const payload = {
      ...questionDraft,
      options: questionDraft.options
        .split("\n")
        .map((x) => x.trim())
        .filter(Boolean),
      marks: Number(questionDraft.marks),
      time_allocation: Number(questionDraft.time_minutes) * 60,
    };
    delete payload.time_minutes;
    try {
      if (questionEditing)
        await api("/admin/questions/" + questionEditing.id, {
          method: "PUT",
          body: payload,
        });
      else await api("/admin/questions", { method: "POST", body: payload });
      setQuestionModal(false);
      flash(
        questionEditing
          ? "Question updated successfully."
          : "Question added to the bank.",
      );
      await load();
    } catch (x) {
      setError(x.message || "Could not save question.");
    } finally {
      setQuestionSaving(false);
    }
  };
  const previewQuestionImport = async (e) => {
    e.preventDefault();
    if (!importFile) return;
    setImportBusy(true);
    setError("");
    setImportPreview(null);
    try {
      const form = new FormData();
      form.append("file", importFile);
      form.append("category_id", importCategory);
      setImportPreview(
        await api("/admin/questions/import/preview", { method: "POST", form }),
      );
    } catch (x) {
      setError(x.message || "Could not preview this file.");
    } finally {
      setImportBusy(false);
    }
  };
  const commitQuestionImport = async () => {
    if (!importPreview) return;
    setImportBusy(true);
    setError("");
    try {
      const valid = importPreview.items
        .filter((x) => !x.errors)
        .map((item) => {
          const { errors: _errors, duplicate: _duplicate, ...q } = item;
          return q;
        });
      const result = await api("/admin/questions/import/commit", {
        method: "POST",
        body: { questions: valid },
      });
      // Keep the submitted items so rejected rows can be named by their index.
      setImportResult({ ...result, submitted: valid });
      setImportPreview(null);
      setImportFile(null);
      flash(
        "Import complete · " +
          result.added +
          " added · " +
          result.skipped +
          " duplicates skipped · " +
          result.rejected +
          " rejected.",
      );
      await load();
    } catch (x) {
      setError(x.message || "Import could not be completed.");
    } finally {
      setImportBusy(false);
    }
  };
  const createQuestionCategory = async (e) => {
    e.preventDefault();
    const name = categoryDraft.trim();
    if (name.length < 2) {
      setError("Enter a category name with at least 2 characters.");
      return;
    }
    setCategoryBusy(true);
    setError("");
    try {
      const created = await api("/admin/questions/categories", {
        method: "POST",
        body: { name },
      });
      setCategoryDraft("");
      setScrapeCategory(created.id);
      flash("Category created: " + created.name);
      await load();
    } catch (x) {
      setError(x.message || "Could not create category.");
    } finally {
      setCategoryBusy(false);
    }
  };
  const runScrape = async (e) => {
    e.preventDefault();
    const html = scrapeMode === "html" ? scrapeHtml.trim() : "";
    if (scrapeMode !== "html" && !scrapeUrl.trim()) return;
    if (scrapeMode === "html" && !html) return;
    setScrapeBusy(true);
    setError("");
    setStagingSelected({});
    try {
      const result = await api("/admin/questions/scrape", {
        method: "POST",
        body: {
          url: scrapeUrl.trim(),
          html,
          category_id: scrapeNewCategory.trim() || scrapeCategory,
          subcategory: scrapeSubcategory.trim(),
        },
      });
      flash(
        "Scraped " +
          result.total +
          " questions into staging from " +
          (result.source_url || "pasted HTML") +
          " · review and select which to import.",
      );
      await load();
    } catch (x) {
      setError(x.message || "Scraping failed.");
    } finally {
      setScrapeBusy(false);
    }
  };
  const toggleStaging = (id, on) => {
    setStagingSelected((s) => {
      const n = { ...s };
      if (on) n[id] = true;
      else delete n[id];
      return n;
    });
  };
  const commitStaging = async () => {
    const ids = Object.keys(stagingSelected).filter((k) => stagingSelected[k]);
    if (!ids.length) {
      flash("Select at least one staged question to import.");
      return;
    }
    setStagingBusy(true);
    setError("");
    try {
      const result = await api("/admin/questions/staging/commit", {
        method: "POST",
        body: { question_ids: ids },
      });
      setStagingSelected({});
      flash(
        "Import complete · " +
          result.added +
          " added · " +
          result.skipped +
          " duplicates skipped · " +
          result.rejected +
          " rejected.",
      );
      await load();
    } catch (x) {
      setError(x.message || "Could not import selected questions.");
    } finally {
      setStagingBusy(false);
    }
  };
  const clearStaging = async () => {
    setStagingBusy(true);
    setError("");
    try {
      await api("/admin/questions/staging", { method: "DELETE" });
      setStagingSelected({});
      flash("Staging table cleared.");
      await load();
    } catch (x) {
      setError(x.message || "Could not clear staging.");
    } finally {
      setStagingBusy(false);
    }
  };
  const deleteStagingItem = async (id) => {
    setStagingBusy(true);
    try {
      await api("/admin/questions/staging/" + encodeURIComponent(id), {
        method: "DELETE",
      });
      setStagingSelected((s) => {
        const n = { ...s };
        delete n[id];
        return n;
      });
      await load();
    } catch (x) {
      setError(x.message || "Could not remove that staged question.");
    } finally {
      setStagingBusy(false);
    }
  };
  const printAssessmentReport = (report) => {
    const esc = (v) =>
      String(v ?? "—").replace(
        /[&<>"']/g,
        (c) =>
          ({
            "&": "&amp;",
            "<": "&lt;",
            ">": "&gt;",
            '"': "&quot;",
            "'": "&#39;",
          })[c],
      );
    const evidence = report.answer_evidence || [];
    const questions = evidence
      .map(
        (q) =>
          `<article class="question"><h3>Question ${esc(q.number)} · ${esc(q.topic)} · ${esc(q.type)}</h3><p class="prompt">${esc(q.question)}</p>${q.options?.length ? `<ol>${q.options.map((o) => `<li>${esc(o)}</li>`).join("")}</ol>` : ""}<div class="answer"><b>Candidate response</b><pre>${esc(q.selected_option ?? q.candidate_answer ?? "Not captured in this attempt")}</pre></div><div class="meta">Automated result: ${q.automated_correct === true ? "Correct" : q.automated_correct === false ? "Incorrect" : "Not available"} · Difficulty: ${esc(q.difficulty)} · Response time: ${esc(q.time_seconds)} sec</div>${q.evaluation ? `<div class="meta"><b>AI-assisted draft (${esc(q.evaluation.status)}):</b> ${esc(q.evaluation.ai_marks)}/${esc(q.evaluation.max_marks)} partial marks · ${esc(q.evaluation.rationale)}</div>` : ""}</article>`,
      )
      .join("");
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>Assessment evaluation report</title><style>body{font:14px/1.55 Arial,sans-serif;color:#18232b;margin:34px}h1{font-size:26px;margin:0}h2{margin-top:28px} .sub{color:#61717b}.summary{display:flex;gap:16px;margin:22px 0}.metric{padding:14px;border:1px solid #dce4e8;border-radius:10px;min-width:120px}.metric b{display:block;font-size:24px}.question{border:1px solid #dce4e8;border-radius:10px;padding:16px;margin:14px 0;break-inside:avoid}.prompt{font-weight:600}.answer{background:#f4f7f8;padding:12px;border-radius:8px}.answer pre{white-space:pre-wrap;font:13px/1.5 monospace;margin:8px 0}.meta{font-size:12px;color:#61717b;margin-top:10px}.notice{background:#fff8e8;border-left:4px solid #d59a35;padding:12px;margin:18px 0} @media print{body{margin:15mm}.question{break-inside:avoid}}</style></head><body><h1>TalentForge · Assessment evaluation report</h1><p class="sub">Candidate: ${esc(report.candidate_name)} · ${esc(report.email)}<br>Attempt: ${esc(report.id)} · Type: ${esc(report.kind)} · Completed: ${esc(stamp(report.finished))}</p><div class="summary"><div class="metric"><b>${esc(report.result?.overall ?? "—")}/100</b>Overall score</div><div class="metric"><b>${esc(report.result?.level ?? "—")}</b>Estimated level</div><div class="metric"><b>${esc(report.result?.trust ?? "—")}</b>Integrity signal</div></div><div class="notice"><b>Evaluation method:</b> ${esc(report.evaluation_method || "Automated grading details unavailable.")} The score is a support signal, not a final hiring decision. Manual review is required.</div><h2>Topic breakdown</h2><ul>${Object.entries(
      report.result?.topics || {},
    )
      .map(
        ([k, v]) =>
          `<li>${esc(k)}: ${esc(v.score)}% · ${esc(v.level)} · ${esc(v.n)} questions</li>`,
      )
      .join(
        "",
      )}</ul><h2>Question-by-question evidence</h2>${questions || "<p>No question-level evidence is available for this attempt.</p>"}<p class="sub">Generated by TalentForge admin review. Save or print this page as PDF using your browser's print dialog.</p><script>window.onload=()=>setTimeout(()=>window.print(),300)</script></body></html>`;
    const win = window.open("", "_blank");
    if (!win) {
      setError("Allow pop-ups to generate the printable PDF report.");
      return;
    }
    win.document.open();
    win.document.write(html);
    win.document.close();
  };
  const counts = data.overview?.counts || {};
  const rows = (key) => data[key]?.items || [];
  // Server-side pagination for the large admin lists (limit/offset/total).
  const loadAdminPage = async (key, offset) => {
    const base = ADMIN_PAGED_ENDPOINTS[key];
    if (!base) return;
    setBusy(true);
    try {
      const res = await api(`${base}?limit=${ADMIN_PAGE_SIZE}&offset=${Math.max(0, offset)}`);
      setData((current) => ({ ...current, [key]: res }));
    } catch (x) {
      setError(x.message || "Could not load this page.");
    } finally {
      setBusy(false);
    }
  };
  const adminPager = (key) => {
    const info = data[key];
    const total = Number(info?.total);
    if (!info || info.error || !Number.isFinite(total)) return null;
    const offset = Number(info.offset) || 0;
    const limit = Number(info.limit) || ADMIN_PAGE_SIZE;
    const count = (info.items || []).length;
    return (
      <nav className="ad-pager" aria-label={`${key} pages`}>
        <span aria-live="polite">{total && count ? `${offset + 1}–${offset + count} of ${total}` : `0 of ${total}`}</span>
        <button type="button" disabled={busy || offset <= 0} onClick={() => loadAdminPage(key, offset - limit)}>Prev</button>
        <button type="button" disabled={busy || offset + count >= total} onClick={() => loadAdminPage(key, offset + limit)}>Next</button>
      </nav>
    );
  };
  const filtered = (items, fields) =>
    items.filter((x) =>
      fields.some((f) =>
        String(x[f] ?? "")
          .toLowerCase()
          .includes(search.toLowerCase()),
      ),
    );
  const stamp = (v) => (v ? new Date(Number(v) * 1000).toLocaleString() : "—");
  const eventLabel = (type) => ({
    tab_hidden: "Switched away from exam tab",
    tab_visible: "Returned to exam tab",
    blur: "Exam window lost focus",
    focus: "Exam window focused",
    fullscreen_exit: "Exited full-screen",
    fullscreen_enter: "Returned to full-screen",
    screen_share_stopped: "Screen sharing stopped",
    screen_share_started: "Screen sharing started",
    screen_share_unavailable: "Screen sharing unavailable",
    wrong_share_surface: "Wrong surface shared",
    camera_stopped: "Webcam disconnected",
    copy: "Copy shortcut blocked",
    cut: "Cut shortcut blocked",
    paste: "Paste shortcut blocked",
    heartbeat_gap: "Monitoring connection gap",
    network_ip_changed: "Network address changed",
    ai_no_face: "No face visible to camera",
    ai_multiple_faces: "Multiple faces detected",
    ai_gaze_away: "Possible gaze deviation",
    ai_phone_detected: "Possible phone detected",
    ai_audio_level: "Sustained microphone sound level",
    microphone_stopped: "Microphone disconnected",
    ai_model_unavailable: "On-device AI unavailable",
    identity_verified: "Identity verified against profile photo",
    identity_mismatch: "Identity mismatch against profile photo",
    identity_skipped: "Identity check skipped",
  })[type] || String(type || "Unknown event").replaceAll("_", " ");
  const eventSource = (e) =>
    e.type === "ai_audio_level" ? "On-device sound-level threshold (not speech recognition)" : String(e.type || "").startsWith("ai_")
      ? "Local AI · MediaPipe"
      : String(e.type || "").startsWith("identity_")
        ? "Local face check · face-api"
        : e.type === "heartbeat_gap"
          ? "Connection monitoring"
          : e.type === "camera_stopped"
            ? "Webcam status"
            : "Browser event · server timestamp";
  const renderIntegrityEvents = (title, events, emptyText) => (
    <>
      <h3>{title} ({events.length})</h3>
      {events.length ? (
        <div className="ad-table-wrap">
          <table className="ad-table">
            <thead>
              <tr>
                <th>Server time</th>
                <th>Elapsed</th>
                <th>Event</th>
                <th>Question</th>
                <th>Interruption duration</th>
                <th>Source</th>
              </tr>
            </thead>
            <tbody>
              {events.map((e) => (
                <tr key={e.id}>
                  <td>{stamp(e.server_ts)}</td>
                  <td>{e.elapsed_label || fmt(Math.floor(e.elapsed_seconds || 0))}</td>
                  <td>
                    <b>{eventLabel(e.type)}</b>
                    <small>{e.type}</small>
                    {e.metadata?.review_note && <small>{e.metadata.review_note}</small>}
                  </td>
                  <td>
                    {e.question_id || "Before / between questions"}
                    {e.question && <small>{e.question}</small>}
                  </td>
                  <td>
                    {e.duration_status === "instant"
                      ? "Point-in-time event"
                      : e.duration_seconds != null
                        ? Number(e.duration_seconds).toFixed(1) + "s" +
                          (e.duration_status === "ongoing"
                            ? " (ongoing)"
                            : e.duration_status === "measured"
                              ? " (measured)"
                              : "")
                        : "Not recorded"}
                  </td>
                  <td>
                    {eventSource(e)}
                    {e.metadata?.surface ? " · " + e.metadata.surface : ""}
                    {typeof e.metadata?.similarity === "number"
                      ? " · similarity " + e.metadata.similarity + "%"
                      : ""}
                    {e.seq ? " · seq " + e.seq : ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p>{emptyText}</p>
      )}
    </>
  );
  const pill = (v) => (
    <span
      data-tone={statusTone(v)}
      className={
        "ad-pill ad-" +
        String(v || "unknown")
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
      }
    >
      {String(v || "unknown").replaceAll("_", " ")}
    </span>
  );
  const metric = (label, value, sub, icon) => (
    <article className="ad-metric">
      <span aria-hidden="true"><WorkspaceIcon name={{ "♙": "team", "◎": "profile", "▣": "building", "▤": "jobs", "↗": "applications", "✓": "exams", "◈": "privacy", "⚑": "appeals", "◷": "clock" }[icon] || icon} size={18} /></span>
      <div>
        <small>{label}</small>
        <strong>{value ?? "—"}</strong>
        <em>{sub}</em>
      </div>
    </article>
  );
  const table = (heads, body, empty) => (
    <div className="ad-table-wrap">
      <table className="ad-table">
        <thead>
          <tr>
            {heads.map((h) => (
              <th key={h} scope="col">{sentenceCase(h)}</th>
            ))}
          </tr>
        </thead>
        <tbody>{body}</tbody>
      </table>
      {!body.length && (
        <div className="ad-empty">{empty || "No records to display."}</div>
      )}
    </div>
  );
  const section = (k) => setPage(k);
  const scopePages = {
    super_admin: [
      "overview",
      "users",
      "staff",
      "companies",
      "jobs",
      "assessments",
      "integrity",
      "identity",
      "appeals",
      "questions",
      "learning",
      "ai",
      "agent",
      "billing",
      "privacy",
      "quality",
      "audit",
      "security",
    ],
    trust_safety_reviewer: [
      "users",
      "assessments",
      "integrity",
      "identity",
      "appeals",
      "quality",
      "agent",
    ],
    question_content_admin: [
      "questions",
      "learning",
      "assessments",
      "integrity",
      "agent",
    ],
    company_verification_admin: [
      "companies",
      "jobs",
      "assessments",
      "integrity",
    ],
    support_agent: ["users"],
    finance_admin: ["billing", "learning"],
    compliance_officer: ["ai", "agent", "privacy", "quality", "audit"],
  };
  const visibleNav = nav.filter(([id]) =>
    (scopePages[adminRole] || []).includes(id),
  );
  useEffect(() => {
    if (visibleNav.length && !visibleNav.some((x) => x[0] === page))
      setPage(visibleNav[0][0]);
    // Only re-check when the admin role (and so the visible pages) changes;
    // visibleNav is derived from adminRole every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adminRole]);
  const current = nav.find((x) => x[0] === page);
  if (adminRole === null) {
    return (
      <main className="ad-app ad-no-role" id="admin-content">
        <section className="ad-modal" role="alert" style={{ margin: "10vh auto" }}>
          <h2>No staff role assigned</h2>
          <p>Your account has no admin role or scopes yet. Ask a super admin to assign a staff role, then sign in again.</p>
          <div className="ad-modal-actions">
            <button type="button" onClick={load} disabled={busy}>Check again</button>
            <button type="button" className="ad-modal-confirm" onClick={onLogout}>{C.common.signOut}</button>
          </div>
        </section>
      </main>
    );
  }
  return (
    <div className="ad-app">
      <a className="ws-skip-link" href="#admin-content">Skip to content</a>
      <aside className="ad-sidebar">
        <div className="ad-brand">
          <span className="ad-brand-mark">TF</span>
          <span>
            TalentForge<small>{A.brand}</small>
          </span>
        </div>
        <div className="ad-admin-label">
          <span className="ad-online-dot" /> {A.label}
        </div>
        <nav className="ad-nav" aria-label={A.navAria}>
          {visibleNav.map(([id, label, icon]) => (
            <button
              key={id}
              type="button"
              className={page === id ? "active" : ""}
              aria-current={page === id ? "page" : undefined}
              title={label}
              onClick={() => {
                setPage(id);
                setSearch("");
              }}
            >
              <span><WorkspaceIcon name={icon || id} /></span>
              {label}
              {id === "companies" && counts.pending_companies > 0 ? (
                <b>{counts.pending_companies}</b>
              ) : id === "jobs" && counts.pending_jobs > 0 ? (
                <b>{counts.pending_jobs}</b>
              ) : id === "integrity" &&
                (data.assessments?.items || []).filter((x) => !x.review_decision).length > 0 ? (
                <b>
                  {(data.assessments?.items || []).filter((x) => !x.review_decision).length}
                </b>
              ) : id === "appeals" && counts.open_appeals > 0 ? (
                <b>{counts.open_appeals}</b>
              ) : null}
            </button>
          ))}
        </nav>
        <div className="ad-sidebar-bottom">
          <div className="ad-security-card">
            <strong>{A.privilegedTitle}</strong>
            <p>{A.privilegedBody}</p>
          </div>
          <div className="ad-admin-profile">
            <div>SA</div>
            <span>
              <b>{adminRole.replaceAll("_", " ")}</b>
              <small>{A.internalAccess}</small>
            </span>
          </div>
          <button
            className="ad-sidebar-signout"
            type="button"
            onClick={onLogout}
          >
            {A.signOutAdmin}
          </button>
        </div>
      </aside>
      <main className="ad-main">
        <header className="ad-topbar">
          <div>
            <span>{A.platform}</span>
            <b>/</b>
            {current?.[1] || A.nav.overview}
          </div>
          <div className="ad-top-actions">
            <WorkspaceSearch items={visibleNav.map(([id, label, icon]) => ({ id, label, icon }))} onNavigate={(id) => { setPage(id); setSearch(""); }} lang={lang} />
            <span className="ad-secure-label">
              <i /> {A.secureSession}
            </span>
            <NotificationBell
              workspace="admin"
              availableSections={visibleNav.map(([id]) => id)}
              onNavigate={(id) => { setPage(id); setSearch(""); }}
              buttonClassName="ad-bell-btn"
            />
            <button onClick={load} disabled={busy} title={C.common.refresh} aria-label={C.common.refresh}>
              <WorkspaceIcon name="refresh" size={18} />
            </button>
            <select className="ws-language" aria-label="Language" value={lang} onChange={(event) => setLang(event.target.value)}><option value="en">English</option><option value="bn">বাংলা</option></select>
            <span className="ad-top-avatar">SA</span>
            <button className="ad-signout" onClick={onLogout} type="button">
              <WorkspaceIcon name="logout" size={16} /> {C.common.signOut}
            </button>
          </div>
        </header>
        <div className="ad-content" id="admin-content" tabIndex={-1} aria-busy={busy}>
          {toast && (
            <div className="ad-toast" role="status">
              ✓ {toast}
              <button type="button" aria-label="Dismiss" onClick={() => setToast("")}>×</button>
            </div>
          )}
          {error && (
            <div className="ad-error" role="alert">
              {error}
              <button type="button" aria-label="Dismiss" onClick={() => setError("")}>×</button>
            </div>
          )}
          <div className="ad-page-heading">
            <div>
              <div className="ad-eyebrow">{A.title}</div>
              <h1>
                {page === "overview" ? A.overviewTitle : current?.[1]}
              </h1>
              <p>
                {page === "overview" ? A.overviewDesc : A.desc[page]}
              </p>
            </div>
            <button className="ad-refresh" onClick={load} disabled={busy}>
              {busy ? C.common.refreshing : C.common.refreshData}
            </button>
          </div>
          {page === "overview" && (
            <section>
              <div className="ad-metrics">
                {metric(
                  A.metrics.totalAccounts,
                  counts.users,
                  A.metrics.registeredUsers,
                  "♙",
                )}
                {metric(
                  A.metrics.candidates,
                  counts.candidates,
                  A.metrics.individualAccounts,
                  "◎",
                )}
                {metric(
                  A.metrics.companies,
                  counts.companies,
                  counts.verified_companies + " " + A.metrics.verifiedCount,
                  "▣",
                )}
                {metric(
                  A.metrics.publishedJobs,
                  counts.published_jobs,
                  counts.pending_jobs + " " + A.metrics.awaitingReview,
                  "▤",
                )}
                {metric(
                  A.metrics.applications,
                  counts.applications,
                  A.metrics.submittedApplications,
                  "↗",
                )}
                {metric(
                  A.metrics.completed,
                  counts.completed_attempts,
                  counts.open_appeals + " " + A.metrics.openAppeals,
                  "✓",
                )}
              </div>
              <div className="ad-overview-grid">
                <div className="ad-panel">
                  <div className="ad-panel-head">
                    <div>
                      <h2>{A.needsAttention}</h2>
                      <p>{A.needsAttentionSub}</p>
                    </div>
                    <span className="ad-live-tag">{A.liveData}</span>
                  </div>
                  {[
                    [
                      A.queues.companyVerification,
                      counts.pending_companies,
                      "companies",
                      "companies",
                    ],
                    [A.queues.jobReview, counts.pending_jobs, "posts", "jobs"],
                    [
                      A.queues.appeals,
                      counts.open_appeals,
                      "appeals",
                      "appeals",
                    ],
                    [
                      A.queues.assessmentReview,
                      (data.assessments?.items || []).filter(
                        (x) => !x.review_decision,
                      ).length,
                      "reviews",
                      "assessments",
                    ],
                  ].map(([label, n, unit, target]) => (
                    <button key={target + label}
                      className="ad-queue-row"
                      onClick={() => section(target)}
                    >
                      <span className="ad-queue-icon" aria-hidden="true"><WorkspaceIcon name={target} size={18} /></span>
                      <span>
                        <b>{label}</b>
                        <small>
                          {n || 0} {unit} pending review
                        </small>
                      </span>
                      <strong>{n || 0}</strong>
                      <i>→</i>
                    </button>
                  ))}
                </div>
                <div className="ad-panel">
                  <div className="ad-panel-head">
                    <div>
                      <h2>Platform readiness</h2>
                      <p>Connected service status</p>
                    </div>
                  </div>
                  <div className="ad-health-row">
                    <span>
                      <i className="ad-health-green" /> API / database
                    </span>
                    <b>Connected</b>
                  </div>
                  <div className="ad-health-row">
                    <span>
                      <i
                        className={
                          data.ai?.configured
                            ? "ad-health-green"
                            : "ad-health-amber"
                        }
                      />{" "}
                      AI provider
                    </span>
                    <b>
                      {data.ai?.status === "configured"
                        ? "Configured"
                        : "Fallback mode"}
                    </b>
                  </div>
                  <div className="ad-health-row">
                    <span>
                      <i className="ad-health-amber" /> Billing
                    </span>
                    <b>Not enabled</b>
                  </div>
                  <div className="ad-health-row">
                    <span>
                      <i className="ad-health-amber" /> Retention workers
                    </span>
                    <b>Not configured</b>
                  </div>
                  <p className="ad-footnote">
                    Health indicators reflect available application
                    configuration, not external uptime guarantees.
                  </p>
                </div>
              </div>
              <div className="ad-panel ad-lower-note">
                <strong>Platform principles</strong>
                <div>
                  <span>✓ Human-led hiring decisions</span>
                  <span>✓ Deterministic assessment scoring</span>
                  <span>✓ Candidate-controlled sharing</span>
                  <span>✓ Auditable admin actions</span>
                </div>
              </div>
            </section>
          )}
          {page === "users" && (
            <section className="ad-panel">
              <div className="ad-panel-head">
                <div>
                  <h2>Accounts directory</h2>
                  <p>Search users and manage account availability.</p>
                </div>
                <span className="ad-count">{rows("users").length} records</span>
              </div>
              <div className="ad-toolbar">
                <input
                  placeholder="Search name or email…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
                <select
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                >
                  <option value="all">All roles</option>
                  <option value="candidate">Candidates</option>
                  <option value="company">Company users</option>
                  <option value="admin">Admins</option>
                </select>
              </div>
              {adminPager("users")}
              {table(
                ["User", "Role", "Created", "Status", "Actions"],
                filtered(
                  rows("users").filter(
                    (x) => filter === "all" || x.role === filter,
                  ),
                  ["name", "email"],
                ).map((u) => (
                  <tr key={u.id || u.email}>
                    <td>
                      <b>{u.name}</b>
                      <small>{u.email}</small>
                      <small className="ad-id">ID {u.id}</small>
                    </td>
                    <td>{pill(u.role)}</td>
                    <td>{stamp(u.created)}</td>
                    <td>{pill(u.account_status || "active")}</td>
                    <td>
                      {u.role === "candidate" && (
                        <button
                          className="ad-action-btn"
                          onClick={() => setCandidateView(u.id)}
                        >
                          View candidate
                        </button>
                      )}
                      {u.role !== "admin" && adminRole !== "support_agent" && (
                        <button
                          className="ad-action-btn"
                          onClick={() =>
                            openAction(
                              "user",
                              u.id,
                              (u.account_status || "active") === "active"
                                ? "suspended"
                                : "active",
                            )
                          }
                        >
                          {(u.account_status || "active") === "active"
                            ? "Suspend"
                            : "Reactivate"}
                        </button>
                      )}
                    </td>
                  </tr>
                )),
                "No accounts match your search.",
              )}
            </section>
          )}

          {page === "staff" && (
            <section className="ad-panel">
              <div className="ad-panel-head">
                <div>
                  <h2>Privileged staff access</h2>
                  <p>
                    Admin accounts are provisioned internally. Assign each staff
                    account only the scope required for their duties.
                  </p>
                </div>
                <span className="ad-count">
                  {rows("staff").length} staff accounts
                </span>
              </div>
              <div className="ad-info-banner">
                Create internal admin accounts here. Public signup cannot grant
                admin access. Choose the least-privilege role needed for each
                person.
              </div>
              <form
                onSubmit={createAdmin}
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fit,minmax(180px,1fr))",
                  gap: 12,
                  alignItems: "end",
                  padding: "16px 0",
                }}
              >
                <label>
                  Full name
                  <input
                    className="ad-role-select"
                    required
                    minLength={2}
                    maxLength={80}
                    value={adminDraft.name}
                    onChange={(e) =>
                      setAdminDraft({ ...adminDraft, name: e.target.value })
                    }
                    placeholder="Admin name"
                  />
                </label>
                <label>
                  Admin email
                  <input
                    className="ad-role-select"
                    type="email"
                    required
                    value={adminDraft.email}
                    onChange={(e) =>
                      setAdminDraft({ ...adminDraft, email: e.target.value })
                    }
                    placeholder="admin@example.com"
                  />
                </label>
                <label>
                  Password
                  <input
                    className="ad-role-select"
                    type="password"
                    required
                    minLength={14}
                    maxLength={128}
                    autoComplete="new-password"
                    value={adminDraft.password}
                    onChange={(e) =>
                      setAdminDraft({ ...adminDraft, password: e.target.value })
                    }
                    placeholder="At least 14 characters"
                  />
                </label>
                <label>
                  Permission role
                  <select
                    className="ad-role-select"
                    value={adminDraft.admin_role}
                    onChange={(e) =>
                      setAdminDraft({
                        ...adminDraft,
                        admin_role: e.target.value,
                      })
                    }
                  >
                    <option value="support_agent">Support Agent</option>
                    <option value="trust_safety_reviewer">
                      Trust & Safety Reviewer
                    </option>
                    <option value="question_content_admin">
                      Question / Content Admin
                    </option>
                    <option value="company_verification_admin">
                      Company Verification Admin
                    </option>
                    <option value="finance_admin">Finance Admin</option>
                    <option value="compliance_officer">
                      Compliance Officer
                    </option>
                    <option value="super_admin">Super Admin</option>
                  </select>
                </label>
                <button
                  className="ad-mini-primary"
                  disabled={creatingAdmin || adminDraft.password.length < 14}
                >
                  {creatingAdmin ? "Creating…" : "＋ Add Admin"}
                </button>
              </form>
              <div className="ad-info-banner">
                Passwords are stored as secure hashes. Do not reuse or share
                passwords in public channels; provide each admin their
                credentials privately.
              </div>
              {table(
                ["Staff member", "Admin role", "Updated", "Access scope", "Actions"],
                rows("staff").map((s) => (
                  <tr key={s.id || s.email}>
                    <td>
                      <b>{s.name}</b>
                      <small>{s.email}</small>
                      <small>ID {s.id}</small>
                    </td>
                    <td>
                      <select
                        className="ad-role-select"
                        value={s.admin_role || ""}
                        onChange={async (e) => {
                          try {
                            await api("/admin/console/staff/" + s.id, {
                              method: "PUT",
                              body: { admin_role: e.target.value },
                            });
                            flash("Admin role updated.");
                            await load();
                          } catch (x) {
                            setError(x.message);
                          }
                        }}
                      >
                        {!s.admin_role && <option value="" disabled>No role assigned</option>}
                        <option value="super_admin">Super Admin</option>
                        <option value="trust_safety_reviewer">
                          Trust & Safety Reviewer
                        </option>
                        <option value="question_content_admin">
                          Question / Content Admin
                        </option>
                        <option value="company_verification_admin">
                          Company Verification Admin
                        </option>
                        <option value="support_agent">Support Agent</option>
                        <option value="finance_admin">Finance Admin</option>
                        <option value="compliance_officer">
                          Compliance Officer
                        </option>
                      </select>
                    </td>
                    <td>{stamp(s.updated_at)}</td>
                    <td>
                      <small>{s.admin_role ? s.admin_role.replaceAll("_", " ") : "No role assigned"}</small>
                    </td>
                    <td>
                      {s.id === adminId ? (
                        <small>Your account</small>
                      ) : (
                        <div className="ad-row-actions">
                          <button type="button" onClick={() => revokeAdmin(s)}>
                            Revoke admin
                          </button>
                          <button
                            type="button"
                            className="ad-danger-link"
                            onClick={() => deleteAdmin(s)}
                          >
                            Delete
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                )),
                "No internally provisioned admin staff accounts found.",
              )}
            </section>
          )}
          {page === "companies" && (
            <section className="ad-panel">
              <div className="ad-panel-head">
                <div>
                  <h2>Organisation verification queue</h2>
                  <p>Review legal identity details and evidence notes.</p>
                </div>
                <span className="ad-count">
                  {rows("companies").length} requests
                </span>
              </div>
              <div className="ad-toolbar">
                <input
                  placeholder="Search company or legal name…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
                <select
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                >
                  <option value="all">All statuses</option>
                  <option value="pending_review">Pending</option>
                  <option value="verified">Verified</option>
                  <option value="needs_information">Needs information</option>
                  <option value="rejected">Rejected</option>
                </select>
              </div>
              {table(
                [
                  "Organisation",
                  "Legal details",
                  "Submitted",
                  "Status",
                  "Decision",
                ],
                filtered(
                  rows("companies").filter(
                    (x) => filter === "all" || x.status === filter,
                  ),
                  ["company_name", "legal_name", "country"],
                ).map((x) => (
                  <tr key={x.id}>
                    <td>
                      <b>{x.company_name}</b>
                      <small>{x.website || "Website not provided"}</small>
                    </td>
                    <td>
                      <b>{x.legal_name}</b>
                      <small>
                        {x.country} · {x.business_id || "No registration ID"}
                      </small>
                      <small>{x.evidence_note}</small>
                    </td>
                    <td>{stamp(x.submitted_at)}</td>
                    <td>{pill(x.status)}</td>
                    <td>
                      <div className="ad-row-actions">
                        {x.status === "pending_review" && (
                          <>
                            <button
                              className="ad-mini-primary"
                              onClick={() =>
                                openAction("company", x.company_id, "verified")
                              }
                            >
                              Verify
                            </button>
                            <button
                              onClick={() =>
                                openAction(
                                  "company",
                                  x.company_id,
                                  "needs_information",
                                )
                              }
                            >
                              Request info
                            </button>
                            <button
                              className="ad-danger-link"
                              onClick={() =>
                                openAction("company", x.company_id, "rejected")
                              }
                            >
                              Reject
                            </button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                )),
                "No verification requests found.",
              )}
            </section>
          )}
          {page === "jobs" && (
            <section className="ad-panel">
              <div className="ad-panel-head">
                <div>
                  <h2>Job moderation</h2>
                  <p>
                    Approve compliant listings or return them with a clear
                    reason.
                  </p>
                </div>
                <span className="ad-count">{rows("jobs").length} records</span>
              </div>
              <div className="ad-toolbar">
                <input
                  placeholder="Search job title or company…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </div>
              {table(
                [
                  "Job / company",
                  "Location",
                  "Submitted",
                  "Status",
                  "Moderation",
                ],
                filtered(rows("jobs"), [
                  "title",
                  "company_name",
                  "description",
                ]).map((x) => (
                  <tr key={x.id}>
                    <td>
                      <b>{x.title}</b>
                      <small>{x.company_name}</small>
                      <small>
                        {x.description?.slice(0, 130)}
                        {x.description?.length > 130 ? "…" : ""}
                      </small>
                    </td>
                    <td>
                      {x.location}
                      <small>{x.employment_type}</small>
                    </td>
                    <td>{stamp(x.created)}</td>
                    <td>{pill(x.status)}</td>
                    <td>
                      <div className="ad-row-actions">
                        {x.status === "pending_review" && (
                          <>
                            <button
                              className="ad-mini-primary"
                              disabled={!x.verified}
                              onClick={() =>
                                openAction("job", x.id, "published")
                              }
                            >
                              Approve
                            </button>
                            <button
                              onClick={() =>
                                openAction("job", x.id, "needs_changes")
                              }
                            >
                              Request changes
                            </button>
                            <button
                              className="ad-danger-link"
                              onClick={() =>
                                openAction("job", x.id, "rejected")
                              }
                            >
                              Reject
                            </button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                )),
                "No jobs are awaiting moderation.",
              )}
            </section>
          )}
          {page === "assessments" && (
            <section className="ad-panel">
              <div className="ad-panel-head">
                <div>
                  <h2>Assessment review</h2>
                  <p>
                    Review the automated score alongside every question and the
                    candidate's submitted response before recording a human
                    decision.
                  </p>
                </div>
                <span className="ad-count">
                  {rows("assessments").length} attempts
                </span>
              </div>
              <div className="ad-info-banner">
                MCQs and reference-answer SQL are graded deterministically.
                Descriptive, scenario, coding and analytical answers receive a
                stored-rubric draft (keyword coverage + reference similarity)
                with partial marks. Every draft waits for
                your approval and can be edited before it affects the score.
                Academic and honesty approval together publish the candidate's learning path
                and Skill Passport. Invalidating or
                requesting more information revokes that passport. Older attempts
                may not contain saved raw answers.
              </div>
              <div className="ad-toolbar">
                <input
                  placeholder="Search candidate or email…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </div>
              {adminPager("assessments")}
              {table(
                [
                  "Candidate",
                  "Assessment",
                  "Score",
                  "Review status",
                  "Report / action",
                ],
                filtered(rows("assessments"), [
                  "candidate_name",
                  "email",
                  "kind",
                ]).map((x) => (
                  <tr key={x.id}>
                    <td>
                      <b>{x.candidate_name}</b>
                      <small>{x.email}</small>
                    </td>
                    <td>
                      {x.kind}
                      <small>{stamp(x.finished)}</small>
                    </td>
                    <td>
                      <strong>
                        {x.result?.overall ?? "—"}
                        <small>/ 100</small>
                      </strong>
                    </td>
                    <td>
                      {pill(x.publication?.stage || x.review_decision || "pending_review")}
                      {x.review_response && (
                        <small className="ad-review-response">
                          Candidate reply ({stamp(x.review_response.created)}): {x.review_response.note}
                        </small>
                      )}
                    </td>
                    <td>
                      <div className="ad-row-actions">
                        <button onClick={() => openReport(x)}>
                          View report
                        </button>
                        <button
                          className="ad-mini-primary"
                          onClick={() =>
                            openAction("assessment", x.id, "approved")
                          }
                        >
                          Approve academic marks
                        </button>
                        <button
                          onClick={() =>
                            openAction("assessment", x.id, "needs_more_info")
                          }
                        >
                          More info
                        </button>
                        <button
                          className="ad-danger-link"
                          onClick={() =>
                            openAction("assessment", x.id, "invalidated")
                          }
                        >
                          Invalid
                        </button>
                      </div>
                    </td>
                  </tr>
                )),
                "No completed assessments in the review list.",
              )}
              <div className="ad-panel-head ad-subhead">
                <div>
                  <h2>Company assessment requests</h2>
                  <p>
                    Company-authored phase-two requests require platform
                    approval.
                  </p>
                </div>
              </div>
              {table(
                ["Request", "Company / candidate", "Status", "Review"],
                rows("phaseTwo").map((x) => (
                  <tr key={x.id}>
                    <td>
                      <b>{x.title}</b>
                      <small>{x.requirements}</small>
                    </td>
                    <td>
                      {x.company_name}
                      <small>
                        {x.candidate_name} · {x.job_title}
                      </small>
                    </td>
                    <td>{pill(x.status)}</td>
                    <td>
                      {x.status === "pending_platform_review" && (
                        <div className="ad-row-actions">
                          <button
                            className="ad-mini-primary"
                            onClick={() =>
                              openAction("phase", x.id, "approved")
                            }
                          >
                            Approve
                          </button>
                          <button
                            onClick={() =>
                              openAction("phase", x.id, "needs_changes")
                            }
                          >
                            Request changes
                          </button>
                          <button
                            className="ad-danger-link"
                            onClick={() =>
                              openAction("phase", x.id, "rejected")
                            }
                          >
                            Reject
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                )),
                "No company assessment requests.",
              )}
            </section>
          )}
          {page === "integrity" && (
            <section className="ad-panel">
              <div className="ad-panel-head">
                <div>
                  <h2>Exam integrity monitoring</h2>
                  <p>
                    All recorded attempts, including active attempts. Open a row
                    to inspect event evidence and the explainable trust
                    assessment.
                  </p>
                </div>
                <span className="ad-count">
                  {rows("integrity").length} attempts
                </span>
              </div>
              <div className="ad-toolbar">
                <input
                  placeholder="Search candidate, email or attempt ID…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
                <select
                  value={integrityStatus}
                  onChange={(e) => setIntegrityStatus(e.target.value)}
                >
                  <option value="all">All statuses</option>
                  <option value="active">In progress</option>
                  <option value="done">Completed</option>
                </select>
                <select
                  value={integrityKind}
                  onChange={(e) => setIntegrityKind(e.target.value)}
                >
                  <option value="all">All assessment types</option>
                  <option value="pre">Initial</option>
                  <option value="post">Retest</option>
                </select>
                <select
                  value={integrityTrust}
                  onChange={(e) => setIntegrityTrust(e.target.value)}
                >
                  <option value="all">All trust labels</option>
                  <option value="High trust">High trust</option>
                  <option value="Medium">Medium</option>
                  <option value="Needs review">Needs review</option>
                  <option value="Not scored">Not scored</option>
                </select>
              </div>
              {adminPager("integrity")}
              {table(
                [
                  "Candidate",
                  "Attempt",
                  "Status",
                  "Score",
                  "Trust",
                  "Honesty",
                  "Events",
                  "Review",
                  "Details",
                ],
                rows("integrity")
                  .filter(
                    (x) =>
                      (integrityStatus === "all" ||
                        x.status === integrityStatus) &&
                      (integrityKind === "all" || x.kind === integrityKind) &&
                      (integrityTrust === "all" || x.trust === integrityTrust),
                  )
                  .filter((x) =>
                    [x.candidate_name, x.email, x.id].some((v) =>
                      String(v || "")
                        .toLowerCase()
                        .includes(search.toLowerCase()),
                    ),
                  )
                  .map((x) => (
                    <tr key={x.id}>
                      <td>
                        <b>{x.candidate_name}</b>
                        <small>{x.email}</small>
                      </td>
                      <td>
                        <code>{x.id}</code>
                        <small>{stamp(x.finished || x.started)}</small>
                      </td>
                      <td>{pill(x.status)}</td>
                      <td>
                        {x.result?.overall ?? "—"}
                        {x.result && <small>/ 100</small>}
                      </td>
                      <td>
                        {pill(x.trust || "Not scored")}
                        <small>{x.result?.trust_points ?? "—"} points</small>
                      </td>
                      <td>
                        <b>{x.honesty_score ?? "—"}</b>
                        <small>{x.honesty_status || "pending"}</small>
                      </td>
                      <td>{x.event_count ?? 0}</td>
                      <td>{pill(x.review_decision || "not_reviewed")}</td>
                      <td>
                        <button
                          className="ad-action-btn"
                          onClick={() => openIntegrityDetail(x.id)}
                        >
                          Inspect →
                        </button>
                      </td>
                    </tr>
                  )),
                "No exam attempts match these filters.",
              )}
            </section>
          )}
          {page === "appeals" && (
            <section className="ad-panel">
              <div className="ad-panel-head">
                <div>
                  <h2>Candidate appeals</h2>
                  <p>
                    Appeals should be reviewed independently where staffing
                    permits.
                  </p>
                </div>
                <span className="ad-count">
                  {rows("appeals").length} appeals
                </span>
              </div>
              {adminPager("appeals")}
              {table(
                ["Candidate", "Attempt", "Appeal note", "Status", "Outcome"],
                rows("appeals").map((x) => (
                  <tr key={x.attempt_id || x.id}>
                    <td>
                      <b>{x.candidate_name}</b>
                      <small>{x.email}</small>
                    </td>
                    <td>
                      <code>{x.attempt_id}</code>
                      <small>{stamp(x.finished)}</small>
                      {x.appealed_outcome && (
                        <small>
                          Appealed outcome:{" "}
                          {x.appealed_outcome === "honesty_rejected" ? "Integrity review rejected" : x.appealed_outcome === "invalidated" ? "Academic review rejected" : String(x.appealed_outcome).replaceAll("_", " ")}
                        </small>
                      )}
                    </td>
                    <td>{x.appeal}{x.original_reviewer_name && <small>Reviewed by {x.original_reviewer_name}</small>}</td>
                    <td>
                      {pill(x.decision || "open")}
                      {x.decision && x.appeal_reviewer_name && <small>Decided by {x.appeal_reviewer_name} · {stamp(x.decided_at)}</small>}
                    </td>
                    <td>
                      {x.open ? (
                        x.can_decide ? (
                          <div className="ad-row-actions">
                            <button
                              className="ad-mini-primary"
                              onClick={() =>
                                openAction("appeal", x.attempt_id, "upheld")
                              }
                            >
                              Uphold
                            </button>
                            <button
                              onClick={() =>
                                openAction("appeal", x.attempt_id, "overturned")
                              }
                            >
                              Overturn
                            </button>
                            <button
                              onClick={() =>
                                openAction(
                                  "appeal",
                                  x.attempt_id,
                                  "needs_more_info",
                                )
                              }
                            >
                              More info
                            </button>
                          </div>
                        ) : (
                          <small>{x.blocked_reason || "Another administrator must decide this appeal."}</small>
                        )
                      ) : (
                        <small>Final decision recorded. No further action is required.</small>
                      )}
                    </td>
                  </tr>
                )),
                "No candidate appeals have been submitted.",
              )}
            </section>
          )}
          {page === "questions" &&
            (() => {
              const qdata = data.questions || {},
                cats = qdata.categories || [],
                allQuestions = qdata.items || [];
              const stagingItems = data.staging?.items || [],
                selectedCount = Object.keys(stagingSelected).filter(
                  (k) => stagingSelected[k],
                ).length;
              const visibleQuestions = allQuestions.filter(
                (q) =>
                  (questionCategory === "all" ||
                    q.category_id === questionCategory) &&
                  (questionStatus === "all" || q.status === questionStatus) &&
                  [q.question_text, q.subcategory, q.question_type, q.id].some(
                    (v) =>
                      String(v || "")
                        .toLowerCase()
                        .includes(questionQuery.toLowerCase()),
                  ),
              );
              const activeCategory = cats.find(
                (c) => c.id === questionCategory,
              );
              return (
                <section className="ad-question-workspace">
                  <div className="ad-question-hero">
                    <div>
                      <div className="ad-eyebrow">
                        ASSESSMENT CONTENT · GOVERNANCE
                      </div>
                      <h2>Build a stronger question bank.</h2>
                      <p>
                        Organise questions across built-in and custom skill
                        domains. New topics are created automatically when
                        imported content introduces them.
                      </p>
                      <div className="ad-question-hero-tags">
                        <span>Database-backed</span>
                        <span>Versioned edits</span>
                        <span>Bulk import</span>
                      </div>
                    </div>
                    <div className="ad-question-hero-icon">
                      Q<span>+</span>
                    </div>
                  </div>
                  <div className="ad-category-manager">
                    <div>
                      <span className="ad-eyebrow">Dynamic topic library</span>
                      <h3>Manage question categories</h3>
                      <p>
                        Use existing topics or create a new one. Unknown source
                        topics are added automatically during preview and
                        import.
                      </p>
                    </div>
                    <form onSubmit={createQuestionCategory}>
                      <input
                        value={categoryDraft}
                        onChange={(e) => setCategoryDraft(e.target.value)}
                        maxLength={80}
                        placeholder="New category name (e.g. Cloud Computing)"
                        aria-label="New category name"
                      />
                      <button
                        className="ad-q-add-btn"
                        disabled={
                          categoryBusy || categoryDraft.trim().length < 2
                        }
                      >
                        {categoryBusy ? "Creating…" : "＋ Create category"}
                      </button>
                    </form>
                    <div className="ad-category-chips">
                      {cats.map((c) => (
                        <button
                          type="button"
                          key={c.id}
                          className={questionCategory === c.id ? "on" : ""}
                          onClick={() => setQuestionCategory(c.id)}
                        >
                          <b>{c.name}</b>
                          <span>{c.count || 0}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="ad-graphrag-panel">
                    <div>
                      <span className="ad-eyebrow">
                        OPTIONAL GRAPH RETRIEVAL · EXPERIMENTAL
                      </span>
                      <h3>CV + Fundamental GraphRAG</h3>
                      <p>
                        {data.graphrag?.active_question_count ?? "—"} active
                        questions · Fundamental{" "}
                        {data.graphrag?.fundamental_selected_count ?? 0}/25 ·
                        CV skills{" "}
                        {data.graphrag?.covered_skill_count ?? 0} covered /{" "}
                        {data.graphrag?.uncovered_skill_count ?? 0} pending ·
                        Meilisearch{" "}
                        {data.graphrag?.meilisearch_configured
                          ? "configured"
                          : "not connected"}{" "}
                        · Neo4j{" "}
                        {data.graphrag?.neo4j_configured
                          ? "configured"
                          : "not connected"}
                      </p>
                      <small>
                        This 25-question + CV-skill blueprint uses the same skill
                        catalogue as the candidate profile and skill journey.
                        Skills without a complete per-difficulty quota are
                        reported below; no questions are fabricated.
                      </small>
                      {!!data.graphrag?.uncovered_skills?.length && (
                        <small>
                          Pending bank coverage:{" "}
                          {data.graphrag.uncovered_skills
                            .slice(0, 6)
                            .map((x) => x.label)
                            .join(" · ")}
                        </small>
                      )}
                      {data.graphrag?.fundamental_shortages?.length > 0 && (
                        <small>
                          Missing:{" "}
                          {data.graphrag.fundamental_shortages
                            .slice(0, 4)
                            .map(
                              (x) => x.format || x.topic + " " + x.difficulty,
                            )
                            .join(" · ")}
                        </small>
                      )}
                    </div>
                    <button
                      className="ad-q-add-btn"
                      onClick={async () => {
                        try {
                          const result = await api(
                            "/admin/assessment/graphrag/reindex",
                            { method: "POST" },
                          );
                          flash(
                            "Graph index updated · " +
                              result.active_questions +
                              " approved questions.",
                          );
                          await load();
                        } catch (x) {
                          setError(x.message || "Graph index update failed.");
                        }
                      }}
                    >
                      Rebuild search + graph index
                    </button>
                  </div>
                  <div className="ad-question-stats">
                    <article>
                      <span className="ad-qstat-icon" aria-hidden="true"><WorkspaceIcon name="list" size={18} /></span>
                      <div>
                        <small>Total questions</small>
                        <strong>
                          {qdata.summary?.total ?? allQuestions.length}
                        </strong>
                        <em>Across all categories</em>
                      </div>
                    </article>
                    <article>
                      <span className="ad-qstat-icon ad-qstat-green" aria-hidden="true"><WorkspaceIcon name="check" size={18} /></span>
                      <div>
                        <small>Active</small>
                        <strong>{qdata.summary?.active ?? 0}</strong>
                        <em>Ready for use</em>
                      </div>
                    </article>
                    <article>
                      <span className="ad-qstat-icon ad-qstat-amber" aria-hidden="true"><WorkspaceIcon name="edit" size={18} /></span>
                      <div>
                        <small>Draft</small>
                        <strong>{qdata.summary?.draft ?? 0}</strong>
                        <em>Awaiting approval</em>
                      </div>
                    </article>
                    <article>
                      <span className="ad-qstat-icon ad-qstat-grey" aria-hidden="true"><WorkspaceIcon name="inbox" size={18} /></span>
                      <div>
                        <small>Archived</small>
                        <strong>{qdata.summary?.archived ?? 0}</strong>
                        <em>Retained for history</em>
                      </div>
                    </article>
                    <article>
                      <span className="ad-qstat-icon ad-qstat-grey">◌</span>
                      <div>
                        <small>Practice</small>
                        <strong>{qdata.summary?.practice ?? 0}</strong>
                        <em>Learning only, never scored</em>
                      </div>
                    </article>
                  </div>
                  <div className="ad-question-section-head">
                    <div>
                      <h3>Explore by category</h3>
                      <p>Select a domain to view its question inventory.</p>
                    </div>
                    <button
                      className="ad-q-add-btn"
                      onClick={() => openQuestionEditor()}
                    >
                      ＋ Create question
                    </button>
                  </div>
                  <div className="ad-category-grid">
                    {cats.map((c, i) => (
                      <button
                        key={c.id}
                        className={
                          "ad-category-card " +
                          (questionCategory === c.id ? "selected" : "")
                        }
                        onClick={() =>
                          setQuestionCategory(
                            questionCategory === c.id ? "all" : c.id,
                          )
                        }
                      >
                        <span className={"ad-category-icon ad-cat-" + (i + 1)}>
                          {c.icon}
                        </span>
                        <span className="ad-category-copy">
                          <b>{c.name}</b>
                          <small>{c.description}</small>
                        </span>
                        <strong>
                          {c.count || 0}
                          <small>questions</small>
                        </strong>
                      </button>
                    ))}
                  </div>
                  <div className="ad-question-panel">
                    <div className="ad-question-section-head">
                      <div>
                        <h3>
                          {activeCategory
                            ? activeCategory.name + " questions"
                            : "All questions"}
                        </h3>
                        <p>
                          {activeCategory
                            ? activeCategory.description
                            : "Browse the complete question bank and manage its lifecycle."}
                        </p>
                      </div>
                      <span className="ad-count">
                        {visibleQuestions.length} shown
                      </span>
                    </div>
                    <div className="ad-question-toolbar">
                      <label className="ad-q-search">
                        <WorkspaceIcon name="search" size={16} />
                        <input
                          value={questionQuery}
                          onChange={(e) => setQuestionQuery(e.target.value)}
                          placeholder="Search question, subcategory or ID…"
                        />
                      </label>
                      <select
                        value={questionStatus}
                        onChange={(e) => setQuestionStatus(e.target.value)}
                      >
                        <option value="all">All statuses</option>
                        <option value="active">Active</option>
                        <option value="draft">Draft</option>
                        <option value="practice">Practice (learning only)</option>
                        <option value="archived">Archived</option>
                      </select>
                      <button
                        className="ad-q-clear"
                        onClick={() => {
                          setQuestionCategory("all");
                          setQuestionStatus("all");
                          setQuestionQuery("");
                        }}
                      >
                        Reset filters
                      </button>
                    </div>
                    <div className="ad-question-list">
                      {visibleQuestions.map((q) => (
                        <article className="ad-question-row" key={q.id}>
                          <div className="ad-q-type-icon">
                            {q.question_type === "MCQ"
                              ? "☷"
                              : q.question_type.toLowerCase().includes("coding")
                                ? "</>"
                                : "✎"}
                          </div>
                          <div className="ad-question-main">
                            <div className="ad-question-meta">
                              <span>
                                {cats.find((c) => c.id === q.category_id)
                                  ?.name || q.category_id}
                              </span>
                              <i>·</i>
                              <span>{q.subcategory}</span>
                              <i>·</i>
                              <span>{q.question_type}</span>
                            </div>
                            <h4>{q.question_text}</h4>
                            <div className="ad-question-tags">
                              <span
                                className={
                                  "ad-q-difficulty ad-q-" +
                                  q.difficulty_level.toLowerCase()
                                }
                              >
                                {q.difficulty_level}
                              </span>
                              <span>{q.marks} marks</span>
                              <span>
                                {Math.round(q.time_allocation / 60)} min
                              </span>
                              <span>v{q.version}</span>
                            </div>
                          </div>
                          <div className="ad-question-actions">
                            {pill(q.status === "practice" ? "practice (learning only)" : q.status)}
                            <button onClick={() => openQuestionEditor(q)}>
                              Edit ↗
                            </button>
                          </div>
                        </article>
                      ))}
                      {!visibleQuestions.length && (
                        <div className="ad-q-empty">
                          <span aria-hidden="true"><WorkspaceIcon name="search" size={20} /></span>
                          <b>No questions found</b>
                          <p>
                            Try another category or adjust your search filters.
                          </p>
                          <button onClick={() => openQuestionEditor()}>
                            Create the first question
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="ad-question-import">
                    <div>
                      <span className="ad-q-upload-icon">⇧</span>
                      <div>
                        <h3>Import questions in bulk</h3>
                        <p>
                          Upload CSV, JSON or text-based PDF. Preview and
                          validate records before saving them to the database.
                        </p>
                        <small>
                          Maximum 5 MB · Up to 1,000 questions per import
                        </small>
                      </div>
                    </div>
                    <form onSubmit={previewQuestionImport}>
                      <label className="ad-q-file">
                        <input
                          type="file"
                          accept=".csv,.json,.pdf,application/pdf,text/csv,application/json"
                          onChange={(e) => {
                            setImportFile(e.target.files?.[0] || null);
                            setImportPreview(null);
                          }}
                        />
                        <span>＋ Choose file</span>
                        <b>{importFile?.name || "No file selected"}</b>
                      </label>
                      <select
                        value={importCategory}
                        onChange={(e) => setImportCategory(e.target.value)}
                      >
                        <option value="">
                          Choose default category (if file has no category)
                        </option>
                        {cats.map((c) => (
                          <option key={c.id} value={c.id}>{c.name}</option>
                        ))}
                      </select>
                      <button
                        className="ad-q-add-btn"
                        disabled={!importFile || importBusy}
                      >
                        {importBusy ? "Preparing preview…" : "Preview import →"}
                      </button>
                    </form>
                    {importResult && (
                      <div className="ad-import-preview" role="status" aria-live="polite">
                        <div className="ad-import-preview-head">
                          <strong>
                            Import {importResult.status ? String(importResult.status).replaceAll("_", " ") : "complete"} · {(importResult.imported_ids || []).length || importResult.added || 0} imported as Draft
                          </strong>
                          <button type="button" className="ad-q-clear" onClick={() => setImportResult(null)}>Dismiss</button>
                        </div>
                        <p className="ad-footnote">Imported questions are always saved as Draft. Review and approve them before they can be used in an assessment.</p>
                        {(importResult.rejected_items || []).length > 0 && (
                          <div className="ad-import-items">
                            <b>Rejected rows ({importResult.rejected_items.length})</b>
                            {importResult.rejected_items.map((item) => (
                              <div key={item.index}>
                                <b>Row {Number(item.index) + 1}</b>{" "}
                                <small>{String(importResult.submitted?.[item.index]?.question_text || "").slice(0, 90)}</small>
                                <small className="err">{(item.errors || []).map((e) => (typeof e === "string" ? e : e?.message || JSON.stringify(e))).join("; ")}</small>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                    {importPreview && (
                      <div className="ad-import-preview">
                        <div className="ad-import-preview-head">
                          <div>
                            <b>Import preview</b>
                            <small>
                              {importPreview.filename} · Review before
                              committing
                            </small>
                          </div>
                          <button type="button" aria-label="Close preview" onClick={() => setImportPreview(null)}>
                            ×
                          </button>
                        </div>
                        <div className="ad-import-counts">
                          <span>
                            <b>{importPreview.total}</b>Total
                          </span>
                          <span>
                            <b>{importPreview.valid}</b>Valid
                          </span>
                          <span>
                            <b>{importPreview.invalid}</b>Invalid / duplicate
                          </span>
                        </div>
                        {importPreview.pdf_note && (
                          <p className="ad-q-pdf-note">
                            {importPreview.pdf_note}
                          </p>
                        )}
                        <div className="ad-import-items">
                          {importPreview.items.slice(0, 8).map((q, i) => (
                            <div key={i}>
                              <b>
                                {i + 1}.{" "}
                                {q.question_text.slice(0, 150) ||
                                  "Empty question"}
                              </b>
                              <small>
                                {q.category_id} · {q.difficulty_level} ·{" "}
                                {q.question_type} · {q.time_allocation}s
                              </small>
                              {q.errors.length > 0 && (
                                <em>{q.errors.join(" ")}</em>
                              )}
                            </div>
                          ))}
                        </div>
                        {importPreview.items.length > 8 && (
                          <small>
                            Showing first 8 of {importPreview.items.length}{" "}
                            records.
                          </small>
                        )}
                        <button
                          className="ad-q-add-btn"
                          disabled={!importPreview.valid || importBusy}
                          onClick={commitQuestionImport}
                        >
                          {importBusy
                            ? "Importing…"
                            : "Import " +
                              importPreview.valid +
                              " valid questions"}
                        </button>
                      </div>
                    )}
                  </div>
                  <div className="ad-question-import ad-scrape-panel">
                    <div>
                      <span className="ad-q-upload-icon">⌖</span>
                      <div>
                        <h3>Scrape questions from a URL</h3>
                        <p>
                          Paste a public page URL (JSON-LD Quiz/FAQ, or a
                          numbered MCQ list). Questions are extracted,
                          preprocessed into the question-bank format and staged
                          for your review before saving.
                        </p>
                        <small>
                          If a site blocks automated requests (403 / Cloudflare),
                          open it in your browser and use “Paste HTML” instead.
                        </small>
                      </div>
                    </div>
                    <form onSubmit={runScrape}>
                      <div className="ad-scrape-tabs">
                        <button
                          type="button"
                          className={scrapeMode === "url" ? "on" : ""}
                          onClick={() => setScrapeMode("url")}
                        >
                          From URL
                        </button>
                        <button
                          type="button"
                          className={scrapeMode === "html" ? "on" : ""}
                          onClick={() => setScrapeMode("html")}
                        >
                          Paste HTML
                        </button>
                      </div>
                      {scrapeMode === "url" ? (
                        <input
                          className="ad-scrape-input"
                          type="url"
                          placeholder="https://…"
                          value={scrapeUrl}
                          onChange={(e) => setScrapeUrl(e.target.value)}
                        />
                      ) : (
                        <textarea
                          className="ad-scrape-textarea"
                          placeholder="Paste the page's HTML here. In your browser: right-click → View Page Source (or Ctrl+U), copy everything, and paste it here."
                          value={scrapeHtml}
                          onChange={(e) => setScrapeHtml(e.target.value)}
                        />
                      )}
                      <select
                        value={scrapeCategory}
                        onChange={(e) => {
                          setScrapeCategory(e.target.value);
                          setScrapeNewCategory("");
                        }}
                      >
                        <option value="">Auto-detect topic from question</option>
                        {cats.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.name}
                          </option>
                        ))}
                      </select>
                      <input
                        className="ad-scrape-input ad-scrape-sub"
                        type="text"
                        placeholder="Or enter a new category (optional)"
                        value={scrapeNewCategory}
                        onChange={(e) => setScrapeNewCategory(e.target.value)}
                      />
                      <input
                        className="ad-scrape-input ad-scrape-sub"
                        type="text"
                        placeholder="Subcategory (optional)"
                        value={scrapeSubcategory}
                        onChange={(e) => setScrapeSubcategory(e.target.value)}
                      />
                      <button
                        className="ad-q-add-btn"
                        disabled={
                          (scrapeMode === "url"
                            ? !scrapeUrl.trim()
                            : !scrapeHtml.trim()) || scrapeBusy
                        }
                      >
                        {scrapeBusy
                          ? "Scraping…"
                          : scrapeMode === "url"
                            ? "Scrape URL →"
                            : "Extract from HTML →"}
                      </button>
                    </form>
                    <div className="ad-staging">
                      <div className="ad-staging-head">
                        <div>
                          <b>Staging review</b>
                          <small>
                            {stagingItems.length} staged ·{" "}
                            {
                              stagingItems.filter(
                                (q) => !q.errors?.length && !q.duplicate,
                              ).length
                            }{" "}
                            ready to import · {selectedCount} selected
                          </small>
                        </div>
                        <div className="ad-staging-actions">
                          {stagingItems.some(
                            (q) => !q.errors?.length && !q.duplicate,
                          ) && (
                            <button
                              className="ad-q-clear"
                              onClick={() =>
                                setStagingSelected(
                                  Object.fromEntries(
                                    stagingItems
                                      .filter(
                                        (q) => !q.errors?.length && !q.duplicate,
                                      )
                                      .map((q) => [q.id, true]),
                                  ),
                                )
                              }
                              disabled={stagingBusy}
                            >
                              Select all valid
                            </button>
                          )}
                          {selectedCount > 0 && (
                            <button
                              className="ad-q-clear"
                              onClick={() => setStagingSelected({})}
                              disabled={stagingBusy}
                            >
                              Clear selection
                            </button>
                          )}
                          {selectedCount > 0 && (
                            <button
                              className="ad-q-add-btn"
                              onClick={commitStaging}
                              disabled={stagingBusy}
                            >
                              {stagingBusy
                                ? "Importing…"
                                : "Import " + selectedCount + " selected"}
                            </button>
                          )}
                          {stagingItems.length > 0 && (
                            <button
                              className="ad-q-clear"
                              onClick={clearStaging}
                              disabled={stagingBusy}
                            >
                              Clear staging
                            </button>
                          )}
                        </div>
                      </div>
                      {!stagingItems.length && (
                        <div className="ad-q-empty">
                          <span>⌖</span>
                          <b>No staged questions</b>
                          <p>Scrape a URL above to populate the staging table.</p>
                        </div>
                      )}
                      {stagingItems.length > 0 && (
                        <div className="ad-staging-list">
                          {stagingItems.map((q) => {
                            const sel = !!stagingSelected[q.id],
                              invalid = q.errors?.length > 0,
                              dup = q.duplicate;
                            return (
                              <article
                                className={
                                  "ad-staging-row" +
                                  (sel ? " selected" : "") +
                                  (invalid || dup ? " locked" : "")
                                }
                                key={q.id}
                              >
                                <label className="ad-staging-check">
                                  <input
                                    type="checkbox"
                                    checked={sel}
                                    disabled={invalid || dup}
                                    onChange={(e) =>
                                      toggleStaging(q.id, e.target.checked)
                                    }
                                  />
                                  <span />
                                </label>
                                <div className="ad-staging-main">
                                  <div className="ad-question-meta">
                                    <span>
                                      {cats.find((c) => c.id === q.category_id)
                                        ?.name ||
                                        q.category_id ||
                                        "—"}
                                    </span>
                                    <i>·</i>
                                    <span>{q.subcategory}</span>
                                    <i>·</i>
                                    <span>{q.question_type}</span>
                                    <i>·</i>
                                    <span>{q.difficulty_level}</span>
                                  </div>
                                  <h4>{q.question_text}</h4>
                                  {q.options?.length > 0 && (
                                    <div className="ad-staging-options">
                                      {q.options.map((o, i) => (
                                        <span
                                          key={i}
                                          className={
                                            q.correct_answer &&
                                            o === q.correct_answer
                                              ? "ad-staging-answer"
                                              : ""
                                          }
                                        >
                                          {String.fromCharCode(65 + i)}. {o}
                                        </span>
                                      ))}
                                    </div>
                                  )}
                                  {!q.options?.length && q.correct_answer && (
                                    <small className="ad-staging-answer-line">
                                      Answer: {q.correct_answer}
                                    </small>
                                  )}
                                  {q.explanation && (
                                    <small>Explanation: {q.explanation}</small>
                                  )}
                                  {dup && (
                                    <em className="ad-staging-warn">
                                      Duplicate of an existing question — remove
                                      or edit the source before importing.
                                    </em>
                                  )}
                                  {!invalid && !dup && (
                                    <small className="ad-staging-ready">
                                      Ready for review · imports as Draft
                                    </small>
                                  )}
                                  {q.marks && (
                                    <small>
                                      {q.marks} mark(s) · {q.time_allocation}s ·
                                      {q.status || "draft"} · Added by{" "}
                                      {q.created_by || "Admin"}
                                    </small>
                                  )}
                                  {invalid && (
                                    <em className="ad-staging-warn">
                                      {q.errors.join(" ")}
                                    </em>
                                  )}
                                  <small className="ad-staging-src">
                                    Source: {q.source_url}
                                  </small>
                                </div>
                                <button
                                  className="ad-staging-del"
                                  onClick={() => deleteStagingItem(q.id)}
                                  aria-label="Remove from staging"
                                  title="Remove from staging"
                                >
                                  ×
                                </button>
                              </article>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  </div>
                </section>
              );
            })()}
          {page === "ai" && (
            <section className="ad-two-col">
              <div className="ad-panel">
                <div className="ad-panel-head">
                  <div>
                    <h2>AI provider</h2>
                    <p>Current extraction provider configuration</p>
                  </div>
                  {pill(data.ai?.status || "unknown")}
                </div>
                <div className="ad-detail-list">
                  <div>
                    <span>Provider</span>
                    <b>{data.ai?.provider || "—"}</b>
                  </div>
                  <div>
                    <span>Model</span>
                    <b>{data.ai?.model || "—"}</b>
                  </div>
                  <div>
                    <span>API configured</span>
                    <b>{data.ai?.configured ? "Yes" : "No"}</b>
                  </div>
                  <div>
                    <span>Fallback</span>
                    <b>{data.ai?.fallback || "—"}</b>
                  </div>
                  <div>
                    <span>Usage telemetry</span>
                    <b>
                      {data.ai?.metrics_available
                        ? "Available"
                        : "Not instrumented"}
                    </b>
                  </div>
                </div>
                {data.ai?.status === "budget_exhausted" && (
                  <div className="ad-error" role="alert">
                    AI budget exhausted for this window. Paid AI calls are paused until the window resets or an admin raises the limit; rule-based fallbacks continue.
                  </div>
                )}
                {data.ai?.budget && (
                  <div className="ad-detail-list">
                    <div>
                      <span>Budget ({data.ai.budget.window || `${data.ai.budget.window_days ?? "?"} days`}){data.ai.budget.estimate ? " · estimate" : ""}</span>
                      <b>
                        ${Number(data.ai.budget.spent_usd ?? 0).toFixed(2)} of ${Number(data.ai.budget.limit_usd ?? 0).toFixed(2)}
                      </b>
                    </div>
                    <div>
                      <span>Remaining</span>
                      <b>${Number(data.ai.budget.remaining_usd ?? 0).toFixed(2)}</b>
                    </div>
                  </div>
                )}
                {Array.isArray(data.ai?.providers) && data.ai.providers.length > 0 && (
                  <div className="ad-table-wrap">
                    <table className="ad-table">
                      <thead><tr><th>Provider</th><th>Model</th><th>Configured</th></tr></thead>
                      <tbody>
                        {data.ai.providers.map((p) => (
                          <tr key={p.provider}>
                            <td>{p.provider}</td>
                            <td>{p.model || "—"}</td>
                            <td>{p.configured ? "Yes" : "No"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
              <div className="ad-panel">
                <h2>Operations notes</h2>
                <p>
                  {data.ai?.note || "AI operations telemetry is not connected."}
                </p>
                <div className="ad-info-banner">
                  No AI-generated score or hiring decision is authorised. AI
                  output must be validated and grounded in source data.
                </div>
              </div>
            </section>
          )}
          {page === "agent" && <Suspense fallback={<WorkspaceLoading />}><AgentConsole /></Suspense>}
          {page === "billing" && (
            <section className="ad-billing">
              <div className="ad-billing-hero">
                <div>
                  <span className="ad-eyebrow">Finance operations</span>
                  <h2>Billing & payments</h2>
                  <p>
                    Manage plans, review payment records, refunds and retake
                    credits.
                  </p>
                </div>
                <div className="ad-billing-provider">
                  <span className="ad-provider-mark">৳</span>
                  <div>
                    <b>{data.billing?.provider || "SSLCommerz"}</b>
                    <small>
                      {data.billing?.live_enabled
                        ? "Live mode"
                        : data.billing?.provider_configured
                          ? "Credentials detected · live disabled"
                          : "Gateway not connected"}
                    </small>
                  </div>
                  <span
                    className={
                      data.billing?.live_enabled
                        ? "ad-status-live"
                        : "ad-status-pending"
                    }
                  >
                    {data.billing?.live_enabled ? "Live" : "Not live"}
                  </span>
                </div>
              </div>
              <div className="ad-billing-notice">
                <b>Checkout is safely disabled.</b>
                <span>
                  {data.billing?.note ||
                    "Merchant approval, credentials and verified callbacks are required before accepting payments."}
                </span>
              </div>
              <div className="ad-billing-metrics">
                <article>
                  <small>Confirmed paid invoices</small>
                  <strong>{data.billing?.summary?.paid_invoices ?? 0}</strong>
                  <span>Verified records only</span>
                </article>
                <article>
                  <small>Gross confirmed payments</small>
                  <strong>
                    ৳
                    {(
                      (data.billing?.summary?.gross_paid_minor || 0) / 100
                    ).toLocaleString("en-BD", {
                      minimumFractionDigits: 2,
                      maximumFractionDigits: 2,
                    })}
                  </strong>
                  <span>BDT minor units converted</span>
                </article>
                <article>
                  <small>Awaiting payment</small>
                  <strong>
                    {data.billing?.summary?.pending_invoices ?? 0}
                  </strong>
                  <span>Not counted as revenue</span>
                </article>
                <article>
                  <small>Refund requests</small>
                  <strong>{data.billing?.summary?.refund_requests ?? 0}</strong>
                  <span>Awaiting Finance review</span>
                </article>
              </div>
              <Suspense fallback={<WorkspaceLoading />}><AiUsagePanel /></Suspense>
              <div className="ad-panel">
                <div className="ad-panel-head">
                  <div>
                    <h3>Pricing plans</h3>
                    <p>
                      New plans are saved inactive. Configure final pricing
                      before launch.
                    </p>
                  </div>
                  <span className="ad-count">
                    {data.billing?.plans?.length || 0} plans
                  </span>
                </div>
                <div className="ad-table-wrap">
                  <table className="ad-table">
                    <thead>
                      <tr>
                        <th>Plan</th>
                        <th>Price</th>
                        <th>Billing cycle</th>
                        <th>Retake credits</th>
                        <th>Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(data.billing?.plans || []).map((p) => (
                        <tr key={p.id}>
                          <td>
                            <b>{p.name}</b>
                            <small>{p.description || "—"}</small>
                          </td>
                          <td>
                            ৳
                            {(p.amount_minor / 100).toLocaleString("en-BD", {
                              minimumFractionDigits: 2,
                            })}
                          </td>
                          <td>{p.interval}</td>
                          <td>{p.retake_credits}</td>
                          <td>{pill(p.active ? "active" : "inactive")}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {!(data.billing?.plans || []).length && (
                  <div className="ad-billing-empty">
                    No pricing plans have been configured yet. Final prices
                    remain intentionally unset.
                  </div>
                )}
              </div>
              <div className="ad-two-col ad-billing-lists">
                <div className="ad-panel">
                  <div className="ad-panel-head">
                    <div>
                      <h3>Recent invoices</h3>
                      <p>Only verified successful payments count as paid.</p>
                    </div>
                    <span className="ad-count">
                      {data.billing?.invoices?.length || 0}
                    </span>
                  </div>
                  {(data.billing?.invoices || []).length ? (
                    <div className="ad-table-wrap">
                      <table className="ad-table">
                        <thead>
                          <tr>
                            <th>Invoice</th>
                            <th>Customer</th>
                            <th>Amount</th>
                            <th>Status</th>
                          </tr>
                        </thead>
                        <tbody>
                          {data.billing.invoices.slice(0, 8).map((x) => (
                            <tr key={x.id}>
                              <td>{x.id.slice(0, 10)}</td>
                              <td>{x.customer_email || "—"}</td>
                              <td>৳{(x.amount_minor / 100).toFixed(2)}</td>
                              <td>{pill(x.status)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <div className="ad-billing-empty">
                      No invoices recorded.
                    </div>
                  )}
                </div>
                <div className="ad-panel">
                  <div className="ad-panel-head">
                    <div>
                      <h3>Refund queue</h3>
                      <p>Approval is not a completed refund.</p>
                    </div>
                    <span className="ad-count">
                      {data.billing?.refunds?.length || 0}
                    </span>
                  </div>
                  {(data.billing?.refunds || []).length ? (
                    <div className="ad-table-wrap">
                      <table className="ad-table">
                        <thead>
                          <tr>
                            <th>Request</th>
                            <th>Customer</th>
                            <th>Amount</th>
                            <th>Status</th>
                          </tr>
                        </thead>
                        <tbody>
                          {data.billing.refunds.slice(0, 8).map((x) => (
                            <tr key={x.id}>
                              <td>{x.id.slice(0, 10)}</td>
                              <td>{x.customer_email || "—"}</td>
                              <td>৳{(x.amount_minor / 100).toFixed(2)}</td>
                              <td>{pill(x.status)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <div className="ad-billing-empty">No refund requests.</div>
                  )}
                </div>
              </div>
              <div className="ad-panel">
                <div className="ad-panel-head">
                  <div>
                    <h3>Retake credit ledger</h3>
                    <p>
                      Append-only entries; balance changes are traceable to an
                      actor and reason.
                    </p>
                  </div>
                  <span className="ad-count">
                    {data.billing?.ledger?.length || 0} entries
                  </span>
                </div>
                {(data.billing?.ledger || []).length ? (
                  <div className="ad-table-wrap">
                    <table className="ad-table">
                      <thead>
                        <tr>
                          <th>Customer</th>
                          <th>Change</th>
                          <th>Entry</th>
                          <th>Reason</th>
                          <th>Date</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.billing.ledger.slice(0, 12).map((x) => (
                          <tr key={x.id}>
                            <td>{x.customer_email || x.user_id}</td>
                            <td>
                              {x.delta > 0 ? "+" : ""}
                              {x.delta}
                            </td>
                            <td>{x.entry_type}</td>
                            <td>{x.reason}</td>
                            <td>
                              {new Date(x.created * 1000).toLocaleDateString()}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <div className="ad-billing-empty">
                    No credit adjustments recorded.
                  </div>
                )}
              </div>
            </section>
          )}
          {page === "learning" && (
            <section className="ad-learning">
              <div className="ad-learning-hero">
                <div>
                  <span className="ad-eyebrow">
                    LEARNING QUALITY & RETAKE GOVERNANCE
                  </span>
                  <h2>Build a learning system candidates can trust.</h2>
                  <p>
                    Verify every resource, understand real learning progress and
                    keep retake entitlements transparent and auditable.
                  </p>
                </div>
              </div>
              <div className="ad-billing-metrics">
                <article>
                  <small>Catalogue resources</small>
                  <strong>{data.learning?.summary?.resources ?? 0}</strong>
                  <span>All catalogue statuses</span>
                </article>
                <article>
                  <small>Verified resources</small>
                  <strong>{data.learning?.summary?.verified ?? 0}</strong>
                  <span>Visible to candidates</span>
                </article>
                <article>
                  <small>Pending review</small>
                  <strong>{data.learning?.summary?.pending ?? 0}</strong>
                  <span>Awaiting curator</span>
                </article>
                <article>
                  <small>Retakes consumed</small>
                  <strong>
                    {data.learning?.summary?.retakes_consumed ?? 0}
                  </strong>
                  <span>Ledger-confirmed attempts</span>
                </article>
              </div>
              <div className="ad-panel">
                <div className="ad-panel-head">
                  <div>
                    <h3>Resource governance</h3>
                    <p>
                      New resources remain hidden from candidates until a human
                      verifies them.
                    </p>
                  </div>
                  <span className="ad-count">
                    {data.learning?.resources?.length || 0} resources
                  </span>
                </div>
                {(adminRole === "super_admin" ||
                  adminRole === "question_content_admin") && (
                  <form
                    className="ad-learning-form"
                    onSubmit={async (e) => {
                      e.preventDefault();
                      try {
                        const f = e.currentTarget;
                        await api("/admin/learning/resources", {
                          method: "POST",
                          body: {
                            topic: f.topic.value,
                            title: f.title.value,
                            provider: f.provider.value,
                            url: f.url.value,
                            language: f.language.value,
                            level: Number(f.level.value),
                            licence: f.licence.value,
                            estimated_minutes: Number(f.minutes.value),
                          },
                        });
                        f.reset();
                        flash("Resource added to the pending review queue.");
                        await load();
                      } catch (x) {
                        setError(x.message || "Could not add resource.");
                      }
                    }}
                  >
                    <label>
                      Topic
                      <input name="topic" required placeholder="e.g. python" />
                    </label>
                    <label>
                      Resource title
                      <input
                        name="title"
                        required
                        placeholder="Official Python tutorial"
                      />
                    </label>
                    <label>
                      Provider
                      <input
                        name="provider"
                        required
                        placeholder="Python Software Foundation"
                      />
                    </label>
                    <label>
                      HTTPS URL
                      <input
                        name="url"
                        type="url"
                        required
                        placeholder="https://…"
                      />
                    </label>
                    <label>
                      Language
                      <input name="language" defaultValue="en" required />
                    </label>
                    <label>
                      Level
                      <select name="level">
                        <option value="1">Beginner</option>
                        <option value="2">Intermediate</option>
                        <option value="3">Advanced</option>
                        <option value="4">Expert</option>
                        <option value="5">Specialist</option>
                      </select>
                    </label>
                    <label>
                      Licence / usage
                      <input
                        name="licence"
                        placeholder="Licence or usage note"
                      />
                    </label>
                    <label>
                      Estimated minutes
                      <input
                        name="minutes"
                        type="number"
                        min="1"
                        defaultValue="30"
                      />
                    </label>
                    <button className="ad-q-add-btn" type="submit">
                      + Add for review
                    </button>
                  </form>
                )}
                <div className="ad-table-wrap">
                  <table className="ad-table">
                    <thead>
                      <tr>
                        <th>Resource</th>
                        <th>Topic</th>
                        <th>Provider / language</th>
                        <th>Status</th>
                        <th>Last checked</th>
                        <th>Review action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(data.learning?.resources || []).map((r) => (
                        <tr key={r.id}>
                          <td>
                            <b>{r.title}</b>
                            <small>
                              <a href={r.url} target="_blank" rel="noreferrer">
                                {r.url}
                              </a>
                            </small>
                          </td>
                          <td>{r.topic}</td>
                          <td>
                            {r.provider}
                            <small>{r.language}</small>
                          </td>
                          <td>{pill(r.verification_status)}</td>
                          <td>{stamp(r.last_checked_at)}</td>
                          <td>
                            {(adminRole === "super_admin" ||
                              adminRole === "question_content_admin") && (
                              <div className="ad-learning-actions">
                                {r.verification_status !== "verified" && (
                                  <button
                                    className="ad-action-btn"
                                    onClick={() =>
                                      openAction(
                                        "learning-resource",
                                        r.id,
                                        "verified",
                                      )
                                    }
                                  >
                                    Verify
                                  </button>
                                )}
                                {r.verification_status !== "quarantined" && (
                                  <button
                                    className="ad-action-btn"
                                    onClick={() =>
                                      openAction(
                                        "learning-resource",
                                        r.id,
                                        "quarantined",
                                      )
                                    }
                                  >
                                    Quarantine
                                  </button>
                                )}
                                {r.verification_status !== "retired" && (
                                  <button
                                    className="ad-action-btn"
                                    onClick={() =>
                                      openAction(
                                        "learning-resource",
                                        r.id,
                                        "retired",
                                      )
                                    }
                                  >
                                    Retire
                                  </button>
                                )}
                              </div>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {!(data.learning?.resources || []).length && (
                    <div className="ad-billing-empty">
                      No resources in the catalogue.
                    </div>
                  )}
                </div>
              </div>
              <div className="ad-panel">
                <div className="ad-panel-head">
                  <div>
                    <h3>Retake policy</h3>
                    <p>
                      Configurable limits are applied by the backend when an
                      attempt is created.
                    </p>
                  </div>
                </div>
                {(adminRole === "super_admin" ||
                  adminRole === "finance_admin") && (
                  <form
                    className="ad-learning-policy"
                    onSubmit={async (e) => {
                      e.preventDefault();
                      try {
                        await api("/admin/learning/policy", {
                          method: "PUT",
                          body: {
                            cooldown_hours: Number(
                              e.currentTarget.cooldown.value,
                            ),
                            max_attempts_90d: Number(e.currentTarget.cap.value),
                            credits_per_attempt: Number(
                              e.currentTarget.cost.value,
                            ),
                          },
                        });
                        flash("Retake policy updated.");
                        await load();
                      } catch (x) {
                        setError(x.message || "Could not update policy.");
                      }
                    }}
                  >
                    <label>
                      Cooldown hours
                      <input
                        name="cooldown"
                        type="number"
                        min="0"
                        max="2160"
                        defaultValue={
                          data.learning?.policy?.cooldown_hours ?? 24
                        }
                      />
                    </label>
                    <label>
                      Maximum attempts / 90 days
                      <input
                        name="cap"
                        type="number"
                        min="1"
                        max="20"
                        defaultValue={
                          data.learning?.policy?.max_attempts_90d ?? 3
                        }
                      />
                    </label>
                    <label>
                      Credits per retake
                      <input
                        name="cost"
                        type="number"
                        min="1"
                        max="20"
                        defaultValue={
                          data.learning?.policy?.credits_per_attempt ?? 1
                        }
                      />
                    </label>
                    <button className="ad-q-add-btn">Save policy</button>
                  </form>
                )}
              </div>
              <div className="ad-two-col">
                <div className="ad-panel">
                  <div className="ad-panel-head">
                    <div>
                      <h3>Candidate learning progress</h3>
                      <p>Progress events from the verified catalogue.</p>
                    </div>
                  </div>
                  <div className="ad-table-wrap">
                    <table className="ad-table">
                      <thead>
                        <tr>
                          <th>Candidate</th>
                          <th>Resource</th>
                          <th>Topic</th>
                          <th>Status</th>
                          <th>Updated</th>
                        </tr>
                      </thead>
                      <tbody>
                        {(data.learning?.progress || []).map((p, i) => (
                          <tr key={i}>
                            <td>
                              {p.candidate_name}
                              <small>{p.candidate_email}</small>
                            </td>
                            <td>{p.resource_title}</td>
                            <td>{p.topic}</td>
                            <td>{pill(p.status)}</td>
                            <td>{stamp(p.updated_at)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {!(data.learning?.progress || []).length && (
                      <div className="ad-billing-empty">
                        No learning progress has been recorded.
                      </div>
                    )}
                  </div>
                </div>
                <div className="ad-panel">
                  <div className="ad-panel-head">
                    <div>
                      <h3>Credit consumption & adjustments</h3>
                      <p>
                        Grant credits only with a clear operational reason. All
                        entries remain traceable.
                      </p>
                    </div>
                  </div>
                  {(adminRole === "super_admin" ||
                    adminRole === "finance_admin") && (
                    <form
                      className="ad-learning-credit-form"
                      onSubmit={async (e) => {
                        e.preventDefault();
                        try {
                          const f = e.currentTarget;
                          await api("/admin/learning/credits", {
                            method: "POST",
                            body: {
                              user_id: Number(f.user_id.value),
                              delta: Number(f.delta.value),
                              reason: f.reason.value,
                            },
                          });
                          f.reset();
                          flash("Retake credits granted and logged.");
                          await load();
                        } catch (x) {
                          setError(x.message || "Could not grant credits.");
                        }
                      }}
                    >
                      <label>
                        Candidate user ID
                        <input name="user_id" type="number" min="1" required />
                      </label>
                      <label>
                        Credits to grant
                        <input
                          name="delta"
                          type="number"
                          min="1"
                          max="100"
                          defaultValue="1"
                          required
                        />
                      </label>
                      <label>
                        Reason
                        <input
                          name="reason"
                          minLength="8"
                          required
                          placeholder="e.g. verified platform interruption"
                        />
                      </label>
                      <button className="ad-q-add-btn">Grant credits</button>
                    </form>
                  )}
                  {(adminRole === "super_admin" ||
                    adminRole === "finance_admin") && (
                    <div className="ad-table-wrap">
                      <table className="ad-table">
                        <thead>
                          <tr>
                            <th>Candidate</th>
                            <th>Change</th>
                            <th>Entry</th>
                            <th>Reason</th>
                            <th>Date</th>
                          </tr>
                        </thead>
                        <tbody>
                          {(data.learning?.ledger || []).map((l) => (
                            <tr key={l.id}>
                              <td>
                                {l.candidate_name ||
                                  l.candidate_email ||
                                  l.user_id}
                                <small>{l.candidate_email}</small>
                              </td>
                              <td>
                                {l.delta > 0 ? "+" : ""}
                                {l.delta}
                              </td>
                              <td>{l.entry_type}</td>
                              <td>{l.reason}</td>
                              <td>{stamp(l.created)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      {!(data.learning?.ledger || []).length && (
                        <div className="ad-billing-empty">
                          No retake ledger entries.
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </section>
          )}
          {page === "privacy" && (
            <section className="ad-two-col">
              <div className="ad-panel">
                <h2>Privacy & data rights</h2>
                <p>
                  Available candidate rights capabilities and consent coverage.
                </p>
                <div className="ad-metrics ad-metrics-compact">
                  {metric(
                    "Consented users",
                    data.privacy?.consented_users,
                    "Distinct accounts",
                    "✓",
                  )}
                  {metric(
                    "Consent records",
                    data.privacy?.consent_records,
                    "Versioned records",
                    "◈",
                  )}
                </div>
                <div className="ad-health-row">
                  <span>Candidate data export</span>
                  {pill(
                    data.privacy?.export_capability
                      ? "available"
                      : "unavailable",
                  )}
                </div>
                <div className="ad-health-row">
                  <span>Self-service deletion</span>
                  {pill(
                    data.privacy?.self_service_deletion
                      ? "available"
                      : "unavailable",
                  )}
                </div>
                <div className="ad-health-row">
                  <span>Scheduled retention jobs</span>
                  {pill(
                    data.privacy?.retention_jobs_configured
                      ? "configured"
                      : "not_configured",
                  )}
                </div>
              </div>
              <div className="ad-panel">
                <h2>Implementation notes</h2>
                <p>{data.privacy?.note || "Privacy controls not available."}</p>
                <div className="ad-info-banner">
                  Admin access to sensitive candidate evidence must remain
                  purpose-limited, reason-coded and audited. Raw media access is
                  not provided by this console.
                </div>
              </div>
            </section>
          )}
          {page === "quality" && (
            <section className="ad-panel">
              <div className="ad-panel-head">
                <div>
                  <h2>Fairness & quality signals</h2>
                  <p>
                    Descriptive operational metrics; not candidate ranking or
                    protected-trait profiling.
                  </p>
                </div>
              </div>
              <div className="ad-metrics">
                {metric(
                  "Completed attempts",
                  data.quality?.completed_attempts,
                  "Scored attempts",
                  "◎",
                )}
                {metric(
                  "Appeals",
                  data.quality?.appeals,
                  "Candidate-raised",
                  "⚑",
                )}
                {metric(
                  "Reviewed attempts",
                  data.quality?.reviewed_attempts,
                  "Human review records",
                  "✓",
                )}
                {metric(
                  "Appeal overturns",
                  data.quality?.appeal_overturns,
                  "Outcomes",
                  "↺",
                )}
              </div>
              <div className="ad-health-row">
                <span>Appeal overturn rate</span>
                <b>
                  {data.quality?.appeal_overturn_rate == null
                    ? "Not enough data"
                    : (data.quality.appeal_overturn_rate * 100).toFixed(1) +
                      "%"}
                </b>
              </div>
              <div className="ad-info-banner">
                {data.quality?.note ||
                  "Quality metrics are limited by available data."}{" "}
                Protected demographic data is not collected for this analysis.
              </div>
            </section>
          )}
          {page === "audit" && (
            <section className="ad-panel">
              <div className="ad-panel-head">
                <div>
                  <h2>Audit event history</h2>
                  <p>Recent account, moderation and review events.</p>
                </div>
                <span className="ad-count">{rows("audit").length} events</span>
              </div>
              <div className="ad-toolbar">
                <input
                  placeholder="Filter by action…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </div>
              {table(
                ["Time", "Actor", "Action", "Target"],
                filtered(rows("audit"), [
                  "action",
                  "target",
                  "actor_name",
                  "actor_email",
                ]).map((x) => (
                  <tr key={x.id || `${x.ts}-${x.action}-${x.target}`}>
                    <td>{stamp(x.ts)}</td>
                    <td>
                      <b>{x.actor_name || "System"}</b>
                      <small>{x.actor_email || "ID " + x.actor}</small>
                    </td>
                    <td>
                      <code>{x.action}</code>
                    </td>
                    <td className="ad-audit-target">{x.target}</td>
                  </tr>
                )),
                "No audit events found.",
              )}
            </section>
          )}
          {page === "identity" && (
            <IdentityReviewQueue A={{ ...A, loading: C.common.loading }} onFlash={flash} onError={setError} />
          )}
          {page === "security" && (
            <SecurityPanel S={A.security} email={adminEmail} />
          )}
          {busy && <div className="ad-loading">Syncing platform data…</div>}
          <footer className="ad-footer">
            <span>TalentForge Global · Admin Console</span>
            <span>
              Least privilege · Human review · Evidence-led operations
            </span>
          </footer>
        </div>
      </main>
      {candidateView && (
        <CandidateDetailModal
          userId={candidateView}
          onClose={() => setCandidateView(null)}
        />
      )}
      {questionModal && (
        <div
          className="ad-modal-backdrop"
          onClick={() => !questionSaving && setQuestionModal(false)}
        >
          <form
            className="ad-question-modal"
            onSubmit={saveQuestion}
            onClick={(e) => e.stopPropagation()}
          >
            <header>
              <div>
                <div className="ad-eyebrow">Question authoring</div>
                <h2>
                  {questionEditing ? "Edit question" : "Create a question"}
                </h2>
                <p>
                  Define the question, answer key and fair assessment timing.
                </p>
              </div>
              <button type="button" aria-label="Close" onClick={() => setQuestionModal(false)}>
                ×
              </button>
            </header>
            <div className="ad-q-form-grid">
              <label>
                Category
                <select
                  required
                  value={questionDraft.category_id}
                  onChange={(e) =>
                    setQuestionDraft((v) => ({
                      ...v,
                      category_id: e.target.value,
                    }))
                  }
                >
                  {(data.questions?.categories || []).map((c) => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </select>
              </label>
              <label>
                Subcategory
                <input
                  required
                  value={questionDraft.subcategory}
                  onChange={(e) =>
                    setQuestionDraft((v) => ({
                      ...v,
                      subcategory: e.target.value,
                    }))
                  }
                  placeholder="e.g. Joins"
                />
              </label>
              <label>
                Question type
                <select
                  value={questionDraft.question_type}
                  onChange={(e) =>
                    setQuestionDraft((v) => ({
                      ...v,
                      question_type: e.target.value,
                    }))
                  }
                >
                  {[
                    "MCQ",
                    "Coding",
                    "SQL",
                    "Explanation",
                    "Short Answer",
                    "Scenario-Based",
                    "System Design",
                    "True/False",
                  ].map((x) => (
                    <option key={x}>{x}</option>
                  ))}
                </select>
              </label>
              <label>
                Difficulty
                <select
                  value={questionDraft.difficulty_level}
                  onChange={(e) =>
                    setQuestionDraft((v) => ({
                      ...v,
                      difficulty_level: e.target.value,
                    }))
                  }
                >
                  {["Easy", "Medium", "Hard"].map((x) => (
                    <option key={x}>{x}</option>
                  ))}
                </select>
              </label>
              <label className="ad-q-full">
                Question text
                <textarea
                  required
                  rows="4"
                  value={questionDraft.question_text}
                  onChange={(e) =>
                    setQuestionDraft((v) => ({
                      ...v,
                      question_text: e.target.value,
                    }))
                  }
                  placeholder="Write a clear, unambiguous question…"
                />
              </label>
              {questionDraft.question_type === "MCQ" && (
                <label className="ad-q-full">
                  Options <small>One option per line</small>
                  <textarea
                    rows="4"
                    value={questionDraft.options}
                    onChange={(e) =>
                      setQuestionDraft((v) => ({
                        ...v,
                        options: e.target.value,
                      }))
                    }
                    placeholder={"Option A\nOption B\nOption C\nOption D"}
                  />
                </label>
              )}
              <label>
                Correct answer
                <input
                  value={questionDraft.correct_answer}
                  onChange={(e) =>
                    setQuestionDraft((v) => ({
                      ...v,
                      correct_answer: e.target.value,
                    }))
                  }
                  placeholder="Exact answer or option"
                />
              </label>
              <label>
                Marks
                <input
                  type="number"
                  min="1"
                  max="100"
                  value={questionDraft.marks}
                  onChange={(e) =>
                    setQuestionDraft((v) => ({ ...v, marks: e.target.value }))
                  }
                />
              </label>
              <label>
                Time allocation (minutes)
                <input
                  type="number"
                  min="0.25"
                  max="120"
                  step="0.25"
                  value={questionDraft.time_minutes}
                  onChange={(e) =>
                    setQuestionDraft((v) => ({
                      ...v,
                      time_minutes: e.target.value,
                    }))
                  }
                />
              </label>
              <label>
                Status
                <select
                  value={questionDraft.status}
                  onChange={(e) =>
                    setQuestionDraft((v) => ({ ...v, status: e.target.value }))
                  }
                >
                  <option value="draft">Draft</option>
                  <option value="active">Active</option>
                  <option value="practice">Practice (learning only)</option>
                  <option value="archived">Archived</option>
                </select>
              </label>
              <label className="ad-q-full">
                Explanation
                <textarea
                  rows="2"
                  value={questionDraft.explanation}
                  onChange={(e) =>
                    setQuestionDraft((v) => ({
                      ...v,
                      explanation: e.target.value,
                    }))
                  }
                />
              </label>
              <label className="ad-q-full">
                Reference answer
                <textarea
                  rows="2"
                  value={questionDraft.reference_answer}
                  onChange={(e) =>
                    setQuestionDraft((v) => ({
                      ...v,
                      reference_answer: e.target.value,
                    }))
                  }
                  placeholder={
                    questionDraft.question_type === "SQL"
                      ? "Canonical SQL query used for automatic grading against hidden datasets."
                      : "Expected answer, reference implementation or guidance for human review."
                  }
                />
              </label>
              <label className="ad-q-full">
                Grading rubric
                <textarea
                  rows="2"
                  value={questionDraft.grading_rubric}
                  onChange={(e) =>
                    setQuestionDraft((v) => ({
                      ...v,
                      grading_rubric: e.target.value,
                    }))
                  }
                />
              </label>
            </div>
            <div className="ad-q-system-meta">
              <span>
                Created by: {questionEditing?.created_by || "Current admin"}
              </span>
              <span>
                Version:{" "}
                {questionEditing
                  ? "v" +
                    questionEditing.version +
                    " → v" +
                    (Number(questionEditing.version) + 1)
                  : "v1 on save"}
              </span>
              <span>
                Created date:{" "}
                {questionEditing
                  ? stamp(questionEditing.created_date)
                  : "Generated on save"}
              </span>
            </div>
            <footer>
              <button
                type="button"
                onClick={() => setQuestionModal(false)}
                disabled={questionSaving}
              >
                Cancel
              </button>
              <button className="ad-q-add-btn" disabled={questionSaving}>
                {questionSaving
                  ? "Saving…"
                  : questionEditing
                    ? "Save new version"
                    : "Create question"}
              </button>
            </footer>
          </form>
        </div>
      )}
      {selectedReport && (
        <div
          className="ad-modal-backdrop"
          onClick={() => setSelectedReport(null)}
        >
          <section
            className="ad-report-modal"
            onClick={(e) => e.stopPropagation()}
          >
            <header>
              <div>
                <div className="ad-eyebrow">
                  CANDIDATE EVIDENCE · MANUAL REVIEW
                </div>
                <h2>Assessment evaluation report</h2>
                <p>
                  {selectedReport.candidate_name} · {selectedReport.email} ·{" "}
                  {selectedReport.kind} assessment
                </p>
              </div>
              <button type="button" aria-label="Close report" onClick={() => setSelectedReport(null)}>
                ×
              </button>
            </header>
            <div className="ad-report-summary">
              <div>
                <small>Current academic score · provisional until release</small>
                <strong>
                  {selectedReport.result?.overall ?? "—"}
                  <small>/100</small>
                </strong>
              </div>
              <div>
                <small>Level</small>
                <strong>{selectedReport.result?.level ?? "—"}</strong>
              </div>
              <div>
                <small>Integrity signal</small>
                <strong>{selectedReport.result?.trust ?? "—"}</strong>
              </div>
            </div>
            <AssessmentStatus publication={selectedReport.publication} objective={selectedReport.result?.objective_summary} />
            <button type="button" className="btn ghost sm" onClick={() => { const id = selectedReport.id; setSelectedReport(null); openIntegrityDetail(id); }}>Review honesty report and score →</button>
            <div className="ad-info-banner">
              {selectedReport.evaluation_method ||
                "Automated evaluation method unavailable."}{" "}
              Stored-rubric drafts are advisory evidence. The score changes only
              after you approve or edit each mark.
              {" External AI scoring is disabled by project policy."}
            </div>
            <div className="ad-eval-toolbar">
              <button
                type="button"
                className="ad-mini-primary"
                onClick={() => runEvaluation(selectedReport)}
                disabled={evaluationBusy}
              >
                {evaluationBusy
                  ? "Preparing stored-rubric drafts…"
                  : "Re-run stored-rubric evaluation"}
              </button>
              <span>
                {selectedReport.evaluation_summary?.pending_admin_approval ?? 0}{" "}
                draft(s) pending approval
              </span>
            </div>
            {evaluationError && (
              <div className="ad-warning-banner">{evaluationError}</div>
            )}
            {!selectedReport.answer_evidence_complete && (
              <div className="ad-warning-banner">
                Some or all candidate responses were not captured for this older
                attempt. The original question list may be visible, but missing
                answers cannot be reconstructed.
              </div>
            )}
            <h3>Topic performance</h3>
            <div className="ad-report-topics">
              {Object.entries(selectedReport.result?.topics || {}).map(
                ([topic, v]) => (
                  <div key={topic}>
                    <b>{topic}</b>
                    <span>
                      {v.score}% · {v.level} · {v.n} questions
                    </span>
                  </div>
                ),
              )}
            </div>
            <h3>
              Questions and candidate answers (
              {selectedReport.answer_evidence?.length || 0})
            </h3>
            <div className="ad-report-questions">
              {(selectedReport.answer_evidence || []).map((q, idx) => (
                <article key={q.id || q.question_id || idx}>
                  <div className="ad-report-qmeta">
                    Q{q.number} · {q.topic} · {q.type} · Difficulty{" "}
                    {q.difficulty}
                  </div>
                  <h4>{q.question}</h4>
                  {q.options?.length > 0 && (
                    <ol>
                      {q.options.map((o, oi) => (
                        <li key={oi}>{o}</li>
                      ))}
                    </ol>
                  )}
                  <div className="ad-report-answer">
                    <b>Candidate answer</b>
                    <pre>
                      {q.selected_option ??
                        q.candidate_answer ??
                        "Not captured in this attempt"}
                    </pre>
                  </div>
                  {q.expected_answer && (
                    <div className="ad-report-answer">
                      <b>Expected / reference answer</b>
                      <pre>{q.expected_answer}</pre>
                    </div>
                  )}
                  {q.explanation && (
                    <p className="ad-report-qmeta">
                      Explanation: {q.explanation}
                    </p>
                  )}
                  {q.grading_rubric && (
                    <p className="ad-report-qmeta">
                      Rubric: {q.grading_rubric}
                    </p>
                  )}
                  {q.evaluation ? (
                    <div className="ad-eval-card">
                      <div className="ad-eval-head">
                        <b>Stored-rubric evaluation draft</b>
                        <span
                          className={
                            "ad-eval-status " +
                            (q.evaluation.status === "approved"
                              ? "approved"
                              : "pending")
                          }
                        >
                          {q.evaluation.status === "approved"
                            ? "Administrator approved"
                            : "Awaiting administrator approval"}
                        </span>
                      </div>
                      <div className="ad-eval-score">
                        <strong>
                          {q.evaluation.ai_marks}
                          <small> / {q.evaluation.max_marks}</small>
                        </strong>
                        <span>
                          Suggested partial marks ·{" "}
                          {Math.round((q.evaluation.confidence || 0) * 100)}%
                          confidence · {q.evaluation.method}
                          {q.evaluation.llm_model
                            ? ` · ${q.evaluation.llm_provider}/${q.evaluation.llm_model}`
                            : " · deterministic draft"}
                        </span>
                      </div>
                      <div className="ad-eval-bars">
                        {[
                          ["Keyword coverage", q.evaluation.components?.keyword],
                          ["Reference similarity", q.evaluation.components?.similarity],
                        ].map(([label, component]) => (
                          <div key={label}>
                            <span>{label}</span>
                            <div>
                              <i
                                style={{
                                  width:
                                    Math.round((component?.score || 0) * 100) +
                                    "%",
                                }}
                              />
                            </div>
                            <b>
                              {Math.round((component?.score || 0) * 100)}%
                            </b>
                          </div>
                        ))}
                      </div>
                      <div className="ad-eval-keywords">
                        {(q.evaluation.keywords?.matched || []).map((k) => (
                          <span className="hit" key={"m-" + k}>
                            ✓ {k}
                          </span>
                        ))}
                        {(q.evaluation.keywords?.missing || []).map((k) => (
                          <span className="miss" key={"x-" + k}>
                            ✕ {k}
                          </span>
                        ))}
                      </div>
                      <p className="ad-eval-rationale">
                        {q.evaluation.rationale}
                      </p>
                      {q.evaluation.flags?.length > 0 && (
                        <p className="ad-eval-flags">
                          Flags: {q.evaluation.flags.join(", ")}
                        </p>
                      )}
                      <div className="ad-eval-edit">
                        <label>
                          <span>Approved marks (0–{q.evaluation.max_marks})</span>
                          <input
                            type="number"
                            min="0"
                            max={q.evaluation.max_marks}
                            step="0.25"
                            value={
                              reportEvaluations[q.question_id]?.marks ?? ""
                            }
                            onChange={(e) =>
                              setReportEvaluations((prev) => ({
                                ...prev,
                                [q.question_id]: {
                                  ...(prev[q.question_id] || {}),
                                  marks: e.target.value,
                                },
                              }))
                            }
                          />
                        </label>
                        <label>
                          <span>Administrator note (reason for the mark)</span>
                          <textarea
                            rows="2"
                            value={
                              reportEvaluations[q.question_id]?.admin_note || ""
                            }
                            onChange={(e) =>
                              setReportEvaluations((prev) => ({
                                ...prev,
                                [q.question_id]: {
                                  ...(prev[q.question_id] || {}),
                                  admin_note: e.target.value,
                                },
                              }))
                            }
                          />
                        </label>
                        <label>
                          <span>Additional information for the audit trail</span>
                          <textarea
                            rows="2"
                            value={
                              reportEvaluations[q.question_id]
                                ?.additional_info || ""
                            }
                            onChange={(e) =>
                              setReportEvaluations((prev) => ({
                                ...prev,
                                [q.question_id]: {
                                  ...(prev[q.question_id] || {}),
                                  additional_info: e.target.value,
                                },
                              }))
                            }
                          />
                        </label>
                        <button
                          type="button"
                          className="ad-mini-primary"
                          disabled={evaluationBusy}
                          onClick={() =>
                            saveEvaluation(selectedReport, q.question_id)
                          }
                        >
                          Save & approve this mark
                        </button>
                      </div>
                    </div>
                  ) : q.objective ? (
                    <div className="ad-eval-card"><p>Objective answer-key result: <strong>{q.awarded_marks ?? 0}/{q.max_marks ?? q.marks ?? 1}</strong>. An administrator may adjust marks within the allowed range with a recorded reason.</p><div className="ad-eval-edit"><label>Adjusted marks<input type="number" min="0" max={q.max_marks ?? q.marks ?? 1} step="0.25" value={reportEvaluations[q.question_id]?.marks ?? ""} onChange={(event) => setReportEvaluations((previous) => ({ ...previous, [q.question_id]: { ...previous[q.question_id], marks: event.target.value } }))} /></label><label>Reason for adjustment<textarea rows="2" value={reportEvaluations[q.question_id]?.admin_note || ""} onChange={(event) => setReportEvaluations((previous) => ({ ...previous, [q.question_id]: { ...previous[q.question_id], admin_note: event.target.value } }))} /></label><button type="button" className="ad-mini-primary" disabled={evaluationBusy} onClick={() => saveEvaluation(selectedReport, q.question_id)}>Save adjusted mark</button></div></div>
                  ) : (
                    <div className="ad-report-qmeta">
                      Evaluation:{" "}
                      {q.review_status ||
                        (q.automated_correct === true
                          ? "Correct"
                          : q.automated_correct === false
                            ? "Incorrect"
                            : "Unavailable")}{" "}
                      · Response time: {q.time_seconds ?? "—"} sec
                    </div>
                  )}
                </article>
              ))}
            </div>
            <footer>
              <span>
                Use browser print dialog and choose “Save as PDF” for a
                downloadable report.
              </span>
              <button type="button" className="ad-mini-primary" disabled={evaluationBusy} onClick={() => {
                const evaluations = Object.entries(reportEvaluations).filter(([questionId]) => selectedReport.evaluations?.some((evaluation) => evaluation.question_id === questionId)).map(([question_id, edit]) => ({ question_id, marks: edit.marks === "" ? null : Number(edit.marks), admin_note: edit.admin_note || "", additional_info: edit.additional_info || "", status: "approved" }));
                setAction({ kind: "assessment", id: selectedReport.id, decision: "approved", evaluations });
                setReason("");
                setSelectedReport(null);
              }}>Approve academic marks</button>
              <button
                className="ad-mini-primary"
                onClick={() => printAssessmentReport(selectedReport)}
              >
                Print / Save PDF
              </button>
              <button onClick={() => setSelectedReport(null)}>Close</button>
            </footer>
          </section>
        </div>
      )}
      {(integrityDetail || integrityLoading) && (
        <div
          className="ad-modal-backdrop"
          onClick={() => setIntegrityDetail(null)}
        >
          <section
            className="ad-modal"
            style={{
              width: "min(920px,96vw)",
              maxHeight: "88vh",
              overflowY: "auto",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              className="ad-modal-close"
              aria-label="Close"
              onClick={() => setIntegrityDetail(null)}
            >
              ×
            </button>
            {integrityLoading ? (
              <p>Loading attempt evidence…</p>
            ) : (
              <>
                <div className="ad-eyebrow">Exam integrity report</div>
                <h2>{integrityDetail.candidate_name}</h2>
                <p>
                  {integrityDetail.email} · {integrityDetail.kind} ·{" "}
                  {integrityDetail.id}
                </p>
                <div className="ad-info-banner">
                  AI and identity alerts are probabilistic review signals, not
                  proof of misconduct. Webcam frames are analysed locally; only
                  limited JPEG snapshots linked to triggered alerts may be stored
                  temporarily. No continuous video or audio is recorded.
                </div>
                <div className="ad-detail-list">
                  <div>
                    <span>Attempt status</span>
                    <b>{integrityDetail.status}</b>
                  </div>
                  <div>
                    <span>Started</span>
                    <b>{stamp(integrityDetail.started)}</b>
                  </div>
                  <div>
                    <span>Finished</span>
                    <b>{stamp(integrityDetail.finished)}</b>
                  </div>
                  <div>
                    <span>Technical score</span>
                    <b>{integrityDetail.integrity?.overall ?? "Not scored"}</b>
                  </div>
                  <div>
                    <span>Trust label</span>
                    <b>{integrityDetail.integrity?.trust || "Not scored"}</b>
                  </div>
                  <div>
                    <span>Trust points</span>
                    <b>{integrityDetail.integrity?.trust_points ?? "—"}</b>
                  </div>
                  <div>
                    <span>Rule version</span>
                    <b>
                      {integrityDetail.integrity?.trust_rule_version ||
                        "Not available"}
                    </b>
                  </div>
                  <div>
                    <span>Review decision</span>
                    <b>{integrityDetail.review_decision || "Not reviewed"}</b>
                  </div>
                </div>
                {integrityDetail.review_response ? (
                  <div className="ad-info-banner" role="note">
                    <b>Candidate reply to "needs more information"</b> · {stamp(integrityDetail.review_response.created)}
                    <p>{integrityDetail.review_response.note}</p>
                  </div>
                ) : integrityDetail.review_decision === "needs_more_info" ? (
                  <p className="ad-footnote">More information was requested; the candidate has not replied yet.</p>
                ) : null}
                <h3>Honesty score</h3>
                <div className="honesty-review">
                  <div className="honesty-summary">
                    <div>
                      <span>System default</span>
                      <b>{integrityDetail.honesty?.auto_score ?? "—"}</b>
                    </div>
                    <div>
                      <span>Current score</span>
                      <b>{integrityDetail.honesty?.score ?? "—"}</b>
                    </div>
                    <div>
                      <span>Status</span>
                      <b>{pill(integrityDetail.honesty?.status || "pending")}</b>
                    </div>
                    <div>
                      <span>Reviewed</span>
                      <b>
                        {integrityDetail.honesty?.reviewed_at
                          ? stamp(integrityDetail.honesty.reviewed_at)
                          : "Not reviewed"}
                      </b>
                    </div>
                  </div>
                  <div className="honesty-form">
                    <label>
                      Score (0–100)
                      <input
                        type="number"
                        min="0"
                        max="100"
                        value={honestyDraft.score}
                        onChange={(e) =>
                          setHonestyDraft((d) => ({ ...d, score: e.target.value }))
                        }
                      />
                    </label>
                    <label>
                      Review note
                      <textarea
                        rows="2"
                        maxLength="2000"
                        placeholder="Why did you adjust or accept this score?"
                        value={honestyDraft.reason}
                        onChange={(e) =>
                          setHonestyDraft((d) => ({ ...d, reason: e.target.value }))
                        }
                      />
                    </label>
                    <div className="honesty-actions">
                      <button
                        type="button"
                        className="ad-action-btn"
                        disabled={honestyBusy}
                        onClick={() => saveHonesty("pending")}
                      >
                        {honestyBusy ? "Saving…" : "Save score"}
                      </button>
                      <button
                        type="button"
                        className="ad-action-btn"
                        disabled={honestyBusy}
                        onClick={() => saveHonesty("approved")}
                      >
                        Approve honesty
                      </button>
                      <button
                        type="button"
                        className="ad-action-btn danger"
                        disabled={honestyBusy}
                        onClick={() => saveHonesty("rejected")}
                      >
                        Reject honesty
                      </button>
                    </div>
                    {honestyError && <p className="err">{honestyError}</p>}
                    <p className="ad-footnote">
                      Default score = 100 − (integrity points × 10), capped at 40
                      when a hard flag exists. Editing or deciding this score never
                      changes the technical assessment score; use assessment review
                      for that.
                    </p>
                  </div>
                </div>
                <h3>Flags detected</h3>
                {integrityDetail.flags?.length ? (
                  <div className="honesty-flags">
                    {integrityDetail.flags.map((f) => (
                      <span key={f.type} className="honesty-flag">
                        {eventLabel(f.type)} <b>×{f.count}</b>
                      </span>
                    ))}
                  </div>
                ) : (
                  <p>No integrity flags recorded for this attempt.</p>
                )}
                <h3>Trust reasons</h3>
                {integrityDetail.integrity?.trust_reasons?.length ? (
                  <ul>
                    {integrityDetail.integrity.trust_reasons.map((r, i) => (
                      <li key={i}>
                        {r.key}: {r.n ?? 0} event(s), {r.points ?? 0} point(s)
                        {r.duration_seconds != null
                          ? ", " + r.duration_seconds + "s"
                          : ""}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p>No trust reasons recorded.</p>
                )}
                <h3>Hard flags</h3>
                <p>
                  {integrityDetail.integrity?.trust_hard_flags?.join(", ") ||
                    "None recorded"}
                </p>
                <h3>Integrity activity summary</h3>
                <div className="ad-detail-list">
                  <div>
                    <span>Suspicious-activity signals</span>
                    <b>
                      {integrityDetail.events?.filter(
                        (e) =>
                          [
                            "tab_hidden",
                            "tab_visible",
                            "blur",
                            "focus",
                            "fullscreen_exit",
                            "fullscreen_enter",
                            "screen_share_stopped",
                            "screen_share_started",
                            "screen_share_unavailable",
                            "wrong_share_surface",
                            "copy",
                            "cut",
                            "paste",
                            "identity_mismatch",
                          ].includes(e.type) ||
                          String(e.type || "").startsWith("ai_"),
                      ).length || 0}
                    </b>
                  </div>
                  <div>
                    <span>AI evidence snapshots</span>
                    <b>{integrityDetail.evidence?.length || 0}</b>
                  </div>
                  <div>
                    <span>Technical issues</span>
                    <b>
                      {integrityDetail.events?.filter((e) =>
                        e.type !== "heartbeat" &&
                        ["heartbeat_gap", "camera_stopped", "microphone_stopped", "ai_model_unavailable", "network_ip_changed"].includes(e.type),
                      ).length || 0}
                    </b>
                  </div>
                </div>
                {renderIntegrityEvents(
                  "Suspicious activity signals",
                  (integrityDetail.events || []).filter(
                    (e) =>
                      [
                        "tab_hidden",
                        "tab_visible",
                        "blur",
                        "focus",
                        "fullscreen_exit",
                        "fullscreen_enter",
                        "screen_share_stopped",
                        "screen_share_started",
                        "screen_share_unavailable",
                        "wrong_share_surface",
                        "copy",
                        "cut",
                        "paste",
                        "identity_mismatch",
                      ].includes(e.type) ||
                      String(e.type || "").startsWith("ai_"),
                  ),
                  "No suspicious-activity signals were recorded. These are review signals, not findings of misconduct.",
                )}
                {renderIntegrityEvents(
                  "Technical issues",
                  (integrityDetail.events || []).filter(
                    (e) =>
                      e.type !== "heartbeat" &&
                      (["heartbeat_gap", "camera_stopped", "microphone_stopped", "ai_model_unavailable", "network_ip_changed"].includes(e.type) ||
                      ![
                        "tab_hidden",
                        "tab_visible",
                        "blur",
                        "focus",
                        "fullscreen_exit",
                        "fullscreen_enter",
                        "screen_share_stopped",
                        "screen_share_started",
                        "screen_share_unavailable",
                        "wrong_share_surface",
                        "copy",
                        "cut",
                        "paste",
                        "identity_mismatch",
                        "identity_verified",
                        "identity_skipped",
                      ].includes(e.type) &&
                        !String(e.type || "").startsWith("ai_")),
                  ),
                  "No technical interruptions were recorded.",
                )}
                <h3>AI evidence snapshots ({integrityDetail.evidence?.length || 0})</h3>
                <p className="ad-footnote">
                  Snapshots are limited still images captured when an eligible AI
                  alert fires. They are not continuous video. A missing snapshot
                  does not mean the alert did not occur: capture or upload may
                  fail, the image may exceed the size limit, the per-attempt cap
                  may be reached, or the retention period may have expired.
                  Confidence is a detector score, not the probability that the
                  candidate cheated.
                </p>
                {integrityDetail.evidence?.length ? (
                  <div className="ai-evidence-grid">
                    {integrityDetail.evidence.map((ev) => (
                      <figure key={ev.id}>
                        <EvidenceImage attemptId={integrityDetail.id} evidence={ev} />
                        <figcaption>
                          {stamp(ev.captured_at)} ·{" "}
                          {Math.round(ev.size_bytes / 1024)} KB
                          {ev.vision && (
                            <span className="evidence-vision">
                              {ev.vision.source ? `${ev.vision.source} snapshot · ` : "Legacy snapshot · "}
                              {ev.vision.summary || "Model details unavailable; inspect the frame manually."}
                              {ev.vision.advisory && " · Advisory, client-reported observation—not a misconduct finding."}
                            </span>
                          )}
                        </figcaption>
                      </figure>
                    ))}
                  </div>
                ) : (
                  <p>No retained AI snapshots are available for this attempt.</p>
                )}
                <p className="ad-footnote">
                  Routine heartbeat pings run every 10 seconds and are not
                  displayed. A gap over 30 seconds is listed under Technical
                  issues as a monitoring interruption, not misconduct. Duration
                  is shown only when a matching return/restoration event exists;
                  clipboard actions are point-in-time events. AI detections,
                  including possible gaze deviation, are imperfect signals and
                  require human review.
                </p>
                <h3>Answer timing &amp; responses</h3>
                {integrityDetail.answers?.length ? (
                  <div className="ad-table-wrap">
                    <table className="ad-table">
                      <thead>
                        <tr>
                          <th># / QUESTION</th>
                          <th>Candidate answer</th>
                          <th>Topic / type</th>
                          <th>Started</th>
                          <th>Submitted</th>
                          <th>Time taken</th>
                        </tr>
                      </thead>
                      <tbody>
                        {integrityDetail.answers.map((a, i) => (
                          <tr key={i}>
                            <td>
                              <b>Q{a.question_index ?? i + 1}: {a.question_id || "—"}</b>
                              <small>{a.question}</small>
                            </td>
                            <td style={{ whiteSpace: "pre-wrap", maxWidth: 260 }}>
                              {a.answer || "No answer text recorded"}
                            </td>
                            <td>
                              {a.topic || "—"}
                              <small>{a.type || "—"}</small>
                            </td>
                            <td>{a.started_at ? stamp(a.started_at) : "—"}</td>
                            <td>{a.submitted_at ? stamp(a.submitted_at) : "—"}</td>
                            <td>
                              {a.seconds == null ? "—" : Number(a.seconds).toFixed(1) + "s"}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <p>No answer timing records.</p>
                )}
                <h3>Candidate appeal</h3>
                <p>{integrityDetail.appeal || "No appeal submitted."}</p>
                <h3>Human review</h3>
                <div className="ad-detail-list">
                  <div>
                    <span>Decision</span>
                    <b>{integrityDetail.review_decision || "Pending review"}</b>
                  </div>
                  <div>
                    <span>Reviewer account ID</span>
                    <b>{integrityDetail.reviewer_id ?? "—"}</b>
                  </div>
                  <div>
                    <span>Reviewed at</span>
                    <b>{stamp(integrityDetail.reviewed_at)}</b>
                  </div>
                  <div>
                    <span>Review note</span>
                    <b>{integrityDetail.review_reason || "No review note recorded"}</b>
                  </div>
                </div>
                <p className="ad-footnote">
                  Answer records and technical score remain unchanged by
                  integrity review.
                </p>
              </>
            )}
          </section>
        </div>
      )}
      {action && (
        <div
          className="ad-modal-backdrop"
          onClick={() => !saving && setAction(null)}
        >
          <form
            className="ad-modal"
            onSubmit={submitAction}
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              className="ad-modal-close"
              aria-label="Close"
              onClick={() => setAction(null)}
            >
              ×
            </button>
            <div className="ad-eyebrow">Reason-coded admin action</div>
            <h2>Confirm {action.decision.replaceAll("_", " ")}</h2>
            <p>
              This decision will be recorded with your administrator identity
              and timestamp. Add a clear reason for the audit trail.
            </p>
            <label>
              Decision reason
              <textarea
                required
                minLength={action.kind === "learning-resource" ? 8 : 3}
                rows="4"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Explain the evidence reviewed and why this action is appropriate…"
              />
            </label>
            <div className="ad-modal-actions">
              <button
                type="button"
                onClick={() => setAction(null)}
                disabled={saving}
              >
                Cancel
              </button>
              <button
                className="ad-modal-confirm"
                disabled={
                  saving ||
                  reason.trim().length <
                    (action.kind === "learning-resource" ? 8 : 3)
                }
              >
                {saving ? "Saving…" : "Confirm decision"}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}

