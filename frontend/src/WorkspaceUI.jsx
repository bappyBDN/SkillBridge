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
  integrity: "M12 3 4 6v6c0 4.5 3.4 7.8 8 9 4.6-1.2 8-4.5 8-9V6Z M8.5 12l2.5 2.5 4.5-5",
  privacy: "M6 11h12v10H6Z M8 11V7a4 4 0 0 1 8 0v4 M12 15v2",
  security: "M12 3 4 6v6c0 4.5 3.4 7.8 8 9 4.6-1.2 8-4.5 8-9V6Z M9.5 12h5v4h-5Z M10.5 12v-1.5a1.5 1.5 0 0 1 3 0V12",
  team: "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2 M13 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0 M17 4a4 4 0 0 1 0 8 M22 21v-2a4 4 0 0 0-3-4",
  staff: "M10 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8 M3 21v-1a6 6 0 0 1 9-5.2 M17.5 13l3.5 1.4V17c0 1.9-1.5 3.3-3.5 4-2-.7-3.5-2.1-3.5-4v-2.6Z",
  building: "M4 21V5a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v16 M15 9h4a1 1 0 0 1 1 1v11 M3 21h18 M8 8h3 M8 12h3 M8 16h3",
  identity: "M3 5h18v14H3Z M6.5 15.5a3 3 0 0 1 6 0 M9.5 11.5a1.75 1.75 0 1 0 0-3.5 1.75 1.75 0 0 0 0 3.5 M15 10h3 M15 14h3",
  appeals: "M12 3v18 M7 21h10 M5 7h14 M5 7l-3 7a3 3 0 0 0 6 0Z M19 7l-3 7a3 3 0 0 0 6 0Z",
  questions: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18 M9.5 9.2a2.5 2.5 0 1 1 3.4 2.3c-.6.3-.9.8-.9 1.4v.6 M12 16.8v.2",
  ai: "M7 7h10v10H7Z M10 10h4v4h-4Z M10 3v4 M14 3v4 M10 17v4 M14 17v4 M3 10h4 M3 14h4 M17 10h4 M17 14h4",
  billing: "M6 3h12v18l-3-2-3 2-3-2-3 2Z M9 8h6 M9 12h6 M9 16h3",
  quality: "M4 18a9 9 0 1 1 16 0 M12 14l4-5 M4 18h16",
  audit: "M12 7v5l3 2 M3.5 12a8.5 8.5 0 1 0 2.5-6 M3 4v4h4",
  analytics: "M4 3v18h18 M8 16v-5 M13 16V6 M18 16v-8",
  settings: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6 M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z",
  sliders: "M4 7h16 M4 17h16 M9 4v6 M15 14v6",
  search: "M21 21l-5-5 M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0",
  bell: "M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9 M10 21h4",
  arrow: "M4 12h16 M14 6l6 6-6 6",
  chevronRight: "M9 6l6 6-6 6",
  chevronDown: "M6 9l6 6 6-6",
  external: "M7 17 17 7 M8 7h9v9",
  close: "M6 6l12 12 M6 18 18 6",
  menu: "M4 6h16 M4 12h16 M4 18h16",
  refresh: "M20 7V3l-4 4 M20 7a9 9 0 1 0 1 9",
  file: "M14 2H4v20h16V8Z M14 2v6h6 M8 13h8 M8 17h5",
  mcp: "M9 2v6 M15 2v6 M6 8h12v3a6 6 0 0 1-12 0Z M12 17v5",
  agent: "M9 3h6 M12 3v3 M6 6h12a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2Z M9 11v2 M15 11v2 M9 16h6",
  logout: "M15 4h4a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-4 M10 17l5-5-5-5 M15 12H3",
  plus: "M12 5v14 M5 12h14",
  check: "M5 12.5l4.5 4.5L19 7",
  alert: "M12 9v4 M12 17v.01 M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z",
  info: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18 M12 11v5 M12 8v.01",
  inbox: "M3 13h5l1.5 3h5l1.5-3h5 M5.5 5h13L21 13v6H3v-6Z",
  clock: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18 M12 7v5l3 2",
  upload: "M12 16V4 M7 9l5-5 5 5 M4 16v4h16v-4",
  edit: "M4 20h4L19 9l-4-4L4 16Z M13.5 6.5l4 4",
  code: "M8 8l-4 4 4 4 M16 8l4 4-4 4 M14 5l-4 14",
  list: "M9 6h11 M9 12h11 M9 18h11 M4.5 6v.01 M4.5 12v.01 M4.5 18v.01",
};
const ALIASES = { applicants: "team", users: "team", candidates: "profile", companies: "building", assessments: "exams", appeals: "appeals", resources: "learning", reports: "analytics", trash: "close" };

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
        <small>{bn ? "পেজ" : "Go to page"}</small>
        {matches.map((item, index) => <button type="button" key={item.id} className={active === index ? "is-selected" : ""} onClick={() => navigate(item.id)} onMouseEnter={() => setActive(index)}><WorkspaceIcon name={item.icon || item.id} /><span>{item.label}</span><WorkspaceIcon name="arrow" size={17} /></button>)}
        {!matches.length && <p role="status">{bn ? "কোনো পেজ পাওয়া যায়নি। অন্য কিছু লিখুন।" : "No pages found. Try a different search."}</p>}
      </div>
      <footer>{bn ? "নেভিগেট করতে ↑ ↓ · খুলতে Enter · বন্ধ করতে Esc" : "↑ ↓ to navigate · Enter to open · Esc to close"}</footer>
    </dialog>
  </>;
}

// Skeleton placeholder: shows the shape of what is coming instead of a bare spinner.
export function WorkspaceLoading({ label = "Loading workspace…", lines = 3 }) {
  return <div className="ws-loading" role="status" aria-live="polite" aria-busy="true">
    <span className="ds-skeleton lg" aria-hidden="true" />
    {Array.from({ length: lines }, (_, index) => <span key={index} className="ds-skeleton" style={{ width: `${92 - index * 18}%` }} aria-hidden="true" />)}
    <span className="ws-loading-text">{label}</span>
  </div>;
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
