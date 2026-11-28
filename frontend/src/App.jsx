import { lazy, Suspense, useEffect, useId, useState, useCallback, useRef, Component } from "react";
import { api, getToken, sendExitBeacon, setToken } from "./api.js";
import { LangCtx, LangSetCtx, useT, useSetLang, useLangValue } from "./i18n.js";
import CandidateProfileWorkspace from "./CandidateProfileWorkspace.jsx";
import Avatar, { useAvatar } from "./Avatar.jsx";
import { WorkspaceIcon, WorkspaceLoading, WorkspaceSearch } from "./WorkspaceUI.jsx";
import AssessmentStatus from "./AssessmentStatus.jsx";
import SkillCredential from "./SkillCredential.jsx";
import CandidateAccountSettings from "./CandidateAccountSettings.jsx";
import PasswordReset from "./PasswordReset.jsx";
import { describeError, errorCode } from "./errors.js";
import { fmt } from "./format.js";
import { statusTone } from "./status.js";
import ConfirmDialog from "./ConfirmDialog.jsx";
import { canRespondToInvite, canWithdrawApplication, humanizeStatus, inviteAwaitingResponse, inviteDeadlinePassed, normalizeInvites } from "./applications.js";
import {
  assessmentNotificationItems,
  isHonestyRejected,
  loadSeenNotifications,
  markNotificationsSeen,
  mergeNotificationFeed,
  notificationBadgeCount,
  notificationKey,
  notificationTimestamp,
  sectionForNotificationLink,
  shouldPollForNotifications,
  unreadNotificationItems,
  unreadServerIds,
} from "./notifications.js";
import { ServerNotificationItem, useServerNotifications } from "./NotificationCenter.jsx";
import useExamDevices, { trackLive } from "./useExamDevices.js";
import useExamMonitoring from "./useExamMonitoring.js";
import AIInterviewCards from "./AIInterviewCards.jsx";

// Every exam is proctored (camera, microphone, screen share, full-screen).
// Only attempts saved before proctoring existed are marked otherwise.
const isProctored = (policy) => policy?.mode !== "legacy_unproctored";
import { loadFaceApi, preloadProctorModels, preloadVisionModels, useProctorModelStatus } from "./proctorModels.js";
// Public support address shown on the landing FAQ. Hidden when not configured.
const SUPPORT_EMAIL = (import.meta.env.VITE_SUPPORT_EMAIL || "").trim();
const CodeWorkspace = lazy(() => import("./CodeWorkspace.jsx"));
// Role-specific workspaces and AI consoles are split out of the candidate bundle.
const AdminConsole = lazy(() => import("./AdminConsole.jsx"));
const HiringWorkspace = lazy(() => import("./HiringWorkspace.jsx"));
const McpConsole = lazy(() => import("./McpConsole.jsx"));
const AgentConsole = lazy(() => import("./AgentConsole.jsx"));
const VoiceInterview = lazy(() => import("./VoiceInterview.jsx"));

const SAMPLE_CV = `Sadia Rahman
House 14, Road 3, Mirpur, Dhaka
sadia.rahman@example.com | +880 1712-345678 | https://github.com/sadia-demo

Education: BSc in Computer Science, final year.
Projects: Sales dashboard in Power BI; customer analysis with pandas and MySQL joins; basic statistics for a class survey.
Skills: SQL, Python, Excel, Git. Presentation and report writing for class projects.
(Synthetic sample CV for demo purposes.)`;

/* ---------- small helpers ---------- */
const STEPS = ["profile", "assess", "gap", "learn", "retest", "passport"];

function Err({ e }) {
  const t = useT();
  if (!e) return null;
  const info = describeError(e, t);
  return (
    <p className="err" role="alert">
      {info.text}
      {info.code ? <small className="muted err-code"> ({t("errorReference")}: {info.code})</small> : null}
    </p>
  );
}

function Bar({ score, threshold, unverified }) {
  return (
    <div
      className={"bar" + (unverified ? " bar-un" : "")}
      aria-label={unverified ? "unverified" : `${score}%`}
    >
      {!unverified && (
        <span className="bar-fill" style={{ width: `${score}%` }} />
      )}
      {threshold != null && (
        <span
          className="bar-tick"
          style={{ left: `${threshold}%` }}
          title={`${threshold}%`}
        />
      )}
    </div>
  );
}

function TrustChip({ trust }) {
  const t = useT();
  const cls =
    trust === "High trust" || trust === "High"
      ? "chip-ok"
      : trust === "Medium"
        ? "chip-mid"
        : "chip-rev";
  return (
    <span className={"chip " + cls}>
      {t("trusts")[trust] || trust || "Not scored"}
    </span>
  );
}

/* ---------- landing + auth ---------- */
function passwordScore(pw) {
  if (!pw) return 0;
  let score = 0;
  if (pw.length >= 12) score += 1;
  if (pw.length >= 16) score += 1;
  if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) score += 1;
  if (/\d/.test(pw) && /[^A-Za-z0-9]/.test(pw)) score += 1;
  if (/^(1234|abcd|qwer|asdf)/i.test(pw)) score = Math.max(0, score - 2);
  return Math.min(score, 4);
}

/* ---------- public landing page (design: docs/Landing page.pdf) ---------- */
function LpIcon({ children }) {
  return (
    <svg
      viewBox="0 0 20 20"
      width="1em"
      height="1em"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}
const LpI = {
  check: () => (
    <LpIcon>
      <path d="M4.2 10.5l3.6 3.6 8-9" />
    </LpIcon>
  ),
  arrow: () => (
    <LpIcon>
      <path d="M3.2 10h13M11.6 5.2l4.8 4.8-4.8 4.8" />
    </LpIcon>
  ),
  upload: () => (
    <LpIcon>
      <path d="M10 12.6V3.5M6.3 7.2L10 3.5l3.7 3.7M3.4 13v2.2a1.4 1.4 0 0 0 1.4 1.4h10.4a1.4 1.4 0 0 0 1.4-1.4V13" />
    </LpIcon>
  ),
  person: () => (
    <LpIcon>
      <circle cx="10" cy="6.6" r="3" />
      <path d="M3.7 17c.4-3.2 2.9-5 6.3-5s5.9 1.8 6.3 5" />
    </LpIcon>
  ),
  clock: () => (
    <LpIcon>
      <circle cx="10" cy="10" r="6.9" />
      <path d="M10 5.9V10l3 1.8" />
    </LpIcon>
  ),
  shield: () => (
    <LpIcon>
      <path d="M10 2.9l6 2.2v4.5c0 3.6-2.4 6.2-6 7.5-3.6-1.3-6-3.9-6-7.5V5.1l6-2.2z" />
      <path d="M7.1 9.9l2.1 2.1 3.9-4.1" />
    </LpIcon>
  ),
  briefcase: () => (
    <LpIcon>
      <rect x="2.9" y="6.5" width="14.2" height="9.8" rx="2" />
      <path d="M7.4 6.5V5a1.6 1.6 0 0 1 1.6-1.6h2A1.6 1.6 0 0 1 12.6 5v1.5M2.9 10.7h14.2" />
    </LpIcon>
  ),
  listCheck: () => (
    <LpIcon>
      <rect x="3.2" y="3.2" width="13.6" height="13.6" rx="2.6" />
      <path d="M6.6 10l2.2 2.2 4.7-5" />
    </LpIcon>
  ),
  badge: () => (
    <LpIcon>
      <circle cx="10" cy="10" r="7" />
      <path d="M6.9 10.2l2.2 2.2 4.2-4.6" />
    </LpIcon>
  ),
  lock: () => (
    <LpIcon>
      <rect x="4.4" y="8.7" width="11.2" height="7.9" rx="1.9" />
      <path d="M7.2 8.7V6.5a2.8 2.8 0 0 1 5.6 0v2.2" />
    </LpIcon>
  ),
  trend: () => (
    <LpIcon>
      <path d="M3.4 13.7l4-4.3 3 2.6 5.5-6.3" />
      <path d="M11.7 5.8h4.3v4.3" />
    </LpIcon>
  ),
  filter: () => (
    <LpIcon>
      <path d="M3.2 5.2h13.6M5.4 10h9.2M7.8 14.8h4.4" />
    </LpIcon>
  ),
  search: () => (
    <LpIcon>
      <circle cx="9" cy="9" r="5.4" />
      <path d="M13.1 13.1l4 4" />
    </LpIcon>
  ),
  stages: () => (
    <LpIcon>
      <rect x="3" y="3.4" width="14" height="13.2" rx="1.9" />
      <path d="M8 3.4v13.2M13 3.4v13.2" />
    </LpIcon>
  ),
};

function Landing({ onAuthed }) {
  const t = useT();
  const L = t("landing");
  const H = L.home;
  const [mode, setMode] = useState(
    location.hash === "#signin" ? "login" : "register",
  );
  const [authOpen, setAuthOpen] = useState(
    location.hash === "#signin" || location.hash === "#signup",
  );
  const [journey, setJourney] = useState("candidate");
  const [faqOpen, setFaqOpen] = useState(0);
  const [f, setF] = useState({
    name: "",
    email: "",
    password: "",
    confirm: "",
    role: "candidate",
  });
  const [err, setErr] = useState(null);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [mfaChallenge, setMfaChallenge] = useState("");
  const [mfaCode, setMfaCode] = useState("");
  const isRegister = mode === "register";
  const score = passwordScore(f.password);
  const confirmMismatch = isRegister && f.confirm && f.confirm !== f.password;
  useEffect(() => {
    const syncMode = () => {
      if (location.hash === "#signin") {
        setMode("login");
        setAuthOpen(true);
      }
      if (location.hash === "#signup") {
        setMode("register");
        setAuthOpen(true);
      }
    };
    syncMode();
    window.addEventListener("hashchange", syncMode);
    return () => window.removeEventListener("hashchange", syncMode);
  }, []);
  useEffect(() => {
    if (!authOpen) return undefined;
    const onKey = (e) => {
      if (e.key === "Escape") setAuthOpen(false);
    };
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    document.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      document.removeEventListener("keydown", onKey);
    };
  }, [authOpen]);
  const changeMode = (next) => {
    setErr(null);
    setNotice("");
    setMfaChallenge("");
    setMode(next);
  };
  const openAuth = (next, role) => {
    if (role) setF((v) => ({ ...v, role }));
    changeMode(next);
    setAuthOpen(true);
    const hash = next === "login" ? "#signin" : "#signup";
    if (location.hash !== hash) history.replaceState(null, "", hash);
  };
  const closeAuth = () => {
    setAuthOpen(false);
    if (location.hash === "#signin" || location.hash === "#signup") {
      history.replaceState(null, "", "#top");
    }
  };
  const submit = async (e) => {
    e.preventDefault();
    setErr(null);
    setNotice("");
    if (isRegister) {
      if (f.password !== f.confirm) {
        setErr(new Error(L.passwordMismatch));
        return;
      }
      if (f.password.length < 8) {
        setErr(new Error(L.passwordShort));
        return;
      }
    }
    setBusy(true);
    try {
      if (mfaChallenge) {
        const r = await api("/auth/mfa/verify", {
          method: "POST",
          body: { challenge: mfaChallenge, code: mfaCode },
        });
        setToken(r.token);
        onAuthed();
        return;
      }
      const r = await api(isRegister ? "/auth/register" : "/auth/login", {
        method: "POST",
        body: isRegister
          ? { name: f.name, email: f.email, password: f.password, role: f.role }
          : { email: f.email, password: f.password },
      });
      if (r.mfa_required) {
        setMfaChallenge(r.challenge);
        return;
      }
      if (r.token) {
        setToken(r.token);
        onAuthed();
        return;
      }
      // Registration was accepted without an immediate session (email verification).
      setNotice(r.message || L.verifySent);
      changeMode("login");
    } catch (x) {
      setErr(x);
    } finally {
      setBusy(false);
    }
  };
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const steps = journey === "candidate" ? H.candSteps : H.hireSteps;
  return (
    <main className="lp">
      <section className="lp-hero" id="top" aria-labelledby="lp-hero-title">
        <div className="lp-hero-copy">
          <span className="lp-eyebrow">
            <i /> {H.eyebrow}
          </span>
          <h1 id="lp-hero-title">
            {H.heroA1}
            <br />
            {H.heroA2}
            <br />
            <em>
              {H.heroB1}
              <br />
              {H.heroB2}
            </em>
          </h1>
          <p className="lp-hero-lead">{H.lead}</p>
          <div className="lp-hero-actions">
            <button
              type="button"
              className="lp-btn lp-btn-mint"
              onClick={() => openAuth("register", "candidate")}
            >
              <LpI.upload />
              {H.ctaUpload}
              <LpI.arrow />
            </button>
            <button
              type="button"
              className="lp-btn lp-btn-ghost"
              onClick={() => openAuth("register", "company")}
            >
              {H.ctaHiring}
              <LpI.arrow />
            </button>
          </div>
          <div className="lp-hero-trust">
            <span>
              <LpI.check /> {H.trustFree}
            </span>
            <span>
              <LpI.check /> {H.trustTests}
            </span>
            <span>
              <LpI.check /> {H.trustLang}
            </span>
          </div>
        </div>
        <div className="lp-hero-visual">
          <span className="lp-visual-note">{H.sample}</span>
          <div className="lp-score-card">
            <div className="lp-score-top">
              <span className="lp-avatar">SA</span>
              <div className="lp-score-who">
                <strong>{H.candidateName}</strong>
                <small>{H.candidateRole}</small>
              </div>
              <span className="lp-verified">
                <LpI.check /> {H.verified}
              </span>
            </div>
            <div className="lp-score-main">
              <b>82</b>
              <span>
                <small>/ 100</small>
                <em>{H.scoreLabel}</em>
              </span>
            </div>
            <ul className="lp-bars">
              <li>
                <div>
                  <b>SQL</b>
                  <span>
                    88 · <em>{H.verified}</em>
                  </span>
                </div>
                <div className="lp-bar">
                  <i style={{ width: "88%" }} />
                </div>
              </li>
              <li>
                <div>
                  <b>Excel</b>
                  <span>
                    91 · <em>{H.verified}</em>
                  </span>
                </div>
                <div className="lp-bar">
                  <i style={{ width: "91%" }} />
                </div>
              </li>
              <li>
                <div>
                  <b>Power BI</b>
                  <span>
                    74 · <em>{H.verified}</em>
                  </span>
                </div>
                <div className="lp-bar">
                  <i style={{ width: "74%" }} />
                </div>
              </li>
              <li className="lp-bar-pending">
                <div>
                  <b>Python</b>
                  <span>{H.fromCv}</span>
                </div>
                <div className="lp-bar lp-bar-ghost" />
              </li>
            </ul>
            <div className="lp-score-foot">
              <span>{H.cvRead}</span>
              <button
                type="button"
                className="lp-score-link"
                onClick={() => openAuth("register", "candidate")}
              >
                {H.takeTest} <LpI.arrow />
              </button>
            </div>
          </div>
          <div className="lp-shortlist">
            <span className="lp-shortlist-icon">
              <LpI.briefcase />
            </span>
            <div>
              <strong>{H.shortlisted}</strong>
              <small>{H.meets}</small>
            </div>
          </div>
        </div>
      </section>

      <section className="lp-section lp-why" aria-labelledby="lp-why-title">
        <p className="lp-kicker">{H.whyKicker}</p>
        <h2 id="lp-why-title" className="lp-h2">
          {H.whyA}
          <br />
          <em>{H.whyB}</em>
        </h2>
        <div className="lp-why-grid">
          <article className="lp-why-card">
            <span className="lp-why-icon lp-icon-rose">
              <LpI.person />
            </span>
            <h3>{H.why1T}</h3>
            <p>{H.why1B}</p>
          </article>
          <article className="lp-why-card">
            <span className="lp-why-icon lp-icon-amber">
              <LpI.clock />
            </span>
            <h3>{H.why2T}</h3>
            <p>{H.why2B}</p>
          </article>
          <article className="lp-why-card lp-why-card-dark">
            <span className="lp-why-icon">
              <LpI.shield />
            </span>
            <h3>{H.why3T}</h3>
            <p>{H.why3B}</p>
          </article>
        </div>
      </section>

      <section
        className="lp-section lp-how"
        id="how-it-works"
        aria-labelledby="lp-how-title"
      >
        <div className="lp-how-head">
          <div>
            <p className="lp-kicker">{H.howKicker}</p>
            <h2 id="lp-how-title" className="lp-h2">
              {H.howA}
              <br />
              {H.howB}
            </h2>
          </div>
          <div className="lp-tabs" role="tablist" aria-label={H.howKicker}>
            <button
              type="button"
              role="tab"
              aria-selected={journey === "candidate"}
              className={journey === "candidate" ? "on" : ""}
              onClick={() => setJourney("candidate")}
            >
              {H.tabCandidate}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={journey === "hiring"}
              className={journey === "hiring" ? "on" : ""}
              onClick={() => setJourney("hiring")}
            >
              {H.tabHiring}
            </button>
          </div>
        </div>
        <div className="lp-steps" role="tabpanel">
          {steps.map((step, index) => (
            <article className="lp-step" key={step.t}>
              <span className="lp-step-num">
                {String(index + 1).padStart(2, "0")}
              </span>
              <h3>{step.t}</h3>
              <p>{step.b}</p>
            </article>
          ))}
        </div>
        <div className="lp-how-cta">
          <button
            type="button"
            className="lp-btn lp-btn-dark"
            onClick={() =>
              openAuth("register", journey === "hiring" ? "company" : "candidate")
            }
          >
            {journey === "hiring" ? H.startHiring : H.howCta}
            <LpI.arrow />
          </button>
          <span>{H.howNote}</span>
        </div>
      </section>

      <section className="lp-section lp-score-section" aria-labelledby="lp-score-title">
        <div className="lp-score" id="skill-score">
          <div className="lp-score-copy">
          <p className="lp-kicker">{H.scoreKicker}</p>
          <h2 id="lp-score-title" className="lp-h2">
            {H.scoreA}
          </h2>
          <p className="lp-lead">{H.scoreLead}</p>
          <div className="lp-score-features">
            <div>
              <span className="lp-feature-icon">
                <LpI.listCheck />
              </span>
              <div>
                <b>{H.scoreF1T}</b>
                <p>{H.scoreF1B}</p>
              </div>
            </div>
            <div>
              <span className="lp-feature-icon">
                <LpI.badge />
              </span>
              <div>
                <b>{H.scoreF2T}</b>
                <p>{H.scoreF2B}</p>
              </div>
            </div>
            <div>
              <span className="lp-feature-icon">
                <LpI.lock />
              </span>
              <div>
                <b>{H.scoreF3T}</b>
                <p>{H.scoreF3B}</p>
              </div>
            </div>
            <div>
              <span className="lp-feature-icon">
                <LpI.trend />
              </span>
              <div>
                <b>{H.scoreF4T}</b>
                <p>{H.scoreF4B}</p>
              </div>
            </div>
          </div>
        </div>
        <div className="lp-score-panel">
          <div className="lp-donut">
            <svg viewBox="0 0 160 160" aria-hidden="true">
              <circle className="lp-donut-track" cx="80" cy="80" r="62" />
              <circle
                className="lp-donut-value"
                cx="80"
                cy="80"
                r="62"
                strokeDasharray="319.2 389.6"
              />
            </svg>
            <div>
              <b>82</b>
              <span>{H.ringLabel}</span>
            </div>
          </div>
          <div className="lp-legend">
            <div>
              <i className="dot-green" />
              <span>{H.legendVerified}</span>
              <b>3</b>
            </div>
            <div>
              <i className="dot-hollow" />
              <span>{H.legendCv}</span>
              <b>6</b>
            </div>
            <div>
              <i className="dot-amber" />
              <span>{H.legendNext}</span>
              <b>{H.nextSkill}</b>
            </div>
          </div>
        </div>
        </div>
      </section>

      <section
        className="lp-section lp-hire"
        id="for-recruiters"
        aria-labelledby="lp-hire-title"
      >
        <div className="lp-hire-head">
          <div>
            <p className="lp-kicker">{H.recKicker}</p>
            <h2 id="lp-hire-title" className="lp-h2">
              {H.recA}
              <br />
              <em>{H.recB}</em>
            </h2>
          </div>
          <p className="lp-lead">{H.recLead}</p>
        </div>
        <div className="lp-role-card">
          <div className="lp-role-head">
            <div>
              <strong>{H.role}</strong>
              <small>{H.roleSub}</small>
            </div>
            <div className="lp-role-chips">
              <span className="lp-chip lp-chip-mint">{H.chipSql}</span>
              <span className="lp-chip lp-chip-mint">{H.chipExcel}</span>
              <span className="lp-chip">{H.chipDhaka}</span>
              <span className="lp-chip lp-chip-live">
                <i /> {H.chipNow}
              </span>
            </div>
          </div>
          <div className="lp-tablewrap">
            <table className="lp-table">
              <thead>
                <tr>
                  <th>{H.thCandidate}</th>
                  <th>{H.thScore}</th>
                  <th>{H.thVerified}</th>
                  <th>{H.thMet}</th>
                  <th>{H.thStage}</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td data-label={H.thCandidate}>
                    <span className="lp-row-person">
                      <span className="lp-row-avatar av-mint">SA</span>
                      <strong>{H.c1}</strong>
                    </span>
                  </td>
                  <td data-label={H.thScore}>
                    <span className="lp-score-chip">82</span>
                  </td>
                  <td data-label={H.thVerified}>
                    SQL 88 · Excel 91 · Power BI 74
                  </td>
                  <td data-label={H.thMet}>3 / 3</td>
                  <td data-label={H.thStage}>
                    <span className="lp-stage lp-stage-short">
                      {H.stageShortlisted}
                    </span>
                  </td>
                </tr>
                <tr>
                  <td data-label={H.thCandidate}>
                    <span className="lp-row-person">
                      <span className="lp-row-avatar av-lilac">NJ</span>
                      <strong>{H.c2}</strong>
                    </span>
                  </td>
                  <td data-label={H.thScore}>
                    <span className="lp-score-chip">79</span>
                  </td>
                  <td data-label={H.thVerified}>
                    Excel 90 · SQL 76 · Power BI 71
                  </td>
                  <td data-label={H.thMet}>3 / 3</td>
                  <td data-label={H.thStage}>
                    <span className="lp-stage lp-stage-interview">
                      {H.stageInterview}
                    </span>
                  </td>
                </tr>
                <tr>
                  <td data-label={H.thCandidate}>
                    <span className="lp-row-person">
                      <span className="lp-row-avatar av-sand">RH</span>
                      <strong>{H.c3}</strong>
                    </span>
                  </td>
                  <td data-label={H.thScore}>
                    <span className="lp-score-chip">75</span>
                  </td>
                  <td data-label={H.thVerified}>SQL 81 · Excel 85</td>
                  <td data-label={H.thMet}>2 / 3</td>
                  <td data-label={H.thStage}>
                    <span className="lp-stage">{H.stageNew}</span>
                  </td>
                </tr>
                <tr>
                  <td data-label={H.thCandidate}>
                    <span className="lp-row-person">
                      <span className="lp-row-avatar av-sky">TI</span>
                      <strong>{H.c4}</strong>
                    </span>
                  </td>
                  <td data-label={H.thScore}>
                    <span className="lp-score-chip">71</span>
                  </td>
                  <td data-label={H.thVerified}>SQL 72 · Power BI 77</td>
                  <td data-label={H.thMet}>2 / 3</td>
                  <td data-label={H.thStage}>
                    <span className="lp-stage">{H.stageNew}</span>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <p className="lp-table-note">{H.sampleData}</p>
        </div>
        <div className="lp-hire-features">
          <div>
            <LpI.filter />
            <div>
              <b>{H.recF1T}</b>
              <p>{H.recF1B}</p>
            </div>
          </div>
          <div>
            <LpI.search />
            <div>
              <b>{H.recF2T}</b>
              <p>{H.recF2B}</p>
            </div>
          </div>
          <div>
            <LpI.stages />
            <div>
              <b>{H.recF3T}</b>
              <p>{H.recF3B}</p>
            </div>
          </div>
        </div>
        <div className="lp-audience">
          <article className="lp-audience-card">
            <p className="lp-audience-tag">{L.candidateTag}</p>
            <h3>{L.candidateTitle}</h3>
            <ul>
              {H.candBullets.map((item) => (
                <li key={item}>
                  <LpI.check /> {item}
                </li>
              ))}
            </ul>
            <button
              type="button"
              className="lp-btn lp-btn-dark"
              onClick={() => openAuth("register", "candidate")}
            >
              {L.candidateCta} <LpI.arrow />
            </button>
          </article>
          <article className="lp-audience-card lp-audience-dark">
            <p className="lp-audience-tag">{L.companyTag}</p>
            <h3>{L.companyTitle}</h3>
            <ul>
              {H.compBullets.map((item) => (
                <li key={item}>
                  <LpI.check /> {item}
                </li>
              ))}
            </ul>
            <button
              type="button"
              className="lp-btn lp-btn-mint"
              onClick={() => openAuth("register", "company")}
            >
              {L.companyCta} <LpI.arrow />
            </button>
          </article>
        </div>
        <div className="lp-values">
          {H.values.map((value) => (
            <div key={value.t}>
              <b>{value.t}</b>
              <p>{value.b}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="lp-section lp-faq" id="faq" aria-labelledby="lp-faq-title">
        <div className="lp-faq-intro">
          <p className="lp-kicker">{H.faqKicker}</p>
          <h2 id="lp-faq-title" className="lp-h2">
            {H.faqA}
            <br />
            {H.faqB}
          </h2>
          {SUPPORT_EMAIL ? (
            <p className="lp-faq-support">
              {H.faqSupport}{" "}
              <a className="lp-support-mail" href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>
            </p>
          ) : null}
        </div>
        <div className="lp-faq-list">
          {H.faqs.map((item, index) => {
            const open = faqOpen === index;
            return (
              <div className={"lp-faq-item" + (open ? " open" : "")} key={item.q}>
                <button
                  type="button"
                  aria-expanded={open}
                  aria-controls={"lp-faq-a-" + index}
                  onClick={() => setFaqOpen(open ? -1 : index)}
                >
                  <span>{item.q}</span>
                  <i aria-hidden="true">{open ? "−" : "+"}</i>
                </button>
                <div id={"lp-faq-a-" + index} hidden={!open}>
                  <p>{item.a}</p>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      <section className="lp-section lp-cta-section" aria-labelledby="lp-cta-title">
        <div className="lp-cta">
          <h2 id="lp-cta-title">
            {H.ctaA}
            <br />
            <em>{H.ctaB}</em>
          </h2>
          <p>{H.ctaLead}</p>
          <div className="lp-cta-actions">
            <button
              type="button"
              className="lp-btn lp-btn-mint"
              onClick={() => openAuth("register", "candidate")}
            >
              {H.howCta} <LpI.arrow />
            </button>
            <button
              type="button"
              className="lp-btn lp-btn-ghost"
              onClick={() => openAuth("register", "company")}
            >
              {H.startHiring}
            </button>
          </div>
        </div>
      </section>

      <footer className="lp-footer" id="legal">
        <div className="lp-footer-top">
          <div className="lp-footer-brand">
            <span className="lp-footer-mark">S</span>
            <strong>TalentForge</strong>
            <p>{H.footTag}</p>
          </div>
          <div className="lp-footer-cols">
            <div>
              <b>{H.footPlatform}</b>
              <a href="#how-it-works">{H.footHow}</a>
              <a href="#skill-score">{H.footScore}</a>
              <a href="#for-recruiters">{H.footRec}</a>
            </div>
            <div>
              <b>{H.footAccount}</b>
              <button type="button" onClick={() => openAuth("register", "candidate")}>
                {H.footCreate}
              </button>
              <button type="button" onClick={() => openAuth("login")}>
                {H.footSignin}
              </button>
              <a href="#faq">{H.footFaq}</a>
            </div>
            <div>
              <b>{H.footLegal}</b>
              <a href="#legal">{H.footPrivacy}</a>
              <a href="#legal">{H.footTerms}</a>
            </div>
          </div>
        </div>
        <div className="lp-footer-bottom">
          <span>{H.copyright}</span>
          <span>{H.motto}</span>
        </div>
      </footer>

      {authOpen && (
        <div
          className="lp-auth-overlay"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) closeAuth();
          }}
        >
          <div className="lp-auth-shell">
            <button
              type="button"
              className="lp-auth-close"
              onClick={closeAuth}
              aria-label={L.close || "Close"}
            >
              ×
            </button>
            <div
              className="sb-auth-card"
              role="dialog"
              aria-modal="true"
              aria-labelledby="lp-auth-title"
            >
              <div className="sb-auth-card-top">
                <span className="sb-auth-mark">S</span>
                <span className="sb-auth-secure">
                  <span /> {L.authSecure}
                </span>
              </div>
              <div className="sb-auth-heading">
                <div className="sb-kicker">
                  {isRegister ? L.authKickerRegister : L.authKickerLogin}
                </div>
                <h2 id="lp-auth-title">
                  {isRegister ? L.authTitleRegister : L.authTitleLogin}
                </h2>
                <p>{isRegister ? L.authSubRegister : L.authSubLogin}</p>
              </div>
              <div className="sb-auth-tabs" role="tablist" aria-label="Account access">
                <button
                  type="button"
                  role="tab"
                  aria-selected={isRegister}
                  className={isRegister ? "active" : ""}
                  onClick={() => changeMode("register")}
                >
                  {L.tabCreate}
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={!isRegister}
                  className={!isRegister ? "active" : ""}
                  onClick={() => changeMode("login")}
                >
                  {L.tabSignin}
                </button>
              </div>
              <form className="sb-auth-form" onSubmit={submit}>
                {isRegister && (
                  <>
                    <div className="sb-field-label">{L.joiningAs}</div>
                    <div className="sb-role-choices">
                      <button
                        type="button"
                        className={f.role === "candidate" ? "selected" : ""}
                        onClick={() => setF({ ...f, role: "candidate" })}
                      >
                        <span className="sb-role-icon"><WorkspaceIcon name="profile" size={18} /></span>
                        <span>
                          <b>{L.roleCandidate}</b>
                          <small>{L.roleCandidateSub}</small>
                        </span>
                        <i>{f.role === "candidate" ? "✓" : ""}</i>
                      </button>
                      <button
                        type="button"
                        className={f.role === "company" ? "selected" : ""}
                        onClick={() => setF({ ...f, role: "company" })}
                      >
                        <span className="sb-role-icon"><WorkspaceIcon name="building" size={18} /></span>
                        <span>
                          <b>{L.roleCompany}</b>
                          <small>{L.roleCompanySub}</small>
                        </span>
                        <i>{f.role === "company" ? "✓" : ""}</i>
                      </button>
                    </div>
                    <label>
                      {L.labelName}
                      <input
                        value={f.name}
                        onChange={set("name")}
                        required
                        minLength={2}
                        autoComplete="name"
                        placeholder="e.g. Samira Ahmed"
                      />
                    </label>
                  </>
                )}
                <label>
                  {L.labelEmail}
                  <input
                    type="email"
                    value={f.email}
                    onChange={set("email")}
                    required
                    autoComplete="email"
                    placeholder="you@example.com"
                  />
                </label>
                {!mfaChallenge && (
                  <label>
                    {L.labelPassword}
                    <div className="sb-password-field">
                      <input
                        type={showPassword ? "text" : "password"}
                        value={f.password}
                        onChange={set("password")}
                        required
                        minLength={isRegister ? 8 : 1}
                        maxLength={128}
                        autoComplete={isRegister ? "new-password" : "current-password"}
                        placeholder={isRegister ? "At least 8 characters" : ""}
                      />
                      <button
                        type="button"
                        onClick={() => setShowPassword((v) => !v)}
                        aria-label={showPassword ? L.hide : L.show}
                      >
                        {showPassword ? L.hide : L.show}
                      </button>
                    </div>
                    {isRegister && (
                      <>
                        <div className={"sb-strength s" + score} aria-hidden="true">
                          <span />
                          <span />
                          <span />
                          <span />
                        </div>
                        <small className="sb-hint">{L.passwordHint}</small>
                      </>
                    )}
                  </label>
                )}
                {!isRegister && !mfaChallenge && (
                  <a className="sb-forgot-link" href="#/reset-password">
                    {t("settingsForgotPassword")}
                  </a>
                )}
                {isRegister && !mfaChallenge && (
                  <label>
                    {L.confirmPassword}
                    <input
                      type={showPassword ? "text" : "password"}
                      value={f.confirm}
                      onChange={set("confirm")}
                      required
                      autoComplete="new-password"
                    />
                    {confirmMismatch && <small className="err">{L.passwordMismatch}</small>}
                  </label>
                )}
                {mfaChallenge && (
                  <label>
                    Authenticator code
                    <input
                      value={mfaCode}
                      onChange={(e) => setMfaCode(e.target.value)}
                      required
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      placeholder="123456"
                    />
                  </label>
                )}
                {notice && (
                  <p className="sb-notice" role="status">
                    {notice}
                  </p>
                )}
                <Err e={err} />
                <button
                  className="sb-submit"
                  disabled={busy || Boolean(confirmMismatch)}
                >
                  {busy
                    ? L.submitting
                    : mfaChallenge
                      ? "Verify code"
                      : isRegister
                        ? L.submitRegister
                        : L.submitLogin}
                  <span>→</span>
                </button>
              </form>
              <div className="sb-auth-switch">
                {isRegister ? L.switchHave : L.switchNew}{" "}
                <button
                  type="button"
                  onClick={() => changeMode(isRegister ? "login" : "register")}
                >
                  {isRegister ? L.tabSignin : L.tabCreate}
                </button>
              </div>
              <div className="sb-auth-legal">{L.legal}</div>
            </div>
            <div className="sb-auth-note">
              {L.authNote}
            </div>
          </div>
        </div>
      )}
    </main>
  );
}

/* ---------- consent ---------- */
function Consent({ lang, onDone }) {
  const t = useT();
  const [ok, setOk] = useState(false);
  const [err, setErr] = useState(null);
  const go = async () => {
    try {
      await api("/consent", { method: "POST", body: { lang } });
      onDone();
    } catch (e) {
      setErr(e);
    }
  };
  return (
    <section className="card narrow">
      <h2>{t("consentTitle")}</h2>
      <ul className="consent">
        {t("consentItems").map((x, i) => (
          <li key={i}>{x}</li>
        ))}
      </ul>
      <label className="check">
        <input
          type="checkbox"
          checked={ok}
          onChange={(e) => setOk(e.target.checked)}
        />{" "}
        {t("consentCheck")}
      </label>
      <Err e={err} />
      <button className="btn" disabled={!ok} onClick={go}>
        {t("consentBtn")}
      </button>
    </section>
  );
}

/* ---------- profile: CV -> skills ---------- */
function Profile({ st, onDone, onEditProfile }) {
  const t = useT();
  const [text, setText] = useState("");
  const [file, setFile] = useState(null);
  const [res, setRes] = useState(null);
  const [sel, setSel] = useState([]);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [identityConfirmed, setIdentityConfirmed] = useState(false);
  const [journey, setJourney] = useState(null);

  useEffect(() => {
    if (!st.from_profile) return;
    api("/skill-journey")
      .then(setJourney)
      .catch(() => {});
  }, [st.from_profile, st.confirmed]);

  useEffect(() => {
    if (st.from_profile) setSel(st.confirmed || []);
  }, [st.from_profile, st.confirmed]);

  const analyse = async () => {
    setErr(null);
    setBusy(true);
    try {
      const form = new FormData();
      form.append("text", text);
      if (file) form.append("file", file);
      const r = await api("/cv", { method: "POST", form });
      setRes(r);
      setIdentityConfirmed(false);
      setSel(r.skills.map((s) => s.id));
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };
  const confirm = async () => {
    setErr(null);
    setBusy(true);
    try {
      await api("/skills", { method: "PUT", body: { skills: sel, cv_identity_confirmed: identityConfirmed } });
      await onDone();
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };
  const toggle = (id) =>
    setSel(sel.includes(id) ? sel.filter((x) => x !== id) : [...sel, id]);
  const identity = res?.identity;
  const identityIsUnknown = identity?.status === "unknown" && !identity.confirmed;
  const identityNeedsConfirmation = Boolean(identity
    && ["weak", "no_match"].includes(identity.status)
    && !identity.confirmed);
  const identityNeedsAttention = Boolean(identity && (identityNeedsConfirmation || identityIsUnknown));

  return (
    <section>
      <h2>{t("profileTitle")}</h2>
      {st.confirmed && !res && !st.from_profile && (
        <p className="note">
          {t("claimed")}: {st.confirmed.join(", ") || "-"}
        </p>
      )}
      {st.from_profile && !res && (
        <div className="card profile-journey-skills">
          <h3>Skills from your profile</h3>
          <p className="note">These skills are claimed in your profile. Their verified status comes from your approved assessment result.</p>
          <p className="chips">
            {(st.profile_skill_items || []).map((skill, index) => {
              const item = journey?.journey?.find(
                (entry) =>
                  entry.skill_id === skill.id ||
                  (entry.skill_ids || []).includes(skill.id),
              );
              const status = !item
                ? t("claimed")
                : item.status === "verified"
                  ? `Verified · ${item.score}%`
                  : item.status === "needs_practice"
                    ? `Needs practice · ${item.score}%`
                    : item.status === "pending_review"
                      ? "Pending human review"
                      : item.status === "ready_to_verify"
                        ? "Ready to verify"
                        : item.status === "question_bank_pending"
                          ? "Practice bank pending"
                          : item.status === "covered_by_fundamental"
                            ? "Covered by fundamentals"
                            : "Not assessable yet";
              return (
                <span
                  className={
                    "chip " +
                    (item?.status === "verified"
                      ? "chip-ok"
                      : !item || item.status === "not_assessable"
                        ? "chip-rev"
                        : "chip-mid")
                  }
                  key={`${skill.name}-${index}`}
                >
                  {skill.label || skill.name} · {status}
                </span>
              );
            })}
          </p>
          {!st.profile_skill_items?.length && (
            <p className="muted">No skills are listed yet. Add them to your profile to begin.</p>
          )}
          {!!st.not_assessable_yet?.length && (
            <p className="muted">
              Not assessable yet: {st.not_assessable_yet.join(", ")}. These skills remain in your profile.
            </p>
          )}
          <button className="btn ghost" onClick={onEditProfile}>
            Edit skills on My profile
          </button>
        </div>
      )}
      {st.from_profile && !res ? (
        <details className="card reanalyse-cv">
          <summary>Re-analyse a different CV</summary>
          <div className="reanalyse-content">
            <p>{t("cvHelp")}</p>
            <textarea rows={8} value={text} onChange={(e) => setText(e.target.value)} placeholder={t("cvPaste")} />
            <div className="row">
              <input type="file" accept=".pdf,.docx,.txt,.md" onChange={(e) => setFile(e.target.files[0] || null)} />
              <button type="button" className="btn ghost" onClick={() => { setText(SAMPLE_CV); setFile(null); }}>
                {t("sampleCv")}
              </button>
              <button className="btn" onClick={analyse} disabled={busy || (!text && !file)}>
                {t("analyse")}
              </button>
            </div>
            <Err e={err} />
          </div>
        </details>
      ) : (
        <div className="card">
          <p>{t("cvHelp")}</p>
          <textarea rows={8} value={text} onChange={(e) => setText(e.target.value)} placeholder={t("cvPaste")} />
          <div className="row">
            <input type="file" accept=".pdf,.docx,.txt,.md" onChange={(e) => setFile(e.target.files[0] || null)} />
            <button type="button" className="btn ghost" onClick={() => { setText(SAMPLE_CV); setFile(null); }}>
              {t("sampleCv")}
            </button>
            <button className="btn" onClick={analyse} disabled={busy || (!text && !file)}>
              {t("analyse")}
            </button>
          </div>
          <Err e={err} />
        </div>
      )}

      {res && (
        <>
          <div className="card">
            <h3>{t("redacted")}</h3>
            <p className="chips">
              {Object.entries(res.redaction).map(([k, n]) => (
                <span key={k} className="chip chip-mid">
                  {n} {t("redactedLabels")[k]}
                </span>
              ))}
            </p>
            <details>
              <summary>{t("preview")}</summary>
              <pre className="pre">{res.redacted_preview}</pre>
            </details>
          </div>
          <div className="card">
            <h3>{t("confirmTitle")}</h3>
            <p className="note">
              {t("confirmHelp")} ({t("extractedBy")}:{" "}
              {res.source === "llm" ? t("llm") : t("rules")})
            </p>
            {identityNeedsAttention && (
              <div className="cv-identity-check" role="alert">
                <h4>{t(identityIsUnknown ? "cvIdentityUnknownTitle" : "cvIdentityTitle")}</h4>
                <p>{t(identityIsUnknown ? "cvIdentityUnknownHelp" : "cvIdentityHelp")}</p>
                <dl className="cv-identity-facts">
                  <div><dt>{t("cvIdentityStatus")}</dt><dd>{t(`cvIdentity_${identity.status}`)}</dd></div>
                  <div><dt>{t("cvIdentityCvName")}</dt><dd>{identity.cv_name || "—"}</dd></div>
                  <div><dt>{t("cvIdentitySimilarity")}</dt><dd>{typeof identity.score === "number" ? Math.round(identity.score * 100) + "%" : "—"}</dd></div>
                  <div><dt>{t("cvIdentityEmailMatch")}</dt><dd>{identity.email_match ? t("yes") : t("no")}</dd></div>
                </dl>
                {identityNeedsConfirmation && (
                  <label className="check">
                    <input
                      type="checkbox"
                      checked={identityConfirmed}
                      onChange={(e) => setIdentityConfirmed(e.target.checked)}
                    />
                    {t("cvIdentityConfirm")}
                  </label>
                )}
                <small>{t("cvIdentityReviewNote")}</small>
              </div>
            )}
            <ul className="skills">
              {res.taxonomy.map((s) => {
                const found = res.skills.find((x) => x.id === s.id);
                return (
                  <li key={s.id}>
                    <label className="check">
                      <input
                        type="checkbox"
                        checked={sel.includes(s.id)}
                        onChange={() => toggle(s.id)}
                      />{" "}
                      <strong>{s.name}</strong>
                      <span className="chip chip-mid">{t("claimed")}</span>
                    </label>
                    {found && (
                      <small className="evid">
                        {t("evidence")}: “{found.evidence}”
                      </small>
                    )}
                  </li>
                );
              })}
            </ul>
            <button className="btn" onClick={confirm} disabled={identityNeedsConfirmation && !identityConfirmed}>
              {t("confirmBtn")}
            </button>
          </div>
        </>
      )}
    </section>
  );
}

/* ---------- gap ---------- */
function Gap({ onStart, refreshKey, actionLabel }) {
  const t = useT();
  const [d, setD] = useState(null);
  const [journey, setJourney] = useState(null);
  const [err, setErr] = useState(null);
  useEffect(() => {
    Promise.all([
      api("/job"),
      api("/skill-journey").catch(() => null),
    ])
      .then(([jobData, journeyData]) => {
        setD(jobData);
        setJourney(journeyData);
      })
      .catch(setErr);
  }, [refreshKey]);
  if (err) return <Err e={err} />;
  if (!d) return <p>{t("loading")}</p>;
  const journeyStatusLabel = (item) => {
    if (item.status === "verified") return `Verified · ${item.score}%`;
    if (item.status === "needs_practice") return `Needs practice · ${item.score}%`;
    if (item.status === "pending_review") return "Pending human review";
    if (item.status === "ready_to_verify") return "Ready to verify";
    if (item.status === "covered_by_fundamental") return "Covered by fundamentals";
    if (item.status === "question_bank_pending") return "Practice bank pending";
    return "Not assessable yet";
  };
  const gapStatusLabel = (g) => {
    if (g.score != null) {
      return `${g.verified ? "Verified" : "Provisional"} · ${g.score}%`;
    }
    if (g.coverage_status === "ready_to_verify") return "Ready to verify";
    if (g.coverage_status === "question_bank_pending") return "Practice bank pending";
    return t("gs")[g.status];
  };
  return (
    <section>
      <h2>{t("gapTitle")}</h2>
      <AssessmentStatus publication={journey?.latest_result?.publication} objective={journey?.latest_result?.objective_summary} />
      {journey?.latest_result && (
        <div
          className={
            "learn-approval " + (journey.approved ? "approved" : "pending")
          }
        >
          <div>
            <span className="learn-kicker">
              {journey.approved ? "Verified assessment" : "Assessment complete"}
            </span>
            <h3>
              {journey.approved
                ? "Your result is approved."
                : "Your score is recorded and awaiting human review."}
            </h3>
            <p>
              {journey.approved
                ? "Your learning path is verified and your Skill Passport was created automatically."
                : "Personalized learning and the Skill Passport unlock after the response marks and honesty report are both approved."}
            </p>
            {journey.latest_result.section_scores && (
              <small className="learn-note">
                Fundamentals 60%:{" "}
                {journey.latest_result.section_scores.fundamental?.score ?? "—"}%
                {" · "}CV &amp; development 40%:{" "}
                {journey.latest_result.section_scores.cv?.score ?? "—"}%
              </small>
            )}
          </div>
          <div className="learn-approval-score">
            <strong>
              {journey.latest_result.overall == null
                ? "—"
                : journey.latest_result.overall + "%"}
            </strong>
            <small>{journey.latest_result.level || "Pending review"}</small>
            {journey.passport && !journey.passport.revoked && (
              <span>Passport issued</span>
            )}
          </div>
        </div>
      )}
      {journey && (
        <div className="card profile-journey-skills">
          <h3>Skills from your profile &amp; CV</h3>
          <p className="note">
            These confirmed skills drive your assessment, learning and skill
            journey. Skills without approved practice questions stay visible and
            are marked below instead of being dropped.
          </p>
          <p className="chips">
            {(journey.journey || []).map((item, index) => (
              <span className="chip chip-mid" key={`${item.name}-${index}`}>
                {item.label} · {journeyStatusLabel(item)}
              </span>
            ))}
          </p>
          {!journey.journey?.length && (
            <p className="muted">
              No profile skills are confirmed yet. Add skills on My profile to
              start the journey.
            </p>
          )}
          {!!journey.pending_question_bank?.length && (
            <p className="muted">
              Awaiting question-bank coverage:{" "}
              {journey.pending_question_bank.map((item) => item.label).join(", ")}.
            </p>
          )}
          {!!journey.not_assessable?.length && (
            <p className="muted">
              Not assessable yet: {journey.not_assessable.join(", ")}. These
              skills remain in your profile.
            </p>
          )}
        </div>
      )}
      <div className="card">
        <div className="jobhead">
          <h3>{d.job.title}</h3>
          <span className="chip chip-mock">{t("jobMock")}</span>
        </div>
        <ul className="gaps">
          {d.gap.map((g) => (
            <li key={g.skill}>
              <div className="gaprow">
                <strong>{g.name}</strong>
                <span className="muted">
                  {g.claimed ? t("claimedTag") : t("notClaimed")}
                </span>
                <span className={"status s-" + (g.score != null ? (g.verified ? "met" : "unverified") : g.status)}>
                  {gapStatusLabel(g)}
                </span>
              </div>
              <Bar
                score={g.score || 0}
                threshold={g.threshold}
                unverified={g.status === "unverified"}
              />
              <small className="muted">
                {t("threshold")}: {g.threshold}%
              </small>
            </li>
          ))}
        </ul>
        <p className="note">{t("gapNote")}</p>
        <p className="muted">
          {t("preferred")}:{" "}
          {d.job.preferred
            .map((p) => `${p.name}${p.claimed ? " ✓" : ""}`)
            .join(", ")}
        </p>
        {onStart && journey?.latest_result && (
          <button className="btn" onClick={onStart}>
            {actionLabel || t("startTest")}
          </button>
        )}
      </div>
    </section>
  );
}

/* ---------- exam integrity monitor ---------- */
/**
 * Send queued integrity events while the page unloads. Uses the same API base
 * URL as api.js (VITE_API_BASE_URL on the Vercel + Render split). sendBeacon
 * cannot carry an Authorization header, so the token goes in the JSON body,
 * which the backend's /event/beacon endpoint verifies.
 */
function flushExamEventsOnExit(aid, events) {
  const token = getToken();
  if (!token || !aid) return;
  for (const item of events || []) {
    sendExitBeacon(`/attempts/${aid}/event/beacon`, { ...item, authorization: token });
  }
}

function useExamIntegrity(initial, screenStream) {
  const t = useT();
  const aid = initial.attempt_id;
  const sessionId = useRef(initial.session_id);
  const sequence = useRef(initial.last_event_seq || 0);
  const [shareActive, setShareActive] = useState(
    Boolean(
      screenStream
        ?.getVideoTracks()
        .some((track) => track.readyState === "live"),
    ),
  );
  const [fullscreenActive, setFullscreenActive] = useState(
    Boolean(document.fullscreenElement),
  );
  const [notice, setNotice] = useState("");
  const [shareError, setShareError] = useState("");
  const [alerts, setAlerts] = useState([]);
  const [tabVisible, setTabVisible] = useState(document.visibilityState !== "hidden");
  const [signals, setSignals] = useState({ clipboard: 0, focus: 0, fullscreen: 0 });
  const [away, setAway] = useState(false);
  const pendingEvents = useRef([]);
  const flushPromise = useRef(null);
  const reportedStream = useRef(screenStream);
  const evidenceHandler = useRef(null);

  const flushEvents = useCallback(async () => {
    if (flushPromise.current) return flushPromise.current;
    flushPromise.current = (async () => {
      while (pendingEvents.current.length) {
        const item = pendingEvents.current[0];
        try {
          await api(`/attempts/${aid}/event`, { method: "POST", body: item });
          pendingEvents.current.shift();
        } catch (error) {
          // A 409 means this event is stale (replayed sequence or a session that
          // was replaced in another tab). Drop it instead of retrying forever.
          if (error?.status === 409) {
            pendingEvents.current.shift();
            continue;
          }
          break;
        }
      }
    })();
    try {
      await flushPromise.current;
    } finally {
      flushPromise.current = null;
    }
  }, [aid]);

  const nextSeq = useCallback(() => ++sequence.current, []);

  const report = useCallback(
    (type, metadata = {}) => {
      const event = {
        type,
        session_id: sessionId.current,
        seq: ++sequence.current,
        client_ts: Date.now(),
        metadata,
      };
      pendingEvents.current.push(event);
      flushEvents();
      evidenceHandler.current?.(event);
      const info = ALERT_MAP[type];
      if (info) {
        const now = Date.now();
        setAlerts((current) => {
          const fresh = current.filter((alert) => !(alert.type === type && now - alert.at < 4000));
          return [...fresh.slice(-2), { id: type + "-" + now, type, at: now, ...info }];
        });
      }
    },
    [flushEvents],
  );
  useEffect(() => {
    const heartbeat = async () => {
      try {
        await flushEvents();
        if (pendingEvents.current.length) return;
        const body = {
          session_id: sessionId.current,
          seq: ++sequence.current,
          client_ts: Date.now(),
        };
        await api(`/attempts/${aid}/heartbeat`, { method: "POST", body });
      } catch {
        /* the next successful heartbeat records the monitoring gap */
      }
    };
    const timer = setInterval(heartbeat, 10000);
    const onExit = () => flushExamEventsOnExit(aid, pendingEvents.current);
    window.addEventListener("pagehide", onExit);
    return () => {
      clearInterval(timer);
      window.removeEventListener("pagehide", onExit);
    };
  }, [aid, flushEvents]);
  useEffect(() => {
    if (!alerts.length) return undefined;
    const timer = setTimeout(() => setAlerts((current) => current.slice(1)), 6500);
    return () => clearTimeout(timer);
  }, [alerts]);
  useEffect(() => {
    const blockClipboard = (type) => {
      setSignals((current) => ({ ...current, clipboard: current.clipboard + 1 }));
      report(type);
      setNotice(t("clipboardBlocked"));
    };
    const clipboard = (e) => {
      // Capture phase + stopPropagation so editors (CodeMirror, textareas)
      // never receive the clipboard data.
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation?.();
      blockClipboard(e.type);
    };
    const beforeInput = (e) => {
      if (["insertFromPaste", "insertFromPasteAsQuotation", "insertFromDrop", "insertFromYank"].includes(e.inputType)) {
        e.preventDefault();
        e.stopPropagation();
        blockClipboard("paste");
      }
    };
    const drop = (e) => {
      e.preventDefault();
      e.stopPropagation();
      blockClipboard("paste");
    };
    const keydown = (e) => {
      const key = String(e.key || "").toLowerCase();
      const mod = e.ctrlKey || e.metaKey;
      if (mod && ["c", "v", "x"].includes(key)) {
        e.preventDefault();
        e.stopPropagation();
        blockClipboard(key === "c" ? "copy" : key === "x" ? "cut" : "paste");
        return;
      }
      if (e.shiftKey && key === "insert") {
        e.preventDefault();
        e.stopPropagation();
        blockClipboard("paste");
        return;
      }
      // Developer tools, view-source, print and save are not needed in an exam.
      if (key === "f12" || (mod && e.shiftKey && ["i", "j", "c", "k"].includes(key)) || (mod && ["u", "s", "p"].includes(key))) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      // Tab/window switching shortcuts. With Keyboard Lock active (Chromium,
      // full-screen) these reach the page and are blocked here; otherwise the
      // browser handles them first and the visibility/blur events are the
      // evidence. Not an OS kiosk lock.
      const switching = (mod && ["tab", "t", "w", "n", "pageup", "pagedown"].includes(key))
        || (e.altKey && ["tab", "f4"].includes(key))
        || key === "meta" || key === "os" || key === "f11";
      if (switching) {
        e.preventDefault();
        e.stopPropagation();
        report("blur", { reason: "browser_navigation_shortcut_blocked" });
        setNotice("Switching tabs or windows is not allowed during the exam.");
      }
    };
    const context = (e) => {
      e.preventDefault();
      report("context_menu");
    };
    const drag = (e) => {
      e.preventDefault();
      report("drag_start");
    };
    const editable = (target) =>
      target?.closest?.("textarea,input,[contenteditable='true'],.cm-editor");
    const selection = (e) => {
      if (!editable(e.target)) e.preventDefault();
    };
    const auxclick = (e) => {
      if (e.button === 1) e.preventDefault();
    };
    const blur = () => {
      setSignals((current) => ({ ...current, focus: current.focus + 1 }));
      report("blur");
    };
    const visibility = () => {
      const visible = document.visibilityState !== "hidden";
      setTabVisible(visible);
      if (!visible) {
        setSignals((current) => ({ ...current, focus: current.focus + 1 }));
        setAway(true);
      }
      report(visible ? "tab_visible" : "tab_hidden");
    };
    const fullscreen = () => {
      const active = Boolean(document.fullscreenElement);
      setFullscreenActive(active);
      if (active) {
        report("fullscreen_enter");
        lockExamKeyboard();
      }
      if (!active) {
        setSignals((current) => ({ ...current, fullscreen: current.fullscreen + 1 }));
        report("fullscreen_exit");
        setNotice(t("fullscreenWarning"));
      }
    };
    const unload = (e) => {
      e.preventDefault();
      e.returnValue = "";
      return "";
    };
    if (document.fullscreenElement) lockExamKeyboard();
    document.addEventListener("copy", clipboard, true);
    document.addEventListener("cut", clipboard, true);
    document.addEventListener("paste", clipboard, true);
    document.addEventListener("beforeinput", beforeInput, true);
    document.addEventListener("drop", drop, true);
    document.addEventListener("keydown", keydown, true);
    document.addEventListener("contextmenu", context, true);
    document.addEventListener("dragstart", drag, true);
    document.addEventListener("selectstart", selection, true);
    document.addEventListener("auxclick", auxclick, true);
    document.addEventListener("visibilitychange", visibility);
    document.addEventListener("fullscreenchange", fullscreen);
    window.addEventListener("blur", blur);
    window.addEventListener("beforeunload", unload);
    return () => {
      document.removeEventListener("copy", clipboard, true);
      document.removeEventListener("cut", clipboard, true);
      document.removeEventListener("paste", clipboard, true);
      document.removeEventListener("beforeinput", beforeInput, true);
      document.removeEventListener("drop", drop, true);
      document.removeEventListener("keydown", keydown, true);
      document.removeEventListener("contextmenu", context, true);
      document.removeEventListener("dragstart", drag, true);
      document.removeEventListener("selectstart", selection, true);
      document.removeEventListener("auxclick", auxclick, true);
      document.removeEventListener("visibilitychange", visibility);
      document.removeEventListener("fullscreenchange", fullscreen);
      window.removeEventListener("blur", blur);
      window.removeEventListener("beforeunload", unload);
      try { navigator.keyboard?.unlock?.(); } catch { /* unsupported */ }
    };
  }, [report, t]);
  useEffect(() => {
    const track = screenStream?.getVideoTracks()[0];
    if (!track) {
      setShareActive(false);
      return;
    }
    const sync = () => {
      const live = track.readyState === "live" && (!isProctored(initial.proctoring) || !track.muted);
      setShareActive(live);
      if (live) setShareError("");
    };
    const ended = () => {
      setShareActive(false);
      setShareError(t("shareStopped"));
      report("screen_share_stopped");
    };
    sync();
    // A restored share is a fresh MediaStream: re-assert it to the server so the
    // answer/navigation guard passes again. The initial stream is already
    // reported by the setup flow, so skip it on first mount.
    if (reportedStream.current !== screenStream) {
      reportedStream.current = screenStream;
      report("screen_share_started", {
        surface: track.getSettings?.().displaySurface || "unknown",
      });
    }
    // Some browsers report the track state a tick after the picker closes, and an
    // interrupted share can recover without an "ended" event. Poll so the exam
    // never stays stuck on "share off" while the screen is actually shared.
    const timer = setInterval(sync, 1000);
    track.addEventListener("ended", ended);
    const mute = () => { sync(); if (isProctored(initial.proctoring)) report("screen_share_unavailable", { reason: "screen_track_muted" }); };
    const unmute = () => { sync(); if (isProctored(initial.proctoring)) report("screen_share_started", { surface: track.getSettings?.().displaySurface || "unknown" }); };
    track.addEventListener("mute", mute);
    track.addEventListener("unmute", unmute);
    return () => {
      clearInterval(timer);
      track.removeEventListener("ended", ended);
      track.removeEventListener("mute", mute);
      track.removeEventListener("unmute", unmute);
    };
  }, [screenStream, report, t, initial.proctoring]);
  const restartFullscreen = async () => {
    try {
      if (!document.documentElement.requestFullscreen)
        throw new Error(t("fullscreenUnsupported"));
      await document.documentElement.requestFullscreen();
      setFullscreenActive(Boolean(document.fullscreenElement));
    } catch (e) {
      setShareError(e.message || t("fullscreenRequired"));
    }
  };
  return {
    shareActive,
    fullscreenActive,
    notice,
    shareError,
    alerts,
    tabVisible,
    signals,
    away,
    dismissAway: () => setAway(false),
    setNotice,
    restartFullscreen,
    report,
    flushEvents,
    nextSeq,
    evidenceHandler,
  };
}
/* ---------- exam ---------- */
function ExamRun({ initial, onFinished, screenStream, cameraStream, micStream, audioContext, devicesReady, onRestartCamera, onRestartMic, onRestartShare }) {
  // An active exam owns the whole viewport: the workspace sidebar/topbar are
  // hidden so the candidate cannot wander into the app mid-assessment.
  useEffect(() => {
    document.body.classList.add("exam-live");
    return () => document.body.classList.remove("exam-live");
  }, []);
  if (initial.graphrag)
    return (
      <GraphRAGExamRunGate
        initial={initial}
        onFinished={onFinished}
        screenStream={screenStream}
        cameraStream={cameraStream}
        micStream={micStream}
        onRestartShare={onRestartShare}
        audioContext={audioContext}
        devicesReady={devicesReady}
        onRestartCamera={onRestartCamera}
        onRestartMic={onRestartMic}
      />
    );
  return (
    <AdaptiveExamRun
      initial={initial}
      onFinished={onFinished}
      screenStream={screenStream}
      cameraStream={cameraStream}
      micStream={micStream}
    />
  );
}

function GraphRAGExamRunGate({ initial, onFinished, screenStream, cameraStream, micStream, onRestartShare, audioContext, devicesReady, onRestartCamera, onRestartMic }) {
  const integrity = useExamIntegrity(initial, screenStream);
  return (
    <GraphRAGExamRun
      initial={initial}
      onFinished={onFinished}
      integrity={integrity}
      cameraStream={cameraStream}
      micStream={micStream}
      onRestartShare={onRestartShare}
      screenStream={screenStream}
      audioContext={audioContext}
      devicesReady={devicesReady}
      onRestartCamera={onRestartCamera}
      onRestartMic={onRestartMic}
    />
  );
}

/* ---------- local-only AI proctoring ---------- */
function LocalProctor({ cameraStream, report, inline = false, onDetections }) {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const [status, setStatus] = useState("Loading local vision models…");
  const [cameraStatus, setCameraStatus] = useState("Waiting for camera video…");
  const [detections, setDetections] = useState({ face: "Starting", objects: "Starting" });
  const lastAlert = useRef({});
  const noFaceSince = useRef(0);
  const modelRef = useRef(null);

  const evidence = useCallback(async (type, confidence) => {
    const now = Date.now();
    if (now - (lastAlert.current[type] || 0) < 15000) return;
    lastAlert.current[type] = now;
    report(type, { confidence: Number(confidence.toFixed(2)), model: "mediapipe", local_only: true });
  }, [report]);

  useEffect(() => {
    let cancelled = false, timer = null;
    const video = videoRef.current;
    if (!cameraStream || !video) return;
    video.muted = true;
    video.autoplay = true;
    video.playsInline = true;
    const playPreview = async () => {
      try {
        await video.play();
        if (!cancelled) setCameraStatus("Camera preview live");
      } catch (previewError) {
        if (!cancelled) setCameraStatus("Preview blocked: " + (previewError?.message || "click to allow playback"));
      }
    };
    const onVideoReady = () => { if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) playPreview(); };
    const onPlaying = () => { if (!cancelled) setCameraStatus("Camera preview live"); };
    const onWaiting = () => { if (!cancelled) setCameraStatus("Waiting for camera frames…"); };
    video.addEventListener("loadedmetadata", onVideoReady);
    video.addEventListener("loadeddata", onVideoReady);
    video.addEventListener("playing", onPlaying);
    video.addEventListener("waiting", onWaiting);
    video.srcObject = cameraStream;
    if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) playPreview();
    const track = cameraStream.getVideoTracks()[0];
    if (track) {
      if (track.readyState !== "live") setCameraStatus("Camera track is not live");
      else if (track.muted) setCameraStatus("Camera is starting…");
    }
    const load = async () => {
      try {
        // Shared models: already preloaded and warmed on the verify page, and
        // kept alive across setup → exam so monitoring starts instantly.
        const { face, objects } = await preloadVisionModels();
        if (cancelled) return;
        modelRef.current = { face, objects };
        setStatus(objects ? "Local AI monitoring active" : "Face analysis active; object model unavailable");
        let lastVideoTime = -1;
        let lastFaceRun = 0;
        let lastObjectRun = 0;
        let lastFaceLabel = "";
        let lastObjectLabel = "";
        const loop = () => {
          if (cancelled) return;
          const now = performance.now();
          // Analyser runs ~5x/second rather than once per animation frame, and
          // state is only updated when a label changes. This keeps the page
          // smooth (no 60fps React re-renders) while detection stays responsive.
          if (video.readyState >= 2 && video.currentTime !== lastVideoTime && now - lastFaceRun >= 180) {
            lastVideoTime = video.currentTime;
            lastFaceRun = now;
            const faces = face.detectForVideo(video, now).faceLandmarks || [];
            const count = faces.length;
            const faceLabel = count === 0 ? "No face" : count > 1 ? `${count} faces` : "One face";
            if (faceLabel !== lastFaceLabel) {
              lastFaceLabel = faceLabel;
              setDetections(old => ({ ...old, face: faceLabel }));
            }
            if (count === 0) {
              if (!noFaceSince.current) noFaceSince.current = now;
              if (now - noFaceSince.current > 1500) evidence("ai_no_face", 0);
            } else {
              noFaceSince.current = 0;
            }
            if (count > 1) evidence("ai_multiple_faces", 0);
            if (objects) {
              if (now - lastObjectRun >= 650) {
                lastObjectRun = now;
                const found = objects.detectForVideo(video, now).detections || [];
                const phone = found.find(d => (d.categories || []).some(c => ["cell phone", "mobile phone", "phone"].includes((c.categoryName || "").toLowerCase())));
                const objectLabel = phone ? "Possible phone" : "No phone detected";
                if (objectLabel !== lastObjectLabel) {
                  lastObjectLabel = objectLabel;
                  setDetections(old => ({ ...old, objects: objectLabel }));
                }
                if (phone) evidence("ai_phone_detected", phone.categories?.[0]?.score || 0.6);
              }
            } else if (lastObjectLabel !== "Unavailable") {
              lastObjectLabel = "Unavailable";
              setDetections(old => ({ ...old, objects: "Unavailable" }));
            }
          }
          timer = requestAnimationFrame(loop);
        };
        loop();
      } catch (e) {
        if (!cancelled) setStatus("Local AI unavailable: " + (e?.message || "model load failed"));
        report("ai_model_unavailable", { reason: "model_load_failed", local_only: true });
      }
    };
    load();
    return () => {
      cancelled = true;
      if (timer) cancelAnimationFrame(timer);
      video.removeEventListener("loadedmetadata", onVideoReady);
      video.removeEventListener("loadeddata", onVideoReady);
      video.removeEventListener("playing", onPlaying);
      video.removeEventListener("waiting", onWaiting);
      video.pause();
      video.srcObject = null;
      modelRef.current = null;
    };
  }, [cameraStream, evidence, report]);
  const live = Boolean(cameraStream?.getVideoTracks?.().some((track) => track.readyState === "live"));
  useEffect(() => {
    onDetections?.(detections);
  }, [detections, onDetections]);
  return (
    <aside className={"camera-float proctor" + (live ? " live" : " off") + (inline ? " inline" : "")} aria-label="Webcam preview and on-device monitoring">
      <div className="camera-float-head">
        <i className="camera-dot" aria-hidden="true" />
        <span>{live ? "LIVE" : "OFF"}</span>
        <span>On-device AI</span>
      </div>
      <div className="camera-frame">
        <video ref={videoRef} muted playsInline autoPlay aria-label="Live webcam preview" />
        {!live && <div className="camera-placeholder">Camera offline</div>}
      </div>
      <div className="camera-status">
        <span>{cameraStatus}</span>
        <span>{status}</span>
        <div className="camera-detect">
          <span
            className={
              "detect-chip" +
              (detections.face === "One face"
                ? " ok"
                : detections.face === "No face"
                  ? " bad"
                  : " warn")
            }
          >
            ◉ {detections.face}
          </span>
          <span
            className={
              "detect-chip" +
              (detections.objects === "No phone detected"
                ? " ok"
                : detections.objects === "Possible phone"
                  ? " bad"
                  : " warn")
            }
          >
            ☎ {detections.objects}
          </span>
        </div>
      </div>
      <div className="camera-float-foot">
        <span>Local preview</span>
        <span>Flag-triggered snapshots saved</span>
      </div>
      <canvas ref={canvasRef} hidden />
    </aside>
  );
}

/* ---------- adaptive exam (phase 2 integrity) ---------- */
// Mirrors engine.GRACE: the server accepts writes this long after the timer.
const EXAM_GRACE_SECONDS = 30;
function AdaptiveExamRun({ initial, onFinished, screenStream, cameraStream, micStream }) {
  const t = useT();
  // Long-lived listeners read the current language through a ref so they
  // are not re-registered on every render.
  const tRef = useRef(t);
  tRef.current = t;
  const [v, setV] = useState(initial);
  const [ans, setAns] = useState("");
  const [out, setOut] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [quitting, setQuitting] = useState(false);
  const [alerts, setAlerts] = useState([]);
  const [left, setLeft] = useState(initial.remaining);
  const [unlimitedTime, setUnlimitedTime] = useState(Boolean(initial.unlimited_time));
  const [stream, setStream] = useState(screenStream || null);
  const [shareActive, setShareActive] = useState(Boolean(screenStream?.getVideoTracks().some((track) => track.readyState === "live")));
  const [fullscreenActive, setFullscreenActive] = useState(Boolean(document.fullscreenElement));
  const [shareNotice, setShareNotice] = useState("");
  const [integrityNotice, setIntegrityNotice] = useState("");
  const aid = v.attempt_id;
  const sessionId = useRef(initial.session_id);
  const sequence = useRef(initial.last_event_seq || 0);
  const pendingEvents = useRef([]);
  const flushPromise = useRef(null);
  const flushEvents = useCallback(async () => {
    if (flushPromise.current) return flushPromise.current;
    flushPromise.current = (async () => {
      while (pendingEvents.current.length) {
        const item = pendingEvents.current[0];
        try {
          await api(`/attempts/${aid}/event`, { method: "POST", body: item });
          pendingEvents.current.shift();
        } catch (error) {
          // A 409 means this event is stale (replayed sequence or a session that
          // was replaced in another tab). Drop it instead of retrying forever.
          if (error?.status === 409) {
            pendingEvents.current.shift();
            continue;
          }
          break;
        }
      }
    })();
    try { await flushPromise.current; }
    finally { flushPromise.current = null; }
  }, [aid]);

  const report = useCallback((type, metadata = {}) => {
    const item = {
      type, session_id: sessionId.current, seq: ++sequence.current,
      client_ts: Date.now(), metadata
    };
    pendingEvents.current.push(item);
    flushEvents();
    const info = ALERT_MAP[type];
    if (info) {
      const now = Date.now();
      setAlerts((current) => {
        const fresh = current.filter((alert) => !(alert.type === type && now - alert.at < 4000));
        return [...fresh.slice(-2), { id: type + "-" + now, type, at: now, ...info }];
      });
    }
  }, [flushEvents]);

  useEffect(() => {
    if (!alerts.length) return undefined;
    const timer = setTimeout(() => setAlerts((current) => current.slice(1)), 6500);
    return () => clearTimeout(timer);
  }, [alerts]);

  const onVoice = useCallback(({ confidence, level, duration_ms }) => {
    report("ai_audio_level", {
      confidence: Number(Number(confidence).toFixed(2)),
      level: Number(level),
      duration_ms: Number(duration_ms),
      local_only: true,
    });
  }, [report]);
  useEffect(() => {
    const track = micStream?.getAudioTracks?.()[0];
    if (!track) return undefined;
    const ended = () => report("microphone_stopped", { reason: "audio_track_ended" });
    track.addEventListener("ended", ended);
    return () => track.removeEventListener("ended", ended);
  }, [micStream, report]);

  useEffect(() => {
    const heartbeat = async () => {
      try {
        await flushEvents();
        if (pendingEvents.current.length) return; // preserve strict sequence order while offline
        const body = { session_id: sessionId.current, seq: ++sequence.current, client_ts: Date.now() };
        await api(`/attempts/${aid}/heartbeat`, { method: "POST", body });
      } catch {
        // The next successful heartbeat lets the server record the monitoring gap.
      }
    };
    const timer = setInterval(heartbeat, 10000);
    const flushOnExit = () => flushExamEventsOnExit(aid, pendingEvents.current);
    window.addEventListener("pagehide", flushOnExit);
    return () => { clearInterval(timer); window.removeEventListener("pagehide", flushOnExit); };
  }, [aid, flushEvents]);

  useEffect(() => {
    if (unlimitedTime) return;
    const i = setInterval(() => setLeft((x) => Math.max(0, x - 1)), 1000);
    return () => clearInterval(i);
  }, [unlimitedTime]);

  // Time is up: save the answer on screen, then let the server close the
  // attempt. The legacy exam has no submit endpoint; the server finalises an
  // expired attempt (after its grace window) on the next answer call.
  const [timeUp, setTimeUp] = useState(null);
  const timeUpStarted = useRef(false);
  const ansRef = useRef(ans);
  ansRef.current = ans;
  const qIdRef = useRef(v.question?.id);
  qIdRef.current = v.question?.id;
  const finishAfterTimeUp = useCallback(async () => {
    setTimeUp("submitting");
    setErr(null);
    const post = (answer) => api(`/attempts/${aid}/answer`, {
      method: "POST",
      body: { question_id: qIdRef.current, answer, session_id: sessionId.current },
    });
    try {
      try { await flushEvents(); } catch { /* best effort */ }
      if (qIdRef.current && String(ansRef.current ?? "").trim()) {
        const saved = await post(String(ansRef.current));
        if (saved?.status === "done") { await onFinished(aid); return; }
        setV(saved);
      }
      await new Promise((resolve) => setTimeout(resolve, (EXAM_GRACE_SECONDS + 2) * 1000));
      const closed = await post("");
      if (closed?.status === "done") { await onFinished(aid); return; }
      setTimeUp("failed");
    } catch (e) {
      try {
        const fresh = await api(`/attempts/${aid}`);
        if (fresh?.status === "done") { await onFinished(aid); return; }
      } catch { /* report the original error */ }
      setErr(e);
      setTimeUp("failed");
    }
  }, [aid, flushEvents, onFinished]);
  useEffect(() => {
    if (unlimitedTime || left > 0 || timeUpStarted.current) return;
    timeUpStarted.current = true;
    finishAfterTimeUp();
  }, [left, unlimitedTime, finishAfterTimeUp]);
  useEffect(() => { setAns(""); setOut(null); }, [v.question?.id]);

  // Block clipboard actions throughout the exam, not only in the SQL editor.
  useEffect(() => {
    const inCodeEditor = (target) => Boolean(target?.closest?.("textarea.code, [contenteditable='true']"));
    const clipboard = (event) => {
      if (event.type !== "paste" && inCodeEditor(event.target)) return;
      event.preventDefault();
      report(event.type, { editor: inCodeEditor(event.target) });
      setIntegrityNotice(tRef.current("clipboardBlocked"));
    };
    const keyboard = (event) => {
      const key = String(event.key || "").toLowerCase();
      if (key === "f11" || (key === "escape" && document.fullscreenElement)) {
        event.preventDefault();
        event.stopPropagation();
      }
      if (inCodeEditor(event.target) && (event.ctrlKey || event.metaKey) && key === "v") {
        event.preventDefault();
        report("paste", { editor: true });
        setIntegrityNotice(tRef.current("clipboardBlocked"));
        return;
      }
      if (inCodeEditor(event.target)) return;
      if ((event.ctrlKey || event.metaKey) && ["c", "v", "x"].includes(key)) {
        event.preventDefault();
        report(key === "c" ? "copy" : key === "x" ? "cut" : "paste");
        setIntegrityNotice(tRef.current("clipboardBlocked"));
      }
      if (event.shiftKey && key === "insert") {
        event.preventDefault();
        report("paste");
        setIntegrityNotice(tRef.current("clipboardBlocked"));
      }
    };
    const contextMenu = (event) => { event.preventDefault(); };
    const blur = () => report("blur");
    const visibility = () => { report(document.visibilityState === "hidden" ? "tab_hidden" : "tab_visible"); };
    const fullscreen = () => {
      const active = Boolean(document.fullscreenElement);
      setFullscreenActive(active);
      if (!active) {
        report("fullscreen_exit");
        setIntegrityNotice(tRef.current("fullscreenWarning"));
      } else {
        report("fullscreen_enter");
      }
    };
    const focus = () => report("focus");
    const blockOutsideExam = (event) => {
      if (event.target?.closest?.(".exam")) return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      setIntegrityNotice(tRef.current("examNavigationLocked"));
    };
    document.addEventListener("copy", clipboard, true);
    document.addEventListener("cut", clipboard, true);
    document.addEventListener("paste", clipboard, true);
    document.addEventListener("keydown", keyboard, true);
    document.addEventListener("click", blockOutsideExam, true);
    document.addEventListener("contextmenu", contextMenu, true);
    document.addEventListener("visibilitychange", visibility);
    document.addEventListener("fullscreenchange", fullscreen);
    window.addEventListener("blur", blur);
    window.addEventListener("focus", focus);
    return () => {
      document.removeEventListener("copy", clipboard, true);
      document.removeEventListener("cut", clipboard, true);
      document.removeEventListener("paste", clipboard, true);
      document.removeEventListener("keydown", keyboard, true);
      document.removeEventListener("click", blockOutsideExam, true);
      document.removeEventListener("contextmenu", contextMenu, true);
      document.removeEventListener("visibilitychange", visibility);
      document.removeEventListener("fullscreenchange", fullscreen);
      window.removeEventListener("blur", blur);
      window.removeEventListener("focus", focus);
    };
  }, [report]);

  useEffect(() => {
    const track = stream?.getVideoTracks()[0];
    if (!track) { setShareActive(false); return; }
    const sync = () => setShareActive(track.readyState === "live");
    const ended = () => {
      setShareActive(false);
      setShareNotice(tRef.current("shareStopped"));
      report("screen_share_stopped");
    };
    sync();
    // Same robustness as the GraphRAG exam: some browsers report the track state
    // a tick after the picker closes, so poll instead of trusting a single read.
    const timer = setInterval(sync, 1000);
    track.addEventListener("ended", ended);
    track.addEventListener("mute", sync);
    track.addEventListener("unmute", sync);
    return () => {
      clearInterval(timer);
      track.removeEventListener("ended", ended);
      track.removeEventListener("mute", sync);
      track.removeEventListener("unmute", sync);
    };
  }, [stream, report]);

  // Record webcam disconnection during the active attempt. The browser never
  // uploads a continuous video stream; this is a status event only.
  useEffect(() => {
    const track = cameraStream?.getVideoTracks()[0];
    if (!track) return;
    const ended = () => {
      report("camera_stopped", { reason: "video_track_ended" });
      setIntegrityNotice("Webcam disconnected. This interruption has been recorded.");
    };
    track.addEventListener("ended", ended);
    return () => track.removeEventListener("ended", ended);
  }, [cameraStream, report]);

  // Stop capture when the exam component is removed or the stream is replaced.
  useEffect(() => () => {
    stream?.getTracks().forEach((track) => track.stop());
  }, [stream]);
  useEffect(() => () => {
    if (document.fullscreenElement && document.exitFullscreen) document.exitFullscreen().catch(() => {});
  }, []);

  const q = v.question;
  const restartFullscreen = async () => {
    try {
      if (!document.documentElement.requestFullscreen) throw new Error(t("fullscreenUnsupported"));
      await document.documentElement.requestFullscreen();
      setFullscreenActive(Boolean(document.fullscreenElement));
      setIntegrityNotice("");
    } catch (e) {
      setShareNotice(e.message || t("fullscreenUnsupported"));
    }
  };
  const restartShare = async () => {
    try {
      if (!navigator.mediaDevices?.getDisplayMedia) throw new Error(t("shareUnsupported"));
      const nextStream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 5 }, audio: false });
      const surface = nextStream.getVideoTracks()[0]?.getSettings?.().displaySurface || "unknown";
      if (surface !== "monitor") {
        nextStream.getTracks().forEach((track) => track.stop());
        report("wrong_share_surface", { surface });
        throw new Error("Please share your entire screen (not a tab or window).");
      }
      report("screen_share_started", { surface });
      setStream(nextStream);
      setShareActive(true);
      setShareNotice("");
      setIntegrityNotice("");
    } catch (e) {
      setShareNotice(e.message || t("shareRequired"));
      report("screen_share_unavailable");
    }
  };
  const submit = async () => {
    if (!shareActive || !fullscreenActive) { setShareNotice(!shareActive ? t("shareRequired") : t("fullscreenRequired")); return; }
    setBusy(true); setErr(null);
    try {
      const r = await api(`/attempts/${aid}/answer`, { method: "POST", body: { question_id: q.id, answer: String(ans), session_id: sessionId.current } });
      setV(r); setLeft(r.remaining); setUnlimitedTime(Boolean(r.unlimited_time));
      if (r.status === "done") onFinished(aid);
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };
  const quit = async () => {
    if (!window.confirm(t("quitConfirm"))) return;
    setQuitting(true);
    setErr(null);
    try {
      // If time had already run out the server grades the attempt instead.
      const quitResult = await api(`/attempts/${aid}/quit`, { method: "POST", body: { session_id: sessionId.current } });
      await onFinished(aid, quitResult?.status === "done" ? "done" : "quit");
    } catch (e) {
      setErr(e);
      setQuitting(false);
    }
  };
  const runSql = async () => {
    if (!shareActive) { setShareNotice(t("shareRequired")); return; }
    try { setOut(await api(`/attempts/${aid}/sql-run`, { method: "POST", body: { sql: ans, session_id: sessionId.current } })); } catch (e) { setErr(e); }
  };

  if (!q) return <p>{t("loading")}</p>;
  return (
    <section className="card exam">
      {timeUp && (
        <div className="exam-lock-overlay exam-timeup-overlay" role="alertdialog" aria-modal="true" aria-labelledby="legacy-timeup-title">
          <div className="exam-lock-card">
            <span className="exam-lock-icon" aria-hidden="true">◷</span>
            <h3 id="legacy-timeup-title">{t("timeUpTitle")}</h3>
            <p aria-live="assertive">{timeUp === "failed" ? t("timeUpFailed") : t("timeUpSubmitting")}</p>
            {timeUp === "failed" && (
              <>
                <Err e={err} />
                <div className="exam-lock-actions">
                  <button type="button" className="btn" onClick={finishAfterTimeUp} autoFocus>{t("timeUpRetry")}</button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
      <IntegrityAlerts alerts={alerts} />
      <MicMonitor stream={micStream} onVoice={onVoice} />
      <div className="examhead">
        <span>
          {t("q")} {q.index + 1} {t("of")} {q.total}
        </span>
        <progress value={q.index} max={q.total} />
        <span className={"timer" + (!unlimitedTime && left < 120 ? " low" : "")}>{t("timeLeft")}: {unlimitedTime ? "Unlimited" : fmt(left)}</span>
      </div>
      <div className={"exam-integrity-banner" + (shareActive ? " active" : " warning")} role="status">
        <strong>{shareActive ? t("shareActive") : t("shareStopped")}</strong>
        <span>{t("sharePrivacy")}</span>
        {!shareActive && <button type="button" className="btn sm" onClick={restartShare}>{t("restartShare")}</button>}
        <span>{fullscreenActive ? t("fullscreenActive") : t("fullscreenWarning")}</span>
        {!fullscreenActive && <button type="button" className="btn sm" onClick={restartFullscreen}>{t("restartFullscreen")}</button>}
      </div>
      {integrityNotice && <p className="exam-integrity-notice" role="status">{integrityNotice}</p>}
      {shareNotice && <p className="err" role="alert">{shareNotice}</p>}
      <h3 className="qtext exam-copy-locked">{q.prompt}</h3>
      {q.type === "mcq" ? (
        <fieldset className="opts">
          {q.options.map((o, i) => (
            <label key={i} className={"opt exam-copy-locked" + (String(ans) === String(i) ? " on" : "")}>
              <input type="radio" name="opt" checked={String(ans) === String(i)} onChange={() => setAns(String(i))} /> {o}
            </label>
          ))}
        </fieldset>
      ) : (
        <>
          <details open><summary>{t("schema")}</summary><pre className="pre exam-copy-locked">{q.schema}</pre></details>
          <p className="note">{t("sqlHelp")}</p>
          <textarea className="code" rows={6} spellCheck={false} value={ans} onChange={(e) => setAns(e.target.value)} placeholder="SELECT ..." />
          <p className="muted">{t("pasteNote")}</p>
          <button className="btn ghost" onClick={runSql} disabled={!ans.trim() || !shareActive || !fullscreenActive}>{t("run")}</button>
          {out && (out.error ? <p className="err">{t("sqlError")}: {out.error}</p> : (
            <div className="tablewrap">
              <table><thead><tr>{out.columns.map((c) => <th key={c}>{c}</th>)}</tr></thead>
                <tbody>{out.rows.slice(0, 20).map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j}>{String(c)}</td>)}</tr>)}</tbody></table>
              <small className="muted">{out.rows.length} {t("rows")}</small>
            </div>
          ))}
        </>
      )}
      <Err e={err} />
      <div className="exam-actions">
        <button className="btn" onClick={submit} disabled={busy || quitting || !shareActive || !fullscreenActive || String(ans).trim() === ""}>{busy ? t("saving") : t("submit")}</button>
        <button type="button" className="btn ghost exam-quit" onClick={quit} disabled={busy || quitting}>{quitting ? t("quitBusy") : t("quitButton")}</button>
      </div>
    </section>
  );
}

/**
 * Server-timed countdown. Every attempt response re-syncs `initial` (seconds
 * left). When it reaches zero `onExpire` runs once so the exam can save the
 * last answer and submit. Unlimited-time attempts never expire.
 */
function ExamCountdown({ initial, warnAt = 120, onExpire, unlimited = false, unlimitedLabel = "Unlimited" }) {
  const seconds = Math.max(0, Math.floor(Number(initial) || 0));
  const [left, setLeft] = useState(seconds);
  const expireRef = useRef(onExpire);
  const firedRef = useRef(false);
  expireRef.current = onExpire;
  useEffect(() => {
    if (unlimited) return undefined;
    if (seconds > 0) firedRef.current = false;
    const deadline = Date.now() + seconds * 1000;
    const tick = () => {
      const next = Math.max(0, Math.round((deadline - Date.now()) / 1000));
      setLeft(next);
      if (next === 0 && !firedRef.current) {
        firedRef.current = true;
        expireRef.current?.();
      }
    };
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [seconds, unlimited]);
  if (unlimited) return <b>{unlimitedLabel}</b>;
  return <b className={left < warnAt ? "low" : ""} role="timer">{fmt(left)}</b>;
}

function GraphRAGExamRun({ initial, onFinished, integrity, cameraStream, micStream, onRestartShare, screenStream, audioContext, devicesReady = true, onRestartCamera, onRestartMic }) {
  const t = useT();
  const proctored = isProctored(initial.proctoring);
  const monitoring = useExamMonitoring({ enabled: proctored, initial, integrity, screenStream, cameraStream, micStream, audioContext });
  const [v, setV] = useState(initial);
  const [currentIndex, setCurrentIndex] = useState(initial.question_index || 0);
  const initialAnswers = initial.answers || initial.page?.answers || {};
  const [ans, setAns] = useState(
    initialAnswers[initial.question?.id] || "",
  );
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [quitting, setQuitting] = useState(false);
  const [syncing, setSyncing] = useState(false);
  // "Time is up" state: the countdown hit zero and the last answer is being
  // saved and the attempt submitted. "failed" keeps a retry button visible.
  const [timeUp, setTimeUp] = useState(null);
  const finishedRef = useRef(false);
  const onFinishedRef = useRef(onFinished);
  onFinishedRef.current = onFinished;
  // The server closed the attempt (submitted, or the timer ran out): stop the
  // exam UI once and hand over to the results screen.
  const finishOnce = useCallback((attemptId) => {
    if (finishedRef.current) return;
    finishedRef.current = true;
    onFinishedRef.current?.(attemptId);
  }, []);
  const [sqlOut, setSqlOut] = useState(null);
  const [voiceFlags, setVoiceFlags] = useState(0);
  const [voiceActive, setVoiceActive] = useState(false);
  const [detections, setDetections] = useState(null);
  const voiceTimer = useRef(null);
  const [marked, setMarked] = useState(() => {
    try {
      return new Set(JSON.parse(sessionStorage.getItem(`sb:flags:${initial.attempt_id}`) || "[]"));
    } catch {
      return new Set();
    }
  });
  const toggleMark = (id) => {
    setMarked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const aid = v.attempt_id;

  const allQuestions = v.all_questions || [];
  const q = allQuestions[currentIndex] || v.question;
  const answersMap = v.answers || initialAnswers;
  const qRef = useRef(q);
  const ansRef = useRef(ans);
  const indexRef = useRef(currentIndex);
  qRef.current = q;
  ansRef.current = ans;
  indexRef.current = currentIndex;
  const updateAnswer = useCallback((value) => {
    ansRef.current = value;
    setAns(value);
  }, []);
  const sessionId = useRef(initial.session_id);
  useEffect(() => {
    try {
      sessionStorage.setItem(`sb:flags:${aid}`, JSON.stringify([...marked]));
    } catch {
      /* session storage can be unavailable in private mode */
    }
  }, [marked, aid]);
  const visitedKey = `sb:visited:${initial.attempt_id}`;
  const [visited, setVisited] = useState(() => {
    try {
      return new Set(JSON.parse(sessionStorage.getItem(visitedKey) || "[]"));
    } catch {
      return new Set();
    }
  });
  useEffect(() => {
    const id = q?.id;
    if (!id) return;
    setVisited((prev) => {
      if (prev.has(id)) return prev;
      const next = new Set(prev);
      next.add(id);
      try {
        sessionStorage.setItem(visitedKey, JSON.stringify([...next]));
      } catch {
        /* ignore */
      }
      return next;
    });
  }, [q?.id, visitedKey]);
  const reportEvent = integrity.report;
  const flushIntegrityEvents = integrity.flushEvents;
  const onVoice = useCallback(({ confidence, level, duration_ms }) => {
    setVoiceFlags((count) => count + 1);
    setVoiceActive(true);
    if (voiceTimer.current) clearTimeout(voiceTimer.current);
    voiceTimer.current = setTimeout(() => setVoiceActive(false), 6000);
    reportEvent("ai_audio_level", {
      confidence: Number(Number(confidence).toFixed(2)),
      level: Number(level),
      duration_ms: Number(duration_ms),
      local_only: true,
    });
  }, [reportEvent]);
  useEffect(() => () => {
    if (voiceTimer.current) clearTimeout(voiceTimer.current);
  }, []);
  useEffect(() => {
    const track = micStream?.getAudioTracks?.()[0];
    if (!track) return undefined;
    const ended = () => reportEvent("microphone_stopped", { reason: "audio_track_ended" });
    track.addEventListener("ended", ended);
    return () => track.removeEventListener("ended", ended);
  }, [micStream, reportEvent]);

  useEffect(() => {
    setAns(answersMap[q?.id] || "");
    setSqlOut(null);
    // Only react to a question change; background saves must not overwrite typing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q?.id]);
  const saveAnswer = async () => {
    if (!integrity.shareActive || !integrity.fullscreenActive)
      throw new Error(
        !integrity.shareActive
          ? "screen_share_required"
          : "fullscreen_required",
      );
    if (!q || !String(ans).trim()) return v;
    await flushIntegrityEvents();
    const next = await api(`/attempts/${aid}/answer`, {
      method: "POST",
      headers: { "X-Exam-Session": sessionId.current },
      body: { question_id: q.id, answer: String(ans) },
    });
    setV(next);
    if (next?.status === "done") finishOnce(aid);
    return next;
  };
  const queueRef = useRef([]);
  const pumpPromise = useRef(null);
  const mergeView = useCallback((res) => {
    if (res?.status === "done") {
      queueRef.current = [];
      finishOnce(res.attempt_id || initial.attempt_id);
      return;
    }
    setV((prev) => ({
      ...prev,
      navigator: res.navigator ?? prev.navigator,
      answered: res.answered ?? prev.answered,
      answers: res.answers ?? prev.answers,
      all_questions: res.all_questions ?? prev.all_questions,
      remaining: res.remaining ?? prev.remaining,
    }));
  }, [finishOnce, initial.attempt_id]);
  const pumpQueue = useCallback(() => {
    if (pumpPromise.current) return pumpPromise.current;
    pumpPromise.current = (async () => {
      setSyncing(true);
      try {
        while (queueRef.current.length) {
          const item = queueRef.current.shift();
          try {
            await flushIntegrityEvents();
            const res = await api(`/attempts/${aid}/goto`, { method: "POST", body: item, headers: { "X-Exam-Session": sessionId.current } });
            mergeView(res);
          } catch (e) {
            setErr(e);
            // The optimistic position and the server disagree; reload once.
            try {
              const fresh = await api(`/attempts/${aid}`);
              if (fresh?.status === "done") {
                queueRef.current = [];
                finishOnce(aid);
                return;
              }
              setV(fresh);
              setCurrentIndex(fresh.question_index || 0);
              setAns((fresh.answers || {})[fresh.question?.id] || "");
            } catch {
              /* keep the current screen */
            }
            queueRef.current = [];
          }
        }
      } finally {
        pumpPromise.current = null;
        setSyncing(false);
      }
    })();
    return pumpPromise.current;
  }, [aid, mergeView, flushIntegrityEvents, finishOnce]);
  const flushQueue = async () => {
    while (queueRef.current.length || pumpPromise.current) {
      await pumpQueue();
    }
  };
  const goTo = (index) => {
    const previousQuestion = qRef.current;
    if (!previousQuestion || index === indexRef.current) return;
    if (!integrity.shareActive || !integrity.fullscreenActive || (proctored && (!devicesReady || !integrity.tabVisible))) {
      setErr(
        new Error(
          !integrity.shareActive
            ? "screen_share_required"
            : "fullscreen_required",
        ),
      );
      return;
    }
    const target = allQuestions[index];
    if (!target) return;
    // Instant UI switch. The previous answer and the navigation are written in
    // the background, serialised so the server state follows click order.
    const previousId = previousQuestion.id;
    const previousAnswer = String(ansRef.current ?? "");
    indexRef.current = index;
    ansRef.current = answersMap[target.id] || "";
    setCurrentIndex(index);
    setAns(answersMap[target.id] || "");
    setSqlOut(null);
    queueRef.current.push({ index, question_id: previousId, answer: previousAnswer });
    pumpQueue();
  };
  const runSql = async () => {
    if (!integrity.shareActive || !integrity.fullscreenActive || (proctored && (!devicesReady || !integrity.tabVisible))) {
      setErr(new Error("screen_share_required"));
      return;
    }
    try {
      setSqlOut(
        await api(`/attempts/${aid}/sql-run`, {
          method: "POST",
          headers: { "X-Exam-Session": sessionId.current },
          body: { sql: ans },
        }),
      );
    } catch (e) {
      setErr(e);
    }
  };
  const submit = async () => {
    if (!integrity.shareActive || !integrity.fullscreenActive || (proctored && (!devicesReady || !integrity.tabVisible))) {
      setErr(new Error("screen_share_required"));
      return;
    }
    const alreadySaved = Boolean(String(answersMap[q?.id] ?? "").trim());
    const unsaved = !alreadySaved && String(ans).trim() ? 1 : 0;
    const unanswered = Math.max(0, v.total - (v.answered + unsaved));
    if (unanswered > 0 && !window.confirm(
      `${unanswered} question${unanswered === 1 ? " is" : "s are"} still unanswered. Submit anyway?`,
    )) {
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      await flushQueue();
      await saveAnswer();
      await flushIntegrityEvents();
      const r = await api(`/attempts/${aid}/submit`, { method: "POST", headers: { "X-Exam-Session": sessionId.current } });
      if (r.status === "done") finishOnce(aid);
      else setV(r);
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };
  // Countdown reached zero: flush queued navigation and integrity events, save
  // the answer currently on screen (never lose the last typed answer), then
  // submit. The server finalises an expired attempt on any of these calls.
  const submitAfterTimeUp = async () => {
    if (finishedRef.current) return;
    setTimeUp("submitting");
    setErr(null);
    setBusy(true);
    try {
      try { await flushQueue(); } catch { /* the save below retries the answer */ }
      if (finishedRef.current) return;
      const current = qRef.current;
      const value = String(ansRef.current ?? "");
      try { await flushIntegrityEvents(); } catch { /* best effort */ }
      if (current && value.trim()) {
        const saved = await api(`/attempts/${aid}/answer`, {
          method: "POST",
          headers: { "X-Exam-Session": sessionId.current },
          body: { question_id: current.id, answer: value },
        });
        if (saved?.status === "done") { finishOnce(aid); return; }
      }
      const r = await api(`/attempts/${aid}/submit`, { method: "POST", headers: { "X-Exam-Session": sessionId.current } });
      if (r?.status === "done") { finishOnce(aid); return; }
      setV(r);
      setTimeUp("failed");
    } catch (e) {
      // The attempt may already be closed (expired on the server, or submitted
      // from another request). Check before reporting a failure.
      try {
        const fresh = await api(`/attempts/${aid}`);
        if (fresh?.status === "done") { finishOnce(aid); return; }
      } catch { /* report the original error */ }
      setErr(e);
      setTimeUp("failed");
    } finally {
      setBusy(false);
    }
  };
  const quit = async () => {
    if (!window.confirm("Quit this assessment? It will end without a score and cannot be resumed.")) return;
    setQuitting(true);
    setErr(null);
    try {
      // If time had already run out the server grades the attempt instead.
      const quitResult = await api(`/attempts/${aid}/quit`, { method: "POST", body: { session_id: sessionId.current } });
      await onFinished(aid, quitResult?.status === "done" ? "done" : "quit");
    } catch (e) { setErr(e); }
    finally { setQuitting(false); }
  };
  if (!q) return <p>Loading assessment…</p>;
  const isChoice = ["mcq", "multiple choice"].includes(
    String(q.question_type).toLowerCase(),
  );
  const currentNumber = currentIndex + 1;
  const previousIndex = Math.max(0, currentIndex - 1);
  const nextIndex = Math.min(v.total - 1, currentIndex + 1);
  const progressPct = v.total ? Math.round((v.answered / v.total) * 100) : 0;
  const sqlQuestion = String(q.question_type).toLowerCase().includes("sql");
  const codingQuestion = String(q.question_type).toLowerCase() === "coding";
  const codingLanguage = /javascript|typescript|react|next\.?js|node\.?js|express/i.test(
    String(q.question_text || ""),
  )
    ? "javascript"
    : "python";
  const navigator = v.navigator || [];
  const paused = proctored && (!devicesReady || !integrity.shareActive || !integrity.fullscreenActive || !integrity.tabVisible);
  const cameraLive = trackLive(cameraStream);
  const micLive = trackLive(micStream, "audio") && audioContext?.state === "running";
  const face = detections?.face || "Starting";
  const objects = detections?.objects || "Starting";
  const awayCount = integrity.signals.focus + integrity.signals.fullscreen;
  // Every monitoring signal in one list. These are review flags for a human,
  // never an automatic fail.
  const flagRows = [
    ...(proctored ? [
      { id: "camera", label: "Camera", value: cameraLive ? "On" : "Off", state: cameraLive ? "ok" : "bad" },
      { id: "mic", label: "Microphone", value: micLive ? "On" : "Off", state: micLive ? "ok" : "bad" },
      { id: "identity", label: "Face verification", value: initial.proctoring?.identity_status === "verified" ? "Verified" : "Manual review", state: initial.proctoring?.identity_status === "verified" ? "ok" : "warn" },
      { id: "face", label: "Face", value: face, state: face === "One face" ? "ok" : face === "No face" ? "bad" : "warn" },
      { id: "phone", label: "Phone", value: objects === "No phone detected" ? "None seen" : objects, state: objects === "No phone detected" ? "ok" : objects === "Possible phone" ? "bad" : "warn" },
      { id: "voice", label: "Voice", value: voiceActive ? "Detected now" : voiceFlags ? `${voiceFlags} flagged` : "Quiet", state: voiceActive ? "bad" : voiceFlags ? "warn" : "ok" },
    ] : []),
    { id: "screen", label: "Screen share", value: integrity.shareActive ? "Active" : "Stopped", state: integrity.shareActive ? "ok" : "bad" },
    { id: "fullscreen", label: "Full screen", value: integrity.fullscreenActive ? "Active" : "Exited", state: integrity.fullscreenActive ? "ok" : "bad" },
    { id: "tab", label: "Tab focus", value: !integrity.tabVisible ? "Away" : awayCount ? `${awayCount} left` : "In exam", state: !integrity.tabVisible ? "bad" : awayCount ? "warn" : "ok" },
    { id: "clipboard", label: "Copy / paste", value: integrity.signals.clipboard ? `${integrity.signals.clipboard} blocked` : "Blocked", state: integrity.signals.clipboard ? "warn" : "ok" },
    { id: "marked", label: "Marked questions", value: marked.size ? `${marked.size} flagged` : "None", state: marked.size ? "warn" : "ok" },
  ];
  return (
    <section className="tech-exam exam3">
      {!timeUp && (integrity.away || !integrity.fullscreenActive) && (
        <div className="exam-lock-overlay" role="alertdialog" aria-modal="true" aria-labelledby="exam-lock-title">
          <div className="exam-lock-card">
            <span className="exam-lock-icon" aria-hidden="true">!</span>
            <h3 id="exam-lock-title">{!integrity.fullscreenActive ? "You left full-screen" : "You left the exam tab"}</h3>
            <p>
              Switching tabs, windows or leaving full-screen is not allowed. This has been recorded for human review
              {integrity.signals.focus + integrity.signals.fullscreen > 0 ? ` (${integrity.signals.focus + integrity.signals.fullscreen} time${integrity.signals.focus + integrity.signals.fullscreen === 1 ? "" : "s"} so far)` : ""}.
              It never fails you automatically. Your timer keeps running.
            </p>
            <div className="exam-lock-actions">
              {!integrity.shareActive && (
                <button type="button" className="btn ghost" onClick={() => onRestartShare?.()}>Restore screen share</button>
              )}
              <button
                type="button"
                className="btn"
                onClick={async () => {
                  if (!document.fullscreenElement) await integrity.restartFullscreen();
                  if (document.fullscreenElement) integrity.dismissAway();
                }}
              >
                {!integrity.fullscreenActive ? "Return to full-screen exam" : "Return to exam"}
              </button>
              <button type="button" className="btn ghost exam-quit" onClick={quit} disabled={busy || quitting}>
                {quitting ? "Quitting…" : "Quit assessment"}
              </button>
            </div>
          </div>
        </div>
      )}
      {timeUp && (
        <div className="exam-lock-overlay exam-timeup-overlay" role="alertdialog" aria-modal="true" aria-labelledby="exam-timeup-title" aria-describedby="exam-timeup-body">
          <div className="exam-lock-card">
            <span className="exam-lock-icon" aria-hidden="true">◷</span>
            <h3 id="exam-timeup-title">{t("timeUpTitle")}</h3>
            <p id="exam-timeup-body" aria-live="assertive">{timeUp === "failed" ? t("timeUpFailed") : t("timeUpSubmitting")}</p>
            {timeUp === "failed" && (
              <>
                <Err e={err} />
                <div className="exam-lock-actions">
                  <button type="button" className="btn" onClick={submitAfterTimeUp} disabled={busy} autoFocus>{busy ? t("saving") : t("timeUpRetry")}</button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
      {!proctored && <MicMonitor stream={micStream} onVoice={onVoice} />}
      <header className="exam3-top">
        <div className="exam3-title">
          <span className="exam3-kind">{initial.mode === "initial_cv_fundamentals" || initial.mode === "job_specific" ? "Initial exam" : initial.mode === "profile_retake" ? "Profile retake exam" : "Assessment"}</span>
          <b>Question {currentNumber} of {v.total}</b>
          {syncing && <span className="exam3-saving">Saving…</span>}
        </div>
        <div className="exam3-progress" aria-label={`${v.answered || 0} of ${v.total} answered`}>
          <div className="exam3-progress-track"><span style={{ width: `${progressPct}%` }} /></div>
          <small>{v.answered || 0} / {v.total} answered</small>
        </div>
        <div className="exam3-timer">
          <span>Time left</span>
          <ExamCountdown initial={v.remaining} unlimited={Boolean(v.unlimited_time)} onExpire={submitAfterTimeUp} />
        </div>
      </header>

      <div className="exam3-grid">
        <aside className="exam3-nav" aria-label="Question palette">
          <div className="exam3-nav-head">
            <b>Questions</b>
            <span>{v.total} total</span>
          </div>
          <div className="exam3-qgrid">
            {navigator.map((item) => {
              const isCurrent = item.id === q.id;
              const answeredItem = isCurrent ? String(ans).trim() !== "" : item.answered;
              const skipped = !answeredItem && visited.has(item.id);
              const status = answeredItem ? "answered" : skipped ? "skipped" : "todo";
              return (
                <button
                  key={item.id}
                  type="button"
                  className={"exam3-q " + status + (isCurrent ? " current" : "") + (marked.has(item.id) ? " flagged" : "")}
                  onClick={() => goTo(item.number - 1)}
                  disabled={busy}
                  aria-current={isCurrent ? "step" : undefined}
                  title={`${marked.has(item.id) ? "Flagged · " : ""}${item.section === "project" ? "Project probe" : item.section === "cv" ? "CV cluster" : "Fundamental"} · ${item.topic} · ${item.difficulty}`}
                >
                  {item.number}
                  {marked.has(item.id) && <span className="exam3-qflag" aria-hidden="true">⚑</span>}
                </button>
              );
            })}
          </div>
          <ul className="exam3-legend">
            <li><i className="sw current" /> Current</li>
            <li><i className="sw answered" /> Answered</li>
            <li><i className="sw skipped" /> Skipped</li>
            <li><i className="sw" /> Not answered</li>
            <li><i className="sw flag">⚑</i> Flagged</li>
          </ul>
          <div className="exam3-actions">
            <button type="button" className="exam3-submit" onClick={submit} disabled={busy || quitting || paused}>
              {busy ? "Submitting…" : "Submit assessment"}
            </button>
            <button type="button" className="exam3-quit" onClick={quit} disabled={busy || quitting}>
              {quitting ? "Quitting…" : "Quit assessment"}
            </button>
          </div>
        </aside>

        <main className="exam3-main">
          {paused && <div className="exam3-paused" role="alert">Assessment controls are paused. Restore all four required permissions and return to this tab. Your server timer continues; you can always Quit assessment.</div>}
          <fieldset className="exam3-fieldset" disabled={paused}>
            <article className="exam3-card">
              <div className="exam3-card-head">
                <span className="exam3-chip">Question {currentNumber}</span>
                <span className="exam3-meta">
                  {[q.assessment_topic, q.difficulty_level, q.question_type].filter(Boolean).join(" · ")}
                  {q.marks ? ` · ${q.marks} mark${Number(q.marks) === 1 ? "" : "s"}` : ""}
                </span>
                <button
                  type="button"
                  className={"exam3-flag-btn" + (marked.has(q.id) ? " on" : "")}
                  onClick={() => toggleMark(q.id)}
                  aria-pressed={marked.has(q.id)}
                >
                  <span aria-hidden="true">⚑</span>
                  {marked.has(q.id) ? "Flagged" : "Flag Question"}
                </button>
              </div>
              <div className="exam3-card-body">
                <h3 className="exam3-question">{q.prompt}</h3>

                {isChoice ? (
                  <div className="exam3-options" role="radiogroup" aria-label="Answer options">
                    {q.options.map((option, index) => (
                      <label key={index} className={"exam3-opt" + (String(ans) === String(option) ? " on" : "")}>
                        <input
                          type="radio"
                          name={"gr-option-" + q.id}
                          checked={String(ans) === String(option)}
                          onChange={() => updateAnswer(String(option))}
                        />
                        <span className="exam3-opt-letter" aria-hidden="true">{String.fromCharCode(65 + index)}</span>
                        <span className="exam3-opt-text">{option}</span>
                      </label>
                    ))}
                  </div>
                ) : (
                  <>
                    {sqlQuestion && (
                      <details className="exam3-schema" open>
                        <summary>SQL schema</summary>
                        <pre>{q.schema || "Schema supplied by the question author."}</pre>
                      </details>
                    )}
                    <div className="exam3-answer-head">
                      <b>Your answer</b>
                      <span>{codingQuestion ? "Code workspace" : sqlQuestion ? "SQL editor" : "Response editor"}</span>
                    </div>
                    {codingQuestion ? (
                      <Suspense fallback={<div className="cw-loading">Loading code workspace…</div>}>
                        <CodeWorkspace
                          question={q}
                          value={ans}
                          onChange={updateAnswer}
                          defaultLanguage={codingLanguage}
                          disabled={busy || paused}
                        />
                      </Suspense>
                    ) : (
                      <>
                        <textarea
                          className="exam3-textarea"
                          rows={8}
                          spellCheck={false}
                          value={ans}
                          onChange={(e) => updateAnswer(e.target.value)}
                          placeholder={sqlQuestion ? "SELECT ..." : "Write your explanation, scenario response or code here…"}
                        />
                        {sqlQuestion && (
                          <button type="button" className="exam3-ghost" onClick={runSql} disabled={!ans.trim()}>
                            Run SQL
                          </button>
                        )}
                        {sqlOut && <pre className="exam3-sqlout">{JSON.stringify(sqlOut, null, 2)}</pre>}
                      </>
                    )}
                  </>
                )}
                <p className="exam3-note">Your answer is saved as you move. You can revisit any question before submitting.</p>
              </div>
            </article>

            <nav className="exam3-pager" aria-label="Question navigation">
              <button type="button" className="exam3-pg prev" onClick={() => goTo(previousIndex)} disabled={currentNumber <= 1 || busy}>
                ← Previous
              </button>
              <span className="exam3-pager-count">{currentNumber} / {v.total}</span>
              <button type="button" className="exam3-pg next" onClick={() => goTo(nextIndex)} disabled={currentNumber >= v.total || busy}>
                Next Question →
              </button>
            </nav>
          </fieldset>
          <Err e={err} />
        </main>

        <aside className="exam3-side" aria-label="Camera and monitoring flags">
          <section className="exam3-cam">
            <div className="exam3-side-head">
              <b>Camera</b>
              <span className={"exam3-live" + (proctored && trackLive(cameraStream) ? " on" : "")}>{proctored ? (trackLive(cameraStream) ? "Live" : "Off") : "Not used"}</span>
            </div>
            {proctored ? (
              <>
                <LocalProctor cameraStream={cameraStream} report={integrity.report} inline onDetections={setDetections} />
                <div className="exam3-restore">
                  {!trackLive(cameraStream) && <button type="button" onClick={onRestartCamera}>Restore camera</button>}
                  {(!trackLive(micStream, "audio") || audioContext?.state !== "running") && <button type="button" onClick={onRestartMic}>Restore microphone</button>}
                </div>
              </>
            ) : (
              <div className="exam3-cam-off">This exam does not use your camera. Screen, full-screen and tab signals are still recorded for human review.</div>
            )}
          </section>

          <section className="exam3-flags">
            <div className="exam3-side-head">
              <b>Monitoring flags</b>
              <span className={"exam3-count" + (flagRows.some((row) => row.state === "bad") ? " bad" : flagRows.some((row) => row.state === "warn") ? " warn" : "")}>
                {flagRows.filter((row) => row.state !== "ok").length || "All clear"}
              </span>
            </div>
            <ul className="exam3-flag-list">
              {flagRows.map((row) => (
                <li key={row.id} className={"exam3-flag " + row.state}>
                  <i aria-hidden="true" />
                  <span>{row.label}</span>
                  <b>{row.value}</b>
                </li>
              ))}
            </ul>
            {(!integrity.shareActive || !integrity.fullscreenActive) && (
              <div className="exam3-restore">
                {!integrity.shareActive && (
                  <button
                    type="button"
                    onClick={async () => {
                      const stream = await onRestartShare?.();
                      if (!stream) integrity.setNotice("screen_share_required");
                    }}
                  >
                    Restore screen share
                  </button>
                )}
                {!integrity.fullscreenActive && <button type="button" onClick={integrity.restartFullscreen}>Restore full-screen</button>}
              </div>
            )}
            {proctored && <p className="exam3-evidence" role="status">{monitoring.evidenceStatus}</p>}
          </section>

          <IntegrityAlerts alerts={integrity.alerts} inline />

          <p className="exam3-tip">
            {proctored ? "Camera observations, sound-level flags and event-triggered screenshots are saved for human review. No emotion, personality, demographics or speech content is inferred. Flags never fail you automatically." : "Tab changes and leaving full-screen are advisory signals for human review, never an automatic fail."}
          </p>
        </aside>
      </div>
    </section>
  );
}

function Result({ aid, next, nextLabel }) {
  const t = useT();
  const [r, setR] = useState(null);
  const [reviewPage, setReviewPage] = useState(0);
  const [err, setErr] = useState(null);
  useEffect(() => {
    api(`/attempts/${aid}/result`).then(setR).catch(setErr);
  }, [aid]);
  const waitingForResultReview = Boolean(r && !r.publication?.ready && r.publication?.stage !== "invalidated");
  useEffect(() => {
    if (!waitingForResultReview) return;
    const timer = setInterval(() => api(`/attempts/${aid}/result`).then(setR).catch(setErr), 15000);
    return () => clearInterval(timer);
  }, [aid, waitingForResultReview]);
  if (err) return <Err e={err} />;
  if (!r) return <p>{t("loading")}</p>;
  return (
    <section>
      <h2>{t("resultTitle")}</h2>
      <AssessmentStatus publication={r.publication} objective={r.objective_summary} onRefresh={() => api(`/attempts/${aid}/result`).then(setR).catch(setErr)} />
      <div className="card result">
        <div className="bignum">
          <span>{r.overall == null ? "Pending" : r.overall}</span>
          <small>{r.overall == null ? "review" : "%"}</small>
        </div>
        <dl className="facts">
          <div>
            <dt>{t("level")}</dt>
            <dd>{t("levels")[r.level]}</dd>
          </div>
          <div>
            <dt>{t("trust")}</dt>
            <dd>
              <TrustChip trust={r.trust} />
            </dd>
          </div>
          <div>
            <dt>{t("date")}</dt>
            <dd>{r.date}</dd>
          </div>
        </dl>
      </div>
      {r.section_scores && (
        <div className="score-split">
          <article>
            <small>Fundamentals · 60% weight</small>
            <strong>
              {r.section_scores.fundamental?.score == null
                ? "—"
                : r.section_scores.fundamental.score + "%"}
            </strong>
            <span>
              DSA · SQL · Networking · OOP · Database · Coding · Critical Thinking
            </span>
          </article>
          <article>
            <small>CV & Development · 40% weight</small>
            <strong>
              {r.section_scores.cv?.score == null
                ? "—"
                : r.section_scores.cv.score + "%"}
            </strong>
            <span>AI/ML · Git · Docker · all confirmed CV skills merged</span>
          </article>
        </div>
      )}
      {r.scoring_version === "legacy-adaptive" && (
        <p className="note">
          This is a legacy adaptive result. Take a new verified assessment to
          receive the 60% fundamentals / 40% CV development scorecard.
        </p>
      )}
      {r.publication?.ready && (
        <p className="success-note">
          Human-reviewed and approved. Your verified learning path is updated
          and a Skill Passport has been issued automatically.
        </p>
      )}
      {r.review_status === "invalidated" && (
        <p className="err">
          This result was invalidated during human review. Your score was not
          changed, but it cannot be used as verified evidence.
        </p>
      )}
      {r.review_status === "needs_more_info" && (
        <p className="note">
          The reviewer requested more information. Your learning recommendations
          remain provisional until the result is approved.
        </p>
      )}
      {r.manual_review_required && (
        <p className="note">
          Explanation, coding and scenario responses have stored-rubric drafts for human review.
          Courses and the Skill Passport remain locked until academic and honesty approval are complete.
        </p>
      )}
      <div className="card">
        <h3>{t("topics")}</h3>
        <ul className="gaps">
          {Object.entries(r.topics).map(([k, v]) => (
            <li key={k}>
              <div className="gaprow">
                <strong>{v.label || k}</strong>
                <span className="muted">
                  {v.score == null ? "Pending review" : t("levels")[v.level]}
                </span>
                <span>{v.score == null ? "—" : v.score + "%"}</span>
              </div>
              <Bar score={v.score ?? 0} />
            </li>
          ))}
        </ul>
        <p className="muted">{t("percentile")}</p>
        {r.manual_review_required && (
          <p className="note">
            Some coding, SQL, scenario or explanation responses are awaiting
            human review. The displayed score covers automatically gradable
            questions only.
          </p>
        )}
      </div>
      {r.question_results?.length > 0 && (
        <div className="card gr-review">
          <h3>Question and answer review</h3>
          <p className="muted">
            Correct answers are revealed only after submission. Five questions
            are shown per page.
          </p>
          <div className="gr-question-table">
            <table>
              <thead>
                <tr>
                  <th>#</th>
                  <th>Question</th>
                  <th>Your answer</th>
                  <th>Expected answer / review</th>
                  <th>Marks</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {r.question_results
                  .slice(reviewPage * 5, reviewPage * 5 + 5)
                  .map((item, index) => (
                    <tr key={item.question_id}>
                      <td>{reviewPage * 5 + index + 1}</td>
                      <td>{item.question}</td>
                      <td>{item.answer || "No answer"}</td>
                      <td>{item.correct_answer || "Pending human review"}</td>
                      <td>
                        {item.awarded_marks == null
                          ? "Pending"
                          : `${item.awarded_marks} / ${item.max_marks ?? 1}`}
                      </td>
                      <td>{String(item.review_status).replaceAll("_", " ")}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
          <div className="gr-exam-actions">
            <button
              className="btn ghost"
              onClick={() => setReviewPage((x) => Math.max(0, x - 1))}
              disabled={reviewPage === 0}
            >
              Previous 5
            </button>
            <span>
              Page {reviewPage + 1} of{" "}
              {Math.ceil(r.question_results.length / 5)}
            </span>
            <button
              className="btn ghost"
              onClick={() =>
                setReviewPage((x) =>
                  Math.min(Math.ceil(r.question_results.length / 5) - 1, x + 1),
                )
              }
              disabled={(reviewPage + 1) * 5 >= r.question_results.length}
            >
              Next 5
            </button>
          </div>
        </div>
      )}
      <div className="card quiet">
        <p>{t("trustNote")}</p>
        {(r.trust_reasons || []).length > 0 && (
          <ul>
            {r.trust_reasons.map((x) => (
              <li key={x.key}>
                {x.n} × {t("reasonLabels")[x.key]}
              </li>
            ))}
          </ul>
        )}
        {r.review_decision && (
          <div className="assessment-review-result">
            <strong>{t(`assessmentReview_${r.review_decision}`)}</strong>
            {r.review_reason && <p>{r.review_reason}</p>}
          </div>
        )}
        <HonestyOutcome attempt={r} />
        {r.review_decision === "needs_more_info" && (
          <ReviewResponseForm
            attempt={{ ...r, id: r.attempt_id || aid }}
            onSubmitted={() => api(`/attempts/${aid}/result`).then(setR).catch(setErr)}
          />
        )}
        {(canAppealAttempt(r) || r.appeal) && (
          <>
            <h3>{t("appealTitle")}</h3>
            <AttemptAppeal
              attempt={{ ...r, id: r.attempt_id || aid }}
              onSubmitted={() => api(`/attempts/${aid}/result`).then(setR).catch(setErr)}
            />
          </>
        )}
      </div>
      {next && (
        <button className="btn" onClick={next}>
          {nextLabel}
        </button>
      )}
    </section>
  );
}

/** The backend's `appealable` flag wins; older payloads fall back to the outcome. */
function canAppealAttempt(attempt) {
  if (typeof attempt?.appealable === "boolean") return attempt.appealable;
  return attempt?.review_decision === "invalidated" || isHonestyRejected(attempt);
}

function AttemptAppeal({ attempt, onSubmitted }) {
  const t = useT();
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [submitted, setSubmitted] = useState(false);
  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      await api(`/attempts/${attempt.id || attempt.attempt_id}/appeal`, { method: "POST", body: { note } });
      setNote("");
      if (onSubmitted) await onSubmitted();
      setSubmitted(true);
    } catch (error) {
      setErr(error);
    } finally {
      setBusy(false);
    }
  };
  const needsMoreInfo = attempt.appeal_decision === "needs_more_info";
  if (attempt.appeal || submitted) return (
    <div className="attempt-appeal-status">
      <strong>{attempt.appeal_decision ? t(`appeal_${attempt.appeal_decision}`) : t("appealPending")}</strong>
      {attempt.appeal_reason && <p>{attempt.appeal_reason}</p>}
      {needsMoreInfo && !submitted && (
        <form className="attempt-appeal-form" onSubmit={submit}>
          <label>{t("appealMoreInfoHelp")}<textarea value={note} onChange={(event) => setNote(event.target.value)} minLength={3} maxLength={1000} rows={3} required /></label>
          {err && <Err e={err} />}
          <button className="btn ghost sm" disabled={busy || note.trim().length < 3}>{busy ? t("saving") : t("appealUpdateBtn")}</button>
        </form>
      )}
    </div>
  );
  if (!canAppealAttempt(attempt)) return null;
  return (
    <form className="attempt-appeal-form" onSubmit={submit}>
      <label>{t("appealHelp")}<textarea value={note} onChange={(event) => setNote(event.target.value)} minLength={3} maxLength={1000} rows={3} required /></label>
      {err && <Err e={err} />}
      <button className="btn ghost sm" disabled={busy || note.trim().length < 3}>{busy ? t("saving") : t("appealBtn")}</button>
    </form>
  );
}

/** Candidate-facing status of one finished attempt. */
function attemptOutcome(attempt) {
  if (isHonestyRejected(attempt)) return "honesty_rejected";
  if (attempt?.review_decision === "approved" && !attempt.finalized && attempt.publication?.stage !== "published") return "pending";
  return attempt?.review_decision || "pending";
}

const outcomePillClass = (status) =>
  "status-pill " + (status === "approved" ? "status-valid" : status === "invalidated" || status === "honesty_rejected" ? "status-invalid" : "status-review");

/** Neutral explanation of a human honesty-review rejection. Never automatic. */
function HonestyOutcome({ attempt }) {
  const t = useT();
  if (!isHonestyRejected(attempt)) return null;
  return (
    <div className="assessment-review-result honesty-outcome">
      <strong>{t("honestyRejectedTitle")}</strong>
      <p>{t("honestyRejectedBody")}</p>
      {(attempt.honesty_reason || attempt.honesty?.reason) && <p><strong>{t("reviewReason")}:</strong> {attempt.honesty_reason || attempt.honesty.reason}</p>}
    </div>
  );
}

/**
 * Reply to a reviewer who asked for more information. Posts to
 * /api/attempts/{id}/review-response; once sent the attempt carries
 * review_response {note, created}.
 */
function ReviewResponseForm({ attempt, onSubmitted }) {
  const t = useT();
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [sent, setSent] = useState(null);
  const fieldId = useId();
  if (attempt?.review_decision !== "needs_more_info") return null;
  const response = attempt.review_response || sent;
  // review_response_allowed (when present) tells us the backend accepts a reply.
  if (!response && attempt.review_response_allowed === false) return null;
  if (response) {
    return (
      <div className="attempt-appeal-status review-response-sent" role="status" aria-live="polite">
        <strong>{t("reviewResponseSent")}</strong>
        {response.note && <p>{response.note}</p>}
        {response.created ? <small>{new Date(Number(response.created) * 1000).toLocaleString()}</small> : null}
      </div>
    );
  }
  const trimmed = note.trim();
  const submit = async (event) => {
    event.preventDefault();
    if (trimmed.length < 3) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await api(`/attempts/${attempt.id || attempt.attempt_id}/review-response`, { method: "POST", body: { note: trimmed } });
      setSent(res?.review_response || { note: trimmed, created: Date.now() / 1000 });
      setNote("");
      if (onSubmitted) await onSubmitted();
    } catch (error) {
      setErr(error?.status === 404 || error?.status === 501 ? { code: "review_response_unavailable" } : error);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="attempt-appeal-form review-response-form" onSubmit={submit}>
      <p className="review-response-action"><strong>{t("reviewResponseActionNeeded")}</strong></p>
      <label htmlFor={fieldId}>{t("reviewResponseLabel")}</label>
      <textarea id={fieldId} value={note} onChange={(event) => setNote(event.target.value)} minLength={3} maxLength={2000} rows={3} required aria-describedby={fieldId + "-help"} />
      <small id={fieldId + "-help"} className="muted">{t("reviewResponseHelp")} ({note.length}/2000)</small>
      <div aria-live="polite"><Err e={err} /></div>
      <button className="btn ghost sm" disabled={busy || trimmed.length < 3}>{busy ? t("saving") : t("reviewResponseSend")}</button>
    </form>
  );
}

function AssessmentNotifications({ attempts, onRefresh, unreadKeys, server, serverHighlight, onOpenServer }) {
  const t = useT();
  const notifications = assessmentNotificationItems(attempts);
  const serverItems = server?.items || [];
  const feed = mergeNotificationFeed(notifications, serverItems);
  const latest = notifications[0];
  const serverState = server && (
    <div aria-live="polite">
      {server.status === "loading" && !serverItems.length && <p className="assessment-notification-empty">{t("loading")}</p>}
      {server.status === "error" && (
        <p className="err" role="alert">
          {t("notificationsLoadFailed")}{" "}
          <button type="button" className="cr-text-btn" onClick={server.load}>{t("retry")}</button>
        </p>
      )}
    </div>
  );
  if (!feed.length) {
    return (
      <>
        {serverState}
        {server?.status !== "loading" && <p className="assessment-notification-empty">{t("noAssessmentNotifications")}</p>}
      </>
    );
  }
  const date = (timestamp) => timestamp
    ? new Date(Number(timestamp) * 1000).toLocaleString()
    : "";
  const statusKey = (decision) => `assessmentReview_${decision}`;
  const statusDecision = latest ? attemptOutcome(latest) : "pending";
  const reviewedAt = latest ? Math.max(Number(latest.reviewed_at) || 0, Number(latest.appeal_decided_at) || 0, Number(latest.honesty?.reviewed_at) || 0) : 0;
  return (
    <div className="assessment-notifications" aria-live="polite">
      {serverState}
      <div className="assessment-notification-panel">
        {latest && <div className="assessment-notification-heading">
          <div>
            <small>{typeof latest.overall === "number" ? t("latestReviewed") : t("latestUpdate")}</small>
            <strong>{typeof latest.overall === "number" ? `${latest.overall} / 100` : t(statusKey(statusDecision))}</strong>
            {reviewedAt ? <small>{date(reviewedAt)}</small> : null}
          </div>
          <span className="assessment-notification-count" aria-label={`${feed.length} ${t("assessmentUpdates")}`}>{feed.length}</span>
        </div>}
        {feed.map(({ source, key, item: attempt }) => source === "server" ? (
          <ServerNotificationItem
            key={key}
            item={attempt}
            unread={Boolean(serverHighlight?.has(attempt.id)) || !attempt.read_at}
            onOpen={onOpenServer && attempt.link ? onOpenServer : undefined}
          />
        ) : (
          <article className={"assessment-notification-item" + (unreadKeys?.has(notificationKey(attempt)) ? " is-unread" : "")} key={attempt.id}>
            <div className="assessment-notification-meta">
              <strong>{attempt.kind === "post" ? t("attemptRetest") : t("attemptInitial")}</strong>
              <span className={outcomePillClass(attemptOutcome(attempt))}>
                {t(statusKey(attemptOutcome(attempt)))}
              </span>
              <small>{date(notificationTimestamp(attempt))}</small>
            </div>
            {typeof attempt.overall === "number" && <strong className="assessment-notification-score">{attempt.overall} / 100</strong>}
            {attempt.review_reason && <p>{attempt.review_reason}</p>}
            <HonestyOutcome attempt={attempt} />
            <ReviewResponseForm attempt={attempt} onSubmitted={onRefresh} />
            {(canAppealAttempt(attempt) || attempt.appeal) && <AttemptAppeal attempt={attempt} onSubmitted={onRefresh} />}
          </article>
        ))}
      </div>
    </div>
  );
}

function AssessmentRecords({ attempts, onRefresh }) {
  const t = useT();
  const [filter, setFilter] = useState("all");
  const records = [...attempts].filter((attempt) => attempt.status === "done")
    .sort((a, b) => (b.finished || 0) - (a.finished || 0));
  // Buckets follow the candidate-facing outcome; an honesty rejection counts
  // with the other "not verified" outcomes.
  const bucket = (attempt) => {
    const status = attemptOutcome(attempt);
    if (status === "honesty_rejected" || status === "invalidated") return "invalidated";
    if (status === "approved") return "approved";
    return "pending";
  };
  const counts = {
    all: records.length,
    approved: records.filter((attempt) => bucket(attempt) === "approved").length,
    pending: records.filter((attempt) => bucket(attempt) === "pending").length,
    invalidated: records.filter((attempt) => bucket(attempt) === "invalidated").length,
  };
  const visibleRecords = filter === "all" ? records : records.filter((attempt) => bucket(attempt) === filter);
  const date = (timestamp) => timestamp
    ? new Date(Number(timestamp) * 1000).toLocaleString()
    : "";
  const filters = [
    ["all", t("allRecords")],
    ["approved", t("assessmentReview_approved")],
    ["pending", t("assessmentReview_pending")],
    ["invalidated", t("assessmentReview_invalidated")],
  ];
  return (
    <section className="assessment-records">
      <header className="assessment-records-heading">
        <div><span className="eyebrow">{t("assessmentUpdates")}</span><h1>{t("assessmentRecords")}</h1><p>{t("assessmentRecordsHelp")}</p></div>
        <span className="assessment-total"><strong>{records.length}</strong><small>{t("records")}</small></span>
      </header>
      {!!records.length && <div className="assessment-record-summary">
        <article className="assessment-summary-card"><span className="assessment-summary-icon" aria-hidden="true"><WorkspaceIcon name="check" size={18} /></span><div><strong>{counts.approved}</strong><small>{t("assessmentReview_approved")}</small></div></article>
        <article className="assessment-summary-card"><span className="assessment-summary-icon pending" aria-hidden="true"><WorkspaceIcon name="clock" size={18} /></span><div><strong>{counts.pending}</strong><small>{t("assessmentReview_pending")}</small></div></article>
        <article className="assessment-summary-card"><span className="assessment-summary-icon rejected" aria-hidden="true"><WorkspaceIcon name="alert" size={18} /></span><div><strong>{counts.invalidated}</strong><small>{t("assessmentReview_invalidated")}</small></div></article>
      </div>}
      <nav className="assessment-record-filters" aria-label={t("filterAssessments")}>
        {filters.map(([id, label]) => <button key={id} type="button" aria-pressed={filter === id} className={filter === id ? "active" : ""} onClick={() => setFilter(id)}>
          {label}<span>{counts[id]}</span>
        </button>)}
      </nav>
      {!visibleRecords.length ? <div className="assessment-record-empty"><span aria-hidden="true"><WorkspaceIcon name="exams" size={20} /></span><h2>{records.length ? t("noMatchingAssessments") : t("noAssessmentRecords")}</h2><p>{records.length ? t("changeAssessmentFilter") : t("assessmentRecordsHelp")}</p></div> : visibleRecords.map((attempt) => {
        const status = attemptOutcome(attempt);
        const label = t(`assessmentReview_${status}`);
        return (
          <article className={`assessment-record-card assessment-record-${status}`} key={attempt.id}>
            <header className="assessment-record-header">
              <div className="assessment-record-title"><span className="assessment-record-icon" aria-hidden="true"><WorkspaceIcon name={attempt.kind === "post" ? "refresh" : "exams"} size={18} /></span><div><strong>{attempt.kind === "post" ? t("attemptRetest") : t("attemptInitial")}</strong><small>{date(attempt.finished)}</small></div></div>
              <span className={outcomePillClass(status)}>{label}</span>
            </header>
            <div className="assessment-record-score-row">
              <div className="assessment-record-score"><span>{t("score")}</span><strong>{attempt.overall ?? "—"}<small> / 100</small></strong></div>
              <div className="assessment-score-track" role="img" aria-label={`${t("score")}: ${attempt.overall ?? 0}%`}>
                <span style={{ width: `${Math.max(0, Math.min(100, Number(attempt.overall) || 0))}%` }} />
              </div>
            </div>
            {Object.keys(attempt.topics || {}).length > 0 && <details className="assessment-topic-details">
              <summary>{t("topicBreakdown")} <span>{Object.keys(attempt.topics).length}</span></summary>
              <div className="assessment-topic-list">
                {["sql", "python", "statistics", "visualization", ...Object.keys(attempt.topics)]
                  .filter((topic, index, topics) => topic in attempt.topics && topics.indexOf(topic) === index)
                  .map((topic) => {
                    const topicResult = attempt.topics[topic];
                    const topicScore = Math.max(0, Math.min(100, Number(topicResult.score) || 0));
                    return <div className="assessment-topic-row" key={topic}>
                      <div className="assessment-topic-label"><strong>{t(`topic_${topic}`)}</strong><span>{topicScore}%</span></div>
                      <div className="assessment-score-track"><span style={{ width: `${topicScore}%` }} /></div>
                      <small>{topicResult.n} {t("questionsAnswered")}</small>
                    </div>;
                  })}
              </div>
            </details>}
            {attempt.review_reason && <p className="assessment-record-reason"><strong>{t("reviewReason")}:</strong> {attempt.review_reason}</p>}
            <HonestyOutcome attempt={attempt} />
            <ReviewResponseForm attempt={attempt} onSubmitted={onRefresh} />
            <AttemptAppeal attempt={attempt} onSubmitted={onRefresh} />
          </article>
        );
      })}
    </section>
  );
}

function Uplift() {
  const t = useT();
  const [u, setU] = useState(null);
  useEffect(() => {
    api("/uplift")
      .then(setU)
      .catch(() => {});
  }, []);
  if (!u || !u.available) return null;
  return (
    <div className="card">
      <h3>{t("upliftTitle")}</h3>
      <p className="bignum small">
        <span>
          {u.overall.delta == null
            ? "Pending"
            : `${u.overall.delta >= 0 ? "+" : ""}${u.overall.delta}`}
        </span>
        <small>
          {u.overall.delta == null
            ? " human review"
            : ` pts (${u.overall.pre}% → ${u.overall.post}%)`}
        </small>
      </p>
      <ul className="gaps">
        {Object.entries(u.topics).map(([k, v]) => (
          <li key={k}>
            <div className="gaprow">
              <strong>{v.label || k}</strong>
              <span>
                {t("pre")} {v.pre == null ? "—" : v.pre + "%"} → {t("post")}{" "}
                {v.post == null ? "—" : v.post + "%"}
              </span>
              <span>
                {v.delta == null
                  ? "—"
                  : `${v.delta >= 0 ? "+" : ""}${v.delta}`}
              </span>
            </div>
            <Bar score={v.post ?? 0} threshold={v.pre ?? 0} />
          </li>
        ))}
      </ul>
      <p className="muted">{t("upliftNote")}</p>
    </div>
  );
}

/* ---------- shared camera preview ---------- */
const ALERT_MAP = {
  copy: { title: "Copy attempt blocked", detail: "Clipboard actions are recorded as review signals.", level: "warn", icon: "⧉" },
  cut: { title: "Cut attempt blocked", detail: "Clipboard actions are recorded as review signals.", level: "warn", icon: "⧉" },
  paste: { title: "Paste attempt blocked", detail: "Clipboard actions are recorded as review signals.", level: "warn", icon: "⧉" },
  context_menu: { title: "Right-click blocked", detail: "The context menu is disabled during the assessment.", level: "warn", icon: "⧉" },
  drag_start: { title: "Drag attempt blocked", detail: "Dragging text or images is disabled during the assessment.", level: "warn", icon: "⧉" },
  blur: { title: "Window focus lost", detail: "Stay on the assessment window.", level: "warn", icon: "◱" },
  tab_hidden: { title: "Tab switch detected", detail: "Keep the assessment tab visible.", level: "warn", icon: "◱" },
  fullscreen_exit: { title: "Full-screen exited", detail: "Return to full-screen to answer.", level: "warn", icon: "⛶" },
  screen_share_stopped: { title: "Screen sharing stopped", detail: "Restore screen sharing to continue.", level: "danger", icon: "▣" },
  screen_share_unavailable: { title: "Screen sharing unavailable", detail: "Restore screen sharing to continue.", level: "danger", icon: "▣" },
  wrong_share_surface: { title: "Wrong surface shared", detail: "Share your entire screen, not a tab or window.", level: "warn", icon: "▣" },
  camera_stopped: { title: "Webcam disconnected", detail: "Reconnect the webcam to restore the preview.", level: "danger", icon: "◉" },
  ai_gaze_away: { title: "Eyes away from screen", detail: "On-device gaze estimate flagged a look-away.", level: "info", icon: "◉" },
  ai_no_face: { title: "Face not detected", detail: "Stay centred in the camera frame.", level: "warn", icon: "◉" },
  ai_multiple_faces: { title: "Multiple faces detected", detail: "Only the candidate should be visible.", level: "warn", icon: "◉" },
  ai_phone_detected: { title: "Possible phone detected", detail: "Phones and other devices are not allowed.", level: "warn", icon: "☎" },
  ai_audio_level: { title: "Sustained sound level detected", detail: "Local microphone loudness exceeded the threshold. This does not identify speech, speakers or intent.", level: "warn", icon: "🎙" },
  microphone_stopped: { title: "Microphone disconnected", detail: "Reconnect the microphone and enable it again. This interruption is recorded.", level: "danger", icon: "🎙" },
  ai_model_unavailable: { title: "On-device AI unavailable", detail: "Camera analysis could not start; review continues from events.", level: "info", icon: "◉" },
};

function IntegrityAlerts({ alerts, inline = false }) {
  if (!alerts?.length) return null;
  return (
    <div className={"integrity-alerts" + (inline ? " inline" : "")} role="status" aria-live="polite">
      {alerts.map((alert) => (
        <div key={alert.id} className={"integrity-alert " + alert.level} title={alert.detail}>
          <span className="integrity-alert-icon" aria-hidden="true">{alert.icon}</span>
          <div>
            <strong>{alert.title}</strong>
            {alert.detail && <small>{alert.detail}</small>}
          </div>
        </div>
      ))}
      <span className="integrity-alerts-note">Review signals only · never an automatic fail</span>
    </div>
  );
}

/* On-device loudness monitor. No audio is recorded, stored or uploaded. */
function MicMonitor({ stream, onVoice }) {
  useEffect(() => {
    if (!stream) return undefined;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return undefined;
    const context = new Ctx();
    // Browsers start an AudioContext suspended unless it is resumed from a user
    // gesture. Without this the analyser reads silence and no voice flag fires.
    const resume = () => {
      if (context.state === "suspended") context.resume?.().catch(() => {});
    };
    resume();
    document.addEventListener("pointerdown", resume);
    document.addEventListener("keydown", resume);
    const source = context.createMediaStreamSource(stream);
    const analyser = context.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.4;
    source.connect(analyser);
    const samples = new Uint8Array(analyser.fftSize);
    let loudTicks = 0;
    let lastAlert = 0;
    const timer = setInterval(() => {
      resume();
      analyser.getByteTimeDomainData(samples);
      let sum = 0;
      for (let i = 0; i < samples.length; i += 1) {
        const value = (samples[i] - 128) / 128;
        sum += value * value;
      }
      const rms = Math.sqrt(sum / samples.length);
      const now = Date.now();
      if (rms > 0.028) {
        loudTicks += 1;
        // ~1 second of sustained speech before flagging, then throttle.
        if (loudTicks >= 3 && now - lastAlert > 6000) {
          lastAlert = now;
          loudTicks = 0;
          onVoice({
            confidence: Math.min(0.99, 0.5 + rms * 2),
            level: Number(rms.toFixed(4)),
            duration_ms: 1000,
          });
        }
      } else {
        loudTicks = 0;
      }
    }, 250);
    return () => {
      clearInterval(timer);
      document.removeEventListener("pointerdown", resume);
      document.removeEventListener("keydown", resume);
      try { source.disconnect(); } catch { /* already disconnected */ }
      context.close?.().catch(() => {});
    };
  }, [stream, onVoice]);
  return null;
}

/* ---------- verify-page helpers ---------- */
const noopReport = () => {};

// In Chromium, Keyboard Lock routes browser/OS shortcuts (Alt+Tab, Ctrl+Tab,
// Ctrl+W, Ctrl+T, Windows key…) to the page while full-screen, so the exam's
// key handler can block them, and Esc must be held to leave full-screen. Other
// browsers ignore this; focus/visibility events remain the fallback evidence.
function lockExamKeyboard() {
  try { navigator.keyboard?.lock?.().catch(() => {}); } catch { /* unsupported */ }
}

// Live microphone level bar so the candidate can see the mic is working. Drawn
// via a ref (no React re-render per frame). Nothing is recorded.
function MicLevel({ stream, context }) {
  const barRef = useRef(null);
  useEffect(() => {
    if (!stream || !context) return undefined;
    let source, analyser, frame;
    try {
      source = context.createMediaStreamSource(stream);
      analyser = context.createAnalyser();
      analyser.fftSize = 1024;
      source.connect(analyser);
    } catch { return undefined; }
    const data = new Float32Array(analyser.fftSize || 1024);
    const draw = () => {
      analyser.getFloatTimeDomainData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
      const level = Math.min(1, Math.sqrt(sum / data.length) * 6);
      if (barRef.current) barRef.current.style.width = Math.round(level * 100) + "%";
      frame = requestAnimationFrame(draw);
    };
    draw();
    return () => {
      cancelAnimationFrame(frame);
      try { source.disconnect(); } catch { /* already disconnected */ }
    };
  }, [stream, context]);
  return (
    <span className="ies-mic-meter" aria-label="Microphone level">
      <i ref={barRef} />
    </span>
  );
}

/* ---------- pre-exam identity check (profile photo vs live webcam) ---------- */
function loadImageElement(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Could not read the image."));
    image.src = src;
  });
}

function captureStreamFrame(stream) {
  return new Promise((resolve, reject) => {
    const video = document.createElement("video");
    video.muted = true;
    video.autoplay = true;
    video.playsInline = true;
    video.srcObject = stream;
    const deadline = Date.now() + 8000;
    const finish = (fn, arg) => {
      video.pause();
      video.srcObject = null;
      fn(arg);
    };
    video.onloadeddata = async () => {
      try { await video.play(); } catch { /* autoplay may be blocked */ }
      const waitForFrame = () => {
        if (video.videoWidth > 0 && video.videoHeight > 0) {
          const canvas = document.createElement("canvas");
          canvas.width = Math.min(640, video.videoWidth);
          canvas.height = Math.round((canvas.width * video.videoHeight) / video.videoWidth);
          canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);
          finish(resolve, canvas.toDataURL("image/jpeg", 0.85));
        } else if (Date.now() > deadline) {
          finish(reject, new Error("No camera frames were received."));
        } else {
          requestAnimationFrame(waitForFrame);
        }
      };
      waitForFrame();
    };
    video.onerror = () => finish(reject, new Error("The camera preview could not be read."));
  });
}

function IdentityCheck({ cameraStream, avatarUrl, status, onChange, onAvatarUploaded, disabled }) {
  const [reference, setReference] = useState({ state: "idle", descriptor: null, message: "" });
  const [live, setLive] = useState({ state: "idle", similarity: null, distance: null, message: "" });
  const [busy, setBusy] = useState(false);
  const [uploadBusy, setUploadBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (!avatarUrl) {
      setReference({ state: "missing", descriptor: null, message: "Add a profile photo to enable identity verification." });
      return undefined;
    }
    setReference({ state: "loading", descriptor: null, message: "Reading your profile photo…" });
    (async () => {
      try {
        const faceapi = await loadFaceApi();
        const image = await loadImageElement(avatarUrl);
        const detections = await faceapi
          .detectAllFaces(image, new faceapi.TinyFaceDetectorOptions({ inputSize: 416, scoreThreshold: 0.4 }))
          .withFaceLandmarks(true)
          .withFaceDescriptors();
        if (cancelled) return;
        if (detections.length === 0) {
          setReference({ state: "error", descriptor: null, message: "No face was found in your profile photo. Upload a clear, front-facing photo." });
        } else if (detections.length > 1) {
          setReference({ state: "error", descriptor: null, message: "Your profile photo contains more than one face." });
        } else {
          setReference({ state: "ready", descriptor: detections[0].descriptor, message: "Profile photo ready." });
        }
      } catch (error) {
        if (!cancelled) setReference({ state: "error", descriptor: null, message: error.message || "Could not analyse the profile photo." });
      }
    })();
    return () => { cancelled = true; };
  }, [avatarUrl]);

  useEffect(() => {
    if (status === "verified" || status === "flagged") return;
    setLive({ state: "idle", similarity: null, distance: null, message: "" });
  }, [avatarUrl, cameraStream, status]);

  const scan = async () => {
    if (!cameraStream) {
      setLive({ state: "error", message: "Enable the webcam first." });
      return;
    }
    if (!reference.descriptor) {
      setLive({ state: "error", message: reference.message || "Your profile photo is not ready." });
      return;
    }
    setBusy(true);
    setLive({ state: "scanning", message: "Comparing your live face with the profile photo…" });
    try {
      const faceapi = await loadFaceApi();
      const shot = await captureStreamFrame(cameraStream);
      const image = await loadImageElement(shot);
      const detections = await faceapi
        .detectAllFaces(image, new faceapi.TinyFaceDetectorOptions({ inputSize: 416, scoreThreshold: 0.4 }))
        .withFaceLandmarks(true)
        .withFaceDescriptors();
      if (detections.length === 0) throw new Error("No face detected. Face the camera in good light and try again.");
      if (detections.length > 1) throw new Error("More than one face is visible. Only you should be in the frame.");
      const distance = faceapi.euclideanDistance(reference.descriptor, detections[0].descriptor);
      const similarity = Math.max(0, Math.min(100, Math.round((1 - distance) * 100)));
      const match = distance <= 0.6;
      setLive({
        state: match ? "match" : "mismatch",
        similarity,
        distance,
        message: match
          ? "Live face matches your profile photo."
          : "Live face does not match your profile photo closely enough.",
      });
      onChange({
        status: match ? "verified" : "flagged",
        similarity,
        distance: Number(distance.toFixed(3)),
        reason: match ? "face_match" : "face_distance_above_threshold",
      });
    } catch (error) {
      setLive({ state: "error", message: error.message || "Identity check could not run." });
      onChange({ status: "pending", similarity: null, distance: null, reason: "identity_check_failed" });
    } finally {
      setBusy(false);
    }
  };

  // Run the comparison automatically as soon as the camera and the profile
  // photo are both ready (models are preloaded), retrying a couple of times
  // while the candidate settles in front of the camera. Manual "Scan again"
  // stays available.
  const scanRef = useRef(scan);
  scanRef.current = scan;
  const autoTries = useRef(0);
  useEffect(() => { autoTries.current = 0; }, [cameraStream, avatarUrl]);
  useEffect(() => {
    if (disabled || busy || !cameraStream || reference.state !== "ready") return undefined;
    if (status === "verified" || status === "flagged") return undefined;
    if (!["idle", "error"].includes(live.state) || autoTries.current >= 3) return undefined;
    const timer = setTimeout(() => {
      autoTries.current += 1;
      scanRef.current();
    }, autoTries.current === 0 ? 700 : 2000);
    return () => clearTimeout(timer);
  }, [disabled, busy, cameraStream, reference.state, status, live.state]);

  const uploadPhoto = async (file) => {
    if (!file) return;
    setUploadBusy(true);
    try {
      const form = new FormData();
      form.append("file", file);
      await api("/candidate/avatar", { method: "POST", form });
      await onAvatarUploaded?.();
    } catch (error) {
      setReference({ state: "error", descriptor: null, message: error.message || "Could not upload the profile photo." });
    } finally {
      setUploadBusy(false);
    }
  };

  const ready = reference.state === "ready";
  return (
    <div className={"identity-check" + (live.state === "match" ? " ok" : live.state === "mismatch" ? " warn" : "")}>
      <header className="identity-check-head">
        <span className="eyebrow">Identity check</span>
        <strong>Match your live face to your profile photo</strong>
        <span>Runs entirely in this browser. No biometric template is stored.</span>
      </header>
      <div className="identity-check-body">
        <div className="identity-photo">
          {avatarUrl ? (
            <img src={avatarUrl} alt="Profile photo" />
          ) : (
            <span className="identity-photo-empty">No profile photo</span>
          )}
          <small>Profile photo</small>
          {!avatarUrl && (
            <label className={"identity-upload" + (uploadBusy ? " busy" : "")}>
              {uploadBusy ? "Uploading…" : "Upload photo"}
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp"
                disabled={uploadBusy}
                onChange={(e) => uploadPhoto(e.target.files?.[0])}
              />
            </label>
          )}
        </div>
        <div className="identity-actions">
          <p className={"identity-state " + live.state}>
            {live.state === "scanning" && "Scanning…"}
            {live.state === "match" && `Match ${live.similarity}% · distance ${live.distance?.toFixed?.(3) ?? live.distance}`}
            {live.state === "mismatch" && `Mismatch ${live.similarity}% · distance ${live.distance?.toFixed?.(3) ?? live.distance}`}
            {live.state === "error" && live.message}
            {(live.state === "idle") && (cameraStream && reference.state === "ready" ? "Look at the camera — checking automatically…" : (reference.message || "Enable the webcam, then scan your face."))}
          </p>
          <button
            type="button"
            className="btn"
            onClick={scan}
            disabled={disabled || busy || !ready || !cameraStream}
          >
            {busy ? "Checking…" : live.state === "match" ? "Scan again" : "Scan my face"}
          </button>
          {reference.state === "loading" && <small>Loading face recognition models…</small>}
          {reference.state === "missing" && <small>Identity verification needs a profile photo. Upload one above.</small>}
          {reference.state === "error" && <small className="err">{reference.message}</small>}
        </div>
      </div>
    </div>
  );
}

function Exam({ kind, st, refresh, afterResult, afterLabel }) {
  const t = useT();
  const [active, setActive] = useState(null);
  const [err, setErr] = useState(null);
  const [banner, setBanner] = useState("");
  const [screenStream, setScreenStream] = useState(null);
  const [finishedId, setFinishedId] = useState(null);
  const [shareReady, setShareReady] = useState(false);
  const [fullscreenReady, setFullscreenReady] = useState(Boolean(document.fullscreenElement));
  const [setupBusy, setSetupBusy] = useState(false);
  const [online, setOnline] = useState(navigator.onLine);
  const initialMode = kind === "pre";
  const [jobDept, setJobDept] = useState("CS/IT");
  const [jobSkills, setJobSkills] = useState([]);
  const [showAllSkills, setShowAllSkills] = useState(false);
  const mobileDevice = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
  const browserSupported = Boolean(navigator.mediaDevices?.getDisplayMedia && document.documentElement.requestFullscreen);
  const done = st.attempts
    .filter((a) => a.status === "done")
    .sort((a, b) => (a.finished || 0) - (b.finished || 0));
  const latestDone = done.length ? done[done.length - 1] : null;
  const mine = finishedId ? { id: finishedId } : initialMode ? latestDone : null;
  const act = st.attempts.find((a) => a.status === "active");
  const proctoringPolicy = act?.proctoring || st.proctoring_policy || {};
  const proctored = isProctored(proctoringPolicy);
  const [proctoringConsent, setProctoringConsent] = useState(false);
  const devices = useExamDevices(proctored && proctoringConsent);
  const avatarUrl = useAvatar(proctored && proctoringConsent && st.has_avatar, st.avatar_updated, st.user?.email || "");
  const [identityResult, setIdentityResult] = useState({ status: "pending" });
  const [identityAck, setIdentityAck] = useState(false);
  const identityReady = identityResult.status === "verified" || identityAck;
  useEffect(() => {
    setIdentityResult({ status: "pending" });
    setIdentityAck(false);
  }, [devices.camera, avatarUrl]);
  // Start downloading and warming the on-device AI models the moment the verify
  // page opens, in parallel with the candidate reading the consent and granting
  // permissions. Only model files load here; no media is captured.
  const modelStatus = useProctorModelStatus();
  // Every model (face/phone detection and the face-identity model) is always
  // loaded, because the candidate may add a profile photo on this page.
  useEffect(() => {
    preloadProctorModels({ identity: true });
  }, []);

  useEffect(() => {
    const syncNetwork = () => setOnline(navigator.onLine);
    window.addEventListener("online", syncNetwork);
    window.addEventListener("offline", syncNetwork);
    return () => {
      window.removeEventListener("online", syncNetwork);
      window.removeEventListener("offline", syncNetwork);
    };
  }, []);

  // Keep the setup status in sync if the candidate exits full-screen.
  useEffect(() => {
    const syncFullscreen = () => setFullscreenReady(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", syncFullscreen);
    return () => document.removeEventListener("fullscreenchange", syncFullscreen);
  }, []);

  // Reflect when the candidate stops screen sharing from the browser toolbar.
  useEffect(() => {
    const track = screenStream?.getVideoTracks()[0];
    if (!track) {
      setShareReady(false);
      return;
    }
    const syncShare = () => setShareReady(track.readyState === "live");
    syncShare();
    // Some browsers report the track state a tick after the picker closes.
    const timer = setInterval(syncShare, 1000);
    track.addEventListener("ended", syncShare);
    track.addEventListener("mute", syncShare);
    track.addEventListener("unmute", syncShare);
    return () => {
      clearInterval(timer);
      track.removeEventListener("ended", syncShare);
      track.removeEventListener("mute", syncShare);
      track.removeEventListener("unmute", syncShare);
    };
  }, [screenStream]);

  // Re-read browser state after the candidate returns from a permission picker
  // or exits/enters full-screen. This prevents a stale "not active" step.
  const resyncPermissions = useCallback(() => {
    setShareReady(Boolean(screenStream?.getVideoTracks().some((track) => track.readyState === "live")));
    setFullscreenReady(Boolean(document.fullscreenElement));
  }, [screenStream]);
  useEffect(() => {
    const sync = () => resyncPermissions();
    window.addEventListener("focus", sync);
    document.addEventListener("visibilitychange", sync);
    return () => {
      window.removeEventListener("focus", sync);
      document.removeEventListener("visibilitychange", sync);
    };
  }, [resyncPermissions]);

  // Stop a pending screen capture if the candidate leaves the setup screen.
  useEffect(() => () => {
    screenStream?.getTracks().forEach((track) => track.stop());
  }, [screenStream]);

  // Ask for screen sharing in its own click so the browser can show its picker.
  const enableScreenShare = async () => {
    if (proctored && !proctoringConsent) return;
    setErr(null);
    try {
      if (!navigator.mediaDevices?.getDisplayMedia) throw new Error(t("shareUnsupported"));
      const requestedStream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: 5 },
        audio: false,
      });
      const videoTrack = requestedStream.getVideoTracks()[0];
      if (proctored && videoTrack?.getSettings?.().displaySurface !== "monitor") {
        requestedStream.getTracks().forEach((track) => track.stop());
        throw new Error("Share your entire screen. Choose Entire screen in the browser picker, not a tab or window.");
      }
      if (!videoTrack) {
        requestedStream.getTracks().forEach((track) => track.stop());
        throw new Error("The browser did not return a screen video track. Choose a screen or window and try again.");
      }
      setScreenStream(requestedStream);
      setShareReady(videoTrack.readyState === "live");
    } catch (e) {
      setShareReady(false);
      setErr(e?.name === "NotAllowedError" ? new Error(t("sharePermissionDenied")) : e);
    }
  };

  // Full-screen must be requested directly from a separate user click.
  const enableFullscreen = async () => {
    setErr(null);
    try {
      if (!document.documentElement.requestFullscreen) throw new Error(t("fullscreenUnsupported"));
      await document.documentElement.requestFullscreen();
      setFullscreenReady(Boolean(document.fullscreenElement));
      if (!document.fullscreenElement) throw new Error(t("fullscreenRequired"));
      lockExamKeyboard();
    } catch (e) {
      setFullscreenReady(Boolean(document.fullscreenElement));
      setErr(e?.name === "NotAllowedError"
        ? new Error(t("fullscreenClickAgain"))
        : new Error(e.message || t("fullscreenUnsupported")));
    }
  };
  const restartShare = async () => {
    try {
      if (!navigator.mediaDevices?.getDisplayMedia)
        throw new Error(t("shareUnsupported"));
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: 5 },
        audio: false,
      });
      if (proctored && stream.getVideoTracks()[0]?.getSettings?.().displaySurface !== "monitor") {
        stream.getTracks().forEach((track) => track.stop());
        throw new Error("Select Entire screen to restore exam monitoring.");
      }
      // The exam integrity monitor detects the fresh stream and re-asserts the
      // `screen_share_started` event with its own sequence, so the server guard
      // and the on-screen status stay in sync without a sequence conflict.
      setScreenStream(stream);
      setShareReady(true);
      setErr(null);
      return stream;
    } catch (e) {
      setErr(new Error(e.message || t("shareRequired")));
      return null;
    }
  };
  const start = useCallback(async () => {
    setErr(null);
    const sharing = screenStream?.getVideoTracks().some((track) => track.readyState === "live");
    const fullscreen = Boolean(document.fullscreenElement);
    setShareReady(Boolean(sharing));
    setFullscreenReady(fullscreen);
    const missing = [];
    if (mobileDevice) missing.push("a supported desktop browser");
    if (!browserSupported) missing.push("browser support for screen sharing and full-screen");
    if (!navigator.onLine) missing.push("a network connection");
    if (!sharing) missing.push("screen sharing");
    if (!fullscreen) missing.push("full-screen mode");
    if (proctored) {
      if (modelStatus.vision !== "ready") missing.push("AI models loaded");
      if (!proctoringConsent) missing.push("monitoring consent");
      if (!devices.cameraReady || !trackLive(devices.camera)) missing.push("camera with live frames");
      if (!devices.microphoneReady || !trackLive(devices.microphone, "audio")) missing.push("microphone and sound-level monitoring");
      if (!identityReady) missing.push("identity comparison or manual-review acknowledgement");
    }
    if (missing.length) {
      setErr(new Error("Cannot start yet: " + missing.join(", ") + "."));
      return;
    }
    setSetupBusy(true);
    setBanner("");
    try {
      // Resume the saved attempt directly; never build or substitute an exam.
      // Returns a ready blueprint id, or null after explaining the shortage.
      const makeBlueprint = async () => {
        if (initialMode) {
          const bp = await api("/assessment/initial-blueprint", {
            method: "POST",
            body: { department: jobDept, requested_skill_ids: jobSkills },
          });
          if (!bp || bp.status !== "ready") {
            setBanner(
              (bp?.message || "The Initial exam needs more approved questions. No questions were fabricated.") +
                (bp?.shortages?.length ? " Gaps: " + bp.shortages.map((gap) => `${gap.topic || gap.section}: ${gap.available ?? 0}/${gap.required ?? "?"}`).join("; ") + "." : ""),
            );
            return null;
          }
          return bp.blueprint_id;
        }
        const bp = await api("/assessment/blueprint", { method: "POST" });
        if (bp && bp.status === "ready") {
          if (bp.uncovered_skills?.length) {
            setBanner(
              "Some confirmed skills have no approved practice questions yet: " +
                bp.uncovered_skills.map((x) => x.label).join(", ") +
                ". The assessment will cover the available skills.",
            );
          }
          return bp.blueprint_id;
        }
        setBanner(bp?.message || "The Profile retake needs more approved questions. Ask an admin to complete the bank.");
        return null;
      };
      let blueprintId = null;
      if (!act) {
        blueprintId = await makeBlueprint();
        if (!blueprintId) return;
      }
      if (!document.fullscreenElement || !screenStream?.getVideoTracks().some((track) => track.readyState === "live")) {
        resyncPermissions();
        throw new Error("Screen sharing or full-screen stopped during setup. Restore both steps, then start again.");
      }
      const startAttempt = (id) => api("/attempts", {
        method: "POST",
        body: {
          ...(act ? { resume_attempt_id: act.id } : { blueprint_id: id }),
          ...(proctored ? { proctoring_consent: proctoringPolicy.consent_version,
            proctoring_ready: { screen: Boolean(sharing), fullscreen, camera: devices.cameraReady, microphone: devices.microphoneReady },
            identity_status: identityResult.status === "verified" ? "verified" : "needs_review" } : {}),
        },
      });
      let v;
      try {
        v = await startAttempt(blueprintId);
      } catch (startError) {
        // The saved blueprint includes questions this candidate has already
        // seen: build a fresh one once and retry.
        if (act || errorCode(startError) !== "blueprint_contains_seen_questions") throw startError;
        blueprintId = await makeBlueprint();
        if (!blueprintId) return;
        v = await startAttempt(blueprintId);
      }
      if (v.status === "active") {
        let seq = v.last_event_seq || 0;
        const bootstrap = [{ type: trackLive(screenStream) ? "screen_share_started" : "screen_share_stopped", metadata: { surface: screenStream.getVideoTracks()[0]?.getSettings?.().displaySurface || "unknown" } }];
        if (proctored) bootstrap.push({ type: document.fullscreenElement ? "fullscreen_enter" : "fullscreen_exit" },
          { type: trackLive(devices.camera) ? "camera_started" : "camera_stopped" },
          { type: trackLive(devices.microphone, "audio") && devices.audioContext?.state === "running" ? "microphone_started" : "microphone_stopped" },
          { type: identityResult.status === "verified" ? "identity_verified" : identityResult.status === "flagged" ? "identity_mismatch" : "identity_skipped", metadata: { local_only: true, model: "face-api", reason: "advisory_identity_check" } });
        for (const event of bootstrap) await api(`/attempts/${v.attempt_id}/event`, { method: "POST", body: { ...event, session_id: v.session_id, seq: ++seq, client_ts: Date.now() } });
        setActive({ ...v, last_event_seq: seq });
      } else {
        screenStream?.getTracks().forEach((track) => track.stop());
        setScreenStream(null);
        if (v.status === "done") setFinishedId(v.attempt_id);
        if (document.fullscreenElement) await document.exitFullscreen().catch(() => {});
        await refresh();
      }
    } catch (e) {
      setErr(e);
    } finally {
      setSetupBusy(false);
    }
  }, [refresh, screenStream, mobileDevice, browserSupported, act, initialMode, jobDept, jobSkills, resyncPermissions, proctored, proctoringConsent, devices, identityReady, identityResult.status, proctoringPolicy.consent_version, modelStatus.vision]);
  const finished = async (aid, status = "done") => {
    if (status === "done") setFinishedId(aid || active?.attempt_id);
    screenStream?.getTracks().forEach((track) => track.stop());
    devices.stop();
    setScreenStream(null);
    setActive(null);
    if (document.fullscreenElement && document.exitFullscreen)
      document.exitFullscreen().catch(() => {});
    await refresh();
  };

  if (active) return <ExamRun initial={active} screenStream={screenStream} onFinished={finished} onRestartShare={restartShare}
    cameraStream={proctored ? devices.camera : undefined} micStream={proctored ? devices.microphone : undefined}
    audioContext={devices.audioContext} devicesReady={!proctored || (devices.cameraReady && devices.microphoneReady)}
    onRestartCamera={devices.enableCamera} onRestartMic={devices.enableMicrophone} />;
  // Ordered exactly as the candidate should complete them: full-screen is last
  // because opening the screen-share picker can drop full-screen.
  const setupRequirements = [
    { id: "desktop", label: "Desktop device", ok: !mobileDevice },
    { id: "browser", label: "Browser support", ok: browserSupported },
    { id: "network", label: "Network", ok: online },
    ...(proctored ? [
      // The live face/phone monitor must be loaded before the exam can start,
      // so the exam page itself never waits on a model download.
      { id: "models", label: "AI models loaded", ok: modelStatus.vision === "ready" },
      { id: "consent", label: "Monitoring consent", ok: proctoringConsent },
      { id: "camera", label: "Camera", ok: devices.cameraReady },
      { id: "microphone", label: "Microphone", ok: devices.microphoneReady },
      { id: "identity", label: "Identity / manual review", ok: identityReady },
    ] : []),
    { id: "share", label: "Screen sharing", ok: shareReady },
    { id: "fullscreen", label: "Full-screen", ok: fullscreenReady },
  ];
  const setupMissing = setupRequirements.filter((item) => !item.ok).map((item) => item.label);
  const nextStep = setupRequirements.find((item) => !item.ok)?.id || null;
  const checklist = setupRequirements.filter((item) => !["desktop", "browser", "network", "models"].includes(item.id));
  const modelChip = (state, label) => state === "ready" ? { cls: "ok", text: `${label} ready` }
    : state === "error" ? { cls: "bad", text: `${label} failed to load` }
      : { cls: "", text: `Loading ${label.toLowerCase()}…` };
  const aiModels = !proctored ? [] : [
    { id: "vision", ...modelChip(modelStatus.vision, "Face & phone detection") },
    { id: "identity", ...modelChip(modelStatus.identity, "Face verification model") },
  ];
  const modelsFailed = aiModels.some((item) => item.cls === "bad");
  const skillOptions = (() => {
    const options = new Map();
    (st.profile_skill_items || []).forEach((skill) => {
      const id = skill.id || skill.skill_id;
      if (id) options.set(id, skill.label || skill.name || id);
    });
    (st.confirmed || []).forEach((id) => {
      if (!options.has(id)) options.set(id, String(id).replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()));
    });
    return [...options.entries()];
  })();
  const visibleSkills = showAllSkills ? skillOptions : skillOptions.slice(0, 4);
  const progressSteps = ["Profile", "Initial Exam", "Gap", "Learn", "Profile Retake", "Passport"];
  const currentStep = initialMode ? 1 : 4;
  const cameraPerm = { id: "camera", icon: "🎥", title: "Camera", hint: "Used for the identity check and on-device monitoring.", done: devices.cameraReady,
    actionLabel: devices.cameraReady ? "Camera active" : "Enable camera", onAction: devices.enableCamera,
    disabled: !proctoringConsent || devices.busy || setupBusy };
  const micPerm = { id: "microphone", icon: "🎙️", title: "Microphone", hint: "Local sound-level check only; audio is never recorded.", done: devices.microphoneReady,
    actionLabel: devices.microphoneReady ? "Microphone active" : "Enable microphone", onAction: devices.enableMicrophone,
    disabled: !proctoringConsent || devices.busy || setupBusy,
    extra: devices.microphoneReady ? <MicLevel stream={devices.microphone} context={devices.audioContext} /> : null };
  const sharePerm = { id: "share", icon: "🖥️", title: "Screen sharing", hint: proctored ? "Choose “Entire screen” in the browser picker." : "The screen stream is not recorded or uploaded; only event counts are saved.", done: shareReady,
    actionLabel: shareReady ? t("shareActive") : t("restartShare"), onAction: enableScreenShare, disabled: setupBusy || (proctored && !proctoringConsent) };
  const fullscreenPerm = { id: "fullscreen", icon: "⛶", title: "Full-screen mode", hint: "Do this last. Leaving full-screen or switching tabs pauses the exam.", done: fullscreenReady,
    actionLabel: fullscreenReady ? t("fullscreenActive") : t("restartFullscreen"), onAction: enableFullscreen, disabled: setupBusy };
  const renderPerm = (item) => (
    <div className={"ies-perm" + (item.done ? " done" : "") + (nextStep === item.id ? " next" : "")} key={item.id} id={"ies-step-" + item.id}>
      <span className="ies-perm-icon" aria-hidden="true">{item.icon}</span>
      <div className="ies-perm-text">
        <b>{item.title}</b><span>{item.hint}</span>
        {item.extra}
      </div>
      {item.done
        ? <button type="button" className="ies-pill" disabled>{item.actionLabel}</button>
        : <button type="button" className="ies-perm-btn" onClick={item.onAction} disabled={item.disabled}>{item.actionLabel}</button>}
    </div>
  );
  const identityState = identityResult.status === "verified"
    ? { cls: "ok", mark: "✓", title: "Face verified", body: "Your face is clearly visible and matches your profile photo." }
    : identityAck
      ? { cls: "warn", mark: "!", title: "Manual review acknowledged", body: "A human reviewer will check your identity. This is not an automatic rejection." }
      : { cls: "", mark: "◉", title: "Identity check pending", body: devices.cameraReady ? "The face check runs automatically. You can also acknowledge manual review." : "Enable the camera to start the face comparison." };
  const renderSetup = ({ resume, title, intro, primaryLabel }) => (
    <section className="ies">
      <div className="ies-main">
        <article className="ies-card">
          <div className="ies-card-head">
            <span className="ies-card-icon" aria-hidden="true">📋</span>
            <div>
              <span className="ies-kicker">System check</span>
              <h2>{title}</h2>
              <p>{intro}</p>
            </div>
          </div>
          <div className="ies-chips">
            <span className={"ies-chip " + (mobileDevice ? "bad" : "ok")}>{!mobileDevice && <i aria-hidden="true">✓</i>}{mobileDevice ? "✕ Desktop device required" : "Desktop device"}</span>
            <span className={"ies-chip " + (browserSupported ? "ok" : "bad")}>{browserSupported && <i aria-hidden="true">✓</i>}{browserSupported ? "Browser supported" : "Screen sharing/full-screen unsupported"}</span>
            <span className={"ies-chip " + (online ? "ok" : "bad")}>{online && <i aria-hidden="true">✓</i>}{online ? "Network stable" : "Network offline"}</span>
            {aiModels.map((item) => (
              <span key={item.id} className={"ies-chip " + item.cls} role="status">
                {item.cls === "ok" ? <i aria-hidden="true">✓</i> : item.cls === "" ? <i className="ies-spin" aria-hidden="true" /> : null}{item.text}
              </span>
            ))}
            {modelsFailed && (
              <button type="button" className="ies-chip-retry" onClick={() => preloadProctorModels({ identity: true })}>
                Retry loading models
              </button>
            )}
          </div>
          <div className="ies-alert">
            <span aria-hidden="true">i</span>
            <div>
              <b>Important Instructions</b>
              <p>
                {proctored
                  ? "Complete the steps below in order. Keep your face visible during the exam. Copy, paste and tab switching are blocked; leaving the exam pauses it."
                  : "Allow screen sharing and full-screen. Keep sharing active until you submit or quit. Copy, paste and tab switching are blocked during the exam."}
              </p>
            </div>
          </div>
        </article>

        {proctored && (
          <article className={"ies-card ies-consent" + (proctoringConsent ? " done" : " next")} id="ies-step-consent">
            <div className="ies-card-head">
              <span className="ies-card-icon" aria-hidden="true"><WorkspaceIcon name="integrity" size={20} /></span>
              <div>
                <span className="ies-kicker">STEP 1</span>
                <h3>Monitoring Consent</h3>
                <p>Explicit consent is required before camera, microphone or screenshot capture can start.</p>
              </div>
            </div>
            <p>
              Local AI detects missing/multiple faces and possible phones. A local sound-level detector
              flags sustained noise—not words or speaker identity. Face comparison is advisory and may
              be referred to manual review. No continuous video, raw audio or biometric templates are
              stored, and no frames are sent to external AI providers.
            </p>
            <p>
              Flag-triggered camera and screen JPEG snapshots are kept for authorized reviewers for
              {" "}{proctoringPolicy.retention_days} days (max {proctoringPolicy.max_snapshots} snapshots).
              Event times, numerical observations and review notes stay until account deletion. You can
              export/delete your data at any time. Focus changes are logged. Flags never automatically fail you.
            </p>
            <label className="ies-check">
              <input type="checkbox" checked={proctoringConsent} onChange={(event) => setProctoringConsent(event.target.checked)} disabled={setupBusy} />
              I consent to this exam monitoring and time-limited screenshot storage.
            </label>
          </article>
        )}

        {proctored && (
          <article className="ies-card">
            <div className="ies-card-head">
              <span className="ies-card-icon" aria-hidden="true">🎥</span>
              <div>
                <span className="ies-kicker">STEP 2</span>
                <h3>Camera &amp; Microphone</h3>
                <p>{proctoringConsent ? "Allow access when the browser asks. The live preview confirms the AI can see you." : "Give consent above to unlock these."}</p>
              </div>
            </div>
            <div className="ies-perms">
              {renderPerm(cameraPerm)}
              {renderPerm(micPerm)}
            </div>
            {devices.cameraReady && (
              <div className="ies-live-preview">
                <LocalProctor cameraStream={devices.camera} report={noopReport} inline />
              </div>
            )}
            {devices.error && <p className="err" role="alert" style={{ marginTop: 10 }}>{devices.error}</p>}
          </article>
        )}

        {proctored && proctoringConsent && (
          <article className="ies-card" id="ies-step-identity">
            <div className="ies-card-head">
              <span className="ies-card-icon" aria-hidden="true">🪪</span>
              <div>
                <span className="ies-kicker">STEP 3</span>
                <h3>Identity Verification</h3>
                <p>Your live face is compared with your profile photo automatically. Comparison runs only in this browser.</p>
              </div>
            </div>
            <div className="ies-identity-grid ies-identity-single">
              <IdentityCheck
                cameraStream={devices.camera}
                avatarUrl={avatarUrl}
                status={identityResult.status}
                onChange={setIdentityResult}
                onAvatarUploaded={refresh}
                disabled={setupBusy}
              />
            </div>
            <div className={"ies-verified " + identityState.cls} style={{ marginTop: 14 }}>
              <span aria-hidden="true">{identityState.mark}</span>
              <div><b>{identityState.title}</b>{identityState.body}</div>
            </div>
            {identityResult.status !== "verified" && (
              <label className="ies-check" style={{ marginTop: 12 }}>
                <input type="checkbox" checked={identityAck} onChange={(event) => setIdentityAck(event.target.checked)} />
                If the comparison is unavailable or does not match, I acknowledge referral to human identity review; this is not an automatic rejection.
              </label>
            )}
          </article>
        )}

        <article className="ies-card">
          <div className="ies-card-head">
            <span className="ies-card-icon" aria-hidden="true">🖥️</span>
            <div>
              {proctored && <span className="ies-kicker">STEP 4</span>}
              <h3>Screen Sharing &amp; Full-screen</h3>
              <p>Share your screen first, then enter full-screen.</p>
            </div>
          </div>
          <div className="ies-perms">
            {renderPerm(sharePerm)}
            {renderPerm(fullscreenPerm)}
          </div>
        </article>

        <article className="ies-brief">
          <div className="ies-brief-head">
            <span className="ies-brief-icon" aria-hidden="true">🕐</span>
            <div className="ies-brief-title">
              <b>{initialMode ? "Initial Exam: CV + Fundamentals · 40 Minutes" : "Profile Retake Exam"}</b>
              <span>
                {initialMode
                  ? "40 questions: 20 fundamental, 16 CV-skill questions and 4 project/scenario probes."
                  : "25 fundamentals plus 5 questions per covered confirmed CV skill. Duration is set from the selected questions."}
              </span>
            </div>
            {initialMode && <span className="ies-brief-badge">{jobSkills.length}/5 skills selected</span>}
          </div>
          {initialMode && (
            <div className="ies-brief-body">
              <label>
                <span>Department</span>
                <select value={jobDept} onChange={(e) => setJobDept(e.target.value)} disabled={setupBusy}>
                  <option value="CS/IT">CS/IT</option>
                </select>
              </label>
              <div>
                <div className="ies-skill-head"><b>Skills you want verified (optional)</b><span style={{ fontSize: 11, color: "#9db8d8" }}>Confirmed from your profile</span></div>
                <div className="ies-skill-chips">
                  {visibleSkills.map(([id, label]) => {
                    const on = jobSkills.includes(id);
                    const full = jobSkills.length >= 5 && !on;
                    return (
                      <button
                        key={id}
                        type="button"
                        className={"ies-skill-chip" + (on ? " on" : "")}
                        disabled={setupBusy || full}
                        onClick={() => setJobSkills((prev) => prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id])}
                      >
                        {on ? "✓ " : ""}{label}
                      </button>
                    );
                  })}
                  {skillOptions.length > 4 && (
                    <button type="button" className="ies-skill-more" onClick={() => setShowAllSkills((value) => !value)} disabled={setupBusy}>
                      {showAllSkills ? "Show less" : "+ Add more"}
                    </button>
                  )}
                  {!skillOptions.length && <span style={{ fontSize: 11.5, color: "#9db8d8" }}>Confirm skills on your profile to prioritize them here.</span>}
                </div>
              </div>
            </div>
          )}
        </article>

        {banner
          ? <p className="ies-ready warn" role="status"><span aria-hidden="true">i</span>{banner}</p>
          : setupMissing.length
            ? <p className="ies-ready warn" role="status"><span aria-hidden="true">i</span>Still required: {setupMissing.join(", ")}.</p>
            : <p className="ies-ready" role="status"><span aria-hidden="true">✓</span>{initialMode ? "All required permissions are granted. The approved question bank is ready — you can start now." : "All checks passed. You can start your retake now."}</p>}

        <Err e={err} />
        <div className="ies-actions">
          <button type="button" className="ies-primary" onClick={start} disabled={setupBusy || setupMissing.length > 0}>
            <span className="ies-play" aria-hidden="true">▶</span>
            {setupBusy ? t("saving") : primaryLabel}
            <span aria-hidden="true">→</span>
          </button>
          <button type="button" className="ies-ghost" onClick={resyncPermissions} disabled={setupBusy}>
            <span aria-hidden="true">↻</span> Re-check Permissions
          </button>
        </div>
        <p className="ies-fineprint">
          {resume
            ? (proctored ? "Camera, microphone, screen sharing and full-screen are required to resume. Your original exam deadline is unchanged." : "Enable screen sharing and full-screen to resume your saved exam. Answers and the original deadline are kept.")
            : (proctored ? "Camera, microphone, entire-screen sharing and full-screen are required throughout the exam. Signals are advisory evidence for human review." : "Only screen sharing and full-screen are required. No camera, face check or microphone is used.")}
        </p>
      </div>

      <aside className="ies-side">
        <article className="ies-card">
          <div className="ies-tips-head"><span aria-hidden="true">☑</span><b>Setup checklist</b></div>
          <ol className="ies-checklist">
            {checklist.map((item) => (
              <li key={item.id} className={item.ok ? "done" : nextStep === item.id ? "current" : ""}>
                <button type="button" onClick={() => document.getElementById("ies-step-" + item.id)?.scrollIntoView({ behavior: "smooth", block: "center" })}>
                  <i aria-hidden="true">{item.ok ? "✓" : ""}</i>{item.label}
                </button>
              </li>
            ))}
          </ol>
        </article>
        <article className="ies-card">
          <div className="ies-tips-head"><span aria-hidden="true"><WorkspaceIcon name="info" size={18} /></span><b>Quick tips</b></div>
          <ul className="ies-tips">
            <li><i aria-hidden="true">✓</i>Use a modern desktop browser (Chrome, Edge, or Firefox).</li>
            {proctored && <li><i aria-hidden="true">✓</i>Allow camera, microphone, entire-screen sharing and full-screen.</li>}
            {!proctored && <li><i aria-hidden="true">✓</i>Allow screen sharing and stay in full-screen.</li>}
            {proctored && <li><i aria-hidden="true">✓</i>Keep your face visible at all times.</li>}
            <li><i aria-hidden="true">✓</i>Do not switch tabs or open other apps.</li>
          </ul>
          <button type="button" className="ies-help" onClick={() => document.getElementById("candidate-content")?.scrollIntoView({ behavior: "smooth" })}>Need help? <span aria-hidden="true">↗</span></button>
        </article>

        <article className="ies-card">
          <div className="ies-progress-head">
            <span aria-hidden="true">📈</span>
            <div><b>Your Progress</b><small>Step {currentStep + 1} of 6</small></div>
          </div>
          <div className="ies-dots" aria-hidden="true">
            {progressSteps.map((step, index) => (
              <span key={step} style={{ display: "contents" }}>
                <b className={index < currentStep ? "done" : index === currentStep ? "current" : ""} />
                {index < progressSteps.length - 1 && <i className={index < currentStep ? "done" : ""} />}
              </span>
            ))}
          </div>
          <ul className="ies-progress-list">
            <li className="done"><i aria-hidden="true">✓</i>Profile completed</li>
            <li className="current"><i aria-hidden="true">●</i>{progressSteps[currentStep]} (current)</li>
            <li className="pending"><i aria-hidden="true">○</i>{progressSteps[currentStep + 1] || "Passport"}</li>
          </ul>
        </article>

        <article className={"ies-allset" + (setupMissing.length ? " warn" : "")}>
          <div className="ies-allset-head"><span aria-hidden="true">{setupMissing.length ? "!" : "✓"}</span><b>{setupMissing.length ? "Almost ready" : "You're all set!"}</b></div>
          <p>
            {setupMissing.length
              ? `Complete ${setupMissing.length} remaining step${setupMissing.length === 1 ? "" : "s"}: ${setupMissing.join(", ")}.`
              : `All required permissions are granted. You can now start your ${initialMode ? "Initial Exam" : "retake"} with confidence.`}
          </p>
        </article>
      </aside>
    </section>
  );;
  if (act) return renderSetup({
    resume: true,
    title: initialMode ? "Resume Initial Exam" : "Resume Profile Retake",
    intro: "Restore every required permission, then continue where you left off. Your saved answers and original deadline are unchanged.",
    primaryLabel: t("resume"),
  });
  if (mine) return (
    <>
      <Result aid={mine.id} next={afterResult} nextLabel={afterLabel} />
      {kind === "post" && <Uplift />}
    </>
  );
  if (kind === "post" && done.length === 0) return <p className="note">{t("needPre")}</p>;
  return renderSetup({
    resume: false,
    title: initialMode ? "Initial Exam Setup" : "Profile retake exam",
    intro: initialMode
      ? "Verify your identity, allow required permissions, and check your system before starting the exam."
      : "Check your system and permissions before starting your confidential retake.",
    primaryLabel: initialMode ? "Start Initial exam · 40 minutes" : "Start Profile retake exam",
  });
}
/* ---------- learning path ---------- */
function Learn({ onNext }) {
  const [data, setData] = useState(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState("");
  const [adviceStatus, setAdviceStatus] = useState("");
  const load = async () => {
    try {
      setData(await api("/learning/dashboard"));
      setError("");
    } catch (e) {
      setError(e.message || "Learning data could not be loaded.");
    }
  };
  useEffect(() => {
    load();
  }, []);
  useEffect(() => {
    if (!data?.based_on || data.approved || data.publication?.stage === "invalidated") return;
    const timer = setInterval(load, 15000);
    return () => clearInterval(timer);
  }, [data?.based_on, data?.approved, data?.publication?.stage]);
  const explainPlan = async () => {
    setBusy("advice");
    setAdviceStatus("");
    try {
      const response = await api("/learning/plan/explain", { method: "POST" });
      setAdviceStatus(response.message || "AI study guidance saved. Course sources and approved scores have not changed.");
      if (response.status === "available") await load();
    } catch (e) { setAdviceStatus(e.message || "Could not prepare study guidance."); }
    finally { setBusy(""); }
  };
  const update = async (resource, status) => {
    setBusy(resource.id);
    try {
      await api("/learning/resources/" + resource.id + "/progress", {
        method: "PATCH",
        body: { status },
      });
      await load();
    } catch (e) {
      setError(e.message || "Progress could not be saved.");
    } finally {
      setBusy("");
    }
  };
  const feedback = async (resource, helpful) => {
    try {
      await api("/learning/resources/" + resource.id + "/feedback", {
        method: "POST",
        body: { helpful, comment: "" },
      });
      setError("");
    } catch (e) {
      setError(e.message || "Feedback could not be saved.");
    }
  };
  if (!data)
    return (
      <div className="learn-loading">
        {error || "Building your verified learning plan…"}
      </div>
    );
  const topics = [...new Set(data.resources.map((r) => r.topic))],
    retake = data.retake || {};
  const gapsWithoutResources = (data.gap_details || []).filter(
    (gap) => !data.resources.some((resource) => resource.topic === gap.skill),
  );
  const fmt = (v) => (v ? new Date(v * 1000).toLocaleDateString() : "—");
  return (
    <section className="learn-workspace">
      <div className="learn-hero">
        <div>
          <span className="learn-kicker">Your personal development plan</span>
          <h2>Turn skill gaps into progress.</h2>
          <p>
            Your learning path retrieves reviewed courses from your approved topic scores.
            Academic and honesty approval are both required. Every plan is saved against a result revision.
          </p>
        </div>
      </div>
      <AssessmentStatus publication={data.publication} objective={data.result_summary?.objective_summary} onRefresh={load} />
      {error && (
        <div className="learn-alert" role="alert">
          {error}
        </div>
      )}
      {data.result_summary && (
        <div
          className={
            "learn-approval " + (data.approved ? "approved" : "pending")
          }
        >
          <div>
            <span className="learn-kicker">
              {data.approved ? "Verified result" : "Provisional result"}
            </span>
            <h3>
              {data.approved
                ? "Your result is approved."
                : "Your result is awaiting human review."}
            </h3>
            <p>
              {data.approved
                ? "The learning path below is now verified and your Skill Passport was created automatically."
                : "MCQ-only feedback is provisional. Recommendations appear after all academic marks and the honesty report are approved."}
            </p>
            {data.result_summary.section_scores && (
              <small className="learn-note">
                Fundamentals 60%:{" "}
                {data.result_summary.section_scores.fundamental?.score ?? "—"}%
                {" · "}CV &amp; development 40%:{" "}
                {data.result_summary.section_scores.cv?.score ?? "—"}%
              </small>
            )}
          </div>
          <div className="learn-approval-score">
            <strong>
              {data.result_summary.overall == null
                ? "—"
                : data.result_summary.overall + "%"}
            </strong>
            <small>{data.result_summary.level || "Pending review"}</small>
            {data.passport && !data.passport.revoked && (
              <span>Passport issued</span>
            )}
          </div>
        </div>
      )}
      {!!data.performance?.length && (
        <div className="learn-performance" aria-label="Exam performance by skill">
          {data.performance.map((item) => (
            <span
              className={"learn-perf " + item.status}
              key={item.skill}
              title={
                item.score == null
                  ? item.status === "not_assessed"
                    ? "Not assessed yet"
                    : "Waiting for review"
                  : `${item.score}% · ${item.status.replaceAll("_", " ")}`
              }
            >
              {item.name}{" "}
              {item.score == null
                ? item.status === "not_assessed"
                  ? "· not assessed"
                  : "· pending review"
                : `· ${item.score}%`}
            </span>
          ))}
        </div>
      )}
      <div className="learn-stats">
        <article>
          <small>Topics to strengthen</small>
          <strong>{data.based_on && !data.approved ? "Pending" : data.gaps.length}</strong>
          <span>
            {data.result_summary?.overall == null
              ? "From your latest result"
              : `After your ${data.result_summary.overall}% assessment`}
          </span>
        </article>
        <article>
          <small>Resources completed</small>
          <strong>{data.progress.completed}</strong>
          <span>{data.progress.started} in progress</span>
        </article>
        <article>
          <small>Retake credits</small>
          <strong>{retake.balance}</strong>
          <span>{retake.credit_cost} required per retake</span>
        </article>
        <article>
          <small>Attempts in 90 days</small>
          <strong>
            {retake.attempts_used_90d}/{retake.max_attempts_90d}
          </strong>
          <span>Policy-controlled limit</span>
        </article>
      </div>
      <div className="learn-section-head">
        <div>
          <span className="learn-kicker">Curated for your gaps</span>
          <h3>Recommended learning</h3>
          <p>
            Only approved curated links are shown. If no approved resource exists
            for a gap, the catalogue says so instead of inventing one.
          </p>
        </div>
        <span className="learn-verified">✓ Verified catalogue</span>
        <button className="btn ghost sm" onClick={load}>
          Refresh path
        </button>
        {data.approved && data.resources.length > 0 && <button type="button" className="btn sm" onClick={explainPlan} disabled={Boolean(busy)}>{busy === "advice" ? "Preparing guidance…" : "Explain my study plan with AI"}</button>}
      </div>
      {adviceStatus && <p className="note" role="status">{adviceStatus}</p>}
      {data.learning_plan?.ai_advice && <section className="card learning-ai-advice"><h3>Source-grounded study guidance</h3><p className="muted">AI explanation · {data.learning_plan.ai_advice.provider}/{data.learning_plan.ai_advice.model} · does not change scores or course sources.</p>{data.learning_plan.ai_advice.recommendations.map((item) => { const source = data.resources.find((resource) => String(resource.id) === item.resource_id); return source ? <p key={item.resource_id}><strong>{source.title}</strong> — {item.reason} <a href={source.url} target="_blank" rel="noreferrer">[Source {item.resource_id}]</a></p> : null; })}</section>}
      {!topics.length ? (
        <div className="learn-empty">
          <b>
            {data.based_on && !data.approved ? "Your personalized plan is awaiting both approvals." : data.based_on
              ? "Your current skill gaps are covered."
              : "Start with a skill assessment."}
          </b>
          <p>
            {data.based_on && !data.approved ? "The system will not recommend courses from an incomplete or unapproved score. Use Refresh status to check the academic and honesty reviews." : data.gaps.length
              ? "There are skill gaps, but no curator-verified resources are currently available for them. Check back after the catalogue is reviewed."
              : data.based_on
                ? "Your latest result did not identify any priority gaps."
                : "Complete your first assessment to receive recommendations matched to your topic scores."}
          </p>
        </div>
      ) : (
        topics.map((topic) => (
          <section className="learn-topic" key={topic}>
            <header>
              <div>
                <span>Skill gap</span>
                <h4>{data.gap_labels?.[topic] || topic.replaceAll("_", " ")}</h4>
              </div>
              <small>
                {data.resources.filter((r) => r.topic === topic).length}{" "}
                verified resources
              </small>
            </header>
            <div className="learn-resource-grid">
              {data.resources
                .filter((r) => r.topic === topic)
                .map((r) => (
                  <article className="learn-resource" key={r.id}>
                    <div className="learn-resource-top">
                      <span className="learn-resource-icon" aria-hidden="true"><WorkspaceIcon name="learning" size={18} /></span>
                      <span className="learn-resource-level">
                        Level {r.level}
                      </span>
                    </div>
                    <h5>{r.title}</h5>
                    <p>
                      {r.provider} · {r.language.toUpperCase()}
                    </p>
                    {r.reason && <p className="learn-note">{r.reason}</p>}
                    <div className="learn-resource-meta">
                      <span>{r.estimated_minutes} min</span>
                      <span>✓ Verified</span>
                    </div>
                    <div className="learn-resource-actions">
                      <button
                        disabled={
                          busy === r.id || r.progress_status === "completed"
                        }
                        onClick={() => update(r, "started")}
                      >
                        {r.progress_status === "completed"
                          ? "Completed"
                          : r.progress_status === "started"
                            ? "In progress"
                            : "Mark started"}
                      </button>
                      <button
                        disabled={
                          busy === r.id || r.progress_status === "completed"
                        }
                        onClick={() => update(r, "completed")}
                      >
                        Mark complete
                      </button>
                      <a
                        href={r.url}
                        target="_blank"
                        rel="noreferrer noopener"
                        onClick={() => {
                          if (r.progress_status !== "completed")
                            update(r, "started");
                        }}
                      >
                        Open resource ↗
                      </a>
                    </div>
                    <div className="learn-resource-feedback">
                      <span>Was this useful?</span>
                      <button
                        onClick={() => feedback(r, true)}
                        aria-label="Helpful"
                      >
                        👍
                      </button>
                      <button
                        onClick={() => feedback(r, false)}
                        aria-label="Not helpful"
                      >
                        👎
                      </button>
                    </div>
                    <small className="learn-licence">
                      {r.licence || "Licence details not supplied"}
                    </small>
                  </article>
                ))}
            </div>
          </section>
        ))
      )}
      {!!gapsWithoutResources.length && (
        <p className="learn-note">
          No approved resource yet for:{" "}
          {gapsWithoutResources.map((gap) => gap.name).join(", ")}. These gaps
          stay visible so you know what is still pending.
        </p>
      )}
      <div className="learn-bottom-grid">
        <section className="learn-panel">
          <span className="learn-kicker">Reassessment</span>
          <h3>Ready to measure your progress?</h3>
          <p>
            Retakes are separate official attempts. Your previous scores remain
            in your history and are never overwritten.
          </p>
          <div className="learn-retake-line">
            <span>Available credits</span>
            <b>{retake.balance}</b>
          </div>
          <div className="learn-retake-line">
            <span>Credits per attempt</span>
            <b>{retake.credit_cost}</b>
          </div>
          <div className="learn-retake-line">
            <span>Cooldown</span>
            <b>{retake.cooldown_hours} hours</b>
          </div>
          {retake.cooldown_until && (
            <small>Next eligible date: {fmt(retake.cooldown_until)}</small>
          )}
          <button
            className="btn"
            disabled={!retake.eligible && !retake.active_attempt}
            onClick={onNext}
          >
            {retake.active_attempt
              ? "Resume active assessment"
              : retake.eligible
                ? "Start official retake"
                : "Retake not available yet"}
          </button>
          {!retake.eligible && (
            <small className="learn-reason">
              {retake.active_attempt
                ? "An assessment is already in progress."
                : retake.awaiting_review
                  ? "Your latest result is awaiting human review. The verified learning path and retake unlock after approval."
                  : retake.balance < retake.credit_cost
                    ? "You need more retake credits."
                    : retake.attempts_used_90d >= retake.max_attempts_90d
                      ? "You have reached the 90-day attempt limit."
                      : retake.has_result
                        ? "The retake cooldown is still active."
                        : "Complete your first assessment to unlock retakes."}
            </small>
          )}
        </section>
        <section className="learn-panel">
          <span className="learn-kicker">Your learning activity</span>
          <h3>Progress overview</h3>
          <div className="learn-progress-track">
            <span
              style={{
                width:
                  (data.progress.started + data.progress.completed
                    ? Math.round(
                        (data.progress.completed /
                          (data.progress.started + data.progress.completed)) *
                          100,
                      )
                    : 0) + "%",
              }}
            />
          </div>
          <p>
            {data.progress.completed} completed · {data.progress.started}{" "}
            started
          </p>
          <p className="learn-note">
            Recommendations are based on your latest saved assessment. Learning
            activity does not directly change your assessment score.
          </p>
        </section>
      </div>
      <section className="learn-panel learn-history">
        <div className="learn-section-head">
          <div>
            <span className="learn-kicker">Immutable record</span>
            <h3>Assessment attempt history</h3>
            <p>
              Every official attempt is recorded separately, including consumed
              credits.
            </p>
          </div>
          <span className="learn-count">
            {data.attempt_history.length} attempts
          </span>
        </div>
        {data.attempt_history.length ? (
          <div className="learn-history-table">
            <table>
              <thead>
                <tr>
                  <th>Attempt</th>
                  <th>Type</th>
                  <th>Started</th>
                  <th>Result</th>
                  <th>Credits used</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {data.attempt_history.map((a, i) => (
                  <tr key={a.id}>
                    <td>
                      #{data.attempt_history.length - i}
                      <small>{a.id.slice(0, 8)}</small>
                    </td>
                    <td>{a.kind === "pre" ? "Baseline" : "Retake"}</td>
                    <td>{fmt(a.started)}</td>
                    <td>{a.score == null ? "—" : a.score + "%"}</td>
                    <td>{a.credit_consumed}</td>
                    <td>
                      <span>{a.status}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="learn-note">
            No assessment attempts have been recorded yet.
          </p>
        )}
      </section>
      {data.release_history?.length > 0 && <section className="learning-release-history"><h3>Published result revisions</h3><p className="muted">Previous approved scores remain in the record when an administrator publishes a revised result.</p><ul>{data.release_history.map((release) => <li key={release.id}><span>{fmt(release.created)} · revision {release.id.slice(0, 8)}</span><strong>Technical {release.overall ?? "—"}% · honesty {release.honesty_score ?? "—"}/100</strong></li>)}</ul></section>}
    </section>
  );
}

/* ---------- passport ---------- */
function Passport({ st, refresh }) {
  const t = useT();
  const eligible = st.attempts.filter((attempt) => attempt.status === "done" && attempt.finalized === true)
    .sort((a, b) => (b.reviewed_at || 0) - (a.reviewed_at || 0));
  const [copied, setCopied] = useState(null);
  const [journey, setJourney] = useState(null);
  useEffect(() => {
    api("/skill-journey").then(setJourney).catch(() => {});
  }, []);
  const latest = eligible[0];
  const topics = latest?.topics || {};
  const passports = st.passports || [];
  const revoke = async (id) => { await api(`/passport/${id}`, { method: "DELETE" }); refresh(); };
  const link = (id) => `${location.origin}/#/p/${id}`;
  const copy = async (id) => { try { await navigator.clipboard.writeText(link(id)); setCopied(id); } catch { /* ignore */ } };
  const autoPassports = passports.filter((p) => p.auto && !p.revoked);
  return (
    <section>
      <h2>{t("passportTitle")}</h2>
      <AssessmentStatus publication={journey?.latest_result?.publication} objective={journey?.latest_result?.objective_summary} onRefresh={refresh} />
      {autoPassports.length > 0 && (
        <p className="success-note">{t("passportAutoCreated")}</p>
      )}
      {journey?.latest_result && !journey.approved && (
        <p className="note">{t("passportAwaitingReview")}</p>
      )}
      <div className="card">
        <p>{t("passportHelp")}</p>
        {!latest ? <p className="assessment-pending-banner">{t("passportRequiresReviewed")}</p> : <>
          <div className="passport-reviewed-result">
            <div className="passport-reviewed-summary"><span>{t("reviewedResult")}</span><strong>{latest.overall ?? "—"}<small> / 100</small></strong></div>
            <p>{t("assessmentReview_approved")}{latest.reviewed_at ? ` · ${new Date(Number(latest.reviewed_at) * 1000).toLocaleDateString()}` : ""}</p>
          </div>
          {latest?.honesty && <p className="note">Approved honesty score: <strong>{latest.honesty.score}/100</strong> · advisory and separate from technical marks.</p>}
          <p className="passport-skill-note">{t("allReviewedSkillsIncluded")}</p>
          <ul className="gaps passport-skills">{Object.entries(topics).map(([key, topic]) => (
            <li key={key}>
              <div className="passport-skill-choice">
                <span className="passport-skill-info"><strong>{t(`topic_${key}`) === `topic_${key}` ? key : t(`topic_${key}`)}</strong><small>{t("levels")[topic.level]} · {topic.n} {t("questionsAnswered")}</small></span>
                <span className="passport-skill-score">{topic.score}%</span>
              </div>
              <Bar score={topic.score} />
              <span className="passport-skill-reviewed"><span aria-hidden="true">✓</span> {t("skillReviewed")}</span>
            </li>
          ))}</ul>
        </>}
      </div>
      {passports.length > 0 && (
        <div className="card">
          <h3>{t("yourPass")}</h3>
          <ul className="plist">
            {passports.map((p) => (
              <li key={p.id}>
                <code>{link(p.id)}</code>
                {p.auto && !p.revoked && (
                  <span className="chip chip-ok">Auto-verified</span>
                )}
                {p.revoked ? (
                  <span className="chip chip-rev">{t("revoked")}</span>
                ) : (
                  <span className="row">
                    {p.reviewed && <>
                      <a className="btn ghost sm" href={`#/p/${p.id}`} target="_blank" rel="noreferrer">{t("open")}</a>
                      <button className="btn ghost sm" onClick={() => copy(p.id)}>{copied === p.id ? t("copied") : t("copy")}</button>
                    </>}
                    {!p.reviewed && <span className="chip chip-rev">{t("passportReviewRequired")}</span>}
                    <button className="btn ghost sm" onClick={() => revoke(p.id)}>{t("revoke")}</button>
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      <DataRights />
    </section>
  );
}

function DataRights() {
  const t = useT();
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState(null);
  const [status, setStatus] = useState("");
  const [confirming, setConfirming] = useState(false);
  const exp = async () => {
    setBusy("export");
    setErr(null);
    setStatus("");
    try {
      const d = await api("/me/export");
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(d, null, 2)], { type: "application/json" }),
      );
      const a = document.createElement("a");
      a.href = url;
      a.download = "skillbridge-my-data.json";
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setStatus(t("exportReady"));
    } catch (e) {
      setErr(e);
    } finally {
      setBusy("");
    }
  };
  const del = async () => {
    setBusy("delete");
    setErr(null);
    try {
      await api("/me", { method: "DELETE" });
      setToken(null);
      location.hash = "";
      location.reload();
    } catch (e) {
      setErr(e);
      setBusy("");
      setConfirming(false);
    }
  };
  return (
    <div className="card quiet">
      <h3>{t("dataRights")}</h3>
      <div className="row">
        <button className="btn ghost" onClick={exp} disabled={Boolean(busy)} aria-busy={busy === "export"}>
          {busy === "export" ? t("exportBusy") : t("exportData")}
        </button>
        <button className="btn ghost" onClick={() => { setErr(null); setConfirming(true); }} disabled={Boolean(busy)}>
          {t("deleteData")}
        </button>
      </div>
      <p className="muted" role="status" aria-live="polite">{status}</p>
      <Err e={err} />
      <ConfirmDialog
        open={confirming}
        title={t("deleteData")}
        body={t("deleteConfirm")}
        confirmLabel={busy === "delete" ? t("deleteBusy") : t("deleteConfirmBtn")}
        cancelLabel={t("cancel")}
        busy={busy === "delete"}
        danger
        onConfirm={del}
        onCancel={() => setConfirming(false)}
      />
    </div>
  );
}

function PublicPassport({ id }) {
  const t = useT();
  const [d, setD] = useState(null);
  const [nf, setNf] = useState(false);
  useEffect(() => { api(`/public/passport/${id}`).then(setD).catch(() => setNf(true)); }, [id]);
  if (nf) return <main className="wrap"><p className="note">{t("passNotFound")}</p></main>;
  if (!d) return <main className="wrap"><p>{t("loading")}</p></main>;
  if (d.review_required) return <main className="wrap"><p className="note">{t("publicPassportReviewRequired")}</p></main>;
  if (d.revoked) return <main className="wrap"><p className="note">{t("passRevoked")}</p></main>;
  return <main className="credential-page"><SkillCredential passport={d.passport} verification={d} /></main>;
}

function CandidateAssessmentResults({ attempts }) {
  const done = (attempts || []).filter((a) => a.status === "done");
  const approved = done
    .filter((a) => a.finalized === true)
    .sort((a, b) => (b.finished || 0) - (a.finished || 0));
  const latest = approved[0];
  const other = done
    .filter((a) => !latest || a.id !== latest.id)
    .sort((a, b) => (b.finished || 0) - (a.finished || 0));
  const date = (v) =>
    v
      ? new Date(Number(v) * 1000).toLocaleDateString(undefined, {
          year: "numeric",
          month: "short",
          day: "numeric",
        })
      : "Date unavailable";
  const label = (a) =>
    a.kind === "pre" ? "Initial assessment" : a.kind === "post" ? "Reassessment" : "Assessment";
  const status = (a) =>
    a.finalized === true
      ? "Valid exam"
      : a.review_decision === "invalidated"
        ? "Invalidated"
        : "Under review";
  return (
    <section className="portal-panel assessment-history">
      <div className="dashboard-section-heading">
        <div>
          <span className="eyebrow">Verified assessment results</span>
          <h2>Assessment results</h2>
          <p>Academic marks and the honesty report must both be approved before a result is verified.</p>
        </div>
      </div>
      {latest ? (
        <div className="assessment-featured">
          <div>
            <span className="eyebrow">Latest valid exam</span>
            <h3>{label(latest)}</h3>
            <p>{date(latest.finished)}</p>
          </div>
          <strong>
            {latest.overall ?? "—"}
            <small>/ 100</small>
          </strong>
          <span className="status-pill" data-tone="success">Valid exam</span>
        </div>
      ) : (
        <div className="assessment-pending-banner">
          <strong>No valid exam result yet</strong>
          <p>
            Your completed exam marks will remain under review until an
            administrator reviews them.
          </p>
        </div>
      )}
      {other.length > 0 && (
        <>
          <h3>Other exam attempts</h3>
          <div className="assessment-history-list">
            {other.map((a) => (
              <div className="assessment-history-row" key={a.id}>
                <div>
                  <strong>{label(a)}</strong>
                  <small>{date(a.finished)}</small>
                </div>
                <strong>
                  {a.overall ?? "—"}
                  <small>/ 100</small>
                </strong>
                <span
                  className={
                    "status-pill " +
                    (a.review_decision === "approved"
                      ? "status-valid"
                      : a.review_decision === "invalidated"
                        ? "status-invalid"
                        : "status-review")
                  }
                >
                  {status(a)}
                </span>
              </div>
            ))}
          </div>
        </>
      )}
    </section>
  );
}

function CandidateProfileOnboarding({ onSaved, ownerKey }) {
  const [status, setStatus] = useState("loading");
  const [helpOpen, setHelpOpen] = useState(false);
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const loadStatus = async () => {
    try {
      const result = await api("/candidate/profile/status");
      setStatus(result.status || "not_created");
    } catch (e) {
      setError(e.message || "Could not check profile status");
      setStatus("error");
    }
  };

  useEffect(() => {
    loadStatus();
  }, []);

  const startManual = async () => {
    setBusy(true);
    setError("");

    try {
      await api("/candidate/profile/draft", {
        method: "PUT",
        body: {
          headline: "",
          phone: "",
          location: "",
          summary: "",
          linkedin: "",
          github: "",
          portfolio: "",
          education: [],
          experience: [],
          projects: [],
          preferences: {
            job_types: [],
            work_mode: "",
            locations: [],
          },
        },
      });

      setStatus("draft");
    } catch (e) {
      setError(e.message || "Could not start manual profile");
    } finally {
      setBusy(false);
    }
  };

  const uploadCV = async () => {
    if (!file) {
      setError("Please select your CV first.");
      return;
    }

    setBusy(true);
    setError("");

    try {
      const form = new FormData();
      form.append("file", file);

      await api("/cv/profile-extract", {
        method: "POST",
        form,
      });

      setStatus("draft");
    } catch (e) {
      setError(e.message || "Could not extract your CV");
    } finally {
      setBusy(false);
    }
  };

  if (status === "loading") {
    return <div className="portal-panel">Checking your profile...</div>;
  }

  if (status === "error") {
    return (
      <div className="portal-panel">
        <p className="err">{error}</p>
        <button className="btn" onClick={loadStatus}>
          Try again
        </button>
      </div>
    );
  }

  if (status === "draft") {
    return (
      <CandidateProfileWorkspace
        draftMode={true}
        ownerKey={ownerKey}
        onSaved={async () => {
          setStatus("confirmed");
          await onSaved?.();
        }}
      />
    );
  }

  if (status === "confirmed") {
    return (
      <section>
        <div className="portal-panel">
          <span className="eyebrow">Your profile</span>
          <h2>Your candidate profile</h2>
          <p>
            Your profile has been created. You can update your information
            whenever you need.
          </p>
          <span className="status-pill" data-tone="success">Confirmed</span>
        </div>

        <CandidateProfileWorkspace ownerKey={ownerKey} onSaved={onSaved} />
      </section>
    );
  }

  return (
    <section className="tf-profile">
      <header className="tf-page-head">
        <span className="tf-chip">Candidate details</span>
        <h1>My Profile</h1>
        <p>Create, review and manage your professional profile.</p>
        <span className="tf-underline" aria-hidden="true" />
      </header>

      <section className="tf-welcome">
        <div className="tf-welcome-copy">
          <span className="tf-welcome-eyebrow">👋 Welcome to TalentForge!</span>
          <h2>Let's build your candidate profile</h2>
          <p>
            Your account is ready. Now create your professional profile. You can
            enter your details manually or let us extract them from your CV.
          </p>
        </div>
        <ul className="tf-checks">
          {[
            "Stand out to employers",
            "Get personalized recommendations",
            "Track your progress",
          ].map((item) => (
            <li key={item}>
              <span className="tf-check" aria-hidden="true">✓</span>
              {item}
            </li>
          ))}
        </ul>
        <div className="tf-welcome-art" aria-hidden="true">
          <svg viewBox="0 0 220 150" role="presentation">
            <defs>
              <linearGradient id="tfCard" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0%" stopColor="#ffffff" />
                <stop offset="100%" stopColor="#ece7ff" />
              </linearGradient>
              <linearGradient id="tfShield" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0%" stopColor="#34c98a" />
                <stop offset="100%" stopColor="#1f9c68" />
              </linearGradient>
            </defs>
            <circle cx="150" cy="70" r="55" fill="#dcd4ff" opacity=".55" />
            <circle cx="52" cy="30" r="14" fill="#cdbfff" opacity=".7" />
            <rect x="52" y="34" width="108" height="82" rx="12" fill="url(#tfCard)"
                  stroke="#cfc6ff" transform="rotate(-8 106 75)" />
            <circle cx="90" cy="60" r="13" fill="#7c5cff" transform="rotate(-8 106 75)" />
            <rect x="78" y="80" width="62" height="7" rx="3.5" fill="#a99bf5" transform="rotate(-8 106 75)" />
            <rect x="84" y="93" width="46" height="6" rx="3" fill="#c6bdfa" transform="rotate(-8 106 75)" />
            <path d="M158 84l20 9-10 4-4 10z" fill="#a99bf5" opacity=".7" />
            <path d="M168 96l26 10-7 6-9-5-4 8-6-19z" fill="url(#tfShield)" />
            <path d="M178 103h12M184 97v12" stroke="#fff" strokeWidth="3" strokeLinecap="round" />
          </svg>
        </div>
      </section>

      {error && (
        <p className="err tf-error" role="alert">
          {error}
        </p>
      )}

      <div className="tf-cards">
        <article className="tf-card tf-card-blue">
          <div className="tf-card-icon blue">🖊</div>
          <h3>Create manually</h3>
          <p>
            Enter your professional information, education, experience and
            projects yourself.
          </p>
          <button className="tf-btn blue" disabled={busy} onClick={startManual}>
            {busy ? "Please wait…" : "Create profile manually"}
            <span aria-hidden="true">→</span>
          </button>
          <div className="tf-card-art" aria-hidden="true">
            <svg viewBox="0 0 190 130" role="presentation">
              <circle cx="150" cy="105" r="46" fill="#d6e6ff" opacity=".8" />
              <rect x="30" y="34" width="92" height="62" rx="8" fill="#fff" stroke="#bcd4ff" />
              <rect x="42" y="46" width="52" height="5" rx="2.5" fill="#9dc0ff" />
              <rect x="42" y="57" width="66" height="4" rx="2" fill="#c9dcff" />
              <rect x="42" y="66" width="44" height="4" rx="2" fill="#c9dcff" />
              <circle cx="100" cy="82" r="10" fill="#7c5cff" />
              <path d="M96 82h8M100 78v8" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" />
              <path d="M112 96h30l8 14h-46z" fill="#cfe1ff" />
            </svg>
          </div>
        </article>

        <article className="tf-card tf-card-green">
          <div className="tf-card-icon green">⤒</div>
          <h3>Upload your CV</h3>
          <p>
            Upload your resume. TalentForge will extract your information and
            prepare an editable profile draft.
          </p>
          <div className="tf-file-row">
            <label className="tf-file-label">
              <span aria-hidden="true"><WorkspaceIcon name="file" size={20} /></span>
              <span>
                <b>{file ? file.name : "Select CV (PDF, DOCX, TXT or MD)"}</b>
                <small>{file ? "Ready to upload" : "Choose File"}</small>
              </span>
              <input
                type="file"
                accept=".pdf,.docx,.txt,.md"
                onChange={(e) => {
                  setFile(e.target.files?.[0] || null);
                  setError("");
                }}
              />
            </label>
          </div>
          <button className="tf-btn green" disabled={busy || !file} onClick={uploadCV}>
            {busy ? "Extracting CV…" : "Upload and create draft"}
            <span aria-hidden="true">→</span>
          </button>
          <div className="tf-card-art right" aria-hidden="true">
            <svg viewBox="0 0 170 140" role="presentation">
              <circle cx="112" cy="72" r="52" fill="#cdeedd" opacity=".75" />
              <rect x="60" y="34" width="62" height="76" rx="9" fill="#fff" stroke="#b7e3cd"
                    transform="rotate(8 91 72)" />
              <text x="72" y="74" fontSize="22" fontWeight="800" fill="#2f9e6f"
                    transform="rotate(8 91 72)">CV</text>
              <rect x="70" y="86" width="42" height="5" rx="2.5" fill="#bfe6d3" transform="rotate(8 91 72)" />
              <circle cx="128" cy="104" r="18" fill="#2f9e6f" />
              <path d="M128 96v14M122 104l6 6 6-6" stroke="#fff" strokeWidth="3"
                    strokeLinecap="round" strokeLinejoin="round" fill="none" />
            </svg>
          </div>
        </article>
      </div>

      <footer className="tf-trust">
        {[
          ["privacy", "Secure &amp; Private", "Your data is always safe"],
          ["clock", "Fast &amp; Easy", "Complete in minutes"],
          ["profile", "Professional Profile", "Stand out to recruiters"],
        ].map(([icon, title, sub]) => (
          <div className="tf-trust-item" key={title}>
            <span className="tf-trust-icon" aria-hidden="true"><WorkspaceIcon name={icon} size={18} /></span>
            <span>
              <b>{title}</b>
              <small>{sub}</small>
            </span>
          </div>
        ))}
        <button type="button" className="tf-help" onClick={() => setHelpOpen((v) => !v)}>
          🎧 Need Help?
        </button>
      </footer>
      {helpOpen && (
        <p className="tf-help-note">
          Having trouble uploading a PDF? Make sure it is a text-based PDF (not a
          scan). You can also save it as DOCX or TXT, or paste the text on the
          profile page after creating a draft.
        </p>
      )}

      <p className="tf-footnote">
        Your profile is not created or published until you review and confirm the
        information.
      </p>
    </section>
  );
}


function CandidateJobs() {
  const [jobs, setJobs] = useState([]),
    [apps, setApps] = useState([]),
    [search, setSearch] = useState(""),
    [kind, setKind] = useState("All"),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [loading, setLoading] = useState(true);
  const load = async () => {
    try {
      const [j, a] = await Promise.all([
        api("/jobs"),
        api("/applications/mine"),
      ]);
      setJobs(j.items || []);
      setApps(a.items || []);
    } catch (e) {
      setError(e.message || "Could not load jobs");
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    load();
  }, []);
  const apply = async (id) => {
    try {
      const r = await api("/jobs/" + id + "/apply", { method: "POST" });
      setNotice(
        r.status === "already_applied"
          ? "You have already applied."
          : "Application submitted.",
      );
      await load();
    } catch (e) {
      setError(e.message || "Could not apply");
    }
  };
  const applied = new Set(apps.map((a) => a.job_id));
  const filtered = jobs.filter(
    (j) =>
      (kind === "All" || j.employment_type === kind) &&
      [j.title, j.description, j.company_name, ...(j.skills || [])]
        .join(" ")
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  if (loading) return <div className="portal-panel">Loading jobs…</div>;
  return (
    <section>
      <div className="job-filters">
        <input
          aria-label="Search jobs"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search title, company or skill…"
        />
        <select value={kind} onChange={(e) => setKind(e.target.value)}>
          <option>All</option>
          {[
            "Internship",
            "Full-time",
            "Part-time",
            "Contract",
            "Temporary",
          ].map((x) => (
            <option key={x}>{x}</option>
          ))}
        </select>
      </div>
      {notice && (
        <p className="success-note" role="status">
          {notice}
        </p>
      )}
      {error && (
        <p className="err" role="alert">
          {error}
        </p>
      )}
      <div className="job-grid">
        {filtered.map((j) => (
          <article className="job-card" key={j.id}>
            <div className="job-card-top">
              <span className="job-icon" aria-hidden="true"><WorkspaceIcon name="jobs" size={18} /></span>
              {j.is_mock && <span className="chip chip-mock">MOCK DATA</span>}
            </div>
            <h3>{j.title}</h3>
            <p className="job-company">{j.company_name}</p>
            <p>{j.description}</p>
            <div className="job-meta">
              <span>{j.location}</span>
              <span>{j.employment_type}</span>
            </div>
            <div className="job-skill-tags">
              {(j.skills || []).map((s) => (
                <span key={s}>{s}</span>
              ))}
            </div>
            <button
              className={"btn " + (applied.has(j.id) ? "ghost" : "")}
              disabled={applied.has(j.id)}
              onClick={() => apply(j.id)}
            >
              {applied.has(j.id) ? "Application sent" : "Apply now"}
            </button>
          </article>
        ))}
      </div>
      {!filtered.length && (
        <div className="empty-state">
          <h3>No matching jobs</h3>
          <p>Try another search term or filter.</p>
        </div>
      )}
    </section>
  );
}
/** Platform-approved next-stage invitations for the candidate's applications. */
function PhaseTwoInvites({ onChanged }) {
  const t = useT();
  const [items, setItems] = useState([]);
  const [status, setStatus] = useState("loading");
  const [err, setErr] = useState(null);
  const [pending, setPending] = useState(null);
  const [busy, setBusy] = useState(false);
  const [actionErr, setActionErr] = useState(null);
  const [notice, setNotice] = useState("");
  const load = useCallback(async () => {
    setErr(null);
    try {
      const r = await api("/candidate/phase-two-invites");
      setItems(normalizeInvites(r));
      setStatus("ready");
    } catch (e) {
      if (e?.status === 404 || e?.status === 501) {
        setItems([]);
        setStatus("unavailable");
      } else {
        setErr(e);
        setStatus("error");
      }
    }
  }, []);
  useEffect(() => { load(); }, [load]);
  const respond = async () => {
    if (!pending) return;
    setBusy(true);
    setActionErr(null);
    try {
      await api(`/candidate/phase-two-invites/${encodeURIComponent(pending.invite.id)}/respond`, {
        method: "POST",
        body: { decision: pending.decision },
      });
      setNotice(pending.decision === "accept" ? t("inviteAccepted") : t("inviteDeclined"));
      setPending(null);
      await load();
      onChanged?.();
    } catch (e) {
      setActionErr(e);
    } finally {
      setBusy(false);
    }
  };
  if (status === "unavailable") return null;
  return (
    <section className="phase-two-invites" aria-labelledby="phase-two-invites-title">
      <div className="section-toolbar">
        <div>
          <h3 id="phase-two-invites-title">{t("invitesTitle")}</h3>
          <p>{t("invitesHelp")}</p>
        </div>
      </div>
      <div aria-live="polite">
        {status === "loading" && <p className="muted">{t("loading")}</p>}
        {notice && <p className="success-note" role="status">{notice}</p>}
      </div>
      {status === "error" && (
        <div>
          <Err e={err} />
          <button type="button" className="btn ghost sm" onClick={load}>{t("retry")}</button>
        </div>
      )}
      {status === "ready" && !items.length && <p className="muted">{t("invitesEmpty")}</p>}
      {items.map((invite) => {
        const open = canRespondToInvite(invite);
        const expired = inviteAwaitingResponse(invite) && inviteDeadlinePassed(invite);
        const statusLabel = expired ? t("inviteStatus_expired") : t(`inviteStatus_${invite.status}`) !== `inviteStatus_${invite.status}` ? t(`inviteStatus_${invite.status}`) : humanizeStatus(invite.status);
        return (
          <article className="application-row phase-two-invite" key={invite.id} data-invite-id={invite.id}>
            <div className="application-main">
              <h3>{invite.title || t("invitesTitle")}</h3>
              <p>{[invite.job_title, invite.company_name].filter(Boolean).join(" · ")}</p>
              {invite.requirements && <p className="muted">{invite.requirements}</p>}
              <span className={"status-pill " + (invite.status === "accepted" ? "status-valid" : invite.status === "declined" || expired ? "status-invalid" : "status-review")}>{statusLabel}</span>
              {invite.deadline && <small className="muted"> {t("inviteDeadline")}: {invite.deadline}</small>}
            </div>
            {open && (
              <div className="application-actions">
                <button type="button" className="btn sm" onClick={() => { setActionErr(null); setPending({ invite, decision: "accept" }); }}>{t("inviteAccept")}</button>
                <button type="button" className="btn ghost sm" onClick={() => { setActionErr(null); setPending({ invite, decision: "decline" }); }}>{t("inviteDecline")}</button>
              </div>
            )}
          </article>
        );
      })}
      <ConfirmDialog
        open={Boolean(pending)}
        title={pending?.decision === "accept" ? t("inviteAcceptConfirmTitle") : t("inviteDeclineConfirmTitle")}
        body={pending ? `${pending.invite.title || ""}${pending.invite.job_title ? " · " + pending.invite.job_title : ""}. ${pending.decision === "accept" ? t("inviteAcceptConfirmBody") : t("inviteDeclineConfirmBody")}` : ""}
        confirmLabel={busy ? t("saving") : pending?.decision === "accept" ? t("inviteAccept") : t("inviteDecline")}
        cancelLabel={t("cancel")}
        busy={busy}
        danger={pending?.decision === "decline"}
        onConfirm={respond}
        onCancel={() => setPending(null)}
      >
        <Err e={actionErr} />
      </ConfirmDialog>
    </section>
  );
}

function CandidateApplications({ onOpenAssessments }) {
  const t = useT();
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState("");
  const [sharingId, setSharingId] = useState(null);
  const [withdrawTarget, setWithdrawTarget] = useState(null);
  const [withdrawBusy, setWithdrawBusy] = useState(false);
  const [withdrawErr, setWithdrawErr] = useState(null);
  const load = useCallback(async () => {
    try {
      const r = await api("/applications/mine");
      setItems(r.items || []);
      setError(null);
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);
  const share = async (id, value) => {
    setSharingId(id);
    setError(null);
    try {
      await api("/applications/" + id + "/share-results", {
        method: "PUT",
        body: { share: value },
      });
      await load();
    } catch (e) {
      setError(e);
    } finally {
      setSharingId(null);
    }
  };
  const withdraw = async () => {
    if (!withdrawTarget) return;
    setWithdrawBusy(true);
    setWithdrawErr(null);
    try {
      await api(`/applications/${encodeURIComponent(withdrawTarget.application_id)}/withdraw`, { method: "POST", body: {} });
      setNotice(t("withdrawDone"));
      setWithdrawTarget(null);
      await load();
    } catch (e) {
      setWithdrawErr(e?.status === 404 || e?.status === 501 ? { code: "withdraw_unavailable" } : e);
    } finally {
      setWithdrawBusy(false);
    }
  };
  if (loading) return <div className="portal-panel" role="status">{t("applicationsLoading")}</div>;
  return (
    <section className="portal-panel">
      <div className="section-toolbar">
        <div>
          <span className="eyebrow">Your job search</span>
          <h2>My applications</h2>
          <p>Track submitted applications and control result sharing.</p>
        </div>
        <span className="count-badge">{items.length} total</span>
      </div>
      <div aria-live="polite">
        {notice && <p className="success-note" role="status">{notice}</p>}
      </div>
      {error && (
        <div>
          <Err e={error} />
          <button type="button" className="btn ghost sm" onClick={load}>{t("retry")}</button>
        </div>
      )}
      <PhaseTwoInvites onChanged={load} />
      {!items.length && !error && (
        <div className="empty-state">
          <h3>No applications yet</h3>
          <p>Browse jobs and apply to a role that matches your interests.</p>
        </div>
      )}
      {items.map((a) => (
        <article className="application-row" key={a.application_id} data-application-id={a.application_id}>
          <div className="application-logo">SB</div>
          <div className="application-main">
            <h3>{a.title}</h3>
            <p>
              {a.company_name} · {a.location}
            </p>
            <span className="status-pill" data-tone={statusTone(a.status)}>{humanizeStatus(a.status)}</span>
            {a.zoom && (
              <div className="application-interview">
                <strong>Interview: {a.zoom.scheduled_at || "time to be confirmed"}</strong>
                <a href={a.zoom.meeting_url} target="_blank" rel="noreferrer">
                  {a.zoom.meeting_url}
                </a>
                {a.zoom.note && <small>{a.zoom.note}</small>}
              </div>
            )}
            {a.interview_method === "ai" && (
              <div className="application-interview">
                <strong>AI interview invited</strong>
                <small>Open Assessments to review the privacy notice and start.</small>
                {onOpenAssessments && (
                  <button type="button" className="btn ghost sm" onClick={onOpenAssessments}>
                    Open Assessments
                  </button>
                )}
              </div>
            )}
          </div>
          <div className="application-consent">
            <label className="check">
              <input
                type="checkbox"
                checked={!!a.results_shared}
                disabled={sharingId === a.application_id || a.status === "withdrawn"}
                onChange={(e) => share(a.application_id, e.target.checked)}
              />{" "}
              Share assessment results with this employer
            </label>
            <small className="muted">
              You can change this choice at any time.
            </small>
            {canWithdrawApplication(a) && (
              <button
                type="button"
                className="btn ghost sm application-withdraw"
                onClick={() => { setWithdrawErr(null); setWithdrawTarget(a); }}
              >
                {t("withdrawApplication")}
              </button>
            )}
          </div>
        </article>
      ))}
      <ConfirmDialog
        open={Boolean(withdrawTarget)}
        title={t("withdrawConfirmTitle")}
        body={withdrawTarget ? `${withdrawTarget.title || ""}${withdrawTarget.company_name ? " · " + withdrawTarget.company_name : ""}. ${t("withdrawConfirmBody")}` : ""}
        confirmLabel={withdrawBusy ? t("saving") : t("withdrawApplication")}
        cancelLabel={t("cancel")}
        busy={withdrawBusy}
        danger
        onConfirm={withdraw}
        onCancel={() => setWithdrawTarget(null)}
      >
        <Err e={withdrawErr} />
      </ConfirmDialog>
    </section>
  );
}
function CandidatePortal({ st, refresh, tick, setTick, onLogout }) {
  const lang = useLangValue();
  const setLang = useSetLang();
  // Warm the on-device proctoring models in the background while the candidate
  // is still browsing, so the verify page is ready almost instantly. Only model
  // files are fetched; no camera/microphone is touched here.
  useEffect(() => {
    const run = () => preloadProctorModels({ identity: true });
    if (window.requestIdleCallback) {
      const id = window.requestIdleCallback(run, { timeout: 4000 });
      return () => window.cancelIdleCallback?.(id);
    }
    const timer = setTimeout(run, 1500);
    return () => clearTimeout(timer);
  }, []);
  const [section, setSection] = useState("overview");
  const [interviewInvite, setInterviewInvite] = useState(null);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [journeyView, setJourneyView] = useState(() => {
    const completed = (st.attempts || []).filter(
      (a) => a.status === "done",
    ).length;
    if (!st.from_profile) return "profile";
    return completed > 0 ? "gap" : "assess";
  });
  useEffect(() => {
    api("/candidate/profile/status")
      .then((result) => {
        if (result.status !== "confirmed") {
          setSection("profile");
        }
      })
      .catch((error) => {
        console.error("Could not load candidate profile status:", error);
      });
  }, []);
  const t = useT();
  const done = (st?.attempts || []).filter((a) => a.status === "done");
  const notificationItems = assessmentNotificationItems(st?.attempts);
  const notificationOwner = st?.user?.email || "";
  const [seenNotifications, setSeenNotifications] = useState(() => loadSeenNotifications(notificationOwner));
  useEffect(() => { setSeenNotifications(loadSeenNotifications(notificationOwner)); }, [notificationOwner]);
  const unreadItems = unreadNotificationItems(notificationItems, seenNotifications);
  // Keys of what was unread when the panel opened, so those rows stay highlighted
  // while the candidate reads them even though the badge clears at once.
  const [highlightKeys, setHighlightKeys] = useState(() => new Set());
  const unreadSignature = unreadItems.map(notificationKey).join("|");
  useEffect(() => {
    if (!notificationsOpen || !unreadSignature) return;
    setHighlightKeys((old) => new Set([...old, ...unreadSignature.split("|")]));
    setSeenNotifications((seen) => markNotificationsSeen(notificationOwner, seen, notificationItems));
    // notificationItems is derived from the same state as unreadSignature.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notificationsOpen, unreadSignature, notificationOwner]);
  // Server notifications (application, job, phase-two events...) share the
  // bell with assessment events. Opening the panel marks visible ones read.
  const serverNotifications = useServerNotifications();
  const { markRead: markServerRead } = serverNotifications;
  const [serverHighlight, setServerHighlight] = useState(() => new Set());
  const serverUnreadSignature = unreadServerIds(serverNotifications.items).join("|");
  useEffect(() => {
    if (!notificationsOpen || !serverUnreadSignature) return;
    const ids = serverUnreadSignature.split("|");
    setServerHighlight((old) => new Set([...old, ...ids]));
    markServerRead(ids);
  }, [notificationsOpen, serverUnreadSignature, markServerRead]);
  const badgeCount = notificationBadgeCount(unreadItems.length, serverNotifications.unread);
  const closeNotifications = useCallback(() => {
    setNotificationsOpen(false);
    setHighlightKeys(new Set());
    setServerHighlight(new Set());
  }, []);
  const toggleNotifications = () => {
    if (notificationsOpen) { closeNotifications(); return; }
    setNotificationsOpen(true);
    serverNotifications.load();
  };
  useEffect(() => {
    if (!notificationsOpen) return undefined;
    const onKey = (event) => { if (event.key === "Escape") closeNotifications(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [notificationsOpen, closeNotifications]);
  const activeAttempt = (st?.attempts || []).find((a) => a.status === "active");
  const pollNotifications = shouldPollForNotifications(st?.attempts);
  const hasActiveAttempt = Boolean(activeAttempt);
  useEffect(() => {
    if (hasActiveAttempt) return undefined;
    const examLive = () => document.body.classList.contains("exam-live");
    let last = Date.now();
    const update = () => {
      if (examLive() || document.visibilityState === "hidden") return;
      last = Date.now();
      refresh();
    };
    // Reviews, publications and appeal outcomes happen on another account, so
    // poll while one is pending and always catch up when the tab is reopened.
    const timer = pollNotifications ? setInterval(update, 30000) : null;
    // Catch up only after the candidate really left (tab hidden or window
    // blurred), not on every stray focus event.
    let away = false;
    const onAway = () => { away = true; };
    const onBack = () => {
      if (!away || document.visibilityState === "hidden") return;
      away = false;
      if (Date.now() - last > 15000) update();
    };
    const onVisibility = () => (document.visibilityState === "hidden" ? onAway() : onBack());
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("blur", onAway);
    window.addEventListener("focus", onBack);
    return () => {
      if (timer) clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("blur", onAway);
      window.removeEventListener("focus", onBack);
    };
  }, [pollNotifications, hasActiveAttempt, refresh]);
  const latest = done[0];
  const hasSkills = Boolean(st.confirmed?.length);

  const W = t("ws");
  const nav = [
    { id: "overview", label: W.overview, icon: "overview", group: "WORKSPACE" },
    { id: "profile", label: W.myProfile, icon: "profile", group: "WORKSPACE" },
    { id: "jobs", label: W.findJobs, icon: "jobs", group: "WORKSPACE" },
    {
      id: "applications",
      label: W.applications,
      icon: "applications",
      group: "WORKSPACE",
    },
    { id: "exams", label: W.exams, icon: "exams", group: "GROWTH" },
    { id: "journey", label: W.journey, icon: "journey", group: "GROWTH" },
    { id: "learning", label: W.learning, icon: "learning", group: "GROWTH" },
    { id: "mcp", label: "MCP tools", icon: "mcp", group: "GROWTH" },
    { id: "agent", label: "AI Copilot", icon: "agent", group: "GROWTH" },
    { id: "passport", label: W.passport, icon: "passport", group: "GROWTH" },
    { id: "privacy", label: W.privacy, icon: "settings", group: "ACCOUNT" },
  ];
  const groupLabel = {
    WORKSPACE: W.groupWorkspace,
    GROWTH: W.groupGrowth,
    ACCOUNT: W.groupAccount,
  };
  const go = (id) => {
    setSection(id);
    closeNotifications();
    window.scrollTo({ top: 0, behavior: "smooth" });
  };
  return (
    <div className="candidate-shell">
      <a className="ws-skip-link" href="#candidate-content">Skip to content</a>
      <aside className="candidate-sidebar">
        <div className="sidebar-brand">
          <span className="brand-mark tf-logo-mark">TF</span>
          <span className="tf-brand-text">
            TalentForge<small>{W.tagline || "Bridge Your Skills"}</small>
          </span>
        </div>
        <div className="sidebar-profile">
          <Avatar
            name={st.user?.name}
            hasAvatar={st.has_avatar}
            updated={st.avatar_updated}
            ownerKey={st.user?.email}
            className="avatar-small"
          />
          <div>
            <strong>{st.user?.name}</strong>
            <small>{W.candidateAccount}</small>
          </div>
        </div>
        {["WORKSPACE", "GROWTH", "ACCOUNT"].map((group) => (
          <div className="sidebar-group" key={group}>
            <p>{groupLabel[group]}</p>
            {nav
              .filter((n) => n.group === group)
              .map((n) => (
                <button
                  key={n.id}
                  type="button"
                  className={section === n.id ? "active" : ""}
                  aria-current={section === n.id ? "page" : undefined}
                  onClick={() => go(n.id)}
                >
                  <span><WorkspaceIcon name={n.icon || n.id} /></span>
                  {n.label}
                </button>
              ))}
          </div>
        ))}
        <div className="sidebar-bottom">
          <div className="sidebar-tip">
            <strong>{W.keepGrowing}</strong>
            <p>{W.keepGrowingBody}</p>
            <button onClick={() => go("journey")}>{W.continueLearning}</button>
          </div>
          <p className="sidebar-version">TalentForge · {W.candidateAccount}</p>
        </div>
      </aside>
      <main className="candidate-main">
        <header className="candidate-topbar tf-topbar">
          <button type="button" className="ws-mobile-brand" aria-label="TalentForge dashboard" onClick={() => go("overview")}>TF</button>
          <div className="ws-location"><small>{W.groupWorkspace}</small><strong>{nav.find((item) => item.id === section)?.label}</strong></div>
          <WorkspaceSearch items={nav} onNavigate={go} lang={lang} />
          <div className="topbar-actions">
            <button type="button" className="tf-icon-btn sb-bell-btn" title={badgeCount ? `${W.notifications || "Notifications"} (${badgeCount})` : W.notifications || "Notifications"} aria-label={W.notifications || "Notifications"} aria-describedby={badgeCount ? "candidate-notification-count" : undefined} aria-expanded={notificationsOpen} aria-controls="candidate-notifications" onClick={toggleNotifications}>
              <WorkspaceIcon name="bell" size={19} />
              {badgeCount ? <span className="tf-dot sb-bell-badge" data-testid="notification-badge" aria-hidden="true">{badgeCount > 99 ? "99+" : badgeCount}</span> : null}
            </button>
            <span id="candidate-notification-count" className="sb-sr-only" aria-live="polite">{badgeCount ? `${badgeCount} ${t("notificationsUnread")}` : ""}</span>
            <div className="language-switch tf-lang">
              <select
                aria-label="Language"
                value={lang}
                onChange={(e) => setLang(e.target.value)}
              >
                <option value="en">English</option>
                <option value="bn">বাংলা</option>
              </select>
            </div>
            <div className="tf-user">
              <Avatar
                name={st.user?.name}
                hasAvatar={st.has_avatar}
                updated={st.avatar_updated}
                ownerKey={st.user?.email}
                className="topbar-avatar"
              />
              <span>
                <b>{st.user?.name}</b>
                <small>{W.candidateAccount}</small>
              </span>
            </div>
            <button
              type="button"
              className="candidate-logout"
              onClick={onLogout}
            >
              {W.signOut}
            </button>
          </div>
        </header>
        <nav className="candidate-mobile-nav" aria-label="Candidate workspace">
          {nav.map((n) => (
            <button
              key={n.id}
              type="button"
              className={section === n.id ? "active" : ""}
              aria-current={section === n.id ? "page" : undefined}
              onClick={() => go(n.id)}
            >
              <span><WorkspaceIcon name={n.icon || n.id} size={18} /></span>
              {n.label}
            </button>
          ))}
        </nav>
        <div className="candidate-page" id="candidate-content" tabIndex={-1}>
          {notificationsOpen && <section className="portal-panel ws-notifications" id="candidate-notifications" aria-label="Assessment notifications"><div className="panel-heading"><h2>{t("assessmentUpdates")}</h2><button type="button" className="cr-outline-btn" onClick={closeNotifications}>{t("close")}</button></div><AssessmentNotifications attempts={st.attempts || []} onRefresh={refresh} unreadKeys={highlightKeys} server={serverNotifications} serverHighlight={serverHighlight} onOpenServer={(item) => { const target = sectionForNotificationLink(item.link, "candidate", nav.map((entry) => entry.id)); if (target) go(target); }} /></section>}
          {section === "overview" && (
            <>
              <div className="ws-overview-heading"><div><span className="eyebrow">Your personal workspace</span><h1>Career overview</h1></div><span className="ws-date">{new Intl.DateTimeFormat(lang === "bn" ? "bn-BD" : "en-GB", { weekday: "short", day: "numeric", month: "long" }).format(new Date())}</span></div>
              <section className="welcome-banner">
                <div>
                  <span className="eyebrow light">
                    Your career, your progress
                  </span>
                  <h1>
                    Welcome back, {(st.user?.name || "Candidate").split(" ")[0]}
                    .
                  </h1>
                  <p>
                    Build your profile, verify your skills and discover
                    opportunities that fit your goals.
                  </p>
                  <div className="welcome-actions">
                    <button
                      className="btn btn-light"
                      onClick={() => go("profile")}
                    >
                      {st.from_profile ? "View my profile" : "Complete my profile"}
                    </button>
                    <button
                      className="welcome-link"
                      onClick={() => go("journey")}
                    >
                      Continue skill journey
                    </button>
                  </div>
                </div>
              </section>
              <div className="dashboard-section-heading">
                <div>
                  <span className="eyebrow">Your workspace</span>
                  <h2>Your career at a glance</h2>
                </div>
              </div>
              <div className="metric-grid">
                <button className="metric-card" onClick={() => go("profile")}>
                  <span className="metric-icon"><WorkspaceIcon name="profile" /></span>
                  <span className="metric-label">Profile & CV</span>
                  <strong>{st.from_profile ? "Profile added" : st.has_cv ? "CV added" : "Build profile"}</strong>
                  <small>{st.confirmed?.length || 0} confirmed skills</small>
                </button>
                <button className="metric-card" onClick={() => go("journey")}>
                  <span className="metric-icon"><WorkspaceIcon name="exams" /></span>
                  <span className="metric-label">Assessments</span>
                  <strong>{done.length} completed</strong>
                  <small>
                    {latest
                      ? "Latest score: " + (latest.overall ?? "—") + "%"
                      : "Verify your skills"}
                  </small>
                </button>
                <button
                  className="metric-card"
                  onClick={() => go("applications")}
                >
                  <span className="metric-icon"><WorkspaceIcon name="applications" /></span>
                  <span className="metric-label">Applications</span>
                  <strong>Track progress</strong>
                  <small>Manage result sharing</small>
                </button>
                <button className="metric-card" onClick={() => go("passport")}>
                  <span className="metric-icon"><WorkspaceIcon name="passport" /></span>
                  <span className="metric-label">Skill Passport</span>
                  <strong>
                    {st.passports?.filter((x) => !x.revoked).length || 0} active
                  </strong>
                  <small>Share verified evidence</small>
                </button>
              </div>
              <div className="dashboard-lower">
                <section className="portal-panel">
                  <span className="eyebrow">Recommended next step</span>
                  <h2>
                    {!hasSkills
                      ? "Build your candidate profile"
                      : done.length === 0
                        ? "Verify your skills"
                        : "Keep growing your skills"}
                  </h2>
                  <p>
                    {!hasSkills
                      ? "Add your background and review the skills extracted from your CV."
                      : done.length === 0
                        ? "Take an assessment to understand your strengths and learning gaps."
                        : "Use your learning path to practice and measure your progress."}
                  </p>
                  <button
                    className="btn"
                    onClick={() => go(!hasSkills ? "profile" : "journey")}
                  >
                    {!hasSkills ? "Open profile" : "Open skill journey"} →
                  </button>
                </section>
                <section className="portal-panel quick-links">
                  <h2>Quick links</h2>
                  {[
                    { id: "profile", label: "Edit professional profile" },
                    { id: "jobs", label: "Browse opportunities" },
                    { id: "applications", label: "Manage result sharing" },
                    { id: "privacy", label: "Export or delete data" },
                  ].map((x) => (
                    <button key={x.id} onClick={() => go(x.id)}>
                      {x.label}
                      <b>→</b>
                    </button>
                  ))}
                </section>
              </div>
            </>
          )}
          {section === "profile" && (
            <>
              <CandidateProfileOnboarding
                ownerKey={st.user?.email}
                onSaved={async () => {
                  await refresh();
                }}
              />
              <CandidateAssessmentResults attempts={st.attempts} />
            </>
          )}
          {section === "jobs" && (
            <>
              <div className="page-title">
                <div>
                  <span className="eyebrow">Opportunities</span>
                  <h1>Find jobs</h1>
                  <p>
                    Search the current marketplace and apply to a suitable role.
                  </p>
                </div>
              </div>
              <CandidateJobs />
            </>
          )}
          {section === "applications" && (
            <>
              <div className="page-title">
                <div>
                  <span className="eyebrow">Your job search</span>
                  <h1>Applications</h1>
                  <p>
                    Track submitted applications and manage assessment result
                    sharing.
                  </p>
                </div>
              </div>
              <CandidateApplications onOpenAssessments={() => go("exams")} />
            </>
          )}
          {section === "exams" && (
            <>
              {activeAttempt && (
                <div className="tf-resume-banner">
                  <div>
                    <strong>You have an exam in progress</strong>
                    <span>
                      {activeAttempt.kind === "post" ? "Re-test" : "Initial assessment"} ·
                      started{" "}
                      {activeAttempt.started
                        ? new Date(activeAttempt.started * 1000).toLocaleString()
                        : "earlier"}
                    </span>
                  </div>
                  <button className="tf-btn blue" onClick={() => go("journey")}>
                    Resume exam <span aria-hidden="true">→</span>
                  </button>
                </div>
              )}
              <AIInterviewCards
                onOpen={(invite) => setInterviewInvite(invite)}
                refreshKey={tick || 0}
              />
              <AssessmentRecords attempts={st.attempts} onRefresh={refresh} />
            </>
          )}
          {section === "journey" && (
            <>
              <div className="page-title">
                <div>
                  <span className="eyebrow">Skill development</span>
                  <h1>Skill journey</h1>
                  <p>
                    Move from claimed skills to verified evidence, learning and
                    re-assessment.
                  </p>
                </div>
              </div>
              <nav className="steps">
                {STEPS.map((s, i) => (
                  <button
                    key={s}
                    className={
                      (journeyView === s ? "on " : "") +
                      (done.length === 0 &&
                      ["gap", "learn", "retest", "passport"].includes(s)
                        ? "dim"
                        : "")
                    }
                    onClick={() => setJourneyView(s)}
                  >
                    <span className="n">{i + 1}</span>
                    {t("steps")[s]}
                  </button>
                ))}
              </nav>
              <div className="portal-panel journey-content">
                <ProfileJourneyRouter
                  st={st}
                  refresh={refresh}
                  onEditProfile={() => go("profile")}
                  tick={tick}
                  setTick={setTick}
                  done={done}
                  v={journeyView}
                  setV={setJourneyView}
                />
              </div>
            </>
          )}
          {section === "learning" && (
            <>
              <div className="page-title">
                <div>
                  <span className="eyebrow">Learn · Track · Reassess</span>
                  <h1>Learning & retakes</h1>
                  <p>
                    Verified resources, visible progress and transparent attempt
                    history.
                  </p>
                </div>
              </div>
              <div className="portal-panel journey-content">
                <Learn
                  onNext={() => {
                    setJourneyView("retest");
                    go("journey");
                  }}
                />
              </div>
            </>
          )}
          {section === "passport" && (
            <>
              <div className="page-title">
                <div>
                  <span className="eyebrow">Verifiable proof</span>
                  <h1>Skill Passport</h1>
                  <p>
                    Choose verified topics to share and revoke public links
                    whenever you need.
                  </p>
                </div>
              </div>
              <Passport st={st} refresh={refresh} />
            </>
          )}
          {section === "mcp" && (
            <>
              <div className="page-title">
                <div>
                  <span className="eyebrow">AI access · Model Context Protocol</span>
                  <h1>MCP tools</h1>
                  <p>
                    Verify signed Skill Passports and read your learning data through the same
                    read-only tools exposed to AI agents.
                  </p>
                </div>
              </div>
              <Suspense fallback={<WorkspaceLoading />}><McpConsole /></Suspense>
            </>
          )}
          {section === "agent" && (
            <>
              <div className="page-title">
                <div>
                  <span className="eyebrow">Agent platform · Copilot</span>
                  <h1>AI Copilot</h1>
                  <p>
                    Run your career coach, inspect telemetry and review every draft before you
                    use it.
                  </p>
                </div>
              </div>
              <Suspense fallback={<WorkspaceLoading />}><AgentConsole /></Suspense>
            </>
          )}
          {section === "privacy" && (
            <>
              <div className="page-title">
                <div>
                  <span className="eyebrow">{t("settingsPageKicker")}</span>
                  <h1>{t("settingsPageTitle")}</h1>
                  <p>{t("settingsPageHelp")}</p>
                </div>
              </div>
              <CandidateAccountSettings st={st} onEditProfile={() => go("profile")} />
              <DataRights />
              <section className="portal-panel">
                <h2>Privacy basics</h2>
                <ul className="privacy-list">
                  <li>Review CV-extracted skills before confirming them.</li>
                  <li>
                    Assessment integrity signals are review signals, not
                    automatic proof of misconduct.
                  </li>
                  <li>
                    Sharing results with an employer is optional and revocable.
                  </li>
                </ul>
              </section>
            </>
          )}
        </div>
        {interviewInvite && (
          <Suspense fallback={<WorkspaceLoading label="Loading interview" />}>
            <VoiceInterview
              invite={interviewInvite}
              onExit={() => {
                setInterviewInvite(null);
                refresh();
              }}
              onFinished={refresh}
            />
          </Suspense>
        )}
        <footer className="candidate-footer">
          <span>TalentForge Candidate Workspace</span>
          <span>Build skills. Show evidence. Keep growing.</span>
        </footer>
      </main>
    </div>
  );
}
function ProfileJourneyRouter({ st, refresh, onEditProfile, tick, v, setV }) {
  return (
    <>
      {v === "profile" && (
        <Profile
          st={st}
          onEditProfile={onEditProfile}
          onDone={async () => {
            await refresh();
            setV("assess");
          }}
        />
      )}
      {v === "gap" && (
        <Gap
          st={st}
          refreshKey={tick}
          onStart={() => setV("learn")}
          actionLabel="Continue to learning path"
        />
      )}
      {v === "assess" && (
        <Exam
          kind="pre"
          st={st}
          refresh={refresh}
          afterResult={() => setV("gap")}
          afterLabel="View results & gap"
        />
      )}
      {v === "learn" && <Learn onNext={() => setV("retest")} />}
      {v === "retest" && (
        <Exam
          kind="post"
          st={st}
          refresh={refresh}
          afterResult={() => setV("passport")}
          afterLabel="Skill Passport"
        />
      )}
      {v === "passport" && <Passport st={st} refresh={refresh} />}
    </>
  );
}

/* ---------- shell ---------- */
function Shell({ lang, setLang }) {
  const t = useT();
  const [authed, setAuthed] = useState(!!getToken());
  const [role, setRole] = useState(null);
  const [st, setSt] = useState(null);
  const [view, setView] = useState(null);
  const [tick, setTick] = useState(0);
  const [loadError, setLoadError] = useState("");

  const refresh = useCallback(async () => {
    setLoadError("");
    try {
      const identity = await api("/enterprise/me");
      setRole(identity.role || "candidate");
      const s = await api("/state");
      setSt(s);
      setTick((x) => x + 1);
      return s;
    } catch (e) {
      if (e.status === 401) {
        setToken(null);
        setAuthed(false);
        setRole(null);
      } else setLoadError(e.message || "Could not load your workspace. Check your connection and try again.");
    }
  }, []);
  useEffect(() => {
    if (authed)
      refresh().then((s) => {
        if (!s) return;
        const done = (s.attempts || []).filter((a) => a.status === "done");
        const active = (s.attempts || []).find((a) => a.status === "active");
        setView(
          active
            ? active.kind === "post"
              ? "retest"
              : "assess"
            : !s.confirmed
              ? "profile"
              : done.length === 0
                ? "gap"
                : done.length === 1
                  ? "learn"
                  : "passport",
        );
      });
  }, [authed, refresh]);

  const logout = () => {
    // Revoke the session server-side as well as clearing the local token
    // (SB-003 / AUTH-05).
    api("/auth/logout", { method: "POST" }).catch(() => {});
    setToken(null);
    setAuthed(false);
    setRole(null);
    setSt(null);
    setView(null);
  };
  const Head = (
    <header className={"top" + (authed ? "" : " sb-top-landing")}>
      <a className="brand sb-top-brand" href="#top">
        <span className="sb-brand-mark">S</span>
        <span>
          TalentForge<small>Skills · Evidence · Opportunity</small>
        </span>
      </a>
      {!authed && (
        <nav className="sb-top-nav">
          <a href="#how-it-works">{t("landing").home.navHow}</a>
          <a href="#skill-score">{t("landing").home.navScore}</a>
          <a href="#for-recruiters">{t("landing").home.navRecruiters}</a>
          <a href="#faq">{t("landing").home.navFaq}</a>
        </nav>
      )}
      <span className="grow" />
      <div className="seg" role="group" aria-label="Language">
        <button
          className={lang === "en" ? "on" : ""}
          onClick={() => setLang("en")}
        >
          EN
        </button>
        <button
          className={lang === "bn" ? "on" : ""}
          onClick={() => setLang("bn")}
        >
          বাংলা
        </button>
      </div>
      {authed ? (
        <button className="link" onClick={logout}>
          {t("logout")}
        </button>
      ) : (
        <a className="sb-top-signin" href="#signin">
          {t("landing").tabSignin} <span>→</span>
        </a>
      )}
    </header>
  );

  let body;
  if (!authed) body = <Landing onAuthed={() => setAuthed(true)} />;
  // Admin and company accounts have their own onboarding and do not need the
  // candidate consent/state gate. This also removes a loading flash where the
  // marketing header appeared above the operational panels.
  else if (role === "admin") body = <Suspense fallback={<main className="wrap"><WorkspaceLoading /></main>}><AdminConsole onLogout={logout} /></Suspense>;
  else if (role && role !== "candidate")
    body = <Suspense fallback={<main className="wrap"><WorkspaceLoading /></main>}><HiringWorkspace role={role} onLogout={logout} /></Suspense>;
  else if (!st || !view)
    body = (
      <main className="wrap">
        {loadError ? <section className="card" role="alert"><h2>Your workspace couldn’t load</h2><p>{loadError}</p><div className="row"><button type="button" className="btn" onClick={() => refresh().then((result) => { if (result) setView("profile"); })}>Try again</button><button type="button" className="btn ghost" onClick={logout}>Sign out</button></div></section> : <WorkspaceLoading label={t("loading")} />}
      </main>
    );
  else if (!st.consented)
    body = (
      <main className="wrap">
        <Consent lang={lang} onDone={refresh} />
      </main>
    );
  else
    body = (
      <CandidatePortal
        st={st}
        refresh={refresh}
        tick={tick}
        setTick={setTick}
        onLogout={logout}
      />
    );
  // Authenticated workspaces own their full-viewport shell (sidebar + topbar).
  // Rendering the marketing header as well caused duplicate sign-out controls
  // and pushed the three panels to different heights.
  const modernWorkspace = authed && !!role;
  return (
    <>
      {!modernWorkspace && Head}

      {body}
    </>
  );
}

export default function App() {
  const [lang, setLang] = useState(localStorage.getItem("sb_lang") || "en");
  const [hash, setHash] = useState(location.hash);
  useEffect(() => {
    localStorage.setItem("sb_lang", lang);
    document.documentElement.lang = lang;
  }, [lang]);
  useEffect(() => {
    const h = () => setHash(location.hash);
    window.addEventListener("hashchange", h);
    return () => window.removeEventListener("hashchange", h);
  }, []);
  const m = hash.match(/^#\/p\/([\w-]+)/);
  const resetRoute = /^#\/reset-password/.test(hash);
  return (
    <ErrorBoundary>
      <LangCtx.Provider value={lang}>
        <LangSetCtx.Provider value={setLang}>
          {resetRoute ? (
            <PasswordReset key={hash} hash={hash} />
          ) : m ? (
            <PublicPassport id={m[1]} />
          ) : (
            <Shell lang={lang} setLang={setLang} />
          )}
        </LangSetCtx.Provider>
      </LangCtx.Provider>
    </ErrorBoundary>
  );
}

/* ---------- error boundary (SB-005) ---------- */
class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    // Keep the console useful for the team without shipping stack traces to users.
    console.error("TalentForge UI error", error, info?.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <main className="wrap">
        <section className="card" role="alert">
          <h2>Something went wrong on this screen.</h2>
          <p>
            Your saved work is not lost. Reload the page to continue. If this
            keeps happening during an assessment, use Quit assessment and tell
            support what you were doing.
          </p>
          <div className="row">
            <button className="btn" onClick={() => location.reload()}>
              Reload the page
            </button>
            <button
              className="btn ghost"
              onClick={() => {
                setToken(null);
                location.hash = "";
                location.reload();
              }}
            >
              Sign out and start over
            </button>
          </div>
        </section>
      </main>
    );
  }
}
