import { useCallback, useEffect, useRef, useState } from "react";
import { analysisDelayMs, isGazeSuppressed } from "./proctorLogic.js";

const MODEL_URL =
  import.meta.env?.VITE_FACE_LANDMARKER_MODEL ||
  "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";
const WASM_PATH = import.meta.env?.VITE_MEDIAPIPE_WASM_PATH || "/mediapipe/wasm";

const GAZE_NAMES = [
  "eyeLookInLeft", "eyeLookInRight", "eyeLookOutLeft", "eyeLookOutRight",
  "eyeLookUpLeft", "eyeLookUpRight", "eyeLookDownLeft", "eyeLookDownRight",
];

let landmarkerPromise = null;

async function loadLandmarker() {
  if (!landmarkerPromise) {
    landmarkerPromise = (async () => {
      const vision = await import("@mediapipe/tasks-vision");
      const files = await vision.FilesetResolver.forVisionTasks(WASM_PATH);
      const options = {
        baseOptions: { modelAssetPath: MODEL_URL },
        runningMode: "VIDEO",
        numFaces: 3,
        outputFaceBlendshapes: true,
        outputFacialTransformationMatrixes: true,
      };
      try {
        return await vision.FaceLandmarker.createFromOptions(files, {
          ...options,
          baseOptions: { ...options.baseOptions, delegate: "GPU" },
        });
      } catch {
        return vision.FaceLandmarker.createFromOptions(files, {
          ...options,
          baseOptions: { ...options.baseOptions, delegate: "CPU" },
        });
      }
    })().catch((error) => {
      landmarkerPromise = null;
      throw error;
    });
  }
  return landmarkerPromise;
}

function matrixData(matrix) {
  if (!matrix) return null;
  const raw = matrix.data || matrix;
  const flat = Array.isArray(raw[0]) ? raw.flat() : raw;
  return Array.isArray(flat) && flat.length >= 16 ? flat : null;
}

function poseFromMatrix(matrix) {
  const m = matrixData(matrix);
  if (!m) return { yaw: 0, pitch: 0 };
  // MediaPipe returns a 4x4 canonical-to-observed matrix. We only use the
  // rotation part and always compare against the calibrated neutral pose, so a
  // sign/axis convention difference cancels out between baseline and sample.
  const yaw = (Math.atan2(m[8] || 0, m[10] || 0) * 180) / Math.PI;
  const pitch = (Math.asin(Math.max(-1, Math.min(1, -(m[9] || 0)))) * 180) / Math.PI;
  return { yaw, pitch };
}

function gazeVector(result) {
  const categories = result?.faceBlendshapes?.[0]?.categories;
  if (!Array.isArray(categories) || !categories.length) return null;
  const byName = {};
  for (const category of categories) byName[category.categoryName] = category.score;
  if (!GAZE_NAMES.every((name) => typeof byName[name] === "number")) return null;
  return GAZE_NAMES.map((name) => byName[name]);
}

function vectorDistance(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return 0;
  return Math.sqrt(a.reduce((sum, value, index) => sum + (value - b[index]) ** 2, 0));
}

function averageVector(vectors) {
  const valid = vectors.filter((value) => Array.isArray(value));
  if (!valid.length) return null;
  const length = valid[0].length;
  return Array.from({ length }, (_, index) =>
    valid.reduce((sum, value) => sum + (value[index] || 0), 0) / valid.length);
}

function lightingLabel(video) {
  try {
    const canvas = document.createElement("canvas");
    canvas.width = 32;
    canvas.height = 32;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    context.drawImage(video, 0, 0, 32, 32);
    const data = context.getImageData(0, 0, 32, 32).data;
    let total = 0;
    for (let i = 0; i < data.length; i += 4) {
      total += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    }
    const mean = total / (data.length / 4);
    if (mean < 55) return "low";
    if (mean > 215) return "bright";
    return "good";
  } catch {
    return "unknown";
  }
}

export function captureFrame(video, maxWidth = 640, quality = 0.6) {
  if (!video || video.readyState < 2 || !video.videoWidth) return Promise.resolve(null);
  const scale = Math.min(1, maxWidth / video.videoWidth);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
  canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
  canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
}

/**
 * On-device FaceLandmarker loop. Throttled to ~2.5 fps, paused when the tab is
 * hidden, slower when frame processing is expensive. It emits factual events
 * only; the server recomputes severity.
 */
export default function useCameraAnalysis({
  videoRef,
  stream,
  enabled,
  paused = false,
  config,
  calibration,
  questionShownAt,
  turnNo,
  onFlag,
  onUnavailable,
  onMetrics,
}) {
  const [loading, setLoading] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const [metrics, setMetrics] = useState(null);
  const stateRef = useRef({
    absentSince: null, absentSent: false,
    multipleSince: null, multipleSent: false,
    headSince: null, headSent: false,
    gazeSince: null, gazeSent: false,
    gazeIntervals: [], lastCumulativeEmit: 0,
    lastLighting: 0, lighting: "unknown",
  });
  const metricsRef = useRef(null);
  const paramsRef = useRef({});
  paramsRef.current = { config, calibration, questionShownAt, turnNo, onFlag, onUnavailable, onMetrics, paused };

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !stream) return undefined;
    video.srcObject = stream;
    video.muted = true;
    video.playsInline = true;
    video.play().catch(() => {});
    return () => {
      try { video.pause(); } catch { /* ignore */ }
      video.srcObject = null;
    };
  }, [videoRef, stream]);

  useEffect(() => {
    if (!enabled || !stream) return undefined;
    let cancelled = false;
    let timer = 0;
    let lastTimestamp = 0;

    const schedule = (delay) => {
      if (cancelled) return;
      timer = setTimeout(loop, delay);
    };

    const emit = async (type, durationMs, detail, needsShot) => {
      const params = paramsRef.current;
      if (!params.onFlag) return;
      let shot = null;
      if (needsShot) shot = await captureFrame(videoRef.current);
      params.onFlag({ type, duration_ms: durationMs, detail, shot, turn_no: params.turnNo });
    };

    const handle = (result) => {
      const params = paramsRef.current;
      const now = Date.now();
      const tracker = stateRef.current;
      const faceCount = result?.faceLandmarks?.length || 0;
      const matrix = result?.facialTransformationMatrixes?.[0];
      const pose = poseFromMatrix(matrix);
  const safeYaw = Number.isFinite(pose.yaw) ? pose.yaw : 0;
  const safePitch = Number.isFinite(pose.pitch) ? pose.pitch : 0;
      const gaze = gazeVector(result);
      const thresholds = params.config.thresholds;
      const base = params.calibration || {};
      const baseYaw = Number(base.yaw || 0);
      const basePitch = Number(base.pitch || 0);
      const baseGaze = Array.isArray(base.gaze) ? base.gaze : null;
      const gazeDelta = baseGaze && gaze ? vectorDistance(gaze, baseGaze) : null;
      if (now - tracker.lastLighting > 1200) {
        tracker.lighting = lightingLabel(videoRef.current);
        tracker.lastLighting = now;
      }
      const nextMetrics = {
        face_count: faceCount,
        yaw: Number(safeYaw.toFixed(1)),
        pitch: Number(safePitch.toFixed(1)),
        gaze_delta: gazeDelta == null ? null : Number(gazeDelta.toFixed(3)),
        gaze_available: Boolean(baseGaze && gaze),
        gaze_vector: gaze,
        lighting: tracker.lighting,
      };
      metricsRef.current = nextMetrics;
      setMetrics(nextMetrics);
      params.onMetrics?.(nextMetrics);

      // Face absent
      if (faceCount === 0) {
        if (tracker.absentSince == null) {
          tracker.absentSince = now;
          tracker.absentSent = false;
        }
        const duration = now - tracker.absentSince;
        if (!tracker.absentSent && duration >= thresholds.face_absent.min_ms) {
          tracker.absentSent = true;
          emit("face_absent", duration, { face_count: 0 }, true);
        }
      } else {
        tracker.absentSince = null;
        tracker.absentSent = false;
      }

      // Multiple faces
      if (faceCount >= 2) {
        if (tracker.multipleSince == null) {
          tracker.multipleSince = now;
          tracker.multipleSent = false;
        }
        const duration = now - tracker.multipleSince;
        if (!tracker.multipleSent && duration >= thresholds.multiple_faces.min_ms) {
          tracker.multipleSent = true;
          emit("multiple_faces", duration, { face_count: faceCount }, true);
        }
      } else {
        tracker.multipleSince = null;
        tracker.multipleSent = false;
      }

      // Head turned away from the calibrated neutral pose
      if (faceCount >= 1) {
        const off = Math.abs(safeYaw - baseYaw) > thresholds.head_turned.degrees
          || Math.abs(safePitch - basePitch) > thresholds.head_turned.degrees;
        if (off) {
          if (tracker.headSince == null) {
            tracker.headSince = now;
            tracker.headSent = false;
          }
          const duration = now - tracker.headSince;
          if (!tracker.headSent && duration >= thresholds.head_turned.min_ms) {
            tracker.headSent = true;
            emit("head_turned", duration, {
              yaw_delta: Number((safeYaw - baseYaw).toFixed(1)),
              pitch_delta: Number((safePitch - basePitch).toFixed(1)),
            }, true);
          }
        } else {
          tracker.headSince = null;
          tracker.headSent = false;
        }
      } else {
        tracker.headSince = null;
        tracker.headSent = false;
      }

      // Gaze: suppressed for 3 s after a new question, never a single glance.
      const suppressed = isGazeSuppressed(params.questionShownAt, now,
        params.config.gaze_suppression_ms);
      if (suppressed) {
        tracker.gazeSince = null;
        tracker.gazeSent = false;
      } else if (gazeDelta != null) {
        const lookingAway = gazeDelta >= thresholds.gaze_away.deviation;
        if (lookingAway) {
          if (tracker.gazeSince == null) {
            tracker.gazeSince = now;
            tracker.gazeSent = false;
          }
          const duration = now - tracker.gazeSince;
          if (!tracker.gazeSent && duration >= thresholds.gaze_away.min_ms) {
            tracker.gazeSent = true;
            tracker.gazeIntervals.push({ start: tracker.gazeSince, end: now });
            const windowStart = now - thresholds.gaze_away.window_ms;
            tracker.gazeIntervals = tracker.gazeIntervals.filter((item) => item.end >= windowStart);
            const cumulative = tracker.gazeIntervals.reduce(
              (sum, item) => sum + (item.end - item.start), 0);
            emit("gaze_away", duration, {
              cumulative_ms: cumulative,
              window_ms: thresholds.gaze_away.window_ms,
              gaze_x: gazeDelta,
            }, false);
          }
        } else {
          if (tracker.gazeSince != null) {
            tracker.gazeIntervals.push({ start: tracker.gazeSince, end: now });
          }
          tracker.gazeSince = null;
          tracker.gazeSent = false;
          if (tracker.gazeIntervals.length) {
            const windowStart = now - thresholds.gaze_away.window_ms;
            tracker.gazeIntervals = tracker.gazeIntervals.filter((item) => item.end >= windowStart);
            const cumulative = tracker.gazeIntervals.reduce(
              (sum, item) => sum + (item.end - item.start), 0);
            if (cumulative >= thresholds.gaze_away.cumulative_ms
                && now - tracker.lastCumulativeEmit > 5000) {
              tracker.lastCumulativeEmit = now;
              emit("gaze_away", tracker.gazeIntervals[tracker.gazeIntervals.length - 1].end
                - tracker.gazeIntervals[0].start, {
                cumulative_ms: cumulative,
                window_ms: thresholds.gaze_away.window_ms,
                gaze_x: gazeDelta,
              }, false);
            }
          }
        }
      }
    };

    const loop = async () => {
      if (cancelled) return;
      const video = videoRef.current;
      if (!video || video.readyState < 2 || !video.videoWidth) {
        schedule(600);
        return;
      }
      if (video.srcObject !== stream) {
        video.srcObject = stream;
        video.muted = true;
        video.playsInline = true;
        video.play().catch(() => {});
      }
      if (paramsRef.current.paused || document.visibilityState === "hidden") {
        schedule(analysisDelayMs(0, true));
        return;
      }
      const started = performance.now();
      try {
        const timestamp = Math.max(lastTimestamp + 1, Math.round(performance.now()));
        lastTimestamp = timestamp;
        const result = landmarker.detectForVideo(video, timestamp);
        handle(result);
      } catch {
        if (!cancelled) {
          setUnavailable(true);
          paramsRef.current.onUnavailable?.("face_landmarker_failed");
        }
        return;
      }
      schedule(analysisDelayMs(performance.now() - started, false));
    };

    let landmarker;
    setLoading(true);
    loadLandmarker()
      .then((instance) => {
        landmarker = instance;
        if (!cancelled) {
          setLoading(false);
          setUnavailable(false);
          loop();
        }
      })
      .catch(() => {
        if (!cancelled) {
          setLoading(false);
          setUnavailable(true);
          paramsRef.current.onUnavailable?.("face_landmarker_unavailable");
        }
      });
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [enabled, stream, videoRef]);

  const sampleBaseline = useCallback((durationMs = 5000) =>
    new Promise((resolve) => {
      const poses = [];
      const gazes = [];
      const id = setInterval(() => {
        const current = metricsRef.current;
        if (current && current.face_count >= 1) {
          poses.push({ yaw: current.yaw, pitch: current.pitch });
          if (current.gaze_vector) gazes.push(current.gaze_vector);
        }
      }, 120);
      setTimeout(() => {
        clearInterval(id);
        if (!poses.length) {
          resolve(null);
          return;
        }
        resolve({
          yaw: poses.reduce((sum, item) => sum + item.yaw, 0) / poses.length,
          pitch: poses.reduce((sum, item) => sum + item.pitch, 0) / poses.length,
          gaze: averageVector(gazes),
          samples: poses.length,
        });
      }, durationMs);
    }), []);

  return { loading, unavailable, metrics, sampleBaseline, captureFrame };
}
