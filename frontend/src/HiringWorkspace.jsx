import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { api } from "./api.js";
import { useSetLang, useLangValue } from "./i18n.js";
import SecurityPanel from "./SecurityPanel.jsx";
import { useConsoleT } from "./consoleI18n.js";
import { CvPreview, WorkspaceIcon, WorkspaceLoading, WorkspaceSearch } from "./WorkspaceUI.jsx";
import TeamInvitations from "./TeamInvitations.jsx";
import { statusTone } from "./status.js";
import { NotificationBell } from "./NotificationCenter.jsx";
import CompanyInterviewModal from "./CompanyInterviewModal.jsx";
import CompanyInterviewResult from "./CompanyInterviewResult.jsx";

const AdminConsole = lazy(() => import("./AdminConsole.jsx"));
const AgentConsole = lazy(() => import("./AgentConsole.jsx"));

export default function HiringWorkspace({ role, onLogout }) {
  const C = useConsoleT();
  const CO = C.company;
  const lang = useLangValue();
  const setLang = useSetLang();
  const [page, setPage] = useState("overview");
  const [companyEmail, setCompanyEmail] = useState("");
  const [workspace, setWorkspace] = useState(null);
  const [needsOrganisation, setNeedsOrganisation] = useState(false);
  const [jobs, setJobs] = useState([]);
  const [applications, setApplications] = useState([]);
  const [analytics, setAnalytics] = useState(null);
  const [team, setTeam] = useState([]);
  const [phaseTwo, setPhaseTwo] = useState([]);
  const [selected, setSelected] = useState(null);
  const [detail, setDetail] = useState(null);
  const [interviewTarget, setInterviewTarget] = useState(null);
  const applicationDialog = useRef(null);
  useEffect(() => { if (detail) applicationDialog.current?.showModal(); }, [detail]);
  const [toast, setToast] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [memberBusy, setMemberBusy] = useState(false);
  const [secondaryErrors, setSecondaryErrors] = useState([]);
  const [copyStatus, setCopyStatus] = useState("");
  const [companyName, setCompanyName] = useState("");
  const [website, setWebsite] = useState("");
  const [verification, setVerification] = useState({
    legal_name: "",
    country: "Bangladesh",
    business_id: "",
    evidence_note: "",
  });
  const [jobForm, setJobForm] = useState({
    title: "",
    description: "",
    location: "Dhaka, Bangladesh",
    employment_type: "Full-time",
    work_mode: "Hybrid",
    experience_level: "Mid-level",
    salary_min: "",
    salary_max: "",
    salary_currency: "BDT",
    deadline: "",
    required_skills: "",
    preferred_skills: "",
    eligibility: "",
    hard_requirements: "",
  });
  const [jobEditId, setJobEditId] = useState(null);
  const [search, setSearch] = useState("");
  const [filterJob, setFilterJob] = useState("all");
  const [note, setNote] = useState("");
  const [stageReason, setStageReason] = useState("");
  const [teamForm, setTeamForm] = useState({ email: "", role: "recruiter" });
  const [inviteToken, setInviteToken] = useState("");
  const [phaseForm, setPhaseForm] = useState({
    title: "Role-specific practical assessment",
    requirements: "Assess practical skills relevant to this role.",
    syllabus: "",
    question_types: ["scenario", "short_answer"],
    duration_minutes: 60,
    deadline: "",
    attempt_count: 1,
    integrity_mode: "light",
    accommodations: "",
    credit_cost: 0,
    allowed_resources: "",
    rubric: "",
    difficulty_easy: 30,
    difficulty_medium: 50,
    difficulty_hard: 20,
  });
  const [selectedApp, setSelectedApp] = useState("");
  // Set while editing a returned (needs_changes) or still-pending request.
  const [editingPhaseId, setEditingPhaseId] = useState(null);
  const [verificationForm, setVerificationForm] = useState(false);
  const isOwner = workspace?.company?.role === "owner";
  const canManageJobs = workspace?.permissions?.manage_jobs;
  const jobEligibility = workspace?.job_eligibility || {
    registered: false,
    verified: false,
    verification_status: "not_submitted",
    can_create_draft: false,
    can_publish: false,
    reason: "Create and save your company profile before creating jobs.",
  };
  const canCreateJob = Boolean(canManageJobs && jobEligibility.can_create_draft);
  const canPublishJob = Boolean(canManageJobs && jobEligibility.can_publish);
  const canManagePipeline = workspace?.permissions?.manage_pipeline;
  const canManageTeam = workspace?.permissions?.manage_team;
  const date = (v) =>
    v
      ? new Date(Number(v) * 1000).toLocaleDateString("en-GB", {
          day: "numeric",
          month: "short",
          year: "numeric",
        })
      : "—";
  const initials = (s = "") =>
    s
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((x) => x[0])
      .join("")
      .toUpperCase() || "SB";
  const flash = (message) => {
    setToast(message);
    setError("");
  };
  const fail = (e) => {
    setError(e.message || "Something went wrong");
    setToast("");
  };
  const load = async () => {
    setBusy(true);
    setError("");
    try {
      // Core workspace data must load; secondary panels are independent so one
      // unavailable report endpoint cannot blank the rest of the company page.
      const w = await api("/company/workspace");
      setWorkspace(w);
      setNeedsOrganisation(false);
      setCompanyName(w.company.name);
      setWebsite(w.company.website || "");
      if (!companyEmail) {
        api("/enterprise/me")
          .then((identity) => setCompanyEmail(identity?.user?.email || ""))
          .catch(() => {});
      }
      const j = await api("/company/jobs");
      setJobs(j.items || []);
      const optional = [];
      const failures = [];
      if (w.company.verified && w.permissions.manage_pipeline) {
        optional.push(
          api("/company/applications")
            .then((a) => setApplications(a.items || []))
            .catch((e) => { failures.push("Applicants: " + e.message); }),
        );
      } else {
        setApplications([]);
      }
      if (w.permissions.view_reports) {
        optional.push(
          api("/company/analytics")
            .then((x) => setAnalytics(x))
            .catch((e) => { failures.push("Analytics: " + e.message); }),
        );
        optional.push(
          api("/company/phase-two")
            .then((p) => setPhaseTwo(p.items || []))
            .catch((e) => { failures.push("Assessment requests: " + e.message); }),
        );
      }
      if (w.permissions.manage_team) {
        optional.push(
          api("/company/team")
            .then((t) => setTeam(t.items || []))
            .catch((e) => { failures.push("Team: " + e.message); }),
        );
      }
      await Promise.allSettled(optional);
      setSecondaryErrors(failures);
    } catch (e) {
      if (e.status === 409 && e.message.toLowerCase().includes("organisation")) setNeedsOrganisation(true);
      fail(e);
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    if (role !== "admin") load();
    // Load when the role changes; later reloads are explicit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [role]);
  const openApplication = async (id) => {
    try {
      const d = await api("/company/applications/" + id);
      setSelected(id);
      setDetail(d);
    } catch (e) {
      fail(e);
    }
  };
  const shortlistCandidate = async (application) => {
    try {
      await api(`/company/applications/${application.application_id}/shortlist`, {
        method: "POST",
        body: {},
      });
      flash(`${application.candidate_name || "Candidate"} shortlisted. Choose the interview method next.`);
      await load();
      setInterviewTarget({ ...application, shortlisted: true });
    } catch (e) {
      fail(e);
    }
  };
  const openInterviewSetup = (application) => {
    setInterviewTarget(application);
  };
  const saveCompany = async (e) => {
    e.preventDefault();
    try {
      await api("/company/profile", {
        method: "POST",
        body: { name: companyName, website },
      });
      flash("Company profile saved. Next, submit verification.");
      await load();
    } catch (e) {
      fail(e);
    }
  };
  const submitVerification = async (e) => {
    e.preventDefault();
    try {
      const r = await api("/company/verification", {
        method: "POST",
        body: verification,
      });
      flash(r.message);
      setVerificationForm(false);
      await load();
    } catch (e) {
      fail(e);
    }
  };
  const setJob = (key, value) => setJobForm((v) => ({ ...v, [key]: value }));
  const editJob = (j) => {
    const d = j.details || {};
    setJobForm({
      title: j.title,
      description: j.description,
      location: j.location,
      employment_type: j.employment_type,
      work_mode: d.work_mode || "Remote",
      experience_level: d.experience_level || "Any",
      salary_min: d.salary_min ?? "",
      salary_max: d.salary_max ?? "",
      salary_currency: d.salary_currency || "BDT",
      deadline: d.deadline || "",
      required_skills: (d.required_skills || j.skills || []).join(", "),
      preferred_skills: (d.preferred_skills || []).join(", "),
      eligibility: d.eligibility || "",
      hard_requirements: (d.hard_requirements || []).join("\n"),
    });
    setJobEditId(j.id);
    setPage("jobs");
  };
  const submitJob = async (e) => {
    e.preventDefault();
    const payload = {
      ...jobForm,
      salary_min: jobForm.salary_min === "" ? null : Number(jobForm.salary_min),
      salary_max: jobForm.salary_max === "" ? null : Number(jobForm.salary_max),
      required_skills: jobForm.required_skills
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean),
      preferred_skills: jobForm.preferred_skills
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean),
      hard_requirements: jobForm.hard_requirements
        .split("\n")
        .map((x) => x.trim())
        .filter(Boolean),
    };
    try {
      if (jobEditId && jobEditId !== "new")
        await api("/company/jobs/" + jobEditId, {
          method: "PATCH",
          body: payload,
        });
      else await api("/company/jobs", { method: "POST", body: payload });
      setJobEditId(null);
      setJobForm({
        title: "",
        description: "",
        location: "Dhaka, Bangladesh",
        employment_type: "Full-time",
        work_mode: "Hybrid",
        experience_level: "Mid-level",
        salary_min: "",
        salary_max: "",
        salary_currency: "BDT",
        deadline: "",
        required_skills: "",
        preferred_skills: "",
        eligibility: "",
        hard_requirements: "",
      });
      flash(jobEditId ? "Job changes saved." : "Job draft created.");
      await load();
    } catch (e) {
      fail(e);
    }
  };
  const publishJob = async (id) => {
    try {
      const r = await api("/company/jobs/" + id + "/publish", {
        method: "POST",
      });
      flash(
        r.status === "published"
          ? "Job published."
          : "Job submitted for platform review.",
      );
      await load();
    } catch (e) {
      fail(e);
    }
  };
  const jobStatus = async (id, status) => {
    try {
      await api("/company/jobs/" + id + "/status", {
        method: "POST",
        body: { status, reason: "Company requested status change" },
      });
      flash("Job status updated.");
      await load();
    } catch (e) {
      fail(e);
    }
  };
  const moveStage = async (id, stage) => {
    // The backend rejects final decisions without a human reason; say so first.
    if (["rejected", "hired", "offer_declined", "closed"].includes(stage) && stageReason.trim().length < 3) {
      setError("A reason (at least 3 characters) is required to move an application to " + stage.replaceAll("_", " ") + ".");
      return;
    }
    try {
      await api("/company/applications/" + id + "/stage", {
        method: "PATCH",
        body: { stage, reason: stageReason },
      });
      setStageReason("");
      await openApplication(id);
      flash("Candidate pipeline updated.");
      await load();
    } catch (e) {
      fail(e);
    }
  };
  const addNote = async (e) => {
    e.preventDefault();
    try {
      await api("/company/applications/" + selected + "/notes", {
        method: "POST",
        body: { body: note },
      });
      setNote("");
      await openApplication(selected);
      flash("Private recruiter note added.");
    } catch (e) {
      fail(e);
    }
  };
  const sendInvite = async (invitation) => {
    if (memberBusy) return;
    setMemberBusy(true);
    try {
      const r = await api("/company/team/invitations", {
        method: "POST",
        body: invitation,
      });
      setInviteToken(r.invite_token);
      setCopyStatus("");
      setTeamForm({ email: "", role: "recruiter" });
      flash(r.message);
      const t = await api("/company/team");
      setTeam(t.items || []);
    } catch (e) {
      fail(e);
    } finally { setMemberBusy(false); }
  };
  const inviteMember = (e) => {
    e.preventDefault();
    sendInvite(teamForm);
  };
  const changeMemberRole = async (member, newRole) => {
    if (newRole === "revoked" && !window.confirm(`Revoke workspace access for ${member.email}?`)) return;
    setMemberBusy(true);
    try {
      await api("/company/team/" + member.id, { method: "PATCH", body: { role: newRole } });
      const result = await api("/company/team");
      setTeam(result.items || []);
      flash(newRole === "revoked" ? "Workspace access revoked." : "Team permissions updated.");
    } catch (e) { fail(e); }
    finally { setMemberBusy(false); }
  };
  const acceptInvite = async (e) => {
    e.preventDefault();
    if (memberBusy) return;
    setMemberBusy(true);
    try {
      await api("/company/team/accept/" + encodeURIComponent(inviteToken.trim()), { method: "POST" });
      setInviteToken("");
      flash("Organisation invitation accepted. Refreshing workspace.");
      await load();
    } catch (e) {
      fail(e);
    } finally { setMemberBusy(false); }
  };
  const createPhase = async (e) => {
    e.preventDefault();
    if (!selectedApp) {
      fail(new Error("Choose an applicant first."));
      return;
    }
    try {
      const topics = phaseForm.syllabus
        .split("\n")
        .map((x) => x.trim())
        .filter(Boolean);
      const rubricLines = phaseForm.rubric
        .split("\n")
        .map((x) => x.trim())
        .filter(Boolean);
      const difficulty = {
        easy: Number(phaseForm.difficulty_easy),
        medium: Number(phaseForm.difficulty_medium),
        hard: Number(phaseForm.difficulty_hard),
      };
      if (
        topics.length === 0 ||
        rubricLines.length === 0 ||
        phaseForm.question_types.length === 0 ||
        Object.values(difficulty).reduce((x, y) => x + y, 0) !== 100
      ) {
        fail(
          new Error(
            "Add syllabus and rubric criteria; difficulty percentages must total 100.",
          ),
        );
        return;
      }
      const payload = {
        ...phaseForm,
        syllabus: topics,
        rubric: rubricLines.map((criterion) => ({
          criterion,
          weight: 100 / rubricLines.length,
        })),
        allowed_resources: phaseForm.allowed_resources
          .split("\n")
          .map((x) => x.trim())
          .filter(Boolean),
        difficulty,
      };
      if (editingPhaseId) {
        await api("/company/phase-two/" + encodeURIComponent(editingPhaseId), { method: "PUT", body: payload });
        setEditingPhaseId(null);
        flash("Assessment request updated and resubmitted for platform review.");
      } else {
        await api(
          "/company/applications/" + selectedApp + "/phase-two-invitations",
          { method: "POST", body: payload },
        );
        flash(
          "Second-phase assessment configuration submitted for platform review. Candidate delivery is not active yet.",
        );
      }
      await load();
      setPage("assessments");
    } catch (e) {
      fail(e);
    }
  };
  const nav = [
    ["overview", CO.nav.overview, "overview"],
    ["jobs", CO.nav.jobs, "jobs"],
    ...(canManagePipeline ? [["applicants", CO.nav.applicants, "team"]] : []),
    ["assessments", CO.nav.assessments, "exams"],
    ["analytics", CO.nav.analytics, "analytics"],
    ["agent", "AI Copilot", "agent"],
    ...(canManageTeam ? [["team", CO.nav.team, "team"]] : []),
    ["settings", CO.nav.settings, "settings"],
    ["security", CO.nav.security, "security"],
  ];
  const stages = [
    ["submitted"],
    ["preliminary_assessment"],
    ["in_review"],
    ["phase_two_invited"],
    ["further_review"],
    ["human_interview"],
    ["on_hold"],
    ["offer"],
    ["offer_declined"],
    ["offer_withdrawn"],
    ["hired"],
    ["rejected"],
    ["withdrawn"],
    ["closed"],
  ].map(([id]) => [id, CO.stages[id] || id]);
  // Mirrors backend enterprise.APPLICATION_TRANSITIONS: rejection is allowed
  // from every review stage (always with a reason); offer_declined can close.
  const stageTransitions = {
    submitted: ["preliminary_assessment", "in_review", "rejected", "withdrawn"],
    applied: ["preliminary_assessment", "in_review", "rejected", "withdrawn"],
    preliminary_assessment: ["in_review", "phase_two_invited", "human_interview", "rejected", "withdrawn"],
    in_review: ["preliminary_assessment", "phase_two_invited", "human_interview", "rejected", "withdrawn"],
    phase_two_invited: ["human_interview", "further_review", "rejected", "withdrawn"],
    further_review: ["human_interview", "rejected", "withdrawn"],
    human_interview: ["offer", "rejected", "on_hold"],
    on_hold: ["human_interview", "rejected"],
    offer: ["hired", "offer_declined", "offer_withdrawn"],
    offer_withdrawn: ["human_interview", "closed"],
    offer_declined: ["closed"],
    hired: ["closed"],
    rejected: ["closed"],
    withdrawn: ["closed"],
  };
  const filteredApps = applications.filter(
    (a) =>
      (filterJob === "all" || a.job_id === filterJob) &&
      ((a.candidate_name || "").toLowerCase().includes(search.toLowerCase()) ||
        (a.job_title || "").toLowerCase().includes(search.toLowerCase())),
  );
  const pipelineCounts = analytics?.stages
    ? Object.fromEntries(analytics.stages.map((stage) => [stage.status, stage.n]))
    : workspace?.applications || {};
  const pipelineTotal = Object.values(pipelineCounts).reduce((sum, count) => sum + Number(count), 0);
  const metric = (label, value, sub, icon) => (
    <div className="cr-metric">
      <span className="cr-metric-icon" aria-hidden="true"><WorkspaceIcon name={{ "▤": "jobs", "♙": "team", "◷": "exams", "✓": "integrity", "↗": "analytics" }[icon] || "analytics"} size={18} /></span>
      <div>
        <small>{label}</small>
        <strong>{value}</strong>
        <span>{sub}</span>
      </div>
    </div>
  );
  if (role === "admin") return <Suspense fallback={<WorkspaceLoading />}><AdminConsole onLogout={onLogout} /></Suspense>;
  if (!workspace && needsOrganisation)
    return (
      <main className="cr-onboard">
        <div className="cr-onboard-brand">
          TalentForge<span>.</span>
        </div>
        <section className="cr-onboard-card">
          <div className="cr-kicker">{CO.onboarding.kicker}</div>
          <h1>{CO.onboarding.title}</h1>
          <p>{CO.onboarding.body}</p>
          <TeamInvitations onJoined={load} />
          <form onSubmit={saveCompany}>
            <label>
              {CO.onboarding.companyName}
              <input
                value={companyName}
                onChange={(e) => setCompanyName(e.target.value)}
                required
                minLength={2}
                placeholder="e.g. Northstar Technologies"
              />
            </label>
            <label>
              {CO.onboarding.website}
              <input
                value={website}
                onChange={(e) => setWebsite(e.target.value)}
                placeholder="https://company.com"
              />
            </label>
            <button className="cr-primary" disabled={busy}>
              {CO.onboarding.create} <span>→</span>
            </button>
          </form>
          <div className="cr-onboard-divider">
            <span>OR</span>
          </div>
          <form onSubmit={acceptInvite}>
            <label>
              Have a team invitation? Enter its token
              <input
                value={inviteToken}
                onChange={(e) => setInviteToken(e.target.value)}
                required
                placeholder="Paste invitation token"
              />
            </label>
            <button className="cr-outline-btn" disabled={memberBusy}>{memberBusy ? "Joining…" : "Accept team invitation"}</button>
          </form>
          {error && !error.toLowerCase().includes("organisation") && <p className="cr-error" role="alert">{error}</p>}
          <button type="button" className="cr-text-btn" onClick={onLogout}>Sign out</button>
        </section>
      </main>
    );
  return (
    <div className="cr-app">
      <a className="ws-skip-link" href="#company-content">Skip to content</a>
      <aside className="cr-sidebar">
        <div className="cr-brand">
          <span className="cr-brand-mark">TF</span>
          <span>
            TalentForge<span className="cr-brand-dot">.</span>
            <small>{CO.brand}</small>
          </span>
        </div>
        <div className="cr-org">
          <div className="cr-org-avatar">
            {initials(workspace?.company?.name)}
          </div>
          <div>
            <strong>{workspace?.company?.name || "Your organisation"}</strong>
            <small>
              {workspace?.company?.role === "owner"
                ? CO.owner
                : workspace?.company?.role?.replace("_", " ")}
            </small>
          </div>
          <span className="cr-chevron">⌄</span>
        </div>
        <div className="cr-nav-label">{CO.workspace}</div>
        <nav className="cr-nav" aria-label={CO.navAria}>
          {nav.map(([id, label]) => (
            <button
              key={id}
              type="button"
              className={page === id ? "active" : ""}
              aria-current={page === id ? "page" : undefined}
              title={label}
              onClick={() => {
                setPage(id);
                setSelected(null);
                setDetail(null);
              }}
            >
              <span><WorkspaceIcon name={id} /></span>
              {label}
              {id === "applicants" && applications.length > 0 ? (
                <b>{applications.length}</b>
              ) : null}
            </button>
          ))}
        </nav>
        <div className="cr-sidebar-bottom">
          <div className="cr-help-card">
            <strong>{CO.helpTitle}</strong>
            <p>{CO.helpBody}</p>
          </div>
          <div className="cr-user">
            <div className="cr-user-avatar">
              {initials(workspace?.company?.name)}
            </div>
            <div>
              <strong>{workspace?.company?.role || CO.teamMember}</strong>
              <small>{CO.companyAccount}</small>
            </div>
            <button type="button" title={C.common.refresh} aria-label={C.common.refresh} onClick={load}>
              <WorkspaceIcon name="refresh" size={16} />
            </button>
          </div>
        </div>
      </aside>
      <main className="cr-main">
        <header className="cr-topbar">
          <div className="cr-breadcrumb">
            {CO.breadcrumb} <span>/</span>{" "}
            {nav.find((x) => x[0] === page)?.[1] || CO.nav.overview}
          </div>
          <WorkspaceSearch items={nav.map(([id, label]) => ({ id, label }))} onNavigate={(id) => { setPage(id); setSelected(null); setDetail(null); }} lang={lang} />
          <div className="cr-top-actions">
            <span className="cr-secure">
              <i /> {CO.privateWorkspace}
            </span>
            <NotificationBell
              workspace="company"
              availableSections={nav.map(([id]) => id)}
              onNavigate={(id) => { setPage(id); setSelected(null); setDetail(null); }}
              buttonClassName="cr-icon-btn"
            />
            <button
              className="cr-icon-btn"
              onClick={load}
              title={C.common.refresh}
              aria-label={C.common.refresh}
            >
              <WorkspaceIcon name="refresh" size={18} />
            </button>
            <select className="ws-language" aria-label="Language" value={lang} onChange={(event) => setLang(event.target.value)}><option value="en">English</option><option value="bn">বাংলা</option></select>
            <div className="cr-top-avatar">
              {initials(workspace?.company?.name)}
            </div>
            <button type="button" className="cr-logout-btn" onClick={onLogout}>
              <WorkspaceIcon name="logout" size={16} /> {CO.logOut}
            </button>
          </div>
        </header>
        <div className="cr-content" id="company-content" tabIndex={-1} aria-busy={busy}>
          {!workspace && busy && <WorkspaceLoading />}
          {toast && (
            <div className="cr-toast" role="status">
              <span>✓</span>
              {toast}
              <button type="button" aria-label="Dismiss" onClick={() => setToast("")}>×</button>
            </div>
          )}
          {error &&
            !needsOrganisation && (
              <div className="cr-error-banner" role="alert">
                {error}
                <button type="button" aria-label="Dismiss" onClick={() => setError("")}>×</button>
              </div>
            )}
          {secondaryErrors.length > 0 && <div className="cr-error-banner" role="alert"><div><strong>Some workspace data could not be refreshed.</strong>{secondaryErrors.map((message) => <p key={message}>{message}</p>)}</div><button type="button" className="cr-outline-btn" onClick={load} disabled={busy}>Retry</button></div>}
          {workspace && workspace.verification?.status !== "verified" && (
            <div className="cr-verification-banner">
              <div>
                <strong>{CO.verification.title}</strong>
                <span>
                  {workspace?.verification?.status === "pending_review"
                    ? CO.verification.pending
                    : CO.verification.required}
                </span>
              </div>
              <button
                onClick={() => {
                  setPage("settings");
                  setVerificationForm(true);
                }}
              >
                {CO.verification.review}
              </button>
            </div>
          )}
          {page === "overview" && (
            <section>
              <div className="cr-page-heading">
                <div>
                  <div className="cr-kicker">{CO.overviewKicker}</div>
                  <h1>{CO.overviewTitle}</h1>
                  <p>{CO.overviewSub}</p>
                </div>
                <button
                  className="cr-primary"
                  onClick={() => {
                    setJobEditId(canCreateJob ? "new" : null);
                    setPage("jobs");
                  }}
                  disabled={!canCreateJob}
                  title={jobEligibility.reason || "Create a job"}
                >
                  ＋ Create a job
                </button>
              </div>
              <div className="cr-metrics">
                {metric(
                  "Open roles",
                  analytics?.totals?.published_jobs ??
                    jobs.filter((j) => j.status === "published").length,
                  "Published opportunities",
                  "▤",
                )}
                {metric(
                  "Total applicants",
                  analytics?.totals?.applicants ?? applications.length,
                  "Across all roles",
                  "♙",
                )}
                {metric(
                  "In review",
                  applications.filter((a) =>
                    ["in_review", "preliminary_assessment"].includes(a.status),
                  ).length,
                  "Needs recruiter attention",
                  "◷",
                )}
                {metric(
                  "Shared assessments",
                  analytics?.totals?.shared_results ??
                    applications.filter((a) => a.results_shared).length,
                  "Candidate-consented evidence",
                  "✓",
                )}
              </div>
              <div className="cr-overview-grid">
                <div className="cr-panel">
                  <div className="cr-panel-head">
                    <div>
                      <h2>Recent applicants</h2>
                      <p>Latest applications across your roles</p>
                    </div>
                    <button
                      className="cr-text-btn"
                      onClick={() => setPage("applicants")}
                      disabled={!canManagePipeline}
                    >
                      View all →
                    </button>
                  </div>
                  {applications.slice(0, 5).length ? (
                    applications.slice(0, 5).map((a) => (
                      <button
                        className="cr-applicant-row"
                        key={a.application_id}
                        onClick={() => openApplication(a.application_id)}
                      >
                        <div className="cr-person-avatar">
                          {initials(a.candidate_name)}
                        </div>
                        <div className="cr-person-copy">
                          <strong>{a.candidate_name}</strong>
                          <span>{a.job_title}</span>
                        </div>
                        <span data-tone={statusTone(a.status)} className={"cr-stage cr-stage-" + a.status}>
                          {a.status.replaceAll("_", " ")}
                        </span>
                        <span className="cr-row-arrow">→</span>
                      </button>
                    ))
                  ) : (
                    <div className="cr-empty">
                      <span aria-hidden="true"><WorkspaceIcon name="team" size={20} /></span>
                      <strong>No applicants yet</strong>
                      <p>
                        Published roles will appear here as candidates apply.
                      </p>
                    </div>
                  )}
                </div>
                <div className="cr-panel">
                  <div className="cr-panel-head">
                    <div>
                      <h2>Hiring activity</h2>
                      <p>Application stages</p>
                    </div>
                  </div>
                  {stages.slice(0, 7).map(([key, label]) => (
                    <div className="cr-stage-line" key={key}>
                      <span>{label}</span>
                      <strong>
                        {pipelineCounts[key] || 0}
                      </strong>
                      <div>
                        <i
                          style={{
                            width:
                              (pipelineTotal ? ((pipelineCounts[key] || 0) / pipelineTotal) * 100 : 0) + "%",
                          }}
                        />
                      </div>
                    </div>
                  ))}
                  <p className="cr-footnote">
                    Pipeline counts reflect applications in this organisation
                    only.
                  </p>
                </div>
              </div>
              <div className="cr-panel cr-jobs-panel">
                <div className="cr-panel-head">
                  <div>
                    <h2>Your jobs</h2>
                    <p>Manage drafts, published roles and review status</p>
                  </div>
                  <button
                    className="cr-text-btn"
                    onClick={() => setPage("jobs")}
                  >
                    Manage jobs →
                  </button>
                </div>
                <div className="cr-table-wrap">
                  <table className="cr-table">
                    <thead>
                      <tr>
                        <th>Role</th>
                        <th>Status</th>
                        <th>Applicants</th>
                        <th>Posted</th>
                        <th></th>
                      </tr>
                    </thead>
                    <tbody>
                      {jobs.slice(0, 5).map((j) => (
                        <tr key={j.id}>
                          <td>
                            <strong>{j.title}</strong>
                            <small>
                              {j.location} · {j.employment_type}
                            </small>
                          </td>
                          <td>
                            <span data-tone={statusTone(j.status)} className={"cr-status cr-status-" + j.status}>
                              {j.status.replaceAll("_", " ")}
                            </span>
                          </td>
                          <td>
                            {
                              applications.filter((a) => a.job_id === j.id)
                                .length
                            }
                          </td>
                          <td>{date(j.created)}</td>
                          <td>
                            <button
                              className="cr-text-btn"
                              onClick={() => editJob(j)}
                            >
                              Edit
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {!jobs.length && (
                    <div className="cr-empty">
                      <strong>Your first role starts here</strong>
                      <p>
                        Create a structured job description to begin attracting
                        applicants.
                      </p>
                    </div>
                  )}
                </div>
              </div>
            </section>
          )}
          {page === "jobs" && (
            <section>
              <div className="cr-page-heading">
                <div>
                  <div className="cr-kicker">Job management</div>
                  <h1>{jobEditId ? "Edit job" : "Your jobs"}</h1>
                  <p>
                    Create, review and manage every opportunity from one place.
                  </p>
                </div>
                {!jobEditId && (
                  <button
                    className="cr-primary"
                    onClick={() => {
                      if (!canCreateJob) {
                        setPage("settings");
                        return;
                      }
                      setJobEditId("new");
                    }}
                    disabled={!canCreateJob}
                    title={jobEligibility.reason || "Create a job"}
                  >
                    ＋ New job
                  </button>
                )}
              </div>
              {!jobEligibility.can_create_draft && (
                <div className="cr-verification-banner">
                  <div>
                    <strong>Company eligibility required</strong>
                    <span>{jobEligibility.reason}</span>
                  </div>
                  <button onClick={() => setPage("settings")}>
                    Review status →
                  </button>
                </div>
              )}
              {jobEditId !== null && (
                <form className="cr-panel cr-form-panel" onSubmit={submitJob}>
                  <div className="cr-panel-head">
                    <div>
                      <h2>
                        {jobEditId === "new"
                          ? "Create a job"
                          : "Edit job details"}
                      </h2>
                      <p>
                        Complete the required details before submitting for
                        publication.
                      </p>
                    </div>
                    <button
                      type="button"
                      className="cr-text-btn"
                      onClick={() => setJobEditId(null)}
                    >
                      Cancel
                    </button>
                  </div>
                  <div className="cr-form-grid">
                    <label className="cr-span-2">
                      Job title
                      <input
                        required
                        minLength={3}
                        value={jobForm.title}
                        onChange={(e) => setJob("title", e.target.value)}
                        placeholder="e.g. Senior Product Designer"
                      />
                    </label>
                    <label>
                      Location
                      <input
                        value={jobForm.location}
                        onChange={(e) => setJob("location", e.target.value)}
                      />
                    </label>
                    <label>
                      Employment type
                      <select
                        value={jobForm.employment_type}
                        onChange={(e) =>
                          setJob("employment_type", e.target.value)
                        }
                      >
                        {[
                          "Full-time",
                          "Part-time",
                          "Contract",
                          "Internship",
                          "Temporary",
                        ].map((x) => (
                          <option key={x}>{x}</option>
                        ))}
                      </select>
                    </label>
                    <label>
                      Work arrangement
                      <select
                        value={jobForm.work_mode}
                        onChange={(e) => setJob("work_mode", e.target.value)}
                      >
                        {["Remote", "Hybrid", "On-site"].map((x) => (
                          <option key={x}>{x}</option>
                        ))}
                      </select>
                    </label>
                    <label>
                      Experience level
                      <select
                        value={jobForm.experience_level}
                        onChange={(e) =>
                          setJob("experience_level", e.target.value)
                        }
                      >
                        {[
                          "Any",
                          "Entry-level",
                          "Junior",
                          "Mid-level",
                          "Senior",
                          "Lead",
                        ].map((x) => (
                          <option key={x}>{x}</option>
                        ))}
                      </select>
                    </label>
                    <label>
                      Minimum salary
                      <input
                        type="number"
                        min="0"
                        value={jobForm.salary_min}
                        onChange={(e) => setJob("salary_min", e.target.value)}
                        placeholder="Optional"
                      />
                    </label>
                    <label>
                      Maximum salary
                      <input
                        type="number"
                        min="0"
                        value={jobForm.salary_max}
                        onChange={(e) => setJob("salary_max", e.target.value)}
                        placeholder="Optional"
                      />
                    </label>
                    <label>
                      Salary currency
                      <select
                        value={jobForm.salary_currency}
                        onChange={(e) =>
                          setJob("salary_currency", e.target.value)
                        }
                      >
                        <option>BDT</option>
                        <option>USD</option>
                        <option>INR</option>
                      </select>
                    </label>
                    <label>
                      Application deadline
                      <input
                        type="date"
                        value={jobForm.deadline}
                        onChange={(e) => setJob("deadline", e.target.value)}
                      />
                    </label>
                    <label className="cr-span-2">
                      Job description
                      <textarea
                        required
                        minLength={20}
                        rows="6"
                        value={jobForm.description}
                        onChange={(e) => setJob("description", e.target.value)}
                        placeholder="Describe the role, responsibilities and what success looks like..."
                      />
                    </label>
                    <label className="cr-span-2">
                      Required skills <small>Comma-separated</small>
                      <input
                        value={jobForm.required_skills}
                        onChange={(e) =>
                          setJob("required_skills", e.target.value)
                        }
                        placeholder="React, TypeScript, UX research"
                      />
                    </label>
                    <label className="cr-span-2">
                      Preferred skills <small>Comma-separated</small>
                      <input
                        value={jobForm.preferred_skills}
                        onChange={(e) =>
                          setJob("preferred_skills", e.target.value)
                        }
                        placeholder="Figma, accessibility, design systems"
                      />
                    </label>
                    <label className="cr-span-2">
                      Eligibility criteria
                      <textarea
                        rows="2"
                        value={jobForm.eligibility}
                        onChange={(e) => setJob("eligibility", e.target.value)}
                      />
                    </label>
                    <label className="cr-span-2">
                      Hard requirements <small>One per line</small>
                      <textarea
                        rows="3"
                        value={jobForm.hard_requirements}
                        onChange={(e) =>
                          setJob("hard_requirements", e.target.value)
                        }
                      />
                    </label>
                  </div>
                  <div className="cr-form-footer">
                    <span>
                      {jobEligibility.can_publish
                        ? "Jobs are saved as drafts and can be submitted for platform review."
                        : jobEligibility.reason ||
                          "Jobs are saved as drafts. Verified organisations can submit them for review."}
                    </span>
                    <button
                      className="cr-primary"
                      disabled={
                        busy || (jobEditId === "new" && !canCreateJob)
                      }
                    >
                      Save job draft
                    </button>
                  </div>
                </form>
              )}
              <div className="cr-job-list">
                {jobs.map((j) => (
                  <article className="cr-job-card" key={j.id}>
                    <div className="cr-job-icon" aria-hidden="true"><WorkspaceIcon name="jobs" size={18} /></div>
                    <div className="cr-job-main">
                      <div className="cr-job-title">
                        <h3>{j.title}</h3>
                        <span data-tone={statusTone(j.status)} className={"cr-status cr-status-" + j.status}>
                          {j.status.replaceAll("_", " ")}
                        </span>
                      </div>
                      <p>
                        {j.location} · {j.employment_type} ·{" "}
                        {applications.filter((a) => a.job_id === j.id).length}{" "}
                        applicants
                      </p>
                      <div className="cr-tags">
                        {(j.skills || []).slice(0, 5).map((s) => (
                          <span key={s}>{s}</span>
                        ))}
                      </div>
                      <small>
                        Created {date(j.created)} · Revision {j.revision || 1}
                      </small>
                    </div>
                    <div className="cr-job-actions">
                      {canManageJobs &&
                        ["draft", "needs_changes", "paused"].includes(
                          j.status,
                        ) && (
                          <button
                            className="cr-outline-btn"
                            onClick={() => editJob(j)}
                          >
                            Edit
                          </button>
                        )}
                      {j.status === "draft" ||
                      j.status === "needs_changes" ||
                      j.status === "paused" ? (
                        <button
                          className="cr-primary cr-small"
                          onClick={() => publishJob(j.id)}
                          disabled={!canPublishJob}
                          title={
                            canPublishJob
                              ? "Submit this job for platform review"
                              : jobEligibility.reason
                          }
                        >
                          Submit for review
                        </button>
                      ) : null}
                      {j.status === "published" ? (
                        <button
                          className="cr-outline-btn"
                          onClick={() => jobStatus(j.id, "paused")}
                        >
                          Pause
                        </button>
                      ) : null}
                      {j.status === "paused" ? (
                        <button
                          className="cr-outline-btn"
                          onClick={() => jobStatus(j.id, "closed")}
                        >
                          Close
                        </button>
                      ) : null}
                      <button
                        className="cr-text-btn"
                        onClick={async () => {
                          try {
                            const r = await api(
                              "/company/jobs/" + j.id + "/revisions",
                            );
                            flash(r.items.length + " saved revisions");
                          } catch (e) {
                            fail(e);
                          }
                        }}
                      >
                        History
                      </button>
                    </div>
                  </article>
                ))}
                {!jobs.length && (
                  <div className="cr-empty">
                    <strong>No jobs created yet</strong>
                    <p>Start with one clear, structured job description.</p>
                  </div>
                )}
              </div>
            </section>
          )}
          {page === "applicants" && (
            <section>
              <div className="cr-page-heading">
                <div>
                  <div className="cr-kicker">Talent pipeline</div>
                  <h1>Applicants</h1>
                  <p>
                    Review applications with candidate-consented evidence and
                    human-led decisions.
                  </p>
                </div>
              </div>
              <div className="cr-toolbar">
                <div className="cr-search">
                  <WorkspaceIcon name="search" size={16} />
                  <input
                    placeholder="Search candidates or roles..."
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                  />
                </div>
                <select
                  value={filterJob}
                  onChange={(e) => setFilterJob(e.target.value)}
                >
                  <option value="all">All jobs</option>
                  {jobs.map((j) => (
                    <option key={j.id} value={j.id}>
                      {j.title}
                    </option>
                  ))}
                </select>
                <span>{filteredApps.length} applicants</span>
              </div>
              <div className="cr-pipeline">
                {stages.slice(0, 6).map(([key, label]) => (
                  <div className="cr-pipeline-col" key={key}>
                    <div className="cr-pipeline-head">
                      <strong>{label}</strong>
                      <span>
                        {filteredApps.filter((a) => a.status === key).length}
                      </span>
                    </div>
                    {filteredApps
                      .filter((a) => a.status === key)
                      .map((a) => (
                        <button
                          className="cr-candidate-card"
                          key={a.application_id}
                          onClick={() => openApplication(a.application_id)}
                        >
                          <div className="cr-person-avatar">
                            {initials(a.candidate_name)}
                          </div>
                          <strong>{a.candidate_name}</strong>
                          <small>{a.job_title}</small>
                          <span className="cr-candidate-meta">
                            {a.results_shared
                              ? "✓ Assessment shared"
                              : "Assessment not shared"}
                          </span>
                        </button>
                      ))}
                    {!filteredApps.some((a) => a.status === key) && (
                      <div className="cr-pipeline-empty">No candidates</div>
                    )}
                  </div>
                ))}
              </div>
              <div className="cr-panel cr-applicant-table">
                <div className="cr-panel-head">
                  <div>
                    <h2>All applications</h2>
                    <p>Detailed list across your organisation</p>
                  </div>
                </div>
                <div className="cr-table-wrap">
                  <table className="cr-table">
                    <thead>
                      <tr>
                        <th>Candidate</th>
                        <th>Role</th>
                        <th>Stage</th>
                        <th>Assessment</th>
                        <th>Applied</th>
                        <th></th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredApps.map((a) => (
                        <tr key={a.application_id}>
                          <td>
                            <strong>{a.candidate_name}</strong>
                          </td>
                          <td>{a.job_title}</td>
                          <td>
                            <span data-tone={statusTone(a.status)} className={"cr-stage cr-stage-" + a.status}>
                              {a.status.replaceAll("_", " ")}
                            </span>
                          </td>
                          <td>
                            {a.results_shared
                              ? "Shared by candidate"
                              : "Not shared"}
                            {a.results_shared && a.latest_assessment && (
                              <small className="cr-latest-assessment">
                                {a.latest_assessment.overall == null
                                  ? "Awaiting review"
                                  : `${a.latest_assessment.overall}/100${a.latest_assessment.level ? ` · ${a.latest_assessment.level}` : ""}`}
                              </small>
                            )}
                          </td>
                          <td>{date(a.created)}</td>
                          <td>
                            <div className="cr-row-actions">
                              <button
                                className="cr-text-btn"
                                onClick={() => openApplication(a.application_id)}
                              >
                                Review →
                              </button>
                              {canManagePipeline && !a.shortlisted && (
                                <button
                                  className="cr-text-btn"
                                  onClick={() => shortlistCandidate(a)}
                                >
                                  Shortlist
                                </button>
                              )}
                              {canManagePipeline && a.shortlisted && (
                                <button
                                  className="cr-text-btn"
                                  onClick={() => openInterviewSetup(a)}
                                >
                                  {a.interview_method && a.interview_method !== "none"
                                    ? "Interview"
                                    : "Set interview"}
                                </button>
                              )}
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </section>
          )}
          {page === "assessments" && (
            <section>
              <div className="cr-page-heading">
                <div>
                  <div className="cr-kicker">Role-specific evaluation</div>
                  <h1>Second-phase assessments</h1>
                  <p>
                    Configure job-specific tasks with a clear syllabus, rubric
                    and candidate notice.
                  </p>
                </div>
              </div>
              <div className="cr-info-banner">
                <strong>Human approval is required.</strong> New
                company-authored assessment content is saved as a draft request
                for platform review. It is not sent to candidates until approved
                and a notification flow is available.
              </div>
              {canManageJobs && (
                <div className="cr-panel cr-form-panel">
                  <div className="cr-panel-head">
                    <div>
                      <h2>Configure an assessment</h2>
                      <p>
                        Choose an applicant, define the scope and set fair,
                        job-relevant criteria.
                      </p>
                    </div>
                  </div>
                  <form onSubmit={createPhase}>
                    <div className="cr-form-grid">
                      <label className="cr-span-2">
                        Applicant
                        <select
                          required
                          value={selectedApp}
                          onChange={(e) => setSelectedApp(e.target.value)}
                        >
                          <option value="">Select an applicant</option>
                          {applications
                            .filter((a) =>
                              [
                                "submitted",
                                "preliminary_assessment",
                                "in_review",
                                "phase_two_invited",
                              ].includes(a.status),
                            )
                            .map((a) => (
                              <option key={a.application_id} value={a.application_id}>
                                {a.candidate_name} · {a.job_title}
                              </option>
                            ))}
                        </select>
                      </label>
                      <label className="cr-span-2">
                        Assessment title
                        <input
                          required
                          value={phaseForm.title}
                          onChange={(e) =>
                            setPhaseForm((v) => ({
                              ...v,
                              title: e.target.value,
                            }))
                          }
                        />
                      </label>
                      <label className="cr-span-2">
                        Requirements
                        <textarea
                          rows="3"
                          value={phaseForm.requirements}
                          onChange={(e) =>
                            setPhaseForm((v) => ({
                              ...v,
                              requirements: e.target.value,
                            }))
                          }
                        />
                      </label>
                      <label className="cr-span-2">
                        Syllabus / topics <small>One topic per line</small>
                        <textarea
                          rows="4"
                          required
                          value={phaseForm.syllabus}
                          onChange={(e) =>
                            setPhaseForm((v) => ({
                              ...v,
                              syllabus: e.target.value,
                            }))
                          }
                          placeholder={
                            "SQL joins and aggregation\nData interpretation\nProblem solving"
                          }
                        />
                      </label>
                      <label className="cr-span-2">
                        Question types <small>Select all that apply</small>
                        <div className="cr-check-grid">
                          {[
                            "mcq",
                            "sql",
                            "coding",
                            "scenario",
                            "short_answer",
                          ].map((q) => (
                            <label key={q} className="cr-check-option">
                              <input
                                type="checkbox"
                                checked={phaseForm.question_types.includes(q)}
                                onChange={(e) =>
                                  setPhaseForm((v) => ({
                                    ...v,
                                    question_types: e.target.checked
                                      ? [...v.question_types, q]
                                      : v.question_types.filter((x) => x !== q),
                                  }))
                                }
                              />
                              {q.replaceAll("_", " ")}
                            </label>
                          ))}
                        </div>
                      </label>
                      <label>
                        Easy (%)
                        <input
                          type="number"
                          min="0"
                          max="100"
                          value={phaseForm.difficulty_easy}
                          onChange={(e) =>
                            setPhaseForm((v) => ({
                              ...v,
                              difficulty_easy: Number(e.target.value),
                            }))
                          }
                        />
                      </label>
                      <label>
                        Medium (%)
                        <input
                          type="number"
                          min="0"
                          max="100"
                          value={phaseForm.difficulty_medium}
                          onChange={(e) =>
                            setPhaseForm((v) => ({
                              ...v,
                              difficulty_medium: Number(e.target.value),
                            }))
                          }
                        />
                      </label>
                      <label>
                        Hard (%)
                        <input
                          type="number"
                          min="0"
                          max="100"
                          value={phaseForm.difficulty_hard}
                          onChange={(e) =>
                            setPhaseForm((v) => ({
                              ...v,
                              difficulty_hard: Number(e.target.value),
                            }))
                          }
                        />
                      </label>
                      <label>
                        Duration (minutes)
                        <input
                          type="number"
                          min="10"
                          max="360"
                          value={phaseForm.duration_minutes}
                          onChange={(e) =>
                            setPhaseForm((v) => ({
                              ...v,
                              duration_minutes: Number(e.target.value),
                            }))
                          }
                        />
                      </label>
                      <label>
                        Deadline
                        <input
                          type="date"
                          value={phaseForm.deadline}
                          onChange={(e) =>
                            setPhaseForm((v) => ({
                              ...v,
                              deadline: e.target.value,
                            }))
                          }
                        />
                      </label>
                      <label>
                        Allowed attempts
                        <input
                          type="number"
                          min="1"
                          max="3"
                          value={phaseForm.attempt_count}
                          onChange={(e) =>
                            setPhaseForm((v) => ({
                              ...v,
                              attempt_count: Number(e.target.value),
                            }))
                          }
                        />
                      </label>
                      <label>
                        Integrity mode
                        <select
                          value={phaseForm.integrity_mode}
                          onChange={(e) =>
                            setPhaseForm((v) => ({
                              ...v,
                              integrity_mode: e.target.value,
                            }))
                          }
                        >
                          <option value="light">Light · default</option>
                          <option value="standard">
                            Standard · consent required
                          </option>
                          <option value="strict">
                            Strict · legal approval required
                          </option>
                        </select>
                      </label>
                      <label>
                        Credit cost
                        <input
                          type="number"
                          min="0"
                          value={phaseForm.credit_cost}
                          onChange={(e) =>
                            setPhaseForm((v) => ({
                              ...v,
                              credit_cost: Number(e.target.value),
                            }))
                          }
                        />
                      </label>
                      <label className="cr-span-2">
                        Scoring rubric{" "}
                        <small>One job-related criterion per line</small>
                        <textarea
                          rows="3"
                          required
                          value={phaseForm.rubric}
                          onChange={(e) =>
                            setPhaseForm((v) => ({
                              ...v,
                              rubric: e.target.value,
                            }))
                          }
                          placeholder={
                            "Correctness and reasoning\nProblem decomposition\nCommunication of trade-offs"
                          }
                        />
                      </label>
                      <label className="cr-span-2">
                        Allowed resources{" "}
                        <small>One allowed resource per line</small>
                        <textarea
                          rows="2"
                          value={phaseForm.allowed_resources}
                          onChange={(e) =>
                            setPhaseForm((v) => ({
                              ...v,
                              allowed_resources: e.target.value,
                            }))
                          }
                        />
                      </label>
                      <label className="cr-span-2">
                        Accommodations / alternate route
                        <textarea
                          rows="2"
                          value={phaseForm.accommodations}
                          onChange={(e) =>
                            setPhaseForm((v) => ({
                              ...v,
                              accommodations: e.target.value,
                            }))
                          }
                        />
                      </label>
                    </div>
                    <div className="cr-form-footer">
                      <span>
                        Unreviewed AI-generated questions cannot be used in a
                        live assessment.
                      </span>
                      <button className="cr-primary">
                        {editingPhaseId ? "Resubmit for platform review" : "Submit for platform review"}
                      </button>
                      {editingPhaseId && (
                        <button type="button" className="cr-outline-btn" onClick={() => setEditingPhaseId(null)}>
                          Cancel editing
                        </button>
                      )}
                    </div>
                  </form>
                </div>
              )}
              <div className="cr-panel">
                <div className="cr-panel-head">
                  <div>
                    <h2>Assessment requests</h2>
                    <p>Saved configurations and their review status</p>
                  </div>
                </div>
                {phaseTwo.length ? (
                  phaseTwo.map((p) => (
                    <div className="cr-assessment-row" key={p.id}>
                      <div>
                        <strong>{p.title}</strong>
                        <span>
                          {p.candidate_name} · {p.job_title}
                        </span>
                      </div>
                      <span className="cr-status cr-status-pending_review">
                        {p.status.replaceAll("_", " ")}
                        {p.version ? ` · v${p.version}` : ""}
                      </span>
                      {["needs_changes", "pending_platform_review"].includes(p.status) && canManagePipeline && (
                        <button
                          type="button"
                          className="cr-outline-btn"
                          onClick={() => {
                            const c = p.config || {};
                            const lines = (value) => (Array.isArray(value) ? value.map((x) => (typeof x === "string" ? x : x?.criterion || "")).filter(Boolean).join("\n") : String(value || ""));
                            setPhaseForm((v) => ({
                              ...v,
                              ...c,
                              title: p.title || c.title || v.title,
                              requirements: p.requirements || c.requirements || v.requirements,
                              deadline: p.deadline || c.deadline || "",
                              syllabus: lines(c.syllabus),
                              rubric: lines(c.rubric),
                              allowed_resources: lines(c.allowed_resources),
                              question_types: Array.isArray(c.question_types) ? c.question_types : v.question_types,
                              difficulty_easy: c.difficulty?.easy ?? v.difficulty_easy,
                              difficulty_medium: c.difficulty?.medium ?? v.difficulty_medium,
                              difficulty_hard: c.difficulty?.hard ?? v.difficulty_hard,
                            }));
                            setSelectedApp(p.application_id);
                            setEditingPhaseId(p.id);
                            window.scrollTo({ top: 0, behavior: "smooth" });
                          }}
                        >
                          {p.status === "needs_changes" ? "Edit & resubmit" : "Edit request"}
                        </button>
                      )}
                    </div>
                  ))
                ) : (
                  <div className="cr-empty">
                    <strong>No assessment requests yet</strong>
                    <p>Configured requests will appear here.</p>
                  </div>
                )}
              </div>
            </section>
          )}
          {page === "analytics" && (
            <section>
              <div className="cr-page-heading">
                <div>
                  <div className="cr-kicker">Hiring performance</div>
                  <h1>Analytics</h1>
                  <p>
                    Understand pipeline volume and role performance. Counts are
                    descriptive, not candidate quality rankings.
                  </p>
                </div>
              </div>
              <div className="cr-metrics">
                {metric(
                  "Total roles",
                  analytics?.totals?.jobs ?? 0,
                  "All job records",
                  "▤",
                )}
                {metric(
                  "Published roles",
                  analytics?.totals?.published_jobs ?? 0,
                  "Live opportunities",
                  "↗",
                )}
                {metric(
                  "Applications",
                  analytics?.totals?.applicants ?? 0,
                  "Received applications",
                  "♙",
                )}
                {metric(
                  "Shared results",
                  analytics?.totals?.shared_results ?? 0,
                  "Candidate opted-in",
                  "✓",
                )}
              </div>
              <div className="cr-overview-grid">
                <div className="cr-panel">
                  <div className="cr-panel-head">
                    <div>
                      <h2>Pipeline distribution</h2>
                      <p>Current application counts by stage</p>
                    </div>
                  </div>
                  {stages.map(([key, label]) => (
                    <div className="cr-stage-line" key={key}>
                      <span>{label}</span>
                      <strong>
                        {pipelineCounts[key] || 0}
                      </strong>
                      <div>
                        <i
                          style={{
                            width:
                              (pipelineTotal ? ((pipelineCounts[key] || 0) / pipelineTotal) * 100 : 0) + "%",
                          }}
                        />
                      </div>
                    </div>
                  ))}
                </div>
                <div className="cr-panel">
                  <div className="cr-panel-head">
                    <div>
                      <h2>Role performance</h2>
                      <p>Application volume by job</p>
                    </div>
                  </div>
                  {(analytics?.jobs || []).map((j) => (
                    <div className="cr-performance-row" key={j.id}>
                      <div>
                        <strong>{j.title}</strong>
                        <span>{j.status}</span>
                      </div>
                      <b>{j.applicants}</b>
                    </div>
                  ))}
                </div>
              </div>
            </section>
          )}
          {page === "team" && (
            <section>
              <div className="cr-page-heading">
                <div>
                  <div className="cr-kicker">Organisation access</div>
                  <h1>Team members</h1>
                  <p>Invite colleagues with least-privilege roles.</p>
                </div>
              </div>
              <div className="cr-info-banner">
                Owner manages organisation settings and billing. Recruiters
                manage jobs and applicants. Hiring Managers provide structured
                review. Viewers have read-only reporting access.
              </div>
              {canManageTeam && (
                <form
                  className="cr-panel cr-team-invite"
                  onSubmit={inviteMember}
                >
                  <div>
                    <h2>Invite a teammate</h2>
                    <p>
                      Invitation token is generated for secure manual delivery.
                    </p>
                  </div>
                  <label>
                    Email address
                    <input
                      type="email"
                      required
                      value={teamForm.email}
                      onChange={(e) =>
                        setTeamForm((v) => ({ ...v, email: e.target.value }))
                      }
                    />
                  </label>
                  <label>
                    Role
                    <select
                      value={teamForm.role}
                      onChange={(e) =>
                        setTeamForm((v) => ({ ...v, role: e.target.value }))
                      }
                    >
                      <option value="recruiter">Recruiter</option>
                      <option value="hiring_manager">Hiring Manager</option>
                      <option value="viewer">Viewer / Analyst</option>
                    </select>
                  </label>
                  <button className="cr-primary" disabled={memberBusy}>{memberBusy ? "Creating…" : "Create invitation"}</button>
                  {inviteToken && (
                    <div className="cr-invite-token">
                      <strong>Invitation token</strong>
                      <code>{inviteToken}</code>
                      <button
                        type="button"
                        className="cr-outline-btn"
                        onClick={async () => {
                          try {
                            if (!navigator.clipboard) throw new Error("Clipboard unavailable");
                            await navigator.clipboard.writeText(inviteToken);
                            setCopyStatus("Copied. Share securely with the invited teammate.");
                          } catch { setCopyStatus("Could not copy automatically. Select the token above and copy it manually."); }
                        }}
                      >
                        Copy token
                      </button>
                      {copyStatus && <p className="cr-footnote" role="status">{copyStatus}</p>}
                      <p className="cr-footnote">
                        The invited teammate can enter this token on the company
                        setup screen after signing in.
                      </p>
                    </div>
                  )}
                </form>
              )}
              <div className="cr-panel">
                <div className="cr-panel-head">
                  <div>
                    <h2>Workspace access</h2>
                    <p>Current invitations and active memberships</p>
                  </div>
                </div>
                <div className="cr-team-row"><div className="cr-person-avatar"><WorkspaceIcon name="privacy" size={18} /></div><div><strong>{companyEmail || "Workspace owner"}</strong><span>Organisation owner · full workspace access</span></div><span className="cr-role-pill">Owner</span></div>
                {team.map((m) => (
                  <div className="cr-team-row" key={m.id}>
                    <div className="cr-person-avatar">{initials(m.email)}</div>
                    <div>
                      <strong>{m.email}</strong>
                      <span>{m.status}</span>
                    </div>
                    <span className="cr-role-pill">
                      {m.company_role.replace("_", " ")}
                    </span>
                    {canManageTeam && m.status !== "revoked" && (
                      <select
                        aria-label={`Role for ${m.email}`}
                        disabled={memberBusy}
                        value={m.company_role}
                        onChange={(e) => changeMemberRole(m, e.target.value)}
                      >
                        <option value="recruiter">Recruiter</option>
                        <option value="hiring_manager">Hiring Manager</option>
                        <option value="viewer">Viewer</option>
                        <option value="revoked">Revoke</option>
                      </select>
                    )}
                    {canManageTeam && m.status !== "active" && <button type="button" className="cr-outline-btn" disabled={memberBusy} onClick={() => sendInvite({ email: m.email, role: m.company_role })}>{m.status === "revoked" ? "Re-invite" : "New token"}</button>}
                  </div>
                ))}
                {!team.length && (
                  <div className="cr-empty">No additional members yet.</div>
                )}
              </div>
            </section>
          )}
          {page === "agent" && <Suspense fallback={<WorkspaceLoading />}><AgentConsole /></Suspense>}
          {page === "settings" && (
            <section>
              <div className="cr-page-heading">
                <div>
                  <div className="cr-kicker">Organisation profile</div>
                  <h1>Company settings</h1>
                  <p>
                    Manage your organisation identity and verification details.
                  </p>
                </div>
              </div>
              <div className="cr-settings-grid">
                <div className="cr-panel">
                  <h2>Company profile</h2>
                  {isOwner ? (
                    <form onSubmit={saveCompany}>
                      <label>
                        Organisation name
                        <input
                          required
                          value={companyName}
                          onChange={(e) => setCompanyName(e.target.value)}
                        />
                      </label>
                      <label>
                        Website
                        <input
                          value={website}
                          onChange={(e) => setWebsite(e.target.value)}
                        />
                      </label>
                      <button className="cr-primary">Save profile</button>
                    </form>
                  ) : (
                    <p>
                      Only the organisation owner can edit company identity
                      details.
                    </p>
                  )}
                </div>
                <div className="cr-panel">
                  <h2>Verification status</h2>
                  <span
                    className={
                      "cr-status cr-status-" +
                      (workspace?.verification?.status || "not_submitted")
                    }
                  >
                    {(
                      workspace?.verification?.status || "not submitted"
                    ).replaceAll("_", " ")}
                  </span>
                  <p>
                    {workspace?.verification?.decision_reason ||
                      "Company verification is required before public job publishing and applicant access."}
                  </p>
                  {isOwner && (
                    <button
                      className="cr-outline-btn"
                      onClick={() => setVerificationForm(!verificationForm)}
                    >
                      {verificationForm
                        ? "Cancel"
                        : "Submit / update verification"}
                    </button>
                  )}
                </div>
              </div>
              {verificationForm && isOwner && (
                <form
                  className="cr-panel cr-form-panel"
                  onSubmit={submitVerification}
                >
                  <div className="cr-panel-head">
                    <div>
                      <h2>Organisation verification</h2>
                      <p>
                        Provide legal details and a reference to supporting
                        evidence. Do not upload sensitive identity documents
                        through this prototype.
                      </p>
                    </div>
                  </div>
                  <div className="cr-form-grid">
                    <label>
                      Legal organisation name
                      <input
                        required
                        value={verification.legal_name}
                        onChange={(e) =>
                          setVerification((v) => ({
                            ...v,
                            legal_name: e.target.value,
                          }))
                        }
                      />
                    </label>
                    <label>
                      Country
                      <input
                        required
                        value={verification.country}
                        onChange={(e) =>
                          setVerification((v) => ({
                            ...v,
                            country: e.target.value,
                          }))
                        }
                      />
                    </label>
                    <label>
                      Business registration ID
                      <input
                        value={verification.business_id}
                        onChange={(e) =>
                          setVerification((v) => ({
                            ...v,
                            business_id: e.target.value,
                          }))
                        }
                      />
                    </label>
                    <label className="cr-span-2">
                      Evidence reference / notes
                      <textarea
                        required
                        minLength="10"
                        value={verification.evidence_note}
                        onChange={(e) =>
                          setVerification((v) => ({
                            ...v,
                            evidence_note: e.target.value,
                          }))
                        }
                      />
                    </label>
                  </div>
                  <button className="cr-primary">
                    Submit for verification review
                  </button>
                </form>
              )}
            </section>
          )}
          {page === "security" && (
            <SecurityPanel S={CO.security} email={companyEmail} />
          )}
          {busy && <div className="cr-loading">Refreshing workspace…</div>}
        </div>
        <footer className="cr-footer">
          <span>TalentForge Global · Company workspace</span>
          <span>Evidence-led hiring · Human decisions · Privacy by design</span>
        </footer>
      </main>
      {detail && (
        <dialog
          ref={applicationDialog}
          className="ws-application-dialog"
          aria-labelledby="application-report-title"
          onCancel={() => { setDetail(null); setSelected(null); }}
          onClick={(event) => { if (event.target === applicationDialog.current) { setDetail(null); setSelected(null); } }}
        >
          <aside className="cr-drawer" onClick={(e) => e.stopPropagation()}>
            <div className="cr-drawer-head">
              <div>
                <div className="cr-kicker">Application report</div>
                <h2 id="application-report-title">{detail.candidate_name}</h2>
                <p>{detail.job_title}</p>
              </div>
              <button
                aria-label="Close application report"
                onClick={() => {
                  setDetail(null);
                  setSelected(null);
                }}
              >
                ×
              </button>
            </div>
            <div className="cr-drawer-body">
              <div className="cr-report-note">
                <strong>Evidence visibility</strong>
                <p>
                  This candidate applied to your job, so their CV is available to
                  this workspace only. Assessment scores and the Skill Passport are
                  shown only when the candidate has shared results for this
                  application.
                </p>
              </div>
              <div className="cr-report-section">
                <h3>Application status</h3>
                <span data-tone={statusTone(detail.status)} className={"cr-stage cr-stage-" + detail.status}>
                  {detail.status.replaceAll("_", " ")}
                </span>
                <p>Applied {date(detail.created)}</p>
              </div>
              <div className="cr-report-section">
                <h3>Interview setup</h3>
                <p className="cr-footnote">
                  Shortlisting does not reject anyone. Choose a manual/Zoom interview or an AI
                  interview; AI answers are visible only after a platform admin approves them.
                </p>
                <div className="cr-row-actions">
                  {!detail.shortlisted && canManagePipeline && (
                    <button
                      className="cr-outline-btn"
                      onClick={() => shortlistCandidate(detail)}
                    >
                      Shortlist candidate
                    </button>
                  )}
                  {detail.shortlisted && canManagePipeline && (
                    <button
                      className="cr-outline-btn"
                      onClick={() => openInterviewSetup(detail)}
                    >
                      {detail.interview_method && detail.interview_method !== "none"
                        ? "View / change interview"
                        : "Set up interview"}
                    </button>
                  )}
                  {detail.shortlisted && (
                    <span className="status-pill status-review">
                      {detail.interview_method === "zoom"
                        ? "Manual / Zoom"
                        : detail.interview_method === "ai"
                          ? "AI interview"
                          : "Shortlisted"}
                    </span>
                  )}
                </div>
                <CompanyInterviewResult
                  applicationId={detail.application_id}
                  interview={detail.interview}
                />
              </div>
              <div className="cr-report-section">
                <h3>Candidate CV</h3>
                {detail.candidate_cv?.available ? (
                  <CvPreview url={detail.candidate_cv.url} filename={detail.candidate_cv.filename} />
                ) : (
                  <p className="cr-muted-box">This candidate has not uploaded a CV.</p>
                )}
              </div>
              <div className="cr-report-section">
                <h3>Required job skills vs candidate evidence</h3>
                <div className="cr-tags">
                  {(detail.candidate_skills || detail.required_skills || []).map(
                    (s, index) => {
                      const name = typeof s === "string" ? s : s.required;
                      const status = typeof s === "string" ? "not_shared" : s.status;
                      return (
                        <span key={`${name}-${index}`}>
                          {name} · {String(status).replaceAll("_", " ")}
                          {typeof s === "object" && s.score != null
                            ? ` · ${s.score}%`
                            : ""}
                        </span>
                      );
                    },
                  )}
                </div>
                {detail.skill_evidence_summary && (
                  <p className="cr-footnote">
                    Verified {detail.skill_evidence_summary.verified ?? 0} ·
                    Claimed {detail.skill_evidence_summary.claimed ?? 0} ·
                    Missing {detail.skill_evidence_summary.missing ?? 0}
                    {detail.skill_evidence_summary.not_shared
                      ? ` · Not shared ${detail.skill_evidence_summary.not_shared}`
                      : ""}
                  </p>
                )}
                <p className="cr-footnote">
                  {detail.results_shared
                    ? "Claimed and verified skill evidence is shown because the candidate shared results for this application."
                    : "The candidate has not shared assessment evidence for this application."}
                </p>
              </div>
              <div className="cr-report-section">
                <h3>Shared assessment evidence</h3>
                {detail.results_shared ? (
                  detail.assessment_history?.map((r, idx) => (
                    <div key={r.attempt_id || r.id || idx} className="cr-score-card">
                      <strong>
                        {r.score ?? "—"}
                        <small>/100</small>
                      </strong>
                      <div>
                        <b>{r.result_status}</b>
                        <span>
                          {r.finished ? date(r.finished) : "Date unavailable"} ·{" "}
                          {r.scale}
                        </span>
                        <small>Integrity: {r.integrity_summary}</small>
                      </div>
                    </div>
                  ))
                ) : (
                  <p className="cr-muted-box">
                    Candidate has not shared assessment results for this
                    application.
                  </p>
                )}
              </div>
              {detail.results_shared && detail.passport && (
                <div className="cr-report-section">
                  <h3>Skill Passport</h3>
                  <div className="cr-passport-card">
                    <strong>{detail.passport.holder || detail.candidate_name}</strong>
                    <small>
                      Issued {detail.passport.issued || "—"} · expires{" "}
                      {detail.passport.expires || "—"}
                    </small>
                    <div className="cr-tags">
                      {(detail.passport.skills || []).map((s) => (
                        <span key={s.skill}>
                          {s.name} · {s.score}%
                        </span>
                      ))}
                    </div>
                    {detail.passport.uplift && (
                      <p className="cr-footnote">
                        Uplift: {detail.passport.uplift.pre}% →{" "}
                        {detail.passport.uplift.post}% (+{detail.passport.uplift.delta})
                      </p>
                    )}
                    <a
                      className="cr-passport-link"
                      href={detail.passport.public_url}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Open public passport ↗
                    </a>
                  </div>
                </div>
              )}
              {canManagePipeline && (
                <div className="cr-report-section">
                  <h3>Move through pipeline</h3>
                  <label>
                    New stage
                    <select id="cr-stage-select" defaultValue="">
                      <option value="" disabled>
                        Select a stage
                      </option>
                      {(stageTransitions[detail.status] || []).map((s) => (
                        <option key={s} value={s}>{s.replaceAll("_", " ")}</option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Decision / transition reason
                    <input
                      value={stageReason}
                      onChange={(e) => setStageReason(e.target.value)}
                      placeholder="Required to reject, hire, decline or close"
                    />
                  </label>
                  <button
                    className="cr-primary"
                    onClick={() => {
                      const s =
                        document.getElementById("cr-stage-select")?.value;
                      if (s) moveStage(selected, s);
                    }}
                  >
                    Update application stage
                  </button>
                  <button
                    className="cr-outline-btn"
                    onClick={() => {
                      setSelectedApp(selected);
                      setPage("assessments");
                      setDetail(null);
                    }}
                  >
                    Configure phase-two assessment
                  </button>
                </div>
              )}{" "}
              {canManagePipeline && (
                <div className="cr-report-section">
                  <h3>Private recruiter notes</h3>
                  {detail.notes?.map((n) => (
                    <div key={n.id || n.created} className="cr-note-item">
                      <p>{n.body}</p>
                      <small>{date(n.created)}</small>
                    </div>
                  ))}
                  <form onSubmit={addNote}>
                    <textarea
                      rows="3"
                      required
                      value={note}
                      onChange={(e) => setNote(e.target.value)}
                      placeholder="Add a structured, job-related note for your team..."
                    />
                    <button className="cr-outline-btn">Add note</button>
                  </form>
                </div>
              )}
              <div className="cr-report-section">
                <h3>Decision history</h3>
                {detail.history?.map((h) => (
                  <div key={h.id || `${h.created}-${h.to_stage}`} className="cr-history-item">
                    <strong>
                      {h.from_stage.replaceAll("_", " ")} →{" "}
                      {h.to_stage.replaceAll("_", " ")}
                    </strong>
                    <span>{h.reason}</span>
                    <small>{date(h.created)}</small>
                  </div>
                ))}
                {!detail.history?.length && (
                  <p className="cr-footnote">No stage changes recorded yet.</p>
                )}
              </div>
            </div>
          </aside>
        </dialog>
      )}
      {interviewTarget && (
        <CompanyInterviewModal
          application={interviewTarget}
          onClose={() => setInterviewTarget(null)}
          onSaved={async () => {
            flash("Interview details saved. The candidate was notified.");
            await load();
            if (detail) await openApplication(interviewTarget.application_id);
          }}
        />
      )}
    </div>
  );
}

