const KEY = "sb_token";
// Set VITE_API_BASE_URL in Vercel to the deployed FastAPI origin (for example, https://skillbridge.onrender.com).
const API_BASE = (import.meta.env.VITE_API_BASE_URL || "").trim().replace(/\/+$/, "");
export const getToken = () => localStorage.getItem(KEY);
export const setToken = (t) => (t ? localStorage.setItem(KEY, t) : localStorage.removeItem(KEY));

export async function api(path, { method = "GET", body, form } = {}) {
  const headers = {};
  const t = getToken();
  if (t) headers.Authorization = "Bearer " + t;
  let payload;
  if (form) payload = form;
  else if (body !== undefined) { headers["Content-Type"] = "application/json"; payload = JSON.stringify(body); }
  const res = await fetch(API_BASE + "/api" + path, { method, headers, body: payload });
  let data = null;
  try { data = await res.json(); } catch { /* empty */ }
  if (!res.ok) {
    const err = new Error((data && (data.detail?.[0]?.msg || data.detail)) || res.statusText);
    err.status = res.status; err.code = typeof data?.detail === "string" ? data.detail : null;
    throw err;
  }
  return data;
}
