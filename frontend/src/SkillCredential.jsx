import { useState } from "react";
import { useT } from "./i18n.js";

export default function SkillCredential({ passport, verification, preview = false }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState("");
  const total = passport.skills.reduce((count, skill) => count + (skill.questions || 0), 0);
  const overall = passport.assessment?.overall ?? passport.overall;
  const copy = async () => {
    try { await navigator.clipboard.writeText(location.href); setCopied(true); setCopyError(""); }
    catch { setCopyError("Copy the page address from your browser to share this credential."); }
  };
  return <article className="skill-credential">
    <header className="credential-header"><div className="credential-brand"><span>TF</span><div>TalentForge<small>SKILLS · EVIDENCE · OPPORTUNITY</small></div></div><span className="credential-verified">✓ {preview ? "APPROVED ASSESSMENT" : verification?.signature_valid ? "SIGNATURE VERIFIED" : "SIGNATURE NOT VERIFIED"}</span></header>
    <section className="credential-hero"><div><span className="credential-kicker">VERIFIABLE SKILL RECORD</span><h1>{passport.holder}</h1><p>Evidence of assessed skills. Academic marks and the integrity review are independently approved by a human reviewer.</p><code>Credential ID · {passport.pid || "Preview"}</code></div><div className="credential-seal" aria-label="Human-reviewed assessment"><span>TF</span><b>HUMAN REVIEWED</b><small>Skill Passport</small></div></section>
    {verification?.expired && <p className="credential-warning" role="alert">This credential has expired. Ask the holder for a current passport.</p>}
    <div className="credential-scores"><div><small>TECHNICAL ASSESSMENT</small><strong>{overall ?? "—"}<span>/100</span></strong><p>Approved academic result</p></div><div><small>HONESTY REVIEW</small><strong>{passport.honesty?.score ?? "—"}<span>/100</span></strong><p>Administrator-reviewed · advisory</p></div><div><small>ASSESSMENT COVERAGE</small><strong>{passport.skills.length}<span>topics</span></strong><p>{total ? `${total} reviewed questions` : "See topic evidence below"}</p></div></div>
    <div className="credential-meta"><div><small>Issued</small><b>{passport.issued || "After review"}</b></div><div><small>Valid until</small><b>{passport.expires || "—"}</b></div><div><small>Review standard</small><b>Academic + honesty approval</b></div><div><small>Revision</small><b>{passport.release_id?.slice(0, 12) || "Reviewed result"}</b></div></div>
    <section className="credential-topics"><div className="credential-section-title"><div><span className="credential-kicker">TOPIC-LEVEL EVIDENCE</span><h2>Skills, measured individually.</h2></div><small>Percentage of approved marks</small></div><div className="credential-table-wrap"><table><thead><tr><th>Assessed topic</th><th>Proficiency</th><th>Questions</th><th>Topic score</th></tr></thead><tbody>{passport.skills.map((skill) => <tr key={skill.skill}><td><strong>{skill.name}</strong><small>{skill.section === "fundamental" ? "Fundamentals" : skill.section === "cv" ? "CV & development" : "Assessment topic"}</small></td><td>{t("levels")[skill.level] || skill.level || "Reviewed"}</td><td>{skill.questions ?? "—"}</td><td><div className="credential-topic-score"><b>{skill.score}%</b><span><i style={{ width: `${Math.max(0, Math.min(100, Number(skill.score) || 0))}%` }} /></span></div></td></tr>)}</tbody></table></div></section>
    <div className="credential-disclosure"><span aria-hidden="true">ⓘ</span><p>The honesty score summarizes an administrator’s review of advisory integrity signals. It does not alter technical marks, infer personality, or prove misconduct. This prototype credential is not an accredited qualification or a hiring decision.</p></div>
    <footer className="credential-footer"><div><b>{passport.issuer || "TalentForge Global R0 prototype"} · MOCK / R0 prototype content</b><small>Signed record · revocable by the holder · current approval checked on verification</small></div>{!preview && <div className="credential-actions"><button type="button" className="btn ghost sm" onClick={copy}>{copied ? "Link copied" : "Copy verification link"}</button><button type="button" className="btn sm" onClick={() => window.print()}>Print / save PDF</button></div>}</footer>
    {copyError && <p className="credential-warning" role="status">{copyError}</p>}
  </article>;
}
