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
