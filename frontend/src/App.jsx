import { useEffect, useState, useCallback } from "react";
import { api, getToken, setToken } from "./api.js";
import { LangCtx, useT } from "./i18n.js";

const SAMPLE_CV = `Sadia Rahman
House 14, Road 3, Mirpur, Dhaka
sadia.rahman@example.com | +880 1712-345678 | https://github.com/sadia-demo

Education: BSc in Computer Science, final year.
Projects: Sales dashboard in Power BI; customer analysis with pandas and MySQL joins; basic statistics for a class survey.
Skills: SQL, Python, Excel, Git. Presentation and report writing for class projects.
(Synthetic sample CV for demo purposes.)`;

/* ---------- small helpers ---------- */
const STEPS = ["profile", "gap", "assess", "learn", "retest", "passport"];
const fmt = (s) => `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;

function Err({ e }) {
  const t = useT();
  if (!e) return null;
  return <p className="err" role="alert">{t(e.code) !== e.code ? t(e.code) : e.message || t("error")}</p>;
}

function Bar({ score, threshold, unverified }) {
  return (
    <div className={"bar" + (unverified ? " bar-un" : "")} aria-label={unverified ? "unverified" : `${score}%`}>
      {!unverified && <span className="bar-fill" style={{ width: `${score}%` }} />}
      {threshold != null && <span className="bar-tick" style={{ left: `${threshold}%` }} title={`${threshold}%`} />}
    </div>
  );
}

function TrustChip({ trust }) {
  const t = useT();
  const cls = trust === "High" ? "chip-ok" : trust === "Medium" ? "chip-mid" : "chip-rev";
  return <span className={"chip " + cls}>{t("trusts")[trust]}</span>;
}

/* ---------- landing + auth ---------- */
function BridgeRail() {
  const t = useT();
  const xs = [80, 230, 380, 530, 680, 830];
  return (
    <svg className="rail" viewBox="0 0 910 150" role="img" aria-label="SkillBridge loop">
      <line x1="30" y1="86" x2="880" y2="86" className="rail-deck" />
      {xs.slice(0, -1).map((x, i) => (
        <path key={i} d={`M${x} 86 Q${(x + xs[i + 1]) / 2} 14 ${xs[i + 1]} 86`} className="rail-cable" />
      ))}
      {xs.map((x, i) => (
        <g key={i}>
          <circle cx={x} cy="86" r="9" className="rail-node" />
          <text x={x} y="116" textAnchor="middle" className="rail-label">{t("loop")[i]}</text>
          <text x={x} y="136" textAnchor="middle" className="rail-sub">{t("loopSub")[i]}</text>
        </g>
      ))}
    </svg>
  );
}

function Landing({ onAuthed }) {
  const t = useT();
  const [mode, setMode] = useState("register");
  const [f, setF] = useState({ name: "", email: "", password: "", role: "candidate" });
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault(); setErr(null); setBusy(true);
    try {
      const r = await api(mode === "register" ? "/auth/register" : "/auth/login", { method: "POST", body: mode === "register" ? f : { email: f.email, password: f.password } });
      setToken(r.token); onAuthed();
    } catch (x) { setErr(x); } finally { setBusy(false); }
  };
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  return (
    <main className="wrap">
      <section className="hero">
        <h1>{t("heroTitle")}</h1>
        <p className="lead">{t("heroSub")}</p>
        <BridgeRail />
      </section>
      <section className="split">
        <form className="card" onSubmit={submit}>
          <h2>{mode === "register" ? t("register") : t("signIn")}</h2>
          {mode === "register" && <label>{t("name")}<input value={f.name} onChange={set("name")} required minLength={2} autoComplete="name" /></label>}
          {mode === "register" && <label>Account type<select value={f.role} onChange={set("role")}><option value="candidate">Candidate / Job seeker</option><option value="company">Company / Recruiter</option></select></label>}
          <label>{t("email")}<input type="email" value={f.email} onChange={set("email")} required autoComplete="email" /></label>
          <label>{t("password")}<input type="password" value={f.password} onChange={set("password")} required minLength={8} autoComplete={mode === "register" ? "new-password" : "current-password"} /></label>
          <Err e={err} />
          <button className="btn" disabled={busy}>{mode === "register" ? t("register") : t("signIn")}</button>
          <button type="button" className="link" onClick={() => setMode(mode === "register" ? "login" : "register")}>{mode === "register" ? t("haveAcct") : t("noAcct")}</button>
        </form>
        <aside className="card quiet">
          <h2>{t("limitsTitle")}</h2>
          <ul>{t("limits").map((x, i) => <li key={i}>{x}</li>)}</ul>
        </aside>
      </section>
    </main>
  );
}

/* ---------- consent ---------- */
function Consent({ lang, onDone }) {
  const t = useT();
  const [ok, setOk] = useState(false);
  const [err, setErr] = useState(null);
  const go = async () => { try { await api("/consent", { method: "POST", body: { lang } }); onDone(); } catch (e) { setErr(e); } };
  return (
    <section className="card narrow">
      <h2>{t("consentTitle")}</h2>
      <ul className="consent">{t("consentItems").map((x, i) => <li key={i}>{x}</li>)}</ul>
      <label className="check"><input type="checkbox" checked={ok} onChange={(e) => setOk(e.target.checked)} /> {t("consentCheck")}</label>
      <Err e={err} />
      <button className="btn" disabled={!ok} onClick={go}>{t("consentBtn")}</button>
    </section>
  );
}

/* ---------- profile: CV -> skills ---------- */
function Profile({ st, onDone }) {
  const t = useT();
  const [text, setText] = useState("");
  const [file, setFile] = useState(null);
  const [res, setRes] = useState(null);
  const [sel, setSel] = useState([]);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);

  const analyse = async () => {
    setErr(null); setBusy(true);
    try {
      const form = new FormData();
      form.append("text", text);
      if (file) form.append("file", file);
      const r = await api("/cv", { method: "POST", form });
      setRes(r); setSel(r.skills.map((s) => s.id));
    } catch (e) { setErr(e); } finally { setBusy(false); }
  };
  const confirm = async () => {
    try { await api("/skills", { method: "PUT", body: { skills: sel } }); onDone(); } catch (e) { setErr(e); }
  };
  const toggle = (id) => setSel(sel.includes(id) ? sel.filter((x) => x !== id) : [...sel, id]);

  return (
    <section>
      <h2>{t("profileTitle")}</h2>
      {st.confirmed && !res && (
        <p className="note">{t("claimed")}: {st.confirmed.join(", ") || "-"}</p>
      )}
      <div className="card">
        <p>{t("cvHelp")}</p>
        <textarea rows={8} value={text} onChange={(e) => setText(e.target.value)} placeholder={t("cvPaste")} />
        <div className="row">
          <input type="file" accept=".pdf,.docx,.txt,.md" onChange={(e) => setFile(e.target.files[0] || null)} />
          <button type="button" className="btn ghost" onClick={() => { setText(SAMPLE_CV); setFile(null); }}>{t("sampleCv")}</button>
          <button className="btn" onClick={analyse} disabled={busy || (!text && !file)}>{t("analyse")}</button>
        </div>
        <Err e={err} />
      </div>

      {res && (
        <>
          <div className="card">
            <h3>{t("redacted")}</h3>
            <p className="chips">
              {Object.entries(res.redaction).map(([k, n]) => <span key={k} className="chip chip-mid">{n} {t("redactedLabels")[k]}</span>)}
            </p>
            <details><summary>{t("preview")}</summary><pre className="pre">{res.redacted_preview}</pre></details>
          </div>
          <div className="card">
            <h3>{t("confirmTitle")}</h3>
            <p className="note">{t("confirmHelp")} ({t("extractedBy")}: {res.source === "llm" ? t("llm") : t("rules")})</p>
            <ul className="skills">
              {res.taxonomy.map((s) => {
                const found = res.skills.find((x) => x.id === s.id);
                return (
                  <li key={s.id}>
                    <label className="check">
                      <input type="checkbox" checked={sel.includes(s.id)} onChange={() => toggle(s.id)} /> <strong>{s.name}</strong>
                      <span className="chip chip-mid">{t("claimed")}</span>
                    </label>
                    {found && <small className="evid">{t("evidence")}: “{found.evidence}”</small>}
                  </li>
                );
              })}
            </ul>
            <button className="btn" onClick={confirm}>{t("confirmBtn")}</button>
          </div>
        </>
      )}
    </section>
  );
}

/* ---------- gap ---------- */
function Gap({ onStart, refreshKey }) {
  const t = useT();
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);
  useEffect(() => { api("/job").then(setD).catch(setErr); }, [refreshKey]);
  if (err) return <Err e={err} />;
  if (!d) return <p>{t("loading")}</p>;
  return (
    <section>
      <h2>{t("gapTitle")}</h2>
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
                <span className="muted">{g.claimed ? t("claimedTag") : t("notClaimed")}</span>
                <span className={"status s-" + g.status}>{t("gs")[g.status]}{g.score != null ? ` · ${g.score}%` : ""}</span>
              </div>
              <Bar score={g.score || 0} threshold={g.threshold} unverified={g.status === "unverified"} />
              <small className="muted">{t("threshold")}: {g.threshold}%</small>
            </li>
          ))}
        </ul>
        <p className="note">{t("gapNote")}</p>
        <p className="muted">{t("preferred")}: {d.job.preferred.map((p) => `${p.name}${p.claimed ? " ✓" : ""}`).join(", ")}</p>
        {onStart && <button className="btn" onClick={onStart}>{t("startTest")}</button>}
      </div>
    </section>
  );
}

/* ---------- exam ---------- */
function ExamRun({ initial, onFinished }) {
  const t = useT();
  const [v, setV] = useState(initial);
  const [ans, setAns] = useState("");
  const [out, setOut] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [left, setLeft] = useState(initial.remaining);
  const aid = v.attempt_id;

  useEffect(() => { const i = setInterval(() => setLeft((x) => Math.max(0, x - 1)), 1000); return () => clearInterval(i); }, []);
  useEffect(() => { setAns(""); setOut(null); }, [v.question?.id]);
  useEffect(() => {
    const onBlur = () => api(`/attempts/${aid}/event`, { method: "POST", body: { type: "blur" } }).catch(() => {});
    window.addEventListener("blur", onBlur);
    return () => window.removeEventListener("blur", onBlur);
  }, [aid]);

  const q = v.question;
  const submit = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await api(`/attempts/${aid}/answer`, { method: "POST", body: { question_id: q.id, answer: String(ans) } });
      setV(r); setLeft(r.remaining);
      if (r.status === "done") onFinished(aid);
    } catch (e) { setErr(e); } finally { setBusy(false); }
  };
  const runSql = async () => { try { setOut(await api(`/attempts/${aid}/sql-run`, { method: "POST", body: { sql: ans } })); } catch (e) { setErr(e); } };
  const onPaste = () => api(`/attempts/${aid}/event`, { method: "POST", body: { type: "paste" } }).catch(() => {});

  if (!q) return <p>{t("loading")}</p>;
  return (
    <section className="card exam">
      <div className="examhead">
        <span>{t("q")} {q.index + 1} {t("of")} {q.total}</span>
        <progress value={q.index} max={q.total} />
        <span className={"timer" + (left < 120 ? " low" : "")}>{t("timeLeft")}: {fmt(left)}</span>
      </div>
      <h3 className="qtext">{q.prompt}</h3>
      {q.type === "mcq" ? (
        <fieldset className="opts">
          {q.options.map((o, i) => (
            <label key={i} className={"opt" + (String(ans) === String(i) ? " on" : "")}>
              <input type="radio" name="opt" checked={String(ans) === String(i)} onChange={() => setAns(String(i))} /> {o}
            </label>
          ))}
        </fieldset>
      ) : (
        <>
          <details open><summary>{t("schema")}</summary><pre className="pre">{q.schema}</pre></details>
          <p className="note">{t("sqlHelp")}</p>
          <textarea className="code" rows={6} spellCheck={false} value={ans} onChange={(e) => setAns(e.target.value)} onPaste={onPaste} placeholder="SELECT ..." />
          <p className="muted">{t("pasteNote")}</p>
          <button className="btn ghost" onClick={runSql} disabled={!ans.trim()}>{t("run")}</button>
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
      <button className="btn" onClick={submit} disabled={busy || String(ans).trim() === ""}>{busy ? t("saving") : t("submit")}</button>
    </section>
  );
}

function Result({ aid, next, nextLabel }) {
  const t = useT();
  const [r, setR] = useState(null);
  const [note, setNote] = useState("");
  const [sent, setSent] = useState(false);
  const [err, setErr] = useState(null);
  useEffect(() => { api(`/attempts/${aid}/result`).then(setR).catch(setErr); }, [aid]);
  if (err) return <Err e={err} />;
  if (!r) return <p>{t("loading")}</p>;
  const sendAppeal = async () => { try { await api(`/attempts/${aid}/appeal`, { method: "POST", body: { note } }); setSent(true); } catch (e) { setErr(e); } };
  return (
    <section>
      <h2>{t("resultTitle")}</h2>
      <div className="card result">
        <div className="bignum"><span>{r.overall}</span><small>%</small></div>
        <dl className="facts">
          <div><dt>{t("level")}</dt><dd>{t("levels")[r.level]}</dd></div>
          <div><dt>{t("trust")}</dt><dd><TrustChip trust={r.trust} /></dd></div>
          <div><dt>{t("date")}</dt><dd>{r.date}</dd></div>
        </dl>
      </div>
      <div className="card">
        <h3>{t("topics")}</h3>
        <ul className="gaps">
          {Object.entries(r.topics).map(([k, v]) => (
            <li key={k}>
              <div className="gaprow"><strong>{k}</strong><span className="muted">{t("levels")[v.level]}</span><span>{v.score}%</span></div>
              <Bar score={v.score} />
            </li>
          ))}
        </ul>
        <p className="muted">{t("percentile")}</p>
      </div>
      <div className="card quiet">
        <p>{t("trustNote")}</p>
        {r.trust_reasons.length > 0 && <ul>{r.trust_reasons.map((x) => <li key={x.key}>{x.n} × {t("reasonLabels")[x.key]}</li>)}</ul>}
        <h3>{t("appealTitle")}</h3>
        {r.appeal || sent ? <p className="note">{t("appealSent")}</p> : (
          <div className="row">
            <input value={note} onChange={(e) => setNote(e.target.value)} placeholder={t("appealPh")} />
            <button className="btn ghost" disabled={note.trim().length < 3} onClick={sendAppeal}>{t("appealBtn")}</button>
          </div>
        )}
      </div>
      {next && <button className="btn" onClick={next}>{nextLabel}</button>}
    </section>
  );
}

function Uplift() {
  const t = useT();
  const [u, setU] = useState(null);
  useEffect(() => { api("/uplift").then(setU).catch(() => {}); }, []);
  if (!u || !u.available) return null;
  return (
    <div className="card">
      <h3>{t("upliftTitle")}</h3>
      <p className="bignum small"><span>{u.overall.delta >= 0 ? "+" : ""}{u.overall.delta}</span><small> pts ({u.overall.pre}% → {u.overall.post}%)</small></p>
      <ul className="gaps">
        {Object.entries(u.topics).map(([k, v]) => (
          <li key={k}>
            <div className="gaprow"><strong>{k}</strong><span>{t("pre")} {v.pre}% → {t("post")} {v.post}%</span><span>{v.delta >= 0 ? "+" : ""}{v.delta}</span></div>
            <Bar score={v.post} threshold={v.pre} />
          </li>
        ))}
      </ul>
      <p className="muted">{t("upliftNote")}</p>
    </div>
  );
}

function Exam({ kind, st, refresh, afterResult, afterLabel }) {
  const t = useT();
  const [active, setActive] = useState(null);
  const [err, setErr] = useState(null);
  const done = st.attempts.filter((a) => a.status === "done");
  const mine = kind === "pre" ? done[0] : done.length > 1 ? done[done.length - 1] : null;
  const act = st.attempts.find((a) => a.status === "active");
  const start = useCallback(async () => {
    setErr(null);
    try { const v = await api("/attempts", { method: "POST" }); if (v.status === "active") setActive(v); else refresh(); } catch (e) { setErr(e); }
  }, [refresh]);
  const finished = async () => { setActive(null); await refresh(); };

  if (active) return <ExamRun initial={active} onFinished={finished} />;
  if (act && (act.kind === kind)) return <section className="card narrow"><button className="btn" onClick={start}>{t("resume")}</button><Err e={err} /></section>;
  if (mine) return (
    <>
      <Result aid={mine.id} next={afterResult} nextLabel={afterLabel} />
      {kind === "post" && <Uplift />}
    </>
  );
  if (kind === "post" && done.length === 0) return <p className="note">{t("needPre")}</p>;
  return (
    <section className="card narrow">
      <h2>{kind === "pre" ? t("startTest") : t("steps").retest}</h2>
      <p>{kind === "pre" ? t("testIntro") : t("retestIntro")}</p>
      <Err e={err} />
      <button className="btn" onClick={start}>{t("startTest")}</button>
    </section>
  );
}

/* ---------- learning path ---------- */
function Learn({ onNext }) {
  const t = useT();
  const [p, setP] = useState(null);
  const [err, setErr] = useState(null);
  useEffect(() => { api("/learning-path").then(setP).catch(setErr); }, []);
  if (err) return <p className="note">{t("needPre")}</p>;
  if (!p) return <p>{t("loading")}</p>;
  const byTopic = {};
  p.items.forEach((i) => (byTopic[i.topic] = [...(byTopic[i.topic] || []), i]));
  return (
    <section>
      <h2>{t("learnTitle")}</h2>
      {p.gaps.length === 0 && <div className="card"><p>{t("learnNone")}</p></div>}
      {Object.entries(byTopic).map(([topic, items]) => (
        <div className="card" key={topic}>
          <h3>{t("learnFor")}: {topic}</h3>
          <ol className="path">
            {items.map((i, n) => i.none ? <li key={n} className="note">{t("noResource")}</li> : (
              <li key={i.id}>
                <a href={i.url} target="_blank" rel="noreferrer noopener">{i.title}</a>
                <small className="muted">{t("source")}: {i.source} · {t("licence")}: {i.licence} · ~{i.minutes} {t("minutes")}</small>
              </li>
            ))}
          </ol>
        </div>
      ))}
      <p className="note">{t("learnNote")}</p>
      <button className="btn" onClick={onNext}>{t("toRetest")}</button>
    </section>
  );
}

/* ---------- passport ---------- */
function Passport({ st, refresh }) {
  const t = useT();
  const [res, setRes] = useState(null);
  const [sel, setSel] = useState([]);
  const [name, setName] = useState(false);
  const [err, setErr] = useState(null);
  const [copied, setCopied] = useState(null);
  const done = st.attempts.filter((a) => a.status === "done");
  const latest = done[done.length - 1];
  useEffect(() => {
    if (latest) api(`/attempts/${latest.id}/result`).then((r) => { setRes(r); setSel(Object.keys(r.topics)); }).catch(setErr);
  }, [latest?.id]);
  const create = async () => { try { await api("/passport", { method: "POST", body: { topics: sel, show_name: name } }); refresh(); } catch (e) { setErr(e); } };
  const revoke = async (id) => { await api(`/passport/${id}`, { method: "DELETE" }); refresh(); };
  const link = (id) => `${location.origin}/#/p/${id}`;
  const copy = async (id) => { try { await navigator.clipboard.writeText(link(id)); setCopied(id); } catch { /* ignore */ } };
  if (!latest) return <p className="note">{t("needVerified")}</p>;
  return (
    <section>
      <h2>{t("passportTitle")}</h2>
      <div className="card">
        <p>{t("passportHelp")}</p>
        {res && <ul className="skills">{Object.entries(res.topics).map(([k, v]) => (
          <li key={k}><label className="check"><input type="checkbox" checked={sel.includes(k)} onChange={() => setSel(sel.includes(k) ? sel.filter((x) => x !== k) : [...sel, k])} /> <strong>{k}</strong> · {v.score}% · {t("levels")[v.level]}</label></li>
        ))}</ul>}
        <label className="check"><input type="checkbox" checked={name} onChange={(e) => setName(e.target.checked)} /> {t("showName")}</label>
        <Err e={err} />
        <button className="btn" onClick={create} disabled={!sel.length}>{t("createPass")}</button>
      </div>
      {st.passports.length > 0 && (
        <div className="card">
          <h3>{t("yourPass")}</h3>
          <ul className="plist">
            {st.passports.map((p) => (
              <li key={p.id}>
                <code>{link(p.id)}</code>
                {p.revoked ? <span className="chip chip-rev">{t("revoked")}</span> : (
                  <span className="row">
                    <a className="btn ghost sm" href={`#/p/${p.id}`} target="_blank" rel="noreferrer">{t("open")}</a>
                    <button className="btn ghost sm" onClick={() => copy(p.id)}>{copied === p.id ? t("copied") : t("copy")}</button>
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
  const exp = async () => {
    const d = await api("/me/export");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([JSON.stringify(d, null, 2)], { type: "application/json" }));
    a.download = "skillbridge-my-data.json"; a.click();
  };
  const del = async () => { if (confirm(t("deleteConfirm"))) { await api("/me", { method: "DELETE" }); setToken(null); location.hash = ""; location.reload(); } };
  return (
    <div className="card quiet">
      <h3>{t("dataRights")}</h3>
      <div className="row"><button className="btn ghost" onClick={exp}>{t("exportData")}</button><button className="btn ghost" onClick={del}>{t("deleteData")}</button></div>
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
  if (d.revoked) return <main className="wrap"><p className="note">{t("passRevoked")}</p></main>;
  const p = d.passport;
  return (
    <main className="wrap">
      <article className="card passport">
        <header>
          <h1>{t("passportTitle")}</h1>
          <span className={"chip " + (d.signature_valid ? "chip-ok" : "chip-rev")}>{d.signature_valid ? t("sigOk") : t("sigBad")}</span>
        </header>
        {d.expired && <p className="err">{t("passExpired")}</p>}
        <dl className="facts">
          <div><dt>{t("holder")}</dt><dd>{p.holder}</dd></div>
          <div><dt>{t("issued")}</dt><dd>{p.issued}</dd></div>
          <div><dt>{t("expires")}</dt><dd>{p.expires}</dd></div>
        </dl>
        <h3>{t("verified")}</h3>
        <ul className="gaps">
          {p.skills.map((s) => (
            <li key={s.skill}>
              <div className="gaprow"><strong>{s.name}</strong><span className="muted">{t("levels")[s.level]} · {s.date}</span><span>{s.score}% <TrustChip trust={s.trust} /></span></div>
              <Bar score={s.score} />
            </li>
          ))}
        </ul>
        {p.uplift && <p className="note">{t("upliftTitle")}: {p.uplift.pre}% → {p.uplift.post}% ({p.uplift.delta >= 0 ? "+" : ""}{p.uplift.delta})</p>}
        <small className="muted">{p.issuer} · {t("mockBanner")}</small>
        <p><a href="#/" className="link">{t("back")}</a></p>
      </article>
    </main>
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

  const refresh = useCallback(async () => {
    try {
      const identity = await api("/enterprise/me");
      setRole(identity.role || "candidate");
      const s = await api("/state"); setSt(s); setTick((x) => x + 1); return s;
    } catch (e) { if (e.status === 401) { setToken(null); setAuthed(false); setRole(null); } }
  }, []);
  useEffect(() => { if (authed) refresh().then((s) => {
    if (!s) return;
    const done = s.attempts.filter((a) => a.status === "done");
    const active = s.attempts.find((a) => a.status === "active");
    setView(active ? (active.kind === "post" ? "retest" : "assess") : !s.confirmed ? "profile" : done.length === 0 ? "gap" : done.length === 1 ? "learn" : "passport");
  }); }, [authed, refresh]);

  const logout = () => { setToken(null); setAuthed(false); setRole(null); setSt(null); setView(null); };
  const Head = (
    <header className="top">
      <strong className="brand">{t("brand")}</strong>
      <span className="grow" />
      <div className="seg" role="group" aria-label="Language">
        <button className={lang === "en" ? "on" : ""} onClick={() => setLang("en")}>EN</button>
        <button className={lang === "bn" ? "on" : ""} onClick={() => setLang("bn")}>বাংলা</button>
      </div>
      {authed && <button className="link" onClick={logout}>{t("logout")}</button>}
    </header>
  );

  let body;
  if (!authed) body = <Landing onAuthed={() => setAuthed(true)} />;
  else if (!st || !view) body = <main className="wrap"><p>{t("loading")}</p></main>;
  else if (!st.consented) body = <main className="wrap"><Consent lang={lang} onDone={refresh} /></main>;
  else {
    const done = st.attempts.filter((a) => a.status === "done");
    body = (
      <main className="wrap">
        <nav className="steps" aria-label="Progress">
          {STEPS.map((s, i) => (
            <button key={s} className={(view === s ? "on " : "") + (done.length === 0 && ["learn", "retest", "passport"].includes(s) ? "dim" : "")} onClick={() => setView(s)}>
              <span className="n">{i + 1}</span>{t("steps")[s]}
            </button>
          ))}
        </nav>
        {view === "profile" && <Profile st={st} onDone={async () => { await refresh(); setView("gap"); }} />}
        {view === "gap" && <Gap refreshKey={tick} onStart={done.length === 0 ? () => setView("assess") : null} />}
        {view === "assess" && <Exam kind="pre" st={st} refresh={refresh} afterResult={() => setView("learn")} afterLabel={t("toLearn")} />}
        {view === "learn" && <Learn onNext={() => setView("retest")} />}
        {view === "retest" && <Exam kind="post" st={st} refresh={refresh} afterResult={() => setView("passport")} afterLabel={t("steps").passport} />}
        {view === "passport" && <Passport st={st} refresh={refresh} />}
      </main>
    );
  }
  return (
    <>
      {Head}
      <div className="mock" role="note">{t("mockBanner")}</div>
      {body}
    </>
  );
}

export default function App() {
  const [lang, setLang] = useState(localStorage.getItem("sb_lang") || "en");
  const [hash, setHash] = useState(location.hash);
  useEffect(() => { localStorage.setItem("sb_lang", lang); document.documentElement.lang = lang; }, [lang]);
  useEffect(() => { const h = () => setHash(location.hash); window.addEventListener("hashchange", h); return () => window.removeEventListener("hashchange", h); }, []);
  const m = hash.match(/^#\/p\/([\w-]+)/);
  return (
    <LangCtx.Provider value={lang}>
      {m ? <><div className="mock" role="note"><PubBanner /></div><PublicPassport id={m[1]} /></> : <Shell lang={lang} setLang={setLang} />}
    </LangCtx.Provider>
  );
}

function PubBanner() { const t = useT(); return <>{t("mockBanner")}</>; }
