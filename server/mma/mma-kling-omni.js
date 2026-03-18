// server/mma/mma-kling-omni.js — Kling Omni (O3), Motion Control, and Fabric Audio runners
"use strict";

import { getReplicate } from "./mma-clients.js";
import { getMmaConfig } from "./mma-config.js";
import { safeStr, asHttpUrl } from "./mma-helpers.js";
import { nowIso } from "./mma-utils.js";
import { replicatePredictWithTimeout } from "./replicate-poll.js";
import {
  normalizeKlingSourceMode,
  extractKlingTaskStatus,
  submitAndPollKlingTask,
  KLING_DEFAULT_NEGATIVE_PROMPT,
} from "./mma-kling.js";

const REPLICATE_POLL_MS = Number(process.env.MMA_REPLICATE_POLL_MS || 2500) || 2500;
const REPLICATE_CALL_TIMEOUT_MS = Number(process.env.MMA_REPLICATE_CALL_TIMEOUT_MS || 15000) || 15000;
const REPLICATE_CANCEL_ON_TIMEOUT =
  String(process.env.MMA_REPLICATE_CANCEL_ON_TIMEOUT || "false").toLowerCase() === "true";

// ============================================================================
// Fabric Audio (lip-sync from image + audio)
// ============================================================================
export async function runFabricAudio({ image, audio, resolution, input: forcedInput }) {
  const replicate = getReplicate();
  const cfg = getMmaConfig();

  const version =
    process.env.MMA_FABRIC_VERSION ||
    cfg?.fabric?.model ||
    "veed/fabric-1.0";

  const envRes = safeStr(process.env.MMA_FABRIC_RESOLUTION, "");
  const cfgRes = safeStr(cfg?.fabric?.resolution, "");
  const desired = safeStr(resolution, "") || cfgRes || envRes || "720p";
  const finalRes = desired === "480p" ? "480p" : "720p";

  const input = forcedInput
    ? { ...forcedInput, image: forcedInput.image || image, audio: forcedInput.audio || audio }
    : { image, audio, resolution: finalRes };

  const REPLICATE_MAX_MS_FABRIC =
    Number(process.env.MMA_REPLICATE_MAX_MS_FABRIC || process.env.MMA_REPLICATE_MAX_MS || 900000) || 900000;

  const t0 = Date.now();

  const pred = await replicatePredictWithTimeout({
    replicate,
    version,
    input,
    timeoutMs: REPLICATE_MAX_MS_FABRIC,
    pollMs: REPLICATE_POLL_MS,
    callTimeoutMs: REPLICATE_CALL_TIMEOUT_MS,
    cancelOnTimeout: REPLICATE_CANCEL_ON_TIMEOUT,
  });

  const prediction = pred.prediction || {};
  const out = prediction.output;

  return {
    input,
    out,
    prediction_id: pred.predictionId,
    prediction_status: prediction.status || null,
    timed_out: !!pred.timedOut,
    timing: {
      started_at: new Date(t0).toISOString(),
      ended_at: nowIso(),
      duration_ms: Date.now() - t0,
    },
    provider: { prediction },
  };
}

// ============================================================================
// Kling Motion Control (omni-video with reference video)
// ============================================================================
export async function runKlingMotionControl({
  prompt,
  image,
  video,
  mode,
  keepOriginalSound,
  characterOrientation,
  duration,
  input: forcedInput,
}) {
  const cfg = getMmaConfig();

  const modelName =
    safeStr(process.env.MMA_KLING_OMNI_MODEL_NAME, "") ||
    safeStr(cfg?.kling_motion_control?.model_name, "") ||
    "kling-v3-omni";

  const firstFrame = asHttpUrl(image);
  const refVideo = asHttpUrl(video);

  if (!firstFrame) throw new Error("MISSING_KLING_MOTION_START_IMAGE");
  if (!refVideo) throw new Error("MISSING_KLING_MOTION_REFERENCE_VIDEO");

  const rawDuration = Number(duration || 5) || 5;
  const finalDuration = Math.max(3, Math.min(10, Math.round(rawDuration)));

  const finalMode = normalizeKlingSourceMode(mode);
  const keep = keepOriginalSound !== undefined ? !!keepOriginalSound : true;

  const safePrompt =
    safeStr(prompt, "") || "Keep the subject consistent and transfer the reference motion naturally.";

  const input = forcedInput
    ? { ...forcedInput }
    : {
        model_name: modelName,
        prompt: safePrompt,
        image_list: [
          {
            image_url: firstFrame,
            type: "first_frame",
          },
        ],
        video_list: [
          {
            video_url: refVideo,
            refer_type: "feature",
            keep_original_sound: keep ? "yes" : "no",
          },
        ],
        sound: "off",
        mode: finalMode,
        duration: String(finalDuration),
      };

  const t0 = Date.now();

  const polled = await submitAndPollKlingTask({
    createPath: "/v1/videos/omni-video",
    queryPathFromTaskId: (taskId) => `/v1/videos/omni-video/${encodeURIComponent(taskId)}`,
    body: input,
    timeoutMs:
      Number(process.env.MMA_REPLICATE_MAX_MS_KLING_MOTION_CONTROL || process.env.MMA_REPLICATE_MAX_MS || 900000) ||
      900000,
    pollMs: REPLICATE_POLL_MS,
  });

  const finalStatus = extractKlingTaskStatus(polled.final);

  return {
    input,
    out: polled.final?.data?.task_result || polled.final?.data || null,
    prediction_id: polled.taskId,
    prediction_status: finalStatus || null,
    timed_out: !!polled.timedOut,
    timing: {
      started_at: new Date(t0).toISOString(),
      ended_at: nowIso(),
      duration_ms: Date.now() - t0,
    },
    provider: {
      kling: {
        createPath: "/v1/videos/omni-video",
        task_id: polled.taskId,
        createResponse: polled.created,
        finalResponse: polled.final,
      },
    },
  };
}

// ============================================================================
// Kling Omni (O3) — text/image/two-frame/audio-ref via omni-video endpoint
// ============================================================================
export async function runKlingOmni({
  prompt,
  startImage,
  endImage,
  duration,
  mode,
  negativePrompt,
  generateAudio,
  input: forcedInput,
}) {
  const cfg = getMmaConfig();
  const modelName =
    safeStr(process.env.MMA_KLING_OMNI_MODEL_NAME, "") ||
    safeStr(cfg?.kling_motion_control?.model_name, "") ||
    "kling-v3-omni";

  const hasStart = !!asHttpUrl(startImage);
  const hasEnd = !!asHttpUrl(endImage);

  const rawDuration = Number(duration || 5) || 5;
  const finalDuration = Math.max(3, Math.min(15, Math.round(rawDuration)));
  const finalMode = normalizeKlingSourceMode(
    safeStr(mode, "") || safeStr(cfg?.kling?.mode, "") || safeStr(process.env.MMA_KLING_MODE, "") || "pro"
  );

  const finalNeg =
    negativePrompt !== undefined
      ? safeStr(negativePrompt, KLING_DEFAULT_NEGATIVE_PROMPT)
      : safeStr(process.env.NEGATIVE_PROMPT_KLING || process.env.MMA_NEGATIVE_PROMPT_KLING || cfg?.kling?.negativePrompt, "")
        || KLING_DEFAULT_NEGATIVE_PROMPT;

  const finalPrompt = safeStr(prompt, "");
  if (!finalPrompt) throw new Error("MISSING_KLING_OMNI_PROMPT");

  const sound = generateAudio ? "on" : "off";

  const image_list = [];
  if (hasStart) image_list.push({ image_url: asHttpUrl(startImage), type: "first_frame" });
  if (hasEnd) image_list.push({ image_url: asHttpUrl(endImage), type: "last_frame" });

  const input = forcedInput ? { ...forcedInput } : {
    model_name: modelName,
    prompt: finalPrompt,
    ...(image_list.length > 0 ? { image_list } : {}),
    sound,
    mode: finalMode,
    duration: String(finalDuration),
    ...(finalNeg ? { negative_prompt: finalNeg } : {}),
  };

  const t0 = Date.now();

  const polled = await submitAndPollKlingTask({
    createPath: "/v1/videos/omni-video",
    queryPathFromTaskId: (taskId) => `/v1/videos/omni-video/${encodeURIComponent(taskId)}`,
    body: input,
    timeoutMs: Number(process.env.MMA_REPLICATE_MAX_MS_KLING || process.env.MMA_REPLICATE_MAX_MS || 900000) || 900000,
    pollMs: REPLICATE_POLL_MS,
  });

  const finalStatus = extractKlingTaskStatus(polled.final);

  return {
    input,
    out: polled.final?.data?.task_result || polled.final?.data || null,
    prediction_id: polled.taskId,
    prediction_status: finalStatus || null,
    timed_out: !!polled.timedOut,
    timing: {
      started_at: new Date(t0).toISOString(),
      ended_at: nowIso(),
      duration_ms: Date.now() - t0,
    },
    provider: {
      kling: {
        createPath: "/v1/videos/omni-video",
        task_id: polled.taskId,
        createResponse: polled.created,
        finalResponse: polled.final,
      },
    },
  };
}
