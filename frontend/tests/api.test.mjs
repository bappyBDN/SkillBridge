import assert from "node:assert/strict";
import { test } from "node:test";
import { api, apiUrl } from "../src/api.js";

test("API paths are prefixed exactly once, including server CV URLs", () => {
  assert.equal(apiUrl("/state"), "/api/state");
  assert.equal(apiUrl("/api/admin/candidates/42/cv"), "/api/admin/candidates/42/cv");
  assert.equal(apiUrl("/admin/candidates/42/cv?document_id=abc"), "/api/admin/candidates/42/cv?document_id=abc");
});

test("API client refuses external and protocol-relative URLs before attaching credentials", () => {
  for (const path of ["https://external.test/cv", "//external.test/cv", "/\\external.test", undefined]) {
    assert.throws(() => apiUrl(path), /Invalid API path/);
  }
});

test("caller headers are sent but cannot replace the bearer token", async () => {
  const previousFetch = globalThis.fetch;
  globalThis.localStorage = { getItem: () => "test-token" };
  let sent;
  globalThis.fetch = async (url, options) => {
    sent = options.headers;
    return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
  };
  try {
    await api("/attempts/a1/answer", { method: "POST", body: { answer: "x" }, headers: { "X-Exam-Session": "session-1", Authorization: "Bearer attacker" } });
    assert.equal(sent["X-Exam-Session"], "session-1");
    assert.equal(sent.Authorization, "Bearer test-token");
    assert.equal(sent["Content-Type"], "application/json");
  } finally { globalThis.fetch = previousFetch; delete globalThis.localStorage; }
});

test("authenticated CV fetch preserves binary PDF data", async () => {
  const previousFetch = globalThis.fetch;
  globalThis.localStorage = { getItem: () => "test-token" };
  globalThis.fetch = async (url, options) => {
    assert.equal(url, "/api/admin/candidates/42/cv");
    assert.equal(options.headers.Authorization, "Bearer test-token");
    return new Response("%PDF-1.4 test", { headers: { "Content-Type": "application/pdf" } });
  };
  try {
    const pdf = await api("/api/admin/candidates/42/cv", { responseType: "blob" });
    assert.equal(await pdf.text(), "%PDF-1.4 test");
  } finally { globalThis.fetch = previousFetch; delete globalThis.localStorage; }
});
