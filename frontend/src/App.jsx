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


const emptyCandidateProfile = {headline:"",phone:"",location:"",summary:"",linkedin:"",github:"",portfolio:"",education:[],experience:[],projects:[],preferences:{job_types:["Internship","Full-time"],work_mode:"Any",locations:[]}};
function CandidateProfileEditor({onSaved}) {
 const [p,setP]=useState(emptyCandidateProfile),[account,setAccount]=useState({}),[cv,setCv]=useState(null),[loading,setLoading]=useState(true),[busy,setBusy]=useState(false),[message,setMessage]=useState(""),[error,setError]=useState("");
 const load=async()=>{try{const r=await api("/candidate/profile");setAccount(r.user||{});setP({...emptyCandidateProfile,...r.profile,preferences:{...emptyCandidateProfile.preferences,...(r.profile?.preferences||{})}});setCv(r.cv);}catch(e){setError(e.message||"Could not load profile");}finally{setLoading(false);}};
 useEffect(()=>{load();},[]);
 const set=(k,v)=>setP(old=>({...old,[k]:v}));
 const item=(key,i,k,v)=>setP(old=>({...old,[key]:old[key].map((x,n)=>n===i?({...x,[k]:v}):x)}));
 const add=(key,value)=>set(key,[...p[key],value]);
 const remove=(key,i)=>set(key,p[key].filter((_,n)=>n!==i));
 const save=async e=>{e.preventDefault();setBusy(true);setMessage("");setError("");try{await api("/candidate/profile",{method:"PUT",body:p});setMessage("Profile saved successfully.");onSaved?.();}catch(e){setError(e.message||"Could not save profile");}finally{setBusy(false);}};
 if(loading)return <div className="portal-panel">Loading profile…</div>;
 const completed=[p.headline,p.location,p.summary,cv?.uploaded,p.education.length,p.experience.length,p.projects.length].filter(Boolean).length;
 const progress=Math.round(completed/7*100);
 return <div className="profile-layout"><aside className="profile-side-card"><div className="avatar-circle">{(account.name||"C").split(" ").map(x=>x[0]).join("").slice(0,2).toUpperCase()}</div><h2>{account.name}</h2><p className="muted">{p.headline||"Add a professional headline"}</p><p className="muted">{account.email}</p><div className="completion-row"><span>Profile completeness</span><strong>{progress}%</strong></div><div className="completion-track"><span style={{width:progress+"%"}}/></div><div className="profile-mini-stat"><strong>{cv?.skills?.length||0}</strong><span>Confirmed skills</span></div><div className="profile-mini-stat"><strong>{p.experience.length}</strong><span>Experience entries</span></div><div className="profile-mini-stat"><strong>{p.projects.length}</strong><span>Projects</span></div><p className="muted">Only share assessment results with employers when you choose to.</p></aside>
 <form className="profile-editor" onSubmit={save}>{message&&<p className="success-note" role="status">{message}</p>}{error&&<p className="err" role="alert">{error}</p>}
 <section className="portal-panel"><div className="panel-heading"><div><span className="eyebrow">YOUR PROFILE</span><h2>Professional overview</h2><p>Give employers a clear picture of your strengths and goals.</p></div><span className="status-pill">{progress>=70?"Good progress":"In progress"}</span></div>
 <div className="form-grid"><label>Full name<input disabled value={account.name||""}/></label><label>Professional headline<input value={p.headline} onChange={e=>set("headline",e.target.value)} maxLength={180} placeholder="Junior Data Analyst | SQL & Python"/></label><label>Email<input disabled value={account.email||""}/></label><label>Phone<input value={p.phone} onChange={e=>set("phone",e.target.value)} placeholder="+880…"/></label><label>Location<input value={p.location} onChange={e=>set("location",e.target.value)} placeholder="Dhaka, Bangladesh"/></label></div><label>Professional summary<textarea rows={4} value={p.summary} onChange={e=>set("summary",e.target.value)} maxLength={3000} placeholder="Your interests, strengths, experience and the problems you enjoy solving."/></label><div className="form-grid"><label>LinkedIn URL<input value={p.linkedin} onChange={e=>set("linkedin",e.target.value)} placeholder="https://linkedin.com/in/…"/></label><label>GitHub URL<input value={p.github} onChange={e=>set("github",e.target.value)} placeholder="https://github.com/…"/></label><label>Portfolio URL<input value={p.portfolio} onChange={e=>set("portfolio",e.target.value)} placeholder="https://…"/></label></div></section>
 <section className="portal-panel"><div className="panel-heading"><div><span className="eyebrow">BACKGROUND</span><h2>Education</h2></div><button type="button" className="btn ghost sm" onClick={()=>add("education",{institution:"",degree:"",field:"",start_year:"",end_year:"",details:""})}>+ Add education</button></div>{p.education.map((x,i)=><div className="repeat-card" key={i}><div className="repeat-top"><strong>Education {i+1}</strong><button type="button" className="text-danger" onClick={()=>remove("education",i)}>Remove</button></div><div className="form-grid"><label>Institution<input required value={x.institution} onChange={e=>item("education",i,"institution",e.target.value)}/></label><label>Degree<input value={x.degree} onChange={e=>item("education",i,"degree",e.target.value)}/></label><label>Field of study<input value={x.field} onChange={e=>item("education",i,"field",e.target.value)}/></label><label>Start year<input value={x.start_year} onChange={e=>item("education",i,"start_year",e.target.value)}/></label><label>End year / expected<input value={x.end_year} onChange={e=>item("education",i,"end_year",e.target.value)}/></label></div><label>Details<textarea rows={2} value={x.details} onChange={e=>item("education",i,"details",e.target.value)}/></label></div>)}{!p.education.length&&<p className="empty-inline">Add your university, school or relevant training.</p>}</section>
 <section className="portal-panel"><div className="panel-heading"><div><span className="eyebrow">CAREER</span><h2>Experience</h2></div><button type="button" className="btn ghost sm" onClick={()=>add("experience",{company:"",title:"",employment_type:"",start_date:"",end_date:"",current:false,description:""})}>+ Add experience</button></div>{p.experience.map((x,i)=><div className="repeat-card" key={i}><div className="repeat-top"><strong>Experience {i+1}</strong><button type="button" className="text-danger" onClick={()=>remove("experience",i)}>Remove</button></div><div className="form-grid"><label>Company<input required value={x.company} onChange={e=>item("experience",i,"company",e.target.value)}/></label><label>Role / title<input required value={x.title} onChange={e=>item("experience",i,"title",e.target.value)}/></label><label>Employment type<input value={x.employment_type} onChange={e=>item("experience",i,"employment_type",e.target.value)}/></label><label>Start date<input value={x.start_date} onChange={e=>item("experience",i,"start_date",e.target.value)}/></label><label>End date<input disabled={x.current} value={x.end_date} onChange={e=>item("experience",i,"end_date",e.target.value)}/></label><label className="check"><input type="checkbox" checked={!!x.current} onChange={e=>item("experience",i,"current",e.target.checked)}/> Current role</label></div><label>Description<textarea rows={3} value={x.description} onChange={e=>item("experience",i,"description",e.target.value)}/></label></div>)}{!p.experience.length&&<p className="empty-inline">Internships, volunteering and practical work all count.</p>}</section>
 <section className="portal-panel"><div className="panel-heading"><div><span className="eyebrow">PORTFOLIO</span><h2>Projects</h2></div><button type="button" className="btn ghost sm" onClick={()=>add("projects",{name:"",description:"",technologies:[],url:""})}>+ Add project</button></div>{p.projects.map((x,i)=><div className="repeat-card" key={i}><div className="repeat-top"><strong>Project {i+1}</strong><button type="button" className="text-danger" onClick={()=>remove("projects",i)}>Remove</button></div><div className="form-grid"><label>Project name<input required value={x.name} onChange={e=>item("projects",i,"name",e.target.value)}/></label><label>Repository / demo URL<input value={x.url} onChange={e=>item("projects",i,"url",e.target.value)}/></label></div><label>Description<textarea rows={3} value={x.description} onChange={e=>item("projects",i,"description",e.target.value)}/></label><label>Technologies, comma-separated<input value={(x.technologies||[]).join(", ")} onChange={e=>item("projects",i,"technologies",e.target.value.split(",").map(y=>y.trim()).filter(Boolean))}/></label></div>)}{!p.projects.length&&<p className="empty-inline">Add projects to demonstrate what you can build.</p>}</section>
 <section className="portal-panel"><div className="panel-heading"><div><span className="eyebrow">JOB SEARCH</span><h2>Preferences</h2><p>Used to organize your search, not to guarantee a match.</p></div></div><label>Preferred work mode<select value={p.preferences.work_mode||"Any"} onChange={e=>set("preferences",{...p.preferences,work_mode:e.target.value})}><option>Any</option><option>Remote</option><option>Hybrid</option><option>On-site</option></select></label><strong>Employment type</strong><div className="preference-options">{["Internship","Full-time","Part-time","Contract","Temporary"].map(x=><label className="check" key={x}><input type="checkbox" checked={(p.preferences.job_types||[]).includes(x)} onChange={e=>set("preferences",{...p.preferences,job_types:e.target.checked?[...(p.preferences.job_types||[]),x]:(p.preferences.job_types||[]).filter(y=>y!==x)})}/>{x}</label>)}</div><label>Preferred locations, comma-separated<input value={(p.preferences.locations||[]).join(", ")} onChange={e=>set("preferences",{...p.preferences,locations:e.target.value.split(",").map(x=>x.trim()).filter(Boolean)})} placeholder="Dhaka, Remote"/></label></section>
 <div className="profile-savebar"><span className="muted">Remember to save your changes.</span><button className="btn" disabled={busy}>{busy?"Saving…":"Save profile"}</button></div></form></div>;
}
function CandidateJobs({onApply}) {
 const [jobs,setJobs]=useState([]),[apps,setApps]=useState([]),[search,setSearch]=useState(""),[kind,setKind]=useState("All"),[error,setError]=useState(""),[notice,setNotice]=useState(""),[loading,setLoading]=useState(true);
 const load=async()=>{try{const [j,a]=await Promise.all([api("/jobs"),api("/applications/mine")]);setJobs(j.items||[]);setApps(a.items||[]);}catch(e){setError(e.message||"Could not load jobs");}finally{setLoading(false);}};
 useEffect(()=>{load();},[]);
 const apply=async id=>{try{const r=await api("/jobs/"+id+"/apply",{method:"POST"});setNotice(r.status==="already_applied"?"You have already applied.":"Application submitted.");await load();}catch(e){setError(e.message||"Could not apply");}};
 const applied=new Set(apps.map(a=>a.job_id));const filtered=jobs.filter(j=>(kind==="All"||j.employment_type===kind)&&[j.title,j.description,j.company_name,...(j.skills||[])].join(" ").toLowerCase().includes(search.toLowerCase()));
 if(loading)return <div className="portal-panel">Loading jobs…</div>;
 return <section><div className="job-filters"><input aria-label="Search jobs" value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search title, company or skill…"/><select value={kind} onChange={e=>setKind(e.target.value)}><option>All</option>{["Internship","Full-time","Part-time","Contract","Temporary"].map(x=><option key={x}>{x}</option>)}</select></div>{notice&&<p className="success-note" role="status">{notice}</p>}{error&&<p className="err" role="alert">{error}</p>}<div className="job-grid">{filtered.map(j=><article className="job-card" key={j.id}><div className="job-card-top"><span className="job-icon">↗</span>{j.is_mock&&<span className="chip chip-mock">MOCK DATA</span>}</div><h3>{j.title}</h3><p className="job-company">{j.company_name}</p><p>{j.description}</p><div className="job-meta"><span>{j.location}</span><span>{j.employment_type}</span></div><div className="job-skill-tags">{(j.skills||[]).map(s=><span key={s}>{s}</span>)}</div><button className={"btn "+(applied.has(j.id)?"ghost":"")} disabled={applied.has(j.id)} onClick={()=>apply(j.id)}>{applied.has(j.id)?"Application sent":"Apply now"}</button></article>)}</div>{!filtered.length&&<div className="empty-state"><h3>No matching jobs</h3><p>Try another search term or filter.</p></div>}</section>;
}
function CandidateApplications() {
 const [items,setItems]=useState([]),[loading,setLoading]=useState(true),[error,setError]=useState("");
 const load=async()=>{try{const r=await api("/applications/mine");setItems(r.items||[]);}catch(e){setError(e.message||"Could not load applications");}finally{setLoading(false);}};
 useEffect(()=>{load();},[]);
 const share=async(id,value)=>{try{await api("/applications/"+id+"/share-results",{method:"PUT",body:{share:value}});await load();}catch(e){setError(e.message||"Could not update sharing");}};
 if(loading)return <div className="portal-panel">Loading applications…</div>;
 return <section className="portal-panel"><div className="section-toolbar"><div><span className="eyebrow">YOUR JOB SEARCH</span><h2>My applications</h2><p>Track submitted applications and control result sharing.</p></div><span className="count-badge">{items.length} total</span></div>{error&&<p className="err">{error}</p>}{!items.length&&<div className="empty-state"><h3>No applications yet</h3><p>Browse jobs and apply to a role that matches your interests.</p></div>}{items.map(a=><article className="application-row" key={a.application_id}><div className="application-logo">SB</div><div className="application-main"><h3>{a.title}</h3><p>{a.company_name} · {a.location}</p><span className="status-pill">{a.status}</span></div><div className="application-consent"><label className="check"><input type="checkbox" checked={!!a.results_shared} onChange={e=>share(a.application_id,e.target.checked)}/> Share assessment results with this employer</label><small className="muted">You can change this choice at any time.</small></div></article>)}</section>;
}
function CandidatePortal({st,refresh,tick,setTick}) {
 const [section,setSection]=useState("overview");const [journeyView,setJourneyView]=useState(st.confirmed?"gap":"profile");const t=useT();const done=(st?.attempts||[]).filter(a=>a.status==="done");const latest=done[done.length-1];
 const nav=[{id:"overview",label:"Overview",icon:"⌂",group:"WORKSPACE"},{id:"profile",label:"My profile",icon:"◉",group:"WORKSPACE"},{id:"jobs",label:"Find jobs",icon:"↗",group:"WORKSPACE"},{id:"applications",label:"Applications",icon:"▤",group:"WORKSPACE"},{id:"journey",label:"Skill journey",icon:"⌁",group:"GROWTH"},{id:"passport",label:"Skill Passport",icon:"◇",group:"GROWTH"},{id:"privacy",label:"Data & privacy",icon:"▣",group:"ACCOUNT"}];
 const go=id=>{setSection(id);window.scrollTo({top:0,behavior:"smooth"});};
 return <div className="candidate-shell"><aside className="candidate-sidebar"><div className="sidebar-brand"><span className="brand-mark">S</span><span>SkillBridge<small>CAREER WORKSPACE</small></span></div><div className="sidebar-profile"><div className="avatar-small">{(st.user?.name||"C").split(" ").map(x=>x[0]).join("").slice(0,2).toUpperCase()}</div><div><strong>{st.user?.name}</strong><small>Candidate account</small></div></div>{["WORKSPACE","GROWTH","ACCOUNT"].map(group=><div className="sidebar-group" key={group}><p>{group}</p>{nav.filter(n=>n.group===group).map(n=><button key={n.id} className={section===n.id?"active":""} onClick={()=>go(n.id)}><span>{n.icon}</span>{n.label}</button>)}</div>)}<div className="sidebar-bottom"><div className="sidebar-tip"><strong>Keep growing</strong><p>Verify skills, learn from gaps and build proof of progress.</p><button onClick={()=>go("journey")}>Continue learning →</button></div><p className="sidebar-version">SkillBridge · Candidate</p></div></aside>
 <main className="candidate-main"><header className="candidate-topbar"><div className="mobile-brand"><span className="brand-mark">S</span><strong>SkillBridge</strong></div><div className="breadcrumb">Candidate workspace <span>/</span> {nav.find(n=>n.id===section)?.label}</div><div className="topbar-actions"><div className="language-switch"><select aria-label="Language" value={localStorage.getItem("sb_lang")||"en"} onChange={e=>{localStorage.setItem("sb_lang",e.target.value);location.reload();}}><option value="en">English</option><option value="bn">বাংলা</option></select></div><div className="topbar-avatar">{(st.user?.name||"C")[0]?.toUpperCase()}</div></div></header><div className="candidate-page">
 {section==="overview"&&<><section className="welcome-banner"><div><span className="eyebrow light">YOUR CAREER, YOUR PROGRESS</span><h1>Welcome back, {(st.user?.name||"Candidate").split(" ")[0]}.</h1><p>Build your profile, verify your skills and discover opportunities that fit your goals.</p><div className="welcome-actions"><button className="btn btn-light" onClick={()=>go("profile")}>Complete my profile →</button><button className="welcome-link" onClick={()=>go("journey")}>Continue skill journey ↗</button></div></div><div className="welcome-art" aria-hidden="true"><div className="art-orbit orbit-one"/><div className="art-orbit orbit-two"/><div className="art-center">SB</div><span className="art-node node-one">✦</span><span className="art-node node-two">✓</span><span className="art-node node-three">↗</span></div></section><div className="dashboard-section-heading"><div><span className="eyebrow">YOUR WORKSPACE</span><h2>Your career at a glance</h2></div></div><div className="metric-grid"><button className="metric-card" onClick={()=>go("profile")}><span className="metric-icon">◉</span><span className="metric-label">Profile & CV</span><strong>{st.has_cv?"CV added":"Build profile"}</strong><small>{st.confirmed?.length||0} confirmed skills</small></button><button className="metric-card" onClick={()=>go("journey")}><span className="metric-icon">✓</span><span className="metric-label">Assessments</span><strong>{done.length} completed</strong><small>{latest?"Latest score: "+(latest.overall??"—")+"%":"Verify your skills"}</small></button><button className="metric-card" onClick={()=>go("applications")}><span className="metric-icon">▤</span><span className="metric-label">Applications</span><strong>Track progress</strong><small>Manage result sharing</small></button><button className="metric-card" onClick={()=>go("passport")}><span className="metric-icon">◇</span><span className="metric-label">Skill Passport</span><strong>{st.passports?.filter(x=>!x.revoked).length||0} active</strong><small>Share verified evidence</small></button></div><div className="dashboard-lower"><section className="portal-panel"><span className="eyebrow">RECOMMENDED NEXT STEP</span><h2>{!st.confirmed?"Build your candidate profile":done.length===0?"Verify your skills":"Keep growing your skills"}</h2><p>{!st.confirmed?"Add your background and review the skills extracted from your CV.":done.length===0?"Take an assessment to understand your strengths and learning gaps.":"Use your learning path to practice and measure your progress."}</p><button className="btn" onClick={()=>go(!st.confirmed?"profile":"journey")}>{!st.confirmed?"Open profile":"Open skill journey"} →</button></section><section className="portal-panel quick-links"><h2>Quick links</h2>{[{id:"profile",label:"Edit professional profile"},{id:"jobs",label:"Browse opportunities"},{id:"applications",label:"Manage result sharing"},{id:"privacy",label:"Export or delete data"}].map(x=><button key={x.id} onClick={()=>go(x.id)}>{x.label}<b>→</b></button>)}</section></div></>}
 {section==="profile"&&<><div className="page-title"><div><span className="eyebrow">CANDIDATE DETAILS</span><h1>My profile</h1><p>Manage your professional story, education, experience, projects and job preferences.</p></div></div><CandidateProfileEditor onSaved={refresh}/><div className="page-title cv-title"><div><span className="eyebrow">CV & SKILLS</span><h2>Resume and skills</h2><p>Upload a CV, review extracted skills and confirm what represents you.</p></div></div><Profile st={st} onDone={async()=>{await refresh();go("journey");}}/></>}
 {section==="jobs"&&<><div className="page-title"><div><span className="eyebrow">OPPORTUNITIES</span><h1>Find jobs</h1><p>Search the current marketplace and apply to a suitable role.</p></div></div><CandidateJobs/></>}
 {section==="applications"&&<><div className="page-title"><div><span className="eyebrow">YOUR JOB SEARCH</span><h1>Applications</h1><p>Track submitted applications and manage assessment result sharing.</p></div></div><CandidateApplications/></>}
 {section==="journey"&&<><div className="page-title"><div><span className="eyebrow">SKILL DEVELOPMENT</span><h1>Skill journey</h1><p>Move from claimed skills to verified evidence, learning and re-assessment.</p></div></div><nav className="steps">{STEPS.map((s,i)=><button key={s} className={viewClass(s,section,done.length)} onClick={()=>setJourneyView(s)}><span className="n">{i+1}</span>{t("steps")[s]}</button>)}</nav><div className="portal-panel journey-content"><ProfileJourneyRouter st={st} refresh={refresh} tick={tick} setTick={setTick} done={done} v={journeyView} setV={setJourneyView}/></div></>}
 {section==="passport"&&<><div className="page-title"><div><span className="eyebrow">VERIFIABLE PROOF</span><h1>Skill Passport</h1><p>Choose verified topics to share and revoke public links whenever you need.</p></div></div><Passport st={st} refresh={refresh}/></>}
 {section==="privacy"&&<><div className="page-title"><div><span className="eyebrow">YOUR DATA</span><h1>Data & privacy</h1><p>Export a copy of your data or request account deletion.</p></div></div><DataRights/><section className="portal-panel"><h2>Privacy basics</h2><ul className="privacy-list"><li>Review CV-extracted skills before confirming them.</li><li>Assessment integrity signals are review signals, not automatic proof of misconduct.</li><li>Sharing results with an employer is optional and revocable.</li></ul></section></>}
 </div><footer className="candidate-footer"><span>SkillBridge Candidate Workspace</span><span>Build skills. Show evidence. Keep growing.</span></footer></main></div>;
}
function ProfileJourneyRouter({st,refresh,tick,setTick,done,v,setV}) {
 return <>{v==="profile"&&<Profile st={st} onDone={async()=>{await refresh();setV("gap");}}/>}{v==="gap"&&<Gap refreshKey={tick} onStart={()=>setV("assess")}/ >}{v==="assess"&&<Exam kind="pre" st={st} refresh={refresh} afterResult={()=>setV("learn")} afterLabel="Learning path"/>}{v==="learn"&&<Learn onNext={()=>setV("retest")}/ >}{v==="retest"&&<Exam kind="post" st={st} refresh={refresh} afterResult={()=>setV("passport")} afterLabel="Skill Passport"/>}{v==="passport"&&<Passport st={st} refresh={refresh}/>}</>;
}
function HiringWorkspace({role}) {
  const [jobs,setJobs]=useState([]); const [items,setItems]=useState([]); const [name,setName]=useState(""); const [title,setTitle]=useState(""); const [description,setDescription]=useState(""); const [error,setError]=useState("");
  const load=async()=>{try{if(role==="candidate"){const r=await api("/jobs");setJobs(r.items||[]);const a=await api("/applications/mine");setItems(a.items||[]);}else if(role==="company"){const j=await api("/company/jobs");setJobs(j.items||[]);const a=await api("/company/applications");setItems(a.items||[]);}else{const a=await api("/admin/overview");setItems(Object.entries(a.counts||{}).map(([key,value])=>({key,value})));}}catch(e){setError(e.message);}};
  useEffect(()=>{load();},[role]);
  const company=async e=>{e.preventDefault();try{await api("/company/profile",{method:"POST",body:{name,website:""}});setError("Company profile saved.");await load();}catch(e){setError(e.message);}};
  const job=async e=>{e.preventDefault();try{await api("/jobs",{method:"POST",body:{title,description,skills:["Python","SQL"],publish:true}});setTitle("");setDescription("");setError("Job published.");await load();}catch(e){setError(e.message);}};
  const apply=async id=>{try{await api("/jobs/"+id+"/apply",{method:"POST"});setError("Application submitted.");await load();}catch(e){setError(e.message);}};
  return <main className="wrap"><section className="hero"><h1>{role==="company"?"Company workspace":role==="admin"?"Admin overview":"Job marketplace"}</h1><p className="lead">SkillBridge hiring workflows backed by PostgreSQL.</p><p className="note">Demo jobs are synthetic. Assessment results are shared only with candidate consent.</p></section>{error&&<p className="note" role="status">{error}</p>}
  {role==="company"&&<><form className="card" onSubmit={company}><h2>Company profile</h2><label>Company name<input value={name} onChange={e=>setName(e.target.value)} required minLength={2}/></label><button className="btn">Save profile</button></form><form className="card" onSubmit={job}><h2>Publish job</h2><label>Title<input value={title} onChange={e=>setTitle(e.target.value)} required minLength={3}/></label><label>Description<textarea value={description} onChange={e=>setDescription(e.target.value)} required minLength={20}/></label><button className="btn">Publish</button></form><section className="card"><h2>Applications</h2>{items.map(a=><p key={a.application_id}>{a.candidate_name} — {a.job_title} · Results shared: {a.results_shared?"Yes":"No"}</p>)}</section></>}
  {role==="candidate"&&<section className="card"><h2>Available jobs</h2>{jobs.map(j=><article className="card quiet" key={j.id}><h3>{j.title} {j.is_mock&&<span className="chip">MOCK</span>}</h3><p>{j.company_name} · {j.location}</p><p>{j.description}</p><button className="btn" onClick={()=>apply(j.id)}>Apply</button></article>)}<h2>My applications</h2>{items.map(a=><p key={a.application_id}>{a.title} — {a.company_name}</p>)}</section>}
  {role==="admin"&&<section className="card"><h2>Platform totals</h2>{items.map(x=><p key={x.key}>{x.key}: {x.value}</p>)}</section>}<button className="btn ghost" onClick={load}>Refresh</button></main>;
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
  else if (role && role !== "candidate") body = <HiringWorkspace role={role} />;
  else body = <CandidatePortal st={st} refresh={refresh} tick={tick} setTick={setTick} />;
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
