import { useEffect, useRef, useState } from "react";
import { api } from "./api.js";

const ICONS = {
  overview: "M3 10 12 3l9 7v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1Z",
  profile: "M20 21v-2a6 6 0 0 0-6-6h-4a6 6 0 0 0-6 6v2 M16 6a4 4 0 1 1-8 0 4 4 0 0 1 8 0",
  jobs: "M8 7V4h8v3 M3 7h18v13H3Z M3 12a20 20 0 0 0 18 0 M12 11v4",
  applications: "M7 3h10v3h4v15H3V6h4Z M7 3v5h10V3 M7 12h10 M7 16h6",
  exams: "M8 3h8v3h4v15H4V6h4 M8 3v5h8V3 M8 14l3 3 5-6",
  journey: "M4 18h5v-6h6V6h5 M16 6h4v4 M4 21v-6",
  learning: "M12 5C9 2 5 3 2 4v15c4-1 7-1 10 1 3-2 6-2 10-1V4c-3-1-7-2-10 1Z M12 5v15",
  passport: "M5 3h14v18H5Z M9 16h6 M15 9a3 3 0 1 1-6 0 3 3 0 0 1 6 0",
  privacy: "M12 3 3 7v5c0 5 9 9 9 9s9-4 9-9V7Z M8 12l3 3 5-6",
  team: "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2 M13 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0 M17 4a4 4 0 0 1 0 8 M22 21v-2a4 4 0 0 0-3-4",
  analytics: "M4 3v18h18 M8 16v-5 M13 16V6 M18 16v-8",
  settings: "M4 7h16 M4 17h16 M9 4v6 M15 14v6",
  search: "M21 21l-5-5 M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0",
  bell: "M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9 M10 21h4",
  arrow: "M4 12h16 M14 6l6 6-6 6",
  close: "M6 6l12 12 M6 18 18 6",
  menu: "M4 6h16 M4 12h16 M4 18h16",
  refresh: "M20 7V3l-4 4 M20 7a9 9 0 1 0 1 9",
  file: "M14 2H4v20h16V8Z M14 2v6h6 M8 13h8 M8 17h5",
};
const ALIASES = { applicants: "team", users: "team", candidates: "profile", companies: "jobs", assessments: "exams", security: "privacy", integrity: "privacy", appeals: "applications", questions: "learning", resources: "learning", reports: "analytics" };

export function WorkspaceIcon({ name, size = 20, ...props }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}><path d={ICONS[ALIASES[name] || name] || ICONS.overview} /></svg>;
}

// Native dialog supplies focus trapping, Escape handling and background inertness.
export function WorkspaceSearch({ items, onNavigate, lang = "en" }) {
  const dialog = useRef(null);
  const input = useRef(null);
  const trigger = useRef(null);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const bn = lang === "bn";
  const matches = items.filter((item) => item.label.toLowerCase().includes(query.toLowerCase()));
  const open = () => {
    if (document.body.classList.contains("exam-live")) return;
    setQuery("");
    setActive(0);
    dialog.current?.showModal();
    input.current?.focus();
  };
  const close = () => dialog.current?.close();
  const navigate = (id) => { close(); onNavigate(id); };
  useEffect(() => {
    const onKey = (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k" && !document.body.classList.contains("exam-live")) {
        event.preventDefault();
        open();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return <>
    <button ref={trigger} type="button" className="ws-search-trigger" onClick={open} aria-label={bn ? "ওয়ার্কস্পেসে খুঁজুন" : "Search workspace"}>
      <WorkspaceIcon name="search" size={18} /><span>{bn ? "ওয়ার্কস্পেসে খুঁজুন…" : "Search workspace…"}</span><kbd>Ctrl K</kbd>
    </button>
    <dialog ref={dialog} className="ws-command" aria-label={bn ? "ওয়ার্কস্পেসে খুঁজুন" : "Search workspace"} onClose={() => trigger.current?.focus()} onClick={(event) => { if (event.target === dialog.current) close(); }}>
      <div className="ws-command-input"><WorkspaceIcon name="search" /><input ref={input} placeholder={bn ? "কোথায় যেতে চান?" : "Where would you like to go?"} aria-label={bn ? "পেজ খুঁজুন" : "Search pages"} value={query} onChange={(event) => { setQuery(event.target.value); setActive(0); }} onKeyDown={(event) => {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          setActive((index) => matches.length ? (index + (event.key === "ArrowDown" ? 1 : matches.length - 1)) % matches.length : 0);
        }
        if (event.key === "Enter") {
          // Closing restores focus to the trigger. Cancel Enter's default
          // activation so the same keystroke cannot reopen the dialog.
          event.preventDefault();
          if (matches[active]) navigate(matches[active].id);
        }
      }} /><button type="button" onClick={close} aria-label="Close search"><WorkspaceIcon name="close" size={18} /></button></div>
      <div className="ws-command-results">
        <small>{bn ? "পেজ" : "GO TO PAGE"}</small>
        {matches.map((item, index) => <button type="button" key={item.id} className={active === index ? "is-selected" : ""} onClick={() => navigate(item.id)} onMouseEnter={() => setActive(index)}><WorkspaceIcon name={item.id} /><span>{item.label}</span><WorkspaceIcon name="arrow" size={17} /></button>)}
        {!matches.length && <p role="status">{bn ? "কোনো পেজ পাওয়া যায়নি। অন্য কিছু লিখুন।" : "No pages found. Try a different search."}</p>}
      </div>
      <footer>{bn ? "নেভিগেট করতে ↑ ↓ · খুলতে Enter · বন্ধ করতে Esc" : "↑ ↓ to navigate · Enter to open · Esc to close"}</footer>
    </dialog>
  </>;
}

export function WorkspaceLoading({ label = "Loading workspace…" }) {
  return <div className="ws-loading" role="status" aria-live="polite"><span className="ws-spinner" /><span>{label}</span></div>;
}

export function CvPreview({ url, filename = "Candidate CV" }) {
  const [objectUrl, setObjectUrl] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!url) return;
    const controller = new AbortController();
    let created = "";
    setLoading(true);
    setError("");
    setObjectUrl("");
    api(url, { responseType: "blob", signal: controller.signal }).then((blob) => {
      if (controller.signal.aborted) return;
      created = URL.createObjectURL(blob);
      setObjectUrl(created);
    }).catch((e) => { if (!controller.signal.aborted) setError(e.message || "Could not load this CV."); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => { controller.abort(); if (created) URL.revokeObjectURL(created); };
  }, [url, retry]);
  return <div className="ws-cv-preview">
    <div className="ws-cv-toolbar"><span><WorkspaceIcon name="file" size={18} />{filename}</span>{objectUrl && <a className="cr-outline-btn" href={objectUrl} download={filename.replace(/\.[^.]+$/, "") + ".pdf"}>Download PDF</a>}</div>
    {loading && <WorkspaceLoading label="Loading secure CV preview…" />}
    {error && <div className="ws-cv-error" role="alert"><p>{error}</p><button type="button" className="cr-outline-btn" onClick={() => setRetry((value) => value + 1)}>Try again</button></div>}
    {objectUrl && <><iframe src={objectUrl} title={`CV preview: ${filename}`} /><p className="ws-cv-fallback">Preview not supported by your browser? <a href={objectUrl} target="_blank" rel="noreferrer">Open PDF in a new tab</a> or download it above.</p></>}
  </div>;
}
