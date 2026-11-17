import { useCallback, useEffect, useRef, useState } from "react";

export const trackLive = (stream, kind = "video") => Boolean(
  (kind === "audio" ? stream?.getAudioTracks() : stream?.getVideoTracks())
    ?.some((track) => track.readyState === "live" && !track.muted),
);

export default function useR1Devices(enabled) {
  const allowed = useRef(enabled);
  allowed.current = enabled;
  useEffect(() => () => { allowed.current = false; }, []);
  const [camera, setCamera] = useState(null);
  const [microphone, setMicrophone] = useState(null);
  const [audioContext, setAudioContext] = useState(null);
  const [cameraReady, setCameraReady] = useState(false);
  const [microphoneReady, setMicrophoneReady] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const enableCamera = useCallback(async () => {
    if (!enabled || busy) return;
    setBusy(true);
    setError("");
    let stream;
    const video = document.createElement("video");
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 } }, audio: false });
      video.muted = true;
      video.playsInline = true;
      video.srcObject = stream;
      await video.play();
      await new Promise((resolve, reject) => {
        const deadline = Date.now() + 8000;
        const check = () => {
          if (video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0 && trackLive(stream)) return resolve();
          if (Date.now() >= deadline) return reject(new Error("Camera permission was granted but no live frames arrived. Check your webcam and try again."));
          requestAnimationFrame(check);
        };
        check();
      });
      if (!allowed.current) throw new Error("R1 camera setup was cancelled.");
      setCamera(stream);
      setCameraReady(true);
    } catch (e) {
      stream?.getTracks().forEach((track) => track.stop());
      setError(e.name === "NotAllowedError" ? "Camera access was denied. Allow webcam access in the browser and click Enable camera again." : e.message);
    } finally {
      video.pause();
      video.srcObject = null;
      setBusy(false);
    }
  }, [enabled, busy]);
  const enableMicrophone = useCallback(async () => {
    if (!enabled || busy) return;
    setBusy(true);
    setError("");
    let stream, context;
    try {
      const Context = window.AudioContext || window.webkitAudioContext;
      if (!Context) throw new Error("This browser cannot perform the required local microphone-level check.");
      context = new Context();
      // Resume directly within the user's click, before the permission picker.
      await context.resume();
      stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      if (!trackLive(stream, "audio") || context.state !== "running") throw new Error("Microphone monitoring is not active. Allow access and try again.");
      const probe = context.createMediaStreamSource(stream);
      probe.disconnect();
      if (!allowed.current) throw new Error("R1 microphone setup was cancelled.");
      setMicrophone(stream);
      setAudioContext(context);
      setMicrophoneReady(true);
    } catch (e) {
      stream?.getTracks().forEach((track) => track.stop());
      context?.close().catch(() => {});
      setError(e.name === "NotAllowedError" ? "Microphone access was denied. Allow microphone access and click Enable microphone again." : e.message);
    } finally { setBusy(false); }
  }, [enabled, busy]);
  useEffect(() => {
    if (!enabled) {
      camera?.getTracks().forEach((track) => track.stop());
      microphone?.getTracks().forEach((track) => track.stop());
      setCameraReady(false);
      setMicrophoneReady(false);
    }
  }, [enabled, camera, microphone]);
  useEffect(() => {
    const tracks = [...(camera?.getVideoTracks() || []), ...(microphone?.getAudioTracks() || [])];
    const sync = () => { setCameraReady(trackLive(camera)); setMicrophoneReady(trackLive(microphone, "audio") && audioContext?.state === "running"); };
    tracks.forEach((track) => ["ended", "mute", "unmute"].forEach((event) => track.addEventListener(event, sync)));
    audioContext?.addEventListener("statechange", sync);
    sync();
    return () => {
      tracks.forEach((track) => ["ended", "mute", "unmute"].forEach((event) => track.removeEventListener(event, sync)));
      audioContext?.removeEventListener("statechange", sync);
    };
  }, [camera, microphone, audioContext]);
  // Returning from a hidden tab can suspend the AudioContext. Try to resume it
  // so the candidate is not stuck on "microphone inactive" after a focus change.
  useEffect(() => {
    if (!audioContext) return undefined;
    const resume = () => { if (audioContext.state === "suspended") audioContext.resume?.().catch(() => {}); };
    document.addEventListener("visibilitychange", resume);
    window.addEventListener("focus", resume);
    return () => {
      document.removeEventListener("visibilitychange", resume);
      window.removeEventListener("focus", resume);
    };
  }, [audioContext]);
  useEffect(() => () => camera?.getTracks().forEach((track) => track.stop()), [camera]);
  useEffect(() => () => microphone?.getTracks().forEach((track) => track.stop()), [microphone]);
  useEffect(() => () => { audioContext?.close().catch(() => {}); }, [audioContext]);
  const stop = () => {
    camera?.getTracks().forEach((track) => track.stop());
    microphone?.getTracks().forEach((track) => track.stop());
    setCamera(null);
    setMicrophone(null);
    setAudioContext(null);
  };
  return { camera, microphone, audioContext, cameraReady, microphoneReady, enableCamera, enableMicrophone, busy, error, stop };
}
