import { useCallback, useEffect, useRef, useState } from "react";

/**
 * One camera stream for pre-check + the interview. It is never recorded; only
 * on-device analysis reads the frames.
 */
export default function useCameraStream() {
  const [stream, setStream] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const streamRef = useRef(null);

  const stop = useCallback(() => {
    streamRef.current?.getTracks?.().forEach((track) => track.stop());
    streamRef.current = null;
    setStream(null);
  }, []);

  const start = useCallback(async () => {
    if (busy) return null;
    setBusy(true);
    setError("");
    try {
      const next = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 } },
        audio: false,
      });
      streamRef.current = next;
      setStream(next);
      return next;
    } catch (err) {
      const name = err?.name || "";
      setError(
        name === "NotAllowedError" || name === "SecurityError"
          ? "Camera permission is blocked. Allow camera access in your browser settings and try again."
          : name === "NotFoundError"
            ? "No camera was found. You can request a manual/Zoom interview instead."
            : name === "NotReadableError"
              ? "Your camera is busy in another app. Close it and try again."
              : "The camera could not start. Check your device and try again.",
      );
      return null;
    } finally {
      setBusy(false);
    }
  }, [busy]);

  useEffect(() => () => stop(), [stop]);

  const live = Boolean(stream?.getVideoTracks()?.some((track) => track.readyState === "live" && !track.muted));

  return { stream, start, stop, busy, error, live };
}
