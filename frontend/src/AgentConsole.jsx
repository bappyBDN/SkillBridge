import { useEffect, useRef, useState } from "react";
import { api } from "./api.js";
import "./agent-console.css";

/**
 * Native in-app copilot (candidate · company · admin).
 *
 * Talks to the existing read-only `/api/agent/*` endpoints. The UI is a chat:
 * type (or tap a suggestion), the agent runs, and the reply is rendered as
 * human-readable cards — never raw JSON. Every output is a draft awaiting human
 * approval. The standalone `public/agent-console.html` stays as a fallback.
 */

const INTENT_INFO = {
  study_plan: {
    label: "Study plan",
    prompt: "Build me a week-by-week study plan from my latest results.",
    placeholder: "Ask for a study plan…",
    fallback: "I can turn your verified gaps into a week-by-week plan.",
  },
  gap_explain: {
    label: "Skill gaps",
    prompt: "Explain what's verified and what I should close first.",
    placeholder: "Ask what to improve next…",
    fallback: "I can compare what is verified with what needs work.",
  },
  practice_hint: {
    label: "Practice questions",
    prompt: "Give me 3 practice questions on Python.",
    placeholder: "e.g. Give me 3 practice questions on SQL…",
    fallback: "I can pull approved practice questions — answers stay hidden.",
  },
  application_draft: {
    label: "Application note",
    ask: "Paste the job ID and I'll draft a note from your verified skills.",
    placeholder: "Draft an application note for job <job id>…",
    fallback: "Share a job ID and I'll draft the note.",
  },
  job_skills: {
    label: "Job → skills",
    ask: "Paste the job description and I'll map it to the skill taxonomy.",
    placeholder: "Paste a job description here…",
    fallback: "Paste a job description to map required skills.",
  },
  shortlist: {
    label: "Shortlist",
    prompt: "Show my consenting applicants with verified evidence.",
    placeholder: "Ask for a shortlist…",
    fallback: "I can list consenting applicants with verified evidence.",
  },
  evidence_summary: {
    label: "Evidence summary",
    prompt: "Summarise the verified evidence for my applicants.",
    placeholder: "Ask for an evidence summary…",
    fallback: "I can summarise verified evidence for consenting applicants.",
  },
  feedback_draft: {
    label: "Feedback draft",
    ask: "Paste the application ID and I'll draft neutral feedback.",
    placeholder: "Draft feedback for application <application id>…",
    fallback: "Share an application ID and I'll draft feedback.",
  },
  question_coverage: {
    label: "Coverage report",
    prompt: "Which skills still need approved questions?",
    placeholder: "Ask about question-bank coverage…",
    fallback: "I can report which skills still need approved questions.",
  },
  question_draft: {
    label: "Draft questions",
    prompt: "Draft 3 Python questions for the bank.",
    placeholder: "e.g. Draft 3 questions on Docker…",
    fallback: "I can draft questions for a skill; they wait for approval.",
  },
  integrity_summary: {
    label: "Integrity summary",
    ask: "Paste the attempt ID and I'll summarise the integrity signals (advisory).",
    placeholder: "Summarise integrity for attempt <attempt id>…",
    fallback: "Share an attempt ID and I'll summarise its signals — advisory only.",
  },
};

const TOPIC_ALIASES = [
  ["ai_ml", ["machine learning", "ml", "ai", "llm", "rag"]],
  ["visualization", ["power bi", "tableau", "dashboard", "visualisation", "visualization"]],
  ["statistics", ["statistics", "stats", "probability"]],
  ["python", ["python", "pandas"]],
  ["sql", ["sql", "mysql", "postgres"]],
  ["git", ["git", "github"]],
  ["docker", ["docker", "container"]],
  ["javascript", ["javascript", "react", "typescript"]],
  ["java", ["java", "spring"]],
  ["networking", ["network", "tcp", "dns"]],
  ["excel", ["excel", "spreadsheet"]],
  ["communication", ["communication", "presentation"]],
];

let seq = 0;
const nextId = () => `m${++seq}`;
const pretty = (value) => {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
};
const humanize = (key) =>
  String(key)
    .replaceAll("_", " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());

function extractId(text) {
  const keyed = text.match(/(?:job|application|attempt|id)[^\w]{0,8}([A-Za-z0-9][\w-]{3,})/i);
  if (keyed) return keyed[1];
  const token = text.match(/\b[A-Za-z0-9][\w-]{7,}\b/);
  return token ? token[0] : "";
}

function extractTopic(text) {
  const lower = text.toLowerCase();
  for (const [id, words] of TOPIC_ALIASES) {
    if (words.some((word) => lower.includes(word))) return id;
  }
  return "";
}

function extractCount(text, fallback = 3) {
  const match = text.match(/(\d+)\s*(?:question|questions|practice|items)?/i);
  if (!match) return fallback;
  return Math.max(1, Math.min(10, Number(match[1])));
}

function detectIntent(text, allowed) {
  const lower = text.toLowerCase();
  const rules = [
    [/study|plan|schedule|week/, "study_plan"],
    [/gap|verified|unverified|weak|improve/, "gap_explain"],
    [/draft.*question|new question|generate.*question|draft.*item/, "question_draft"],
    [/practice|quiz|exercise/, "practice_hint"],
    [/application|cover note|apply/, "application_draft"],
    [/job description|\bjd\b|map|skills for/, "job_skills"],
    [/shortlist|applicants|candidates/, "shortlist"],
    [/evidence|summar/, "evidence_summary"],
    [/feedback/, "feedback_draft"],
    [/coverage|question bank|bank/, "question_coverage"],
    [/integrity|honesty|flag|review/, "integrity_summary"],
  ];
  for (const [pattern, id] of rules) {
    if (pattern.test(lower) && allowed.includes(id)) return id;
  }
  return allowed[0] || "";
}

function buildPayload(intent, text) {
  if (intent === "job_skills") return { description: text };
  if (intent === "practice_hint") return { topic: extractTopic(text) || "python", count: extractCount(text) };
  if (intent === "question_draft") return { skill: extractTopic(text) || "python", count: extractCount(text) };
  if (intent === "application_draft") return { job_id: extractId(text) };
  if (intent === "feedback_draft") return { application_id: extractId(text) };
  if (intent === "integrity_summary") return { attempt_id: extractId(text) };
  return {};
}

function missingRequirement(intent, payload) {
  if (intent === "application_draft" && !payload.job_id) return "job ID";
  if (intent === "feedback_draft" && !payload.application_id) return "application ID";
  if (intent === "integrity_summary" && !payload.attempt_id) return "attempt ID";
  if (intent === "job_skills" && !(payload.description || "").trim()) return "job description";
  return "";
}

export default function AgentConsole() {
  const [status, setStatus] = useState(null);
  const [statusError, setStatusError] = useState("");
  const [loading, setLoading] = useState(true);

  const [messages, setMessages] = useState([]);
  const [draft, setDraft] = useState("");
  const [intent, setIntent] = useState("");
  const [pinned, setPinned] = useState(false);
  const [running, setRunning] = useState(false);

  const [queue, setQueue] = useState(null);
  const [queueError, setQueueError] = useState("");
  const [artifactBusy, setArtifactBusy] = useState("");

  const endRef = useRef(null);
  const composerRef = useRef(null);

  const loadQueue = async () => {
    try {
      setQueue(await api("/agent/artifacts?status=pending_approval"));
      setQueueError("");
    } catch (e) {
      setQueueError(e.message || "Could not load the approval queue.");
    }
  };

  useEffect(() => {
    let alive = true;
    api("/agent/status")
      .then((data) => {
        if (!alive) return;
        setStatus(data);
        const first = (data.intents || [])[0] || "";
        setIntent(first);
        setMessages([
          {
            id: nextId(),
            role: "assistant",
            text:
              data.enabled === false
                ? "The copilot is currently disabled on this deployment. You can still review the approval queue."
                : `Hi — I'm your ${data.role || "workspace"} copilot. ${INTENT_INFO[first]?.fallback || "What would you like to do?"}`,
          },
        ]);
        if (data.enabled) loadQueue();
      })
      .catch((e) => {
        if (!alive) return;
        setStatusError(
          e.status === 401 ? "Sign in to use the copilot." : e.message || "Could not load the copilot.",
        );
      })
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [messages, running]);

  const push = (message) => setMessages((current) => [...current, { id: nextId(), ...message }]);

  const pickSuggestion = (id) => {
    setIntent(id);
    setPinned(true);
    setDraft(INTENT_INFO[id]?.prompt || INTENT_INFO[id]?.ask || "");
    composerRef.current?.focus();
  };

  const send = async () => {
    const text = draft.trim();
    if (!text || running || !status) return;
    const allowed = status.intents || [];
    const detected = detectIntent(text, allowed);
    const effectiveIntent =
      pinned && allowed.includes(intent)
        ? intent
        : detected || (allowed.includes(intent) ? intent : allowed[0] || "");
    setPinned(false);
    const payload = buildPayload(effectiveIntent, text);

    push({ role: "user", text });
    setDraft("");

    const missing = missingRequirement(effectiveIntent, payload);
    if (missing) {
      push({
        role: "assistant",
        text: `I need the ${missing} to run this. ${INTENT_INFO[effectiveIntent]?.ask || "Please include it in your message."}`,
      });
      return;
    }

    setRunning(true);
    try {
      const result = await api("/agent/run", { method: "POST", body: { intent: effectiveIntent, payload } });
      push({
        role: "assistant",
        text: result.summary || "Done.",
        result,
      });
      if (status.enabled) loadQueue();
    } catch (e) {
      const friendly =
        e.status === 422
          ? "That request doesn't match an intent available to your role. Try one of the suggestions."
          : e.status === 503
            ? "The agent platform is disabled on this deployment."
            : e.message || "I couldn't complete that request.";
      push({ role: "assistant", text: friendly, error: true });
    } finally {
      setRunning(false);
    }
  };

  const onKeyDown = (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      send();
    }
  };

  const decide = async (artifact, action) => {
    setArtifactBusy(artifact.id);
    try {
      if (action === "approve") {
        await api(`/agent/artifacts/${artifact.id}/approve`, { method: "POST" });
      } else {
        await api(`/agent/artifacts/${artifact.id}`, { method: "DELETE" });
      }
      await loadQueue();
    } catch (e) {
      setQueueError(e.message || "Could not update that draft.");
    } finally {
      setArtifactBusy("");
    }
  };

  const intents = status?.intents || [];
  const budget = status?.ai_budget;
  const activeInfo = INTENT_INFO[intent] || {};

  return (
    <div className="copilot">
      <section className="copilot-hero">
        <div className={`copilot-orb ${running ? "thinking" : ""}`} aria-hidden="true">
          <span>AI</span>
        </div>
        <div className="copilot-hero-copy">
          <span className="copilot-kicker">AGENT PLATFORM · HUMAN-IN-THE-LOOP</span>
          <h2>SkillBridge Copilot</h2>
          <p>
            Ask in plain language. I run the read-only agent tools, show what I used, and
            leave every draft for your approval. Nothing changes a score.
          </p>
          <div className="copilot-pills">
            <span className="copilot-pill">{status?.role || "…"}</span>
            <span className={`copilot-pill ${status?.enabled ? "good" : "muted"}`}>
              {status?.enabled ? "online" : "disabled"}
            </span>
            {budget && (
              <span className={`copilot-pill ${budget.exhausted ? "warn" : ""}`}>
                AI budget ${Number(budget.spent_usd || 0).toFixed(3)} / ${Number(budget.limit_usd || 0).toFixed(2)}
              </span>
            )}
          </div>
        </div>
        <button
          className="copilot-new"
          type="button"
          onClick={() => {
            setMessages([
              {
                id: nextId(),
                role: "assistant",
                text: `Fresh start. ${INTENT_INFO[intent]?.fallback || "What would you like to do?"}`,
              },
            ]);
            setDraft("");
          }}
        >
          New chat
        </button>
      </section>

      {loading && <p className="copilot-note">Loading your copilot…</p>}
      {statusError && <p className="copilot-error">{statusError}</p>}

      <div className="copilot-layout">
        <section className="copilot-chat">
          <div className="copilot-thread" aria-live="polite">
            {messages.map((message) => (
              <div className={`copilot-msg ${message.role}${message.error ? " is-error" : ""}`} key={message.id}>
                {message.role === "assistant" && <div className="copilot-avatar">AI</div>}
                <div className="copilot-bubble">
                  <p>{message.text}</p>
                  {message.result && <RunCard result={message.result} />}
                </div>
              </div>
            ))}
            {running && (
              <div className="copilot-msg assistant">
                <div className="copilot-avatar">AI</div>
                <div className="copilot-bubble copilot-typing">
                  <i />
                  <i />
                  <i />
                  <span>Working…</span>
                </div>
              </div>
            )}
            <div ref={endRef} />
          </div>

          {status?.enabled && (
            <div className="copilot-composer">
              <div className="copilot-suggestions">
                {intents.map((id) => (
                  <button
                    key={id}
                    type="button"
                    className={`copilot-chip ${intent === id ? "on" : ""}`}
                    onClick={() => pickSuggestion(id)}
                  >
                    {INTENT_INFO[id]?.label || id}
                  </button>
                ))}
              </div>
              <div className="copilot-inputrow">
                <textarea
                  ref={composerRef}
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={onKeyDown}
                  rows={1}
                  placeholder={activeInfo.placeholder || "Ask the copilot…"}
                  aria-label="Message the copilot"
                />
                <button className="copilot-send" type="button" onClick={send} disabled={running || !draft.trim()}>
                  {running ? "…" : "Send"}
                </button>
              </div>
              <p className="copilot-hint">
                Enter to send · Shift+Enter for a new line · drafts wait for human approval
              </p>
            </div>
          )}
        </section>

        <aside className="copilot-side">
          <div className="copilot-side-head">
            <h3>
              Approval queue {queue?.count ? <span className="copilot-count">{queue.count}</span> : null}
            </h3>
            <button className="copilot-refresh" type="button" onClick={loadQueue}>
              Refresh
            </button>
          </div>
          {queueError && <p className="copilot-error">{queueError}</p>}
          {!queue && !queueError && <p className="copilot-note">Loading drafts…</p>}
          {queue && queue.count === 0 && (
            <p className="copilot-note">No drafts waiting. Run the copilot to create one.</p>
          )}
          <div className="copilot-queue">
            {(queue?.items || []).map((artifact) => (
              <HumanArtifact
                key={artifact.id}
                artifact={artifact}
                actions={
                  <>
                    <button
                      className="copilot-accept"
                      type="button"
                      disabled={artifactBusy === artifact.id}
                      onClick={() => decide(artifact, "approve")}
                    >
                      Approve
                    </button>
                    <button
                      className="copilot-reject"
                      type="button"
                      disabled={artifactBusy === artifact.id}
                      onClick={() => decide(artifact, "reject")}
                    >
                      Reject
                    </button>
                  </>
                }
              />
            ))}
          </div>
        </aside>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ run card */
function RunCard({ result }) {
  const artifacts = result.artifacts || [];
  const data = result.data || {};
  return (
    <div className="copilot-run">
      <div className="copilot-telemetry">
        <span className={result.status === "ok" ? "ok" : "bad"}>
          {result.status === "ok" ? "completed" : "failed"}
        </span>
        <span>{result.usage?.tool_calls ?? 0} tool call(s)</span>
        <span>{result.usage?.latency_ms ?? 0} ms</span>
        <span>
          {result.usage?.tokens_in ?? 0} in / {result.usage?.tokens_out ?? 0} out tokens
        </span>
      </div>
      {artifacts.map((artifact) => (
        <HumanArtifact key={artifact.id} artifact={artifact} />
      ))}
      {artifacts.length === 0 && <HumanData data={data} />}
      <details className="copilot-details">
        <summary>Technical details</summary>
        <pre>{pretty({ tool_calls: result.tool_calls, usage: result.usage, data })}</pre>
      </details>
    </div>
  );
}

/* ------------------------------------------------------------------ artifacts */
function HumanArtifact({ artifact, actions }) {
  return (
    <article className="copilot-artifact">
      <header>
        <span className="copilot-kind">{humanize(artifact.kind)}</span>
        <span className={`copilot-badge ${artifact.status}`}>{humanize(artifact.status)}</span>
      </header>
      <h4>{artifact.title}</h4>
      <ArtifactBody kind={artifact.kind} body={artifact.body || {}} />
      {actions && <div className="copilot-artifact-actions">{actions}</div>}
      <details className="copilot-details">
        <summary>Technical details</summary>
        <pre>{pretty(artifact.body)}</pre>
      </details>
    </article>
  );
}

function Chips({ items, empty = "None yet." }) {
  if (!items || !items.length) return <p className="copilot-muted">{empty}</p>;
  return (
    <div className="copilot-taglist">
      {items.map((item, index) => (
        <span key={`${item}-${index}`}>{typeof item === "string" ? item : item.name || item.skill || "—"}</span>
      ))}
    </div>
  );
}

function ArtifactBody({ kind, body }) {
  if (kind === "study_plan") {
    return (
      <div className="copilot-plan">
        {(body.weeks || []).map((week) => (
          <div className="copilot-week" key={week.week}>
            <b>Week {week.week}</b>
            <span>{week.focus}</span>
            <em>{week.target}</em>
          </div>
        ))}
        {(body.resources || []).length > 0 && (
          <>
            <h5>Suggested resources</h5>
            <ul className="copilot-links">
              {body.resources.map((item, index) => (
                <li key={`${item.title || item.topic}-${index}`}>
                  {item.none ? (
                    <span className="copilot-muted">No curated resource yet for {item.topic}</span>
                  ) : (
                    <a href={item.url} target="_blank" rel="noreferrer">
                      {item.title || item.topic}
                    </a>
                  )}
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    );
  }
  if (kind === "gap_explain") {
    return (
      <div className="copilot-columns">
        <div>
          <h5>Verified</h5>
          <Chips items={(body.verified || []).map((v) => v.skill || v.name)} empty="Nothing verified yet." />
        </div>
        <div>
          <h5>Needs work</h5>
          <Chips items={(body.needs_work || []).map((v) => v.name || v.skill)} empty="Nothing below threshold." />
        </div>
        {(body.fastest_path || []).length > 0 && (
          <div className="copilot-span">
            <h5>Fastest path</h5>
            <ul className="copilot-bullets">
              {body.fastest_path.map((line, index) => (
                <li key={index}>{line}</li>
              ))}
            </ul>
          </div>
        )}
      </div>
    );
  }
  if (kind === "application_answer") {
    return (
      <>
        <p className="copilot-body-text">{body.cover_note}</p>
        <h5>Verified skills mentioned</h5>
        <Chips items={body.verified_skills || []} empty="No verified skills yet." />
      </>
    );
  }
  if (kind === "job_skills") {
    return (
      <>
        <h5>Mapped skills</h5>
        <Chips items={body.skills || []} empty="No taxonomy skills detected." />
        {body.suggested_thresholds && (
          <>
            <h5>Suggested thresholds</h5>
            <div className="copilot-taglist">
              {Object.entries(body.suggested_thresholds).map(([id, value]) => (
                <span key={id}>
                  {id.replaceAll("_", " ")} ≥ {value}%
                </span>
              ))}
            </div>
          </>
        )}
      </>
    );
  }
  if (kind === "shortlist") {
    const rows = body.shortlist || [];
    if (!rows.length) return <p className="copilot-muted">No consenting applicants with a result yet.</p>;
    return (
      <div className="copilot-candidates">
        {rows.map((row) => (
          <div className="copilot-candidate" key={row.application_id || row.candidate_id}>
            <div>
              <b>{row.job_title || "Role"}</b>
              <small>candidate #{row.candidate_id}</small>
            </div>
            <strong>{row.overall ?? "—"}</strong>
            <em>{row.level || ""}</em>
          </div>
        ))}
      </div>
    );
  }
  if (kind === "feedback") {
    return <p className="copilot-body-text">{body.feedback}</p>;
  }
  if (kind === "integrity_summary") {
    return (
      <>
        <p className="copilot-body-text">{body.summary || body.headline}</p>
        {(body.focus_points || []).length > 0 && (
          <>
            <h5>Review signals</h5>
            <ul className="copilot-bullets">
              {body.focus_points.map((point) => (
                <li key={point.key}>
                  <b>{point.label}</b> — {point.detail}
                </li>
              ))}
            </ul>
          </>
        )}
        {body.flags?.length > 0 && <p className="copilot-muted">Hard flags: {body.flags.join(", ")}</p>}
        <p className="copilot-muted">{body.recommendation}</p>
      </>
    );
  }
  if (kind === "question_drafts") {
    return (
      <div className="copilot-questions">
        {(body.drafts || []).map((draft) => (
          <div className="copilot-question" key={draft.id}>
            <p>{draft.question_text}</p>
            <span className={`copilot-badge ${draft.status}`}>{humanize(draft.status)}</span>
            {draft.validation?.length > 0 && (
              <small>Needs authoring: {draft.validation.join(", ").replaceAll("_", " ")}</small>
            )}
          </div>
        ))}
      </div>
    );
  }
  return <KeyValue value={body} />;
}

function HumanData({ data }) {
  if (!data || Object.keys(data).length === 0) return null;
  if (data.practice?.questions) {
    return (
      <div className="copilot-questions">
        {data.practice.questions.map((question) => (
          <div className="copilot-question" key={question.id}>
            <p>{question.question_text}</p>
            <small>
              {[question.question_type, question.difficulty_level, question.time_allocation ? `${question.time_allocation}s` : null]
                .filter(Boolean)
                .join(" · ")}
            </small>
            {question.options?.length > 0 && (
              <ul className="copilot-options">
                {question.options.map((option, index) => (
                  <li key={index}>{option}</li>
                ))}
              </ul>
            )}
          </div>
        ))}
        <p className="copilot-muted">Answers are intentionally withheld.</p>
      </div>
    );
  }
  if (data.skills || data.gaps) {
    return (
      <>
        <div className="copilot-stats">
          <div>
            <b>{data.covered ?? 0}</b>
            <span>covered</span>
          </div>
          <div>
            <b>{data.pending ?? 0}</b>
            <span>pending</span>
          </div>
        </div>
        {(data.gaps || []).length > 0 && (
          <>
            <h5>Skills still needing questions</h5>
            <Chips items={data.gaps.map((gap) => gap.label || gap.skill_id)} />
          </>
        )}
      </>
    );
  }
  if (data.shortlist) {
    return <ArtifactBody kind="shortlist" body={data} />;
  }
  return <KeyValue value={data} />;
}

function KeyValue({ value }) {
  if (value == null) return null;
  if (Array.isArray(value)) {
    if (!value.length) return <p className="copilot-muted">None.</p>;
    return (
      <ul className="copilot-bullets">
        {value.map((item, index) => (
          <li key={index}>
            <KeyValue value={item} />
          </li>
        ))}
      </ul>
    );
  }
  if (typeof value === "object") {
    return (
      <dl className="copilot-kv">
        {Object.entries(value).map(([key, item]) => (
          <div key={key}>
            <dt>{humanize(key)}</dt>
            <dd>
              <KeyValue value={item} />
            </dd>
          </div>
        ))}
      </dl>
    );
  }
  return <span>{String(value)}</span>;
}
