import { useEffect, useRef, useState } from "react";
import { api } from "./api.js";

const EVIDENCE_TYPES = new Set(["ai_no_face", "ai_multiple_faces", "ai_phone_detected", "ai_audio_level", "tab_hidden", "blur", "fullscreen_exit", "copy", "cut", "paste", "camera_stopped", "microphone_stopped", "screen_share_stopped", "screen_share_unavailable"]);

export default function useExamMonitoring({ enabled, initial, integrity, screenStream, cameraStream, micStream, audioContext }) {
  const [evidenceStatus, setEvidenceStatus] = useState("Event-triggered screenshots: ready");
  const cameraVideo = useRef(null), screenVideo = useRef(null);
  const queue = useRef(Promise.resolve());
  const last = useRef({});
  const count = useRef(0);
  const { report, flushEvents, evidenceHandler } = integrity;
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const makeVideo = (stream) => {
      const video = document.createElement("video");
      video.muted = true;
      video.playsInline = true;
      video.srcObject = stream;
      video.play().catch(() => { if (!cancelled) setEvidenceStatus("Snapshot preview unavailable; event flags still save. Restore permissions or quit."); });
      return video;
    };
    cameraVideo.current = makeVideo(cameraStream);
    screenVideo.current = makeVideo(screenStream);
    const snapshot = (video) => {
      if (!video || video.readyState < 2 || !video.videoWidth || !video.videoHeight) return Promise.resolve(null);
      const canvas = document.createElement("canvas");
      const scale = Math.min(1, 960 / video.videoWidth, 720 / video.videoHeight);
      canvas.width = Math.max(1, Math.round(scale * video.videoWidth));
      canvas.height = Math.max(1, Math.round(scale * video.videoHeight));
      canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);
      return new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.6));
    };
    const receive = async (event) => {
      if (!EVIDENCE_TYPES.has(event.type) || cancelled || count.current >= initial.proctoring.max_snapshots) return;
      const now = Date.now();
      if (now - (last.current[event.type] || 0) < 15000) return;
      last.current[event.type] = now;
      // Capture now, not after an upload queue delay. Missing frames are not
      // fabricated or represented as proof of what happened off-screen.
      const frames = await Promise.all([
        snapshot(cameraVideo.current).then((blob) => ["camera", blob]),
        snapshot(screenVideo.current).then((blob) => ["screen", blob]),
      ]);
      queue.current = queue.current.catch(() => {}).then(async () => {
        if (cancelled) return;
        await flushEvents();
        for (const [source, blob] of frames) {
          if (cancelled) return;
          if (!blob || blob.size > 180 * 1024) {
            setEvidenceStatus("A snapshot could not be captured; the event flag remains in the review timeline.");
            continue;
          }
          if (count.current >= initial.proctoring.max_snapshots) break;
          const form = new FormData();
          form.append("session_id", initial.session_id);
          form.append("event_seq", String(event.seq));
          form.append("event_type", event.type);
          form.append("confidence", String(event.metadata.confidence ?? 0));
          form.append("source", source);
          form.append("image", blob, `${source}-snapshot.jpg`);
          try {
            await api(`/attempts/${initial.attempt_id}/evidence`, { method: "POST", form });
            count.current++;
            setEvidenceStatus(count.current >= initial.proctoring.max_snapshots
              ? "Screenshot limit reached; event flags continue to save for human review."
              : `${count.current} evidence snapshots saved · human review only`);
          } catch (e) {
            if (e.status === 429) count.current = initial.proctoring.max_snapshots;
            setEvidenceStatus("Snapshot upload unavailable or retention limit reached; event flags remain separate. Restore your connection or quit.");
          }
        }
      });
    };
    evidenceHandler.current = (event) => { receive(event).catch(() => { if (!cancelled) setEvidenceStatus("Snapshot capture failed; event flags still save separately."); }); };
    return () => {
      cancelled = true;
      evidenceHandler.current = null;
      [cameraVideo.current, screenVideo.current].forEach((video) => { video?.pause(); if (video) video.srcObject = null; });
    };
  }, [enabled, initial, cameraStream, screenStream, evidenceHandler, flushEvents]);
  useEffect(() => {
    if (!enabled) return;
    const tracks = [[cameraStream?.getVideoTracks()[0], "camera"], [micStream?.getAudioTracks()[0], "microphone"]];
    const cleanups = [];
    tracks.forEach(([track, kind]) => {
      if (!track) return;
      const sync = () => report(`${kind}_${track.readyState === "live" && !track.muted ? "started" : "stopped"}`, { reason: "media_track_status", local_only: true });
      sync();
      ["ended", "mute", "unmute"].forEach((type) => track.addEventListener(type, sync));
      cleanups.push(() => ["ended", "mute", "unmute"].forEach((type) => track.removeEventListener(type, sync)));
    });
    return () => cleanups.forEach((cleanup) => cleanup());
  }, [enabled, cameraStream, micStream, report]);
  useEffect(() => {
    if (!enabled || !micStream || !audioContext) return;
    let source, analyser;
    try {
      source = audioContext.createMediaStreamSource(micStream);
      analyser = audioContext.createAnalyser();
      analyser.fftSize = 2048;
      source.connect(analyser);
    } catch {
      report("microphone_stopped", { reason: "audio_analyser_unavailable", local_only: true });
      return;
    }
    const data = new Float32Array(analyser.fftSize);
    let since = 0, lastFlag = 0;
    const threshold = 0.028;
    const timer = setInterval(() => {
      if (audioContext.state !== "running") return;
      analyser.getFloatTimeDomainData(data);
      const rms = Math.sqrt(data.reduce((sum, value) => sum + value * value, 0) / data.length);
      const now = Date.now();
      if (rms > threshold) {
        if (!since) since = now;
        if (now - since >= 1000 && now - lastFlag >= 15000) {
          report("ai_audio_level", { level: Number(rms.toFixed(4)), threshold, duration_ms: now - since, model: "local_rms_threshold_v1", local_only: true });
          lastFlag = now;
          since = now;
        }
      } else { since = 0; }
    }, 250);
    const contextChanged = () => report(audioContext.state === "running" ? "microphone_started" : "microphone_stopped", { reason: "audio_context_" + audioContext.state, local_only: true });
    audioContext.addEventListener("statechange", contextChanged);
    return () => {
      clearInterval(timer);
      source.disconnect();
      audioContext.removeEventListener("statechange", contextChanged);
    };
  }, [enabled, micStream, audioContext, report]);
  return { evidenceStatus };
}
