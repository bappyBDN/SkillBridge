import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { python } from "@codemirror/lang-python";
import { javascript } from "@codemirror/lang-javascript";
import { oneDark } from "@codemirror/theme-one-dark";
import { keymap } from "@codemirror/view";

/**
 * Candidate code workspace: a VS Code-like editor plus a runnable terminal.
 *
 * Execution is deliberately client-side only:
 *   - Python runs in Pyodide (WebAssembly) inside a Web Worker.
 *   - JavaScript runs in a Web Worker.
 * No candidate code ever executes on the SkillBridge server. The editor content
 * is what gets submitted as the attempt answer; scoring stays rubric/human
 * reviewed, exactly as AGENTS.md requires.
 */

const PYODIDE_VERSION = "0.26.4";
const PYODIDE_URL = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/pyodide.js`;
const RUN_TIMEOUT_MS = 12000;

const STARTERS = {
  python: `# Write your solution here.
# Ctrl+Enter (or Run) executes this file in the terminal below.
# Use print(...) to inspect values and try your own test cases.

def solve():
    pass

if __name__ == "__main__":
    solve()
`,
  javascript: `// Write your solution here.
// Ctrl+Enter (or Run) executes this file in the terminal below.
// Use console.log(...) to inspect values and try your own test cases.

function solve() {
}

solve();
`,
};

const PYTHON_WORKER = `
let readyPromise = null;
function boot() {
  if (readyPromise) return readyPromise;
  try {
    importScripts(${JSON.stringify(PYODIDE_URL)});
    readyPromise = loadPyodide({
      stdout: (line) => self.postMessage({ type: "out", text: line }),
      stderr: (line) => self.postMessage({ type: "err", text: line }),
    }).then((py) => {
      self.postMessage({ type: "ready", runtime: "Python 3.12 (Pyodide)" });
      return py;
    });
  } catch (err) {
    readyPromise = Promise.reject(err);
  }
  return readyPromise;
}
self.onmessage = async (event) => {
  const data = event.data || {};
  if (data.type === "boot") {
    try { await boot(); } catch (err) {
      self.postMessage({ type: "boot-error", text: String(err && err.message || err) });
    }
    return;
  }
  if (data.type === "run") {
    try {
      const py = await boot();
      await py.runPythonAsync(data.code);
      self.postMessage({ type: "done", exit: "ok" });
    } catch (err) {
      self.postMessage({ type: "err", text: String(err && err.message || err) });
      self.postMessage({ type: "done", exit: "error" });
    }
  }
};
`;

const JS_WORKER = `
function show(value) {
  if (typeof value === "string") return value;
  try { return JSON.stringify(value); } catch (_) { return String(value); }
}
self.onmessage = (event) => {
  const data = event.data || {};
  if (data.type !== "run") return;
  const emit = (kind) => (...args) =>
    self.postMessage({ type: kind, text: args.map(show).join(" ") });
  const fakeConsole = { log: emit("out"), info: emit("out"), debug: emit("out"), warn: emit("err"), error: emit("err") };
  try {
    const fn = new Function("console", "print", data.code + "\\n//# sourceURL=candidate.js");
    const result = fn(fakeConsole, fakeConsole.log);
    if (result !== undefined) self.postMessage({ type: "out", text: "=> " + show(result) });
    self.postMessage({ type: "done", exit: "ok" });
  } catch (err) {
    self.postMessage({ type: "err", text: String(err && err.message || err) });
    self.postMessage({ type: "done", exit: "error" });
  }
};
`;

function detectLanguage(question) {
  const text = `${question?.question_text || question?.prompt || ""}`;
  if (/javascript|typescript|react|next\.?js|node\.?js|express/i.test(text)) {
    return "javascript";
  }
  return "python";
}

function languageLabel(language) {
  return language === "javascript" ? "JavaScript (Node-like sandbox)" : `Python 3.12 (Pyodide)`;
}

export default function CodeWorkspace({
  question,
  value,
  onChange,
  defaultLanguage,
  disabled = false,
}) {
  const initialLanguage = defaultLanguage || detectLanguage(question);
  const [language, setLanguage] = useState(initialLanguage);
  const [output, setOutput] = useState([]);
  const [running, setRunning] = useState(false);
  const [booting, setBooting] = useState(false);
  const [runtimeNote, setRuntimeNote] = useState("");

  const workerRef = useRef(null);
  const timeoutRef = useRef(null);
  const outputRef = useRef(null);
  const questionId = question?.id || "";

  const starter = useMemo(() => STARTERS[language], [language]);
  const code = value ?? "";
  const displayed = code.trim() ? code : starter;

  const stopWorker = useCallback(() => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    if (workerRef.current) {
      workerRef.current.terminate();
      workerRef.current = null;
    }
    setRunning(false);
  }, []);

  // Moving to another question swaps the task; do not leak the previous
  // terminal output or let the old language choice carry over.
  useEffect(() => {
    stopWorker();
    setOutput([]);
    setRuntimeNote("");
    setLanguage(defaultLanguage || detectLanguage(question));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [questionId]);

  useEffect(() => () => stopWorker(), [stopWorker]);

  useEffect(() => {
    if (outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [output]);

  const append = (kind, text) => {
    setOutput((rows) => [...rows, { kind, text }]);
  };

  const ensureWorker = useCallback(() => {
    if (workerRef.current) return workerRef.current;
    const source = language === "javascript" ? JS_WORKER : PYTHON_WORKER;
    const blob = new Blob([source], { type: "application/javascript" });
    const worker = new Worker(URL.createObjectURL(blob));
    worker.onmessage = (event) => {
      const data = event.data || {};
      if (data.type === "out") append("out", data.text);
      else if (data.type === "err") append("err", data.text);
      else if (data.type === "ready") {
        setBooting(false);
        setRuntimeNote(data.runtime || languageLabel(language));
      } else if (data.type === "boot-error") {
        setBooting(false);
        append("err", `Could not start ${languageLabel(language)}: ${data.text}`);
        stopWorker();
      } else if (data.type === "done") {
        if (data.exit === "ok") append("meta", `Process finished successfully.`);
        else append("meta", `Process finished with errors.`);
        setRunning(false);
        if (timeoutRef.current) {
          clearTimeout(timeoutRef.current);
          timeoutRef.current = null;
        }
      }
    };
    worker.onerror = (event) => {
      append("err", event.message || "The code runner crashed.");
      stopWorker();
    };
    workerRef.current = worker;
    if (language === "python") {
      setBooting(true);
      worker.postMessage({ type: "boot" });
    }
    return worker;
  }, [language, stopWorker]);

  // Switching language swaps the runtimes; keep the code the candidate wrote.
  useEffect(() => {
    if (workerRef.current) {
      stopWorker();
      setRuntimeNote("");
    }
  }, [language, stopWorker]);

  const run = useCallback(() => {
    if (disabled || running) return;
    const source = displayed.trim();
    if (!source) {
      append("err", "Nothing to run yet. Write some code first.");
      return;
    }
    setOutput((rows) => [
      ...rows,
      { kind: "cmd", text: `$ ${language === "javascript" ? "node solution.js" : "python solution.py"}` },
    ]);
    setRunning(true);
    append("meta", `Starting ${languageLabel(language)}…`);
    const worker = ensureWorker();
    try {
      worker.postMessage({ type: "run", code: displayed });
    } catch (err) {
      append("err", String(err));
      stopWorker();
      return;
    }
    timeoutRef.current = setTimeout(() => {
      append("err", `Execution stopped after ${RUN_TIMEOUT_MS / 1000}s (possible infinite loop).`);
      stopWorker();
    }, RUN_TIMEOUT_MS);
  }, [disabled, running, displayed, language, ensureWorker, stopWorker]);

  const reset = () => {
    if (disabled) return;
    stopWorker();
    setOutput([]);
    setRuntimeNote("");
    onChange(starter);
  };

  const onKeyDown = (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
      event.preventDefault();
      run();
    }
  };

  return (
    <div className="cw" onKeyDown={onKeyDown}>
      <div className="cw-bar">
        <div className="cw-bar-left">
          <span className="cw-dot" aria-hidden="true" />
          <b>Code workspace</b>
          <span className="cw-file">
            {language === "javascript" ? "solution.js" : "solution.py"}
          </span>
          <span className="cw-badge">{running ? "running" : booting ? "loading runtime" : "ready"}</span>
        </div>
        <div className="cw-bar-right">
          <select
            className="cw-select"
            value={language}
            onChange={(event) => setLanguage(event.target.value)}
            disabled={disabled || running}
            aria-label="Programming language"
          >
            <option value="python">Python</option>
            <option value="javascript">JavaScript</option>
          </select>
          <button type="button" className="cw-btn primary" onClick={run} disabled={disabled || running}>
            ▶ Run
          </button>
          <button type="button" className="cw-btn" onClick={stopWorker} disabled={!running}>
            ■ Stop
          </button>
          <button type="button" className="cw-btn" onClick={reset} disabled={disabled}>
            Reset
          </button>
        </div>
      </div>

      <div className="cw-editor">
        <CodeMirror
          value={displayed}
          height="340px"
          theme={oneDark}
          extensions={[
            language === "javascript" ? javascript({ jsx: true }) : python(),
            keymap.of([
              {
                key: "Mod-Enter",
                run: () => {
                  run();
                  return true;
                },
              },
            ]),
          ]}
          onChange={onChange}
          editable={!disabled}
          basicSetup={{
            lineNumbers: true,
            highlightActiveLine: true,
            bracketMatching: true,
            closeBrackets: true,
            autocompletion: true,
            indentOnInput: true,
            foldGutter: true,
          }}
        />
      </div>

      <div className="cw-term">
        <div className="cw-term-head">
          <span>TERMINAL</span>
          <span className="cw-term-hint">Ctrl+Enter to run · output is yours only</span>
          <button
            type="button"
            className="cw-term-clear"
            onClick={() => setOutput([])}
            disabled={!output.length}
          >
            clear
          </button>
        </div>
        <pre className="cw-term-body" ref={outputRef} aria-live="polite">
          {output.length === 0 ? (
            <span className="cw-term-idle">
              {runtimeNote || languageLabel(language)} ready. Press Run to execute your code.
            </span>
          ) : (
            output.map((row, index) => (
              <div key={index} className={`cw-line ${row.kind}`}>
                {row.text}
              </div>
            ))
          )}
        </pre>
      </div>

      <p className="cw-note">
        Runs in your browser only — the server never executes your code. Your saved
        editor content is submitted with this question and reviewed against the
        stored rubric.
      </p>
    </div>
  );
}
