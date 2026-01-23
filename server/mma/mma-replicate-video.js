import { asHttpUrl, safeStr } from "./mma-shared.js";
import { getMmaConfig } from "./mma-config.js";
import { replicatePredictWithTimeout } from "./replicate-poll.js";
import { nowIso } from "./mma-utils.js";
import {
  REPLICATE_CALL_TIMEOUT_MS,
  REPLICATE_CANCEL_ON_TIMEOUT,
  REPLICATE_POLL_MS,
  getReplicate,
} from "./mma-replicate-core.js";

export function pickKlingStartImage(vars, parent) {
  const assets = vars?.assets || {};
  const inputs = vars?.inputs || {};

  return (
    asHttpUrl(inputs.start_image_url || inputs.startImageUrl) ||
    asHttpUrl(inputs.parent_output_url || inputs.parentOutputUrl) ||
    asHttpUrl(parent?.mg_output_url) ||
    asHttpUrl(assets.start_image_url || assets.startImageUrl) ||
    asHttpUrl(assets.image || assets.image_url || assets.imageUrl) ||
    asHttpUrl(assets.product_image_url || assets.productImageUrl) ||
    ""
  );
}

export function pickKlingEndImage(vars, parent) {
  const assets = vars?.assets || {};
  const inputs = vars?.inputs || {};

  return (
    asHttpUrl(inputs.end_image_url || inputs.endImageUrl) ||
    asHttpUrl(assets.end_image_url || assets.endImageUrl) ||
    ""
  );
}

export async function runKling({
  prompt,
  startImage,
  endImage,
  duration,
  mode,
  negativePrompt,
  generateAudio,
  aspectRatio,
  input: forcedInput,
}) {
  const replicate = getReplicate();
  const cfg = getMmaConfig();

  let version =
    process.env.MMA_KLING_VERSION ||
    process.env.MMA_KLING_MODEL_VERSION ||
    cfg?.kling?.model ||
    "kwaivgi/kling-v2.1";

  const hasEndFrame = !!asHttpUrl(endImage);
  if (hasEndFrame) {
    version = process.env.MMA_KLING_V21_MODEL || "kwaivgi/kling-v2.1";
  }

  const is26 = /kling[-_/]?v2\\.6/i.test(String(version));

  const rawDuration = Number(duration ?? cfg?.kling?.duration ?? process.env.MMA_KLING_DURATION ?? 5) || 5;
  const duration26 = rawDuration >= 10 ? 10 : 5;

  const envNeg =
    process.env.NEGATIVE_PROMPT_KLING ||
    process.env.MMA_NEGATIVE_PROMPT_KLING ||
    cfg?.kling?.negativePrompt ||
    "";

  const finalNeg = negativePrompt !== undefined ? negativePrompt : envNeg;

  const REPLICATE_MAX_MS_KLING =
    Number(process.env.MMA_REPLICATE_MAX_MS_KLING || process.env.MMA_REPLICATE_MAX_MS || 900000) || 900000;

  let input;
  if (forcedInput) {
    input = { ...forcedInput };
  } else if (is26) {
    const hasStart = !!asHttpUrl(startImage);
    const ar =
      safeStr(aspectRatio, "") ||
      safeStr(cfg?.kling?.aspectRatio, "") ||
      safeStr(process.env.MMA_KLING_ASPECT_RATIO, "") ||
      "16:9";

    input = {
      prompt,
      duration: duration26,
      ...(hasStart ? { start_image: startImage } : { aspect_ratio: ar }),
      generate_audio: generateAudio !== undefined ? !!generateAudio : true,
      negative_prompt: safeStr(finalNeg, ""),
    };
  } else {
    const defaultDuration = rawDuration;
    const hasEnd = !!asHttpUrl(endImage);
    const finalMode =
      safeStr(mode, "") ||
      (hasEnd ? "pro" : "") ||
      cfg?.kling?.mode ||
      process.env.MMA_KLING_MODE ||
      "standard";

    input = {
      mode: finalMode,
      prompt,
      duration: defaultDuration,
      start_image: startImage,
      ...(hasEnd ? { end_image: asHttpUrl(endImage) } : {}),
      ...(finalNeg ? { negative_prompt: finalNeg } : {}),
    };

    if (generateAudio !== undefined) input.generate_audio = !!generateAudio;
  }

  if (!input.prompt) input.prompt = prompt;

  const t0 = Date.now();

  let pred;
  try {
    pred = await replicatePredictWithTimeout({
      replicate,
      version,
      input,
      timeoutMs: REPLICATE_MAX_MS_KLING,
      pollMs: REPLICATE_POLL_MS,
      callTimeoutMs: REPLICATE_CALL_TIMEOUT_MS,
      cancelOnTimeout: REPLICATE_CANCEL_ON_TIMEOUT,
    });
  } catch (err) {
    const msg = String(err?.message || err || "").toLowerCase();
    const looksLikeBadField =
      !is26 && msg.includes("input") && (msg.includes("generate_audio") || msg.includes("unexpected"));

    if (looksLikeBadField) {
      const retryInput = { ...input };
      delete retryInput.generate_audio;

      pred = await replicatePredictWithTimeout({
        replicate,
        version,
        input: retryInput,
        timeoutMs: REPLICATE_MAX_MS_KLING,
        pollMs: REPLICATE_POLL_MS,
        callTimeoutMs: REPLICATE_CALL_TIMEOUT_MS,
        cancelOnTimeout: REPLICATE_CANCEL_ON_TIMEOUT,
      });

      input = retryInput;
    } else {
      throw err;
    }
  }

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

function normalizeKmcMode(v) {
  const s = safeStr(v, "").toLowerCase();
  if (s === "pro") return "pro";
  if (s === "std" || s === "standard") return "std";
  return "std";
}

function normalizeKmcOrientation(v) {
  const s = safeStr(v, "").toLowerCase();
  return s === "video" ? "video" : "image";
}

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

export async function runKlingMotionControl({
  prompt,
  image,
  video,
  mode,
  keepOriginalSound,
  characterOrientation,
  input: forcedInput,
}) {
  const replicate = getReplicate();
  const cfg = getMmaConfig();

  const version =
    process.env.MMA_KLING_MOTION_CONTROL_VERSION ||
    cfg?.kling_motion_control?.model ||
    "kwaivgi/kling-v2.6-motion-control";

  const finalMode = normalizeKmcMode(mode);
  const finalOrientation = normalizeKmcOrientation(characterOrientation);

  const keep =
    keepOriginalSound !== undefined
      ? !!keepOriginalSound
      : (cfg?.kling_motion_control?.keepOriginalSound !== undefined ? !!cfg.kling_motion_control.keepOriginalSound : true);

  const input = forcedInput
    ? { ...forcedInput }
    : {
        prompt: safeStr(prompt, ""),
        image,
        video,
        mode: finalMode,
        keep_original_sound: keep,
        character_orientation: finalOrientation,
      };

  if (!input.image) input.image = image;
  if (!input.video) input.video = video;
  if (input.prompt === undefined) input.prompt = safeStr(prompt, "");
  if (!input.mode) input.mode = finalMode;
  if (input.keep_original_sound === undefined) input.keep_original_sound = keep;
  if (!input.character_orientation) input.character_orientation = finalOrientation;

  const REPLICATE_MAX_MS_KMC =
    Number(process.env.MMA_REPLICATE_MAX_MS_KLING_MOTION_CONTROL || process.env.MMA_REPLICATE_MAX_MS || 900000) || 900000;

  const t0 = Date.now();

  const pred = await replicatePredictWithTimeout({
    replicate,
    version,
    input,
    timeoutMs: REPLICATE_MAX_MS_KMC,
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
