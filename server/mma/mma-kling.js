// server/mma/mma-kling.js — Kling v3 HTTP video runner (JWT auth, poll, image helpers)
"use strict";

import crypto from "node:crypto";
import { getMmaConfig } from "./mma-config.js";
import { safeStr, asHttpUrl, withKlingImageSizing } from "./mma-helpers.js";
import { nowIso } from "./mma-utils.js";

// ---- Timeout constants (shared with Kling-Omni) ----
const REPLICATE_POLL_MS = Number(process.env.MMA_REPLICATE_POLL_MS || 2500) || 2500;
const REPLICATE_CALL_TIMEOUT_MS = Number(process.env.MMA_REPLICATE_CALL_TIMEOUT_MS || 15000) || 15000;

const KLING_DEFAULT_NEGATIVE_PROMPT =
  "morphing, distorted hands, extra fingers, flickering textures, blurry text, cartoonish, low resolution";

// ============================================================================
// Kling HTTP config + JWT
// ============================================================================
export function getKlingHttpConfig() {
  const baseUrl = safeStr(
    process.env.KLING_BASE_URL,
    "https://api-singapore.klingai.com"
  ).replace(/\/+$/, "");

  const accessKey = safeStr(process.env.KLING_ACCESS_KEY, "");
  const secretKey = safeStr(process.env.KLING_SECRET_KEY, "");

  if (!accessKey || !secretKey) {
    throw new Error("KLING_KEYS_MISSING");
  }

  return { baseUrl, accessKey, secretKey };
}

function base64UrlEncode(input) {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

export function buildKlingJwt(accessKey, secretKey) {
  const now = Math.floor(Date.now() / 1000);

  const header = { alg: "HS256", typ: "JWT" };
  const payload = { iss: accessKey, exp: now + 1800, nbf: now - 5 };

  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));

  const signature = crypto
    .createHmac("sha256", secretKey)
    .update(`${encodedHeader}.${encodedPayload}`)
    .digest("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");

  return `${encodedHeader}.${encodedPayload}.${signature}`;
}

// ============================================================================
// Kling task helpers
// ============================================================================
export function normalizeKlingSourceMode(v) {
  const s = safeStr(v, "").toLowerCase();
  if (["pro", "professional", "1080p"].includes(s)) return "pro";
  if (["std", "standard", "720p"].includes(s)) return "std";
  return "pro";
}

export function extractKlingTaskId(payload) {
  return safeStr(payload?.data?.task_id, "");
}

export function extractKlingTaskStatus(payload) {
  return safeStr(payload?.data?.task_status, "");
}

export function extractKlingTaskStatusMsg(payload) {
  return safeStr(payload?.data?.task_status_msg, "") || safeStr(payload?.message, "");
}

export function klingResultHasVideo(payload) {
  const tr = payload?.data?.task_result;
  if (!tr || typeof tr !== "object") return false;
  const videos = tr.videos;
  if (Array.isArray(videos) && videos.length > 0) {
    return videos.some((v) => typeof v?.url === "string" && v.url.startsWith("http"));
  }
  for (const val of Object.values(tr)) {
    if (typeof val === "string" && /^https?:\/\//i.test(val)) return true;
    if (Array.isArray(val)) {
      for (const item of val) {
        if (typeof item?.url === "string" && item.url.startsWith("http")) return true;
      }
    }
  }
  return false;
}

export function extractKlingVideoUrl(payload) {
  return safeStr(payload?.data?.task_result?.videos?.[0]?.url, "");
}

export function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ============================================================================
// Kling HTTP request + poll
// ============================================================================
export async function klingRequestJson(path, { method = "GET", body, timeoutMs } = {}) {
  const { baseUrl, accessKey, secretKey } = getKlingHttpConfig();

  const ctrl = new AbortController();
  const timer = setTimeout(
    () => ctrl.abort(),
    Math.max(1000, Number(timeoutMs || REPLICATE_CALL_TIMEOUT_MS) || 15000)
  );

  try {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${buildKlingJwt(accessKey, secretKey)}`,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctrl.signal,
    });

    const rawText = await res.text();
    let json = null;

    try {
      json = rawText ? JSON.parse(rawText) : null;
    } catch {
      json = null;
    }

    if (!res.ok) {
      const err = new Error(`KLING_HTTP_${res.status}: ${rawText || "Request failed"}`);
      err.code = `KLING_HTTP_${res.status}`;
      err.provider = {
        kling: { method, path, status: res.status, body: json || rawText || null },
      };
      throw err;
    }

    if (
      json &&
      typeof json === "object" &&
      Object.prototype.hasOwnProperty.call(json, "code") &&
      Number(json.code) !== 0
    ) {
      const err = new Error(`KLING_API_ERROR: ${safeStr(json.message, "Unknown Kling API error")}`);
      err.code = "KLING_API_ERROR";
      err.provider = { kling: { method, path, status: res.status, body: json } };
      throw err;
    }

    return json;
  } catch (err) {
    if (err?.name === "AbortError") {
      const e = new Error(`KLING_TIMEOUT: ${method} ${path}`);
      e.code = "KLING_TIMEOUT";
      throw e;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export async function submitAndPollKlingTask({
  createPath,
  queryPathFromTaskId,
  body,
  timeoutMs,
  pollMs,
}) {
  const created = await klingRequestJson(createPath, {
    method: "POST",
    body,
    timeoutMs: REPLICATE_CALL_TIMEOUT_MS,
  });

  const taskId = extractKlingTaskId(created);
  if (!taskId) {
    const err = new Error("KLING_TASK_ID_MISSING");
    err.code = "KLING_TASK_ID_MISSING";
    err.provider = { kling: { createPath, createResponse: created } };
    throw err;
  }

  let final = created;
  const startedAt = Date.now();
  const maxMs = Math.max(5000, Number(timeoutMs || 900000) || 900000);
  const waitMs = Math.max(1000, Number(pollMs || 2500) || 2500);

  const SUCCEED_EMPTY_RETRIES = 4;
  const SUCCEED_EMPTY_WAIT_MS = 3000;

  while (true) {
    const status = extractKlingTaskStatus(final);

    if (status === "succeed") {
      if (klingResultHasVideo(final)) {
        return { created, final, taskId, timedOut: false };
      }

      let retryFinal = final;
      for (let i = 0; i < SUCCEED_EMPTY_RETRIES; i++) {
        await sleepMs(SUCCEED_EMPTY_WAIT_MS);
        retryFinal = await klingRequestJson(queryPathFromTaskId(taskId), {
          method: "GET",
          timeoutMs: REPLICATE_CALL_TIMEOUT_MS,
        });
        if (klingResultHasVideo(retryFinal)) {
          return { created, final: retryFinal, taskId, timedOut: false };
        }
      }

      return { created, final: retryFinal, taskId, timedOut: false };
    }

    if (status === "failed") {
      const err = new Error(`KLING_TASK_FAILED: ${extractKlingTaskStatusMsg(final) || "Task failed"}`);
      err.code = "KLING_TASK_FAILED";
      err.provider = { kling: { createResponse: created, finalResponse: final, taskId } };
      throw err;
    }

    if (Date.now() - startedAt >= maxMs) {
      return { created, final, taskId, timedOut: true };
    }

    await sleepMs(waitMs);

    final = await klingRequestJson(queryPathFromTaskId(taskId), {
      method: "GET",
      timeoutMs: REPLICATE_CALL_TIMEOUT_MS,
    });
  }
}

// ============================================================================
// Image pickers
// ============================================================================
export function pickKlingStartImage(vars, parent) {
  const assets = vars?.assets || {};
  const inputs = vars?.inputs || {};

  return withKlingImageSizing(
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

  return withKlingImageSizing(
    asHttpUrl(inputs.end_image_url || inputs.endImageUrl) ||
    asHttpUrl(assets.end_image_url || assets.endImageUrl) ||
    ""
  );
}

// ============================================================================
// runKling — v3-video + legacy fallback
// ============================================================================
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
  const cfg = getMmaConfig();

  const modelName =
    safeStr(process.env.MMA_KLING_MODEL_NAME, "") ||
    safeStr(cfg?.kling?.model_name, "") ||
    "kling-v3";

  const hasStart = !!asHttpUrl(startImage);
  const hasEnd = !!asHttpUrl(endImage);

  const rawDuration =
    Number(duration ?? cfg?.kling?.duration ?? process.env.MMA_KLING_DURATION ?? 5) || 5;

  const finalDuration = Math.max(3, Math.min(15, Math.round(rawDuration)));
  const finalMode = normalizeKlingSourceMode(
    safeStr(mode, "") ||
      safeStr(cfg?.kling?.mode, "") ||
      safeStr(process.env.MMA_KLING_MODE, "") ||
      "pro"
  );

  const finalNeg =
    negativePrompt !== undefined
      ? safeStr(negativePrompt, KLING_DEFAULT_NEGATIVE_PROMPT)
      : safeStr(
          process.env.NEGATIVE_PROMPT_KLING || process.env.MMA_NEGATIVE_PROMPT_KLING || cfg?.kling?.negativePrompt,
          ""
        ) || KLING_DEFAULT_NEGATIVE_PROMPT;

  const finalPrompt = safeStr(prompt, "");
  if (!finalPrompt) throw new Error("MISSING_KLING_PROMPT");

  const sound = generateAudio ? "on" : "off";

  let createPath = "/v1/videos/text2video";
  let queryPathFromTaskId = (taskId) => `/v1/videos/text2video/${encodeURIComponent(taskId)}`;
  let input;

  if (forcedInput) {
    input = { ...forcedInput };
  } else if (hasStart) {
    createPath = "/v1/videos/image2video";
    queryPathFromTaskId = (taskId) => `/v1/videos/image2video/${encodeURIComponent(taskId)}`;

    input = {
      model_name: modelName,
      image: asHttpUrl(startImage),
      prompt: finalPrompt,
      duration: String(finalDuration),
      mode: finalMode,
      sound,
      ...(hasEnd ? { image_tail: asHttpUrl(endImage) } : {}),
      ...(finalNeg ? { negative_prompt: finalNeg } : {}),
    };
  } else {
    input = {
      model_name: modelName,
      prompt: finalPrompt,
      duration: String(finalDuration),
      mode: finalMode,
      sound,
      aspect_ratio: safeStr(aspectRatio, "") || "16:9",
      ...(finalNeg ? { negative_prompt: finalNeg } : {}),
    };
  }

  const t0 = Date.now();

  const polled = await submitAndPollKlingTask({
    createPath,
    queryPathFromTaskId,
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
        createPath,
        task_id: polled.taskId,
        createResponse: polled.created,
        finalResponse: polled.final,
      },
    },
  };
}

export { KLING_DEFAULT_NEGATIVE_PROMPT };
