// Shared, preloadable on-device proctoring models.
//
// The verify page starts downloading/compiling these as soon as it mounts, so by
// the time the candidate has granted permissions the face check and the live
// monitor are ready instantly. Models run only in this browser; no media is
// sent anywhere by this module.
import { useEffect, useState } from "react";

const FACE_MODEL = "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";
const OBJECT_MODEL = "https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/float32/1/efficientdet_lite0.tflite";

const status = { vision: "idle", identity: "idle", visionError: "", identityError: "" };
const listeners = new Set();
const emit = (patch) => {
  Object.assign(status, patch);
  const snapshot = { ...status };
  listeners.forEach((listener) => listener(snapshot));
};

const blankCanvas = () => {
  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 64;
  canvas.getContext("2d")?.fillRect(0, 0, 64, 64);
  return canvas;
};

let visionPromise = null;
export function preloadVisionModels() {
  if (!visionPromise) {
    emit({ vision: "loading", visionError: "" });
    visionPromise = (async () => {
      const vision = await import("@mediapipe/tasks-vision");
      const files = await vision.FilesetResolver.forVisionTasks("/mediapipe/wasm");
      const create = async (Task, options) => {
        try { return await Task.createFromOptions(files, { ...options, baseOptions: { ...options.baseOptions, delegate: "GPU" } }); }
        catch { return Task.createFromOptions(files, { ...options, baseOptions: { ...options.baseOptions, delegate: "CPU" } }); }
      };
      // Load both models in parallel instead of one after the other.
      const [faceResult, objectResult] = await Promise.allSettled([
        create(vision.FaceLandmarker, { baseOptions: { modelAssetPath: FACE_MODEL }, runningMode: "VIDEO", numFaces: 3 }),
        create(vision.ObjectDetector, { baseOptions: { modelAssetPath: OBJECT_MODEL }, runningMode: "VIDEO", scoreThreshold: 0.45, maxResults: 10 }),
      ]);
      if (faceResult.status !== "fulfilled") throw faceResult.reason;
      const models = { face: faceResult.value, objects: objectResult.status === "fulfilled" ? objectResult.value : null };
      // Warm up GPU shaders once so the first real frame is not slow.
      try {
        const canvas = blankCanvas();
        const now = performance.now();
        models.face.detectForVideo(canvas, now);
        models.objects?.detectForVideo(canvas, now + 1);
      } catch { /* warm-up is best effort */ }
      emit({ vision: "ready" });
      return models;
    })().catch((error) => {
      visionPromise = null;
      emit({ vision: "error", visionError: error?.message || "model load failed" });
      throw error;
    });
  }
  return visionPromise;
}

let faceApiPromise = null;
export function loadFaceApi() {
  if (!faceApiPromise) {
    emit({ identity: "loading", identityError: "" });
    faceApiPromise = (async () => {
      const faceapi = await import("@vladmandic/face-api");
      // The bundled tfjs picks its backend lazily; initialise a concrete one
      // (WebGL, then CPU) before loading or running any model.
      const tf = faceapi.tf;
      if (tf?.setBackend) {
        let ready = false;
        for (const backend of ["webgl", "cpu"]) {
          try {
            const selected = await tf.setBackend(backend);
            if (selected === false) continue;
            await tf.ready();
            ready = true;
            break;
          } catch { /* try the next backend */ }
        }
        if (!ready) {
          throw new Error("Face analysis could not start in this browser. Use Chrome or Edge with hardware acceleration enabled, or continue with the manual identity check.");
        }
      }
      await Promise.all([
        faceapi.nets.tinyFaceDetector.loadFromUri("/face-api/model"),
        faceapi.nets.faceLandmark68TinyNet.loadFromUri("/face-api/model"),
        faceapi.nets.faceRecognitionNet.loadFromUri("/face-api/model"),
      ]);
      try {
        await faceapi.detectAllFaces(blankCanvas(), new faceapi.TinyFaceDetectorOptions({ inputSize: 128 }));
      } catch { /* warm-up is best effort */ }
      emit({ identity: "ready" });
      return faceapi;
    })().catch((error) => {
      faceApiPromise = null;
      emit({ identity: "error", identityError: error?.message || "model load failed" });
      throw error;
    });
  }
  return faceApiPromise;
}

/** Start every model the R1 verify page needs. Safe to call repeatedly. */
export function preloadProctorModels({ identity = true } = {}) {
  preloadVisionModels().catch(() => {});
  if (identity) loadFaceApi().catch(() => {});
}

export function useProctorModelStatus() {
  const [snapshot, setSnapshot] = useState(() => ({ ...status }));
  useEffect(() => {
    listeners.add(setSnapshot);
    setSnapshot({ ...status });
    return () => listeners.delete(setSnapshot);
  }, []);
  return snapshot;
}
