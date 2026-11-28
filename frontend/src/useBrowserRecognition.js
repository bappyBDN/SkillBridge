import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Browser SpeechRecognition (Chrome/Edge only) used as a live preview and as
 * the transcript fallback when server-side Whisper is unavailable.
 *
 * The browser may send audio to its vendor for this preview; the consent screen
 * says so. Recognition auto-restarts while listening because Chrome stops the
 * engine after a short silence.
 */
export default function useBrowserRecognition({ lang, active }) {
  const Recognition =
    typeof window !== "undefined"
      ? window.SpeechRecognition || window.webkitSpeechRecognition
      : null;
  const supported = Boolean(Recognition);

  const [transcript, setTranscript] = useState("");
  const [listening, setListening] = useState(false);
  const recognitionRef = useRef(null);
  const finalRef = useRef("");
  const activeRef = useRef(false);
  const restartRef = useRef(0);
  const langRef = useRef(lang);

  langRef.current = lang;

  const reset = useCallback(() => {
    finalRef.current = "";
    setTranscript("");
  }, []);

  useEffect(() => {
    activeRef.current = Boolean(active);
    if (!supported || !Recognition) return undefined;

    const cleanup = () => {
      clearTimeout(restartRef.current);
      const current = recognitionRef.current;
      recognitionRef.current = null;
      try {
        current?.abort?.();
      } catch {
        /* ignore */
      }
      setListening(false);
    };

    if (!active) {
      cleanup();
      return cleanup;
    }

    const startEngine = () => {
      if (!activeRef.current) return;
      try {
        const recognition = new Recognition();
        recognition.lang = langRef.current || "en-US";
        recognition.continuous = true;
        recognition.interimResults = true;
        recognition.maxAlternatives = 1;
        recognition.onstart = () => setListening(true);
        recognition.onresult = (event) => {
          let finalText = "";
          let interimText = "";
          for (let i = event.resultIndex; i < event.results.length; i += 1) {
            const result = event.results[i];
            if (result.isFinal) finalText += result[0].transcript;
            else interimText += result[0].transcript;
          }
          if (finalText) {
            finalRef.current = `${finalRef.current} ${finalText}`.replace(/\s+/g, " ").trim();
          }
          setTranscript(`${finalRef.current} ${interimText}`.replace(/\s+/g, " ").trim());
        };
        recognition.onerror = (event) => {
          // "no-speech"/"aborted" are normal; the restart below keeps it alive.
          if (event?.error === "not-allowed" || event?.error === "service-not-allowed") {
            activeRef.current = false;
            setListening(false);
          }
        };
        recognition.onend = () => {
          setListening(false);
          if (activeRef.current) {
            clearTimeout(restartRef.current);
            restartRef.current = setTimeout(startEngine, 250);
          }
        };
        recognitionRef.current = recognition;
        recognition.start();
      } catch {
        setListening(false);
        if (activeRef.current) {
          clearTimeout(restartRef.current);
          restartRef.current = setTimeout(startEngine, 500);
        }
      }
    };

    startEngine();
    return cleanup;
  }, [active, supported, Recognition]);

  return { supported, transcript, listening, reset };
}
