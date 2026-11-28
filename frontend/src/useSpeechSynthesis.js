import { useCallback, useEffect, useMemo, useRef, useState } from "react";

const MAX_UTTERANCE_MS = 45000;

function normaliseLang(value) {
  return String(value || "").replace("_", "-").toLowerCase();
}

/**
 * Browser speechSynthesis wrapper.
 *
 * `cancel()` is intentionally exposed separately and the page calls it ONLY from
 * the candidate's own "Skip reading" button. Nothing here cancels on unmount or
 * on a phase change, so the AI can never be cut off by a state transition.
 */
export default function useSpeechSynthesis() {
  const supported =
    typeof window !== "undefined" && typeof window.speechSynthesis !== "undefined";
  const [voices, setVoices] = useState([]);
  const [speaking, setSpeaking] = useState(false);
  const activeRef = useRef(null);

  useEffect(() => {
    if (!supported) return undefined;
    const load = () => setVoices(window.speechSynthesis.getVoices?.() || []);
    load();
    window.speechSynthesis.addEventListener?.("voiceschanged", load);
    return () => window.speechSynthesis.removeEventListener?.("voiceschanged", load);
  }, [supported]);

  const hasVoiceFor = useCallback(
    (lang) => {
      const wanted = normaliseLang(lang);
      const prefix = wanted.slice(0, 2);
      if (!voices.length) {
        // Voice lists can be empty before the browser loads them. Let the
        // utterance try instead of claiming there is no voice.
        return true;
      }
      return voices.some((voice) => {
        const code = normaliseLang(voice.lang);
        return code === wanted || code.startsWith(prefix);
      });
    },
    [voices],
  );

  const voiceFor = useCallback(
    (lang) => {
      const wanted = normaliseLang(lang);
      const prefix = wanted.slice(0, 2);
      return (
        voices.find((voice) => normaliseLang(voice.lang) === wanted) ||
        voices.find((voice) => normaliseLang(voice.lang).startsWith(prefix)) ||
        null
      );
    },
    [voices],
  );

  const speak = useCallback(
    (text, lang) =>
      new Promise((resolve) => {
        const clean = String(text || "").trim();
        if (!supported || !clean) {
          resolve({ spoken: false, reason: "unsupported" });
          return;
        }
        if (!hasVoiceFor(lang)) {
          resolve({ spoken: false, reason: "no_voice" });
          return;
        }
        let settled = false;
        const finish = (spoken, reason) => {
          if (settled) return;
          settled = true;
          setSpeaking(false);
          resolve({ spoken, reason: reason || (spoken ? "spoken" : "blocked") });
        };
        try {
          const synth = window.speechSynthesis;
          const utterance = new window.SpeechSynthesisUtterance(clean);
          utterance.lang = lang || "en-US";
          const voice = voiceFor(lang);
          if (voice) utterance.voice = voice;
          utterance.rate = 1;
          utterance.pitch = 1;
          utterance.onend = () => finish(true, "spoken");
          utterance.onerror = () => finish(false, "blocked");
          activeRef.current = utterance;
          setSpeaking(true);
          synth.speak(utterance);
          // Some engines never fire onend (tab suspended, no output device).
          // Do NOT cancel the utterance and do NOT start listening: that would
          // let the AI talk over the candidate. The candidate can tap the
          // visible "Skip reading" button when ready.
          setTimeout(() => finish(false, "timeout"), Math.min(MAX_UTTERANCE_MS, 6000 + clean.length * 90));
        } catch {
          finish(false, "blocked");
        }
      }),
    [hasVoiceFor, supported, voiceFor],
  );

  /** Only the candidate's Skip button may call this. */
  const cancel = useCallback(() => {
    if (!supported) return;
    try {
      window.speechSynthesis.cancel();
    } catch {
      /* ignore */
    }
    activeRef.current = null;
    setSpeaking(false);
  }, [supported]);

  /** Pause/resume are safe for a proctor overlay: they never discard the text. */
  const pause = useCallback(() => {
    if (!supported) return;
    try { window.speechSynthesis.pause?.(); } catch { /* ignore */ }
  }, [supported]);

  const resume = useCallback(() => {
    if (!supported) return;
    try { window.speechSynthesis.resume?.(); } catch { /* ignore */ }
  }, [supported]);

  return useMemo(
    () => ({ supported, voices, speaking, speak, cancel, pause, resume, hasVoiceFor }),
    [supported, voices, speaking, speak, cancel, pause, resume, hasVoiceFor],
  );
}
