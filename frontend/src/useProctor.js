import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api.js";
import { proctorOverlay } from "./proctorLogic.js";

function tabId() {  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

/**
 * Browser-event proctoring, independent of the interview state machine.
 * It never changes the interview content; it only records factual events and
 * exposes a `blocked` overlay for fullscreen/camera/second-tab violations.
 */
export default function useProctor({
  inviteId,
  level = "standard",
  enabled = false,
  config,
  currentTurn = 0,
  cameraStream = null,
  cameraLive = false,
  enterFullscreenOnStart = false,
}) {
  const [fullscreenActive, setFullscreenActive] = useState(
    typeof document !== "undefined" && Boolean(document.fullscreenElement),
  );
  const [secondTab, setSecondTab] = useState(false);
  const [shareActive, setShareActive] = useState(false);
  const [shareError, setShareError] = useState("");
  const [notice, setNotice] = useState("");
  const [reportedCameraLost, setReportedCameraLost] = useState(false);

  const queueRef = useRef(Promise.resolve());
  const turnRef = useRef(currentTurn);
  const enabledRef = useRef(enabled);
  const fullscreenRef = useRef(fullscreenActive);
  const shareStreamRef = useRef(null);
  const shareTrackRef = useRef(null);
  const hiddenSince = useRef(0);
  const blurSince = useRef(0);
  const lastEvent = useRef({});
  const channelRef = useRef(null);
  const selfIdRef = useRef(tabId());

  turnRef.current = currentTurn;
  enabledRef.current = enabled;
  fullscreenRef.current = fullscreenActive;

  const report = useCallback((type, detail = {}, durationMs = 0, shot = null, turnNo = null) => {
    if (!enabledRef.current && type !== "fullscreen_exit") return Promise.resolve(null);
    const now = Date.now();
    const key = `${type}:${Math.floor(durationMs / 1000)}`;
    if (lastEvent.current[key] && now - lastEvent.current[key] < 1000) {
      return Promise.resolve(null); // 1 s client dedupe; the server also enforces 30 s
    }
    lastEvent.current[key] = now;
    const form = new FormData();
    form.append("event", JSON.stringify({
      type,
      turn_no: turnNo == null ? turnRef.current : turnNo,
      client_ts: now / 1000,
      duration_ms: Math.max(0, Number(durationMs) || 0),
      detail: { ...detail, source: "client_proctor_v1" },
    }));
    if (shot) form.append("shot", shot, "snapshot.jpg");
    queueRef.current = queueRef.current
      .catch(() => {})
      .then(() => api(`/interviews/${inviteId}/proctor/events`, { method: "POST", form }))
      .catch(() => null);
    return queueRef.current;
  }, [inviteId]);

  const reportRef = useRef(report);
  reportRef.current = report;

  const enterFullscreen = useCallback(async () => {
    try {
      if (!document.documentElement.requestFullscreen) throw new Error("unsupported");
      await document.documentElement.requestFullscreen();
      setFullscreenActive(Boolean(document.fullscreenElement));
      try { await navigator.keyboard?.lock?.(["Escape"]); } catch { /* best effort */ }
      return true;
    } catch {
      setNotice("Full screen could not start. Allow full screen for this site and try again.");
      return false;
    }
  }, []);

  useEffect(() => {
    if (!enabled || level === "off" || level === "light") return undefined;
    if (enterFullscreenOnStart && !document.fullscreenElement) {
      // Must be called from the Start click; the caller invokes before mounting
      // when possible. This is only a best-effort fallback.
      enterFullscreen();
    }
    return undefined;
  }, [enabled, level, enterFullscreenOnStart, enterFullscreen]);

  useEffect(() => {
    if (level === "off") return undefined;
    const fullscreen = () => {
      if (level === "light") return;
      const active = Boolean(document.fullscreenElement);
      setFullscreenActive(active);
      if (active) {
        reportRef.current("fullscreen_enter", {}, 0);
        try { navigator.keyboard?.lock?.(["Escape"]).catch(() => {}); } catch { /* ignore */ }
      } else if (enabledRef.current) {
        reportRef.current("fullscreen_exit", {}, 0);
        setNotice("Return to full screen to continue. The AI stays silent and recording continues.");
      }
    };
    const visibility = () => {
      if (document.visibilityState === "hidden") {
        hiddenSince.current = Date.now();
        reportRef.current("tab_hidden", {}, 0);
      } else {
        const lasted = hiddenSince.current ? Date.now() - hiddenSince.current : 0;
        hiddenSince.current = 0;
        reportRef.current("tab_visible", { visible: true }, lasted);
      }
    };
    const blur = () => {
      if (blurSince.current) return;
      blurSince.current = Date.now();
      reportRef.current("window_blur", {}, 0);
    };
    const focus = () => {
      if (!blurSince.current) return;
      const lasted = Date.now() - blurSince.current;
      blurSince.current = 0;
      reportRef.current("window_blur_end", {}, lasted);
    };
    const log = (type) => () => reportRef.current(type, {}, 0);
    const keydown = (event) => {
      const key = String(event.key || "").toLowerCase();
      const mod = event.ctrlKey || event.metaKey;
      if (key === "printscreen") {
        reportRef.current("printscreen", {}, 0);
        return;
      }
      if (key === "f12") {
        reportRef.current("devtools_shortcut", { reason: "f12" }, 0);
        return;
      }
      if (mod && event.shiftKey && ["i", "j", "c"].includes(key)) {
        reportRef.current("devtools_shortcut", { reason: "ctrl_shift_" + key }, 0);
        return;
      }
      if (mod && key === "u") {
        reportRef.current("devtools_shortcut", { reason: "ctrl_u" }, 0);
      }
    };
    const unload = (event) => {
      reportRef.current("beforeunload", {}, 0);
      event.preventDefault();
      event.returnValue = "";
      return "";
    };
    document.addEventListener("fullscreenchange", fullscreen);
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("blur", blur);
    window.addEventListener("focus", focus);
    document.addEventListener("copy", log("copy"), true);
    document.addEventListener("cut", log("cut"), true);
    document.addEventListener("paste", log("paste"), true);
    document.addEventListener("contextmenu", log("context_menu"), true);
    document.addEventListener("keydown", keydown, true);
    window.addEventListener("beforeunload", unload);
    return () => {
      document.removeEventListener("fullscreenchange", fullscreen);
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("blur", blur);
      window.removeEventListener("focus", focus);
      document.removeEventListener("copy", log("copy"), true);
      document.removeEventListener("cut", log("cut"), true);
      document.removeEventListener("paste", log("paste"), true);
      document.removeEventListener("contextmenu", log("context_menu"), true);
      document.removeEventListener("keydown", keydown, true);
      window.removeEventListener("beforeunload", unload);
      try { navigator.keyboard?.unlock?.(); } catch { /* ignore */ }
    };
  }, [enabled, level]);

  // Camera track loss -> overlay + advisory event.
  useEffect(() => {
    if (!enabled || !cameraStream || !["standard", "strict"].includes(level)) return undefined;
    const tracks = cameraStream.getVideoTracks();
    const lost = () => {
      setReportedCameraLost(true);
      reportRef.current("camera_lost", { reason: "track_ended_or_muted" }, 0);
      setNotice("Your camera stopped. Restore it to continue; the interview is paused visually, not failed.");
    };
    const restored = () => {
      setReportedCameraLost(false);
      setNotice("");
    };
    tracks.forEach((track) => {
      track.addEventListener("ended", lost);
      track.addEventListener("mute", lost);
      track.addEventListener("unmute", restored);
    });
    const device = () => reportRef.current("camera_lost", { reason: "devicechange" }, 0);
    navigator.mediaDevices?.addEventListener?.("devicechange", device);
    return () => {
      tracks.forEach((track) => {
        track.removeEventListener("ended", lost);
        track.removeEventListener("mute", lost);
        track.removeEventListener("unmute", restored);
      });
      navigator.mediaDevices?.removeEventListener?.("devicechange", device);
    };
  }, [enabled, level, cameraStream]);

  // Strict: reuse the exam's getDisplayMedia + screen-share event names.
  const stopScreenShare = useCallback(() => {
    shareTrackRef.current = null;
    shareStreamRef.current?.getTracks?.().forEach((track) => track.stop());
    shareStreamRef.current = null;
    setShareActive(false);
  }, []);

  const startScreenShare = useCallback(async () => {
    setShareError("");
    try {
      if (!navigator.mediaDevices?.getDisplayMedia) {
        throw new Error("Screen sharing is not available in this browser.");
      }
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: 5 }, audio: false,
      });
      const track = stream.getVideoTracks()[0];
      shareStreamRef.current = stream;
      shareTrackRef.current = track;
      setShareActive(track?.readyState === "live");
      track?.addEventListener("ended", () => {
        setShareActive(false);
        reportRef.current("screen_share_stopped", { reason: "track_ended" }, 0);
      });
      reportRef.current("screen_share_started", {
        surface: track?.getSettings?.().displaySurface || "unknown",
      }, 0);
      return true;
    } catch (error) {
      setShareError(error?.message || "Screen sharing could not start.");
      return false;
    }
  }, []);

  useEffect(() => () => {
    shareStreamRef.current?.getTracks?.().forEach((track) => track.stop());
    shareStreamRef.current = null;
  }, []);

  // Second tab detection (best effort; the server also stores the event).
  useEffect(() => {
    if (!enabled || typeof BroadcastChannel === "undefined") return undefined;
    const channel = new BroadcastChannel(`ai-interview-${inviteId}`);
    channelRef.current = channel;
    const selfId = selfIdRef.current;
    channel.onmessage = (event) => {
      const message = event.data || {};
      if (!message || message.from === selfId) return;
      if (message.type === "claim") {
        setSecondTab(true);
        reportRef.current("second_tab", { reason: "claimed_elsewhere" }, 0);
      } else if (message.type === "hello") {
        setSecondTab(true);
        reportRef.current("second_tab", { reason: "second_tab_opened" }, 0);
      }
    };
    channel.postMessage({ type: "hello", from: selfId });
    return () => {
      channel.close();
      channelRef.current = null;
    };
  }, [enabled, inviteId]);

  const claimTab = useCallback(() => {
    setSecondTab(false);
    channelRef.current?.postMessage({ type: "claim", from: selfIdRef.current });
  }, []);

  const overlay = useMemo(() => proctorOverlay({
    level,
    fullscreenActive,
    cameraLive,
    shareLive: shareActive,
    secondTab,
  }), [level, fullscreenActive, cameraLive, shareActive, secondTab]);

  const blocked = Boolean(overlay);

  return {
    report,
    blocked,
    overlay,
    fullscreenActive,
    enterFullscreen,
    shareActive,
    shareError,
    startScreenShare,
    stopScreenShare,
    secondTab,
    claimTab,
    notice,
    setNotice,
    cameraLost: reportedCameraLost || (["standard", "strict"].includes(level) && !cameraLive && enabled),
    config,
  };
}
