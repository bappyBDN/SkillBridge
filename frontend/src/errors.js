/**
 * Turn an API or client error into text a person can read.
 *
 * The backend raises bare snake_case codes (for example "attempt_cap" or
 * "monitoring_restore_required:camera_started"). A code is never shown alone:
 * it is translated, or a friendly generic message is shown with the code as a
 * small reference for support.
 */

const CODE_RE = /^[a-z][a-z0-9_]*(?::[a-z0-9_,.-]+)?$/;

export function isErrorCode(value) {
  return typeof value === "string" && CODE_RE.test(value.trim());
}

/** The machine code behind an error, if it has one. */
export function errorCode(error) {
  if (!error) return null;
  if (typeof error === "string") return isErrorCode(error) ? error.trim() : null;
  if (isErrorCode(error.code)) return error.code.trim();
  if (isErrorCode(error.message)) return error.message.trim();
  return null;
}

/**
 * @param error  Error | {code,message} | string
 * @param lookup (key) => translated string, or undefined when missing
 * @returns {{ text: string, code: string|null }} code is set only when the
 *          text is the generic fallback, so the UI can show it muted.
 */
export function describeError(error, lookup) {
  if (!error) return null;
  const tr = (key) => {
    const value = lookup(key);
    return typeof value === "string" && value !== key ? value : null;
  };
  const code = errorCode(error);
  if (code) {
    const direct = tr(code);
    if (direct) return { text: direct, code: null };
    const [prefix, suffix] = code.split(":");
    if (suffix !== undefined) {
      const specific = tr(`${prefix}:${suffix}`) || tr(`${prefix}_${suffix}`);
      if (specific) return { text: specific, code: null };
      const general = tr(`${prefix}:*`);
      if (general) return { text: general, code: null };
    }
    return { text: tr("errorGeneric") || "Something went wrong. Please try again.", code };
  }
  const message = typeof error === "string" ? error : error.message;
  if (typeof message === "string" && message.trim()) return { text: message.trim(), code: null };
  return { text: tr("errorGeneric") || tr("error") || "Something went wrong. Please try again.", code: null };
}
