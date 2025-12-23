// ./server/mma/mma-controller.js
import express from "express";
import OpenAI from "openai";
import Replicate from "replicate";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { megaEnsureCustomer } from "../../mega-db.js";
import { getSupabaseAdmin } from "../../supabase.js";

import {
  computePassId,
  eventIdentifiers,
  generationIdentifiers,
  makeInitialVars,
  newUuid,
  nowIso,
  stepIdentifiers,
} from "./mma-utils.js";

import { addSseClient, sendDone, sendScanLine, sendStatus } from "./mma-sse.js";
import { getMmaConfig } from "./mma-config.js";

/**
 * IMPORTANT: scan_lines are stored/sent as objects: { text, index }
 * Frontend should render: line.text
 */

// ---------------------------
// Cached clients
// ---------------------------
let _openai = null;
function getOpenAI() {
  if (_openai) return _openai;
  if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY_MISSING");
  _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return _openai;
}

let _replicate = null;
function getReplicate() {
  if (_replicate) return _replicate;
  if (!process.env.REPLICATE_API_TOKEN) throw new Error("REPLICATE_API_TOKEN_MISSING");
  _replicate = new Replicate({ auth: process.env.REPLICATE_API_TOKEN });
  return _replicate;
}

// ---------------------------
// Tiny helpers
// ---------------------------
function safeStr(v, fallback = "") {
  if (v === null || v === undefined) return fallback;
  const s = typeof v === "string" ? v : String(v);
  const t = s.trim();
  return t ? t : fallback;
}

function asHttpUrl(u) {
  const s = safeStr(u, "");
  return s.startsWith("http") ? s : "";
}

function safeArray(x) {
  return Array.isArray(x) ? x : [];
}

function parseJsonMaybe(v) {
  if (!v) return null;
  if (typeof v === "object") return v;
  if (typeof v === "string") {
    try {
      return JSON.parse(v);
    } catch {
      return null;
    }
  }
  return null;
}

// ---------------------------
// User messages (SSE + DB)
// ---------------------------
function pushUserMessageLine(vars, text) {
  const t = safeStr(text, "");
  if (!t) return vars;

  const next = { ...(vars || {}) };
  next.userMessages = { ...(next.userMessages || {}) };

  const prev = Array.isArray(next.userMessages.scan_lines) ? next.userMessages.scan_lines : [];
  const index = prev.length;

  next.userMessages.scan_lines = [...prev, { text: t, index }];
  return next;
}

function lastScanLine(vars, fallbackText = "") {
  const lines = vars?.userMessages?.scan_lines;
  const last = Array.isArray(lines) && lines.length ? lines[lines.length - 1] : null;
  return last || { text: fallbackText, index: Array.isArray(lines) ? lines.length : 0 };
}

// ---------------------------
// ctx config (editable in mega_admin)
// ---------------------------
async function getMmaCtxConfig(supabase) {
  const defaults = {
    // STILL
    scanner: [
      "You are Mina GPTscanner.",
      "You will be given ONE image. Understand it.",
      'Output STRICT JSON only (no markdown): {"crt":string,"userMessage":string}',
      "crt: short factual description in ONE sentence (max 220 chars).",
      "Hint type if possible (product/logo/inspiration).",
      "userMessage: friendly short line while user waits (max 140 chars).",
      "Never mention technical errors like CORS.",
    ].join("\n"),

    like_history: [
      "You are Mina Style Memory.",
      "You receive a list of recently liked generations (prompt + maybe images).",
      'Output STRICT JSON only: {"style_history_csv":string}',
      "style_history_csv: comma-separated keywords (5 to 12). No hashtags. No sentences.",
    ].join("\n"),

    reader: [
      "You are Mina Mind — prompt builder for Seedream (still image).",
      "You will receive product_crt/logo_crt/inspiration_crt + user brief + style + style_history_csv.",
      'Output STRICT JSON only: {"clean_prompt":string,"userMessage":string}',
      "clean_prompt: Seedream-ready, photoreal editorial, concise but detailed.",
      "Respect logo integration if logo_crt exists. Use inspirations if provided.",
      "userMessage: friendly short line while generating (max 140 chars).",
    ].join("\n"),

    output_scan: [
      "You are Mina GPTscanner (output scan).",
      "You will be given the GENERATED image.",
      'Output STRICT JSON only: {"still_crt":string,"userMessage":string}',
      "still_crt: 1-sentence description (max 220 chars).",
      "userMessage: friendly short line (max 140 chars).",
    ].join("\n"),

    feedback: [
      "You are Mina Feedback Fixer for Seedream still images.",
      "You will receive: generated image + still_crt + user feedback + previous prompt.",
      'Output STRICT JSON only: {"clean_prompt":string}',
      "clean_prompt must keep what's good, fix what's bad, apply feedback precisely.",
    ].join("\n"),

    // MOTION
    motion_suggestion: [
      "You are Mina Motion Suggestion.",
      "You receive: start still image + still_crt + motion_user_brief + selected_movement_style.",
      'Output STRICT JSON only: {"sugg_prompt":string,"userMessage":string}',
      "sugg_prompt: short Kling-ready motion prompt (motion + camera).",
      "userMessage: friendly short line (max 140 chars).",
    ].join("\n"),

    motion_reader2: [
      "You are Mina Motion Reader — prompt builder for Kling (image-to-video).",
      "You receive: start still image + still_crt + motion_user_brief + selected_movement_style.",
      'Output STRICT JSON only: {"motion_prompt":string,"userMessage":string}',
      "motion_prompt: Kling-ready. Motion, camera, atmosphere, pace. Concise but detailed.",
      "userMessage: friendly short line (max 140 chars).",
    ].join("\n"),

    motion_feedback2: [
      "You are Mina Motion Feedback Fixer for Kling (image-to-video).",
      "You receive: base motion input + feedback_motion + previous motion prompt.",
      'Output STRICT JSON only: {"motion_prompt":string}',
      "motion_prompt must keep what's good, fix what's bad, apply feedback precisely.",
    ].join("\n"),
  };

  try {
    const { data, error } = await supabase
      .from("mega_admin")
      .select("mg_value")
      .eq("mg_record_type", "app_config")
      .eq("mg_key", "mma_ctx")
      .maybeSingle();

    if (error) throw error;

    const overrides = data?.mg_value && typeof data.mg_value === "object" ? data.mg_value : {};
    return { ...defaults, ...overrides };
  } catch {
    return defaults;
  }
}

// ---------------------------
// OpenAI vision JSON helper
// (Responses API preferred; fallback to chat.completions)
// ---------------------------
function buildResponsesUserContent({ text, imageUrls }) {
  const parts = [];
  const t = safeStr(text, "");
  if (t) parts.push({ type: "input_text", text: t });

  for (const u of safeArray(imageUrls)) {
    const url = asHttpUrl(u);
    if (!url) continue;
    parts.push({ type: "input_image", image_url: url });
  }
  return parts;
}

function extractResponsesText(resp) {
  if (resp && typeof resp.output_text === "string") return resp.output_text;
  const out = resp?.output;
  if (!Array.isArray(out)) return "";
  let text = "";
  for (const item of out) {
    if (item?.type === "message" && Array.isArray(item?.content)) {
      for (const c of item.content) {
        if (c?.type === "output_text" && typeof c?.text === "string") text += c.text;
      }
    }
  }
  return text || "";
}

function buildChatUserContent({ text, imageUrls }) {
  const parts = [];
  const t = safeStr(text, "");
  if (t) parts.push({ type: "text", text: t });

  for (const u of safeArray(imageUrls)) {
    const url = asHttpUrl(u);
    if (!url) continue;
    parts.push({ type: "image_url", image_url: { url } });
  }
  return parts;
}

async function openaiJsonVision({ model, system, userText, imageUrls }) {
  const openai = getOpenAI();

  // Try Responses API
  try {
    if (openai.responses?.create) {
      const input = [
        { role: "system", content: system },
        { role: "user", content: buildResponsesUserContent({ text: userText, imageUrls }) },
      ];

      const resp = await openai.responses.create({
        model,
        input,
        text: { format: { type: "json_object" } },
      });

      const raw = extractResponsesText(resp);
      const parsed = parseJsonMaybe(raw);

      return { request: { model, input }, raw, parsed };
    }
  } catch {
    // fall through
  }

  // Fallback: Chat Completions
  const messages = [
    { role: "system", content: system },
    { role: "user", content: buildChatUserContent({ text: userText, imageUrls }) },
  ];

  const resp = await openai.chat.completions.create({
    model,
    messages,
    response_format: { type: "json_object" },
  });

  const raw = resp?.choices?.[0]?.message?.content || "";
  const parsed = parseJsonMaybe(raw);

  return { request: { model, messages }, raw, parsed };
}

// ---------------------------
// GPT steps
// ---------------------------
async function gptScanImage({ cfg, ctx, kind, imageUrl }) {
  const out = await openaiJsonVision({
    model: cfg.gptModel,
    system: ctx.scanner,
    userText: [`KIND: ${kind}`, "Return JSON only."].join("\n"),
    imageUrls: [imageUrl],
  });

  return {
    crt: safeStr(out?.parsed?.crt, ""),
    userMessage: safeStr(out?.parsed?.userMessage, ""),
    request: out.request,
    raw: out.raw,
    parsed_ok: !!out.parsed,
  };
}

async function gptMakeStyleHistory({ cfg, ctx, likeItems }) {
  const out = await openaiJsonVision({
    model: cfg.gptModel,
    system: ctx.like_history,
    userText: ["RECENT_LIKES:", JSON.stringify(likeItems, null, 2).slice(0, 12000), "Return JSON only."].join("\n"),
    imageUrls: likeItems.map((x) => asHttpUrl(x?.imageUrl)).filter(Boolean).slice(0, 8),
  });

  return {
    style_history_csv: safeStr(out?.parsed?.style_history_csv, ""),
    request: out.request,
    raw: out.raw,
    parsed_ok: !!out.parsed,
  };
}

async function gptReader({ cfg, ctx, input, imageUrls }) {
  const out = await openaiJsonVision({
    model: cfg.gptModel,
    system: ctx.reader,
    userText: JSON.stringify(input, null, 2).slice(0, 14000),
    imageUrls: safeArray(imageUrls).slice(0, 10),
  });

  return {
    clean_prompt: safeStr(out?.parsed?.clean_prompt, ""),
    userMessage: safeStr(out?.parsed?.userMessage, ""),
    request: out.request,
    raw: out.raw,
    parsed_ok: !!out.parsed,
  };
}

async function gptScanOutputStill({ cfg, ctx, imageUrl }) {
  const out = await openaiJsonVision({
    model: cfg.gptModel,
    system: ctx.output_scan,
    userText: "Scan this image. Return JSON only.",
    imageUrls: [imageUrl],
  });

  return {
    still_crt: safeStr(out?.parsed?.still_crt, ""),
    userMessage: safeStr(out?.parsed?.userMessage, ""),
    request: out.request,
    raw: out.raw,
    parsed_ok: !!out.parsed,
  };
}

async function gptFeedbackFixer({ cfg, ctx, parentImageUrl, stillCrt, feedbackText, previousPrompt }) {
  const input = {
    parent_image_url: parentImageUrl,
    still_crt: safeStr(stillCrt, ""),
    feedback: safeStr(feedbackText, ""),
    previous_prompt: safeStr(previousPrompt, ""),
  };

  const out = await openaiJsonVision({
    model: cfg.gptModel,
    system: ctx.feedback,
    userText: JSON.stringify(input, null, 2).slice(0, 14000),
    imageUrls: [parentImageUrl],
  });

  const clean_prompt =
    safeStr(out?.parsed?.clean_prompt, "") || safeStr(out?.parsed?.prompt, "");

  return {
    clean_prompt,
    request: out.request,
    raw: out.raw,
    parsed_ok: !!out.parsed,
  };
}

// Motion GPT steps
async function gptMotionSuggestion({ cfg, ctx, imageUrl, stillCrt, motionBrief, movementStyle }) {
  const input = {
    start_image_url: imageUrl,
    still_crt: safeStr(stillCrt, ""),
    motion_user_brief: safeStr(motionBrief, ""),
    selected_movement_style: safeStr(movementStyle, ""),
  };

  const out = await openaiJsonVision({
    model: cfg.gptModel,
    system: ctx.motion_suggestion,
    userText: JSON.stringify(input, null, 2).slice(0, 14000),
    imageUrls: [imageUrl],
  });

  return {
    sugg_prompt: safeStr(out?.parsed?.sugg_prompt, ""),
    userMessage: safeStr(out?.parsed?.userMessage, ""),
    request: out.request,
    raw: out.raw,
    parsed_ok: !!out.parsed,
  };
}

async function gptMotionReader2({ cfg, ctx, imageUrl, stillCrt, motionBrief, movementStyle }) {
  const input = {
    start_image_url: imageUrl,
    still_crt: safeStr(stillCrt, ""),
    motion_user_brief: safeStr(motionBrief, ""),
    selected_movement_style: safeStr(movementStyle, ""),
  };

  const out = await openaiJsonVision({
    model: cfg.gptModel,
    system: ctx.motion_reader2,
    userText: JSON.stringify(input, null, 2).slice(0, 14000),
    imageUrls: [imageUrl],
  });

  return {
    motion_prompt: safeStr(out?.parsed?.motion_prompt, ""),
    userMessage: safeStr(out?.parsed?.userMessage, ""),
    request: out.request,
    raw: out.raw,
    parsed_ok: !!out.parsed,
  };
}

async function gptMotionFeedback2({ cfg, ctx, imageUrl, baseInput, feedbackMotion, previousMotionPrompt }) {
  const input = {
    ...baseInput,
    feedback_motion: safeStr(feedbackMotion, ""),
    previous_motion_prompt: safeStr(previousMotionPrompt, ""),
  };

  const out = await openaiJsonVision({
    model: cfg.gptModel,
    system: ctx.motion_feedback2,
    userText: JSON.stringify(input, null, 2).slice(0, 14000),
    imageUrls: [imageUrl],
  });

  const motion_prompt =
    safeStr(out?.parsed?.motion_prompt, "") || safeStr(out?.parsed?.prompt, "");

  return {
    motion_prompt,
    request: out.request,
    raw: out.raw,
    parsed_ok: !!out.parsed,
  };
}

// ---------------------------
// Replicate helpers
// ---------------------------
function pickFirstUrl(output) {
  if (!output) return "";
  if (typeof output === "string") return output;
  if (Array.isArray(output)) return pickFirstUrl(output[0]);
  if (typeof output === "object") {
    if (typeof output.url === "string") return output.url;
    if (typeof output.output === "string") return output.output;
  }
  return "";
}

function buildSeedreamImageInputs(vars) {
  const assets = vars?.assets || {};
  const product = asHttpUrl(assets.product_image_url || assets.productImageUrl);
  const logo = asHttpUrl(assets.logo_image_url || assets.logoImageUrl);

  const styleHero = asHttpUrl(
    assets.style_hero_image_url || assets.styleHeroImageUrl || assets.style_hero_url || assets.styleHeroUrl
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

async function runSeedream({ prompt, aspectRatio, imageInputs = [], size, enhancePrompt, input: forcedInput }) {
  const replicate = getReplicate();
  const cfg = getMmaConfig();

  const sizeValue = size || cfg?.seadream?.size || process.env.MMA_SEADREAM_SIZE || "2K";
  const defaultAspect = aspectRatio || cfg?.seadream?.aspectRatio || process.env.MMA_SEADREAM_ASPECT_RATIO || "match_input_image";

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
        aspect_ratio: defaultAspect,
        enhance_prompt,
        sequential_image_generation: "disabled",
        max_images: 1,
        ...(cleanedInputs.length ? { image_input: cleanedInputs } : {}),
      };

  const t0 = Date.now();
  const out = await replicate.run(version, { input });

  return {
    input,
    out,
    timing: { started_at: new Date(t0).toISOString(), ended_at: nowIso(), duration_ms: Date.now() - t0 },
  };
}

// Kling helpers
function pickKlingStartImage(vars, parent) {
  const assets = vars?.assets || {};
  const inputs = vars?.inputs || {};
  return (
    asHttpUrl(inputs.start_image_url || inputs.startImageUrl) ||
    asHttpUrl(inputs.parent_output_url || inputs.parentOutputUrl) ||
    asHttpUrl(parent?.mg_output_url) ||
    asHttpUrl(assets.start_image_url || assets.startImageUrl) ||
    asHttpUrl(assets.product_image_url || assets.productImageUrl) ||
    ""
  );
}

async function runKling({ prompt, startImage, duration, mode, negativePrompt, input: forcedInput }) {
  const replicate = getReplicate();
  const cfg = getMmaConfig();

  const version =
    process.env.MMA_KLING_VERSION ||
    process.env.MMA_KLING_MODEL_VERSION ||
    cfg?.kling?.model ||
    "kwaivgi/kling-v2.1";

  const defaultDuration = Number(duration ?? cfg?.kling?.duration ?? process.env.MMA_KLING_DURATION ?? 5) || 5;

  const envNeg =
    process.env.NEGATIVE_PROMPT_KLING ||
    process.env.MMA_NEGATIVE_PROMPT_KLING ||
    cfg?.kling?.negativePrompt ||
    "";

  const finalNeg = negativePrompt !== undefined ? negativePrompt : envNeg;

  const input = forcedInput
    ? { ...forcedInput }
    : {
        mode: mode || cfg?.kling?.mode || process.env.MMA_KLING_MODE || "standard",
        prompt,
        duration: defaultDuration,
        start_image: startImage,
      };

  if (finalNeg && !input.negative_prompt) input.negative_prompt = finalNeg;
  if (!input.mode) input.mode = mode || cfg?.kling?.mode || process.env.MMA_KLING_MODE || "standard";
  if (!input.prompt) input.prompt = prompt;
  input.duration = Number(input.duration ?? defaultDuration) || defaultDuration;
  if (!input.start_image) input.start_image = startImage;

  const t0 = Date.now();
  const out = await replicate.run(version, { input });

  return {
    input,
    out,
    timing: { started_at: new Date(t0).toISOString(), ended_at: nowIso(), duration_ms: Date.now() - t0 },
  };
}

// ---------------------------
// R2 Public store
// ---------------------------
function getR2() {
  const accountId = process.env.R2_ACCOUNT_ID || "";
  const endpoint =
    process.env.R2_ENDPOINT ||
    (accountId ? `https://${accountId}.r2.cloudflarestorage.com` : "");

  const accessKeyId = process.env.R2_ACCESS_KEY_ID || "";
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY || "";
  const bucket = process.env.R2_BUCKET || "";
  const publicBase = process.env.R2_PUBLIC_BASE_URL || "";

  const enabled = !!(endpoint && accessKeyId && secretAccessKey && bucket && publicBase);
  const client = enabled
    ? new S3Client({
        region: "auto",
        endpoint,
        credentials: { accessKeyId, secretAccessKey },
      })
    : null;

  return { enabled, client, bucket, publicBase };
}

function guessExt(url, fallback = ".bin") {
  try {
    const p = new URL(url).pathname.toLowerCase();
    if (p.endsWith(".png")) return ".png";
    if (p.endsWith(".jpg") || p.endsWith(".jpeg")) return ".jpg";
    if (p.endsWith(".webp")) return ".webp";
    if (p.endsWith(".gif")) return ".gif";
    if (p.endsWith(".mp4")) return ".mp4";
    if (p.endsWith(".webm")) return ".webm";
    if (p.endsWith(".mov")) return ".mov";
    return fallback;
  } catch {
    return fallback;
  }
}

async function storeRemoteToR2Public(url, keyPrefix) {
  const { enabled, client, bucket, publicBase } = getR2();
  if (!enabled || !client) return url;
  if (!url || typeof url !== "string") return url;

  if (publicBase && url.startsWith(publicBase)) return url;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`R2_FETCH_FAILED_${res.status}`);

  const buf = Buffer.from(await res.arrayBuffer());
  const contentType = res.headers.get("content-type") || "application/octet-stream";
  const ext = guessExt(url, contentType.includes("video") ? ".mp4" : ".png");
  const objKey = `${keyPrefix}${ext}`;

  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: objKey,
      Body: buf,
      ContentType: contentType,
    })
  );

  return `${publicBase.replace(/\/$/, "")}/${objKey}`;
}

// ---------------------------
// DB helpers
// ---------------------------
async function ensureCustomerRow(passId, { shopifyCustomerId, userId, email }) {
  const out = await megaEnsureCustomer({
    passId,
    shopifyCustomerId: shopifyCustomerId || null,
    userId: userId || null,
    email: email || null,
  });
  return { preferences: out?.preferences || {} };
}

async function writeGeneration({ supabase, generationId, parentId, passId, vars, mode }) {
  const identifiers = generationIdentifiers(generationId);
  await supabase.from("mega_generations").insert({
    ...identifiers,
    mg_parent_id: parentId ? `generation:${parentId}` : null,
    mg_pass_id: passId,
    mg_status: "queued",
    mg_mma_status: "queued",
    mg_mma_mode: mode,
    mg_mma_vars: vars,
    mg_prompt: null,
    mg_output_url: null,
    mg_created_at: nowIso(),
    mg_updated_at: nowIso(),
  });
}

async function writeStep({ supabase, generationId, passId, stepNo, stepType, payload }) {
  const identifiers = stepIdentifiers(generationId, stepNo);
  await supabase.from("mega_generations").insert({
    ...identifiers,
    mg_parent_id: `generation:${generationId}`,
    mg_pass_id: passId || null,
    mg_step_type: stepType,
    mg_payload: payload,
    mg_created_at: nowIso(),
    mg_updated_at: nowIso(),
  });
}

async function updateVars({ supabase, generationId, vars }) {
  await supabase
    .from("mega_generations")
    .update({ mg_mma_vars: vars, mg_updated_at: nowIso() })
    .eq("mg_generation_id", generationId)
    .eq("mg_record_type", "generation");
}

async function updateStatus({ supabase, generationId, status }) {
  await supabase
    .from("mega_generations")
    .update({ mg_status: status, mg_mma_status: status, mg_updated_at: nowIso() })
    .eq("mg_generation_id", generationId)
    .eq("mg_record_type", "generation");
}

async function finalizeGeneration({ supabase, generationId, url, prompt }) {
  await supabase
    .from("mega_generations")
    .update({
      mg_status: "done",
      mg_mma_status: "done",
      mg_output_url: url,
      mg_prompt: prompt,
      mg_updated_at: nowIso(),
    })
    .eq("mg_generation_id", generationId)
    .eq("mg_record_type", "generation");
}

async function fetchParentGenerationRow(supabase, parentGenerationId) {
  const { data, error } = await supabase
    .from("mega_generations")
    .select("mg_pass_id, mg_output_url, mg_prompt, mg_mma_vars, mg_mma_mode, mg_status, mg_error")
    .eq("mg_generation_id", parentGenerationId)
    .eq("mg_record_type", "generation")
    .maybeSingle();

  if (error) throw error;
  return data || null;
}

function extractFeedbackLikePayload(row) {
  const payload = parseJsonMaybe(row?.mg_payload);
  if (payload) return payload;
  const meta = parseJsonMaybe(row?.mg_meta);
  if (!meta) return null;
  if (meta.payload && typeof meta.payload === "object") return meta.payload;
  return meta;
}

async function fetchRecentLikedItems({ supabase, passId, limit }) {
  const { data, error } = await supabase
    .from("mega_generations")
    .select("mg_payload, mg_meta, mg_event_at, mg_created_at")
    .eq("mg_record_type", "feedback")
    .eq("mg_pass_id", passId)
    .order("mg_event_at", { ascending: false })
    .limit(Math.max(50, limit * 5));

  if (error) throw error;

  const rows = Array.isArray(data) ? data : [];
  const liked = [];

  for (const r of rows) {
    const p = extractFeedbackLikePayload(r);
    if (!p) continue;
    if (p.liked !== true) continue;

    liked.push({
      prompt: safeStr(p.prompt, ""),
      imageUrl: safeStr(p.imageUrl, ""),
      createdAt: r.mg_event_at || r.mg_created_at || null,
    });

    if (liked.length >= limit) break;
  }

  return liked;
}

// ============================================================================
// STILL CREATE PIPELINE
// ============================================================================
async function runStillCreatePipeline({ supabase, generationId, passId, vars }) {
  const cfg = getMmaConfig();
  if (!cfg.enabled) throw new Error("MMA_DISABLED");

  let working = vars;
  const ctx = await getMmaCtxConfig(supabase);
  working.ctx = { ...(working.ctx || {}), mma_ctx: ctx };
  working.scans = { ...(working.scans || {}) };

  let stepNo = 1;

  try {
    await updateStatus({ supabase, generationId, status: "scanning" });
    sendStatus(generationId, "scanning");

    working = pushUserMessageLine(working, "Scanning your inputs…");
    await updateVars({ supabase, generationId, vars: working });
    sendScanLine(generationId, lastScanLine(working, "Scanning your inputs…"));

    const assets = working?.assets || {};
    const productUrl = asHttpUrl(assets.product_image_url || assets.productImageUrl);
    const logoUrl = asHttpUrl(assets.logo_image_url || assets.logoImageUrl);

    const styleHeroUrl = asHttpUrl(
      assets.style_hero_image_url || assets.styleHeroImageUrl || assets.style_hero_url || assets.styleHeroUrl
    );

    const insp = safeArray(
      assets.inspiration_image_urls ||
        assets.inspirationImageUrls ||
        assets.style_image_urls ||
        assets.styleImageUrls
    )
      .map(asHttpUrl)
      .filter(Boolean)
      .slice(0, 4);

    if (productUrl) {
      const t0 = Date.now();
      const scan = await gptScanImage({ cfg, ctx, kind: "product", imageUrl: productUrl });

      await writeStep({
        supabase,
        generationId,
        passId,
        stepNo: stepNo++,
        stepType: "gpt_scan_product",
        payload: {
          ctx: ctx.scanner,
          input: { kind: "product", imageUrl: productUrl },
          request: scan.request,
          raw: scan.raw,
          output: scan,
          timing: { started_at: new Date(t0).toISOString(), ended_at: nowIso(), duration_ms: Date.now() - t0 },
          error: null,
        },
      });

      working.scans.product_crt = scan.crt || null;
      working = pushUserMessageLine(working, scan.userMessage || "Got your product image ✅");
      await updateVars({ supabase, generationId, vars: working });
      sendScanLine(generationId, lastScanLine(working, "Got your product image ✅"));
    }

    if (logoUrl) {
      const t0 = Date.now();
      const scan = await gptScanImage({ cfg, ctx, kind: "logo", imageUrl: logoUrl });

      await writeStep({
        supabase,
        generationId,
        passId,
        stepNo: stepNo++,
        stepType: "gpt_scan_logo",
        payload: {
          ctx: ctx.scanner,
          input: { kind: "logo", imageUrl: logoUrl },
          request: scan.request,
          raw: scan.raw,
          output: scan,
          timing: { started_at: new Date(t0).toISOString(), ended_at: nowIso(), duration_ms: Date.now() - t0 },
          error: null,
        },
      });

      working.scans.logo_crt = scan.crt || null;
      working = pushUserMessageLine(working, scan.userMessage || "Logo noted ✅");
      await updateVars({ supabase, generationId, vars: working });
      sendScanLine(generationId, lastScanLine(working, "Logo noted ✅"));
    }

    for (let i = 0; i < insp.length; i++) {
      const imageUrl = insp[i];
      const t0 = Date.now();
      const scan = await gptScanImage({ cfg, ctx, kind: `inspiration_${i + 1}`, imageUrl });

      await writeStep({
        supabase,
        generationId,
        passId,
        stepNo: stepNo++,
        stepType: "gpt_scan_inspiration",
        payload: {
          ctx: ctx.scanner,
          input: { kind: `inspiration_${i + 1}`, imageUrl },
          request: scan.request,
          raw: scan.raw,
          output: scan,
          timing: { started_at: new Date(t0).toISOString(), ended_at: nowIso(), duration_ms: Date.now() - t0 },
          error: null,
        },
      });

      working.scans.inspiration_crt = Array.isArray(working.scans.inspiration_crt) ? working.scans.inspiration_crt : [];
      working.scans.inspiration_crt = [...working.scans.inspiration_crt, scan.crt || ""];
      working = pushUserMessageLine(working, scan.userMessage || `Inspiration ${i + 1} added ✨`);
      await updateVars({ supabase, generationId, vars: working });
      sendScanLine(generationId, lastScanLine(working, `Inspiration ${i + 1} added ✨`));
    }

    if (styleHeroUrl) {
      const t0 = Date.now();
      const scan = await gptScanImage({ cfg, ctx, kind: "style_hero", imageUrl: styleHeroUrl });

      await writeStep({
        supabase,
        generationId,
        passId,
        stepNo: stepNo++,
        stepType: "gpt_scan_style_hero",
        payload: {
          ctx: ctx.scanner,
          input: { kind: "style_hero", imageUrl: styleHeroUrl },
          request: scan.request,
          raw: scan.raw,
          output: scan,
          timing: { started_at: new Date(t0).toISOString(), ended_at: nowIso(), duration_ms: Date.now() - t0 },
          error: null,
        },
      });

      working.scans.style_hero_crt = scan.crt || null;
      working = pushUserMessageLine(working, scan.userMessage || "Style reference noted ✨");
      await updateVars({ supabase, generationId, vars: working });
      sendScanLine(generationId, lastScanLine(working, "Style reference noted ✨"));
    }

    // Like-history (optional)
    const visionOn = !!working?.history?.vision_intelligence;
    const likeLimit = visionOn ? 5 : 20;

    try {
      const likes = await fetchRecentLikedItems({ supabase, passId, limit: likeLimit });
      if (likes.length) {
        const t0 = Date.now();
        const style = await gptMakeStyleHistory({ cfg, ctx, likeItems: likes });

        await writeStep({
          supabase,
          generationId,
          passId,
          stepNo: stepNo++,
          stepType: "gpt_like_history",
          payload: {
            ctx: ctx.like_history,
            input: { vision_intelligence: visionOn, limit: likeLimit, likes },
            request: style.request,
            raw: style.raw,
            output: style,
            timing: { started_at: new Date(t0).toISOString(), ended_at: nowIso(), duration_ms: Date.now() - t0 },
            error: null,
          },
        });

        working.history = { ...(working.history || {}), style_history_csv: style.style_history_csv || null };
        working = pushUserMessageLine(working, "Remembered your style preferences 🧠✨");
        await updateVars({ supabase, generationId, vars: working });
        sendScanLine(generationId, lastScanLine(working, "Remembered your style preferences 🧠✨"));
      }
    } catch {
      // optional
    }

    // Reader
    await updateStatus({ supabase, generationId, status: "prompting" });
    sendStatus(generationId, "prompting");

    const readerInput = {
      product_crt: safeStr(working?.scans?.product_crt, ""),
      logo_crt: safeStr(working?.scans?.logo_crt, ""),
      inspiration_crt: Array.isArray(working?.scans?.inspiration_crt) ? working.scans.inspiration_crt : [],
      style_hero_crt: safeStr(working?.scans?.style_hero_crt, ""),
      userBrief: safeStr(working?.inputs?.brief || working?.inputs?.userBrief, ""),
      style: safeStr(working?.inputs?.style, ""),
      platform: safeStr(working?.inputs?.platform || "default", "default"),
      aspect_ratio: safeStr(working?.inputs?.aspect_ratio, ""),
      style_history_csv: safeStr(working?.history?.style_history_csv, ""),
    };

    const readerImages = [productUrl, logoUrl, ...insp, styleHeroUrl].filter(Boolean);
    const tReader = Date.now();
    const prompts = await gptReader({ cfg, ctx, input: readerInput, imageUrls: readerImages });

    await writeStep({
      supabase,
      generationId,
      passId,
      stepNo: stepNo++,
      stepType: "gpt_reader",
      payload: {
        ctx: ctx.reader,
        input: readerInput,
        request: prompts.request,
        raw: prompts.raw,
        output: prompts,
        timing: { started_at: new Date(tReader).toISOString(), ended_at: nowIso(), duration_ms: Date.now() - tReader },
        error: null,
      },
    });

    working.prompts = { ...(working.prompts || {}), clean_prompt: prompts.clean_prompt || "" };

    working = pushUserMessageLine(working, prompts.userMessage || "Prompt locked in. Cooking… 🔥");
    await updateVars({ supabase, generationId, vars: working });
    sendScanLine(generationId, lastScanLine(working, "Prompt locked in. Cooking… 🔥"));

    // Seedream
    await updateStatus({ supabase, generationId, status: "generating" });
    sendStatus(generationId, "generating");

    const usedPrompt = safeStr(working?.prompts?.clean_prompt, "");
    if (!usedPrompt) throw new Error("EMPTY_PROMPT");

    const aspect_ratio =
      safeStr(working?.inputs?.aspect_ratio, "") ||
      cfg?.seadream?.aspectRatio ||
      process.env.MMA_SEADREAM_ASPECT_RATIO ||
      "match_input_image";

    const imageInputs = buildSeedreamImageInputs(working);

    const tGen = Date.now();
    const gen = await runSeedream({
      prompt: usedPrompt,
      aspectRatio: aspect_ratio,
      imageInputs,
      size: cfg?.seadream?.size,
      enhancePrompt: cfg?.seadream?.enhancePrompt,
    });

    const url = pickFirstUrl(gen.out);
    if (!url) throw new Error("SEADREAM_NO_URL");

    await writeStep({
      supabase,
      generationId,
      passId,
      stepNo: stepNo++,
      stepType: "seedream_generate",
      payload: { input: gen.input, output: gen.out, timing: gen.timing, error: null, started_at: new Date(tGen).toISOString() },
    });

    const remoteUrl = await storeRemoteToR2Public(url, `mma/still/${generationId}`);
    working.outputs = { ...(working.outputs || {}), seedream_image_url: remoteUrl };
    working.mg_output_url = remoteUrl;

    // Output scan
    await updateStatus({ supabase, generationId, status: "postscan" });
    sendStatus(generationId, "postscan");

    const tScan = Date.now();
    const outScan = await gptScanOutputStill({ cfg, ctx, imageUrl: remoteUrl });

    await writeStep({
      supabase,
      generationId,
      passId,
      stepNo: stepNo++,
      stepType: "gpt_scan_output",
      payload: {
        ctx: ctx.output_scan,
        input: { imageUrl: remoteUrl },
        request: outScan.request,
        raw: outScan.raw,
        output: outScan,
        timing: { started_at: new Date(tScan).toISOString(), ended_at: nowIso(), duration_ms: Date.now() - tScan },
        error: null,
      },
    });

    working.scans = { ...(working.scans || {}), still_crt: outScan.still_crt || null };
    working = pushUserMessageLine(working, outScan.userMessage || "Done ✅");
    working.userMessages = { ...(working.userMessages || {}), final_line: "Finished generation." };

    await updateVars({ supabase, generationId, vars: working });
    sendScanLine(generationId, lastScanLine(working, "Done ✅"));

    await finalizeGeneration({ supabase, generationId, url: remoteUrl, prompt: usedPrompt });

    await updateStatus({ supabase, generationId, status: "done" });
    sendStatus(generationId, "done");
    sendDone(generationId, "done");
  } catch (err) {
    console.error("[mma] still create pipeline error", err);

    await updateStatus({ supabase, generationId, status: "error" });
    await supabase
      .from("mega_generations")
      .update({
        mg_error: { code: "PIPELINE_ERROR", message: err?.message || String(err || "") },
        mg_updated_at: nowIso(),
      })
      .eq("mg_generation_id", generationId)
      .eq("mg_record_type", "generation");

    sendStatus(generationId, "error");
    sendDone(generationId, "error");
  }
}

// ============================================================================
// STILL TWEAK PIPELINE
// ============================================================================
async function runStillTweakPipeline({ supabase, generationId, passId, parent, vars }) {
  const cfg = getMmaConfig();
  if (!cfg.enabled) throw new Error("MMA_DISABLED");

  let working = vars;
  const ctx = await getMmaCtxConfig(supabase);
  working.ctx = { ...(working.ctx || {}), mma_ctx: ctx };
  working.scans = { ...(working.scans || {}) };

  let stepNo = 1;

  try {
    await updateStatus({ supabase, generationId, status: "scanning" });
    sendStatus(generationId, "scanning");

    working = pushUserMessageLine(working, "Reviewing your last image…");
    await updateVars({ supabase, generationId, vars: working });
    sendScanLine(generationId, lastScanLine(working, "Reviewing your last image…"));

    const parentUrl = asHttpUrl(parent?.mg_output_url);
    if (!parentUrl) throw new Error("PARENT_OUTPUT_URL_MISSING");

    const parentVars = parent?.mg_mma_vars && typeof parent.mg_mma_vars === "object" ? parent.mg_mma_vars : {};
    let stillCrt =
      safeStr(parentVars?.scans?.still_crt, "") ||
      safeStr(parentVars?.still_crt, "");

    if (!stillCrt) {
      const t0 = Date.now();
      const scan = await gptScanOutputStill({ cfg, ctx, imageUrl: parentUrl });

      await writeStep({
        supabase,
        generationId,
        passId,
        stepNo: stepNo++,
        stepType: "gpt_scan_output_parent",
        payload: {
          ctx: ctx.output_scan,
          input: { imageUrl: parentUrl },
          request: scan.request,
          raw: scan.raw,
          output: scan,
          timing: { started_at: new Date(t0).toISOString(), ended_at: nowIso(), duration_ms: Date.now() - t0 },
          error: null,
        },
      });

      stillCrt = scan.still_crt || "";
      working.scans.still_crt = stillCrt || null;

      working = pushUserMessageLine(working, scan.userMessage || "Got it — I see the last image ✅");
      await updateVars({ supabase, generationId, vars: working });
      sendScanLine(generationId, lastScanLine(working, "Got it — I see the last image ✅"));
    } else {
      working.scans.still_crt = stillCrt;
      await updateVars({ supabase, generationId, vars: working });
    }

    await updateStatus({ supabase, generationId, status: "prompting" });
    sendStatus(generationId, "prompting");

    const feedbackText =
      safeStr(working?.feedback?.still_feedback, "") ||
      safeStr(working?.feedback?.feedback_still, "") ||
      safeStr(working?.feedback?.text, "") ||
      safeStr(working?.inputs?.feedback_still, "") ||
      safeStr(working?.inputs?.feedback, "") ||
      safeStr(working?.inputs?.comment, "");

    if (!feedbackText) throw new Error("MISSING_STILL_FEEDBACK");

    const t1 = Date.now();
    const fix = await gptFeedbackFixer({
      cfg,
      ctx,
      parentImageUrl: parentUrl,
      stillCrt,
      feedbackText,
      previousPrompt: safeStr(parent?.mg_prompt, ""),
    });

    await writeStep({
      supabase,
      generationId,
      passId,
      stepNo: stepNo++,
      stepType: "gpt_feedback_still",
      payload: {
        ctx: ctx.feedback,
        input: { parent_image_url: parentUrl, still_crt: stillCrt, feedback: feedbackText, previous_prompt: safeStr(parent?.mg_prompt, "") },
        request: fix.request,
        raw: fix.raw,
        output: fix,
        timing: { started_at: new Date(t1).toISOString(), ended_at: nowIso(), duration_ms: Date.now() - t1 },
        error: null,
      },
    });

    const usedPrompt = safeStr(fix.clean_prompt, "");
    if (!usedPrompt) throw new Error("EMPTY_FEEDBACK_PROMPT");

    working.prompts = { ...(working.prompts || {}), clean_prompt: usedPrompt };
    working = pushUserMessageLine(working, "Applying your feedback… ✨");
    await updateVars({ supabase, generationId, vars: working });
    sendScanLine(generationId, lastScanLine(working, "Applying your feedback… ✨"));

    await updateStatus({ supabase, generationId, status: "generating" });
    sendStatus(generationId, "generating");

    const aspect_ratio =
      safeStr(working?.inputs?.aspect_ratio, "") ||
      cfg?.seadream?.aspectRatio ||
      process.env.MMA_SEADREAM_ASPECT_RATIO ||
      "match_input_image";

    const forcedInput = {
      prompt: usedPrompt,
      size: cfg?.seadream?.size || process.env.MMA_SEADREAM_SIZE || "2K",
      aspect_ratio,
      enhance_prompt: !!cfg?.seadream?.enhancePrompt,
      sequential_image_generation: "disabled",
      max_images: 1,
      image_input: [parentUrl],
    };

    const t2 = Date.now();
    const gen = await runSeedream({
      prompt: usedPrompt,
      aspectRatio: aspect_ratio,
      imageInputs: [parentUrl],
      size: cfg?.seadream?.size,
      enhancePrompt: cfg?.seadream?.enhancePrompt,
      input: forcedInput,
    });

    const seedUrl = pickFirstUrl(gen.out);
    if (!seedUrl) throw new Error("SEADREAM_NO_URL_TWEAK");

    await writeStep({
      supabase,
      generationId,
      passId,
      stepNo: stepNo++,
      stepType: "seedream_generate_tweak",
      payload: { input: gen.input, output: gen.out, timing: gen.timing, error: null, started_at: new Date(t2).toISOString() },
    });

    const remoteUrl = await storeRemoteToR2Public(seedUrl, `mma/still/${generationId}`);
    working.outputs = { ...(working.outputs || {}), seedream_image_url: remoteUrl };
    working.mg_output_url = remoteUrl;

    working = pushUserMessageLine(working, "Saved your improved image ✅");
    await updateVars({ supabase, generationId, vars: working });
    sendScanLine(generationId, lastScanLine(working, "Saved your improved image ✅"));

    await updateStatus({ supabase, generationId, status: "postscan" });
    sendStatus(generationId, "postscan");

    const t3 = Date.now();
    const scanNew = await gptScanOutputStill({ cfg, ctx, imageUrl: remoteUrl });

    await writeStep({
      supabase,
      generationId,
      passId,
      stepNo: stepNo++,
      stepType: "gpt_scan_output",
      payload: {
        ctx: ctx.output_scan,
        input: { imageUrl: remoteUrl },
        request: scanNew.request,
        raw: scanNew.raw,
        output: scanNew,
        timing: { started_at: new Date(t3).toISOString(), ended_at: nowIso(), duration_ms: Date.now() - t3 },
        error: null,
      },
    });

    working.scans = { ...(working.scans || {}), still_crt: scanNew.still_crt || stillCrt || "" };
    working = pushUserMessageLine(working, scanNew.userMessage || "Tweak done ✅");
    working.userMessages = { ...(working.userMessages || {}), final_line: "Tweak finished." };

    await updateVars({ supabase, generationId, vars: working });

    await finalizeGeneration({ supabase, generationId, url: remoteUrl, prompt: usedPrompt });

    await updateStatus({ supabase, generationId, status: "done" });
    sendStatus(generationId, "done");
    sendDone(generationId, "done");
  } catch (err) {
    console.error("[mma] still tweak pipeline error", err);

    await updateStatus({ supabase, generationId, status: "error" });
    await supabase
      .from("mega_generations")
      .update({
        mg_error: { code: "PIPELINE_ERROR", message: err?.message || String(err || "") },
        mg_updated_at: nowIso(),
      })
      .eq("mg_generation_id", generationId)
      .eq("mg_record_type", "generation");

    sendStatus(generationId, "error");
    sendDone(generationId, "error");
  }
}

// ============================================================================
// VIDEO (Kling) ANIMATE PIPELINE
// ============================================================================
async function runVideoAnimatePipeline({ supabase, generationId, passId, parent, vars }) {
  const cfg = getMmaConfig();
  if (!cfg.enabled) throw new Error("MMA_DISABLED");

  let working = vars;
  const ctx = await getMmaCtxConfig(supabase);
  working.ctx = { ...(working.ctx || {}), mma_ctx: ctx };
  working.scans = { ...(working.scans || {}) };

  let stepNo = 1;

  try {
    await updateStatus({ supabase, generationId, status: "scanning" });
    sendStatus(generationId, "scanning");

    const parentVars = parent?.mg_mma_vars && typeof parent.mg_mma_vars === "object" ? parent.mg_mma_vars : {};
    const parentStillCrt = safeStr(parentVars?.scans?.still_crt, "") || safeStr(parentVars?.still_crt, "");

    const startImage = pickKlingStartImage(working, parent);
    if (!startImage) throw new Error("MISSING_START_IMAGE_FOR_VIDEO");

    working.inputs = { ...(working.inputs || {}), start_image_url: startImage };

    working = pushUserMessageLine(working, "Reading your image before animating…");
    await updateVars({ supabase, generationId, vars: working });
    sendScanLine(generationId, lastScanLine(working, "Reading your image before animating…"));

    let stillCrt = parentStillCrt;
    if (!stillCrt) {
      const t0 = Date.now();
      const scan = await gptScanOutputStill({ cfg, ctx, imageUrl: startImage });

      await writeStep({
        supabase,
        generationId,
        passId,
        stepNo: stepNo++,
        stepType: "gpt_scan_start_image",
        payload: {
          ctx: ctx.output_scan,
          input: { imageUrl: startImage },
          request: scan.request,
          raw: scan.raw,
          output: scan,
          timing: { started_at: new Date(t0).toISOString(), ended_at: nowIso(), duration_ms: Date.now() - t0 },
          error: null,
        },
      });

      stillCrt = scan.still_crt || "";
      working.scans.still_crt = stillCrt || null;

      working = pushUserMessageLine(working, scan.userMessage || "Image understood ✅");
      await updateVars({ supabase, generationId, vars: working });
      sendScanLine(generationId, lastScanLine(working, "Image understood ✅"));
    } else {
      working.scans.still_crt = stillCrt;
      await updateVars({ supabase, generationId, vars: working });
    }

    await updateStatus({ supabase, generationId, status: "prompting" });
    sendStatus(generationId, "prompting");

    const motionBrief =
      safeStr(working?.inputs?.motion_user_brief, "") ||
      safeStr(working?.inputs?.motionBrief, "") ||
      safeStr(working?.inputs?.brief, "") ||
      safeStr(working?.inputs?.prompt, "");

    const movementStyle =
      safeStr(working?.inputs?.selected_movement_style, "") ||
      safeStr(working?.inputs?.movement_style, "") ||
      safeStr(working?.inputs?.movementStyle, "");

    const typeForMe =
      working?.inputs?.type_for_me === true ||
      working?.inputs?.typeForMe === true ||
      working?.inputs?.use_suggestion === true;

    const suggestOnly =
      working?.inputs?.suggest_only === true ||
      working?.inputs?.suggestOnly === true;

    if (typeForMe) {
      const t1 = Date.now();
      const sugg = await gptMotionSuggestion({
        cfg,
        ctx,
        imageUrl: startImage,
        stillCrt,
        motionBrief,
        movementStyle,
      });

      await writeStep({
        supabase,
        generationId,
        passId,
        stepNo: stepNo++,
        stepType: "gpt_motion_suggestion",
        payload: {
          ctx: ctx.motion_suggestion,
          input: { start_image_url: startImage, still_crt: stillCrt, motion_user_brief: motionBrief, selected_movement_style: movementStyle },
          request: sugg.request,
          raw: sugg.raw,
          output: sugg,
          timing: { started_at: new Date(t1).toISOString(), ended_at: nowIso(), duration_ms: Date.now() - t1 },
          error: null,
        },
      });

      working.prompts = { ...(working.prompts || {}), sugg_prompt: sugg.sugg_prompt || "" };
      working = pushUserMessageLine(working, sugg.userMessage || "Motion idea ready ✨");
      await updateVars({ supabase, generationId, vars: working });
      sendScanLine(generationId, lastScanLine(working, "Motion idea ready ✨"));

      if (suggestOnly) {
        await supabase
          .from("mega_generations")
          .update({
            mg_status: "suggested",
            mg_mma_status: "suggested",
            mg_prompt: working?.prompts?.sugg_prompt || null,
            mg_updated_at: nowIso(),
          })
          .eq("mg_generation_id", generationId)
          .eq("mg_record_type", "generation");

        sendStatus(generationId, "suggested");
        sendDone(generationId, "suggested");
        return;
      }
    }

    const providedSugg = safeStr(working?.inputs?.sugg_prompt || working?.inputs?.suggPrompt, "");
    const suggPrompt = providedSugg || safeStr(working?.prompts?.sugg_prompt, "");

    let finalMotionPrompt = suggPrompt;

    if (!finalMotionPrompt) {
      const t2 = Date.now();
      const rdr = await gptMotionReader2({
        cfg,
        ctx,
        imageUrl: startImage,
        stillCrt,
        motionBrief,
        movementStyle,
      });

      await writeStep({
        supabase,
        generationId,
        passId,
        stepNo: stepNo++,
        stepType: "gpt_reader2_motion",
        payload: {
          ctx: ctx.motion_reader2,
          input: { start_image_url: startImage, still_crt: stillCrt, motion_user_brief: motionBrief, selected_movement_style: movementStyle },
          request: rdr.request,
          raw: rdr.raw,
          output: rdr,
          timing: { started_at: new Date(t2).toISOString(), ended_at: nowIso(), duration_ms: Date.now() - t2 },
          error: null,
        },
      });

      working.prompts = { ...(working.prompts || {}), motion_prompt: rdr.motion_prompt || "" };
      finalMotionPrompt = rdr.motion_prompt || "";

      working = pushUserMessageLine(working, rdr.userMessage || "Motion prompt ready 🎬");
      await updateVars({ supabase, generationId, vars: working });
      sendScanLine(generationId, lastScanLine(working, "Motion prompt ready 🎬"));
    } else {
      working.prompts = { ...(working.prompts || {}), motion_prompt: finalMotionPrompt };
      await updateVars({ supabase, generationId, vars: working });
    }

    if (!finalMotionPrompt) throw new Error("EMPTY_MOTION_PROMPT");

    await updateStatus({ supabase, generationId, status: "generating" });
    sendStatus(generationId, "generating");

    const duration =
      Number(working?.inputs?.duration ?? cfg?.kling?.duration ?? process.env.MMA_KLING_DURATION ?? 5) || 5;

    const mode =
      safeStr(working?.inputs?.kling_mode || working?.inputs?.mode, "") ||
      cfg?.kling?.mode ||
      process.env.MMA_KLING_MODE ||
      "standard";

    const neg =
      safeStr(working?.inputs?.negative_prompt || working?.inputs?.negativePrompt, "") ||
      cfg?.kling?.negativePrompt ||
      process.env.NEGATIVE_PROMPT_KLING ||
      process.env.MMA_NEGATIVE_PROMPT_KLING ||
      "";

    const t3 = Date.now();
    const gen = await runKling({
      prompt: finalMotionPrompt,
      startImage,
      duration,
      mode,
      negativePrompt: neg,
    });

    const remote = pickFirstUrl(gen.out);
    if (!remote) throw new Error("KLING_NO_URL");

    await writeStep({
      supabase,
      generationId,
      passId,
      stepNo: stepNo++,
      stepType: "kling_generate",
      payload: { input: gen.input, output: gen.out, timing: gen.timing, error: null, started_at: new Date(t3).toISOString() },
    });

    const remoteUrl = await storeRemoteToR2Public(remote, `mma/video/${generationId}`);
    working.outputs = { ...(working.outputs || {}), kling_video_url: remoteUrl };
    working.mg_output_url = remoteUrl;

    working = pushUserMessageLine(working, "Saved your video ✅");
    working.userMessages = { ...(working.userMessages || {}), final_line: "Finished animation." };
    await updateVars({ supabase, generationId, vars: working });
    sendScanLine(generationId, lastScanLine(working, "Saved your video ✅"));

    await finalizeGeneration({ supabase, generationId, url: remoteUrl, prompt: finalMotionPrompt });

    await updateStatus({ supabase, generationId, status: "done" });
    sendStatus(generationId, "done");
    sendDone(generationId, "done");
  } catch (err) {
    console.error("[mma] video animate pipeline error", err);

    await updateStatus({ supabase, generationId, status: "error" });
    await supabase
      .from("mega_generations")
      .update({
        mg_error: { code: "PIPELINE_ERROR", message: err?.message || String(err || "") },
        mg_updated_at: nowIso(),
      })
      .eq("mg_generation_id", generationId)
      .eq("mg_record_type", "generation");

    sendStatus(generationId, "error");
    sendDone(generationId, "error");
  }
}

// ============================================================================
// VIDEO (Kling) TWEAK PIPELINE
// ============================================================================
async function runVideoTweakPipeline({ supabase, generationId, passId, parent, vars }) {
  const cfg = getMmaConfig();
  if (!cfg.enabled) throw new Error("MMA_DISABLED");

  let working = vars;
  const ctx = await getMmaCtxConfig(supabase);
  working.ctx = { ...(working.ctx || {}), mma_ctx: ctx };
  working.scans = { ...(working.scans || {}) };

  let stepNo = 1;

  try {
    await updateStatus({ supabase, generationId, status: "scanning" });
    sendStatus(generationId, "scanning");

    const parentVars = parent?.mg_mma_vars && typeof parent.mg_mma_vars === "object" ? parent.mg_mma_vars : {};

    const startImage =
      asHttpUrl(working?.inputs?.start_image_url || working?.inputs?.startImageUrl) ||
      asHttpUrl(parentVars?.inputs?.start_image_url || parentVars?.inputs?.startImageUrl) ||
      asHttpUrl(parentVars?.inputs?.parent_output_url || parentVars?.inputs?.parentOutputUrl) ||
      asHttpUrl(parent?.mg_output_url) ||
      "";

    if (!startImage) throw new Error("MISSING_START_IMAGE_FOR_VIDEO_TWEAK");

    working.inputs = { ...(working.inputs || {}), start_image_url: startImage };

    let stillCrt =
      safeStr(parentVars?.scans?.still_crt, "") ||
      safeStr(parentVars?.still_crt, "") ||
      safeStr(working?.scans?.still_crt, "");

    working = pushUserMessageLine(working, "Re-reading your still before tweaking motion…");
    await updateVars({ supabase, generationId, vars: working });
    sendScanLine(generationId, lastScanLine(working, "Re-reading your still before tweaking motion…"));

    if (!stillCrt) {
      const t0 = Date.now();
      const scan = await gptScanOutputStill({ cfg, ctx, imageUrl: startImage });

      await writeStep({
        supabase,
        generationId,
        passId,
        stepNo: stepNo++,
        stepType: "gpt_scan_start_image",
        payload: {
          ctx: ctx.output_scan,
          input: { imageUrl: startImage },
          request: scan.request,
          raw: scan.raw,
          output: scan,
          timing: { started_at: new Date(t0).toISOString(), ended_at: nowIso(), duration_ms: Date.now() - t0 },
          error: null,
        },
      });

      stillCrt = scan.still_crt || "";
      working.scans.still_crt = stillCrt || null;

      working = pushUserMessageLine(working, scan.userMessage || "Still understood ✅");
      await updateVars({ supabase, generationId, vars: working });
      sendScanLine(generationId, lastScanLine(working, "Still understood ✅"));
    } else {
      working.scans.still_crt = stillCrt;
      await updateVars({ supabase, generationId, vars: working });
    }

    await updateStatus({ supabase, generationId, status: "prompting" });
    sendStatus(generationId, "prompting");

    const motionBrief =
      safeStr(working?.inputs?.motion_user_brief, "") ||
      safeStr(parentVars?.inputs?.motion_user_brief, "") ||
      safeStr(parentVars?.inputs?.motionBrief, "") ||
      safeStr(parentVars?.inputs?.brief, "");

    const movementStyle =
      safeStr(working?.inputs?.selected_movement_style, "") ||
      safeStr(parentVars?.inputs?.selected_movement_style, "") ||
      safeStr(parentVars?.inputs?.movement_style, "") ||
      safeStr(parentVars?.inputs?.movementStyle, "");

    const feedbackMotion =
      safeStr(working?.feedback?.motion_feedback, "") ||
      safeStr(working?.feedback?.feedback_motion, "") ||
      safeStr(working?.inputs?.feedback_motion, "") ||
      safeStr(working?.inputs?.feedback, "") ||
      safeStr(working?.inputs?.comment, "");

    if (!feedbackMotion) throw new Error("MISSING_MOTION_FEEDBACK");

    const baseInput = {
      start_image_url: startImage,
      still_crt: stillCrt,
      motion_user_brief: motionBrief,
      selected_movement_style: movementStyle,
    };

    const prevMotionPrompt =
      safeStr(parentVars?.prompts?.motion_prompt, "") ||
      safeStr(parent?.mg_prompt, "");

    const t1 = Date.now();
    const fix = await gptMotionFeedback2({
      cfg,
      ctx,
      imageUrl: startImage,
      baseInput,
      feedbackMotion,
      previousMotionPrompt: prevMotionPrompt,
    });

    await writeStep({
      supabase,
      generationId,
      passId,
      stepNo: stepNo++,
      stepType: "gpt_feedback2_motion",
      payload: {
        ctx: ctx.motion_feedback2,
        input: { ...baseInput, feedback_motion: feedbackMotion, previous_motion_prompt: prevMotionPrompt },
        request: fix.request,
        raw: fix.raw,
        output: fix,
        timing: { started_at: new Date(t1).toISOString(), ended_at: nowIso(), duration_ms: Date.now() - t1 },
        error: null,
      },
    });

    const finalMotionPrompt = safeStr(fix.motion_prompt, "");
    if (!finalMotionPrompt) throw new Error("EMPTY_MOTION_FEEDBACK_PROMPT");

    working.prompts = { ...(working.prompts || {}), motion_prompt: finalMotionPrompt };
    working = pushUserMessageLine(working, "Applying your motion feedback… 🎬✨");
    await updateVars({ supabase, generationId, vars: working });
    sendScanLine(generationId, lastScanLine(working, "Applying your motion feedback… 🎬✨"));

    await updateStatus({ supabase, generationId, status: "generating" });
    sendStatus(generationId, "generating");

    const duration =
      Number(working?.inputs?.duration ?? parentVars?.inputs?.duration ?? cfg?.kling?.duration ?? process.env.MMA_KLING_DURATION ?? 5) || 5;

    const mode =
      safeStr(working?.inputs?.kling_mode || working?.inputs?.mode, "") ||
      safeStr(parentVars?.inputs?.kling_mode || parentVars?.inputs?.mode, "") ||
      cfg?.kling?.mode ||
      process.env.MMA_KLING_MODE ||
      "standard";

    const neg =
      safeStr(working?.inputs?.negative_prompt || working?.inputs?.negativePrompt, "") ||
      safeStr(parentVars?.inputs?.negative_prompt || parentVars?.inputs?.negativePrompt, "") ||
      cfg?.kling?.negativePrompt ||
      process.env.NEGATIVE_PROMPT_KLING ||
      process.env.MMA_NEGATIVE_PROMPT_KLING ||
      "";

    const t2 = Date.now();
    const gen = await runKling({
      prompt: finalMotionPrompt,
      startImage,
      duration,
      mode,
      negativePrompt: neg,
    });

    const remote = pickFirstUrl(gen.out);
    if (!remote) throw new Error("KLING_NO_URL_TWEAK");

    await writeStep({
      supabase,
      generationId,
      passId,
      stepNo: stepNo++,
      stepType: "kling_generate_tweak",
      payload: { input: gen.input, output: gen.out, timing: gen.timing, error: null, started_at: new Date(t2).toISOString() },
    });

    const remoteUrl = await storeRemoteToR2Public(remote, `mma/video/${generationId}`);
    working.outputs = { ...(working.outputs || {}), kling_video_url: remoteUrl };
    working.mg_output_url = remoteUrl;

    working = pushUserMessageLine(working, "Saved your updated video ✅");
    working.userMessages = { ...(working.userMessages || {}), final_line: "Motion tweak finished." };
    await updateVars({ supabase, generationId, vars: working });
    sendScanLine(generationId, lastScanLine(working, "Saved your updated video ✅"));

    await finalizeGeneration({ supabase, generationId, url: remoteUrl, prompt: finalMotionPrompt });

    await updateStatus({ supabase, generationId, status: "done" });
    sendStatus(generationId, "done");
    sendDone(generationId, "done");
  } catch (err) {
    console.error("[mma] video tweak pipeline error", err);

    await updateStatus({ supabase, generationId, status: "error" });
    await supabase
      .from("mega_generations")
      .update({
        mg_error: { code: "PIPELINE_ERROR", message: err?.message || String(err || "") },
        mg_updated_at: nowIso(),
      })
      .eq("mg_generation_id", generationId)
      .eq("mg_record_type", "generation");

    sendStatus(generationId, "error");
    sendDone(generationId, "error");
  }
}

// ---------------------------
// Public controller API
// ---------------------------
export async function handleMmaStillTweak({ parentGenerationId, body }) {
  const supabase = getSupabaseAdmin();
  if (!supabase) throw new Error("SUPABASE_NOT_CONFIGURED");

  const parent = await fetchParentGenerationRow(supabase, parentGenerationId);
  if (!parent) throw new Error("PARENT_GENERATION_NOT_FOUND");

  const passId =
    body?.passId ||
    body?.pass_id ||
    parent?.mg_pass_id ||
    computePassId({
      shopifyCustomerId: body?.customer_id,
      userId: body?.user_id,
      email: body?.email,
    });

  const generationId = newUuid();

  await ensureCustomerRow(passId, {
    shopifyCustomerId: body?.customer_id,
    userId: body?.user_id,
    email: body?.email,
  });

  const vars = makeInitialVars({
    mode: "still",
    assets: body?.assets || {},
    history: body?.history || {},
    inputs: body?.inputs || {},
    settings: body?.settings || {},
    feedback: body?.feedback || {},
    prompts: body?.prompts || {},
  });

  vars.mg_pass_id = passId;
  vars.meta = { ...(vars.meta || {}), flow: "still_tweak", parent_generation_id: parentGenerationId };
  vars.inputs = { ...(vars.inputs || {}), parent_output_url: parent?.mg_output_url || null };

  await writeGeneration({
    supabase,
    generationId,
    parentId: parentGenerationId,
    passId,
    vars,
    mode: "still",
  });

  runStillTweakPipeline({ supabase, generationId, passId, parent, vars }).catch((e) =>
    console.error("[mma] still tweak pipeline error", e)
  );

  return { generation_id: generationId, status: "queued", sse_url: `/mma/stream/${generationId}` };
}

export async function handleMmaVideoTweak({ parentGenerationId, body }) {
  const supabase = getSupabaseAdmin();
  if (!supabase) throw new Error("SUPABASE_NOT_CONFIGURED");

  const parent = await fetchParentGenerationRow(supabase, parentGenerationId);
  if (!parent) throw new Error("PARENT_GENERATION_NOT_FOUND");

  const passId =
    body?.passId ||
    body?.pass_id ||
    parent?.mg_pass_id ||
    computePassId({
      shopifyCustomerId: body?.customer_id,
      userId: body?.user_id,
      email: body?.email,
    });

  const generationId = newUuid();

  await ensureCustomerRow(passId, {
    shopifyCustomerId: body?.customer_id,
    userId: body?.user_id,
    email: body?.email,
  });

  const vars = makeInitialVars({
    mode: "video",
    assets: body?.assets || {},
    history: body?.history || {},
    inputs: body?.inputs || {},
    settings: body?.settings || {},
    feedback: body?.feedback || {},
    prompts: body?.prompts || {},
  });

  vars.mg_pass_id = passId;
  vars.meta = { ...(vars.meta || {}), flow: "video_tweak", parent_generation_id: parentGenerationId };
  vars.inputs = { ...(vars.inputs || {}), parent_generation_id: parentGenerationId };

  // inherit start still if parent had it
  const parentVars = parent?.mg_mma_vars && typeof parent.mg_mma_vars === "object" ? parent.mg_mma_vars : {};
  const parentStart =
    asHttpUrl(parentVars?.inputs?.start_image_url || parentVars?.inputs?.startImageUrl) ||
    asHttpUrl(parentVars?.inputs?.parent_output_url || parentVars?.inputs?.parentOutputUrl) ||
    "";
  if (parentStart) vars.inputs.start_image_url = parentStart;

  await writeGeneration({
    supabase,
    generationId,
    parentId: parentGenerationId,
    passId,
    vars,
    mode: "video",
  });

  runVideoTweakPipeline({ supabase, generationId, passId, parent, vars }).catch((err) =>
    console.error("[mma] video tweak pipeline error", err)
  );

  return { generation_id: generationId, status: "queued", sse_url: `/mma/stream/${generationId}` };
}

export async function handleMmaCreate({ mode, body }) {
  const supabase = getSupabaseAdmin();
  if (!supabase) throw new Error("SUPABASE_NOT_CONFIGURED");

  const passId =
    body?.passId ||
    body?.pass_id ||
    computePassId({
      shopifyCustomerId: body?.customer_id,
      userId: body?.user_id,
      email: body?.email,
    });

  const parentId =
    body?.parent_generation_id ||
    body?.parentGenerationId ||
    body?.generation_id ||
    null;

  const generationId = newUuid();

  await ensureCustomerRow(passId, {
    shopifyCustomerId: body?.customer_id,
    userId: body?.user_id,
    email: body?.email,
  });

  const vars = makeInitialVars({
    mode,
    assets: body?.assets || {},
    history: body?.history || {},
    inputs: body?.inputs || {},
    settings: body?.settings || {},
    feedback: body?.feedback || {},
    prompts: body?.prompts || {},
  });

  vars.mg_pass_id = passId;

  await writeGeneration({ supabase, generationId, parentId, passId, vars, mode });

  if (mode === "still") {
    runStillCreatePipeline({ supabase, generationId, passId, vars }).catch((err) =>
      console.error("[mma] still create pipeline error", err)
    );
  } else if (mode === "video") {
    const parent = parentId ? await fetchParentGenerationRow(supabase, parentId) : null;

    if (parent?.mg_output_url) {
      vars.inputs = { ...(vars.inputs || {}), parent_output_url: parent.mg_output_url };
      vars.meta = { ...(vars.meta || {}), flow: "video_animate", parent_generation_id: parentId };
      await updateVars({ supabase, generationId, vars });
    } else {
      vars.meta = { ...(vars.meta || {}), flow: "video_animate" };
      await updateVars({ supabase, generationId, vars });
    }

    runVideoAnimatePipeline({ supabase, generationId, passId, parent, vars }).catch((err) =>
      console.error("[mma] video animate pipeline error", err)
    );
  } else {
    await updateStatus({ supabase, generationId, status: "error" });
    await supabase
      .from("mega_generations")
      .update({
        mg_error: { code: "BAD_MODE", message: `Unsupported mode: ${mode}` },
        mg_updated_at: nowIso(),
      })
      .eq("mg_generation_id", generationId)
      .eq("mg_record_type", "generation");
  }

  return { generation_id: generationId, status: "queued", sse_url: `/mma/stream/${generationId}` };
}

export async function handleMmaEvent(body) {
  const supabase = getSupabaseAdmin();
  if (!supabase) throw new Error("SUPABASE_NOT_CONFIGURED");

  const passId =
    body?.passId ||
    body?.pass_id ||
    computePassId({
      shopifyCustomerId: body?.customer_id,
      userId: body?.user_id,
      email: body?.email,
    });

  await ensureCustomerRow(passId, {
    shopifyCustomerId: body?.customer_id,
    userId: body?.user_id,
    email: body?.email,
  });

  const eventId = newUuid();
  const identifiers = eventIdentifiers(eventId);

  await supabase.from("mega_generations").insert({
    ...identifiers,
    mg_generation_id: body?.generation_id || null,
    mg_pass_id: passId,
    mg_parent_id: body?.generation_id ? `generation:${body.generation_id}` : null,
    mg_meta: { event_type: body?.event_type || "unknown", payload: body?.payload || {} },
    mg_created_at: nowIso(),
    mg_updated_at: nowIso(),
  });

  // keep existing preference-write logic
  if (body?.event_type === "like" || body?.event_type === "dislike" || body?.event_type === "preference_set") {
    const { data } = await supabase
      .from("mega_customers")
      .select("mg_mma_preferences")
      .eq("mg_pass_id", passId)
      .maybeSingle();

    const prefs = data?.mg_mma_preferences || {};
    const hardBlocks = new Set(Array.isArray(prefs.hard_blocks) ? prefs.hard_blocks : []);
    const tagWeights = { ...(prefs.tag_weights || {}) };

    if (body?.payload?.hard_block) {
      hardBlocks.add(body.payload.hard_block);
      tagWeights[body.payload.hard_block] = -999;
    }

    await supabase
      .from("mega_customers")
      .update({
        mg_mma_preferences: { ...prefs, hard_blocks: Array.from(hardBlocks), tag_weights: tagWeights },
        mg_mma_preferences_updated_at: nowIso(),
        mg_updated_at: nowIso(),
      })
      .eq("mg_pass_id", passId);
  }

  return { event_id: eventId, status: "ok" };
}

export async function fetchGeneration(generationId) {
  const supabase = getSupabaseAdmin();
  if (!supabase) throw new Error("SUPABASE_NOT_CONFIGURED");

  const { data, error } = await supabase
    .from("mega_generations")
    .select("mg_generation_id, mg_mma_status, mg_status, mg_mma_vars, mg_output_url, mg_prompt, mg_error, mg_mma_mode")
    .eq("mg_generation_id", generationId)
    .eq("mg_record_type", "generation")
    .maybeSingle();

  if (error) throw error;
  if (!data) return null;

  return {
    generation_id: data.mg_generation_id,
    status: data.mg_mma_status || data.mg_status,
    mma_vars: data.mg_mma_vars || {},
    outputs: {
      seedream_image_url: data.mg_mma_mode === "still" ? data.mg_output_url : null,
      kling_video_url: data.mg_mma_mode === "video" ? data.mg_output_url : null,
    },
    prompt: data.mg_prompt || null,
    error: data.mg_error || null,
  };
}

export async function listSteps(generationId) {
  const supabase = getSupabaseAdmin();
  if (!supabase) throw new Error("SUPABASE_NOT_CONFIGURED");

  const { data, error } = await supabase
    .from("mega_generations")
    .select("*")
    .eq("mg_generation_id", generationId)
    .eq("mg_record_type", "mma_step")
    .order("mg_step_no", { ascending: true });

  if (error) throw error;
  return data || [];
}

export async function listErrors() {
  const supabase = getSupabaseAdmin();
  if (!supabase) throw new Error("SUPABASE_NOT_CONFIGURED");

  const { data, error } = await supabase
    .from("mega_admin")
    .select("*")
    .eq("mg_record_type", "error")
    .order("mg_created_at", { ascending: false })
    .limit(50);

  if (error) throw error;
  return data || [];
}

export function registerSseClient(generationId, res, initial) {
  addSseClient(generationId, res, initial);
}

// -----------------------------------------------------------------------------
// Factory expected by server boot
// -----------------------------------------------------------------------------
export function createMmaController() {
  const router = express.Router();

  router.post("/still/create", async (req, res) => {
    try {
      const result = await handleMmaCreate({ mode: "still", body: req.body });
      res.json(result);
    } catch (err) {
      console.error("[mma] still/create error", err);
      res.status(err?.statusCode || 500).json({ error: "MMA_CREATE_FAILED", message: err?.message });
    }
  });

  router.post("/still/:generation_id/tweak", async (req, res) => {
    try {
      const result = await handleMmaStillTweak({
        parentGenerationId: req.params.generation_id,
        body: req.body || {},
      });
      res.json(result);
    } catch (err) {
      console.error("[mma] still tweak error", err);
      res.status(err?.statusCode || 500).json({ error: "MMA_TWEAK_FAILED", message: err?.message });
    }
  });

  router.post("/video/animate", async (req, res) => {
    try {
      const result = await handleMmaCreate({ mode: "video", body: req.body });
      res.json(result);
    } catch (err) {
      console.error("[mma] video/animate error", err);
      res.status(err?.statusCode || 500).json({ error: "MMA_ANIMATE_FAILED", message: err?.message });
    }
  });

  router.post("/video/:generation_id/tweak", async (req, res) => {
    try {
      const result = await handleMmaVideoTweak({
        parentGenerationId: req.params.generation_id,
        body: req.body || {},
      });
      res.json(result);
    } catch (err) {
      console.error("[mma] video tweak error", err);
      res.status(err?.statusCode || 500).json({ error: "MMA_VIDEO_TWEAK_FAILED", message: err?.message });
    }
  });

  router.post("/events", async (req, res) => {
    try {
      const result = await handleMmaEvent(req.body || {});
      res.json(result);
    } catch (err) {
      console.error("[mma] events error", err);
      res.status(500).json({ error: "MMA_EVENT_FAILED", message: err?.message });
    }
  });

  router.get("/generations/:generation_id", async (req, res) => {
    try {
      const payload = await fetchGeneration(req.params.generation_id);
      if (!payload) return res.status(404).json({ error: "NOT_FOUND" });
      res.json(payload);
    } catch (err) {
      console.error("[mma] fetch generation error", err);
      res.status(500).json({ error: "MMA_FETCH_FAILED", message: err?.message });
    }
  });

  router.get("/stream/:generation_id", async (req, res) => {
    const supabase = getSupabaseAdmin();
    if (!supabase) return res.status(500).end();

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      Connection: "keep-alive",
      "Cache-Control": "no-cache",
    });
    res.flushHeaders?.();

    const { data } = await supabase
      .from("mega_generations")
      .select("mg_mma_vars, mg_mma_status")
      .eq("mg_generation_id", req.params.generation_id)
      .eq("mg_record_type", "generation")
      .maybeSingle();

    const scanLines = data?.mg_mma_vars?.userMessages?.scan_lines || [];
    const status = data?.mg_mma_status || "queued";

    const keepAlive = setInterval(() => {
      try {
        res.write(`:keepalive\n\n`);
      } catch {}
    }, 25000);

    res.on("close", () => clearInterval(keepAlive));
    registerSseClient(req.params.generation_id, res, { scanLines, status });
  });

  router.get("/admin/mma/errors", async (_req, res) => {
    try {
      const errors = await listErrors();
      res.json({ errors });
    } catch (err) {
      res.status(500).json({ error: "MMA_ADMIN_ERRORS", message: err?.message });
    }
  });

  router.get("/admin/mma/steps/:generation_id", async (req, res) => {
    try {
      const steps = await listSteps(req.params.generation_id);
      res.json({ steps });
    } catch (err) {
      res.status(500).json({ error: "MMA_ADMIN_STEPS", message: err?.message });
    }
  });

  return router;
}

export default createMmaController;
