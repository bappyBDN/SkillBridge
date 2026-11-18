import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api.js";

const ACCEPT = ".pdf,.docx,.txt,.md";
const MAX_FILES = 3;
const MAX_BYTES = 5_000_000;

const sizeLabel = (bytes) =>
  bytes >= 1_000_000 ? `${(bytes / 1_000_000).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1000))} KB`;

const dateLabel = (seconds) => {
  if (!seconds) return "";
  try {
    return new Date(seconds * 1000).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
  } catch {
    return "";
  }
};

/*
 * Upload one or more newer CVs after the profile is confirmed. Each file is
 * read on the server in parallel; extracted values are merged into the form
 * as suggestions and nothing is saved until the candidate presses Save.
 */
export default function CvUpdatePanel({ onSuggestion }) {
  const input = useRef(null);
  const [jobs, setJobs] = useState([]);
  const [documents, setDocuments] = useState([]);
  const [keep, setKeep] = useState(3);
  const [dragging, setDragging] = useState(false);
  const busy = jobs.some((job) => job.state === "reading");

  const loadDocuments = useCallback(() => {
    api("/cv/documents")
      .then((result) => {
        setDocuments(result.documents || []);
        if (result.keep) setKeep(result.keep);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    loadDocuments();
  }, [loadDocuments]);

  const setJob = (id, patch) =>
    setJobs((list) => list.map((job) => (job.id === id ? { ...job, ...patch } : job)));

  const uploadFiles = async (fileList) => {
    const files = Array.from(fileList || []).slice(0, MAX_FILES);
    if (!files.length) return;
    const batch = files.map((file, index) => ({
      id: `${Date.now()}-${index}`,
      name: file.name,
      size: file.size,
      file,
      state: "reading",
      started: performance.now(),
      note: "",
    }));
    setJobs(batch);
    await Promise.all(
      batch.map(async (job) => {
        if (!/\.(pdf|docx|txt|md)$/i.test(job.name)) {
          setJob(job.id, { state: "error", note: "Use a PDF, DOCX, TXT or MD file." });
          return;
        }
        if (job.size > MAX_BYTES) {
          setJob(job.id, { state: "error", note: "File must be 5 MB or smaller." });
          return;
        }
        try {
          const form = new FormData();
          form.append("file", job.file);
          const result = await api("/cv/profile-update", { method: "POST", form });
          const seconds = ((performance.now() - job.started) / 1000).toFixed(1);
          onSuggestion?.(result.profile || {}, result);
          setJob(job.id, {
            state: "done",
            note: `${result.method === "cv_ai" ? "Read with AI" : "Read offline"} in ${seconds}s · ${result.extraction?.fields_found ?? 0} fields`,
          });
        } catch (error) {
          setJob(job.id, { state: "error", note: error.message || "Could not read this CV." });
        }
      }),
    );
    loadDocuments();
  };

  const pick = (event) => {
    const files = event.target.files;
    event.target.value = "";
    uploadFiles(files);
  };

  return (
    <section className="portal-panel cv-update" aria-labelledby="cv-update-title">
      <div className="cv-update-head">
        <div>
          <h2 id="cv-update-title">Update CV</h2>
          <p className="muted">
            Upload a newer CV whenever you need to — up to {MAX_FILES} files at once. We fill the form below with what we
            find; nothing changes on your profile until you press Save profile.
          </p>
        </div>
        <button type="button" className="btn" disabled={busy} onClick={() => input.current?.click()}>
          {busy ? "Reading CV…" : "Upload CV"}
        </button>
      </div>
      <input ref={input} className="cv-update-input" type="file" accept={ACCEPT} multiple onChange={pick} />
      <div
        className={"cv-update-drop" + (dragging ? " over" : "")}
        role="button"
        tabIndex={0}
        aria-label="Drop CV files here or press to choose files"
        onClick={() => !busy && input.current?.click()}
        onKeyDown={(event) => {
          if ((event.key === "Enter" || event.key === " ") && !busy) {
            event.preventDefault();
            input.current?.click();
          }
        }}
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          if (!busy) uploadFiles(event.dataTransfer.files);
        }}
      >
        <strong>Drop CV files here</strong>
        <span>PDF, DOCX, TXT or MD · 5 MB each</span>
      </div>

      {jobs.length > 0 && (
        <ul className="cv-update-jobs" aria-live="polite">
          {jobs.map((job) => (
            <li key={job.id} className={"cv-update-job " + job.state}>
              <span className="cv-update-state" aria-hidden="true">
                {job.state === "reading" ? <i className="cv-update-spin" /> : job.state === "done" ? "✓" : "!"}
              </span>
              <div>
                <b>{job.name}</b>
                <small>{job.state === "reading" ? `Reading ${sizeLabel(job.size)}…` : job.note}</small>
              </div>
            </li>
          ))}
        </ul>
      )}
      {jobs.some((job) => job.state === "done") && !busy && (
        <p className="cv-update-hint" role="status">
          New details were added to the sections below. Review them, then press Save profile.
        </p>
      )}

      {documents.length > 0 && (
        <div className="cv-update-docs">
          <span className="muted">Your stored CVs (latest {keep} kept)</span>
          <ul>
            {documents.map((doc) => (
              <li key={doc.id}>
                <b>{doc.filename}</b>
                <small>
                  {sizeLabel(doc.size_bytes || 0)}
                  {doc.created ? ` · ${dateLabel(doc.created)}` : ""}
                </small>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
