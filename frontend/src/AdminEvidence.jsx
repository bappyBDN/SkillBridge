import { useEffect, useRef, useState } from "react";
import { api } from "./api.js";

/** Same-origin API path for one evidence image; never an arbitrary URL. */
export function evidencePath(attemptId, evidence) {
  const url = typeof evidence?.url === "string" ? evidence.url : "";
  if (url.startsWith("/api/") && !url.startsWith("//")) return url;
  return `/admin/attempts/${encodeURIComponent(attemptId)}/evidence/${encodeURIComponent(evidence?.id)}`;
}

/**
 * Evidence snapshots need the bearer token, which <img src> cannot send. The
 * image is fetched as a blob only once it scrolls into view, shown through an
 * object URL, and the URL is revoked on unmount.
 */
export function EvidenceImage({ attemptId, evidence }) {
  const holder = useRef(null);
  const [visible, setVisible] = useState(false);
  const [state, setState] = useState({ status: "idle", url: "" });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const node = holder.current;
    if (!node) return undefined;
    if (typeof IntersectionObserver !== "function") { setVisible(true); return undefined; }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) { setVisible(true); observer.disconnect(); }
    }, { rootMargin: "200px" });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!visible) return undefined;
    let active = true;
    let objectUrl = "";
    setState({ status: "loading", url: "" });
    api(evidencePath(attemptId, evidence), { responseType: "blob" })
      .then((blob) => {
        objectUrl = URL.createObjectURL(blob);
        if (active) setState({ status: "ready", url: objectUrl });
        else URL.revokeObjectURL(objectUrl);
      })
      .catch(() => { if (active) setState({ status: "error", url: "" }); });
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [visible, attemptId, evidence, attempt]);
  return (
    <div ref={holder} className="evidence-image" aria-busy={state.status === "loading"}>
      {state.status === "ready" ? (
        <img src={state.url} alt="AI alert evidence snapshot" />
      ) : state.status === "error" ? (
        <div className="evidence-placeholder" role="alert">
          Snapshot could not be loaded (it may have expired or you may lack the integrity-review scope).{" "}
          <button type="button" className="btn ghost sm" onClick={() => setAttempt((n) => n + 1)}>Try again</button>
        </div>
      ) : (
        <div className="evidence-placeholder">{state.status === "loading" ? "Loading snapshot…" : "Snapshot loads when visible"}</div>
      )}
    </div>
  );
}
