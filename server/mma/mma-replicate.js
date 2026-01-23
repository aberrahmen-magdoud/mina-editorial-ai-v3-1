import Replicate from "replicate";

import { asHttpUrl, safeArray, safeStr } from "./mma-shared.js";
import { getMmaConfig } from "./mma-config.js";
import { replicatePredictWithTimeout } from "./replicate-poll.js";
import { nowIso } from "./mma-utils.js";

let _replicate = null;
export function getReplicate() {
  if (_replicate) return _replicate;
  if (!process.env.REPLICATE_API_TOKEN) throw new Error("REPLICATE_API_TOKEN_MISSING");
  _replicate = new Replicate({ auth: process.env.REPLICATE_API_TOKEN });
  return _replicate;
}

export function pickFirstUrl(output) {
  const seen = new Set();

  const isUrl = (s) => typeof s === "string" && /^https?:\/\//i.test(s.trim());

  const walk = (v) => {
    if (!v) return "";

    if (typeof v === "string") return isUrl(v) ? v.trim() : "";

    if (v && typeof v === "object" && typeof v.url === "function") {
      try {
        const u = v.url();
        if (isUrl(u)) return u.trim();
      } catch {}
    }

    if (Array.isArray(v)) {
      for (const item of v) {
        const u = walk(item);
        if (u) return u;
      }
      return "";
    }

    if (typeof v === "object") {
      if (seen.has(v)) return "";
      seen.add(v);

      const keys = [
        "url",
        "output",
        "outputs",
        "image",
        "images",
        "video",
        "video_url",
        "videoUrl",
        "mp4",
        "file",
        "files",
        "result",
        "results",
        "data",
      ];

      for (const k of keys) {
        if (Object.prototype.hasOwnProperty.call(v, k)) {
          const u = walk(v[k]);
          if (u) return u;
        }
      }

      for (const val of Object.values(v)) {
        const u = walk(val);
        if (u) return u;
      }
    }

    return "";
  };

  return walk(output);
}

export function buildSeedreamImageInputs(vars) {
  const assets = vars?.assets || {};
  const product = asHttpUrl(assets.product_image_url || assets.productImageUrl);
  const logo = asHttpUrl(assets.logo_image_url || assets.logoImageUrl);

  const styleHero = asHttpUrl(
    assets.style_hero_image_url ||
      assets.styleHeroImageUrl ||
      assets.style_hero_url ||
      assets.styleHeroUrl
  );

  const inspiration = safeArray(
    assets.inspiration_image_urls ||
      assets.inspirationImageUrls ||
      assets.style_image_urls ||
      assets.styleImageUrls
  )
    .map(asHttpUrl)
    .filter(Boolean)
    .slice(0, 4);

  return []
    .concat(product ? [product] : [])
    .concat(logo ? [logo] : [])
    .concat(inspiration)
    .concat(styleHero ? [styleHero] : [])
    .filter(Boolean)
    .slice(0, 10);
}

export function nanoBananaEnabled() {
  return !!safeStr(process.env.MMA_NANOBANANA_VERSION, "");
}

export function buildNanoBananaImageInputs(vars) {
  const assets = vars?.assets || {};
  const product = asHttpUrl(assets.product_image_url || assets.productImageUrl);
  const logo = asHttpUrl(assets.logo_image_url || assets.logoImageUrl);

  const styleHero = asHttpUrl(
    assets.style_hero_image_url ||
      assets.styleHeroImageUrl ||
      assets.style_hero_url ||
      assets.styleHeroUrl
  );

  const inspiration = safeArray(
    assets.inspiration_image_urls ||
      assets.inspirationImageUrls ||
      assets.style_image_urls ||
      assets.styleImageUrls
  )
    .map(asHttpUrl)
    .filter(Boolean)
    .slice(0, 10);

  return []
    .concat(product ? [product] : [])
    .concat(logo ? [logo] : [])
    .concat(inspiration)
    .concat(styleHero ? [styleHero] : [])
    .filter(Boolean)
    .slice(0, 14);
}

// ---- HARD TIMEOUT settings (4 minutes default) ----
const REPLICATE_MAX_MS = Number(process.env.MMA_REPLICATE_MAX_MS || 900000) || 900000;

const REPLICATE_MAX_MS_NANOBANANA =
  Number(process.env.MMA_REPLICATE_MAX_MS_NANOBANANA || 900000) || 900000;

const REPLICATE_POLL_MS = Number(process.env.MMA_REPLICATE_POLL_MS || 2500) || 2500;
const REPLICATE_CALL_TIMEOUT_MS = Number(process.env.MMA_REPLICATE_CALL_TIMEOUT_MS || 15000) || 15000;
const REPLICATE_CANCEL_ON_TIMEOUT =
  String(process.env.MMA_REPLICATE_CANCEL_ON_TIMEOUT || "false").toLowerCase() === "true";

export async function runNanoBanana({
  prompt,
  aspectRatio,
  imageInputs = [],
  resolution,
  outputFormat,
  safetyFilterLevel,
  input: forcedInput,
}) {
  const replicate = getReplicate();
  const cfg = getMmaConfig();

  const version =
    safeStr(process.env.MMA_NANOBANANA_VERSION, "") ||
    safeStr(cfg?.nanobanana?.model, "") ||
    "google/nano-banana-pro";

  const defaultAspect =
    safeStr(cfg?.nanobanana?.aspectRatio, "") ||
    safeStr(process.env.MMA_NANOBANANA_ASPECT_RATIO, "") ||
    "match_input_image";

  const defaultResolution =
    safeStr(
      String(resolution ?? cfg?.nanobanana?.resolution ?? process.env.MMA_NANOBANANA_RESOLUTION ?? "2K"),
      "2K"
    ) || "2K";

  const defaultFmt =
    safeStr(
      String(outputFormat ?? cfg?.nanobanana?.outputFormat ?? process.env.MMA_NANOBANANA_OUTPUT_FORMAT ?? "jpg"),
      "jpg"
    ) || "jpg";

  const defaultSafety =
    safeStr(
      String(
        safetyFilterLevel ??
          cfg?.nanobanana?.safetyFilterLevel ??
          process.env.MMA_NANOBANANA_SAFETY_FILTER_LEVEL ??
          "block_only_high"
      ),
      "block_only_high"
    ) || "block_only_high";

  const cleanedInputs = safeArray(imageInputs).map(asHttpUrl).filter(Boolean).slice(0, 14);

  const input = forcedInput
    ? { ...forcedInput, prompt: forcedInput.prompt || prompt }
    : {
        prompt,
        resolution: defaultResolution,
        aspect_ratio: aspectRatio || defaultAspect,
        output_format: defaultFmt,
        safety_filter_level: defaultSafety,
        ...(cleanedInputs.length ? { image_input: cleanedInputs } : {}),
      };

  if (!input.prompt) input.prompt = prompt;
  if (!input.resolution) input.resolution = defaultResolution;
  if (!input.aspect_ratio) input.aspect_ratio = aspectRatio || defaultAspect;
  if (!input.output_format) input.output_format = defaultFmt;
  if (!input.safety_filter_level) input.safety_filter_level = defaultSafety;
  if (!input.image_input && cleanedInputs.length) input.image_input = cleanedInputs;

  const t0 = Date.now();

  const pred = await replicatePredictWithTimeout({
    replicate,
    version,
    input,
    timeoutMs: REPLICATE_MAX_MS_NANOBANANA,
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

export async function runSeedream({ prompt, aspectRatio, imageInputs = [], size, enhancePrompt, input: forcedInput }) {
  const replicate = getReplicate();
  const cfg = getMmaConfig();

  const sizeValue = size || cfg?.seadream?.size || process.env.MMA_SEADREAM_SIZE || "2K";
  const defaultAspect =
    cfg?.seadream?.aspectRatio || process.env.MMA_SEADREAM_ASPECT_RATIO || "match_input_image";

  const version =
    process.env.MMA_SEADREAM_VERSION ||
    process.env.MMA_SEADREAM_MODEL_VERSION ||
    cfg?.seadream?.model ||
    "bytedance/seedream-4";

  const neg =
    process.env.NEGATIVE_PROMPT_SEADREAM ||
    process.env.MMA_NEGATIVE_PROMPT_SEADREAM ||
    cfg?.seadream?.negativePrompt ||
    "";

  const finalPrompt = neg ? `${prompt}\n\nAvoid: ${neg}` : prompt;

  const cleanedInputs = safeArray(imageInputs).map(asHttpUrl).filter(Boolean).slice(0, 10);

  const enhance_prompt =
    enhancePrompt !== undefined
      ? enhancePrompt
      : cfg?.seadream?.enhancePrompt !== undefined
        ? !!cfg.seadream.enhancePrompt
        : true;

  const input = forcedInput
    ? { ...forcedInput, prompt: forcedInput.prompt || finalPrompt }
    : {
        prompt: finalPrompt,
        size: sizeValue,
        aspect_ratio: aspectRatio || defaultAspect,
        enhance_prompt,
        sequential_image_generation: "disabled",
        max_images: 1,
        ...(cleanedInputs.length ? { image_input: cleanedInputs } : {}),
      };

  if (!input.aspect_ratio) input.aspect_ratio = aspectRatio || defaultAspect;
  if (!input.size) input.size = sizeValue;
  if (input.enhance_prompt === undefined) input.enhance_prompt = enhance_prompt;
  if (!input.sequential_image_generation) input.sequential_image_generation = "disabled";
  if (!input.max_images) input.max_images = 1;
  if (!input.image_input && cleanedInputs.length) input.image_input = cleanedInputs;

  const t0 = Date.now();

  const pred = await replicatePredictWithTimeout({
    replicate,
    version,
    input,
    timeoutMs: REPLICATE_MAX_MS,
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

  const is26 = /kling[-_/]?v2\.6/i.test(String(version));

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
