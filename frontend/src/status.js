// One mapping from workflow status to visual tone, shared by every pill:
// approved/published = success, pending/review = warning,
// rejected/invalidated = danger, everything else = neutral.
const SUCCESS = /^(approved|published|verified|active|accepted|ready|connected|configured|overturned|hired|offer|valid|confirmed|completed|done|shared|live)$/;
const WARNING = /(pending|review|needs|open|paused|invited|preliminary|interview|awaiting|draft_review|on_hold|more_info|requested)/;
const DANGER = /(rejected|invalidated|invalid|suspended|revoked|declined|failed|expired|withdrawn|blocked|upheld)/;

export function statusTone(status) {
  const value = String(status || "").toLowerCase().trim().replace(/[\s-]+/g, "_");
  if (!value) return "neutral";
  if (DANGER.test(value)) return "danger";
  if (SUCCESS.test(value)) return "success";
  if (WARNING.test(value)) return "warning";
  return "neutral";
}

// "REVIEW STATUS" -> "Review status"; leaves mixed-case and non-Latin text alone.
export function sentenceCase(text) {
  const value = String(text ?? "");
  if (!/[A-Z]/.test(value) || value !== value.toUpperCase()) return value;
  return value.charAt(0) + value.slice(1).toLowerCase();
}
