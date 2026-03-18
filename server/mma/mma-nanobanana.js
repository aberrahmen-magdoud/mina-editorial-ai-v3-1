// server/mma/mma-nanobanana.js — NanoBanana still-image runner (Replicate + Gemini)
"use strict";

import sharp from "sharp";
import { getReplicate } from "./mma-clients.js";
import { getMmaConfig } from "./mma-config.js";
import { safeStr, asHttpUrl, safeArray, parseOptionalBool } from "./mma-helpers.js";
import { nowIso } from "./mma-utils.js";
import { replicatePredictWithTimeout } from "./replicate-poll.js";

// ---- HARD TIMEOUT settings ----
const REPLICATE_MAX_MS_NANOBANANA =
  Number(process.env.MMA_REPLICATE_MAX_MS_NANOBANANA || 900000) || 900000;
const REPLICATE_POLL_MS = Number(process.env.MMA_REPLICATE_POLL_MS || 2500) || 2500;
const REPLICATE_CALL_TIMEOUT_MS = Number(process.env.MMA_REPLICATE_CALL_TIMEOUT_MS || 15000) || 15000;
const REPLICATE_CANCEL_ON_TIMEOUT =
  String(process.env.MMA_REPLICATE_CANCEL_ON_TIMEOUT || "false").toLowerCase() === "true";

// ============================================================================
// Environment helpers
// ============================================================================
export function nanoBananaUseGemini() {
  return String(process.env.MMA_NANOBANANA_USE_GEMINI || "").trim() === "1";
}

export function nanoBananaEnabled() {
  if (nanoBananaUseGemini()) return !!process.env.GEMINI_API_KEY;
  return !!process.env.MMA_NANOBANANA_VERSION;
}

export function mainGeminiModel() {
  return safeStr(process.env.MMA_MAIN_GEMINI_MODEL, "");
}

export function mainUsesGemini() {
  return !!mainGeminiModel() && !!process.env.GEMINI_API_KEY;
}

// ============================================================================
// Image input builder
// ============================================================================
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

// ============================================================================
// Replicate runner
// ============================================================================
export async function runNanoBananaReplicate({
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
    safeStr(process.env.MMA_SEADREAM_VERSION, "") ||
    safeStr(cfg?.nanobanana?.model, "") ||
    "google/nano-banana-pro";

  const defaultAspect =
    safeStr(cfg?.nanobanana?.aspectRatio, "") ||
    safeStr(process.env.MMA_NANOBANANA_ASPECT_RATIO, "") ||
    "match_input_image";

  const defaultResolution =
    safeStr(
      String(resolution ?? cfg?.nanobanana?.resolution ?? process.env.MMA_NANOBANANA_RESOLUTION ?? "4K"),
      "4K"
    ) || "4K";

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

// ============================================================================
// R2 helpers for Gemini (inline upload)
// ============================================================================
function _guessMimeFromUrl(url) {
  const u = String(url || "").toLowerCase();
  if (u.includes(".jpg") || u.includes(".jpeg")) return "image/jpeg";
  if (u.includes(".webp")) return "image/webp";
  return "image/png";
}

function _normalizeAspectRatio(ar) {
  if (!ar) return undefined;
  const s = String(ar).trim();
  if (/^\d+\s*:\s*\d+$/.test(s)) return s.replace(/\s+/g, "");
  if (s === "square") return "1:1";
  if (s === "portrait") return "4:5";
  if (s === "landscape") return "16:9";
  return undefined;
}

let _r2GeminiClientPromise = null;
async function _getR2GeminiClient() {
  if (_r2GeminiClientPromise) return _r2GeminiClientPromise;

  _r2GeminiClientPromise = (async () => {
    const { S3Client } = await import("@aws-sdk/client-s3");

    const endpoint =
      process.env.R2_ENDPOINT ||
      (process.env.R2_ACCOUNT_ID
        ? `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`
        : null);

    const accessKeyId = process.env.R2_ACCESS_KEY_ID || process.env.AWS_ACCESS_KEY_ID;
    const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY || process.env.AWS_SECRET_ACCESS_KEY;

    if (!endpoint) throw new Error("R2_ENDPOINT (or R2_ACCOUNT_ID) is missing");
    if (!accessKeyId || !secretAccessKey) throw new Error("R2 access keys are missing");

    return new S3Client({
      region: "auto",
      endpoint,
      credentials: { accessKeyId, secretAccessKey },
    });
  })();

  return _r2GeminiClientPromise;
}

async function _putBytesToR2Public({ bytes, contentType, keyPrefix }) {
  const { PutObjectCommand } = await import("@aws-sdk/client-s3");

  const bucket =
    process.env.R2_BUCKET ||
    process.env.R2_BUCKET_NAME ||
    process.env.R2_PUBLIC_BUCKET;

  const base = process.env.R2_PUBLIC_BASE_URL;

  if (!bucket) throw new Error("R2_BUCKET (or R2_BUCKET_NAME) is missing");
  if (!base) throw new Error("R2_PUBLIC_BASE_URL is missing");

  const client = await _getR2GeminiClient();

  const ext =
    contentType === "image/jpeg" ? "jpg" :
    contentType === "image/webp" ? "webp" :
    "png";

  const key = `${String(keyPrefix || "mma/generated").replace(/\/$/,"")}/${Date.now()}_${Math.random()
    .toString(16)
    .slice(2)}.${ext}`;

  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: bytes,
      ContentType: contentType || "application/octet-stream",
    })
  );

  return `${base.replace(/\/$/,"")}/${key}`;
}

// ============================================================================
// Gemini runner
// ============================================================================
export async function runNanoBananaGemini(opts = {}) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is missing (set it in env)");

  const model =
    safeStr(opts?.model, "") ||
    process.env.MMA_NANOBANANA_GEMINI_MODEL ||
    "gemini-3-pro-image-preview";

  const t0 = Date.now();

  const prompt = opts?.prompt || opts?.text || opts?.textPrompt || "";
  const aspectRatio = _normalizeAspectRatio(
    opts?.aspectRatio || opts?.aspect || opts?.stillAspect
  );

  const imageInputs = Array.isArray(opts?.imageInputs)
    ? opts.imageInputs
    : Array.isArray(opts?.inputs)
      ? opts.inputs
      : [];

  const maxImgs =
    Number(opts?.maxImages ?? process.env.MMA_NANOBANANA_GEMINI_MAX_IMAGES ?? 14) || 14;

  const parts = [];

  for (const url of imageInputs.slice(0, maxImgs)) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to fetch image input: ${res.status}`);
    const mime = (res.headers.get("content-type") || _guessMimeFromUrl(url)).split(";")[0];
    const buf = Buffer.from(await res.arrayBuffer());
    parts.push({
      inline_data: {
        mime_type: mime,
        data: buf.toString("base64"),
      },
    });
  }

  parts.push({ text: prompt });

  const imageSize =
    safeStr(opts?.imageSize || opts?.resolution || opts?.size, "") ||
    safeStr(process.env.MMA_NANOBANANA_GEMINI_IMAGE_SIZE, "");

  const thinkingLevelRaw = safeStr(opts?.thinkingLevel, "").toLowerCase();
  const thinkingLevel =
    thinkingLevelRaw === "high" ? "High" :
    thinkingLevelRaw === "minimal" ? "Minimal" :
    thinkingLevelRaw === "low" ? "Low" :
    thinkingLevelRaw === "medium" ? "Medium" :
    "";

  const includeThoughts = parseOptionalBool(opts?.includeThoughts);

  const responseModalities =
    Array.isArray(opts?.responseModalities) && opts.responseModalities.length
      ? opts.responseModalities
      : ["IMAGE"];

  const body = {
    contents: [{ parts }],
    generationConfig: {
      responseModalities,
      imageConfig: {},
    },
  };

  if (aspectRatio) body.generationConfig.imageConfig.aspectRatio = aspectRatio;
  if (imageSize) body.generationConfig.imageConfig.imageSize = imageSize;

  if (thinkingLevel || includeThoughts !== undefined) {
    body.generationConfig.thinkingConfig = {};
    if (thinkingLevel) body.generationConfig.thinkingConfig.thinkingLevel = thinkingLevel;
    if (includeThoughts !== undefined) {
      body.generationConfig.thinkingConfig.includeThoughts = includeThoughts;
    }
  }

  const useGoogleSearch = parseOptionalBool(opts?.useGoogleSearch);
  const useImageSearch = parseOptionalBool(opts?.useImageSearch);

  if (useGoogleSearch || useImageSearch) {
    body.tools = [
      {
        google_search: useImageSearch
          ? { searchTypes: { webSearch: {}, imageSearch: {} } }
          : {},
      },
    ];
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

  const ctrl = new AbortController();
  const timeoutMs =
    Number(process.env.MMA_NANOBANANA_GEMINI_TIMEOUT_MS || 1200000) || 1200000;
  const to = setTimeout(() => ctrl.abort(), timeoutMs);

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "x-goog-api-key": apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: ctrl.signal,
  }).finally(() => clearTimeout(to));

  const json = await resp.json().catch(() => ({}));

  if (!resp.ok) {
    const e = new Error(`GEMINI_HTTP_${resp.status}: ${JSON.stringify(json).slice(0, 1200)}`);
    e.code = `GEMINI_HTTP_${resp.status}`;
    e.provider = { gemini: json };
    throw e;
  }

  const cand0 = json?.candidates?.[0] || {};
  const finishReason = safeStr(cand0?.finishReason || cand0?.finish_reason, "");
  const finishMessage = safeStr(cand0?.finishMessage || cand0?.finish_message, "");

  if (finishReason && String(finishReason).toUpperCase().includes("IMAGE_SAFETY")) {
    const e = new Error(
      `IMAGE_SAFETY: ${finishMessage || "Blocked by safety filters. Try rephrasing."}`
    );
    e.code = "IMAGE_SAFETY";
    e.provider = { gemini: { finishReason, finishMessage } };
    throw e;
  }

  const outParts = cand0?.content?.parts || [];
  const imgPart = outParts.find((p) => (p?.inlineData?.data || p?.inline_data?.data));

  if (!imgPart) {
    const e = new Error(`GEMINI_NO_IMAGE_PART: ${JSON.stringify(json).slice(0, 1200)}`);
    e.code = "GEMINI_NO_IMAGE_PART";
    e.provider = { gemini: json };
    throw e;
  }

  const blob = imgPart.inlineData || imgPart.inline_data;
  let mime = blob.mimeType || blob.mime_type || "image/png";
  let bytes = Buffer.from(blob.data, "base64");

  if (opts?.compressToJpeg) {
    bytes = await sharp(bytes).jpeg({ quality: 82 }).toBuffer();
    mime = "image/jpeg";
  }

  const publicUrl = await _putBytesToR2Public({
    bytes,
    contentType: mime,
    keyPrefix: "mma/still",
  });

  const outputFormat =
    mime === "image/jpeg" ? "jpg" :
    mime === "image/webp" ? "webp" :
    "png";

  return {
    input: {
      prompt,
      resolution: safeStr(opts?.resolution, "") || safeStr(opts?.size, "") || imageSize || "4K",
      aspect_ratio: aspectRatio || undefined,
      output_format: outputFormat,
      image_input: imageInputs.slice(0, maxImgs).map(asHttpUrl).filter(Boolean),
      provider: "gemini",
      model,
      response_modalities: responseModalities,
      thinking_level: thinkingLevel || undefined,
      include_thoughts: includeThoughts,
      google_search: !!useGoogleSearch,
      image_search: !!useImageSearch,
    },
    out: publicUrl,
    prediction_id: null,
    prediction_status: "succeeded",
    timed_out: false,
    timing: {
      started_at: new Date(t0).toISOString(),
      ended_at: nowIso(),
      duration_ms: Date.now() - t0,
    },
    provider: {
      gemini: { model },
    },
  };
}

// ============================================================================
// Wrapper: keeps existing calls unchanged
// ============================================================================
export async function runNanoBanana(opts) {
  if (nanoBananaUseGemini()) return runNanoBananaGemini(opts);
  return runNanoBananaReplicate(opts);
}
