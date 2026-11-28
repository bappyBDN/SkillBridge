import { useCallback, useEffect, useRef, useState } from "react";

const SPEECH_LEVEL = 0.12;

function micErrorMessage(error) {
  const name = error?.name || "";
  if (name === "NotAllowedError" || name === "SecurityError") {
    return "Microphone permission is blocked. Allow microphone access in your browser settings, then try again.";
  }
  if (name === "NotFoundError" || name === "DevicesNotFoundError") {
    return "No microphone was found. Connect a microphone and try again.";
  }
  if (name === "NotReadableError" || name === "TrackStartError") {
    return "Your microphone is busy in another app. Close it and try again.";
  }
  return "The microphone could not start. Check your device and try again.";
}

/**
 * MediaRecorder + AnalyserNode. Records each answer as low-bitrate Opus WebM.
 * The stream is stopped between answers so the microphone indicator is off
 * while the AI is asking the next question.
 */
export default function useRecorder() {
  const supported =
    typeof navigator !== "undefined" &&
    Boolean(navigator.mediaDevices?.getUserMedia) &&
    typeof window !== "undefined" &&
    typeof window.MediaRecorder !== "undefined";

  const [active, setActive] = useState(false);
  const [level, setLevel] = useState(0);
  const [error, setError] = useState("");

  const streamRef = useRef(null);
  const recorderRef = useRef(null);
  const chunksRef = useRef([]);
  const blobRef = useRef(null);
  const audioContextRef = useRef(null);
  const analyserRef = useRef(null);
  const rafRef = useRef(0);
  const stopWaitersRef = useRef([]);
  const mimeRef = useRef("audio/webm");

  const teardown = useCallback(() => {
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
    }
    try {
      audioContextRef.current?.close?.();
    } catch {
      /* ignore */
    }
    audioContextRef.current = null;
    analyserRef.current = null;
    try {
      streamRef.current?.getTracks?.().forEach((track) => track.stop());
    } catch {
      /* ignore */
    }
    streamRef.current = null;
    recorderRef.current = null;
    setActive(false);
    setLevel(0);
  }, []);

  const stop = useCallback(
    () =>
      new Promise((resolve) => {
        const recorder = recorderRef.current;
        if (!recorder || recorder.state === "inactive") {
          teardown();
          resolve(blobRef.current);
          return;
        }
        const done = () => {
          teardown();
          resolve(blobRef.current);
        };
        stopWaitersRef.current.push(done);
        try {
          recorder.stop();
        } catch {
          done();
        }
      }),
    [teardown],
  );

  const start = useCallback(async () => {
    if (!supported) {
      setError("This browser cannot record audio. Use Chrome, Edge or Safari.");
      return false;
    }
    if (recorderRef.current && recorderRef.current.state === "recording") return true;
    try {
      setError("");
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
        },
        video: false,
      });
      streamRef.current = stream;
      const mime = window.MediaRecorder.isTypeSupported?.("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : "audio/webm";
      mimeRef.current = mime;
      const recorder = new window.MediaRecorder(stream, {
        mimeType: mime,
        audioBitsPerSecond: 32000,
      });
      chunksRef.current = [];
      recorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) chunksRef.current.push(event.data);
      };
      recorder.onstop = () => {
        const type = (mimeRef.current || "audio/webm").split(";")[0];
        blobRef.current = chunksRef.current.length
          ? new Blob(chunksRef.current, { type })
          : null;
        chunksRef.current = [];
        const waiters = stopWaitersRef.current;
        stopWaitersRef.current = [];
        waiters.forEach((resolve) => {
          try {
            resolve();
          } catch {
            /* ignore */
          }
        });
      };
      recorder.start(500);
      recorderRef.current = recorder;

      const Context = window.AudioContext || window.webkitAudioContext;
      if (Context) {
        const context = new Context();
        const source = context.createMediaStreamSource(stream);
        const analyser = context.createAnalyser();
        analyser.fftSize = 1024;
        source.connect(analyser);
        audioContextRef.current = context;
        analyserRef.current = analyser;
        if (context.state === "suspended") context.resume?.().catch(() => {});
        const samples = new Uint8Array(analyser.fftSize);
        const measure = () => {
          const node = analyserRef.current;
          if (!node) return;
          node.getByteTimeDomainData(samples);
          let sum = 0;
          for (let i = 0; i < samples.length; i += 1) {
            const value = (samples[i] - 128) / 128;
            sum += value * value;
          }
          const rms = Math.sqrt(sum / samples.length);
          setLevel(Math.min(1, rms * 14));
          rafRef.current = requestAnimationFrame(measure);
        };
        rafRef.current = requestAnimationFrame(measure);
      }
      setActive(true);
      return true;
    } catch (err) {
      setError(micErrorMessage(err));
      teardown();
      return false;
    }
  }, [supported, teardown]);

  useEffect(
    () => () => {
      // Never leave the microphone open after leaving the page.
      const recorder = recorderRef.current;
      try {
        if (recorder && recorder.state !== "inactive") recorder.stop();
      } catch {
        /* ignore */
      }
      teardown();
    },
    [teardown],
  );

  return { supported, active, level, error, start, stop, speechLevel: SPEECH_LEVEL };
}
