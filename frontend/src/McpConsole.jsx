import { useEffect, useMemo, useState } from "react";
import { api } from "./api.js";
import "./mcp-console.css";

/**
 * In-app MCP console (M1 verification + M2 candidate learning).
 *
 * Read-only. Every panel calls the same tool functions the MCP server exposes
 * over stdio and Streamable HTTP (/mcp). Nothing here changes a score.
 */
export default function McpConsole() {
  const [status, setStatus] = useState(null);
  const [statusErr, setStatusErr] = useState("");

  const [passport, setPassport] = useState("");
  const [verifyResult, setVerifyResult] = useState(null);
  const [verifyBusy, setVerifyBusy] = useState(false);
  const [verifyErr, setVerifyErr] = useState("");

  const [learning, setLearning] = useState(null);
  const [learningBusy, setLearningBusy] = useState(false);
  const [learningErr, setLearningErr] = useState("");

  const [topic, setTopic] = useState("sql");
  const [practice, setPractice] = useState(null);
  const [practiceBusy, setPracticeBusy] = useState(false);
  const [practiceErr, setPracticeErr] = useState("");

  useEffect(() => {
    let alive = true;
    api("/mcp/status")
      .then((data) => alive && setStatus(data))
      .catch((e) => alive && setStatusErr(e.message || "Could not load MCP status"));
    return () => {
      alive = false;
    };
  }, []);

  const weakTopics = learning?.weak_topics?.weak_topics || [];
  const topicOptions = useMemo(() => {
    const seen = new Map();
    for (const row of weakTopics) {
      seen.set(row.skill, row.name || row.skill);
    }
    for (const [id, name] of [
      ["sql", "SQL"],
      ["python", "Python"],
      ["statistics", "Statistics"],
      ["visualization", "Data Visualization"],
      ["git", "Git"],
      ["ai_ml", "AI & Machine Learning"],
    ]) {
      if (!seen.has(id)) seen.set(id, name);
    }
    return Array.from(seen.entries()).map(([id, label]) => ({ id, label }));
  }, [weakTopics]);

  useEffect(() => {
    if (topicOptions.length && !topicOptions.some((option) => option.id === topic)) {
      setTopic(topicOptions[0].id);
    }
  }, [topicOptions, topic]);

  const runVerify = async (event) => {
    event.preventDefault();
    setVerifyBusy(true);
    setVerifyErr("");
    setVerifyResult(null);
    try {
      setVerifyResult(await api("/mcp/verify", { method: "POST", body: { passport_id: passport } }));
    } catch (err) {
      setVerifyErr(err.message || "Verification failed");
    } finally {
      setVerifyBusy(false);
    }
  };

  const loadLearning = async () => {
    setLearningBusy(true);
    setLearningErr("");
    try {
      setLearning(await api("/mcp/learning"));
    } catch (err) {
      setLearningErr(err.message || "Could not load learning data");
    } finally {
      setLearningBusy(false);
    }
  };

  const loadPractice = async () => {
    setPracticeBusy(true);
    setPracticeErr("");
    setPractice(null);
    try {
      setPractice(await api("/mcp/practice", { method: "POST", body: { topic, count: 5 } }));
    } catch (err) {
      setPracticeErr(err.message || "Could not load practice questions");
    } finally {
      setPracticeBusy(false);
    }
  };

  const enabled = Boolean(status?.enabled);
  const httpPath = status?.transports?.http || "/mcp";

  return (
    <div className="mcp-console">
      <section className={`mcp-hero ${enabled ? "is-on" : "is-off"}`}>
        <div className="mcp-hero-main">
          <span className="mcp-kicker">MODEL CONTEXT PROTOCOL · READ-ONLY</span>
          <h2>SkillBridge MCP</h2>
          <p>
            Any MCP-compatible AI host (Claude Desktop, Cursor, an HR agent) can discover these
            tools and read verified skills and learning data. No tool writes to scores, marks or
            publication state.
          </p>
          <div className="mcp-hero-tags">
            <span className={`mcp-pill ${enabled ? "ok" : "muted"}`}>
              {enabled ? "● Transport enabled" : "○ Transport disabled"}
            </span>
            <span className="mcp-pill">stdio: python -m mcp_server</span>
            <span className="mcp-pill">HTTP: {httpPath}</span>
          </div>
        </div>
        <div className="mcp-hero-stat">
          <b>{status?.tools?.length ?? "—"}</b>
          <span>tools</span>
          <b>{status?.resources?.length ?? 2}</b>
          <span>resources</span>
        </div>
      </section>

      {statusErr && <p className="mcp-error">{statusErr}</p>}

      {status && !enabled && (
        <p className="mcp-note">
          The MCP transport is disabled (<code>MCP_ENABLED=false</code>). Set{" "}
          <code>MCP_ENABLED=true</code> and restart the backend to expose it. The panels below stay
          read-only either way.
        </p>
      )}

      <section className="mcp-section">
        <header className="mcp-section-head">
          <h3>Tool registry</h3>
          <span className="mcp-sub">discoverable over MCP</span>
        </header>
        <div className="mcp-tools">
          {(status?.tools || []).map((tool) => (
            <article className="mcp-tool" key={tool.name}>
              <div className="mcp-tool-top">
                <code>{tool.name}</code>
                <span className={`mcp-auth ${tool.auth === "public" ? "pub" : "auth"}`}>
                  {tool.auth === "public" ? "public" : "signed-in"}
                </span>
              </div>
              <p>{tool.description}</p>
              <span className="mcp-surface">{tool.surface}</span>
            </article>
          ))}
        </div>
      </section>

      <section className="mcp-section">
        <header className="mcp-section-head">
          <h3>Verify a Skill Passport</h3>
          <span className="mcp-sub">tool: verify_passport · public</span>
        </header>
        <form className="mcp-form" onSubmit={runVerify}>
          <input
            type="text"
            value={passport}
            onChange={(e) => setPassport(e.target.value)}
            placeholder="Passport id or share link (…#/p/…)"
            aria-label="Passport id or share link"
          />
          <button className="mcp-btn" type="submit" disabled={verifyBusy || !passport.trim()}>
            {verifyBusy ? "Verifying…" : "Verify"}
          </button>
        </form>
        {verifyErr && <p className="mcp-error">{verifyErr}</p>}
        {verifyResult && <VerifyResult result={verifyResult} />}
      </section>

      <section className="mcp-section">
        <header className="mcp-section-head">
          <h3>My learning data</h3>
          <span className="mcp-sub">tools: my_weak_topics · learning_path</span>
        </header>
        <button className="mcp-btn" type="button" onClick={loadLearning} disabled={learningBusy}>
          {learningBusy ? "Loading…" : "Load my weak topics & learning path"}
        </button>
        {learningErr && <p className="mcp-error">{learningErr}</p>}
        {learning && <LearningResult data={learning} />}
      </section>

      <section className="mcp-section">
        <header className="mcp-section-head">
          <h3>Practice questions</h3>
          <span className="mcp-sub">tool: practice_questions · answers withheld</span>
        </header>
        <div className="mcp-form">
          <select value={topic} onChange={(e) => setTopic(e.target.value)} aria-label="Practice topic">
            {topicOptions.map((option) => (
              <option value={option.id} key={option.id}>
                {option.label}
              </option>
            ))}
          </select>
          <button className="mcp-btn" type="button" onClick={loadPractice} disabled={practiceBusy}>
            {practiceBusy ? "Loading…" : "Get 5 questions"}
          </button>
        </div>
        {practiceErr && <p className="mcp-error">{practiceErr}</p>}
        {practice && <PracticeResult data={practice} />}
      </section>

      <p className="mcp-foot">
        This console mirrors the real MCP tools for visibility. External agents use{" "}
        <code>{httpPath}</code> (Streamable HTTP) or the stdio entrypoint. Scores always come from
        stored answer keys in <code>engine.py</code>.
      </p>
    </div>
  );
}

function VerifyResult({ result }) {
  if (!result.found) {
    return (
      <div className="mcp-result warn">
        <b>Not verified.</b> {result.reason === "not_found" ? "No passport matches that id." : result.reason}
      </div>
    );
  }
  const passport = result.passport || {};
  const skills = passport.skills || [];
  if (result.revoked) {
    return (
      <div className="mcp-result warn">
        <b>Passport revoked{result.review_required ? " · review required" : ""}.</b> Signature{" "}
        {result.signature_valid ? "valid" : "invalid"}. Do not treat it as current proof.
      </div>
    );
  }
  return (
    <div className="mcp-result ok">
      <div className="mcp-result-head">
        <b>Signature valid</b>
        <span>{passport.holder || "Verified holder"}</span>
        {passport.expires ? <span className="mcp-muted">expires {passport.expires}</span> : null}
      </div>
      {skills.length ? (
        <ul className="mcp-skills">
          {skills.map((skill) => (
            <li key={skill.skill}>
              <span>{skill.name || skill.skill}</span>
              <b>{skill.score}/100</b>
              {skill.level ? <em>{skill.level}</em> : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="mcp-muted">No scored skills in this passport.</p>
      )}
    </div>
  );
}

function LearningResult({ data }) {
  const weak = data.weak_topics?.weak_topics || [];
  const path = data.learning_path || {};
  return (
    <div className="mcp-result">
      <div className="mcp-result-head">
        <b>Weak topics</b>
        <span className="mcp-muted">
          {data.weak_topics?.has_result ? "from your latest result" : "no completed result yet"}
        </span>
      </div>
      {weak.length ? (
        <ul className="mcp-skills">
          {weak.map((row) => (
            <li key={row.skill}>
              <span>{row.name || row.skill}</span>
              <b>{row.score == null ? "unverified" : `${row.score}/100`}</b>
              <em>{row.status}</em>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mcp-muted">Nothing below threshold right now.</p>
      )}

      <div className="mcp-result-head" style={{ marginTop: 14 }}>
        <b>Learning path</b>
        <span className="mcp-muted">{path.available ? `${(path.items || []).length} resources` : path.reason || "unavailable"}</span>
      </div>
      {path.available && (path.items || []).length ? (
        <ul className="mcp-resources">
          {path.items.map((item, index) => (
            <li key={`${item.title || item.topic}-${index}`}>
              {item.none ? (
                <span className="mcp-muted">No curated resource yet for {item.topic}</span>
              ) : (
                <>
                  <a href={item.url} target="_blank" rel="noreferrer">
                    {item.title || item.topic}
                  </a>
                  <span className="mcp-muted">
                    {[item.topic, item.source, item.licence].filter(Boolean).join(" · ")}
                  </span>
                </>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="mcp-muted">{path.note || "Learning path unlocks after an approved result."}</p>
      )}
    </div>
  );
}

function PracticeResult({ data }) {
  if (!data.questions?.length) {
    return <div className="mcp-result warn">No approved questions for that topic yet.</div>;
  }
  return (
    <div className="mcp-result">
      <div className="mcp-result-head">
        <b>{data.count} question{data.count === 1 ? "" : "s"}</b>
        <span className="mcp-muted">answers intentionally withheld</span>
      </div>
      <ol className="mcp-questions">
        {data.questions.map((question) => (
          <li key={question.id}>
            <p>{question.question_text}</p>
            <span className="mcp-muted">
              {[question.question_type, question.difficulty_level, question.time_allocation ? `${question.time_allocation}s` : null]
                .filter(Boolean)
                .join(" · ")}
            </span>
            {Array.isArray(question.options) && question.options.length ? (
              <ul className="mcp-options">
                {question.options.map((option, index) => (
                  <li key={`${question.id}-${index}`}>{option}</li>
                ))}
              </ul>
            ) : null}
          </li>
        ))}
      </ol>
    </div>
  );
}
