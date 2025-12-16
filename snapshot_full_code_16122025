/my code has been taking by so many developers and the databse looks meessy i want to clean it up and not change names that might the front use it but i want to have. only supabase 1 -  Admin table 2- Customers 3- Generations try to squeez everything in three major tables that has many columns and that uses only one Customer ID or we can call it Pass ID this will have every information about the user every history every thing should be tied to this PassID and we add toggle verified or not which means got email verficiation or google or apple login verification should be different from any other imput more like a keynumber created for the customer so we can actually retieve all his data and genreations later in his profile and use r2 links that never fade and you should know that the app uses shopify as topup credit and set top up credit to per default to 3 and yes we need clean database supabase only no other bullshit if you find try to migrate and put in admin table ok am starting to share with you the backend end code inlcuding login and // server.js (Supabase-first, no Prisma)
// Mina Editorial AI API
"use strict";

import "dotenv/config";
import express from "express";
import cors from "cors";
import Replicate from "replicate";
import OpenAI from "openai";
import { v4 as uuidv4 } from "uuid";
import crypto from "node:crypto";
import multer from "multer";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { createClient } from "@supabase/supabase-js";

import { parseDataUrl } from "./r2.js";

import { logAdminAction, upsertGenerationRow, upsertSessionRow } from "./supabase.js";
import { requireAdmin } from "./auth.js";

const app = express();
const PORT = process.env.PORT || 3000;
const MINA_BASELINE_USERS = 3651; // offset we add on top of DB users

// ======================================================
// Supabase (service role) — used for business persistence
// Tables (per your schema visualizer):
// - customers (shopify_customer_id PK)
// - credit_transactions (id uuid PK)
// - sessions (id uuid PK)
// - generations (id text PK)
// - feedback (id uuid PK)
// ======================================================
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

const supabaseAdmin =
  SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
    ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
        auth: { persistSession: false, autoRefreshToken: false },
      })
    : null;

function sbEnabled() {
  return !!supabaseAdmin;
}

function nowIso() {
  return new Date().toISOString();
}

function safeString(value, fallback = "") {
  if (value === null || value === undefined) return fallback;
  if (typeof value !== "string") return String(value);
  const trimmed = value.trim();
  return trimmed.length ? trimmed : fallback;
}

function safeShopifyId(customerIdRaw) {
  const v = customerIdRaw === null || customerIdRaw === undefined ? "" : String(customerIdRaw);
  return v.trim() || "anonymous";
}

function isUuid(v) {
  return typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
}

// Accept old clients sending "sess_<uuid>" and normalize to uuid
function normalizeSessionUuid(sessionIdRaw) {
  const s = safeString(sessionIdRaw || "");
  if (!s) return "";
  if (s.startsWith("sess_")) {
    const maybe = s.slice("sess_".length);
    return isUuid(maybe) ? maybe : s;
  }
  return s;
}

function isHttpUrl(u) {
  try {
    const url = new URL(String(u));
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

// ======================================================
// R2 setup (Cloudflare R2 = S3 compatible)
// ======================================================
const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID;
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
const R2_BUCKET = process.env.R2_BUCKET;

// Optional override, otherwise computed from account id
const R2_ENDPOINT =
  process.env.R2_ENDPOINT || `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;

const r2 = new S3Client({
  region: "auto",
  endpoint: R2_ENDPOINT,
  credentials: {
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY,
  },
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB
});

function safeName(name = "file") {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function safeFolderName(name = "uploads") {
  return String(name).replace(/[^a-zA-Z0-9/_-]/g, "_");
}

function guessExtFromContentType(contentType = "") {
  const ct = String(contentType).toLowerCase();
  if (ct.includes("png")) return "png";
  if (ct.includes("jpeg") || ct.includes("jpg")) return "jpg";
  if (ct.includes("webp")) return "webp";
  if (ct.includes("gif")) return "gif";
  if (ct.includes("mp4")) return "mp4";
  return "";
}
// =======================
// GPT I/O capture helpers (store what we send to OpenAI + what we get back)
// =======================
function truncateStr(s, max = 4000) {
  if (typeof s !== "string") return "";
  if (s.length <= max) return s;
  return s.slice(0, max) + `…[truncated ${s.length - max} chars]`;
}

// userContent is sometimes a string, sometimes an array of {type:"text"} + {type:"image_url"}
function summarizeUserContent(userContent) {
  if (typeof userContent === "string") {
    return { userText: truncateStr(userContent, 6000), imageUrls: [], imagesCount: 0 };
  }

  const parts = Array.isArray(userContent) ? userContent : [];
  const texts = [];
  const imageUrls = [];

  for (const p of parts) {
    if (!p || typeof p !== "object") continue;
    if (p.type === "text" && typeof p.text === "string") texts.push(p.text);
    if (p.type === "image_url" && p.image_url && typeof p.image_url.url === "string") {
      imageUrls.push(p.image_url.url);
    }
  }

  return {
    userText: truncateStr(texts.join("\n\n"), 6000),
    imageUrls: imageUrls.slice(0, 8), // keep it small
    imagesCount: imageUrls.length,
  };
}

function makeGptIOInput({ model, systemMessage, userContent, temperature, maxTokens }) {
  const sys = typeof systemMessage?.content === "string" ? systemMessage.content : "";
  const { userText, imageUrls, imagesCount } = summarizeUserContent(userContent);

  return {
    model: model || null,
    temperature: typeof temperature === "number" ? temperature : null,
    maxTokens: typeof maxTokens === "number" ? maxTokens : null,
    system: truncateStr(sys, 6000),
    userText,
    imageUrls,
    imagesCount,
  };
}

// =======================
// R2 PUBLIC (non-expiring) helpers
// =======================
const R2_PUBLIC_BASE_URL = (process.env.R2_PUBLIC_BASE_URL || "").replace(/\/+$/, ""); // e.g. https://assets.faltastudio.com

if (process.env.NODE_ENV === "production" && !R2_PUBLIC_BASE_URL) {
  throw new Error(
    "R2_PUBLIC_BASE_URL is REQUIRED in production so asset URLs are permanent (non-expiring)."
  );
}

function encodeKeyForUrl(key) {
  return String(key || "")
    .split("/")
    .map((p) => encodeURIComponent(p))
    .join("/");
}

function r2PublicUrlForKeyLocal(key) {
  if (!key) return "";
  if (R2_PUBLIC_BASE_URL) return `${R2_PUBLIC_BASE_URL}/${encodeKeyForUrl(key)}`;

  // Fallback works only if your bucket is publicly accessible on the default endpoint
  if (R2_ACCOUNT_ID && R2_BUCKET) {
    return `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${R2_BUCKET}/${encodeKeyForUrl(key)}`;
  }
  return "";
}

function isOurAssetUrl(u) {
  try {
    const url = new URL(String(u));
    const host = url.hostname.toLowerCase();

    if (R2_PUBLIC_BASE_URL) {
      const baseHost = new URL(R2_PUBLIC_BASE_URL).hostname.toLowerCase();
      if (host === baseHost) return true;
    }

    if (host.endsWith("r2.cloudflarestorage.com")) return true;
    return false;
  } catch {
    return false;
  }
}

async function r2PutPublic({ key, body, contentType }) {
  await r2.send(
    new PutObjectCommand({
      Bucket: R2_BUCKET,
      Key: key,
      Body: body,
      ContentType: contentType || "application/octet-stream",
      CacheControl: "public, max-age=31536000, immutable",
    })
  );

  const publicUrl = r2PublicUrlForKeyLocal(key);
  if (!publicUrl) {
    throw new Error(
      "Missing R2_PUBLIC_BASE_URL. Set it to your public R2 domain so URLs never expire."
    );
  }

  return { key, publicUrl };
}

async function storeRemoteToR2Public({ remoteUrl, kind = "generations", customerId = "anon" }) {
  const resp = await fetch(remoteUrl);
  if (!resp.ok) throw new Error(`REMOTE_FETCH_FAILED (${resp.status})`);

  const contentType = resp.headers.get("content-type") || "application/octet-stream";
  const arrayBuf = await resp.arrayBuffer();
  const buf = Buffer.from(arrayBuf);

  const folder = safeFolderName(kind);
  const cid = String(customerId || "anon");
  const uuid = crypto.randomUUID();
  const extGuess = guessExtFromContentType(contentType);
  const key = `${folder}/${cid}/${Date.now()}-${uuid}${extGuess ? `.${extGuess}` : ""}`;

  return r2PutPublic({ key, body: buf, contentType });
}

function getRequestMeta(req) {
  return {
    ip: req.ip,
    userAgent: req.get("user-agent"),
    route: req.path,
    method: req.method,
  };
}
// ======================================================
// Runtime Config (stored in Supabase, applied live)
// ======================================================

// ✅ Base GPT system prompts (your current hardcoded text) — used as DEFAULTS
const BASE_GPT_SYSTEM_EDITORIAL =
  "You are Mina, an editorial art director for fashion & beauty." +
  " You will see one product image, an optional logo, and up to several style reference images." +
  " You write ONE clear prompt for a generative image model." +
  " Describe the product and place the logo if it is added, in environment, lighting, camera, mood, and style inspired from the inspiration and style chosen." +
  " Do NOT include line breaks, lists, or bullet points only the prompt directly. One paragraph max." +
  " After the prompt, return JSON with two fields: 'imageTexts' (array of captions for each image uploaded)" +
  " and 'userMessage' (this usermessage is to talk about the product, the images, the process that mina is doing to connect all the ideas together and setting camera and light and must be user friendly easy english we will animate this as mina chatting with user while he is waiting, you can also put quotes motivation self estem boosting sentences so they bond with mina and also some hold on a bit it is going too long because I want to drink my matchas slowly things AI might say to somehow explain why it is taking so much).";

const BASE_GPT_SYSTEM_MOTION_PROMPT =
  "You are Mina, an editorial motion director for fashion & beauty. " +
  "You will see a reference still frame. " +
  "You describe a SHORT looping scene motion for a generative video model. " +
  "Keep it 1–2 sentences, no line breaks, easy english and describe scene compostion and how they move";

const BASE_GPT_SYSTEM_MOTION_SUGGEST =
  "You are Mina, an editorial motion director for luxury still-life. " +
  "Given images + style preferences, propose ONE short motion idea the user will see in a textarea, easy english and describe scene compostion and how they move\n\n" +
  "Constraints:\n" +
  "- Return exactly ONE sentence, no bullet points, no quotes\n" +
  "- Max ~220 characters.\n" +
  "- Do NOT mention 'TikTok' or 'platform', just describe the motion, in easy english, and clear scene composition.\n\n" +
  "If the user already wrote a draft, improve it while keeping the same intent.";

const DEFAULT_RUNTIME_CONFIG = {
  models: {
    seadream: process.env.SEADREAM_MODEL_VERSION || "bytedance/seedream-4",
    kling: process.env.KLING_MODEL_VERSION || "kwaivgi/kling-v2.1",
    gpt: "gpt-4.1-mini",
  },
  credits: {
    imageCost: Number(process.env.IMAGE_CREDITS_COST || 1),
    motionCost: Number(process.env.MOTION_CREDITS_COST || 5),
  },
  replicate: {
    seadream: {
      size: "4K",
      enhance_prompt: false,
      sequential_image_generation: "disabled",
    },
    kling: {
      mode: "pro",
      negative_prompt: "plastic look, waxy, overly smooth, airbrushed, texture loss, no texture, material loss, flat materials, rubbery, fake fabric, smeared details, muddy details, low detail, blurry, lowres, compression artifacts, blocky, banding, noise, grain, flicker, jitter, warping, wobble, ghosting, temporal inconsistency, lighting change, relighting, exposure change, brightness change, contrast change, gamma shift, shadows changing, highlights changing, white balance shift, color shift, saturation shift, overexposed, underexposed, crushed blacks, clipped highlights, AI artifacts",
    },
  },
  gpt: {
    editorial: {
      temperature: 0.8,
      max_tokens: 420,

      // ✅ You will SEE this text in dashboard (default = your hardcoded prompt)
      system_text: BASE_GPT_SYSTEM_EDITORIAL,

      // ✅ safe extra text appended to the user message (optional)
      user_extra: "",
    },
    motion_prompt: {
      temperature: 0.8,
      max_tokens: 280,
      system_text: BASE_GPT_SYSTEM_MOTION_PROMPT,
      user_extra: "",
    },
    motion_suggest: {
      temperature: 0.8,
      max_tokens: 260,
      system_text: BASE_GPT_SYSTEM_MOTION_SUGGEST,
      user_extra: "",
    },
  },
};

// Simple deep merge (no deps)
function deepMerge(base, override) {
  if (!override || typeof override !== "object") return base;
  const out = Array.isArray(base) ? [...base] : { ...(base || {}) };

  for (const [k, v] of Object.entries(override)) {
    if (
      v &&
      typeof v === "object" &&
      !Array.isArray(v) &&
      base &&
      typeof base[k] === "object" &&
      !Array.isArray(base[k])
    ) {
      out[k] = deepMerge(base[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

// setDeep(obj, "a.b.c", value)
function setDeep(obj, path, value) {
  const parts = String(path || "").split(".").filter(Boolean);
  if (!parts.length) return obj;
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i];
    if (!cur[p] || typeof cur[p] !== "object") cur[p] = {};
    cur = cur[p];
  }
  cur[parts[parts.length - 1]] = value;
  return obj;
}

// unsetDeep(obj, "a.b.c")  -> deletes that key from the override object
function unsetDeep(obj, path) {
  const parts = String(path || "").split(".").filter(Boolean);
  if (!parts.length) return obj;
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i];
    if (!cur[p] || typeof cur[p] !== "object") return obj;
    cur = cur[p];
  }
  const last = parts[parts.length - 1];
  if (cur && typeof cur === "object") delete cur[last];
  return obj;
}

// Optional: guardrails so dashboard can’t break prod easily
function normalizeRuntimeConfig(cfg) {
  const safe = deepMerge(DEFAULT_RUNTIME_CONFIG, cfg || {});

  const clamp = (n, a, b, fallback) =>
    Number.isFinite(Number(n)) ? Math.max(a, Math.min(b, Number(n))) : fallback;

  safe.credits.imageCost = clamp(
    safe.credits.imageCost,
    0,
    100,
    DEFAULT_RUNTIME_CONFIG.credits.imageCost
  );
  safe.credits.motionCost = clamp(
    safe.credits.motionCost,
    0,
    100,
    DEFAULT_RUNTIME_CONFIG.credits.motionCost
  );

  safe.gpt.editorial.temperature = clamp(
    safe.gpt.editorial.temperature,
    0,
    2,
    DEFAULT_RUNTIME_CONFIG.gpt.editorial.temperature
  );
  safe.gpt.motion_prompt.temperature = clamp(
    safe.gpt.motion_prompt.temperature,
    0,
    2,
    DEFAULT_RUNTIME_CONFIG.gpt.motion_prompt.temperature
  );
  safe.gpt.motion_suggest.temperature = clamp(
    safe.gpt.motion_suggest.temperature,
    0,
    2,
    DEFAULT_RUNTIME_CONFIG.gpt.motion_suggest.temperature
  );

  safe.gpt.editorial.max_tokens = clamp(
    safe.gpt.editorial.max_tokens,
    50,
    2000,
    DEFAULT_RUNTIME_CONFIG.gpt.editorial.max_tokens
  );
  safe.gpt.motion_prompt.max_tokens = clamp(
    safe.gpt.motion_prompt.max_tokens,
    50,
    2000,
    DEFAULT_RUNTIME_CONFIG.gpt.motion_prompt.max_tokens
  );
  safe.gpt.motion_suggest.max_tokens = clamp(
    safe.gpt.motion_suggest.max_tokens,
    50,
    2000,
    DEFAULT_RUNTIME_CONFIG.gpt.motion_suggest.max_tokens
  );

  // ensure strings
  safe.gpt.editorial.system_text = safeString(
    safe.gpt.editorial.system_text,
    BASE_GPT_SYSTEM_EDITORIAL
  );
  safe.gpt.editorial.user_extra = safeString(safe.gpt.editorial.user_extra, "");

  safe.gpt.motion_prompt.system_text = safeString(
    safe.gpt.motion_prompt.system_text,
    BASE_GPT_SYSTEM_MOTION_PROMPT
  );
  safe.gpt.motion_prompt.user_extra = safeString(safe.gpt.motion_prompt.user_extra, "");

  safe.gpt.motion_suggest.system_text = safeString(
    safe.gpt.motion_suggest.system_text,
    BASE_GPT_SYSTEM_MOTION_SUGGEST
  );
  safe.gpt.motion_suggest.user_extra = safeString(safe.gpt.motion_suggest.user_extra, "");

  return safe;
}

async function sbGetRuntimeRow() {
  if (!supabaseAdmin) return null;

  const { data, error } = await supabaseAdmin
    .from("runtime_config")
    .select("*")
    .eq("id", 1)
    .maybeSingle();

  if (error) throw error;
  return data || null;
}

async function sbPatchRuntimeRow(patch, updatedBy = null) {
  if (!supabaseAdmin) throw new Error("Supabase not configured");

  const payload = {
    id: 1,
    ...(patch || {}),
    updated_by: updatedBy ? String(updatedBy) : null,
    // updated_at handled by trigger
  };

  const { error } = await supabaseAdmin
    .from("runtime_config")
    .upsert(payload, { onConflict: "id" });

  if (error) throw error;
}

// Convert DB row (flat columns) -> override object (nested)
function runtimeRowToOverride(row) {
  const o = {};
  if (!row) return o;

  // Models
  if (row.seadream_model) setDeep(o, "models.seadream", row.seadream_model);
  if (row.kling_model) setDeep(o, "models.kling", row.kling_model);
  if (row.gpt_model) setDeep(o, "models.gpt", row.gpt_model);

  // Credits
  if (row.image_cost !== null && row.image_cost !== undefined)
    setDeep(o, "credits.imageCost", row.image_cost);
  if (row.motion_cost !== null && row.motion_cost !== undefined)
    setDeep(o, "credits.motionCost", row.motion_cost);

  // Replicate: SeaDream
  if (row.seadream_size) setDeep(o, "replicate.seadream.size", row.seadream_size);
  if (row.seadream_enhance_prompt !== null && row.seadream_enhance_prompt !== undefined)
    setDeep(o, "replicate.seadream.enhance_prompt", row.seadream_enhance_prompt);
  if (row.seadream_sequential_image_generation)
    setDeep(o, "replicate.seadream.sequential_image_generation", row.seadream_sequential_image_generation);

  // Replicate: Kling
  if (row.kling_mode) setDeep(o, "replicate.kling.mode", row.kling_mode);
  if (row.kling_negative_prompt !== null && row.kling_negative_prompt !== undefined)
    setDeep(o, "replicate.kling.negative_prompt", row.kling_negative_prompt);

  // GPT editorial
  if (row.gpt_editorial_temperature !== null && row.gpt_editorial_temperature !== undefined)
    setDeep(o, "gpt.editorial.temperature", row.gpt_editorial_temperature);
  if (row.gpt_editorial_max_tokens !== null && row.gpt_editorial_max_tokens !== undefined)
    setDeep(o, "gpt.editorial.max_tokens", row.gpt_editorial_max_tokens);
  if (row.gpt_editorial_system_text !== null && row.gpt_editorial_system_text !== undefined)
    setDeep(o, "gpt.editorial.system_text", row.gpt_editorial_system_text);
  if (row.gpt_editorial_user_extra !== null && row.gpt_editorial_user_extra !== undefined)
    setDeep(o, "gpt.editorial.user_extra", row.gpt_editorial_user_extra);

  // GPT motion_prompt
  if (row.gpt_motion_prompt_temperature !== null && row.gpt_motion_prompt_temperature !== undefined)
    setDeep(o, "gpt.motion_prompt.temperature", row.gpt_motion_prompt_temperature);
  if (row.gpt_motion_prompt_max_tokens !== null && row.gpt_motion_prompt_max_tokens !== undefined)
    setDeep(o, "gpt.motion_prompt.max_tokens", row.gpt_motion_prompt_max_tokens);
  if (row.gpt_motion_prompt_system_text !== null && row.gpt_motion_prompt_system_text !== undefined)
    setDeep(o, "gpt.motion_prompt.system_text", row.gpt_motion_prompt_system_text);
  if (row.gpt_motion_prompt_user_extra !== null && row.gpt_motion_prompt_user_extra !== undefined)
    setDeep(o, "gpt.motion_prompt.user_extra", row.gpt_motion_prompt_user_extra);

  // GPT motion_suggest
  if (row.gpt_motion_suggest_temperature !== null && row.gpt_motion_suggest_temperature !== undefined)
    setDeep(o, "gpt.motion_suggest.temperature", row.gpt_motion_suggest_temperature);
  if (row.gpt_motion_suggest_max_tokens !== null && row.gpt_motion_suggest_max_tokens !== undefined)
    setDeep(o, "gpt.motion_suggest.max_tokens", row.gpt_motion_suggest_max_tokens);
  if (row.gpt_motion_suggest_system_text !== null && row.gpt_motion_suggest_system_text !== undefined)
    setDeep(o, "gpt.motion_suggest.system_text", row.gpt_motion_suggest_system_text);
  if (row.gpt_motion_suggest_user_extra !== null && row.gpt_motion_suggest_user_extra !== undefined)
    setDeep(o, "gpt.motion_suggest.user_extra", row.gpt_motion_suggest_user_extra);

  return o;
}


async function sbSetRuntimeOverride(nextOverride, updatedBy = null) {
  if (!supabaseAdmin) throw new Error("Supabase not configured");
  const payload = {
    key: "runtime",
    value: nextOverride || {},
    updated_at: nowIso(),
    updated_by: updatedBy ? String(updatedBy) : null,
  };
  const { error } = await supabaseAdmin
    .from("app_config")
    .upsert(payload, { onConflict: "key" });
  if (error) throw error;
}

// In-memory cache so we don’t hit DB every request
const runtimeConfigCache = {
  effective: normalizeRuntimeConfig(null),
  override: {},
  updatedAt: null,
  fetchedAt: 0,
};

const RUNTIME_CONFIG_TTL_MS = Number(process.env.RUNTIME_CONFIG_TTL_MS || 5000);

async function getRuntimeConfig() {
  if (!sbEnabled()) return runtimeConfigCache.effective;

  const now = Date.now();
  if (now - runtimeConfigCache.fetchedAt < RUNTIME_CONFIG_TTL_MS) {
    return runtimeConfigCache.effective;
  }

   const row = await sbGetRuntimeRow();
  const override = runtimeRowToOverride(row);
  const effective = normalizeRuntimeConfig(override);

  runtimeConfigCache.effective = effective;
  runtimeConfigCache.override = override;
  runtimeConfigCache.updatedAt = row?.updated_at || null;
  runtimeConfigCache.fetchedAt = now;


  return effective;
}

// For dashboard “what does this field do?”
const RUNTIME_CONFIG_SCHEMA = [
  { path: "models.seadream", type: "string", description: "Replicate model/version for image generation (SeaDream)." },
  { path: "models.kling", type: "string", description: "Replicate model/version for video generation (Kling)." },
  { path: "models.gpt", type: "string", description: "OpenAI model used for prompt writing & suggestion." },

  { path: "credits.imageCost", type: "number", description: "Credits spent per image generation." },
  { path: "credits.motionCost", type: "number", description: "Credits spent per motion generation." },

  { path: "replicate.seadream.size", type: "string", description: "SeaDream output size (ex: 2K)." },
  { path: "replicate.seadream.enhance_prompt", type: "boolean", description: "SeaDream enhance_prompt flag." },
  { path: "replicate.seadream.sequential_image_generation", type: "string", description: "SeaDream sequential generation mode." },

  { path: "replicate.kling.mode", type: "string", description: "Kling mode (pro, etc.)." },
  { path: "replicate.kling.negative_prompt", type: "string", description: "Kling negative prompt." },

  { path: "gpt.editorial.temperature", type: "number", description: "GPT temperature for editorial prompt writing." },
  { path: "gpt.editorial.max_tokens", type: "number", description: "GPT max_tokens for editorial prompt writing." },
  { path: "gpt.editorial.system_text", type: "string", description: "FULL system prompt for editorial (editable in admin)." },
  { path: "gpt.editorial.user_extra", type: "string", description: "Extra text appended to editorial user instructions." },

  { path: "gpt.motion_prompt.temperature", type: "number", description: "GPT temperature for motion prompt writing." },
  { path: "gpt.motion_prompt.max_tokens", type: "number", description: "GPT max_tokens for motion prompt writing." },
  { path: "gpt.motion_prompt.system_text", type: "string", description: "FULL system prompt for motion prompt (editable in admin)." },
  { path: "gpt.motion_prompt.user_extra", type: "string", description: "Extra text appended to motion prompt user instructions." },

  { path: "gpt.motion_suggest.temperature", type: "number", description: "GPT temperature for motion suggestion (textarea)." },
  { path: "gpt.motion_suggest.max_tokens", type: "number", description: "GPT max_tokens for motion suggestion (textarea)." },
  { path: "gpt.motion_suggest.system_text", type: "string", description: "FULL system prompt for motion suggest (editable in admin)." },
  { path: "gpt.motion_suggest.user_extra", type: "string", description: "Extra text appended to motion suggest user instructions." },
];


// ======================================================
// Admin audit helpers (kept as-is)
// ======================================================
function auditAiEvent(req, action, status, detail = {}) {
  const meta = req ? getRequestMeta(req) : {};
  const userId = req?.user?.userId;
  const email = req?.user?.email;

  const normalizedDetail = { ...detail };
  normalizedDetail.request_id =
    normalizedDetail.request_id || normalizedDetail.requestId || null;
  normalizedDetail.step = normalizedDetail.step || normalizedDetail.stage || null;
  normalizedDetail.input_type =
    normalizedDetail.input_type || normalizedDetail.inputType || null;
  normalizedDetail.output_type =
    normalizedDetail.output_type || normalizedDetail.outputType || null;
  normalizedDetail.r2_url = normalizedDetail.r2_url || normalizedDetail.r2Url || null;
  normalizedDetail.model = normalizedDetail.model || null;
  normalizedDetail.provider = normalizedDetail.provider || null;

  normalizedDetail.latency_ms =
    typeof normalizedDetail.latency_ms === "number"
      ? normalizedDetail.latency_ms
      : typeof normalizedDetail.latencyMs === "number"
        ? normalizedDetail.latencyMs
        : null;

  normalizedDetail.input_chars =
    typeof normalizedDetail.input_chars === "number"
      ? normalizedDetail.input_chars
      : typeof normalizedDetail.inputChars === "number"
        ? normalizedDetail.inputChars
        : null;

  normalizedDetail.output_chars =
    typeof normalizedDetail.output_chars === "number"
      ? normalizedDetail.output_chars
      : typeof normalizedDetail.outputChars === "number"
        ? normalizedDetail.outputChars
        : null;

  delete normalizedDetail.requestId;
  delete normalizedDetail.inputType;
  delete normalizedDetail.outputType;
  delete normalizedDetail.r2Url;
  delete normalizedDetail.latencyMs;
  delete normalizedDetail.inputChars;
  delete normalizedDetail.outputChars;

  normalizedDetail.ip = meta.ip;
  normalizedDetail.userAgent = meta.userAgent;
  normalizedDetail.user_id = userId || undefined;
  normalizedDetail.email = email || undefined;

  void logAdminAction({
    userId,
    email,
    action,
    status,
    route: detail.route || meta.route,
    method: detail.method || meta.method,
    detail: normalizedDetail,
  });
}

function persistSessionHash(req, token, userId, email) {
  if (!token) return;
  const meta = req ? getRequestMeta(req) : {};
  void upsertSessionRow({
    userId,
    email,
    token,
    ip: meta.ip,
    userAgent: meta.userAgent,
  });
}

// ======================================================
// Supabase business persistence helpers
// ======================================================

// Create customer row on first contact (+ optional welcome credits txn)
const DEFAULT_FREE_CREDITS = Number(process.env.DEFAULT_FREE_CREDITS || 50);

async function sbGetCustomer(customerId) {
  if (!supabaseAdmin) return null;
  const id = safeShopifyId(customerId);

  const { data, error } = await supabaseAdmin
    .from("customers")
    .select("shopify_customer_id,user_id,email,credits,expires_at,last_active,disabled,created_at,updated_at,meta")
    .eq("shopify_customer_id", id)
    .maybeSingle();

  if (error) throw error;
  return data || null;
}

async function sbInsertCreditTxn({ customerId, delta, reason, source, refType = null, refId = null }) {
  if (!supabaseAdmin) return;

  const txn = {
    id: crypto.randomUUID(), // uuid column
    shopify_customer_id: safeShopifyId(customerId),
    delta: Number(delta || 0),
    reason: String(reason || "adjustment"),
    source: String(source || "api"),
    ref_type: refType ? String(refType) : null,
    ref_id: refId ? String(refId) : null,
    created_at: nowIso(),
  };

  const { error } = await supabaseAdmin.from("credit_transactions").insert(txn);
  if (error) throw error;
}

async function sbEnsureCustomer({ customerId, userId, email }) {
  if (!supabaseAdmin) return null;

  const id = safeShopifyId(customerId);
  let row = await sbGetCustomer(id);

  if (!row) {
    const ts = nowIso();
    const startingCredits = DEFAULT_FREE_CREDITS > 0 ? DEFAULT_FREE_CREDITS : 0;

    const payload = {
      shopify_customer_id: id,
      user_id: userId || null,
      email: email || null,
      credits: startingCredits,
      last_active: ts,
      created_at: ts,
      updated_at: ts,
      meta: {},
      disabled: false,
    };

    const { data, error } = await supabaseAdmin
      .from("customers")
      .insert(payload)
      .select("shopify_customer_id,user_id,email,credits,expires_at,last_active,disabled,created_at,updated_at,meta")
      .single();

    if (error) throw error;
    row = data;

    // Insert welcome transaction (mirrors old behavior)
    if (startingCredits > 0) {
      try {
        await sbInsertCreditTxn({
          customerId: id,
          delta: startingCredits,
          reason: "auto-welcome",
          source: "system",
          refType: "welcome",
          refId: null,
        });
      } catch (e) {
        // Don’t break customer creation on txn failure
        console.error("[supabase] welcome txn insert failed:", e?.message || e);
      }
    }
  } else {
    // touch last_active / attach email/user_id if newly known
    const updates = { last_active: nowIso(), updated_at: nowIso() };
    if (userId && !row.user_id) updates.user_id = userId;
    if (email && !row.email) updates.email = email;

    const { error } = await supabaseAdmin.from("customers").update(updates).eq("shopify_customer_id", id);
    if (error) throw error;
  }

  return row;
}

async function sbGetCredits({ customerId, reqUserId, reqEmail }) {
  if (!supabaseAdmin) return { balance: null, historyLength: null, source: "no-sb" };

  const cust = await sbEnsureCustomer({
    customerId,
    userId: reqUserId || null,
    email: reqEmail || null,
  });

  // count txns
  const { count, error: countErr } = await supabaseAdmin
    .from("credit_transactions")
    .select("id", { count: "exact", head: true })
    .eq("shopify_customer_id", cust.shopify_customer_id);

  return {
    balance: cust.credits ?? 0,
    historyLength: countErr ? null : (count ?? 0),
    source: "supabase",
  };
}

// WARNING: not fully atomic under concurrency (fine for low traffic)
async function sbAdjustCredits({ customerId, delta, reason, source, refType, refId, reqUserId, reqEmail }) {
  if (!supabaseAdmin) return { ok: false, balance: null, source: "no-sb" };

  const cust = await sbEnsureCustomer({
    customerId,
    userId: reqUserId || null,
    email: reqEmail || null,
  });

  const nextBalance = (cust.credits ?? 0) + Number(delta || 0);
  const updates = {
    credits: nextBalance,
    last_active: nowIso(),
    updated_at: nowIso(),
  };

  if (reqUserId) updates.user_id = reqUserId;
  if (reqEmail) updates.email = reqEmail;

  const { error } = await supabaseAdmin.from("customers").update(updates).eq("shopify_customer_id", cust.shopify_customer_id);
  if (error) throw error;

  // Insert transaction (best effort)
  try {
    await sbInsertCreditTxn({
      customerId: cust.shopify_customer_id,
      delta,
      reason,
      source,
      refType,
      refId,
    });
  } catch (e) {
    console.error("[supabase] credit txn insert failed:", e?.message || e);
  }

  return { ok: true, balance: nextBalance, source: "supabase" };
}

async function sbUpsertAppSession({ id, customerId, platform, title, createdAt }) {
  if (!supabaseAdmin) return;

  const sid = normalizeSessionUuid(id);
  if (!isUuid(sid)) throw new Error(`sessions.id must be uuid; got "${id}"`);

  const payload = {
    id: sid,
    shopify_customer_id: safeShopifyId(customerId),
    platform: safeString(platform || "tiktok").toLowerCase(),
    title: safeString(title || "Mina session"),
    created_at: createdAt || nowIso(),
  };

  const { error } = await supabaseAdmin.from("sessions").upsert(payload, { onConflict: "id" });
  if (error) throw error;
}

async function sbUpsertGenerationBusiness(gen) {
  if (!supabaseAdmin) return;

  // generations.id is text in your schema (so "gen_<uuid>" is OK)
  const payload = {
    id: String(gen.id),
    type: String(gen.type || "image"),
    session_id: gen.sessionId ? String(gen.sessionId) : null,
    customer_id: gen.customerId ? String(gen.customerId) : null,
    platform: gen.platform ? String(gen.platform) : null,
    prompt: gen.prompt ? String(gen.prompt) : "",
    output_url: gen.outputUrl ? String(gen.outputUrl) : null,
    meta: gen.meta ?? null,
    created_at: gen.createdAt || nowIso(),
    updated_at: nowIso(),
    shopify_customer_id: gen.customerId ? String(gen.customerId) : null,
    provider: gen.meta?.provider ? String(gen.meta.provider) : (gen.provider ? String(gen.provider) : null),
    output_key: gen.outputKey ? String(gen.outputKey) : null,
  };

  const { error } = await supabaseAdmin.from("generations").upsert(payload, { onConflict: "id" });
  if (error) throw error;
}

async function sbUpsertFeedbackBusiness(fb) {
  if (!supabaseAdmin) return;

  const fid = fb.id;
  if (!isUuid(fid)) throw new Error(`feedback.id must be uuid; got "${fid}"`);

  const sessionUuid = fb.sessionId ? normalizeSessionUuid(fb.sessionId) : null;
  if (sessionUuid && !isUuid(sessionUuid)) {
    // If client sends legacy / invalid session id, just drop it
    console.warn("[feedback] dropping invalid sessionId:", fb.sessionId);
  }

  const payload = {
    id: fid,
    shopify_customer_id: safeShopifyId(fb.customerId),
    session_id: sessionUuid && isUuid(sessionUuid) ? sessionUuid : null,
    generation_id: fb.generationId ? String(fb.generationId) : null,
    result_type: String(fb.resultType || "image"),
    platform: fb.platform ? String(fb.platform) : null,
    prompt: String(fb.prompt || ""),
    comment: fb.comment ? String(fb.comment) : null,
    image_url: fb.imageUrl ? String(fb.imageUrl) : null,
    video_url: fb.videoUrl ? String(fb.videoUrl) : null,
    created_at: fb.createdAt || nowIso(),
  };

  const { error } = await supabaseAdmin.from("feedback").upsert(payload, { onConflict: "id" });
  if (error) throw error;
}

async function sbGetLikesForCustomer(customerId, limit = 50) {
  if (!supabaseAdmin) return [];

  const { data, error } = await supabaseAdmin
    .from("feedback")
    .select("result_type,platform,prompt,comment,image_url,video_url,created_at")
    .eq("shopify_customer_id", safeShopifyId(customerId))
    .order("created_at", { ascending: true })
    .limit(Math.max(1, Math.min(200, Number(limit || 50))));

  if (error) throw error;

  return (data || []).map((r) => ({
    resultType: r.result_type || "image",
    platform: r.platform || "tiktok",
    prompt: r.prompt || "",
    comment: r.comment || "",
    imageUrl: r.image_url || null,
    videoUrl: r.video_url || null,
    createdAt: r.created_at || nowIso(),
  }));
}

async function sbGetBillingSettings(customerId) {
  if (!supabaseAdmin) return { enabled: false, monthlyLimitPacks: 0, source: "no-db" };

  const cust = await sbEnsureCustomer({ customerId, userId: null, email: null });
  const meta = cust?.meta || {};
  const autoTopup = meta.autoTopup || {};
  return {
    enabled: Boolean(autoTopup.enabled),
    monthlyLimitPacks: Number.isFinite(autoTopup.monthlyLimitPacks)
      ? Math.max(0, Math.floor(autoTopup.monthlyLimitPacks))
      : 0,
    source: "customers.meta",
  };
}

async function sbSetBillingSettings(customerId, enabled, monthlyLimitPacks) {
  if (!supabaseAdmin) throw new Error("Supabase not configured");

  const cust = await sbEnsureCustomer({ customerId, userId: null, email: null });
  const meta = cust?.meta || {};

  const nextMeta = {
    ...meta,
    autoTopup: {
      enabled: Boolean(enabled),
      monthlyLimitPacks: Number.isFinite(monthlyLimitPacks)
        ? Math.max(0, Math.floor(monthlyLimitPacks))
        : 0,
    },
  };

  const { error } = await supabaseAdmin
    .from("customers")
    .update({ meta: nextMeta, updated_at: nowIso() })
    .eq("shopify_customer_id", cust.shopify_customer_id);

  if (error) throw error;

  return { enabled: nextMeta.autoTopup.enabled, monthlyLimitPacks: nextMeta.autoTopup.monthlyLimitPacks };
}

async function sbCountCustomers() {
  if (!supabaseAdmin) return null;
  const { count, error } = await supabaseAdmin
    .from("customers")
    .select("shopify_customer_id", { count: "exact", head: true });
  if (error) throw error;
  return count ?? 0;
}

async function sbListCustomers(limit = 500) {
  if (!supabaseAdmin) return [];
  const { data, error } = await supabaseAdmin
    .from("customers")
    .select("shopify_customer_id,email,credits,last_active,created_at,updated_at,disabled")
    .order("shopify_customer_id", { ascending: true })
    .limit(Math.max(1, Math.min(1000, Number(limit || 500))));
  if (error) throw error;
  return data || [];
}

async function sbGetCustomerHistory(customerId) {
  if (!supabaseAdmin) return null;

  const cid = safeShopifyId(customerId);

  const [custRes, gensRes, fbRes, txRes] = await Promise.all([
    supabaseAdmin
      .from("customers")
      .select("shopify_customer_id,credits")
      .eq("shopify_customer_id", cid)
      .maybeSingle(),
    supabaseAdmin
      .from("generations")
      .select("*")
      .eq("shopify_customer_id", cid)
      .order("created_at", { ascending: false })
      .limit(500),
    supabaseAdmin
      .from("feedback")
      .select("*")
      .eq("shopify_customer_id", cid)
      .order("created_at", { ascending: false })
      .limit(500),
    supabaseAdmin
      .from("credit_transactions")
      .select("*")
      .eq("shopify_customer_id", cid)
      .order("created_at", { ascending: false })
      .limit(500),
  ]);

  if (custRes.error) throw custRes.error;
  if (gensRes.error) throw gensRes.error;
  if (fbRes.error) throw fbRes.error;
  if (txRes.error) throw txRes.error;

  return {
    customerId: cid,
    credits: {
      balance: custRes.data?.credits ?? 0,
      history: txRes.data || [],
    },
    generations: gensRes.data || [],
    feedbacks: fbRes.data || [],
  };
}

async function sbGetAdminOverview() {
  if (!supabaseAdmin) return null;

  const [gensRes, fbRes] = await Promise.all([
    supabaseAdmin.from("generations").select("*").order("created_at", { ascending: false }).limit(500),
    supabaseAdmin.from("feedback").select("*").order("created_at", { ascending: false }).limit(500),
  ]);

  if (gensRes.error) throw gensRes.error;
  if (fbRes.error) throw fbRes.error;

  return {
    generations: gensRes.data || [],
    feedbacks: fbRes.data || [],
  };
}

// ======================================================
// Express setup
// ======================================================
app.use(cors());
app.use(express.json({ limit: "25mb" }));
app.use(express.urlencoded({ extended: true, limit: "25mb" }));

// Replicate (SeaDream + Kling)
const replicate = new Replicate({
  auth: process.env.REPLICATE_API_TOKEN,
});

// OpenAI (GPT brain for Mina)
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Models
const SEADREAM_MODEL = process.env.SEADREAM_MODEL_VERSION || "bytedance/seedream-4";
const KLING_MODEL = process.env.KLING_MODEL_VERSION || "kwaivgi/kling-v2.1";

// How many credits each operation costs
const IMAGE_CREDITS_COST = Number(process.env.IMAGE_CREDITS_COST || 1);
const MOTION_CREDITS_COST = Number(process.env.MOTION_CREDITS_COST || 5);

// ======================================================
// Style presets
// ======================================================
const STYLE_PRESETS = {
  vintage: {
    name: "Vintage",
    profile: {
      keywords: [
        "editorial-still-life",
        "film-grain-texture",
        "muted-color-palette",
        "soft-contrast",
        "gentle-vignette",
        "studio-tabletop",
        "smooth-clean-backdrop",
        "subtle-flash-highlights",
        "timeless-magazine-look",
      ],
      description:
        "editorial still life with a luxurious, magazine-era feel. Clean compositions, smooth backgrounds, and muted tones with gentle contrast. Subtle grain and soft highlights give a timeless, refined look while keeping the scene minimal and polished. no frames",
    },
    heroImageUrls: ["https://assets.faltastudio.com/Website%20Assets/Vintage%201.png"],
  },

  gradient: {
    name: "Gradient",
    profile: {
      keywords: [
        "gradient-background",
        "midair-suspension",
        "luxury-editorial-still-life",
        "minimal-composition",
        "hyper-texture-detail",
        "sculptural-subject",
        "dramatic-rim-light",
        "soft-vignette-falloff",
        "crisp-specular-highlights",
      ],
      description:
        "Minimal luxury still life shot against a smooth gradient backdrop, Editorial lighting with subtle rim/backlight and controlled shadows,hyper-detailed textures and sculptural forms.",
    },
    heroImageUrls: ["https://assets.faltastudio.com/Website%20Assets/Gradient%200.png"],
  },

  "back-light": {
    name: "Back Light",
    profile: {
      keywords: [
        "luxury-editorial-still-life",
        "high-key-light-background",
        "backlit-translucency",
        "glass-refractions",
        "clean-specular-highlights",
        "minimal-composition",
        "soft-shadow-falloff",
        "premium-studio-look",
      ],
      description:
        "Luxurious editorial still life on a bright, minimal background. Clean studio lighting with glossy glass reflections and a strong backlight that reveals inner translucency and subtle texture, creating a premium, sculptural feel.",
    },
    heroImageUrls: ["https://assets.faltastudio.com/Website%20Assets/Backlight.png"],
  },
};

// ======================================================
// Mina Vision Intelligence (now reads likes from Supabase feedback)
// Cache (in-memory) only to reduce DB reads
// ======================================================
const likeMemory = new Map(); // customerId -> [likeEntry]
const MAX_LIKES_PER_CUSTOMER = 50;

const styleProfileCache = new Map(); // customerId -> { profile, likesCountAtCompute, updatedAt }
const styleProfileHistory = new Map(); // customerId -> [ { profile, likesCountAtCompute, createdAt } ]

const MIN_LIKES_FOR_FIRST_PROFILE = 20;
const LIKES_PER_PROFILE_REFRESH = 5;

function rememberLike(customerIdRaw, entry) {
  if (!customerIdRaw) return;
  const customerId = String(customerIdRaw);
  const existing = likeMemory.get(customerId) || [];
  existing.push({
    resultType: entry.resultType || "image",
    platform: entry.platform || "tiktok",
    prompt: entry.prompt || "",
    comment: entry.comment || "",
    imageUrl: entry.imageUrl || null,
    videoUrl: entry.videoUrl || null,
    createdAt: entry.createdAt || new Date().toISOString(),
  });

  if (existing.length > MAX_LIKES_PER_CUSTOMER) {
    const excess = existing.length - MAX_LIKES_PER_CUSTOMER;
    existing.splice(0, excess);
  }

  likeMemory.set(customerId, existing);
}

async function getLikes(customerIdRaw) {
  const customerId = String(customerIdRaw || "");
  if (!customerId) return [];

  // Prefer Supabase feedback
  if (sbEnabled()) {
    try {
      const likes = await sbGetLikesForCustomer(customerId, MAX_LIKES_PER_CUSTOMER);
      likeMemory.set(customerId, likes);
      return likes;
    } catch (e) {
      console.error("[likes] supabase read failed:", e?.message || e);
      // fall back to cache
    }
  }

  return likeMemory.get(customerId) || [];
}

function getStyleHistoryFromLikes(likes) {
  return (likes || []).map((like) => ({
    prompt: like.prompt,
    platform: like.platform,
    comment: like.comment || null,
  }));
}

function mergePresetAndUserProfile(presetProfile, userProfile) {
  if (presetProfile && userProfile) {
    const combinedKeywords = [
      ...(presetProfile.keywords || []),
      ...(userProfile.keywords || []),
    ]
      .map((k) => String(k).trim())
      .filter(Boolean);
    const dedupedKeywords = Array.from(new Set(combinedKeywords));

    const description = (
      "Base style: " +
      (presetProfile.description || "") +
      " Personal twist: " +
      (userProfile.description || "")
    ).trim();

    return {
      profile: {
        keywords: dedupedKeywords,
        description,
      },
      source: "preset+user",
    };
  } else if (userProfile) {
    return { profile: userProfile, source: "user_only" };
  } else if (presetProfile) {
    return { profile: presetProfile, source: "preset_only" };
  } else {
    return { profile: null, source: "none" };
  }
}

async function runChatWithFallback({
  systemMessage,
  userContent,
  fallbackPrompt,
  model = "gpt-4.1-mini",
  temperature = 0.9,
  maxTokens = 400,
}) {
  const gptIn = makeGptIOInput({ model, systemMessage, userContent, temperature, maxTokens });

  try {
    const completion = await openai.chat.completions.create({
      model,
      messages: [systemMessage, { role: "user", content: userContent }],
      temperature,
      max_tokens: maxTokens,
    });

    const text = completion.choices?.[0]?.message?.content?.trim();
    if (!text) throw new Error("Empty GPT response");

    return {
      prompt: text,
      usedFallback: false,
      gptError: null,
      gptModel: model,
      gptIO: {
        in: gptIn,
        out: { text: truncateStr(text, 8000) },
      },
    };
  } catch (err) {
    const outText = fallbackPrompt || "";
    return {
      prompt: outText,
      usedFallback: true,
      gptError: {
        status: err?.status || null,
        message: err?.message || String(err),
      },
      gptModel: model,
      gptIO: {
        in: gptIn,
        out: {
          text: truncateStr(outText, 8000),
          error: { status: err?.status || null, message: err?.message || String(err) },
        },
      },
    };
  }
}


// Build style profile from likes (with vision if images exist)
async function buildStyleProfileFromLikes(customerId, likes) {
  const recentLikes = (likes || []).slice(-10);
  if (!recentLikes.length) {
    return {
      profile: { keywords: [], description: "" },
      usedFallback: false,
      gptError: null,
    };
  }

  const examplesText = recentLikes
    .map((like, idx) => {
      return `#${idx + 1} [${like.resultType} / ${like.platform}]
Prompt: ${like.prompt || ""}
UserComment: ${like.comment || "none"}
HasImage: ${like.imageUrl ? "yes" : "no"}
HasVideo: ${like.videoUrl ? "yes" : "no"}`;
    })
    .join("\n\n");

  const systemMessage = {
    role: "system",
    content:
      "You are an assistant that summarizes a user's aesthetic preferences " +
      "for AI-generated editorial product images and motion.\n\n" +
      "You will see liked generations with prompts, optional comments, and sometimes the final liked image.\n\n" +
      "IMPORTANT:\n" +
      "- Treat comments as preference signals. If user says they DON'T like something (e.g. 'I like the image but I don't like the light'), do NOT treat that attribute as part of their style. Prefer avoiding repeatedly disliked attributes.\n" +
      "- For images, use the actual image content (colors, lighting, composition, background complexity, mood) to infer style.\n" +
      "- For motion entries you only see prompts/comments, use those.\n\n" +
      "Return STRICT JSON only with 'keywords' and 'description'.",
  };

  const userText = `
Customer id: ${customerId}

Below are image/video generations this customer explicitly liked.

Infer what they CONSISTENTLY LIKE, not what they dislike.
If comments mention dislikes, subtract those from your style interpretation.

Return STRICT JSON only with this shape:
{
  "keywords": ["short-tag-1", "short-tag-2", ...],
  "description": "2-3 sentence natural-language description of their style"
}

Text data for last liked generations:
${examplesText}
`.trim();

  const imageParts = [];
  recentLikes.forEach((like) => {
    if (like.resultType === "image" && like.imageUrl) {
      imageParts.push({
        type: "image_url",
        image_url: { url: like.imageUrl },
      });
    }
  });

  const userContent =
    imageParts.length > 0
      ? [{ type: "text", text: userText }, ...imageParts]
      : userText;

  const fallbackPrompt = '{"keywords":[],"description":""}';

  const result = await runChatWithFallback({
    systemMessage,
    userContent,
    fallbackPrompt,
  });

  let profile = { keywords: [], description: "" };
  try {
    profile = JSON.parse(result.prompt);
    if (!Array.isArray(profile.keywords)) profile.keywords = [];
    if (typeof profile.description !== "string") profile.description = "";
  } catch (e) {
    profile = { keywords: [], description: result.prompt || "" };
  }

  return {
    profile,
    usedFallback: result.usedFallback,
    gptError: result.gptError,
  };
}

async function getOrBuildStyleProfile(customerIdRaw, likes) {
  const customerId = String(customerIdRaw || "anonymous");
  const likesCount = (likes || []).length;

  if (likesCount < MIN_LIKES_FOR_FIRST_PROFILE) {
    return {
      profile: null,
      meta: {
        source: "none",
        reason: "not_enough_likes",
        likesCount,
        minLikesForFirstProfile: MIN_LIKES_FOR_FIRST_PROFILE,
      },
    };
  }

  const cached = styleProfileCache.get(customerId);
  if (cached && likesCount < cached.likesCountAtCompute + LIKES_PER_PROFILE_REFRESH) {
    return {
      profile: cached.profile,
      meta: {
        source: "cache",
        likesCount,
        likesCountAtProfile: cached.likesCountAtCompute,
        updatedAt: cached.updatedAt,
        refreshStep: LIKES_PER_PROFILE_REFRESH,
      },
    };
  }

  const profileRes = await buildStyleProfileFromLikes(customerId, likes);
  const profile = profileRes.profile;
  const updatedAt = new Date().toISOString();

  styleProfileCache.set(customerId, {
    profile,
    likesCountAtCompute: likesCount,
    updatedAt,
  });

  const historyArr = styleProfileHistory.get(customerId) || [];
  historyArr.push({
    profile,
    likesCountAtCompute: likesCount,
    createdAt: updatedAt,
  });
  styleProfileHistory.set(customerId, historyArr);

  return {
    profile,
    meta: {
      source: "recomputed",
      likesCount,
      likesCountAtProfile: likesCount,
      updatedAt,
      refreshStep: LIKES_PER_PROFILE_REFRESH,
      usedFallback: profileRes.usedFallback,
      gptError: profileRes.gptError,
    },
  };
}

// ======================================================
// Prompt builders (kept from your version)
// ======================================================
async function buildEditorialPrompt(payload) {
  const cfg = await getRuntimeConfig();
  const g = cfg?.gpt?.editorial || {};

  const {
    productImageUrl,
    logoImageUrl = "",
    styleImageUrls = [],
    brief,
    tone,
    platform = "tiktok",
    mode = "image",
    styleHistory = [],
    styleProfile = null,
    presetHeroImageUrls = [],
  } = payload;

  const fallbackPrompt = [
    safeString(brief, "Editorial still-life product photo."),
    tone ? `Tone: ${tone}.` : "",
    `Shot for ${platform}, clean composition, professional lighting.`,
    "Hero product in focus, refined minimal background, fashion/editorial style.",
  ]
    .join(" ")
    .trim();

  const historyText = styleHistory.length
    ? styleHistory
        .map((item, idx) => `${idx + 1}) [${item.platform}] ${item.prompt || ""}`)
        .join("\n")
    : "none yet – this might be their first liked result.";

  const profileDescription =
    styleProfile && styleProfile.description ? styleProfile.description : "no explicit style profile yet.";
  const profileKeywords =
    styleProfile && Array.isArray(styleProfile.keywords) ? styleProfile.keywords.join(", ") : "";

  // ✅ system prompt comes from runtime config (default = your current hardcoded)
  const systemMessage = {
    role: "system",
    content: safeString(g.system_text, BASE_GPT_SYSTEM_EDITORIAL),
  };

  const baseUserText = `
You are creating a new ${mode} for Mina.

Current request brief:
${safeString(brief, "No extra brand context provided.")}

Tone / mood: ${safeString(tone, "not specified")}
Target platform: ${platform}

Recent liked prompts for this customer (history):
${historyText}

Combined style profile (from presets and/or user-liked generations):
Keywords: ${profileKeywords || "none"}
Description: ${profileDescription}

The attached images are:
- Main product image as the hero subject
- Optional logo image for brand identity
- Up to 3 style/mood references from the user
- Optional preset hero style image(s) defining a strong mood/look

Write the final prompt I should send to the image model.
Also, after the prompt, output JSON with 'imageTexts' and 'userMessage'.
`.trim();

  // ✅ safe extra text you can edit in admin
  const userText = g.user_extra ? `${baseUserText}\n\nExtra instructions:\n${g.user_extra}` : baseUserText;

  const imageParts = [];
  if (productImageUrl) imageParts.push({ type: "image_url", image_url: { url: productImageUrl } });
  if (logoImageUrl) imageParts.push({ type: "image_url", image_url: { url: logoImageUrl } });

  (styleImageUrls || [])
    .slice(0, 3)
    .filter(Boolean)
    .forEach((url) => imageParts.push({ type: "image_url", image_url: { url } }));

  (presetHeroImageUrls || [])
    .slice(0, 1)
    .filter(Boolean)
    .forEach((url) => imageParts.push({ type: "image_url", image_url: { url } }));

  const userContent =
    imageParts.length > 0 ? [{ type: "text", text: userText }, ...imageParts] : userText;

  const result = await runChatWithFallback({
    systemMessage,
    userContent,
    fallbackPrompt,
    model: cfg?.models?.gpt || "gpt-4.1-mini",
    temperature: typeof g.temperature === "number" ? g.temperature : 0.8,
    maxTokens: Number.isFinite(g.max_tokens) ? g.max_tokens : 420,
  });

  const response = (result.prompt || "").trim();
  const firstBrace = response.indexOf("{");
  let prompt = response;
  let meta = { imageTexts: [], userMessage: "" };

  if (firstBrace >= 0) {
    prompt = response.slice(0, firstBrace).trim();
    const jsonString = response.slice(firstBrace);
    try {
      const parsed = JSON.parse(jsonString);
      if (Array.isArray(parsed.imageTexts)) meta.imageTexts = parsed.imageTexts;
      if (typeof parsed.userMessage === "string") meta.userMessage = parsed.userMessage;
    } catch (_) {}
  }

  return {
    prompt,
    usedFallback: result.usedFallback,
    gptError: result.gptError,
    imageTexts: meta.imageTexts,
    userMessage: meta.userMessage,
    gptModel: result.gptModel,
    gptIO: result.gptIO,
  };
}


async function buildMotionPrompt(options) {
  const cfg = await getRuntimeConfig();
  const g = cfg?.gpt?.motion_prompt || {};

  const {
    motionBrief,
    tone,
    platform = "tiktok",
    lastImageUrl,
    styleHistory = [],
    styleProfile = null,
  } = options;

  const fallbackPrompt = [
    motionBrief || "Short looping editorial motion of the product.",
    tone ? `Tone: ${tone}.` : "",
    `Optimised for ${platform} vertical content.`,
  ]
    .join(" ")
    .trim();

  const historyText = styleHistory.length
    ? styleHistory
        .map((item, idx) => `${idx + 1}) [${item.platform}] ${item.prompt || ""}`)
        .join("\n")
    : "none";

  const profileDescription =
    styleProfile && styleProfile.description ? styleProfile.description : "no explicit style profile yet.";
  const profileKeywords =
    styleProfile && Array.isArray(styleProfile.keywords) ? styleProfile.keywords.join(", ") : "";

  const systemMessage = {
    role: "system",
    content: safeString(g.system_text, BASE_GPT_SYSTEM_MOTION_PROMPT),
  };

  const baseUserText = `
You are creating a short motion loop based on the attached still frame.

Desired motion description from the user:
${safeString(motionBrief, "subtle elegant camera move with a small motion in the scene.")}

Tone / feeling: ${safeString(tone, "not specified")}
Target platform: ${platform}

Recent liked image prompts for this customer (aesthetic history):
${historyText}

Combined style profile (from presets and/or user-liked generations):
Keywords: ${profileKeywords || "none"}
Description: ${profileDescription}

The attached image is the reference frame to animate. Do NOT mention URLs.
Write the final video generation prompt.
`.trim();

  const userText = g.user_extra ? `${baseUserText}\n\nExtra instructions:\n${g.user_extra}` : baseUserText;

  const imageParts = [];
  if (lastImageUrl) imageParts.push({ type: "image_url", image_url: { url: lastImageUrl } });

  const userContent =
    imageParts.length > 0 ? [{ type: "text", text: userText }, ...imageParts] : userText;

  return runChatWithFallback({
    systemMessage,
    userContent,
    fallbackPrompt,
    model: cfg?.models?.gpt || "gpt-4.1-mini",
    temperature: typeof g.temperature === "number" ? g.temperature : 0.8,
    maxTokens: Number.isFinite(g.max_tokens) ? g.max_tokens : 280,
  });
}


async function buildMotionSuggestion(options) {
  const cfg = await getRuntimeConfig();
  const g = cfg?.gpt?.motion_suggest || {};

  const {
    referenceImageUrl,
    tone,
    platform = "tiktok",
    styleHistory = [],
    styleProfile = null,
    userDraft = "",
    extraImageUrls = [],
    presetHeroImageUrls = [],
  } = options;

  const cleanedDraft = safeString(userDraft, "").trim();

  const fallbackPrompt =
    cleanedDraft || "Slow, minimal motion, soft, ASMR movement, satisfying video";

  const historyText = styleHistory.length
    ? styleHistory
        .map((item, idx) => `${idx + 1}) [${item.platform}] ${item.prompt || ""}`)
        .join("\n")
    : "none";

  const profileDescription =
    styleProfile && styleProfile.description ? styleProfile.description : "no explicit style profile yet.";
  const profileKeywords =
    styleProfile && Array.isArray(styleProfile.keywords) ? styleProfile.keywords.join(", ") : "";

  const systemMessage = {
    role: "system",
    content: safeString(g.system_text, BASE_GPT_SYSTEM_MOTION_SUGGEST),
  };

  const baseUserText = `
We want a motion idea for an editorial product shot.

User draft (if any):
${cleanedDraft ? cleanedDraft : "none"}

Tone / feeling: ${safeString(tone, "not specified")}
Target platform: ${platform}

Recent liked prompts for this customer:
${historyText}

Style profile:
Keywords: ${profileKeywords || "none"}
Description: ${profileDescription}

Attached images:
- The first image is the still frame to animate (most important).
- Additional images (if present) are product/logo/style references to match the brand vibe.

Task:
Write one single-sentence motion idea. If a user draft exists, rewrite it tighter and more editorial.
`.trim();

  const userText = g.user_extra ? `${baseUserText}\n\nExtra instructions:\n${g.user_extra}` : baseUserText;

  const imageParts = [];

  if (referenceImageUrl) {
    imageParts.push({ type: "image_url", image_url: { url: referenceImageUrl } });
  }

  (extraImageUrls || [])
    .filter((u) => isHttpUrl(u))
    .slice(0, 4)
    .forEach((url) => imageParts.push({ type: "image_url", image_url: { url } }));

  (presetHeroImageUrls || [])
    .filter((u) => isHttpUrl(u))
    .slice(0, 1)
    .forEach((url) => imageParts.push({ type: "image_url", image_url: { url } }));

  const userContent =
    imageParts.length > 0 ? [{ type: "text", text: userText }, ...imageParts] : userText;

  const result = await runChatWithFallback({
    systemMessage,
    userContent,
    fallbackPrompt,
    model: cfg?.models?.gpt || "gpt-4.1-mini",
    temperature: typeof g.temperature === "number" ? g.temperature : 0.8,
    maxTokens: Number.isFinite(g.max_tokens) ? g.max_tokens : 260,
  });

  return {
    text: result.prompt,
    usedFallback: result.usedFallback,
    gptError: result.gptError,
  };
}



// ======================================================
// Sessions (in-memory helper only; authoritative data is Supabase)
// ======================================================
const sessions = new Map(); // sessionId -> { id, customerId, platform, title, createdAt }

function createSession({ customerId, platform, title }) {
  const sessionId = uuidv4(); // MUST be uuid for sessions.id
  const session = {
    id: sessionId,
    customerId: safeShopifyId(customerId),
    platform: safeString(platform || "tiktok").toLowerCase(),
    title: safeString(title || "Mina session"),
    createdAt: new Date().toISOString(),
  };

  sessions.set(sessionId, session);

  // Persist to Supabase
  if (sbEnabled()) {
    void sbUpsertAppSession({
      id: sessionId,
      customerId: session.customerId,
      platform: session.platform,
      title: session.title,
      createdAt: session.createdAt,
    }).catch((e) => console.error("[supabase] session upsert failed:", e?.message || e));
  }

  return session;
}

function ensureSession(sessionIdRaw, customerId, platform) {
  const platformNorm = safeString(platform || "tiktok").toLowerCase();
  const incomingId = normalizeSessionUuid(sessionIdRaw || "");

  if (incomingId && sessions.has(incomingId)) return sessions.get(incomingId);

  if (incomingId && isUuid(incomingId)) {
    // accept client-provided uuid session id
    const s = {
      id: incomingId,
      customerId: safeShopifyId(customerId),
      platform: platformNorm,
      title: "Mina session",
      createdAt: new Date().toISOString(),
    };
    sessions.set(incomingId, s);
    if (sbEnabled()) {
      void sbUpsertAppSession({
        id: incomingId,
        customerId: s.customerId,
        platform: s.platform,
        title: s.title,
        createdAt: s.createdAt,
      }).catch((e) => console.error("[supabase] session upsert failed:", e?.message || e));
    }
    return s;
  }

  return createSession({ customerId, platform: platformNorm, title: "Mina session" });
}

// ======================================================
// Routes
// ======================================================

// Health
app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "Mina Editorial AI API (Supabase)",
    time: new Date().toISOString(),
    supabase: sbEnabled(),
  });
});

app.get("/", (_req, res) => {
  res.json({
    ok: true,
    service: "Mina Editorial AI API (Supabase)",
    time: new Date().toISOString(),
    supabase: sbEnabled(),
  });
});

// public stats → total users on login screen
app.get("/public/stats/total-users", async (_req, res) => {
  const requestId = `stats_${Date.now()}`;

  if (!sbEnabled()) {
    return res.json({
      ok: false,
      requestId,
      source: "no_supabase",
      totalUsers: null,
    });
  }

  try {
    const dbCount = await sbCountCustomers();
    const total = (dbCount ?? 0) + MINA_BASELINE_USERS;
    return res.json({
      ok: true,
      requestId,
      source: "supabase",
      totalUsers: total,
    });
  } catch (err) {
    console.error("[mina] total-users supabase error", err);
    return res.json({
      ok: false,
      requestId,
      source: "sb_error",
      totalUsers: null,
    });
  }
});

// Billing settings (stored in customers.meta.autoTopup)
app.get("/billing/settings", async (req, res) => {
  try {
    const customerIdRaw = req.query.customerId;
    if (!customerIdRaw) return res.status(400).json({ error: "Missing customerId" });

    const customerId = String(customerIdRaw);

    if (!sbEnabled()) {
      return res.json({ customerId, enabled: false, monthlyLimitPacks: 0, source: "no-db" });
    }

    const setting = await sbGetBillingSettings(customerId);
    return res.json({ customerId, ...setting });
  } catch (err) {
    console.error("GET /billing/settings error", err);
    res.status(500).json({ error: "Failed to load billing settings" });
  }
});

app.post("/billing/settings", async (req, res) => {
  try {
    const { customerId, enabled, monthlyLimitPacks } = req.body || {};
    if (!customerId) return res.status(400).json({ error: "customerId is required" });
    if (!sbEnabled()) return res.status(500).json({ error: "Supabase not configured" });

    const saved = await sbSetBillingSettings(
      String(customerId),
      Boolean(enabled),
      Number(monthlyLimitPacks || 0)
    );

    res.json({
      customerId: String(customerId),
      enabled: saved.enabled,
      monthlyLimitPacks: saved.monthlyLimitPacks,
    });
  } catch (err) {
    console.error("POST /billing/settings error", err);
    res.status(500).json({ error: "Failed to save billing settings" });
  }
});

// Credits: balance
app.get("/credits/balance", async (req, res) => {
  const requestId = `req_${Date.now()}_${uuidv4()}`;
  try {
    const customerIdRaw = req.query.customerId || "anonymous";
    const customerId = String(customerIdRaw);

    if (!sbEnabled()) {
      return res.json({
        ok: false,
        requestId,
        customerId,
        balance: null,
        historyLength: null,
        meta: { imageCost: IMAGE_CREDITS_COST, motionCost: MOTION_CREDITS_COST },
        message: "Supabase not configured",
      });
    }

    const rec = await sbGetCredits({
      customerId,
      reqUserId: req?.user?.userId,
      reqEmail: req?.user?.email,
    });

    res.json({
      ok: true,
      requestId,
      customerId,
      balance: rec.balance,
      historyLength: rec.historyLength,
      meta: { imageCost: IMAGE_CREDITS_COST, motionCost: MOTION_CREDITS_COST },
      source: rec.source,
    });
  } catch (err) {
    console.error("Error in /credits/balance:", err);
    res.status(500).json({
      ok: false,
      error: "CREDITS_ERROR",
      message: err?.message || "Unexpected error during credits balance.",
      requestId,
    });
  }
});

// Credits: add (manual / via webhook)
app.post("/credits/add", async (req, res) => {
  const requestId = `req_${Date.now()}_${uuidv4()}`;
  try {
    const body = req.body || {};
    const customerId =
      body.customerId !== null && body.customerId !== undefined ? String(body.customerId) : "anonymous";
    const amount = typeof body.amount === "number" ? body.amount : Number(body.amount || 0);
    const reason = safeString(body.reason || "manual-topup");
    const source = safeString(body.source || "api");

    if (!amount || !Number.isFinite(amount)) {
      return res.status(400).json({
        ok: false,
        error: "INVALID_AMOUNT",
        message: "amount is required and must be a number.",
        requestId,
      });
    }

    if (!sbEnabled()) {
      return res.status(500).json({ ok: false, error: "NO_DB", message: "Supabase not configured", requestId });
    }

    const out = await sbAdjustCredits({
      customerId,
      delta: amount,
      reason,
      source,
      refType: "manual",
      refId: requestId,
      reqUserId: req?.user?.userId,
      reqEmail: req?.user?.email,
    });

    res.json({
      ok: true,
      requestId,
      customerId,
      newBalance: out.balance,
      source: out.source,
    });
  } catch (err) {
    console.error("Error in /credits/add:", err);
    res.status(500).json({
      ok: false,
      error: "CREDITS_ERROR",
      message: err?.message || "Unexpected error during credits add.",
      requestId,
    });
  }
});

// Admin API (summary & customers/adjust)
app.get("/admin/summary", requireAdmin, async (_req, res) => {
  try {
    if (!sbEnabled()) return res.status(503).json({ error: "Supabase not available" });

    const totalCustomers = await sbCountCustomers();

    // Sum credits + autoTopup enabled (best-effort; limited scan)
    let totalCredits = 0;
    let autoTopupOn = 0;

    const pageSize = 1000;
    let from = 0;
    const hardCap = 20000; // safety cap
    while (from < hardCap) {
      const to = from + pageSize - 1;
      const { data, error } = await supabaseAdmin
        .from("customers")
        .select("credits,meta")
        .range(from, to);

      if (error) throw error;
      if (!data || data.length === 0) break;

      for (const row of data) {
        totalCredits += Number(row.credits || 0);
        const enabled = row?.meta?.autoTopup?.enabled;
        if (enabled === true) autoTopupOn += 1;
      }

      if (data.length < pageSize) break;
      from += pageSize;
    }

    res.json({
      totalCustomers: totalCustomers ?? 0,
      totalCredits,
      autoTopupOn,
      source: "supabase",
      note: totalCustomers > 20000 ? "summary capped to 20k customers for sum/autoTopup count" : undefined,
    });
  } catch (err) {
    console.error("GET /admin/summary error", err);
    res.status(500).json({ error: "Failed to load admin summary" });
  }
});

app.get("/admin/customers", requireAdmin, async (req, res) => {
  try {
    if (!sbEnabled()) return res.status(503).json({ error: "Supabase not available" });

    const rows = await sbListCustomers(500);
    res.json({ customers: rows, source: "supabase" });
  } catch (err) {
    console.error("GET /admin/customers error", err);
    res.status(500).json({ error: "Failed to load admin customers" });
  }
});

app.post("/admin/credits/adjust", requireAdmin, async (req, res) => {
  try {
    const { customerId, delta, reason } = req.body || {};
    if (!customerId || typeof delta !== "number") {
      return res.status(400).json({ error: "customerId and numeric delta are required" });
    }
    if (!sbEnabled()) return res.status(503).json({ error: "Supabase not available" });

    const out = await sbAdjustCredits({
      customerId: String(customerId),
      delta,
      reason: reason || "admin-adjust",
      source: "admin",
      refType: "admin",
      refId: req.user?.userId || null,
      reqUserId: req?.user?.userId,
      reqEmail: req?.user?.email,
    });

    res.json({
      customerId: String(customerId),
      balance: out.balance,
      source: out.source,
    });
  } catch (err) {
    console.error("POST /admin/credits/adjust error", err);
    res.status(500).json({ error: "Failed to adjust credits" });
  }
});
// =======================
// Admin: Runtime Config (live)
// =======================
app.get("/admin/config/runtime", requireAdmin, async (_req, res) => {
  try {
    if (!sbEnabled()) return res.status(503).json({ error: "Supabase not available" });

    const effective = await getRuntimeConfig();
    const row = await sbGetRuntimeOverride();

    res.json({
      ok: true,
      defaults: DEFAULT_RUNTIME_CONFIG,
      override: row?.value || {},
      effective,
      meta: {
        updatedAt: row?.updated_at || null,
        updatedBy: row?.updated_by || null,
        ttlMs: RUNTIME_CONFIG_TTL_MS,
      },
      schema: RUNTIME_CONFIG_SCHEMA,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: "CONFIG_READ_FAILED", message: e?.message || String(e) });
  }
});

// Replace the whole override JSON
app.post("/admin/config/runtime", requireAdmin, async (req, res) => {
  try {
    if (!sbEnabled()) return res.status(503).json({ error: "Supabase not available" });

    const { override } = req.body || {};
    if (!override || typeof override !== "object") {
      return res.status(400).json({ ok: false, error: "INVALID_OVERRIDE", message: "override must be a JSON object" });
    }

    await sbSetRuntimeOverride(override, req.user?.email || req.user?.userId || "admin");

    // refresh cache immediately
    runtimeConfigCache.fetchedAt = 0;
    const effective = await getRuntimeConfig();

    res.json({ ok: true, effective });
  } catch (e) {
    res.status(500).json({ ok: false, error: "CONFIG_SAVE_FAILED", message: e?.message || String(e) });
  }
});

// Set one field by path: { path: "gpt.editorial.temperature", value: 0.6 }
// Unset one field (delete from override) so it falls back to DEFAULT
app.post("/admin/config/runtime/unset", requireAdmin, async (req, res) => {
  try {
    if (!sbEnabled()) return res.status(503).json({ error: "Supabase not available" });

    const { path } = req.body || {};
    const p = safeString(path);
    if (!p) return res.status(400).json({ ok: false, error: "MISSING_PATH" });

    const row = await sbGetRuntimeOverride();
    const current = (row?.value && typeof row.value === "object") ? row.value : {};
    const next = unsetDeep({ ...current }, p);

    await sbSetRuntimeOverride(next, req.user?.email || req.user?.userId || "admin");

    runtimeConfigCache.fetchedAt = 0;
    const effective = await getRuntimeConfig();

    res.json({ ok: true, override: next, effective });
  } catch (e) {
    res.status(500).json({ ok: false, error: "CONFIG_UNSET_FAILED", message: e?.message || String(e) });
  }
});


// Force reload (optional button in dashboard)
app.post("/admin/config/runtime/reload", requireAdmin, async (_req, res) => {
  runtimeConfigCache.fetchedAt = 0;
  const effective = await getRuntimeConfig();
  res.json({ ok: true, effective });
});

// =======================
// Session start (Supabase-only)
// =======================
app.post("/sessions/start", async (req, res) => {
  const requestId = `req_${Date.now()}_${uuidv4()}`;

  try {
    const body = req.body || {};
    const customerId =
      body.customerId !== null && body.customerId !== undefined
        ? String(body.customerId)
        : "anonymous";

    const platform = safeString(body.platform || "tiktok").toLowerCase();
    const title = safeString(body.title || "Mina session");

    if (!sbEnabled()) {
      return res.status(500).json({
        ok: false,
        error: "NO_DB",
        message: "Supabase not configured",
        requestId,
      });
    }

    // Ensure customer exists (and welcome credits if configured)
    await sbEnsureCustomer({
      customerId,
      userId: req?.user?.userId || null,
      email: req?.user?.email || null,
    });

    const session = createSession({ customerId, platform, title });

    // For audit/ops correlation
    persistSessionHash(req, session.id || requestId, req.user?.userId, req.user?.email);

    res.json({
      ok: true,
      requestId,
      session,
    });
  } catch (err) {
    console.error("Error in /sessions/start:", err);
    res.status(500).json({
      ok: false,
      error: "SESSION_ERROR",
      message: err?.message || "Unexpected error during session start.",
      requestId,
    });
  }
});

// =======================
// ---- Mina Editorial (image) — R2 ONLY output (no provider URLs)
// =======================
app.post("/editorial/generate", async (req, res) => {
  const requestId = `req_${Date.now()}_${uuidv4()}`;
  const generationId = `gen_${uuidv4()}`;
  const startedAt = Date.now();

  let customerId = "anonymous";
  let platform = "tiktok";
  let stylePresetKey = "";

  try {
    if (!sbEnabled()) {
      return res.status(500).json({
        ok: false,
        error: "NO_DB",
        message: "Supabase not configured",
        requestId,
      });
    }

    const body = req.body || {};
    const productImageUrl = safeString(body.productImageUrl);
    const logoImageUrl = safeString(body.logoImageUrl || "");
    const styleImageUrls = Array.isArray(body.styleImageUrls) ? body.styleImageUrls : [];
    const brief = safeString(body.brief);
    const tone = safeString(body.tone);
    platform = safeString(body.platform || "tiktok").toLowerCase();
    const minaVisionEnabled = !!body.minaVisionEnabled;
    stylePresetKey = safeString(body.stylePresetKey || "");
    const preset = stylePresetKey ? STYLE_PRESETS[stylePresetKey] || null : null;

    customerId =
      body.customerId !== null && body.customerId !== undefined
        ? String(body.customerId)
        : "anonymous";

    if (!productImageUrl && !brief) {
      auditAiEvent(req, "ai_error", 400, {
        request_id: requestId,
        step: "vision",
        input_type: "text",
        output_type: "image",
        model: SEADREAM_MODEL,
        provider: "replicate",
        generation_id: generationId,
        detail: { reason: "missing_input" },
      });
      return res.status(400).json({
        ok: false,
        error: "MISSING_INPUT",
        message: "Provide at least productImageUrl or brief so Mina knows what to create.",
        requestId,
      });
    }

    await sbEnsureCustomer({
      customerId,
      userId: req?.user?.userId || null,
      email: req?.user?.email || null,
    });

    const cfg = await getRuntimeConfig();
    const imageCost = Number(cfg?.credits?.imageCost ?? IMAGE_CREDITS_COST);
    const creditsInfo = await sbGetCredits({
      customerId,
      reqUserId: req?.user?.userId,
      reqEmail: req?.user?.email,
    });

    if ((creditsInfo.balance ?? 0) < imageCost) {
      auditAiEvent(req, "ai_error", 402, {
        request_id: requestId,
        step: "vision",
        input_type: productImageUrl ? "image" : "text",
        output_type: "image",
        model: SEADREAM_MODEL,
        provider: "replicate",
        generation_id: generationId,
        detail: {
          reason: "insufficient_credits",
          required: imageCost,
          balance: creditsInfo.balance ?? 0,
        },
      });
      return res.status(402).json({
        ok: false,
        error: "INSUFFICIENT_CREDITS",
        message: `Not enough Mina credits. Need ${imageCost}, you have ${creditsInfo.balance ?? 0}.`,
        requiredCredits: imageCost,
        currentCredits: creditsInfo.balance ?? 0,
        requestId,
      });
    }

    const session = ensureSession(body.sessionId, customerId, platform);
    const sessionId = session.id;
    persistSessionHash(req, sessionId || requestId, req.user?.userId, req.user?.email);

    let styleHistory = [];
    let userStyleProfile = null;
    let finalStyleProfile = null;
    let styleProfileMeta = null;

    if (minaVisionEnabled && customerId) {
      const likes = await getLikes(customerId);
      styleHistory = getStyleHistoryFromLikes(likes);
      const profileRes = await getOrBuildStyleProfile(customerId, likes);
      userStyleProfile = profileRes.profile;

      const merged = mergePresetAndUserProfile(preset ? preset.profile : null, userStyleProfile);
      finalStyleProfile = merged.profile;
      styleProfileMeta = {
        ...profileRes.meta,
        presetKey: stylePresetKey || null,
        mergeSource: merged.source,
      };
    } else {
      styleHistory = [];
      const merged = mergePresetAndUserProfile(preset ? preset.profile : null, null);
      finalStyleProfile = merged.profile;
      styleProfileMeta = {
        source: merged.source,
        likesCount: 0,
        presetKey: stylePresetKey || null,
      };
    }

    const promptResult = await buildEditorialPrompt({
      productImageUrl,
      logoImageUrl,
      styleImageUrls,
      brief,
      tone,
      platform,
      mode: "image",
      styleHistory,
      styleProfile: finalStyleProfile,
      presetHeroImageUrls: preset?.heroImageUrls || [],
    });

    const prompt = promptResult.prompt;
    const imageTexts = promptResult.imageTexts || [];
    const userMessage = promptResult.userMessage || "";

    const requestedAspect = safeString(body.aspectRatio || "");
    const validAspects = new Set(["9:16", "3:4", "2:3", "1:1", "3:2", "16:9"]);
    let aspectRatio = "2:3";

    if (validAspects.has(requestedAspect)) {
      aspectRatio = requestedAspect;
    } else {
      if (platform === "tiktok" || platform.includes("reel")) aspectRatio = "9:16";
      else if (platform === "instagram-post") aspectRatio = "3:4";
      else if (platform === "print") aspectRatio = "2:3";
      else if (platform === "square") aspectRatio = "1:1";
      else if (platform.includes("youtube")) aspectRatio = "16:9";
    }

    const seadreamModel = cfg?.models?.seadream || SEADREAM_MODEL;

    const input = {
      prompt,
      image_input: productImageUrl ? [productImageUrl, ...styleImageUrls] : styleImageUrls,
      max_images: body.maxImages || 1,
      size: cfg?.replicate?.seadream?.size || "2K",
      aspect_ratio: aspectRatio,
      enhance_prompt: cfg?.replicate?.seadream?.enhance_prompt ?? true,
      sequential_image_generation: cfg?.replicate?.seadream?.sequential_image_generation || "disabled",
    };

    auditAiEvent(req, "ai_request", 200, {
      request_id: requestId,
      step: "vision",
      input_type: productImageUrl ? "image" : "text",
      output_type: "image",
      session_id: sessionId,
      customer_id: customerId,
      model: seadreamModel,
      provider: "replicate",
      input_chars: (prompt || "").length,
      stylePresetKey,
      minaVisionEnabled,
      generation_id: generationId,
    });

    const output = await replicate.run(seadreamModel, { input });

    let providerUrls = [];
    if (Array.isArray(output)) {
      providerUrls = output
        .map((item) => {
          if (typeof item === "string") return item;
          if (item && typeof item === "object") return item.url || item.image || null;
          return null;
        })
        .filter(Boolean);
    } else if (typeof output === "string") {
      providerUrls = [output];
    } else if (output && typeof output === "object") {
      if (typeof output.url === "string") providerUrls = [output.url];
      else if (Array.isArray(output.output)) providerUrls = output.output.filter((v) => typeof v === "string");
    }

    if (!providerUrls.length) throw new Error("Image generation returned no URL.");

    const storedImages = await Promise.all(
      providerUrls.map((u) =>
        storeRemoteToR2Public({
          remoteUrl: u,
          kind: "generations",
          customerId,
        })
      )
    );

    const imageUrls = storedImages.map((s) => s.publicUrl);
    const outputKey = storedImages[0]?.key || null;
    const imageUrl = imageUrls[0] || null;

    if (!imageUrl) throw new Error("R2 store failed (no public URL). Check R2_PUBLIC_BASE_URL.");

    const spend = await sbAdjustCredits({
      customerId,
      delta: -imageCost,
      reason: "image-generate",
      source: "api",
      refType: "generation",
      refId: generationId,
      reqUserId: req?.user?.userId,
      reqEmail: req?.user?.email,
    });

    const latencyMs = Date.now() - startedAt;
    const outputChars = imageUrls.join(",").length;

    const generationRecord = {
      id: generationId,
      type: "image",
      sessionId,
      customerId,
      platform,
      prompt: prompt || "",
      outputUrl: imageUrl,
      outputKey,
      createdAt: new Date().toISOString(),
      meta: {
        tone,
        platform,
        minaVisionEnabled,
        stylePresetKey,
        productImageUrl,
        logoImageUrl,
        styleImageUrls,
        aspectRatio,
        imageTexts,
        userMessage,
        requestId,
        latencyMs,
        inputChars: (prompt || "").length,
        outputChars,
        model: seadreamModel,
        provider: "replicate",
        status: "succeeded",
        userId: req.user?.userId,
        email: req.user?.email,
      },
    };

    void sbUpsertGenerationBusiness(generationRecord).catch((e) =>
      console.error("[supabase] generation upsert failed:", e?.message || e)
    );

    auditAiEvent(req, "ai_response", 200, {
      request_id: requestId,
      step: "vision",
      input_type: productImageUrl ? "image" : "text",
      output_type: "image",
      r2_url: imageUrl,
      session_id: sessionId,
      customer_id: customerId,
      model: seadreamModel,
      provider: "replicate",
      latency_ms: latencyMs,
      input_chars: (prompt || "").length,
      output_chars: outputChars,
      generation_id: generationId,
    });

    void upsertGenerationRow({
      id: generationId,
      requestId,
      sessionId,
      userId: req.user?.userId,
      email: req.user?.email,
      model: seadreamModel,
      provider: "replicate",
      status: "succeeded",
      inputChars: (prompt || "").length,
      outputChars,
      latencyMs,
      meta: {
        requestId,
        step: "vision",
        input_type: productImageUrl ? "image" : "text",
        output_type: "image",
        r2_url: imageUrl,
        customerId,
        platform,
        aspectRatio,
        minaVisionEnabled,
        stylePresetKey,
        outputKey,
      },
    });

    return res.json({
      ok: true,
      message: "Mina Editorial image generated (stored in R2).",
      requestId,
      prompt,
      imageUrl,
      imageUrls,
      generationId,
      sessionId,
      credits: {
        balance: spend.balance,
        cost: imageCost,
      },
      gpt: {
        usedFallback: promptResult.usedFallback,
        error: promptResult.gptError,
        styleProfile: finalStyleProfile,
        styleProfileMeta,
        imageTexts,
        userMessage,
      },
    });
  } catch (err) {
    console.error("Error in /editorial/generate:", err);

    auditAiEvent(req, "ai_error", 500, {
      request_id: requestId,
      step: "vision",
      input_type: safeString(req.body?.productImageUrl) ? "image" : "text",
      output_type: "image",
      model: SEADREAM_MODEL,
      provider: "replicate",
      latency_ms: Date.now() - startedAt,
      generation_id: generationId,
      detail: { error: err?.message },
    });

    void upsertGenerationRow({
      id: generationId,
      requestId,
      sessionId: normalizeSessionUuid(safeString(req.body?.sessionId)) || null,
      userId: req.user?.userId,
      email: req.user?.email,
      model: SEADREAM_MODEL,
      provider: "replicate",
      status: "failed",
      latencyMs: Date.now() - startedAt,
      meta: {
        requestId,
        step: "vision",
        input_type: safeString(req.body?.productImageUrl) ? "image" : "text",
        output_type: "image",
        customerId,
        platform: safeString(req.body?.platform || "") || null,
        stylePresetKey: safeString(req.body?.stylePresetKey || "") || null,
        error: err?.message,
      },
    });

    return res.status(500).json({
      ok: false,
      error: "EDITORIAL_GENERATION_ERROR",
      message: err?.message || "Unexpected error during image generation.",
      requestId,
    });
  }
});
// =======================
// ---- Motion suggestion (textarea) — Supabase-only likes read
// =======================
app.post("/motion/suggest", async (req, res) => {
  const requestId = `req_${Date.now()}_${uuidv4()}`;
  const generationId = `gen_${uuidv4()}`;
  const startedAt = Date.now();

  let customerId = "anonymous";

  try {
    if (!sbEnabled()) {
      return res.status(500).json({
        ok: false,
        error: "NO_DB",
        message: "Supabase not configured",
        requestId,
      });
    }

    const body = req.body || {};
    const referenceImageUrl = safeString(body.referenceImageUrl);

    if (!referenceImageUrl) {
      auditAiEvent(req, "ai_error", 400, {
        request_id: requestId,
        step: "caption",
        input_type: "image",
        output_type: "text",
        model: "gpt-4.1-mini",
        provider: "openai",
        generation_id: generationId,
        detail: { reason: "missing_reference_image" },
      });
      return res.status(400).json({
        ok: false,
        error: "MISSING_REFERENCE_IMAGE",
        message: "referenceImageUrl is required to suggest motion.",
        requestId,
      });
    }

    const tone = safeString(body.tone);
    const platform = safeString(body.platform || "tiktok").toLowerCase();
    const minaVisionEnabled = !!body.minaVisionEnabled;
    const stylePresetKey = safeString(body.stylePresetKey || "");
    const preset = stylePresetKey ? STYLE_PRESETS[stylePresetKey] || null : null;
    const userDraft = safeString(body.text || body.motionBrief || body.motionDescription || "");
    
    // Optional extra context images (if your frontend sends them)
    const productImageUrl = safeString(body.productImageUrl || "");
    const logoImageUrl = safeString(body.logoImageUrl || "");
    const styleImageUrls = Array.isArray(body.styleImageUrls) ? body.styleImageUrls : [];
    
    const extraImageUrls = [
      productImageUrl,
      logoImageUrl,
      ...styleImageUrls,
    ].map((u) => safeString(u, "")).filter((u) => isHttpUrl(u));

    customerId =
      body.customerId !== null && body.customerId !== undefined
        ? String(body.customerId)
        : "anonymous";

    // Ensure customer exists
    await sbEnsureCustomer({
      customerId,
      userId: req?.user?.userId || null,
      email: req?.user?.email || null,
    });

    persistSessionHash(req, body.sessionId || customerId || requestId, req.user?.userId, req.user?.email);

    auditAiEvent(req, "ai_request", 200, {
      request_id: requestId,
      step: "caption",
      input_type: "image",
      output_type: "text",
      session_id: normalizeSessionUuid(body.sessionId) || null,
      customer_id: customerId,
      model: "gpt-4.1-mini",
      provider: "openai",
      input_chars: JSON.stringify(body || {}).length,
      generation_id: generationId,
    });

    let styleHistory = [];
    let userStyleProfile = null;
    let finalStyleProfile = null;

    if (minaVisionEnabled && customerId) {
      const likes = await getLikes(customerId);
      styleHistory = getStyleHistoryFromLikes(likes);
      const profileRes = await getOrBuildStyleProfile(customerId, likes);
      userStyleProfile = profileRes.profile;

      finalStyleProfile = mergePresetAndUserProfile(preset ? preset.profile : null, userStyleProfile).profile;
    } else {
      styleHistory = [];
      finalStyleProfile = mergePresetAndUserProfile(preset ? preset.profile : null, null).profile;
    }

    const suggestionRes = await buildMotionSuggestion({
    referenceImageUrl,
    tone,
    platform,
    styleHistory,
    styleProfile: finalStyleProfile,
  
    // ✅ NEW
    userDraft,
    extraImageUrls,
    presetHeroImageUrls: preset?.heroImageUrls || [],
    });


    const latencyMs = Date.now() - startedAt;

    auditAiEvent(req, "ai_response", 200, {
      request_id: requestId,
      step: "caption",
      input_type: "image",
      output_type: "text",
      session_id: normalizeSessionUuid(body.sessionId) || null,
      customer_id: customerId,
      model: "gpt-4.1-mini",
      provider: "openai",
      latency_ms: latencyMs,
      input_chars: JSON.stringify(body || {}).length,
      output_chars: (suggestionRes.text || "").length,
      generation_id: generationId,
    });

    void upsertGenerationRow({
      id: generationId,
      requestId,
      sessionId: normalizeSessionUuid(body.sessionId) || null,
      userId: req.user?.userId,
      email: req.user?.email,
      model: "gpt-4.1-mini",
      provider: "openai",
      status: "succeeded",
      inputChars: JSON.stringify(body || {}).length,
      outputChars: (suggestionRes.text || "").length,
      latencyMs,
      meta: {
        requestId,
        step: "caption",
        input_type: "image",
        output_type: "text",
        customerId,
        sessionId: normalizeSessionUuid(body.sessionId) || null,
      },
    });

    res.json({
      ok: true,
      requestId,
      suggestion: suggestionRes.text,
      gpt: {
        usedFallback: suggestionRes.usedFallback,
        error: suggestionRes.gptError,
      },
    });
  } catch (err) {
    console.error("Error in /motion/suggest:", err);

    auditAiEvent(req, "ai_error", 500, {
      request_id: requestId,
      step: "caption",
      input_type: "image",
      output_type: "text",
      model: "gpt-4.1-mini",
      provider: "openai",
      latency_ms: Date.now() - startedAt,
      generation_id: generationId,
      detail: { error: err?.message },
    });

    void upsertGenerationRow({
      id: generationId,
      requestId,
      sessionId: normalizeSessionUuid(req.body?.sessionId) || null,
      userId: req.user?.userId,
      email: req.user?.email,
      model: "gpt-4.1-mini",
      provider: "openai",
      status: "failed",
      latencyMs: Date.now() - startedAt,
      meta: {
        requestId,
        step: "caption",
        input_type: "image",
        output_type: "text",
        customerId,
        error: err?.message,
      },
    });

    res.status(500).json({
      ok: false,
      error: "MOTION_SUGGESTION_ERROR",
      message: err?.message || "Unexpected error during motion suggestion.",
      requestId,
    });
  }
});

// =======================
// ---- Mina Motion (video) — R2 ONLY output (no provider URLs)
// =======================
app.post("/motion/generate", async (req, res) => {
  const requestId = `req_${Date.now()}_${uuidv4()}`;
  const generationId = `gen_${uuidv4()}`;
  const startedAt = Date.now();

  let customerId = "anonymous";
  let platform = "tiktok";
  let stylePresetKey = "";

  try {
    if (!sbEnabled()) {
      return res.status(500).json({
        ok: false,
        error: "NO_DB",
        message: "Supabase not configured",
        requestId,
      });
    }

    const body = req.body || {};
    const lastImageUrl = safeString(body.lastImageUrl);
    const motionDescription = safeString(body.motionDescription);
    const tone = safeString(body.tone);
    platform = safeString(body.platform || "tiktok").toLowerCase();
    const minaVisionEnabled = !!body.minaVisionEnabled;
    stylePresetKey = safeString(body.stylePresetKey || "");
    const preset = stylePresetKey ? STYLE_PRESETS[stylePresetKey] || null : null;

    customerId =
      body.customerId !== null && body.customerId !== undefined
        ? String(body.customerId)
        : "anonymous";

    if (!lastImageUrl) {
      return res.status(400).json({
        ok: false,
        error: "MISSING_LAST_IMAGE",
        message: "lastImageUrl is required to create motion.",
        requestId,
      });
    }

    if (!motionDescription) {
      return res.status(400).json({
        ok: false,
        error: "MISSING_MOTION_DESCRIPTION",
        message: "Describe how Mina should move the scene.",
        requestId,
      });
    }

    await sbEnsureCustomer({
      customerId,
      userId: req?.user?.userId || null,
      email: req?.user?.email || null,
    });

    const cfg = await getRuntimeConfig();
    const motionCost = Number(cfg?.credits?.motionCost ?? MOTION_CREDITS_COST);
    const creditsInfo = await sbGetCredits({
      customerId,
      reqUserId: req?.user?.userId,
      reqEmail: req?.user?.email,
    });

    if ((creditsInfo.balance ?? 0) < motionCost) {
      return res.status(402).json({
        ok: false,
        error: "INSUFFICIENT_CREDITS",
        message: `Not enough Mina credits. Need ${motionCost}, you have ${creditsInfo.balance ?? 0}.`,
        requiredCredits: motionCost,
        currentCredits: creditsInfo.balance ?? 0,
        requestId,
      });
    }

    const session = ensureSession(body.sessionId, customerId, platform);
    const sessionId = session.id;
    persistSessionHash(req, sessionId || requestId, req.user?.userId, req.user?.email);

    let styleHistory = [];
    let userStyleProfile = null;
    let finalStyleProfile = null;
    let styleProfileMeta = null;

    if (minaVisionEnabled && customerId) {
      const likes = await getLikes(customerId);
      styleHistory = getStyleHistoryFromLikes(likes);
      const profileRes = await getOrBuildStyleProfile(customerId, likes);
      userStyleProfile = profileRes.profile;

      const merged = mergePresetAndUserProfile(preset ? preset.profile : null, userStyleProfile);
      finalStyleProfile = merged.profile;
      styleProfileMeta = {
        ...profileRes.meta,
        presetKey: stylePresetKey || null,
        mergeSource: merged.source,
      };
    } else {
      styleHistory = [];
      const merged = mergePresetAndUserProfile(preset ? preset.profile : null, null);
      finalStyleProfile = merged.profile;
      styleProfileMeta = {
        source: merged.source,
        likesCount: 0,
        presetKey: stylePresetKey || null,
      };
    }

    const motionResult = await buildMotionPrompt({
      motionBrief: motionDescription,
      tone,
      platform,
      lastImageUrl,
      styleHistory,
      styleProfile: finalStyleProfile,
    });

    const prompt = motionResult.prompt;
    let durationSeconds = Number(body.durationSeconds || 5);
    if (durationSeconds > 10) durationSeconds = 10;
    if (durationSeconds < 1) durationSeconds = 1;

    const klingModel = cfg?.models?.kling || KLING_MODEL;

    const input = {
      mode: cfg?.replicate?.kling?.mode || "pro",
      prompt,
      duration: durationSeconds,
      start_image: lastImageUrl,
      negative_prompt: cfg?.replicate?.kling?.negative_prompt || "",
    };

    const output = await replicate.run(klingModel, { input });

    let providerVideoUrl = null;
    if (typeof output === "string") {
      providerVideoUrl = output;
    } else if (Array.isArray(output) && output.length > 0) {
      const first = output[0];
      if (typeof first === "string") providerVideoUrl = first;
      else if (first && typeof first === "object") {
        if (typeof first.url === "string") providerVideoUrl = first.url;
        else if (typeof first.video === "string") providerVideoUrl = first.video;
      }
    } else if (output && typeof output === "object") {
      if (typeof output.url === "string") providerVideoUrl = output.url;
      else if (typeof output.video === "string") providerVideoUrl = output.video;
      else if (Array.isArray(output.output) && output.output.length > 0) {
        if (typeof output.output[0] === "string") providerVideoUrl = output.output[0];
      }
    }

    if (!providerVideoUrl) throw new Error("Motion generation returned no URL.");

    const storedVideo = await storeRemoteToR2Public({
      remoteUrl: providerVideoUrl,
      kind: "motions",
      customerId,
    });

    const videoUrl = storedVideo.publicUrl;
    const outputKey = storedVideo.key;

    if (!videoUrl) throw new Error("R2 store failed (no public URL). Check R2_PUBLIC_BASE_URL.");

    const spend = await sbAdjustCredits({
      customerId,
      delta: -motionCost,
      reason: "motion-generate",
      source: "api",
      refType: "generation",
      refId: generationId,
      reqUserId: req?.user?.userId,
      reqEmail: req?.user?.email,
    });

    const latencyMs = Date.now() - startedAt;
    const outputChars = (videoUrl || "").length;

    const generationRecord = {
      id: generationId,
      type: "motion",
      sessionId,
      customerId,
      platform,
      prompt: motionDescription || "",
      outputUrl: videoUrl,
      outputKey,
      createdAt: new Date().toISOString(),
      meta: {
        tone,
        platform,
        minaVisionEnabled,
        stylePresetKey,
        lastImageUrl,
        durationSeconds,
        requestId,
        latencyMs,
        inputChars: (prompt || "").length,
        outputChars,
        model: klingModel,
        provider: "replicate",
        status: "succeeded",
        userId: req.user?.userId,
        email: req.user?.email,
      },
    };

    void sbUpsertGenerationBusiness(generationRecord).catch((e) =>
      console.error("[supabase] generation upsert failed:", e?.message || e)
    );

    auditAiEvent(req, "ai_response", 200, {
      request_id: requestId,
      step: "motion",
      input_type: "text",
      output_type: "video",
      r2_url: videoUrl,
      session_id: sessionId,
      customer_id: customerId,
      model: klingModel,
      provider: "replicate",
      latency_ms: latencyMs,
      input_chars: (prompt || "").length,
      output_chars: outputChars,
      generation_id: generationId,
    });

    void upsertGenerationRow({
      id: generationId,
      requestId,
      sessionId,
      userId: req.user?.userId,
      email: req.user?.email,
      model: klingModel,
      provider: "replicate",
      status: "succeeded",
      inputChars: (prompt || "").length,
      outputChars,
      latencyMs,
      meta: {
        requestId,
        step: "motion",
        input_type: "text",
        output_type: "video",
        r2_url: videoUrl,
        customerId,
        platform,
        durationSeconds,
        minaVisionEnabled,
        stylePresetKey,
        outputKey,
      },
    });

    return res.json({
      ok: true,
      message: "Mina Motion video generated (stored in R2).",
      requestId,
      prompt,
      videoUrl,
      generationId,
      sessionId,
      credits: {
        balance: spend.balance,
        cost: motionCost,
      },
      gpt: {
        usedFallback: motionResult.usedFallback,
        error: motionResult.gptError,
        styleProfile: finalStyleProfile,
        styleProfileMeta,
      },
    });
  } catch (err) {
    console.error("Error in /motion/generate:", err);

    auditAiEvent(req, "ai_error", 500, {
      request_id: requestId,
      step: "motion",
      input_type: "text",
      output_type: "video",
      model: KLING_MODEL,
      provider: "replicate",
      latency_ms: Date.now() - startedAt,
      generation_id: generationId,
      detail: { error: err?.message },
    });

    void upsertGenerationRow({
      id: generationId,
      requestId,
      sessionId: normalizeSessionUuid(req.body?.sessionId) || null,
      userId: req.user?.userId,
      email: req.user?.email,
      model: KLING_MODEL,
      provider: "replicate",
      status: "failed",
      latencyMs: Date.now() - startedAt,
      meta: {
        requestId,
        step: "motion",
        input_type: "text",
        output_type: "video",
        customerId,
        error: err?.message,
      },
    });

    return res.status(500).json({
      ok: false,
      error: "MOTION_GENERATION_ERROR",
      message: err?.message || "Unexpected error during motion generation.",
      requestId,
    });
  }
});
// =======================
// ---- Feedback / likes (R2 ONLY persistence)
// =======================
app.post("/feedback/like", async (req, res) => {
  const requestId = `req_${Date.now()}_${uuidv4()}`;

  try {
    if (!sbEnabled()) {
      return res.status(500).json({
        ok: false,
        error: "NO_DB",
        message: "Supabase not configured",
        requestId,
      });
    }

    const body = req.body || {};
    const customerId =
      body.customerId !== null && body.customerId !== undefined
        ? String(body.customerId)
        : "anonymous";

    const resultType = safeString(body.resultType || "image");
    const platform = safeString(body.platform || "tiktok").toLowerCase();
    const prompt = safeString(body.prompt);
    const comment = safeString(body.comment);
    const imageUrl = safeString(body.imageUrl || "");
    const videoUrl = safeString(body.videoUrl || "");
    const sessionId = normalizeSessionUuid(safeString(body.sessionId || "")) || null;
    const generationId = safeString(body.generationId || "") || null;

    if (!prompt) {
      return res.status(400).json({
        ok: false,
        error: "MISSING_PROMPT",
        message: "Prompt is required to store like feedback.",
        requestId,
      });
    }

    await sbEnsureCustomer({
      customerId,
      userId: req?.user?.userId || null,
      email: req?.user?.email || null,
    });

    let cleanImageUrl = imageUrl || "";
    let cleanVideoUrl = videoUrl || "";

    if (cleanImageUrl && !isOurAssetUrl(cleanImageUrl)) {
      const stored = await storeRemoteToR2Public({
        remoteUrl: cleanImageUrl,
        kind: "likes-images",
        customerId,
      });
      cleanImageUrl = stored.publicUrl;
    }

    if (cleanVideoUrl && !isOurAssetUrl(cleanVideoUrl)) {
      const stored = await storeRemoteToR2Public({
        remoteUrl: cleanVideoUrl,
        kind: "likes-videos",
        customerId,
      });
      cleanVideoUrl = stored.publicUrl;
    }

    rememberLike(customerId, {
      resultType,
      platform,
      prompt,
      comment,
      imageUrl: cleanImageUrl || null,
      videoUrl: cleanVideoUrl || null,
    });

    const feedbackId = crypto.randomUUID();
    const feedback = {
      id: feedbackId,
      sessionId,
      generationId,
      customerId,
      resultType,
      platform,
      prompt,
      comment,
      imageUrl: cleanImageUrl || null,
      videoUrl: cleanVideoUrl || null,
      createdAt: new Date().toISOString(),
    };

    await sbUpsertFeedbackBusiness(feedback);

    let totalLikes = null;
    try {
      const likes = await sbGetLikesForCustomer(customerId, MAX_LIKES_PER_CUSTOMER);
      totalLikes = likes.length;
    } catch (_) {}

    return res.json({
      ok: true,
      message: "Like stored (R2 only).",
      requestId,
      payload: {
        customerId,
        resultType,
        platform,
        sessionId,
        generationId,
      },
      totals: {
        likesForCustomer: totalLikes,
      },
    });
  } catch (err) {
    console.error("Error in /feedback/like:", err);
    return res.status(500).json({
      ok: false,
      error: "FEEDBACK_ERROR",
      message: err?.message || "Unexpected error while saving feedback.",
      requestId,
    });
  }
});
// ============================
// Store remote generation (Provider URL -> R2 PUBLIC URL)
// ============================
app.post("/store-remote-generation", async (req, res) => {
  try {
    const { url, urls, customerId, folder } = req.body || {};

    const remoteUrl =
      (typeof url === "string" && url) ||
      (Array.isArray(urls) && typeof urls[0] === "string" ? urls[0] : "");

    if (!remoteUrl) return res.status(400).json({ ok: false, error: "NO_URL" });

    const cid = (customerId || "anon").toString();
    const fold = (folder || "generations").toString();

    const stored = await storeRemoteToR2Public({
      remoteUrl,
      kind: fold,
      customerId: cid,
    });

    return res.json({
      ok: true,
      key: stored.key,
      url: stored.publicUrl,      // ✅ public, never expires
      publicUrl: stored.publicUrl,
    });
  } catch (err) {
    console.error("POST /store-remote-generation error:", err);
    return res.status(500).json({ ok: false, error: "STORE_REMOTE_FAILED", message: err?.message || "Failed" });
  }
});


// =========================
// R2 Upload (kept same route name, BUT returns PUBLIC url)
// =========================
app.post("/api/r2/upload-signed", async (req, res) => {
  try {
    const { dataUrl, kind = "uploads", customerId = "anon", filename = "" } = req.body || {};
    if (!dataUrl) return res.status(400).json({ ok: false, error: "MISSING_DATAURL" });

    const { buffer, contentType, ext } = parseDataUrl(dataUrl);

    const folder = safeFolderName(kind);
    const cid = String(customerId || "anon");
    const base = safeName(filename || "upload");
    const uuid = crypto.randomUUID();

    const extGuess = ext || guessExtFromContentType(contentType);
    const key = `${folder}/${cid}/${Date.now()}-${uuid}-${base}${
      extGuess && !base.toLowerCase().endsWith(`.${extGuess}`) ? `.${extGuess}` : ""
    }`;

    const stored = await r2PutPublic({ key, body: buffer, contentType });

    return res.json({
      ok: true,
      key: stored.key,
      url: stored.publicUrl,        // ✅ public non-expiring
      publicUrl: stored.publicUrl,
      contentType,
      bytes: buffer.length,
    });
  } catch (err) {
    console.error("POST /api/r2/upload-signed error:", err);
    return res.status(500).json({
      ok: false,
      error: "UPLOAD_PUBLIC_FAILED",
      message: err?.message || "Unexpected error",
    });
  }
});

app.post("/api/r2/store-remote-signed", async (req, res) => {
  try {
    const { url, kind = "generations", customerId = "anon" } = req.body || {};
    if (!url) return res.status(400).json({ ok: false, error: "MISSING_URL" });

    const stored = await storeRemoteToR2Public({
      remoteUrl: url,
      kind,
      customerId,
    });

    return res.json({
      ok: true,
      key: stored.key,
      url: stored.publicUrl,        // ✅ public non-expiring
      publicUrl: stored.publicUrl,
    });
  } catch (err) {
    console.error("POST /api/r2/store-remote-signed error:", err);
    return res.status(500).json({
      ok: false,
      error: "STORE_REMOTE_PUBLIC_FAILED",
      message: err?.message || "Unexpected error",
    });
  }
});


// =======================
// Start server
// =======================
app.listen(PORT, () => {
  console.log(`Mina Editorial AI API listening on port ${PORT}`);
});
second file import crypto from "node:crypto";
import { createClient } from "@supabase/supabase-js";

let cachedClient = null;

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function normalizeEmail(email) {
  if (!email || typeof email !== "string") return null;
  const trimmed = email.trim().toLowerCase();
  return trimmed || null;
}

function safeUserAgent(userAgent) {
  if (!userAgent) return null;
  const str = String(userAgent);
  return str.slice(0, 512);
}

function safeIp(ip) {
  if (!ip) return null;
  return String(ip).slice(0, 128);
}

export function getSupabaseAdmin() {
  try {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) {
      console.error(
        "[supabase] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY; skipping Supabase admin client."
      );
      return null;
    }

    if (cachedClient) return cachedClient;

    cachedClient = createClient(url, key, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    });

    return cachedClient;
  } catch (err) {
    console.error("[supabase] Failed to init admin client", err);
    return null;
  }
}

export async function upsertProfileRow({ userId, email, shopifyCustomerId }) {
  try {
    const supabase = getSupabaseAdmin();
    if (!supabase) return;

    const normalizedEmail = normalizeEmail(email);
    if (!userId) return;
    if (!UUID_REGEX.test(userId)) {
      console.error("[supabase] upsertProfileRow skipped invalid userId", userId);
      return;
    }

    const now = new Date().toISOString();
    const payload = {
      user_id: userId,
      email: normalizedEmail,
      shopify_customer_id: shopifyCustomerId || null,
      updated_at: now,
      created_at: now,
    };

    const { error } = await supabase
      .from("profiles")
      .upsert(payload, { onConflict: "user_id" });
    if (error) {
      console.error("[supabase] upsertProfileRow error", error);
    }
  } catch (err) {
    console.error("[supabase] upsertProfileRow failed", err);
  }
}

export async function upsertSessionRow({
  userId,
  email,
  token,
  ip,
  userAgent,
}) {
  try {
    const supabase = getSupabaseAdmin();
    if (!supabase) return;
    if (!token) {
      console.error("[supabase] upsertSessionRow missing token");
      return;
    }

    const normalizedEmail = normalizeEmail(email);
    const validUserId = userId && UUID_REGEX.test(userId) ? userId : null;
    const hash = crypto.createHash("sha256").update(String(token)).digest("hex");
    const now = new Date().toISOString();

    const payload = {
      session_hash: hash,
      user_id: validUserId,
      email: normalizedEmail,
      ip: safeIp(ip),
      user_agent: safeUserAgent(userAgent),
      first_seen_at: now,
      last_seen_at: now,
      updated_at: now,
    };

    const { error } = await supabase
      .from("admin_sessions")
      .upsert(payload, { onConflict: "session_hash" });
    if (error) {
      console.error("[supabase] upsertSessionRow error", error);
    }
  } catch (err) {
    console.error("[supabase] upsertSessionRow failed", err);
  }
}

export async function logAdminAction({
  userId,
  email,
  action,
  route,
  method,
  status,
  detail,
  id,
}) {
  try {
    const supabase = getSupabaseAdmin();
    if (!supabase) return;

    const normalizedEmail = normalizeEmail(email);
    const validUserId = userId && UUID_REGEX.test(userId) ? userId : null;
    const now = new Date().toISOString();

    const payload = {
      id: id || crypto.randomUUID(),
      user_id: validUserId,
      email: normalizedEmail,
      action: action || null,
      route: route || null,
      method: method || null,
      status: typeof status === "number" ? status : null,
      detail: detail ?? null,
      created_at: now,
    };

    const { error } = await supabase.from("admin_audit").insert(payload);
    if (error) {
      console.error("[supabase] logAdminAction error", error);
    }
  } catch (err) {
    console.error("[supabase] logAdminAction failed", err);
  }
}

export async function upsertGenerationRow({
  id,
  userId,
  email,
  requestId,
  sessionId,
  model,
  provider,
  status,
  inputChars,
  outputChars,
  latencyMs,
  meta,
  detail,
}) {
  try {
    const supabase = getSupabaseAdmin();
    if (!supabase) return;
    if (!id) {
      console.error("[supabase] upsertGenerationRow requires id");
      return;
    }

    const normalizedEmail = normalizeEmail(email);
    const validUserId = userId && UUID_REGEX.test(userId) ? userId : null;
    const now = new Date().toISOString();

    const payload = {
      id,
      user_id: validUserId,
      email: normalizedEmail,
      request_id: requestId || null,
      session_id: sessionId || null,
      model: model || null,
      provider: provider || null,
      status: status || null,
      input_chars: typeof inputChars === "number" ? inputChars : null,
      output_chars: typeof outputChars === "number" ? outputChars : null,
      latency_ms: typeof latencyMs === "number" ? latencyMs : null,
      meta: meta ?? detail ?? null,
      created_at: now,
      updated_at: now,
    };

    const { error } = await supabase
      .from("generations")
      .upsert(payload, { onConflict: "id" });
    if (error) {
      console.error("[supabase] upsertGenerationRow error", error);
    }
  } catch (err) {
    console.error("[supabase] upsertGenerationRow failed", err);
  }
} third file // r2.js — PUBLIC, NON-EXPIRING URLs ONLY (no presigned GET links)
"use strict";

import crypto from "node:crypto";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

// =======================
// Env
// =======================
const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID || "";
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID || "";
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY || "";
const R2_BUCKET = process.env.R2_BUCKET || "";

// Optional override, otherwise computed from account id
const R2_ENDPOINT =
  process.env.R2_ENDPOINT || (R2_ACCOUNT_ID ? `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com` : "");

// This should be your permanent public domain for assets, e.g. https://assets.faltastudio.com
const R2_PUBLIC_BASE_URL = (process.env.R2_PUBLIC_BASE_URL || "").replace(/\/+$/, "");

// =======================
// Client
// =======================
const r2 =
  R2_ENDPOINT && R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY
    ? new S3Client({
        region: "auto",
        endpoint: R2_ENDPOINT,
        credentials: {
          accessKeyId: R2_ACCESS_KEY_ID,
          secretAccessKey: R2_SECRET_ACCESS_KEY,
        },
      })
    : null;

function assertR2Configured() {
  if (!r2) throw new Error("R2 is not configured (missing R2_ENDPOINT / credentials).");
  if (!R2_BUCKET) throw new Error("R2_BUCKET is missing.");
}

function safeFolderName(name = "uploads") {
  return String(name).replace(/[^a-zA-Z0-9/_-]/g, "_");
}

function safeName(name = "file") {
  return String(name).replace(/[^a-zA-Z0-9._-]/g, "_");
}

function guessExtFromContentType(contentType = "") {
  const ct = String(contentType).toLowerCase();
  if (ct.includes("png")) return "png";
  if (ct.includes("jpeg") || ct.includes("jpg")) return "jpg";
  if (ct.includes("webp")) return "webp";
  if (ct.includes("gif")) return "gif";
  if (ct.includes("mp4")) return "mp4";
  return "";
}

function encodeKeyForUrl(key) {
  return String(key || "")
    .split("/")
    .map((p) => encodeURIComponent(p))
    .join("/");
}

// ✅ Permanent public URL (no signatures, no expiry)
export function publicUrlForKey(key) {
  if (!key) return "";

  // Preferred: your custom domain (Cloudflare proxied or R2 custom domain)
  if (R2_PUBLIC_BASE_URL) return `${R2_PUBLIC_BASE_URL}/${encodeKeyForUrl(key)}`;

  // Fallback ONLY works if you have configured a public bucket/domain on Cloudflare.
  // If this fallback is not public, the browser will get 403.
  if (R2_ACCOUNT_ID && R2_BUCKET) {
    return `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${R2_BUCKET}/${encodeKeyForUrl(key)}`;
  }

  return "";
}

export function isOurAssetUrl(u) {
  try {
    const url = new URL(String(u));
    const host = url.hostname.toLowerCase();

    if (R2_PUBLIC_BASE_URL) {
      const baseHost = new URL(R2_PUBLIC_BASE_URL).hostname.toLowerCase();
      if (host === baseHost) return true;
    }

    if (host.endsWith("r2.cloudflarestorage.com")) return true;
    return false;
  } catch {
    return false;
  }
}

export function makeKey({ kind = "uploads", customerId = "anon", filename = "", contentType = "" } = {}) {
  const folder = safeFolderName(kind);
  const cid = String(customerId || "anon");
  const uuid = crypto.randomUUID();
  const base = safeName(filename || "upload");

  const extGuess = guessExtFromContentType(contentType);
  const ext =
    extGuess && !base.toLowerCase().endsWith(`.${extGuess}`) ? `.${extGuess}` : "";

  return `${folder}/${cid}/${Date.now()}-${uuid}-${base}${ext}`;
}

export async function putBufferToR2({ key, buffer, contentType } = {}) {
  assertR2Configured();
  if (!key) throw new Error("putBufferToR2: key is required.");
  if (!buffer) throw new Error("putBufferToR2: buffer is required.");

  await r2.send(
    new PutObjectCommand({
      Bucket: R2_BUCKET,
      Key: key,
      Body: buffer,
      ContentType: contentType || "application/octet-stream",
      CacheControl: "public, max-age=31536000, immutable",
      ContentDisposition: "inline",
    })
  );

  const publicUrl = publicUrlForKey(key);
  if (!publicUrl) {
    throw new Error(
      "Public URL could not be built. Set R2_PUBLIC_BASE_URL to a permanent public domain."
    );
  }

  return { key, publicUrl, url: publicUrl };
}

export async function storeRemoteImageToR2({ url, kind = "generations", customerId = "anon" } = {}) {
  if (!url) throw new Error("storeRemoteImageToR2: url is required.");

  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`REMOTE_FETCH_FAILED (${resp.status})`);

  const contentType = resp.headers.get("content-type") || "application/octet-stream";
  const arrayBuf = await resp.arrayBuffer();
  const buf = Buffer.from(arrayBuf);

  const key = makeKey({
    kind,
    customerId,
    filename: "remote",
    contentType,
  });

  return putBufferToR2({ key, buffer: buf, contentType });
}

// Backwards-compat shim: if any older code calls a "sign get" helper,
// we still return a permanent public URL (NO expiry).
export async function r2PutAndSignGet({ key, buffer, contentType } = {}) {
  const stored = await putBufferToR2({ key, buffer, contentType });
  return {
    key: stored.key,
    // historically "getUrl" was signed/expiring; now it's permanent.
    getUrl: stored.publicUrl,
    publicUrl: stored.publicUrl,
    url: stored.publicUrl,
  };
}

// dataURL parsing used by server.js
export function parseDataUrl(dataUrl) {
  const s = String(dataUrl || "");
  const m = s.match(/^data:([^;]+);base64,(.+)$/);
  if (!m) throw new Error("Invalid dataUrl format (expected data:<mime>;base64,...)");

  const contentType = m[1] || "application/octet-stream";
  const b64 = m[2] || "";
  const buffer = Buffer.from(b64, "base64");
  const ext = guessExtFromContentType(contentType);

  return { buffer, contentType, ext };
} fourth //mina-editorial-ai/mina-db-supabase.js
// mina-db-supabase.js
import crypto from "node:crypto";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

// Service-role client (server-side only)
export const supabaseAdmin =
  SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
    ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
        auth: { persistSession: false, autoRefreshToken: false },
      })
    : null;

export function isSupabaseDataReady() {
  return !!supabaseAdmin;
}

function nowIso() {
  return new Date().toISOString();
}

function safeShopifyId(customerIdRaw) {
  const v = customerIdRaw === null || customerIdRaw === undefined ? "" : String(customerIdRaw);
  return v.trim() || "anonymous";
}

function isUuid(v) {
  return typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
}

export function normalizeSessionId(sessionIdRaw) {
  const s = (sessionIdRaw || "").toString().trim();
  if (!s) return "";
  if (s.startsWith("sess_")) {
    const maybe = s.slice("sess_".length);
    return isUuid(maybe) ? maybe : s; // fallback if weird
  }
  return s;
}

export function normalizeFeedbackId(feedbackIdRaw) {
  const s = (feedbackIdRaw || "").toString().trim();
  if (!s) return "";
  if (s.startsWith("fb_")) {
    const maybe = s.slice("fb_".length);
    return isUuid(maybe) ? maybe : s;
  }
  return s;
}

async function getCustomerRow(shopifyCustomerId) {
  if (!supabaseAdmin) return null;

  const { data, error } = await supabaseAdmin
    .from("customers")
    .select("shopify_customer_id,user_id,email,credits,meta,created_at,updated_at,last_active,expires_at")
    .eq("shopify_customer_id", shopifyCustomerId)
    .maybeSingle();

  if (error) throw error;
  return data || null;
}

async function createCustomerRow({ shopifyCustomerId, userId, email, defaultCredits }) {
  if (!supabaseAdmin) return null;

  const ts = nowIso();
  const payload = {
    shopify_customer_id: shopifyCustomerId,
    user_id: userId || null,
    email: email || null,
    credits: Number.isFinite(defaultCredits) ? defaultCredits : 0,
    last_active: ts,
    created_at: ts,
    updated_at: ts,
    meta: {},
  };

  const { data, error } = await supabaseAdmin
    .from("customers")
    .insert(payload)
    .select("shopify_customer_id,user_id,email,credits,meta,created_at,updated_at,last_active,expires_at")
    .single();

  if (error) throw error;
  return data;
}

async function touchCustomer({ shopifyCustomerId, userId, email, patchMeta }) {
  if (!supabaseAdmin) return;

  const ts = nowIso();
  const updates = {
    updated_at: ts,
    last_active: ts,
  };

  // Only set these if provided (don’t overwrite with null)
  if (userId) updates.user_id = userId;
  if (email) updates.email = email;

  if (patchMeta && typeof patchMeta === "object") {
    // merge meta client-side
    const existing = await getCustomerRow(shopifyCustomerId);
    const nextMeta = { ...(existing?.meta || {}), ...patchMeta };
    updates.meta = nextMeta;
  }

  const { error } = await supabaseAdmin
    .from("customers")
    .update(updates)
    .eq("shopify_customer_id", shopifyCustomerId);

  if (error) throw error;
}

export async function getOrCreateCustomer({
  customerId,
  userId,
  email,
  defaultCredits = 0,
}) {
  const shopifyCustomerId = safeShopifyId(customerId);
  if (!supabaseAdmin) return null;

  let row = await getCustomerRow(shopifyCustomerId);
  if (!row) {
    row = await createCustomerRow({
      shopifyCustomerId,
      userId,
      email,
      defaultCredits,
    });
  } else {
    // update last_active (+ attach user/email if they exist)
    await touchCustomer({ shopifyCustomerId, userId, email });
  }
  return row;
}

/**
 * Returns: { balance, customer, historyLength }
 */
export async function getCreditsRecordDb({
  customerId,
  userId,
  email,
  defaultFreeCredits = 0,
}) {
  if (!supabaseAdmin) {
    return { balance: null, customer: null, historyLength: null };
  }

  const cust = await getOrCreateCustomer({
    customerId,
    userId,
    email,
    defaultCredits: defaultFreeCredits,
  });

  // Count txns (optional, can be null if you want cheaper)
  const { count, error: countErr } = await supabaseAdmin
    .from("credit_transactions")
    .select("id", { count: "exact", head: true })
    .eq("shopify_customer_id", cust.shopify_customer_id);

  if (countErr) {
    // don’t fail the request for count
    return { balance: cust.credits ?? 0, customer: cust, historyLength: null };
  }

  return { balance: cust.credits ?? 0, customer: cust, historyLength: count ?? null };
}

/**
 * Adjust credits + insert credit_transactions row.
 * NOTE: This is not fully atomic without a SQL function. Good enough for low concurrency.
 */
export async function adjustCreditsDb({
  customerId,
  delta,
  reason = "adjustment",
  source = "api",
  refType = null,
  refId = null,
  userId,
  email,
  defaultFreeCredits = 0,
}) {
  if (!supabaseAdmin) {
    return { ok: false, balance: null };
  }

  const cust = await getOrCreateCustomer({
    customerId,
    userId,
    email,
    defaultCredits: defaultFreeCredits,
  });

  const nextBalance = (cust.credits ?? 0) + Number(delta || 0);
  const ts = nowIso();

  // 1) update customer balance
  const { error: updErr } = await supabaseAdmin
    .from("customers")
    .update({
      credits: nextBalance,
      updated_at: ts,
      last_active: ts,
      ...(userId ? { user_id: userId } : {}),
      ...(email ? { email } : {}),
    })
    .eq("shopify_customer_id", cust.shopify_customer_id);

  if (updErr) throw updErr;

  // 2) insert transaction
  const txn = {
    id: crypto.randomUUID(),
    shopify_customer_id: cust.shopify_customer_id,
    delta: Number(delta || 0),
    reason: String(reason || "adjustment"),
    source: String(source || "api"),
    ref_type: refType ? String(refType) : null,
    ref_id: refId ? String(refId) : null,
    created_at: ts,
  };

  const { error: insErr } = await supabaseAdmin.from("credit_transactions").insert(txn);
  if (insErr) {
    // If txn insert fails, balance already updated. Log and continue.
    console.error("[credits] Failed to insert credit_transactions row", insErr);
  }

  return { ok: true, balance: nextBalance };
}

export async function upsertAppSessionDb({ id, shopifyCustomerId, platform, title, createdAt }) {
  if (!supabaseAdmin) return;

  const sid = normalizeSessionId(id);
  if (!sid || !isUuid(sid)) {
    throw new Error(`Session id must be UUID (got: ${id})`);
  }

  const payload = {
    id: sid,
    shopify_customer_id: safeShopifyId(shopifyCustomerId),
    platform: (platform || "tiktok").toString(),
    title: (title || "Mina session").toString(),
    created_at: createdAt || nowIso(),
  };

  const { error } = await supabaseAdmin.from("sessions").upsert(payload, { onConflict: "id" });
  if (error) throw error;
}

export async function upsertFeedbackDb(feedback) {
  if (!supabaseAdmin) return;

  const fid = normalizeFeedbackId(feedback?.id);
  if (!fid || !isUuid(fid)) {
    throw new Error(`Feedback id must be UUID (got: ${feedback?.id})`);
  }

  const payload = {
    id: fid,
    shopify_customer_id: safeShopifyId(feedback.shopify_customer_id),
    session_id: feedback.session_id ? normalizeSessionId(feedback.session_id) : null,
    generation_id: feedback.generation_id ? String(feedback.generation_id) : null,
    result_type: String(feedback.result_type || "image"),
    platform: feedback.platform ? String(feedback.platform) : null,
    prompt: String(feedback.prompt || ""),
    comment: feedback.comment ? String(feedback.comment) : null,
    image_url: feedback.image_url ? String(feedback.image_url) : null,
    video_url: feedback.video_url ? String(feedback.video_url) : null,
    created_at: feedback.created_at || nowIso(),
  };

  const { error } = await supabaseAdmin.from("feedback").upsert(payload, { onConflict: "id" });
  if (error) throw error;
}

export async function getBillingSettingsDb(customerId) {
  if (!supabaseAdmin) return { enabled: false, monthlyLimitPacks: 0, source: "no-db" };

  const cust = await getOrCreateCustomer({ customerId, defaultCredits: 0 });
  const meta = cust?.meta || {};
  const autoTopup = meta.autoTopup || {};
  return {
    enabled: Boolean(autoTopup.enabled),
    monthlyLimitPacks: Number.isFinite(autoTopup.monthlyLimitPacks)
      ? Math.max(0, Math.floor(autoTopup.monthlyLimitPacks))
      : 0,
    source: "customers.meta",
  };
}

export async function setBillingSettingsDb(customerId, enabled, monthlyLimitPacks) {
  if (!supabaseAdmin) throw new Error("Supabase not configured");

  const cust = await getOrCreateCustomer({ customerId, defaultCredits: 0 });
  const meta = cust?.meta || {};
  const nextMeta = {
    ...meta,
    autoTopup: {
      enabled: Boolean(enabled),
      monthlyLimitPacks: Number.isFinite(monthlyLimitPacks)
        ? Math.max(0, Math.floor(monthlyLimitPacks))
        : 0,
    },
  };

  await touchCustomer({
    shopifyCustomerId: cust.shopify_customer_id,
    patchMeta: nextMeta,
  });

  return {
    enabled: Boolean(nextMeta.autoTopup.enabled),
    monthlyLimitPacks: nextMeta.autoTopup.monthlyLimitPacks,
  };
}

export async function countCustomersDb() {
  if (!supabaseAdmin) return null;
  const { count, error } = await supabaseAdmin
    .from("customers")
    .select("shopify_customer_id", { count: "exact", head: true });
  if (error) throw error;
  return count ?? 0;
}

export async function listCustomersDb(limit = 500) {
  if (!supabaseAdmin) return [];
  const { data, error } = await supabaseAdmin
    .from("customers")
    .select("shopify_customer_id,credits,email,last_active,created_at,updated_at")
    .order("shopify_customer_id", { ascending: true })
    .limit(Math.max(1, Math.min(1000, Number(limit || 500))));
  if (error) throw error;
  return data || [];
}

export async function getCustomerHistoryDb(shopifyCustomerId) {
  if (!supabaseAdmin) return null;
  const sid = safeShopifyId(shopifyCustomerId);

  const [custRes, gensRes, fbRes, txRes] = await Promise.all([
    supabaseAdmin
      .from("customers")
      .select("shopify_customer_id,credits")
      .eq("shopify_customer_id", sid)
      .maybeSingle(),
    supabaseAdmin
      .from("generations")
      .select("*")
      .eq("shopify_customer_id", sid)
      .order("created_at", { ascending: false })
      .limit(500),
    supabaseAdmin
      .from("feedback")
      .select("*")
      .eq("shopify_customer_id", sid)
      .order("created_at", { ascending: false })
      .limit(500),
    supabaseAdmin
      .from("credit_transactions")
      .select("*")
      .eq("shopify_customer_id", sid)
      .order("created_at", { ascending: false })
      .limit(500),
  ]);

  if (custRes.error) throw custRes.error;
  if (gensRes.error) throw gensRes.error;
  if (fbRes.error) throw fbRes.error;
  if (txRes.error) throw txRes.error;

  return {
    customerId: sid,
    credits: {
      balance: custRes.data?.credits ?? 0,
      history: txRes.data || [],
    },
    generations: gensRes.data || [],
    feedbacks: fbRes.data || [],
  };
}

export async function getAdminOverviewDb() {
  if (!supabaseAdmin) return null;

  const [gensRes, fbRes] = await Promise.all([
    supabaseAdmin.from("generations").select("*").order("created_at", { ascending: false }).limit(500),
    supabaseAdmin.from("feedback").select("*").order("created_at", { ascending: false }).limit(500),
  ]);

  if (gensRes.error) throw gensRes.error;
  if (fbRes.error) throw fbRes.error;

  return {
    generations: gensRes.data || [],
    feedbacks: fbRes.data || [],
  };
}
/ src/MinaApp.tsx
// ============================================================================
// [PART 1 START] Imports & environment
// ============================================================================
import React, { useEffect, useMemo, useState, useRef } from "react";
import { supabase } from "./lib/supabaseClient";
import StudioLeft from "./StudioLeft";
import { loadAdminConfig } from "./lib/adminConfig";
import AdminLink from "./components/AdminLink"; 


const API_BASE_URL =
  import.meta.env.VITE_MINA_API_BASE_URL ||
  "https://mina-editorial-ai-api.onrender.com";

const TOPUP_URL =
  import.meta.env.VITE_MINA_TOPUP_URL ||
  "https://www.faltastudio.com/checkouts/cn/hWN6EhbqQW5KrdIuBO3j5HKV/en-ae?_r=AQAB9NY_ccOV_da3y7VmTxJU-dDoLEOCdhP9sg2YlvDwLQQ";

const LIKE_STORAGE_KEY = "minaLikedMap";
const LEGACY_CUSTOMER_STORAGE_KEY = "minaLegacyCustomerId";

function readLegacyCustomerId(fallback: string): string {
  try {
    if (typeof window !== "undefined") {
      const v = window.localStorage.getItem(LEGACY_CUSTOMER_STORAGE_KEY);
      if (v && v.trim()) return v.trim();
    }
  } catch {
    // ignore
  }
  return fallback;
}

function persistLegacyCustomerId(id: string) {
  try {
    if (typeof window !== "undefined") window.localStorage.setItem(LEGACY_CUSTOMER_STORAGE_KEY, id);
  } catch {
    // ignore
  }
}
// ============================================================================
// [PART 1 END]
// ============================================================================


// ============================================================================
// [PART 2 START] Types
// ============================================================================
type HealthState = {
  ok: boolean;
  message?: string;
};

type CreditsMeta = {
  imageCost: number;
  motionCost: number;

  // ISO date when the current credits expire (optional, if backend returns it)
  expiresAt?: string | null;
};

type CreditsState = {
  balance: number;
  meta?: CreditsMeta;
};

type GptMeta = {
  userMessage?: string;   // what you want to show to the user
  imageTexts?: string[];  // optional: short vision analysis strings
  input?: string;         // optional: raw prompt sent to GPT (if you return it)
  output?: string;        // optional: raw GPT output (if you return it)
  model?: string;         // optional: which model used
};

type EditorialResponse = {
  ok: boolean;
  prompt?: string;
  imageUrl?: string;
  imageUrls?: string[];
  generationId?: string;
  sessionId?: string;

  // ✅ Add this
  gpt?: GptMeta;

  credits?: {
    balance: number;
    cost?: number;
  };
};

type MotionSuggestResponse = {
  ok: boolean;
  suggestion?: string;

  // optional (only if your backend returns it)
  gpt?: GptMeta;
};

type MotionResponse = {
  ok: boolean;
  prompt?: string;
  videoUrl?: string;
  generationId?: string;
  sessionId?: string;

  // ✅ Add this (only if your backend returns it)
  gpt?: GptMeta;

  credits?: {
    balance: number;
    cost?: number;
  };
};


type GenerationRecord = {
  id: string;
  type: string;
  sessionId: string;
  customerId: string;
  platform: string;
  prompt: string;
  outputUrl: string;
  createdAt: string;
  meta?: {
    tone?: string;
    platform?: string;
    minaVisionEnabled?: boolean;
    stylePresetKey?: string;
    productImageUrl?: string;
    styleImageUrls?: string[];
    aspectRatio?: string;
    [key: string]: unknown;
  } | null;
};

type FeedbackRecord = {
  id: string;
  customerId: string;
  resultType: string;
  platform: string;
  prompt: string;
  comment: string;
  imageUrl?: string;
  videoUrl?: string;
  createdAt: string;
};

type HistoryResponse = {
  ok: boolean;
  customerId: string;
  credits: {
    balance: number;

    // Optional: when the current credits expire (if backend returns it)
    expiresAt?: string | null;

    history?: {
      id: string;
      amount: number;
      reason: string;
      createdAt: string;
    }[];
  };
  generations: GenerationRecord[];
  feedbacks: FeedbackRecord[];
};

type StillItem = {
  id: string;
  url: string;
  createdAt: string;
  prompt: string;
  aspectRatio?: string;
};

type MotionItem = {
  id: string;
  url: string;
  createdAt: string;
  prompt: string;
};

type CustomStyleImage = {
  id: string;
  url: string; // blob url for UI
  file: File;
};

type CustomStylePreset = {
  key: string; // "custom-..."
  label: string; // editable name
  thumbDataUrl: string; // persisted
};

type UploadKind = "file" | "url";

type UploadItem = {
  id: string;
  kind: UploadKind;

  // url = UI preview (blob: or http)
  url: string;

  // remoteUrl = REAL stored URL in R2 (https://...)
  remoteUrl?: string;

  file?: File; // only for kind=file
  uploading?: boolean;
  error?: string;
};

type UploadPanelKey = "product" | "logo" | "inspiration";

type AspectKey = "9-16" | "3-4" | "2-3" | "1-1";

type AspectOption = {
  key: AspectKey;
  ratio: string;
  label: string;
  subtitle: string;
  platformKey: string;
};

type MinaAppProps = {
  initialCustomerId?: string;
};
// ============================================================================
// [PART 2 END]
// ============================================================================

// ============================================================================
// [PART 3 START] Constants & helpers
// ============================================================================
const ASPECT_OPTIONS: AspectOption[] = [
  { key: "9-16", ratio: "9:16", label: "9:16", subtitle: "Tiktok/Reel", platformKey: "tiktok" },
  { key: "3-4", ratio: "3:4", label: "3:4", subtitle: "Post", platformKey: "instagram-post" },
  { key: "2-3", ratio: "2:3", label: "2:3", subtitle: "Printing", platformKey: "print" },
  { key: "1-1", ratio: "1:1", label: "1:1", subtitle: "Square", platformKey: "square" },
];

const ASPECT_ICON_URLS: Record<AspectKey, string> = {
  "9-16":
    "https://cdn.shopify.com/s/files/1/0678/9254/3571/files/tiktokreels_icon_e116174c-afc7-4174-9cf0-f24a07c8517b.svg?v=1765425956",
  "3-4":
    "https://cdn.shopify.com/s/files/1/0678/9254/3571/files/post_icon_f646fcb5-03be-4cf5-b25c-b1ec38f6794e.svg?v=1765425956",
  "2-3":
    "https://cdn.shopify.com/s/files/1/0678/9254/3571/files/Printing_icon_c7252c7d-863e-4efb-89c4-669261119d61.svg?v=1765425956",
  "1-1":
    "https://cdn.shopify.com/s/files/1/0678/9254/3571/files/square_icon_901d47a8-44a8-4ab9-b412-2224e97fd9d9.svg?v=1765425956",
};

// Map our UI ratios to Replicate-safe values
const REPLICATE_ASPECT_RATIO_MAP: Record<string, string> = {
  "9:16": "9:16",
  "3:4": "3:4",
  "2:3": "2:3",
  "1:1": "1:1",
};

const MINA_THINKING_DEFAULT = [
  "Sketching ideas…",
  "Let me weave a scene…",
  "Curating tiny details…",
  "Whispering to the lens…",
  "Layering mood + motion…",
  "Painting with light…",
  "Mixing silk, glass, shine…",
  "Checking the perfect drip…",
  "Setting the camera drift…",
  "Dreaming in slow loops…",
];

const MINA_FILLER_DEFAULT = ["typing…", "breathing…", "thinking aloud…", "refining…"];

const ADMIN_ALLOWLIST_TABLE = "admin_allowlist";

const STYLE_PRESETS = [
  {
    key: "vintage",
    label: "Vintage",
    thumb: "https://cdn.shopify.com/s/files/1/0678/9254/3571/files/Vintage_1.png?v=1765457775",
  },
  {
    key: "gradient",
    label: "Gradient",
    thumb: "https://cdn.shopify.com/s/files/1/0678/9254/3571/files/Gradient.png?v=1765457775",
  },
  {
    key: "back-light",
    label: "Back light",
    thumb: "https://cdn.shopify.com/s/files/1/0678/9254/3571/files/Backlight.png?v=1765457775",
  },
] as const;

const PANEL_LIMITS: Record<UploadPanelKey, number> = {
  product: 1,
  logo: 1,
  inspiration: 4,
};

const CUSTOM_STYLES_LS_KEY = "minaCustomStyles_v1";

// Premium reveal timing
const PILL_INITIAL_DELAY_MS = 260; // when the first pill starts appearing
const PILL_STAGGER_MS = 90; // delay between each pill (accordion / wave)
const PILL_SLIDE_DURATION_MS = 320; // slide + fade duration (must exceed stagger for smoothness)
const PANEL_REVEAL_DELAY_MS = PILL_INITIAL_DELAY_MS; // panel shows with first pill
const CONTROLS_REVEAL_DELAY_MS = 0; // vision + create show later
const GROUP_FADE_DURATION_MS = 420; // shared fade timing for pills/panels/controls/textarea
const TYPING_HIDE_DELAY_MS = 2000; // wait before hiding UI when typing starts
const TYPING_REVEAL_DELAY_MS = 600; // wait before showing UI after typing stops
const TEXTAREA_FLOAT_DISTANCE_PX = 12; // tiny translate to avoid layout jump

function classNames(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

function getInitialCustomerId(initialCustomerId?: string): string {
  try {
    if (typeof window !== "undefined") {
      const params = new URLSearchParams(window.location.search);
      const fromUrl = params.get("customerId");
      if (fromUrl && fromUrl.trim().length > 0) return fromUrl.trim();

      const stored = window.localStorage.getItem("minaCustomerId");
      if (stored && stored.trim().length > 0) return stored.trim();
    }
  } catch {
    // ignore
  }
  if (initialCustomerId && initialCustomerId.trim().length > 0) return initialCustomerId.trim();
  return "anonymous";
}

function persistCustomerId(id: string) {
  try {
    if (typeof window !== "undefined") window.localStorage.setItem("minaCustomerId", id);
  } catch {
    // ignore
  }
}

function formatTime(ts?: string | null) {
  if (!ts) return "";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  return d.toLocaleString();
}

function formatDateOnly(ts?: string | null) {
  if (!ts) return "—";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function padEditorialNumber(value: number | string) {
  const clean = typeof value === "number" ? value : Number(value);
  if (Number.isFinite(clean)) {
    return clean.toString().padStart(2, "0");
  }
  return String(value).trim() || "00";
}

// ✅ Detect signed URLs (R2/S3/CloudFront style) so we never break them by adding params
function hasSignedQuery(searchParams: URLSearchParams) {
  return (
    searchParams.has("X-Amz-Signature") ||
    searchParams.has("X-Amz-Credential") ||
    searchParams.has("X-Amz-Algorithm") ||
    searchParams.has("X-Amz-Date") ||
    searchParams.has("X-Amz-Expires") ||
    searchParams.has("Signature") ||
    searchParams.has("Expires") ||
    searchParams.has("Key-Pair-Id") ||
    searchParams.has("Policy") ||
    Array.from(searchParams.keys()).some((k) => k.toLowerCase().includes("signature"))
  );
}

// ✅ Turn a signed URL into a non-expiring base URL (works when your R2 objects are public)
function stripSignedQuery(url: string) {
  try {
    const parsed = new URL(url);
    if (!hasSignedQuery(parsed.searchParams)) return url;
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return url;
  }
}

// ✅ Replicate detection (so we never show it in Profile)
function isReplicateUrl(url: string) {
  try {
    const h = new URL(url).hostname.toLowerCase();
    return h.includes("replicate.delivery") || h.includes("replicate.com");
  } catch {
    return false;
  }
}

// ✅ Preview URL: never modify signed URLs (that’s what caused the ❓ icons)
function toPreviewUrl(url: string) {
  try {
    const parsed = new URL(url);

    // If signed → DO NOT touch query params, and also strip to stable base (no expiry)
    if (hasSignedQuery(parsed.searchParams)) return stripSignedQuery(parsed.toString());

    // Only add resize params for Shopify CDN (safe)
    if (parsed.hostname.includes("cdn.shopify.com")) {
      if (!parsed.searchParams.has("w")) parsed.searchParams.set("w", "900");
      if (!parsed.searchParams.has("auto")) parsed.searchParams.set("auto", "format");
    }

    return parsed.toString();
  } catch {
    return url;
  }
}

function safeIsHttpUrl(url: string) {
  return /^https?:\/\//i.test(url);
}

function looksLikeImageUrl(url: string) {
  const u = url.trim();
  if (!safeIsHttpUrl(u)) return false;
  return /\.(png|jpg|jpeg|webp|gif|avif)(\?.*)?$/i.test(u) || u.includes("cdn.shopify.com");
}

async function fileToDataUrl(file: File): Promise<string> {
  return await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Failed to read file"));
    reader.onload = () => resolve(String(reader.result || ""));
    reader.readAsDataURL(file);
  });
}

function loadCustomStyles(): CustomStylePreset[] {
  try {
    const raw = window.localStorage.getItem(CUSTOM_STYLES_LS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as CustomStylePreset[];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (x) =>
        x &&
        typeof x.key === "string" &&
        typeof x.label === "string" &&
        typeof x.thumbDataUrl === "string"
    );
  } catch {
    return [];
  }
}

function saveCustomStyles(styles: CustomStylePreset[]) {
  try {
    window.localStorage.setItem(CUSTOM_STYLES_LS_KEY, JSON.stringify(styles));
  } catch {
    // ignore
  }
}
// ============================================================================
// [PART 3 END]
// ============================================================================


// ==============================================
// PART UI HELPERS (pills/panels)
// ==============================================
type PanelKey = "product" | "logo" | "inspiration" | "style" | null;

type CustomStyle = {
  id: string; // custom-...
  key: string; // used as stylePresetKey
  label: string;
  thumbUrl: string; // dataURL or https
  createdAt: string;
};

function isHttpUrl(url: string) {
  return /^https?:\/\//i.test(url);
}

function extractFirstHttpUrl(text: string) {
  const m = text.match(/https?:\/\/[^\s)]+/i);
  return m ? m[0] : null;
}

function aspectRatioToNumber(ratio: string) {
  const [w, h] = ratio.split(":").map((n) => Number(n) || 0);
  if (!h || !w) return 1;
  return w / h;
}

function pickNearestAspectOption(ratio: number, options: AspectOption[]): AspectOption {
  if (!Number.isFinite(ratio) || ratio <= 0) return options[0];
  return options.reduce((closest, option) => {
    const candidate = aspectRatioToNumber(option.ratio);
    return Math.abs(candidate - ratio) < Math.abs(aspectRatioToNumber(closest.ratio) - ratio)
      ? option
      : closest;
  }, options[0]);
}


// ============================================================================
// [PART 4 START] Component
// ============================================================================
const MinaApp: React.FC<MinaAppProps> = ({ initialCustomerId }) => {
  // -------------------------
  // 4.1 Global tab + customer
  // -------------------------
  const [activeTab, setActiveTab] = useState<"studio" | "profile">("studio");

  // Legacy fallback (anonymous / dev). In production, Supabase user id overrides this.
  const [customerId, setCustomerId] = useState<string>(() => getInitialCustomerId(initialCustomerId));
  const [customerIdInput, setCustomerIdInput] = useState<string>(customerId);

  // Keep a stable “legacy” id around so Profile can still load older archives
  const legacyCustomerIdRef = useRef<string>(customerId);

  useEffect(() => {
    const seeded = readLegacyCustomerId(customerId);
    legacyCustomerIdRef.current = seeded;
    if (seeded && seeded !== "anonymous") persistLegacyCustomerId(seeded);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ✅ Supabase identity (production truth)
  const [authUserId, setAuthUserId] = useState<string | null>(null);

  const [isAdmin, setIsAdmin] = useState(false);
  const [currentUserEmail, setCurrentUserEmail] = useState<string | null>(null);
  const [adminConfig, setAdminConfig] = useState(loadAdminConfig());
  const [computedStylePresets, setComputedStylePresets] = useState(STYLE_PRESETS);

  // -------------------------
  // 4.2 Health / credits / session
  // -------------------------
  const [health, setHealth] = useState<HealthState | null>(null);
  const [checkingHealth, setCheckingHealth] = useState(false);

  const [credits, setCredits] = useState<CreditsState | null>(null);
  const [creditsLoading, setCreditsLoading] = useState(false);

  const [sessionId, setSessionId] = useState<string | null>(null);
  const [sessionTitle, setSessionTitle] = useState("Mina Studio session");

  // -------------------------
  // 4.3 Studio – brief + steps
  // -------------------------
  const [brief, setBrief] = useState("");
  const [stillBrief, setStillBrief] = useState("");
  const [tone] = useState("still-life");
  const [, setPlatform] = useState("tiktok");
  const [aspectIndex, setAspectIndex] = useState(2);
  const [animateAspectKey, setAnimateAspectKey] = useState<AspectKey>(ASPECT_OPTIONS[aspectIndex].key);
  const [animateMode, setAnimateMode] = useState(false);

  // Stills
  const [stillItems, setStillItems] = useState<StillItem[]>([]);
  const [stillIndex, setStillIndex] = useState(0);
  const [stillGenerating, setStillGenerating] = useState(false);
  const [stillError, setStillError] = useState<string | null>(null);
  const [lastStillPrompt, setLastStillPrompt] = useState<string>("");

  const [minaMessage, setMinaMessage] = useState("");
  const [minaTalking, setMinaTalking] = useState(false);
// When set, we show THIS instead of placeholder thinking text
const [minaOverrideText, setMinaOverrideText] = useState<string | null>(null);

  // Motion
  const [motionItems, setMotionItems] = useState<MotionItem[]>([]);
  const [motionIndex, setMotionIndex] = useState(0);
  const [motionDescription, setMotionDescription] = useState("");
  const [motionStyleKeys, setMotionStyleKeys] = useState<MotionStyleKey[]>(["fix_camera"]);
  const [motionSuggestLoading, setMotionSuggestLoading] = useState(false);
  const [motionSuggestError, setMotionSuggestError] = useState<string | null>(null);
  const [motionSuggestTyping, setMotionSuggestTyping] = useState(false);
  const [animateAspectRotated, setAnimateAspectRotated] = useState(false);
  const [motionGenerating, setMotionGenerating] = useState(false);
  const [motionError, setMotionError] = useState<string | null>(null);
  const [isRightMediaDark, setIsRightMediaDark] = useState(false);

  // Feedback
  const [feedbackText, setFeedbackText] = useState("");
  const [feedbackSending, setFeedbackSending] = useState(false);
  const [feedbackError, setFeedbackError] = useState<string | null>(null);
  const [likedMap, setLikedMap] = useState<Record<string, boolean>>(() => {
    try {
      const raw = typeof window !== "undefined" ? window.localStorage.getItem(LIKE_STORAGE_KEY) : null;
      return raw ? (JSON.parse(raw) as Record<string, boolean>) : {};
    } catch {
      return {};
    }
  });
  const [likeSubmitting, setLikeSubmitting] = useState(false);

  // Panels (only one open at a time)
  const [activePanel, setActivePanel] = useState<PanelKey>(null);

  // Stage 0 = only textarea
  // Stage 1 = pills fade in (stagger)
  // Stage 2 = panels area available
  // Stage 3 = vision + create available
  const [uiStage, setUiStage] = useState<0 | 1 | 2 | 3>(0);
  const stageT2Ref = useRef<number | null>(null);
  const stageT3Ref = useRef<number | null>(null);

  // Global drag overlay (whole page)
  const [globalDragging, setGlobalDragging] = useState(false);
  const dragDepthRef = useRef(0);

  // Upload buckets
  const [uploads, setUploads] = useState<Record<UploadPanelKey, UploadItem[]>>({
    product: [],
    logo: [],
    inspiration: [],
  });

  // Style selection (hover selects too)
  const [stylePresetKey, setStylePresetKey] = useState<string>("vintage");
  const [minaVisionEnabled, setMinaVisionEnabled] = useState(true);

  // Inline rename for styles (no new panel)
  const [styleLabelOverrides, setStyleLabelOverrides] = useState<Record<string, string>>(() => {
    try {
      const raw = window.localStorage.getItem("minaStyleLabelOverrides");
      return raw ? (JSON.parse(raw) as Record<string, string>) : {};
    } catch {
      return {};
    }
  });

  const [customStyles, setCustomStyles] = useState<CustomStyle[]>(() => {
    try {
      const raw = window.localStorage.getItem("minaCustomStyles");
      return raw ? (JSON.parse(raw) as CustomStyle[]) : [];
    } catch {
      return [];
    }
  });

  const [editingStyleKey, setEditingStyleKey] = useState<string | null>(null);
  const [editingStyleValue, setEditingStyleValue] = useState<string>("");

  useEffect(() => {
    setAdminConfig(loadAdminConfig());
    const handler = () => setAdminConfig(loadAdminConfig());
    window.addEventListener("storage", handler);
    return () => window.removeEventListener("storage", handler);
  }, []);

  useEffect(() => {
    const allowedMotionKeys: MotionStyleKey[] = ["melt", "drop", "expand", "satisfying", "slow_motion", "fix_camera"];
    const fromConfig = adminConfig.styles?.movementKeywords || [];
    const filtered = fromConfig.filter((k): k is MotionStyleKey => allowedMotionKeys.includes(k as MotionStyleKey));
    if (filtered.length) setMotionStyleKeys(filtered);

    const publishedPresets = (adminConfig.styles?.presets || [])
      .filter((p) => p.status === "published")
      .map((p) => ({ key: p.id, label: p.name, thumb: p.heroImage || p.images[0] || "" }));
    setComputedStylePresets([...STYLE_PRESETS, ...publishedPresets]);
  }, [adminConfig]);

  // -------------------------
  // 4.4 History (profile)
  // -------------------------
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [historyGenerations, setHistoryGenerations] = useState<GenerationRecord[]>([]);
  const [historyFeedbacks, setHistoryFeedbacks] = useState<FeedbackRecord[]>([]);
  const [visibleHistoryCount, setVisibleHistoryCount] = useState(20);
  const [numberMap, setNumberMap] = useState<Record<string, string>>(() => {
    try {
      const raw = typeof window !== "undefined" ? window.localStorage.getItem("minaProfileNumberMap") : null;
      return raw ? (JSON.parse(raw) as Record<string, string>) : {};
    } catch {
      return {};
    }
  });
  const [editingNumberId, setEditingNumberId] = useState<string | null>(null);
  const [editingNumberValue, setEditingNumberValue] = useState("");
  const [brandingLeft, setBrandingLeft] = useState({
    title: "MINA AI",
    accent: "Taste",
    handle: "@mina.editorial.ai",
  });
  const [brandingRight, setBrandingRight] = useState({
    handle: "@madani_branding",
    note: "Trained by Madani",
  });
  const [brandingEditing, setBrandingEditing] = useState<"left" | "right" | null>(null);

  // -------------------------
  // 4.5 Upload refs / drag state
  // -------------------------
  const productInputRef = useRef<HTMLInputElement | null>(null);
  const logoInputRef = useRef<HTMLInputElement | null>(null);
  const inspirationInputRef = useRef<HTMLInputElement | null>(null);

  // -------------------------
  // 4.6 Brief helper hint ("Describe more")
  // -------------------------
  const [showDescribeMore, setShowDescribeMore] = useState(false);
  const describeMoreTimeoutRef = useRef<number | null>(null);
  const [isTyping, setIsTyping] = useState(false);
  const typingCalmTimeoutRef = useRef<number | null>(null);
  const typingHideTimeoutRef = useRef<number | null>(null);
  const typingRevealTimeoutRef = useRef<number | null>(null);
  const [typingUiHidden, setTypingUiHidden] = useState(false);

  useEffect(() => {
    return () => {
      if (describeMoreTimeoutRef.current !== null) {
        window.clearTimeout(describeMoreTimeoutRef.current);
      }
      if (typingCalmTimeoutRef.current !== null) {
        window.clearTimeout(typingCalmTimeoutRef.current);
      }
      if (typingHideTimeoutRef.current !== null) {
        window.clearTimeout(typingHideTimeoutRef.current);
      }
      if (typingRevealTimeoutRef.current !== null) {
        window.clearTimeout(typingRevealTimeoutRef.current);
      }
    };
  }, []);

  // -------------------------
  // 4.7 Brief scroll ref
  // -------------------------
  const briefShellRef = useRef<HTMLDivElement | null>(null);
  const briefInputRef = useRef<HTMLTextAreaElement | null>(null);

  // -------------------------
  // 4.8 Custom style modal + custom saved styles
  // -------------------------
  const [customStylePanelOpen, setCustomStylePanelOpen] = useState(false);
  const [customStyleImages, setCustomStyleImages] = useState<CustomStyleImage[]>([]);
  const [customStyleHeroId, setCustomStyleHeroId] = useState<string | null>(null);
  const [customStyleHeroThumb, setCustomStyleHeroThumb] = useState<string | null>(null);
  const [customStyleTraining, setCustomStyleTraining] = useState(false);
  const [customStyleError, setCustomStyleError] = useState<string | null>(null);
  const customStyleInputRef = useRef<HTMLInputElement | null>(null);
  const loadMoreRef = useRef<HTMLDivElement | null>(null);

  const [customPresets, setCustomPresets] = useState<CustomStylePreset[]>(() => {
    if (typeof window === "undefined") return [];
    return loadCustomStyles();
  });

  // -------------------------
  // 4.9 Stable refs for unmount cleanup (avoid undefined productItems/etc)
  // -------------------------
  const uploadsRef = useRef(uploads);
  const customStyleHeroThumbRef = useRef<string | null>(customStyleHeroThumb);
  const customStyleImagesRef = useRef<CustomStyleImage[]>(customStyleImages);

  useEffect(() => {
    uploadsRef.current = uploads;
  }, [uploads]);

  useEffect(() => {
    customStyleHeroThumbRef.current = customStyleHeroThumb;
  }, [customStyleHeroThumb]);

  useEffect(() => {
    customStyleImagesRef.current = customStyleImages;
  }, [customStyleImages]);

  useEffect(() => {
    if (animateMode) {
      const currentBrief = brief;
      setStillBrief(currentBrief);
      setBrief(motionDescription || currentBrief);
    } else {
      const currentBrief = brief;
      setMotionDescription(currentBrief);
      setBrief(stillBrief || currentBrief);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [animateMode]);

  useEffect(() => {
    try {
      if (typeof window !== "undefined") {
        window.localStorage.setItem("minaProfileNumberMap", JSON.stringify(numberMap));
      }
    } catch {
      // ignore
    }
  }, [numberMap]);

  useEffect(() => {
    setVisibleHistoryCount(20);
  }, [historyGenerations]);

  useEffect(() => {
    if (activeTab !== "profile") return undefined;
    const target = loadMoreRef.current;
    if (!target) return undefined;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) {
          setVisibleHistoryCount((count) =>
            Math.min(historyGenerations.length, count + Math.max(10, Math.floor(count * 0.2)))
          );
        }
      },
      { rootMargin: "1200px 0px 1200px 0px" }
    );

    observer.observe(target);
    return () => observer.disconnect();
  }, [activeTab, historyGenerations.length]);

  // ========================================================================
  // [PART 5 START] Derived values (the “rules” you requested)
  // ========================================================================
  const briefLength = brief.trim().length;
  const stillBriefLength = stillBrief.trim().length;
  const uploadsPending = Object.values(uploads).some((arr) => arr.some((it) => it.uploading));
  // ✅ Production customer identity: always use Supabase user id when logged in
  const effectiveCustomerId = authUserId || customerId;

  // ✅ Always show newest first in Profile
  const sortedHistoryGenerations = useMemo(() => {
    const copy = [...historyGenerations];
    copy.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    return copy;
  }, [historyGenerations]);

  const historyIndexMap = useMemo(
    () =>
      sortedHistoryGenerations.reduce<Record<string, number>>((acc, item, idx) => {
        acc[item.id] = idx;
        return acc;
      }, {}),
    [sortedHistoryGenerations]
  );

  const visibleHistory = useMemo(
    () =>
      sortedHistoryGenerations.slice(0, Math.min(visibleHistoryCount, sortedHistoryGenerations.length)),
    [sortedHistoryGenerations, visibleHistoryCount]
  );

  // UI stages
  const stageHasPills = uiStage >= 1;
  const showPanels = uiStage >= 1;
  const showControls = uiStage >= 3;
  const showPills = stageHasPills && !typingUiHidden;

  const animationTimingVars = useMemo<React.CSSProperties>(
    () => ({
      "--pill-slide-duration": `${PILL_SLIDE_DURATION_MS}ms`,
      "--group-fade-duration": `${GROUP_FADE_DURATION_MS}ms`,
      "--textarea-float-distance": `${TEXTAREA_FLOAT_DISTANCE_PX}px`,
    }),
    []
  );

  // counts for +/✓
  const productCount = uploads.product.length;
  const logoCount = uploads.logo.length;
  const inspirationCount = uploads.inspiration.length;

  const currentAspect = ASPECT_OPTIONS[aspectIndex];
  const latestStill: StillItem | null = stillItems[0] || null;
  const currentStill: StillItem | null = stillItems[stillIndex] || stillItems[0] || null;
  const currentMotion: MotionItem | null = motionItems[motionIndex] || motionItems[0] || null;

  const animateImage = uploads.product[0] || null;
  const animateAspectOption = ASPECT_OPTIONS.find((opt) => opt.key === animateAspectKey) || currentAspect;
  const animateAspectIconUrl = ASPECT_ICON_URLS[animateAspectOption.key];
  const animateImageHttp = animateImage?.remoteUrl && isHttpUrl(animateImage.remoteUrl)
    ? animateImage.remoteUrl
    : animateImage?.url && isHttpUrl(animateImage.url)
      ? animateImage.url
      : "";
  const motionReferenceImageUrl = animateImageHttp || latestStill?.url || "";

  const personalityThinking = useMemo(
    () =>
      adminConfig.ai?.personality?.thinking?.length
        ? adminConfig.ai.personality.thinking
        : MINA_THINKING_DEFAULT,
    [adminConfig.ai?.personality?.thinking]
  );

  const personalityFiller = useMemo(
    () =>
      adminConfig.ai?.personality?.filler?.length
        ? adminConfig.ai.personality.filler
        : MINA_FILLER_DEFAULT,
    [adminConfig.ai?.personality?.filler]
  );

  const imageCost = credits?.meta?.imageCost ?? adminConfig.pricing?.imageCost ?? 1;
  const motionCost = credits?.meta?.motionCost ?? adminConfig.pricing?.motionCost ?? 5;

  const briefHintVisible = showDescribeMore;

  useEffect(() => {
    if (isTyping) {
      if (typingRevealTimeoutRef.current !== null) {
        window.clearTimeout(typingRevealTimeoutRef.current);
        typingRevealTimeoutRef.current = null;
      }
      if (typingHideTimeoutRef.current === null && !typingUiHidden) {
        typingHideTimeoutRef.current = window.setTimeout(() => {
          setTypingUiHidden(true);
          typingHideTimeoutRef.current = null;
        }, TYPING_HIDE_DELAY_MS);
      }
      return;
    }

    if (typingHideTimeoutRef.current !== null) {
      window.clearTimeout(typingHideTimeoutRef.current);
      typingHideTimeoutRef.current = null;
    }

    typingRevealTimeoutRef.current = window.setTimeout(() => {
      setTypingUiHidden(false);
      typingRevealTimeoutRef.current = null;
    }, TYPING_REVEAL_DELAY_MS);
  }, [isTyping, typingUiHidden]);

  // Style key for API (avoid unknown custom keys)
  const stylePresetKeyForApi = stylePresetKey.startsWith("custom-") ? "custom-style" : stylePresetKey;

  useEffect(() => {
    let cancelled = false;

    const setFromRatio = (ratio: number) => {
      if (cancelled) return;
      const nearest = pickNearestAspectOption(ratio, ASPECT_OPTIONS);
      setAnimateAspectKey(nearest.key);
      setAnimateAspectRotated(ratio > 1);
    };

    const inferFromUrl = (url: string, fallbackRatio?: number) => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => {
        if (cancelled) return;
        const ratio = img.naturalWidth && img.naturalHeight ? img.naturalWidth / img.naturalHeight : 1;
        setFromRatio(ratio || 1);
      };
      img.onerror = () => {
        if (!cancelled && fallbackRatio) setFromRatio(fallbackRatio);
      };
      img.src = url;
    };

    const primaryUrl = animateImage?.remoteUrl || animateImage?.url;
    if (primaryUrl) {
      inferFromUrl(primaryUrl, aspectRatioToNumber(currentAspect.ratio));
      return () => {
        cancelled = true;
      };
    }

    if (latestStill?.aspectRatio) {
      setFromRatio(aspectRatioToNumber(latestStill.aspectRatio));
      return () => {
        cancelled = true;
      };
    }

    if (latestStill?.url) {
      inferFromUrl(latestStill.url, aspectRatioToNumber(currentAspect.ratio));
      return () => {
        cancelled = true;
      };
    }

    setFromRatio(aspectRatioToNumber(currentAspect.ratio));

    return () => {
      cancelled = true;
    };
  }, [animateImage?.remoteUrl, animateImage?.url, latestStill?.aspectRatio, latestStill?.url, currentAspect.ratio]);

  useEffect(() => {
    const url = currentMotion?.url || currentStill?.url;
    if (!url) {
      setIsRightMediaDark(false);
      return undefined;
    }

    let cancelled = false;
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      if (cancelled) return;
      try {
        const canvas = document.createElement("canvas");
        canvas.width = 10;
        canvas.height = 10;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        ctx.drawImage(img, 0, 0, 10, 10);
        const data = ctx.getImageData(0, 0, 10, 10).data;
        let total = 0;
        for (let i = 0; i < data.length; i += 4) {
          total += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
        }
        const avg = total / (data.length / 4 || 1);
        setIsRightMediaDark(avg < 90);
      } catch {
        setIsRightMediaDark(false);
      }
    };
    img.onerror = () => {
      if (!cancelled) setIsRightMediaDark(false);
    };
    img.src = url;

    return () => {
      cancelled = true;
    };
  }, [currentMotion?.url, currentStill?.url]);

  const motionTextTrimmed = motionDescription.trim();
  const canCreateMotion = !!motionReferenceImageUrl && motionTextTrimmed.length > 0 && !motionSuggestTyping;
  const minaBusy = stillGenerating || motionGenerating || motionSuggestLoading || motionSuggestTyping;
  // ========================================================================
  // [PART 5 END]
  // ========================================================================

  // ============================================
// PART UI STAGING (premium reveal / no jumping)
// ============================================

// Persist style storage
useEffect(() => {
  try {
    window.localStorage.setItem("minaStyleLabelOverrides", JSON.stringify(styleLabelOverrides));
  } catch {
    // ignore
  }
}, [styleLabelOverrides]);

useEffect(() => {
  try {
    window.localStorage.setItem("minaCustomStyles", JSON.stringify(customStyles));
  } catch {
    // ignore
  }
}, [customStyles]);

useEffect(() => {
  try {
    window.localStorage.setItem(LIKE_STORAGE_KEY, JSON.stringify(likedMap));
  } catch {
    // ignore
  }
}, [likedMap]);

// ----------------------------
// MINA “thinking out loud” UI
// ----------------------------

// 1) Placeholder text WHILE busy (only if no override text)
useEffect(() => {
  if (!minaBusy) return;
  if (minaOverrideText) return;

  setMinaTalking(true);

  const phrases = [...personalityThinking, ...personalityFiller].filter(Boolean);
  let phraseIndex = 0;
  let charIndex = 0;
  let t: number | null = null;

  const CHAR_MS = 35;       // faster typing
  const END_PAUSE_MS = 160; // faster pause

  const tick = () => {
    const phrase = phrases[phraseIndex % phrases.length] || "";
    const nextChar = charIndex + 1;
    const nextSlice = phrase.slice(0, Math.min(nextChar, phrase.length));

    setMinaMessage(nextSlice || personalityFiller[0] || "typing…");

    const reachedEnd = nextChar > phrase.length;
    charIndex = reachedEnd ? 0 : nextChar;
    if (reachedEnd) phraseIndex += 1;

    t = window.setTimeout(tick, reachedEnd ? END_PAUSE_MS : CHAR_MS);
  };

  t = window.setTimeout(tick, CHAR_MS);

  return () => {
    if (t !== null) window.clearTimeout(t);
  };
}, [minaBusy, minaOverrideText, personalityThinking, personalityFiller]);

// 2) When override arrives, type it VERY fast
useEffect(() => {
  if (!minaOverrideText) return;

  setMinaTalking(true);
  setMinaMessage("");

  let cancelled = false;
  let i = 0;
  let t: number | null = null;

  const text = minaOverrideText;
  const CHAR_MS = 6; // very fast

  const tick = () => {
    if (cancelled) return;
    i += 1;
    setMinaMessage(text.slice(0, i));
    if (i < text.length) t = window.setTimeout(tick, CHAR_MS);
  };

  t = window.setTimeout(tick, CHAR_MS);

  return () => {
    cancelled = true;
    if (t !== null) window.clearTimeout(t);
  };
}, [minaOverrideText]);

// 3) When not busy, keep override briefly then clear
useEffect(() => {
  if (minaBusy) return;

  if (minaOverrideText) {
    const hold = window.setTimeout(() => {
      setMinaTalking(false);
      setMinaMessage("");
      setMinaOverrideText(null);
    }, 2200);

    return () => window.clearTimeout(hold);
  }

  setMinaTalking(false);
  setMinaMessage("");
}, [minaBusy, minaOverrideText]);

// ----------------------------
// UI Stage reveal
// ----------------------------
useEffect(() => {
  // Stage 0: only textarea (no pills, no panels)
  if (briefLength <= 0) {
    if (stageT2Ref.current !== null) window.clearTimeout(stageT2Ref.current);
    if (stageT3Ref.current !== null) window.clearTimeout(stageT3Ref.current);
    stageT2Ref.current = null;
    stageT3Ref.current = null;

    setUiStage(0);
    setActivePanel(null);
    setGlobalDragging(false);
    dragDepthRef.current = 0;
    return;
  }

  // Start the reveal ONLY once (when transitioning 0 -> typing)
  if (uiStage === 0) {
    setUiStage(1);
    setActivePanel((prev) => prev ?? "product");

    stageT2Ref.current = window.setTimeout(() => {
      setUiStage((s) => (s < 2 ? 2 : s));
    }, PANEL_REVEAL_DELAY_MS);

    stageT3Ref.current = window.setTimeout(() => {
      setUiStage((s) => (s < 3 ? 3 : s));
    }, CONTROLS_REVEAL_DELAY_MS);
  }
}, [briefLength, uiStage]);


  // ========================================================================
  // [PART 6 START] Effects – persist customer + bootstrap
  // ========================================================================
  useEffect(() => {
    setCustomerIdInput(customerId);
    persistCustomerId(customerId);
  }, [customerId]);

    useEffect(() => {
    let cancelled = false;

    const applySession = async () => {
      try {
        const { data } = await supabase.auth.getSession();
        if (cancelled) return;

        const email = (data.session?.user?.email || "").toLowerCase() || null;
        setCurrentUserEmail(email);

        // Keep legacy fallback: ADMIN_EMAILS
        setIsAdmin(email ? ADMIN_EMAILS.includes(email) : false);

        // Optional: also allow Supabase table allowlist to grant admin
        if (email) {
          const { data: row, error } = await supabase
            .from(ADMIN_ALLOWLIST_TABLE)
            .select("email")
            .eq("email", email)
            .limit(1)
            .maybeSingle();

          if (!cancelled && !error && row?.email) setIsAdmin(true);
        }

        const uid = data.session?.user?.id || null;
        setAuthUserId(uid);

        // ✅ Production: force customerId to Supabase user id when logged in
        if (!cancelled && uid) {
          setCustomerId((prev) => {
            // Preserve any pre-login customerId as “legacy” for archive fallback
            if (prev && prev !== uid && prev !== "anonymous") {
              legacyCustomerIdRef.current = prev;
              persistLegacyCustomerId(prev);
            }
            return prev !== uid ? uid : prev;
          });
          setCustomerIdInput(uid);
        }
      } catch {
        if (!cancelled) {
          setCurrentUserEmail(null);
          setIsAdmin(false);
        }
      }
    };

    void applySession();

    const { data: sub } = supabase.auth.onAuthStateChange(async (_event, session) => {
      if (cancelled) return;

      const email = (session?.user?.email || "").toLowerCase() || null;
      setCurrentUserEmail(email);
      setIsAdmin(email ? ADMIN_EMAILS.includes(email) : false);

      // Optional: allowlist table can grant admin even if not in ADMIN_EMAILS
      if (email) {
        try {
          const { data: row, error } = await supabase
            .from(ADMIN_ALLOWLIST_TABLE)
            .select("email")
            .eq("email", email)
            .limit(1)
            .maybeSingle();

          if (!cancelled && !error && row?.email) setIsAdmin(true);
        } catch {
          // ignore
        }
      }

      const uid = session?.user?.id || null;
      setAuthUserId(uid);

      // ✅ Production: force customerId to Supabase user id when logged in
      if (uid) {
        setCustomerId((prev) => {
          if (prev && prev !== uid && prev !== "anonymous") {
            legacyCustomerIdRef.current = prev;
            persistLegacyCustomerId(prev);
          }
          return prev !== uid ? uid : prev;
        });
        setCustomerIdInput(uid);
      }
    });

    return () => {
      cancelled = true;
      sub.subscription.unsubscribe();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);


  // ========================================================================
  // [PART 6 END]
  // ========================================================================

  // ========================================================================
// [PART 7 START] API helpers
// ========================================================================

// ------------------------------------------------------------------------
// Supabase → API auth bridge
// Every Mina API call remains API-based, but gets Supabase JWT automatically.
// ------------------------------------------------------------------------
const getSupabaseAccessToken = async (): Promise<string | null> => {
  try {
    const { data } = await supabase.auth.getSession();
    return data.session?.access_token || null;
  } catch {
    return null;
  }
};

const apiFetch = async (path: string, init: RequestInit = {}) => {
  if (!API_BASE_URL) throw new Error("Missing API base URL");

  const headers = new Headers(init.headers || {});
  const token = await getSupabaseAccessToken();

  // Attach JWT for your backend to verify (safe even if backend ignores it)
  if (token && !headers.has("Authorization")) {
    headers.set("Authorization", `Bearer ${token}`);
  }

  // Ensure JSON content-type when body is present and caller didn't specify
  if (init.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  return fetch(`${API_BASE_URL}${path}`, { ...init, headers });
};

const handleCheckHealth = async () => {
  if (!API_BASE_URL) return;
  try {
    setCheckingHealth(true);
    const res = await apiFetch("/health");
    const json = (await res.json().catch(() => ({}))) as { ok?: boolean; message?: string };
    setHealth({ ok: json.ok ?? false, message: json.message ?? "" });
  } catch (err: any) {
    setHealth({ ok: false, message: err?.message || "Unable to reach Mina." });
  } finally {
    setCheckingHealth(false);
  }
};

const extractExpiresAt = (obj: any): string | null => {
  const v =
    obj?.expiresAt ??
    obj?.expirationDate ??
    obj?.expiry ??
    obj?.expiration ??
    obj?.meta?.expiresAt ??
    obj?.meta?.expirationDate ??
    obj?.meta?.expiry ??
    obj?.meta?.expiration ??
    null;

  return typeof v === "string" && v.trim() ? v.trim() : null;
};

const fetchCredits = async () => {
  if (!API_BASE_URL || !effectiveCustomerId) return;
  try {
    setCreditsLoading(true);

    const params = new URLSearchParams({ customerId: effectiveCustomerId });
    const res = await apiFetch(`/credits/balance?${params.toString()}`);
    if (!res.ok) return;

    const json = (await res.json().catch(() => ({}))) as any;

    const expiresAt = extractExpiresAt(json);

    setCredits((prev) => ({
      balance: Number(json?.balance ?? prev?.balance ?? 0),
      meta: {
        imageCost: Number(json?.meta?.imageCost ?? prev?.meta?.imageCost ?? adminConfig.pricing?.imageCost ?? 1),
        motionCost: Number(json?.meta?.motionCost ?? prev?.meta?.motionCost ?? adminConfig.pricing?.motionCost ?? 5),
        expiresAt,
      },
    }));
  } catch {
    // silent
  } finally {
    setCreditsLoading(false);
  }
};

const ensureSession = async (): Promise<string | null> => {
  if (sessionId) return sessionId;
  if (!API_BASE_URL || !effectiveCustomerId) return null;

  try {
    const res = await apiFetch("/sessions/start", {
      method: "POST",
      body: JSON.stringify({
        customerId: effectiveCustomerId,
        platform: currentAspect.platformKey,
        title: sessionTitle,
      }),
    });

    if (!res.ok) return null;
    const json = (await res.json()) as { ok: boolean; session?: { id: string; title?: string } };
    if (json.ok && json.session?.id) {
      setSessionId(json.session.id);
      setSessionTitle(json.session.title || sessionTitle);
      return json.session.id;
    }
  } catch {
    // ignore
  }
  return null;
};

const fetchHistoryForCustomer = async (cid: string): Promise<HistoryResponse> => {
  const res = await apiFetch(`/history/customer/${encodeURIComponent(cid)}`);
  if (!res.ok) throw new Error(`Status ${res.status}`);
  const json = (await res.json().catch(() => ({}))) as HistoryResponse;
  if (!json.ok) throw new Error("History error");
  return json;
};

const mergeById = <T extends { id: string }>(a: T[], b: T[]) => {
  const map = new Map<string, T>();
  [...a, ...b].forEach((item) => {
    if (item && item.id) map.set(item.id, item);
  });
  return Array.from(map.values());
};

// fetchHistory: load primary + legacy archives (so Profile never looks empty after auth switch)
const fetchHistory = async () => {
  if (!API_BASE_URL || !effectiveCustomerId) return;

  const primaryId = effectiveCustomerId;
  const legacyId =
    legacyCustomerIdRef.current && legacyCustomerIdRef.current !== primaryId
      ? legacyCustomerIdRef.current
      : null;

  try {
    setHistoryLoading(true);
    setHistoryError(null);

    let primary: HistoryResponse | null = null;
    let legacy: HistoryResponse | null = null;
    let lastErr: any = null;

    try {
      primary = await fetchHistoryForCustomer(primaryId);
    } catch (e) {
      lastErr = e;
      primary = null;
    }

    if (legacyId) {
      try {
        legacy = await fetchHistoryForCustomer(legacyId);
      } catch (e) {
        if (!lastErr) lastErr = e;
        legacy = null;
      }
    }

    if (!primary && !legacy) {
      throw lastErr || new Error("Unable to load history.");
    }

    // Prefer the credits source that has a higher balance (helps during migration)
    const chosenCredits =
      primary?.credits && legacy?.credits
        ? (Number(legacy.credits.balance) > Number(primary.credits.balance) ? legacy.credits : primary.credits)
        : primary?.credits || legacy?.credits;

    if (chosenCredits) {
      setCredits((prev) => ({
        balance: chosenCredits.balance,
        meta: {
          imageCost: prev?.meta?.imageCost ?? adminConfig.pricing?.imageCost ?? 1,
          motionCost: prev?.meta?.motionCost ?? adminConfig.pricing?.motionCost ?? 5,
          expiresAt: chosenCredits.expiresAt ?? prev?.meta?.expiresAt ?? null,
        },
      }));
    }

    const gens = mergeById(primary?.generations || [], legacy?.generations || []);
    const feedbacks = mergeById(primary?.feedbacks || [], legacy?.feedbacks || []);

    // Normalize links into stable R2 (but never drop items if that fails)
    const updated = await Promise.all(
      gens.map(async (g) => {
        const original = g.outputUrl;
        try {
          const r2 = await storeRemoteToR2(original, "generations");
          const stable = stripSignedQuery(r2);
          return { ...g, outputUrl: stable || original };
        } catch {
          return { ...g, outputUrl: original };
        }
      })
    );

    setHistoryGenerations(updated);
    setHistoryFeedbacks(feedbacks);
  } catch (err: any) {
    setHistoryError(err?.message || "Unable to load history.");
  } finally {
    setHistoryLoading(false);
  }
};

useEffect(() => {
  if (activeTab !== "profile") return;
  if (!effectiveCustomerId) return;

  setVisibleHistoryCount(20);
  void fetchCredits();
  void fetchHistory();
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, [activeTab, effectiveCustomerId]);


const getEditorialNumber = (id: string, index: number) => {
  const fallback = padEditorialNumber(index + 1);
  const custom = numberMap[id];
  return custom ? custom : fallback;
};

const handleBeginEditNumber = (id: string, index: number) => {
  if (!isAdmin) return;
  setEditingNumberId(id);
  setEditingNumberValue(getEditorialNumber(id, index));
};

const handleCommitNumber = () => {
  if (!editingNumberId) return;
  const cleaned = editingNumberValue.trim();
  setNumberMap((prev) => ({ ...prev, [editingNumberId]: cleaned || padEditorialNumber(cleaned) }));
  setEditingNumberId(null);
  setEditingNumberValue("");
};

const handleCancelNumberEdit = () => {
  setEditingNumberId(null);
  setEditingNumberValue("");
};

const handleDownloadGeneration = (item: GenerationRecord, label: string) => {
  const link = document.createElement("a");
  link.href = item.outputUrl;
  link.download = `mina-v3-prompt-${label || item.id}`;
  link.target = "_blank";
  link.rel = "noreferrer";
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
};

const handleBrandingChange = (side: "left" | "right", field: string, value: string) => {
  if (side === "left") {
    setBrandingLeft((prev) => ({ ...prev, [field]: value }));
  } else {
    setBrandingRight((prev) => ({ ...prev, [field]: value }));
  }
};

const stopBrandingEdit = () => setBrandingEditing(null);
// ========================================================================
// [PART 7 END]
// ========================================================================

// ==============================
// R2 helpers (upload + store)
// ==============================

// ✅ Pick a URL from backend response, prefer stable/public first
function pickUrlFromR2Response(json: any): string | null {
  if (!json) return null;

  const candidates: any[] = [
    // Prefer public first (non-expiring)
    json.publicUrl,
    json.public_url,
    json.url,
    json.public,

    json.result?.publicUrl,
    json.result?.public_url,
    json.result?.url,

    json.data?.publicUrl,
    json.data?.public_url,
    json.data?.url,

    // Signed LAST (expires)
    json.signedUrl,
    json.signed_url,
    json.result?.signedUrl,
    json.data?.signedUrl,
  ];

  for (const c of candidates) {
    if (typeof c === "string" && c.startsWith("http")) return c;
  }
  return null;
}

// ✅ Ensure non-expiring URL (strip signature query if present)
function normalizeNonExpiringUrl(url: string): string {
  return stripSignedQuery(url);
}

async function uploadFileToR2(panel: UploadPanelKey, file: File): Promise<string> {
  const dataUrl = await fileToDataUrl(file);

  const res = await apiFetch("/api/r2/upload-signed", {
    method: "POST",
    body: JSON.stringify({
      dataUrl,
      kind: panel, // "product" | "logo" | "inspiration"
      customerId: effectiveCustomerId,
    }),
  });

  const json = await res.json().catch(() => ({}));
  if (!res.ok || json?.ok === false) {
    throw new Error(json?.message || json?.error || `Upload failed (${res.status})`);
  }

  const rawUrl = pickUrlFromR2Response(json);
  if (!rawUrl) throw new Error("Upload succeeded but no URL returned");

  const stable = normalizeNonExpiringUrl(rawUrl);
  if (!stable.startsWith("http")) throw new Error("Upload returned invalid URL");
  return stable;
}

async function storeRemoteToR2(url: string, kind: string): Promise<string> {
  const res = await apiFetch("/api/r2/store-remote-signed", {
    method: "POST",
    body: JSON.stringify({
      url,
      kind, // "generations" | "motions" | etc.
      customerId: effectiveCustomerId,
    }),
  });

  const json = await res.json().catch(() => ({}));

  // If backend fails, keep original (so user still sees something)
  if (!res.ok || json?.ok === false) {
    return url;
  }

  const rawUrl = pickUrlFromR2Response(json);
  if (!rawUrl) return url;

  const stable = normalizeNonExpiringUrl(rawUrl);
  return stable || url;
}

function patchUploadItem(panel: UploadPanelKey, id: string, patch: Partial<UploadItem>) {
  setUploads((prev) => ({
    ...prev,
    [panel]: prev[panel].map((it) => (it.id === id ? { ...it, ...patch } : it)),
  }));
}

async function startUploadForFileItem(panel: UploadPanelKey, id: string, file: File) {
  try {
    patchUploadItem(panel, id, { uploading: true, error: undefined });
    const remoteUrl = await uploadFileToR2(panel, file);
    patchUploadItem(panel, id, { remoteUrl, uploading: false });
  } catch (err: any) {
    patchUploadItem(panel, id, { uploading: false, error: err?.message || "Upload failed" });
  }
}

async function startStoreForUrlItem(panel: UploadPanelKey, id: string, url: string) {
  try {
    patchUploadItem(panel, id, { uploading: true, error: undefined });
    const remoteUrl = await storeRemoteToR2(url, panel);
    patchUploadItem(panel, id, { remoteUrl, uploading: false });
  } catch (err: any) {
    patchUploadItem(panel, id, { uploading: false, error: err?.message || "Store failed" });
  }
}


// ========================================================================
// [PART 9 START] Stills (editorial)
// ========================================================================
const handleGenerateStill = async () => {
  const trimmed = stillBrief.trim();
  if (trimmed.length < 40) return;

  if (!API_BASE_URL) {
    setStillError("Missing API base URL (VITE_MINA_API_BASE_URL).");
    return;
  }

  const sid = await ensureSession();
  if (!sid) {
    setStillError("Could not start Mina session.");
    return;
  }

  try {
    // clear old “real” message so placeholder can run while generating
    setMinaOverrideText(null);

    setStillGenerating(true);
    setStillError(null);

    const safeAspectRatio = REPLICATE_ASPECT_RATIO_MAP[currentAspect.ratio] || "2:3";

    const payload: {
      customerId: string;
      sessionId: string;
      brief: string;
      tone: string;
      platform: string;
      minaVisionEnabled: boolean;
      stylePresetKey: string;
      aspectRatio: string;
      productImageUrl?: string;
      logoImageUrl?: string;
      styleImageUrls?: string[];
    } = {
      customerId: effectiveCustomerId!,
      sessionId: sid,
      brief: trimmed,
      tone,
      platform: currentAspect.platformKey,
      minaVisionEnabled,
      stylePresetKey: stylePresetKeyForApi,
      aspectRatio: safeAspectRatio,
    };

    // Forward product (R2 first, then http only)
    const productItem = uploads.product[0];
    const productUrl = productItem?.remoteUrl || productItem?.url;
    if (productUrl && isHttpUrl(productUrl)) payload.productImageUrl = productUrl;

    // Forward logo (optional)
    const logoItem = uploads.logo[0];
    const logoUrl = logoItem?.remoteUrl || logoItem?.url;
    if (logoUrl && isHttpUrl(logoUrl)) payload.logoImageUrl = logoUrl;

    // Forward inspiration up to 4
    const inspirationUrls = uploads.inspiration
      .map((u) => u.remoteUrl || u.url)
      .filter((u) => isHttpUrl(u))
      .slice(0, 4);

    if (inspirationUrls.length) payload.styleImageUrls = inspirationUrls;

    const res = await apiFetch("/editorial/generate", {
      method: "POST",
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const errJson = await res.json().catch(() => null);
      const msg = errJson?.message || `Error ${res.status}: Failed to generate editorial still.`;
      throw new Error(msg);
    }

    const data = (await res.json()) as EditorialResponse;
    const url = data.imageUrl || data.imageUrls?.[0];
    if (!url) throw new Error("No image URL in Mina response.");

    // ✅ Build the text we want to SHOW to the user (userMessage + prompt)
    const serverUserMessage =
      typeof data.gpt?.userMessage === "string" ? data.gpt.userMessage.trim() : "";

    const promptText = typeof data.prompt === "string" ? data.prompt.trim() : "";

    const imageTexts =
      Array.isArray(data.gpt?.imageTexts)
        ? data.gpt!.imageTexts!.filter((x) => typeof x === "string" && x.trim()).map((x) => x.trim())
        : [];

    const clamp = (t: string, max: number) => (t.length > max ? `${t.slice(0, max)}…` : t);

    const briefEcho = clamp(trimmed, 220);
    const promptShort = clamp(promptText, 380);

    let overlay = serverUserMessage || briefEcho;

    // include prompt (what you asked)
    if (promptShort) {
      overlay = `${overlay}\n\nPrompt:\n${promptShort}`;
    }

    // optional: include a little of vision text (if present)
    if (imageTexts.length) {
      const lines = imageTexts.slice(0, 3).map((t) => `• ${clamp(t, 140)}`).join("\n");
      overlay = `${overlay}\n\nNotes:\n${lines}`;
    }

    if (overlay.trim()) setMinaOverrideText(overlay.trim());

    // store remote AFTER we already showed text (faster UX)
    const storedUrl = await storeRemoteToR2(url, "generations");

    const item: StillItem = {
      id: data.generationId || `still_${Date.now()}`,
      url: storedUrl,
      createdAt: new Date().toISOString(),
      prompt: data.prompt || trimmed,
      aspectRatio: currentAspect.ratio,
    };

    setStillItems((prev) => {
      const next = [item, ...prev];
      setStillIndex(0);
      return next;
    });

    setLastStillPrompt(item.prompt);

    // Update credits
    if (data.credits?.balance !== undefined) {
      setCredits((prev) => ({
        balance: data.credits!.balance,
        meta: prev?.meta,
      }));
    }
  } catch (err: any) {
    setStillError(err?.message || "Unexpected error generating still.");
  } finally {
    setStillGenerating(false);
  }
};

// ========================================================================
// [PART 9 END]
// ========================================================================

// ========================================================================
// [PART 10 START] Motion (suggest + generate)
// ========================================================================
const applyMotionSuggestionText = async (text: string) => {
  if (!text) return;
  if (describeMoreTimeoutRef.current !== null) {
    window.clearTimeout(describeMoreTimeoutRef.current);
    describeMoreTimeoutRef.current = null;
  }
  setShowDescribeMore(false);
  setMotionSuggestTyping(true);

  for (let i = 0; i < text.length; i++) {
    const next = text.slice(0, i + 1);
    setMotionDescription(next);
    setBrief(next);
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, 12));
  }

  setMotionSuggestTyping(false);
};

const handleSuggestMotion = async () => {
  if (!API_BASE_URL || !motionReferenceImageUrl || motionSuggestLoading || motionSuggestTyping) return;

  setAnimateMode(true);

  try {
    setMotionSuggestLoading(true);
    setMotionSuggestError(null);

    const res = await apiFetch("/motion/suggest", {
      method: "POST",
      body: JSON.stringify({
        customerId: effectiveCustomerId,
        referenceImageUrl: motionReferenceImageUrl,
        tone,
        platform: animateAspectOption.platformKey,
        minaVisionEnabled,
        stylePresetKey: stylePresetKeyForApi,
        motionStyles: motionStyleKeys,
        aspectRatio: animateAspectOption.ratio,
      }),
    });

    if (!res.ok) {
      const errJson = await res.json().catch(() => null);
      const msg = errJson?.message || `Error ${res.status}: Failed to suggest motion.`;
      throw new Error(msg);
    }

    const data = (await res.json()) as MotionSuggestResponse;
    if (data.suggestion) await applyMotionSuggestionText(data.suggestion);
  } catch (err: any) {
    setMotionSuggestError(err?.message || "Unexpected error suggesting motion.");
  } finally {
    setMotionSuggestLoading(false);
    setMotionSuggestTyping(false);
  }
};

const handleGenerateMotion = async () => {
  if (!API_BASE_URL || !motionReferenceImageUrl || !motionTextTrimmed) return;

  const sid = await ensureSession();
  if (!sid) {
    setMotionError("Could not start Mina session.");
    return;
  }

  try {
    // clear old “real” message so placeholder can run while generating
    setMinaOverrideText(null);

    setMotionGenerating(true);
    setMotionError(null);

    const res = await apiFetch("/motion/generate", {
      method: "POST",
      body: JSON.stringify({
        customerId: effectiveCustomerId,
        sessionId: sid,
        lastImageUrl: motionReferenceImageUrl,
        motionDescription: motionTextTrimmed,
        tone,
        platform: animateAspectOption.platformKey,
        minaVisionEnabled,
        stylePresetKey: stylePresetKeyForApi,
        motionStyles: motionStyleKeys,
        aspectRatio: animateAspectOption.ratio,
      }),
    });

    if (!res.ok) {
      const errJson = await res.json().catch(() => null);
      const msg = errJson?.message || `Error ${res.status}: Failed to generate motion.`;
      throw new Error(msg);
    }

    const data = (await res.json()) as MotionResponse;
    const url = data.videoUrl;
    if (!url) throw new Error("No video URL in Mina response.");

    // ✅ Show message + prompt (if backend returns it)
    const serverUserMessage =
      typeof data.gpt?.userMessage === "string" ? data.gpt.userMessage.trim() : "";

    const promptText = typeof data.prompt === "string" ? data.prompt.trim() : "";

    const clamp = (t: string, max: number) => (t.length > max ? `${t.slice(0, max)}…` : t);
    const promptShort = clamp(promptText, 380);

    let overlay = serverUserMessage || "Motion is ready.";

    if (promptShort) overlay = `${overlay}\n\nPrompt:\n${promptShort}`;

    if (overlay.trim()) setMinaOverrideText(overlay.trim());

    const storedUrl = await storeRemoteToR2(url, "motions");

    const item: MotionItem = {
      id: data.generationId || `motion_${Date.now()}`,
      url: storedUrl,
      createdAt: new Date().toISOString(),
      prompt: data.prompt || motionTextTrimmed,
    };

    setMotionItems((prev) => {
      const next = [...prev, item];
      setMotionIndex(next.length - 1);
      return next;
    });

    if (data.credits?.balance !== undefined) {
      setCredits((prev) => ({
        balance: data.credits!.balance,
        meta: prev?.meta,
      }));
    }
  } catch (err: any) {
    setMotionError(err?.message || "Unexpected error generating motion.");
  } finally {
    setMotionGenerating(false);
  }
};

// ========================================================================
// [PART 10 END]
// ========================================================================

// ========================================================================
// [PART 11 START] Feedback / like / download
// ========================================================================
const getCurrentMediaKey = () => {
  const mediaType = currentMotion ? "motion" : currentStill ? "still" : null;
  if (!mediaType) return null;

  const rawKey = currentMotion?.id || currentStill?.id || currentMotion?.url || currentStill?.url;
  return rawKey ? `${mediaType}:${rawKey}` : null;
};

const handleLikeCurrentStill = async () => {
  const targetMedia = currentMotion || currentStill;
  if (!targetMedia) return;

  const resultType = currentMotion ? "motion" : "image";
  const likeKey = getCurrentMediaKey();
  const nextLiked = likeKey ? !likedMap[likeKey] : false;

  if (likeKey) {
    setLikedMap((prev) => ({ ...prev, [likeKey]: nextLiked }));
  }

  if (!API_BASE_URL || !nextLiked) return;

  try {
    setLikeSubmitting(true);
    await apiFetch("/feedback/like", {
      method: "POST",
      body: JSON.stringify({
        customerId: effectiveCustomerId,
        resultType,
        platform: currentAspect.platformKey,
        prompt: currentMotion?.prompt || currentStill?.prompt || lastStillPrompt || stillBrief || brief,
        comment: "",
        imageUrl: currentMotion ? "" : targetMedia.url,
        videoUrl: currentMotion ? targetMedia.url : "",
        sessionId,
        liked: true,
      }),
    });
  } catch {
    // non-blocking
  } finally {
    setLikeSubmitting(false);
  }
};

const handleSubmitFeedback = async () => {
  if (!API_BASE_URL || !feedbackText.trim()) return;
  const comment = feedbackText.trim();

  const targetVideo = currentMotion?.url || "";
  const targetImage = currentStill?.url || "";

  try {
    setFeedbackSending(true);
    setFeedbackError(null);

    await apiFetch("/feedback/like", {
      method: "POST",
      body: JSON.stringify({
        customerId: effectiveCustomerId,
        resultType: targetVideo ? "motion" : "image",
        platform: currentAspect.platformKey,
        prompt: lastStillPrompt || stillBrief || brief,
        comment,
        imageUrl: targetImage,
        videoUrl: targetVideo,
        sessionId,
      }),
    });

    setFeedbackText("");
  } catch (err: any) {
    setFeedbackError(err?.message || "Failed to send feedback.");
  } finally {
    setFeedbackSending(false);
  }
};

const handleDownloadCurrentStill = () => {
  const target = currentMotion?.url || currentStill?.url;
  if (!target) return;

  let filename = "";
  try {
    const parsed = new URL(target);
    const last = parsed.pathname.split("/").filter(Boolean).pop();
    if (last && last.includes(".")) filename = last;
  } catch {
    // fallback below
  }

  if (!filename) {
    const safePrompt =
      (lastStillPrompt || brief || "Mina-image")
        .replace(/[^a-z0-9]+/gi, "-")
        .toLowerCase()
        .slice(0, 80) || "mina-image";
    filename = currentMotion ? `mina-motion-${safePrompt}.mp4` : `mina-image-${safePrompt}.png`;
  }

  const a = document.createElement("a");
  a.href = target;
  const safePrompt =
    (lastStillPrompt || stillBrief || brief || "Mina-image")
      .replace(/[^a-z0-9]+/gi, "-")
      .toLowerCase()
      .slice(0, 80) || "mina-image";
  a.download = `Mina-v3-${safePrompt}`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
};

const currentMediaKey = getCurrentMediaKey();
const isCurrentLiked = currentMediaKey ? likedMap[currentMediaKey] : false;
// ========================================================================
// [PART 11 END]
// ========================================================================


  // ==============================================
  // 12. UI helpers – aspect + uploads + logout
  // ==============================================
  const handleCycleAspect = () => {
    setAspectIndex((prev) => {
      const next = (prev + 1) % ASPECT_OPTIONS.length;
      setPlatform(ASPECT_OPTIONS[next].platformKey);
      return next;
    });
  };

  const handleToggleAnimateMode = () => {
    setAnimateMode((prev) => {
      const next = !prev;
      if (!prev && !uploads.product.length && latestStill?.url) {
        setUploads((curr) => ({
          ...curr,
          product: [
            {
              id: `product_auto_${Date.now()}`,
              kind: "url",
              url: latestStill.url,
              remoteUrl: latestStill.url,
              uploading: false,
            },
          ],
        }));
      }
      return next;
    });
  };

  // Open panel (click only)
  const openPanel = (key: PanelKey) => {
    if (!stageHasPills) return;
    if (!key) return;

    setActivePanel(key);

    // Clicking a pill should reveal panels immediately
    setUiStage((s) => (s < 2 ? 2 : s));
  };

  const capForPanel = (panel: UploadPanelKey) => {
    if (panel === "inspiration") return 4;
    return 1; // product + logo
  };

  const pickTargetPanel = (): UploadPanelKey =>
    activePanel === "logo" ? "logo" : activePanel === "inspiration" ? "inspiration" : "product";

  const addFilesToPanel = (panel: UploadPanelKey, files: FileList) => {
    const max = capForPanel(panel);
    const incoming = Array.from(files).filter((f) => f.type.startsWith("image/"));
    if (!incoming.length) return;

    // For product/logo, we replace the current item (only 1)
    const replace = panel !== "inspiration";

    // Compute how many we can accept right now
    const existingCount = uploads[panel].length;
    const remaining = replace ? max : Math.max(0, max - existingCount);
    const slice = incoming.slice(0, remaining);
    if (!slice.length) return;

    const created: Array<{ id: string; file: File }> = [];

    setUploads((prev) => {
      // Revoke old blobs if replacing product/logo
      if (replace) {
        prev[panel].forEach((it) => {
          if (it.kind === "file" && it.url.startsWith("blob:")) {
            try {
              URL.revokeObjectURL(it.url);
            } catch {}
          }
        });
      }

      const base = replace ? [] : prev[panel];

      const nextItems: UploadItem[] = slice.map((file) => {
        const id = `${panel}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
        const previewUrl = URL.createObjectURL(file);
        created.push({ id, file });

        return {
          id,
          kind: "file",
          url: previewUrl, // blob preview
          remoteUrl: undefined, // will become https after upload
          file,
          uploading: true,
        };
      });

      return {
        ...prev,
        [panel]: [...base, ...nextItems].slice(0, max),
      };
    });

    // Kick off uploads AFTER state update
    created.forEach(({ id, file }) => {
      void startUploadForFileItem(panel, id, file);
    });
  };

  const addUrlToPanel = (panel: UploadPanelKey, url: string) => {
    const max = capForPanel(panel);
    const replace = panel !== "inspiration";

    const id = `${panel}_url_${Date.now()}_${Math.random().toString(16).slice(2)}`;

    setUploads((prev) => {
      const base = replace ? [] : prev[panel];

      const next: UploadItem = {
        id,
        kind: "url",
        url, // original http url (preview)
        remoteUrl: undefined, // will become R2 url
        uploading: true,
      };

      return {
        ...prev,
        [panel]: [...base, next].slice(0, max),
      };
    });

    void startStoreForUrlItem(panel, id, url);
  };

  const handlePasteImageUrl = (url: string) => {
    const targetPanel = pickTargetPanel();
    addUrlToPanel(targetPanel, url);
  };

  const removeUploadItem = (panel: UploadPanelKey, id: string) => {
    setUploads((prev) => {
      const item = prev[panel].find((x) => x.id === id);
      if (item?.kind === "file" && item.url.startsWith("blob:")) {
        try {
          URL.revokeObjectURL(item.url);
        } catch {
          // ignore
        }
      }
      return {
        ...prev,
        [panel]: prev[panel].filter((x) => x.id !== id),
      };
    });
  };

  const moveUploadItem = (panel: UploadPanelKey, from: number, to: number) => {
    setUploads((prev) => {
      const arr = [...prev[panel]];
      if (from < 0 || to < 0 || from >= arr.length || to >= arr.length) return prev;
      const [moved] = arr.splice(from, 1);
      arr.splice(to, 0, moved);
      return { ...prev, [panel]: arr };
    });
  };

  const triggerPick = (panel: UploadPanelKey) => {
    if (panel === "product") productInputRef.current?.click();
    if (panel === "logo") logoInputRef.current?.click();
    if (panel === "inspiration") inspirationInputRef.current?.click();
  };

  const handleFileInput = (panel: UploadPanelKey, e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (files && files.length) addFilesToPanel(panel, files);
    e.target.value = "";
  };

  // Whole-page drag/drop + paste (silent, no big text)
  useEffect(() => {
    if (uiStage === 0) return;

    const targetPanel: UploadPanelKey = pickTargetPanel();

    const onDragEnter = (e: DragEvent) => {
      if (!e.dataTransfer) return;
      if (!Array.from(e.dataTransfer.types || []).includes("Files")) return;
      e.preventDefault();
      dragDepthRef.current += 1;
      setGlobalDragging(true);
    };

    const onDragOver = (e: DragEvent) => {
      if (!e.dataTransfer) return;
      if (!Array.from(e.dataTransfer.types || []).includes("Files")) return;
      e.preventDefault();
    };

    const onDragLeave = (e: DragEvent) => {
      if (!e.dataTransfer) return;
      dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
      if (dragDepthRef.current === 0) setGlobalDragging(false);
    };

    const onDrop = (e: DragEvent) => {
      if (!e.dataTransfer) return;
      if (!Array.from(e.dataTransfer.types || []).includes("Files")) return;
      e.preventDefault();
      dragDepthRef.current = 0;
      setGlobalDragging(false);

      const files = e.dataTransfer.files;
      if (files && files.length) addFilesToPanel(targetPanel, files);
    };

    const onPaste = (e: ClipboardEvent) => {
      if (!e.clipboardData) return;
      const targetEl = e.target as HTMLElement | null;
      const isTypingField = !!targetEl?.closest("textarea, input, [contenteditable='true']");

      // image paste
      const items = Array.from(e.clipboardData.items || []);
      const imgItem = items.find((it) => it.type && it.type.startsWith("image/"));
      if (imgItem) {
        const file = imgItem.getAsFile();
        if (file) {
          if (!isTypingField) e.preventDefault();
          const list = {
            0: file,
            length: 1,
            item: (i: number) => (i === 0 ? file : null),
          } as unknown as FileList;
          addFilesToPanel(targetPanel, list);
          return;
        }
      }

      // url paste (silent)
      const text = e.clipboardData.getData("text/plain") || "";
      const url = extractFirstHttpUrl(text);
      if (url && /\.(png|jpe?g|webp|gif|avif)(\?.*)?$/i.test(url)) {
        if (!isTypingField) e.preventDefault();
        addUrlToPanel(targetPanel, url);
      }
    };

    window.addEventListener("dragenter", onDragEnter);
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("dragleave", onDragLeave);
    window.addEventListener("drop", onDrop);
    window.addEventListener("paste", onPaste);

    return () => {
      window.removeEventListener("dragenter", onDragEnter);
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("dragleave", onDragLeave);
      window.removeEventListener("drop", onDrop);
      window.removeEventListener("paste", onPaste);
    };
  }, [uiStage, activePanel]);

  // Style hover-select + inline rename
  const getStyleLabel = (key: string, fallback: string) =>
    (styleLabelOverrides[key] || fallback).trim() || fallback;

  const beginRenameStyle = (key: string, currentLabel: string) => {
    setEditingStyleKey(key);
    setEditingStyleValue(currentLabel);
  };

  const commitRenameStyle = () => {
    if (!editingStyleKey) return;
    const next = editingStyleValue.trim();
    setStyleLabelOverrides((prev) => ({
      ...prev,
      [editingStyleKey]: next,
    }));
    setEditingStyleKey(null);
    setEditingStyleValue("");
  };

  const cancelRenameStyle = () => {
    setEditingStyleKey(null);
    setEditingStyleValue("");
  };

  const deleteCustomStyle = (key: string) => {
    setCustomStyles((prev) => prev.filter((s) => s.key !== key));
    setStyleLabelOverrides((prev) => {
      const copy = { ...prev };
      delete copy[key];
      return copy;
    });
    // if deleting selected, fall back to vintage
    if (stylePresetKey === key) setStylePresetKey("vintage");
  };

  const handleChangeCustomer = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = customerIdInput.trim();
    if (!trimmed) return;
    setCustomerId(trimmed);
    setSessionId(null);
    setStillItems([]);
    setMotionItems([]);
  };

  const handleSignOut = async () => {
    try {
      await supabase.auth.signOut();
    } finally {
      try {
        window.localStorage.removeItem("minaCustomerId");
        window.localStorage.removeItem("minaProfileNumberMap");
        // keep likes/styles if you want; remove if you want a clean logout:
        // window.localStorage.removeItem("minaLikedMap");
      } catch {
        // ignore
      }
      if (typeof window !== "undefined") window.location.reload();
    }
  };

  const handleBriefScroll = () => {
    // fade is handled by CSS mask on .studio-brief-shell
  };

  const handleBriefChange = (value: string) => {
    setBrief(value);
    if (animateMode) setMotionDescription(value);
    else setStillBrief(value);

    if (describeMoreTimeoutRef.current !== null) {
      window.clearTimeout(describeMoreTimeoutRef.current);
      describeMoreTimeoutRef.current = null;
    }

    if (typingCalmTimeoutRef.current !== null) {
      window.clearTimeout(typingCalmTimeoutRef.current);
    }

    setIsTyping(true);
    typingCalmTimeoutRef.current = window.setTimeout(() => setIsTyping(false), 900);
    if (typingHideTimeoutRef.current === null && !typingUiHidden) {
      typingHideTimeoutRef.current = window.setTimeout(() => {
        setTypingUiHidden(true);
        typingHideTimeoutRef.current = null;
      }, TYPING_HIDE_DELAY_MS);
    }
    if (typingRevealTimeoutRef.current !== null) {
      window.clearTimeout(typingRevealTimeoutRef.current);
      typingRevealTimeoutRef.current = null;
    }

    setShowDescribeMore(false);

    const trimmedLength = value.trim().length;
    if (trimmedLength > 0 && trimmedLength < 20) {
      describeMoreTimeoutRef.current = window.setTimeout(() => setShowDescribeMore(true), 1200);
    }
  };
  // ========================================================================
  // [PART 12 END]
  // ========================================================================

  // ========================================================================
  // [PART 13 START] Custom styles (saved list + rename + delete)
  // ========================================================================
  const handleOpenCustomStylePanel = () => {
    setCustomStylePanelOpen(true);
    setCustomStyleError(null);
  };

  const handleCloseCustomStylePanel = () => {
    setCustomStylePanelOpen(false);
  };

  const handleCustomStyleFiles = (files: FileList | null) => {
    if (!files) return;

    const remainingSlots = Math.max(0, 10 - customStyleImages.length);
    if (!remainingSlots) return;

    const nextFiles = Array.from(files).slice(0, remainingSlots);
    const now = Date.now();

    const newItems: CustomStyleImage[] = nextFiles.map((file, index) => ({
      id: `${now}_${index}_${file.name}`,
      url: URL.createObjectURL(file),
      file,
    }));

    setCustomStyleImages((prev) => {
      const merged = [...prev, ...newItems];
      let nextHeroId = customStyleHeroId;
      if (!nextHeroId && merged.length) nextHeroId = merged[0].id;

      setCustomStyleHeroId(nextHeroId || null);

      const heroImage = merged.find((img) => img.id === nextHeroId) || merged[0];
      if (heroImage) {
        setCustomStyleHeroThumb((prevThumb) => {
          if (prevThumb && prevThumb.startsWith("blob:")) URL.revokeObjectURL(prevThumb);
          return heroImage.url;
        });
      }
      return merged;
    });
  };

  const handleCustomStyleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    handleCustomStyleFiles(e.target.files);
    e.target.value = "";
  };

  const handleCustomStyleUploadClick = () => {
    customStyleInputRef.current?.click();
  };

  const handleSelectCustomStyleHero = (id: string) => {
    setCustomStyleHeroId(id);
    const img = customStyleImages.find((item) => item.id === id);
    if (img) {
      setCustomStyleHeroThumb((prevThumb) => {
        if (prevThumb && prevThumb.startsWith("blob:")) URL.revokeObjectURL(prevThumb);
        return img.url;
      });
    }
  };

  const handleTrainCustomStyle = async () => {
    if (!customStyleImages.length || !customStyleHeroId) return;

    try {
      setCustomStyleTraining(true);
      setCustomStyleError(null);

      const hero = customStyleImages.find((x) => x.id === customStyleHeroId);
      if (!hero?.file) throw new Error("Pick a hero image.");

      // Persistable thumb (dataURL)
      const thumbUrl = await fileToDataUrl(hero.file);

      const newKey = `custom-${Date.now()}`;
      const newStyle: CustomStyle = {
        id: newKey,
        key: newKey,
        label: `Style ${customStyles.length + 1}`,
        thumbUrl,
        createdAt: new Date().toISOString(),
      };

      setCustomStyles((prev) => [newStyle, ...prev]);
      setStylePresetKey(newKey);

      // close modal
      setCustomStylePanelOpen(false);
    } catch (err: any) {
      setCustomStyleError(err?.message || "Unable to create style right now.");
    } finally {
      setCustomStyleTraining(false);
    }
  };

  const handleRenameCustomPreset = (key: string) => {
    const preset = customPresets.find((p) => p.key === key);
    if (!preset) return;
    const next = window.prompt("Rename style", preset.label);
    if (!next) return;

    const updated = customPresets.map((p) => (p.key === key ? { ...p, label: next.trim() || p.label } : p));
    setCustomPresets(updated);
    saveCustomStyles(updated);
  };

  const handleDeleteCustomPreset = (key: string) => {
    const preset = customPresets.find((p) => p.key === key);
    if (!preset) return;
    const ok = window.confirm(`Delete "${preset.label}"?`);
    if (!ok) return;

    const updated = customPresets.filter((p) => p.key !== key);
    setCustomPresets(updated);
    saveCustomStyles(updated);

    if (stylePresetKey === key) {
      setStylePresetKey("vintage");
    }
  };
  // ========================================================================
  // [PART 13 END]
  // ========================================================================

  // ========================================================================
  // [PART 15 START] Render – RIGHT side (separate component)
  // ========================================================================

  // Keep lazy component stable across renders (no remounting)
  const StudioRightLazyRef = useRef<
    React.LazyExoticComponent<React.ComponentType<any>> | null
  >(null);

  if (!StudioRightLazyRef.current) {
    StudioRightLazyRef.current = React.lazy(() => import("./StudioRight"));
  }

  const renderStudioRight = () => {
    const StudioRight = StudioRightLazyRef.current!;

    return (
      <React.Suspense
        fallback={
          <div className="studio-right">
            
          </div>
        }
      >
        <StudioRight
          currentStill={currentStill}
          currentMotion={currentMotion}
          stillItems={stillItems}
          stillIndex={stillIndex}
          setStillIndex={setStillIndex}
          feedbackText={feedbackText}
          setFeedbackText={setFeedbackText}
          feedbackSending={feedbackSending}
          feedbackError={feedbackError}
          onSubmitFeedback={handleSubmitFeedback}
        />
      </React.Suspense>
    );
  };

  // ========================================================================
  // [PART 15 END]
  // ========================================================================

  // ========================================================================
  // [PART 16 START] Render – Custom style modal (blur handled in CSS)
  // ========================================================================
  const renderCustomStyleModal = () => {
    if (!customStylePanelOpen) return null;

    return (
      <div className="mina-modal-backdrop" onClick={handleCloseCustomStylePanel}>
        <div className="mina-modal" onClick={(e) => e.stopPropagation()}>
          <div className="mina-modal-header">
            <div>Create a style</div>
            <button type="button" className="mina-modal-close" onClick={handleCloseCustomStylePanel}>
              Close
            </button>
          </div>

          <div
            className="mina-modal-drop"
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              handleCustomStyleFiles(e.dataTransfer.files);
            }}
          >
            <div className="mina-modal-drop-main">
              <button type="button" className="link-button" onClick={handleCustomStyleUploadClick}>
                Upload images
              </button>
              <span>(up to 10)</span>
            </div>
            <div className="mina-modal-drop-help">Drop up to 10 reference images and pick one as hero.</div>

            <input
              ref={customStyleInputRef}
              type="file"
              accept="image/*"
              multiple
              style={{ display: "none" }}
              onChange={handleCustomStyleInputChange}
            />
          </div>

          {customStyleImages.length > 0 && (
            <div className="mina-modal-grid">
              {customStyleImages.map((img) => (
                <button
                  key={img.id}
                  type="button"
                  className={classNames("mina-modal-thumb", customStyleHeroId === img.id && "hero")}
                  onClick={() => handleSelectCustomStyleHero(img.id)}
                >
                  <img src={img.url} alt="" />
                  {customStyleHeroId === img.id && <div className="mina-modal-thumb-tag">Hero</div>}
                </button>
              ))}
            </div>
          )}

          <div className="mina-modal-footer">
            {customStyleError && <div className="error-text">{customStyleError}</div>}
            <button
              type="button"
              className="mina-modal-train"
              onClick={handleTrainCustomStyle}
              disabled={!customStyleImages.length || !customStyleHeroId || customStyleTraining}
            >
              {customStyleTraining ? "Creating…" : "Create style"}
            </button>
          </div>
        </div>
      </div>
    );
  };
  // ========================================================================
  // [PART 16 END]
  // ========================================================================

  // ========================================================================
// [PART 17 START] Profile body – editorial history (cleaned)
// ========================================================================
const renderProfileBody = () => {
  // Show expiration date if provided
  const expirationCandidate =
    credits?.meta?.expiresAt ||
    (credits?.meta as any)?.expiresAt ||
    (credits?.meta as any)?.expirationDate ||
    (credits?.meta as any)?.expiry ||
    (credits?.meta as any)?.expiration;

  const expirationLabel = formatDateOnly(expirationCandidate);

  // Layout variants for grid sizing
  const editorialVariants = ["hero", "tall", "wide", "square", "mini", "wide", "tall"];

  // Render generation number (edit on double-click for admins)
  const renderNumberBadge = (g: GenerationRecord) => {
    const idx = historyIndexMap[g.id] ?? 0;
    const value = getEditorialNumber(g.id, idx);
    const isEditing = editingNumberId === g.id;
    return (
      <div
        className="profile-card-number"
        style={{ textTransform: "none", letterSpacing: "normal" }}
        onDoubleClick={() => handleBeginEditNumber(g.id, idx)}
        title={isAdmin ? "Double-click to edit" : undefined}
      >
        {isEditing ? (
          <input
            autoFocus
            className="profile-card-number-input"
            value={editingNumberValue}
            onChange={(e) => setEditingNumberValue(e.target.value)}
            onBlur={handleCommitNumber}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleCommitNumber();
              if (e.key === "Escape") handleCancelNumberEdit();
            }}
          />
        ) : (
          <span>{value}</span>
        )}
      </div>
    );
  };

  // Render a single history card
  const renderCard = (g: GenerationRecord, i: number) => {
    const variant = editorialVariants[i % editorialVariants.length];
    const aspectStyle = g.meta?.aspectRatio ? g.meta.aspectRatio.replace(":", " / ") : undefined;
    const numberLabel = getEditorialNumber(g.id, i);
    return (
      <article key={g.id} className={`profile-card profile-card--${variant}`}>
        {renderNumberBadge(g)}
        <div
          className="profile-card-media"
          style={{
            aspectRatio: aspectStyle,
            border: "1px solid rgba(8,10,0,0.08)",
            background: "rgba(8, 10, 0, 0.05)",
          }}
          onClick={() => window.open(g.outputUrl, "_blank", "noreferrer")}
        >
          <img
            src={toPreviewUrl(g.outputUrl)}
            loading="lazy"
            decoding="async"
            alt={g.prompt}
            referrerPolicy="no-referrer"
          />
          <div
            className="profile-card-actions"
            style={{
              backdropFilter: "blur(5px)",
              WebkitBackdropFilter: "blur(5px)",
              background: "rgba(0,0,0,0.3)",
            }}
          >
            <button
              type="button"
              className="link-button subtle"
              onClick={(e) => {
                e.stopPropagation();
                handleDownloadGeneration(g, numberLabel);
              }}
              style={{ textTransform: "none", letterSpacing: "normal", fontSize: "10pt" }}
            >
              download
            </button>
          </div>
        </div>
        <div className="profile-card-meta">
          <div
            className="profile-card-prompt"
            style={{
              fontSize: "10pt",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
              textTransform: "none",
              letterSpacing: "normal",
            }}
          >
            {g.prompt || "Untitled prompt"}
            {g.prompt && g.prompt.length > 80 && (
              <>
                {" "}
                <button
                  type="button"
                  className="link-button subtle"
                  onClick={(e) => {
                    e.stopPropagation();
                    alert(g.prompt);
                  }}
                  style={{ fontSize: "10pt", textDecoration: "underline", padding: 0 }}
                >
                  view more
                </button>
              </>
            )}
          </div>
          <div
            className="profile-card-submeta"
            style={{ textTransform: "none", letterSpacing: "normal", fontSize: "10pt" }}
          >
            <span>{formatDateOnly(g.createdAt)}</span>
            <span
              onClick={(e) => {
                e.stopPropagation();
                if (window.confirm("Delete this image?")) {
                  setHistoryGenerations((prev) => prev.filter((item) => item.id !== g.id));
                }
              }}
              style={{ cursor: "pointer", textDecoration: "underline" }}
            >
              delete image
            </span>
          </div>
        </div>
      </article>
    );
  };

  // Sort visibleHistory to show newest first
  const sortedVisibleHistory = [...visibleHistory].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );

  return (
    <div className="profile-editorial-shell">
      <header className="profile-header">
        <div className="profile-header-left">
          <div
            className="profile-header-label"
            style={{ textTransform: "none", letterSpacing: "normal" }}
          >
            Profile
          </div>
          <div className="profile-meta-row">
            <button
              type="button"
              className="profile-cta"
              onClick={() => window.open(TOPUP_URL, "_blank", "noreferrer")}
              style={{
                textTransform: "none",
                letterSpacing: "normal",
                fontSize: "12px",
                fontWeight: 500,
              }}
            >
              Get more matchas
            </button>
            <div className="profile-meta-block">
              <span
                className="profile-meta-title"
                style={{ textTransform: "none", letterSpacing: "normal" }}
              >
                Matchas remaining
              </span>
              <span className="profile-meta-value">{credits ? credits.balance : "—"}</span>
            </div>
            <div className="profile-meta-block">
              <span
                className="profile-meta-title"
                style={{ textTransform: "none", letterSpacing: "normal" }}
              >
                Signed in as
              </span>
              <span className="profile-meta-value" title={currentUserEmail || ""}>
                {currentUserEmail || "—"}
              </span>
            </div>
            <div className="profile-meta-block">
              <span
                className="profile-meta-title"
                style={{ textTransform: "none", letterSpacing: "normal" }}
              >
                Expiration date
              </span>
              <span className="profile-meta-value">{expirationLabel}</span>
            </div>
          </div>
        </div>
        <div className="profile-header-right">
          {isAdmin && (
            <button
              type="button"
              className="profile-cta ghost"
              onClick={() => (window.location.href = "/admin")}
              style={{
                textTransform: "none",
                letterSpacing: "normal",
                fontSize: "12px",
                fontWeight: 500,
              }}
            >
              Admin
            </button>
          )}
          <button
            type="button"
            className="profile-cta ghost"
            onClick={handleSignOut}
            style={{
              textTransform: "none",
              letterSpacing: "normal",
              fontSize: "12px",
              fontWeight: 500,
            }}
          >
            Sign out
          </button>
        </div>
      </header>

      {/* gallery: no editorial block; renamed to Archive */}
      <section className="profile-gallery">
        <div className="profile-gallery-head">
          <div
            className="profile-gallery-title"
            style={{ textTransform: "none", letterSpacing: "normal" }}
          >
            Archive
          </div>
          <div
            className="profile-gallery-sub"
            style={{ textTransform: "none", letterSpacing: "normal" }}
          >
            {historyGenerations.length} pieces
          </div>
        </div>
        {historyLoading && <div className="profile-gallery-status">Loading history…</div>}
        {historyError && (
          <div className="profile-gallery-status error-text">{historyError}</div>
        )}
        {!historyLoading && !historyGenerations.length && (
          <div className="profile-gallery-status">No archive yet.</div>
        )}
        <div className="profile-grid">
          {sortedVisibleHistory.map((g, i) => renderCard(g, i))}
        </div>
        <div ref={loadMoreRef} className="profile-grid-sentinel" aria-hidden />
      </section>

      <div className="profile-bottom-nav">
        <button
          type="button"
          className="profile-cta"
          onClick={() => setActiveTab("studio")}
          style={{
            textTransform: "none",
            letterSpacing: "normal",
            fontSize: "12px",
            fontWeight: 500,
          }}
        >
          Studio
        </button>
      </div>
    </div>
  );
};
// ========================================================================
// [PART 17 END]
// ========================================================================


  // ========================================================================
  // [PART 18 START] Final layout
  // ========================================================================
  return (
    <div className="mina-studio-root">
      <div className={classNames("mina-drag-overlay", globalDragging && "show")} />
      <div className="studio-frame">
        <div className={classNames("studio-header-overlay", isRightMediaDark && "is-dark")}>
          <div className="studio-header-left">
            <a href="https://mina.faltastudio.com" className="studio-logo-link">
              Mina
            </a>
          </div>

          <div className="studio-header-right">
            {activeTab === "studio" && (
              <>
                <button type="button" className="studio-header-cta" onClick={handleToggleAnimateMode}>
                  {animateMode ? "Create" : "Animate this"}
                </button>

                <button
                  type="button"
                  className="studio-header-cta"
                  onClick={handleLikeCurrentStill}
                  disabled={!currentStill && !currentMotion}
                >
                  {isCurrentLiked ? "ok" : "♡ more of this"}
                </button>

                <button
                  type="button"
                  className="studio-header-cta"
                  onClick={handleDownloadCurrentStill}
                  disabled={!currentStill && !currentMotion}
                >
                  Download
                </button>
              </>
            )}

            {activeTab === "profile" && (
              <button type="button" className="link-button subtle" onClick={() => setActiveTab("studio")}>
                Back to studio
              </button>
            )}
          </div>
        </div>

        {activeTab === "studio" ? (
          <div className={classNames("studio-body", "studio-body--two-col")}>
            <StudioLeft
              globalDragging={globalDragging}
              typingHidden={typingUiHidden}
              timingVars={animationTimingVars}
              showPills={showPills}
              showPanels={showPanels}
              showControls={showControls}
              uiStage={uiStage}
              brief={brief}
              briefHintVisible={briefHintVisible}
              briefShellRef={briefShellRef}
              onBriefScroll={handleBriefScroll}
              onBriefChange={handleBriefChange}
              animateMode={animateMode}
              onToggleAnimateMode={handleToggleAnimateMode}
              activePanel={activePanel}
              openPanel={openPanel}
              pillInitialDelayMs={PILL_INITIAL_DELAY_MS}
              pillStaggerMs={PILL_STAGGER_MS}
              panelRevealDelayMs={PANEL_REVEAL_DELAY_MS}
              currentAspect={currentAspect}
              currentAspectIconUrl={ASPECT_ICON_URLS[currentAspect.key]}
              onCycleAspect={handleCycleAspect}
              animateAspect={animateAspectOption}
              animateAspectIconUrl={animateAspectIconUrl}
              animateAspectIconRotated={animateAspectRotated}
              uploads={uploads}
              uploadsPending={uploadsPending}
              removeUploadItem={removeUploadItem}
              moveUploadItem={moveUploadItem}
              triggerPick={triggerPick}
              onFilesPicked={addFilesToPanel}
              productInputRef={productInputRef}
              logoInputRef={logoInputRef}
              inspirationInputRef={inspirationInputRef}
              stylePresetKey={stylePresetKey}
              setStylePresetKey={setStylePresetKey}
              stylePresets={computedStylePresets}
              customStyles={customStyles}
              getStyleLabel={getStyleLabel}
              editingStyleKey={editingStyleKey}
              editingStyleValue={editingStyleValue}
              setEditingStyleValue={setEditingStyleValue}
              beginRenameStyle={beginRenameStyle}
              commitRenameStyle={commitRenameStyle}
              cancelRenameStyle={cancelRenameStyle}
              deleteCustomStyle={deleteCustomStyle}
              onOpenCustomStylePanel={handleOpenCustomStylePanel}
              onImageUrlPasted={handlePasteImageUrl}
              minaVisionEnabled={minaVisionEnabled}
              onToggleVision={() => setMinaVisionEnabled((p) => !p)}
              stillGenerating={stillGenerating}
              stillError={stillError}
              onCreateStill={handleGenerateStill}
              motionStyleKeys={motionStyleKeys}
              setMotionStyleKeys={setMotionStyleKeys}
              motionSuggesting={motionSuggestLoading || motionSuggestTyping}
              canCreateMotion={canCreateMotion}
              motionHasImage={!!motionReferenceImageUrl}
              motionGenerating={motionGenerating}
              motionError={motionError}
              onCreateMotion={handleGenerateMotion}
              onTypeForMe={handleSuggestMotion}
              minaMessage={minaMessage}
              minaTalking={minaTalking}
              onGoProfile={() => setActiveTab("profile")}
            />
            {renderStudioRight()}
          </div>
        ) : (
          renderProfileBody()
        )}
      </div>

      {renderCustomStyleModal()}
    </div>
  );
  // ========================================================================
  // [PART 18 END]
  // ========================================================================
};

export default MinaApp;
// ============================================================================
// [PART 4 END] Component
// ============================================================================ this front app // src/StudioLeft.tsx
// ============================================================================
// Mina Studio — LEFT SIDE (Input + pills + panels + style + create + motion)
// ============================================================================

import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import "./StudioLeft.css";

// ------------------------------------
// Types (kept local so StudioLeft is standalone)
// ------------------------------------
export type UploadPanelKey = "product" | "logo" | "inspiration";
export type PanelKey = "product" | "logo" | "inspiration" | "style" | null;

export type UploadKind = "file" | "url";

export type UploadItem = {
  id: string;
  kind: UploadKind;
  url: string; // UI preview (blob: or http)
  remoteUrl?: string; // stored URL (https://...)
  file?: File;
  uploading?: boolean;
  error?: string;
};

export type StylePreset = {
  key: string;
  label: string;
  thumb: string;
};

export type CustomStyle = {
  key: string;
  label: string;
  thumbUrl: string;
  createdAt?: string;
};

export type AspectOptionLike = {
  key: string;
  label: string;
  subtitle: string;
  ratio?: string;
  platformKey?: string;
};

export type MotionStyleKey = "melt" | "drop" | "expand" | "satisfying" | "slow_motion" | "fix_camera" | "loop";

type StudioLeftProps = {
  globalDragging: boolean;
  typingHidden: boolean;

  showPills: boolean;
  showPanels: boolean;
  showControls: boolean;
  uiStage: 0 | 1 | 2 | 3;

  brief: string;
  briefHintVisible: boolean;
  briefShellRef: React.RefObject<HTMLDivElement>;
  onBriefScroll: () => void;
  onBriefChange: (value: string) => void;

  activePanel: PanelKey;
  openPanel: (key: PanelKey) => void;

  pillInitialDelayMs: number;
  pillStaggerMs: number;
  panelRevealDelayMs: number;

  currentAspect: AspectOptionLike;
  currentAspectIconUrl: string;
  onCycleAspect: () => void;

  animateAspect?: AspectOptionLike;
  animateAspectIconUrl?: string;
  animateAspectIconRotated?: boolean;

  uploads: Record<UploadPanelKey, UploadItem[]>;
  uploadsPending: boolean;

  removeUploadItem: (panel: UploadPanelKey, id: string) => void;
  moveUploadItem: (panel: UploadPanelKey, from: number, to: number) => void;
  triggerPick: (panel: UploadPanelKey) => void;

  // still provided, but StudioLeft doesn't need to call it directly
  onFilesPicked: (panel: UploadPanelKey, files: FileList) => void;

  productInputRef: React.RefObject<HTMLInputElement>;
  logoInputRef: React.RefObject<HTMLInputElement>;
  inspirationInputRef: React.RefObject<HTMLInputElement>;

  stylePresetKey: string;
  setStylePresetKey: (k: string) => void;

  stylePresets: readonly StylePreset[];
  customStyles: CustomStyle[];

  getStyleLabel: (key: string, fallback: string) => string;

  editingStyleKey: string | null;
  editingStyleValue: string;
  setEditingStyleValue: (v: string) => void;

  beginRenameStyle: (key: string, currentLabel: string) => void;
  commitRenameStyle: () => void;
  cancelRenameStyle: () => void;

  deleteCustomStyle: (key: string) => void;
  onOpenCustomStylePanel: () => void;

  minaVisionEnabled: boolean;
  onToggleVision: () => void;

  // IMAGE create
  stillGenerating: boolean;
  stillError: string | null;
  onCreateStill: () => void;

  // ✅ MOTION mode (optional for backward compatibility)
  animateMode?: boolean;
  onToggleAnimateMode?: (next: boolean) => void;

  motionStyleKeys?: MotionStyleKey[];
  setMotionStyleKeys?: (k: MotionStyleKey[]) => void;

  motionSuggesting?: boolean;
  canCreateMotion?: boolean;
  motionHasImage?: boolean;

  motionGenerating?: boolean;
  motionError?: string | null;
  onCreateMotion?: () => void;
  onTypeForMe?: () => void;

  minaMessage?: string;
  minaTalking?: boolean;

  timingVars?: React.CSSProperties;
  
  onGoProfile: () => void;
};

// ------------------------------------
// Small helpers
// ------------------------------------
function classNames(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

// ------------------------------------
// Stable Collapse (keeps children mounted)
// ------------------------------------
const Collapse: React.FC<{
  open: boolean;
  delayMs?: number; // kept for compat
  children: React.ReactNode;
}> = ({ open, delayMs = 0, children }) => {
  const innerRef = useRef<HTMLDivElement | null>(null);
  const [maxH, setMaxH] = useState<number>(open ? 1000 : 0);

  useLayoutEffect(() => {
    void delayMs; // intentionally not delaying panel switches

    const el = innerRef.current;
    if (!el) return;

    let raf1 = 0;
    let raf2 = 0;
    let ro: ResizeObserver | null = null;

    const measure = () => {
      const h = el.scrollHeight || 0;
      setMaxH(h);
    };

    if (open) {
      measure();
      raf1 = requestAnimationFrame(measure);

      if (typeof ResizeObserver !== "undefined") {
        ro = new ResizeObserver(() => measure());
        ro.observe(el);
      }

      return () => {
        if (raf1) cancelAnimationFrame(raf1);
        if (raf2) cancelAnimationFrame(raf2);
        if (ro) ro.disconnect();
      };
    }

    setMaxH(el.scrollHeight || 0);
    raf2 = requestAnimationFrame(() => setMaxH(0));

    return () => {
      if (raf1) cancelAnimationFrame(raf1);
      if (raf2) cancelAnimationFrame(raf2);
      if (ro) ro.disconnect();
    };
  }, [open, delayMs]);

  return (
    <div
      style={{
        overflow: "hidden",
        maxHeight: open ? maxH : 0,
        opacity: open ? 1 : 0,
        transform: open ? "translateY(0)" : "translateY(-6px)",
        pointerEvents: open ? "auto" : "none",
        transition:
          "max-height 650ms cubic-bezier(0.16,1,0.3,1), opacity 650ms cubic-bezier(0.16,1,0.3,1), transform 650ms cubic-bezier(0.16,1,0.3,1)",
        transitionDelay: "0ms",
      }}
    >
      <div ref={innerRef}>{children}</div>
    </div>
  );
};

// ------------------------------------
// Motion styles (exactly 6)
// ------------------------------------
const MOTION_STYLES: Array<{ key: MotionStyleKey; label: string; seed: string }> = [
  { key: "melt", label: "Melt", seed: "Slow, asmr, melting motion—soft drips, luxury macro feel." },
  { key: "drop", label: "Drop", seed: "Falling in slow rhythm—minimal, ASMR, drops." },
  { key: "expand", label: "Expand", seed: "Subtle expansion, calm luxury vibe." },
  { key: "satisfying", label: "Satisfying", seed: "Slime video, satisfying, smooth, satisfying, motion loop—micro movements, clean, premium." },
  { key: "slow_motion", label: "Slow motion", seed: "Ultra slow motion, 1000fps, asmr, premium calm." },
   { key: "fix_camera", label: "Still camera", seed: "fix camera" },
  { key: "loop", label: "Perfect loop", seed: "perfect loop" },

];

// ============================================================================
// Component
// ============================================================================
const StudioLeft: React.FC<StudioLeftProps> = (props) => {
  const {
    globalDragging,
    typingHidden,
    showPills,
    showPanels,
    showControls,
    uiStage,

    brief,
    briefHintVisible,
    briefShellRef,
    onBriefScroll,
    onBriefChange,

    activePanel,
    openPanel,

    pillInitialDelayMs,
    pillStaggerMs,
    panelRevealDelayMs,

    currentAspect,
    currentAspectIconUrl,
    onCycleAspect,

    animateAspect,
    animateAspectIconUrl,
    animateAspectIconRotated,

    uploads,
    uploadsPending,

    removeUploadItem,
    moveUploadItem,
    triggerPick,

    productInputRef,
    logoInputRef,
    inspirationInputRef,

    stylePresetKey,
    setStylePresetKey,
    stylePresets,
    customStyles,
    getStyleLabel,

    editingStyleKey,
    editingStyleValue,
    setEditingStyleValue,
    beginRenameStyle,
    commitRenameStyle,
    cancelRenameStyle,
    deleteCustomStyle,

    onOpenCustomStylePanel,
    onImageUrlPasted,

    minaVisionEnabled,
    onToggleVision,

    stillGenerating,
    stillError,
    onCreateStill,

    motionHasImage,
    motionGenerating,
    motionError,
    onCreateMotion,
    onTypeForMe,

    minaMessage,
    minaTalking,

    timingVars,

    onGoProfile,
  } = props;

  const briefInputRef = useRef<HTMLTextAreaElement | null>(null);

  // ✅ motion mode (with local fallback)
  const [localAnimate, setLocalAnimate] = useState(false);
  const animateMode = props.animateMode ?? localAnimate;
  const prevAnimateModeRef = useRef(animateMode);

  const [localMotionStyle, setLocalMotionStyle] = useState<MotionStyleKey[]>(["fix_camera"]);
  const motionStyleKeys = props.motionStyleKeys ?? localMotionStyle;
  const setMotionStyleKeys = props.setMotionStyleKeys ?? setLocalMotionStyle;

  const stillBriefRef = useRef<string>("");
  const motionBriefRef = useRef<string>("");

  // keep separate briefs per mode (so switching doesn't destroy text)
  useEffect(() => {
    if (animateMode) motionBriefRef.current = brief;
    else stillBriefRef.current = brief;
  }, [brief, animateMode]);

  useEffect(() => {
    const prev = prevAnimateModeRef.current;
    if (animateMode === prev) return;

    if (animateMode) {
      stillBriefRef.current = brief;
      openPanel("product");
    } else {
      motionBriefRef.current = brief;
      openPanel("product");
    }

    prevAnimateModeRef.current = animateMode;
  }, [animateMode, brief, onBriefChange, openPanel]);

  const isMotion = animateMode;

  const briefLen = brief.trim().length;

  // pills delay style
  const pillBaseStyle = (index: number): React.CSSProperties => ({
    transitionDelay: showPills ? `${pillInitialDelayMs + index * pillStaggerMs}ms` : "0ms",
    opacity: showPills ? 1 : 0,
    transform: showPills ? "translateY(0)" : "translateY(-8px)",
  });

  // panel behavior
  const effectivePanel: PanelKey = uiStage === 0 ? null : (activePanel ?? "product");

  const getFirstImageUrl = (items: UploadItem[]) => items[0]?.remoteUrl || items[0]?.url || "";
  const productThumb = getFirstImageUrl(uploads.product);
  const logoThumb = getFirstImageUrl(uploads.logo);
  const inspirationThumb = getFirstImageUrl(uploads.inspiration);

  const allStyleCards = useMemo(() => {
    return [
      ...stylePresets.map((p) => ({
        key: p.key,
        label: getStyleLabel(p.key, p.label),
        thumb: p.thumb,
        isCustom: false,
      })),
      ...customStyles.map((s) => ({
        key: s.key,
        label: getStyleLabel(s.key, s.label),
        thumb: s.thumbUrl,
        isCustom: true,
      })),
    ];
  }, [stylePresets, customStyles, getStyleLabel]);

  const currentStyleCard = allStyleCards.find((c) => c.key === stylePresetKey) || null;
  const styleThumb = currentStyleCard?.thumb || "";
  const styleLabel = currentStyleCard?.label || "Style";

  const renderPillIcon = (src: string, fallback: React.ReactNode, isPlus?: boolean) => (
    <span
      className={classNames(
        "studio-pill-icon",
        src ? "studio-pill-icon-thumb" : "studio-pill-icon-mark",
        !src && isPlus && "studio-pill-icon--plus"
      )}
      aria-hidden="true"
    >
      {src ? <img src={src} alt="" /> : fallback}
    </span>
  );

  // -------------------------
  // Create CTA state machine
  // -------------------------
  const hasMotionHandler = typeof props.onCreateMotion === "function";

  const imageCreateState: "creating" | "uploading" | "describe_more" | "ready" =
    stillGenerating ? "creating" : uploadsPending ? "uploading" : briefLen < 40 ? "describe_more" : "ready";

  const motionSuggesting = !!props.motionSuggesting;
  const canCreateMotion = props.canCreateMotion ?? briefLen >= 1;

  const motionCreateState: "creating" | "describe_more" | "ready" = motionGenerating
    ? "creating"
    : motionSuggesting
      ? "creating"
      : canCreateMotion
        ? "ready"
        : "describe_more";

  const createState = isMotion ? motionCreateState : imageCreateState;
  const canCreateStill = imageCreateState === "ready";

  const createLabel =
    createState === "creating"
      ? isMotion
        ? "Animating…"
        : "Creating…"
      : createState === "uploading"
        ? "Uploading…"
        : createState === "describe_more"
          ? "Describe more"
          : isMotion
            ? "Animate"
            : "Create";

  const createDisabled =
    createState === "creating" ||
    createState === "uploading" ||
    (isMotion && (!hasMotionHandler || motionSuggesting)) ||
    (!isMotion && !canCreateStill);

  const handleCreateClick = () => {
    if (createState === "ready") {
      if (isMotion) {
        props.onCreateMotion?.();
      } else {
        onCreateStill();
      }
      return;
    }
    if (createState === "describe_more") {
      requestAnimationFrame(() => briefInputRef.current?.focus());
    }
  };

  // -------------------------
  // File inputs (just wiring)
  // -------------------------
  const handleFileInput = (panel: UploadPanelKey, e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (files && files.length) props.onFilesPicked(panel, files);
    e.target.value = "";
  };

  // motion style click: pick + optionally seed the motion brief if empty
  const pickMotionStyle = (k: MotionStyleKey) => {
    let added = false;
    setMotionStyleKeys((prev) => {
      const exists = prev.includes(k);
      const next = exists ? prev.filter((x) => x !== k) : [...prev, k];
      added = !exists;
      return next;
    });
    openPanel("style");

    // only seed if user hasn't typed yet
    const trimmed = brief.trim();
    if ((!trimmed || trimmed.length < 4) && added) {
      const seed = MOTION_STYLES.find((s) => s.key === k)?.seed || "";
      if (seed) onBriefChange(seed);
    }
  };

  return (
    <div
      className={classNames(
        "studio-left",
        globalDragging && "drag-active",
        typingHidden && "is-typing-hidden",
        minaTalking && "is-thinking"
      )}
      style={timingVars}
    >
      <div className="studio-left-main">
        {/* Input 1 */}
        <div className="studio-input1-block">
          {/* Pills slot */}
          <div className="studio-pills-slot">
            <div className={classNames("studio-row", "studio-row--pills", !showPills && "hidden")}>
              {!isMotion ? (
                <>
                          {/* Product */}
                            <button
                              type="button"
                              className={classNames(
                                "studio-pill",
                                effectivePanel === "product" && "active",
                                !productThumb && "studio-pill--solo-plus"
                              )}
                              style={pillBaseStyle(0)}
                              onClick={() => {
                                if (!productThumb) {
                                  triggerPick("product");
                                } else {
                                  openPanel("product");
                                }
                              }}
                              onMouseEnter={() => openPanel("product")}
                            >
                              {renderPillIcon(productThumb, "+", true)}
                              <span className="studio-pill-main">Product</span>
                            </button>
                    
                            {/* Logo */}
                            <button
                              type="button"
                              className={classNames(
                                "studio-pill",
                                activePanel === "logo" && "active",
                                !logoThumb && "studio-pill--solo-plus"
                              )}
                              style={pillBaseStyle(1)}
                              onClick={() => {
                                if (!logoThumb) {
                                  triggerPick("logo");
                                } else {
                                  openPanel("logo");
                                }
                              }}
                              onMouseEnter={() => openPanel("logo")}
                            >
                              {renderPillIcon(logoThumb, "+", true)}
                              <span className="studio-pill-main">Logo</span>
                            </button>
                    
                            {/* Inspiration */}
                            <button
                              type="button"
                              className={classNames(
                                "studio-pill",
                                activePanel === "inspiration" && "active",
                                !inspirationThumb && "studio-pill--solo-plus"
                              )}
                              style={pillBaseStyle(2)}
                              onClick={() => {
                                if (!inspirationThumb) {
                                  triggerPick("inspiration");
                                } else {
                                  openPanel("inspiration");
                                }
                              }}
                              onMouseEnter={() => openPanel("inspiration")}
                            >
                              {renderPillIcon(inspirationThumb, "+", true)}
                              <span className="studio-pill-main">Inspiration</span>
                            </button>


                  {/* Style */}
                  <button
                    type="button"
                    className={classNames(
                      "studio-pill",
                      activePanel === "style" && "active",
                      !styleThumb && "studio-pill--solo-plus"
                    )}
                    style={pillBaseStyle(3)}
                    onClick={() => openPanel("style")}
                    onMouseEnter={() => openPanel("style")}
                  >
                    {renderPillIcon(styleThumb, styleLabel.slice(0, 1) || "+")}
                    <span className="studio-pill-main">{styleLabel}</span>
                  </button>

                  {/* Ratio */}
                  <button
                    type="button"
                    className={classNames("studio-pill", "studio-pill--aspect")}
                    style={pillBaseStyle(4)}
                    onClick={onCycleAspect}
                  >
                    <span className="studio-pill-icon">
                      <img src={currentAspectIconUrl} alt="" />
                    </span>
                    <span className="studio-pill-main">{currentAspect.label}</span>
                    <span className="studio-pill-sub">{currentAspect.subtitle}</span>
                  </button>
                </>
              ) : (
                <>
                          {/* Image */}
                          <button
                            type="button"
                            className={classNames(
                              "studio-pill",
                              effectivePanel === "product" && "active",
                              !productThumb && "studio-pill--solo-plus"
                            )}
                            style={pillBaseStyle(0)}
                            onClick={() => {
                              if (!productThumb) {
                                triggerPick("product");
                              } else {
                                openPanel("product");
                              }
                            }}
                            onMouseEnter={() => openPanel("product")}
                          >
                            {renderPillIcon(productThumb, "+", true)}
                            <span className="studio-pill-main">Image</span>
                          </button>


                  {/* Type for me */}
                  <button
                    type="button"
                    className={classNames(
                      "studio-pill",
                      "studio-pill--ghost",
                      motionSuggesting && "active"
                    )}
                    style={pillBaseStyle(1)}
                    onClick={() => onTypeForMe?.()}
                    disabled={motionSuggesting || motionGenerating || !motionHasImage}
                  >
                    <span className="studio-pill-icon studio-pill-icon-mark" aria-hidden="true">
                      ✎
                    </span>
                    <span className="studio-pill-main">Type for me</span>
                  </button>

                  {/* Mouvement style */}
                  <button
                    type="button"
                    className={classNames(
                      "studio-pill",
                      effectivePanel === "style" && "active",
                      !styleThumb && "studio-pill--solo-plus"
                    )}
                    style={pillBaseStyle(0)}
                    onClick={() => openPanel("style")}
                    onMouseEnter={() => openPanel("style")}
                  >
                    {renderPillIcon(styleThumb, styleLabel.slice(0, 1) || "+")}
                    <span className="studio-pill-main">Mouvement style</span>
                  </button>

                  {/* Ratio */}
                  <button
                    type="button"
                    className={classNames("studio-pill", "studio-pill--aspect")}
                    style={pillBaseStyle(3)}
                    disabled
                  >
                    <span className="studio-pill-icon">
                      <img
                        src={animateAspectIconUrl || currentAspectIconUrl}
                        alt=""
                        style={{ transform: animateAspectIconRotated ? "rotate(90deg)" : undefined }}
                      />
                    </span>
                    <span className="studio-pill-main">{(animateAspect ?? currentAspect).label}</span>
                    <span className="studio-pill-sub">{(animateAspect ?? currentAspect).subtitle}</span>
                  </button>
                </>
              )}
            </div>
          </div>

          {/* Textarea */}
          <div className="studio-brief-block">
            <div
              className={classNames("studio-brief-shell", briefHintVisible && "has-brief-hint")}
              ref={briefShellRef}
              onScroll={onBriefScroll}
            >
              <textarea
                ref={briefInputRef}
                className="studio-brief-input"
                placeholder={
                  isMotion
                    ? "Describe the motion you want (loop, camera, drips, melt, etc.)"
                    : "Describe how you want your still life image to look like"
                }
                value={brief}
                onChange={(e) => onBriefChange(e.target.value)}
                rows={4}
                onPaste={(e) => {
                  const text = e.clipboardData?.getData("text/plain") || "";
                  if (!text) return;
                  const url = text.match(/https?:\/\/[^\s)]+/i)?.[0];
                  if (url && /\.(png|jpe?g|webp|gif|avif)(\?.*)?$/i.test(url)) {
                    onImageUrlPasted?.(url);
                  }
                }}
              />
              <div
                className={classNames("studio-brief-overlay", minaTalking && "is-visible")}
                aria-hidden="true"
              >
                {minaTalking ? minaMessage : ""}
              </div>
              {briefHintVisible && <div className="studio-brief-hint">Describe more</div>}
            </div>
          </div>
        </div>

        {/* Panels */}
        <div className="mina-left-block">
          {!isMotion ? (
            <>
                <Collapse open={showPanels && (effectivePanel === "product" || activePanel === null)} delayMs={panelRevealDelayMs}>
                  <div className="studio-panel">
                    <div className="studio-panel-title">Add your product</div>

                    <div className="studio-panel-row">
                      <div className="studio-thumbs studio-thumbs--inline">
                        {uploads.product.map((it) => (
                          <button
                            key={it.id}
                            type="button"
                            className="studio-thumb"
                            onClick={() => removeUploadItem("product", it.id)}
                            title="Click to delete"
                          >
                            <img src={it.remoteUrl || it.url} alt="" />
                          </button>
                        ))}

                        {uploads.product.length === 0 && (
                          <button
                            type="button"
                            className="studio-plusbox studio-plusbox--inline"
                            onClick={() => triggerPick("product")}
                            title="Add image"
                          >
                            <span aria-hidden="true">+</span>
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                </Collapse>

                <Collapse open={showPanels && activePanel === "logo"} delayMs={panelRevealDelayMs}>
                  <div className="studio-panel">
                    <div className="studio-panel-title">Add your logo</div>

                    <div className="studio-panel-row">
                      <div className="studio-thumbs studio-thumbs--inline">
                        {uploads.logo.map((it) => (
                          <button
                            key={it.id}
                            type="button"
                            className="studio-thumb"
                            onClick={() => removeUploadItem("logo", it.id)}
                            title="Click to delete"
                          >
                            <img src={it.remoteUrl || it.url} alt="" />
                          </button>
                        ))}

                        {uploads.logo.length === 0 && (
                          <button
                            type="button"
                            className="studio-plusbox studio-plusbox--inline"
                            onClick={() => triggerPick("logo")}
                            title="Add image"
                          >
                            <span aria-hidden="true">+</span>
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                </Collapse>

                <Collapse open={showPanels && activePanel === "inspiration"} delayMs={panelRevealDelayMs}>
                  <div className="studio-panel">
                    <div className="studio-panel-title">Add inspiration</div>

                    <div className="studio-panel-row">
                      <div className="studio-thumbs studio-thumbs--inline">
                        {uploads.inspiration.map((it, idx) => (
                          <button
                            key={it.id}
                            type="button"
                            className="studio-thumb"
                            draggable
                            onDragStart={() => {
                              (window as any).__minaDragIndex = idx;
                            }}
                            onDragOver={(e) => e.preventDefault()}
                            onDrop={(e) => {
                              e.preventDefault();
                              const from = Number((window as any).__minaDragIndex);
                              const to = idx;
                              if (Number.isFinite(from) && from !== to) {
                                moveUploadItem("inspiration", from, to);
                              }
                              (window as any).__minaDragIndex = null;
                            }}
                            onClick={() => removeUploadItem("inspiration", it.id)}
                            title="Click to delete • Drag to reorder"
                          >
                            <img src={it.remoteUrl || it.url} alt="" />
                          </button>
                        ))}

                        {uploads.inspiration.length < 4 && (
                          <button
                            type="button"
                            className="studio-plusbox studio-plusbox--inline"
                            onClick={() => triggerPick("inspiration")}
                            title="Add image"
                          >
                            <span aria-hidden="true">+</span>
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                </Collapse>

                <Collapse open={showPanels && activePanel === "style"} delayMs={panelRevealDelayMs}>
                  <div className="studio-panel">
                    <div className="studio-panel-title">Pick a style</div>

                    <div className="studio-style-row">
                      {allStyleCards.map((s) => (
                        <button
                          key={s.key}
                          type="button"
                          className={classNames("studio-style-card", stylePresetKey === s.key && "active")}
                          onMouseEnter={() => setStylePresetKey(s.key)}
                          onClick={() => setStylePresetKey(s.key)}
                        >
                          <div className="studio-style-thumb">
                            <img src={s.thumb} alt="" />
                          </div>

                          <div
                            className="studio-style-label"
                            onDoubleClick={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              if (s.isCustom) deleteCustomStyle(s.key);
                            }}
                            onClick={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              beginRenameStyle(s.key, s.label);
                            }}
                          >
                            {editingStyleKey === s.key ? (
                              <input
                                autoFocus
                                value={editingStyleValue}
                                onChange={(e) => setEditingStyleValue(e.target.value)}
                                onBlur={commitRenameStyle}
                                onKeyDown={(e) => {
                                  if (e.key === "Enter") commitRenameStyle();
                                  if (e.key === "Escape") cancelRenameStyle();
                                }}
                              />
                            ) : (
                              s.label
                            )}
                          </div>
                        </button>
                      ))}

                      {/* Create style */}
                      <button type="button" className={classNames("studio-style-card", "add")} onClick={onOpenCustomStylePanel}>
                        <div className="studio-style-thumb">
                          <span aria-hidden="true">+</span>
                        </div>
                        <div className="studio-style-label">Your style</div>
                      </button>
                    </div>
                  </div>
                </Collapse>
              </>
            ) : (
              <>
                <Collapse open={showPanels && (effectivePanel === "product" || activePanel === null)} delayMs={panelRevealDelayMs}>
                  <div className="studio-panel">
                    <div className="studio-panel-title">Add your image</div>

                    <div className="studio-panel-row">
                      <div className="studio-thumbs studio-thumbs--inline">
                        {uploads.product.map((it) => (
                          <button
                            key={it.id}
                            type="button"
                            className="studio-thumb"
                            onClick={() => removeUploadItem("product", it.id)}
                            title="Click to delete"
                          >
                            <img src={it.remoteUrl || it.url} alt="" />
                          </button>
                        ))}

                        {uploads.product.length === 0 && (
                          <button
                            type="button"
                            className="studio-plusbox studio-plusbox--inline"
                            onClick={() => triggerPick("product")}
                            title="Add image"
                          >
                            <span aria-hidden="true">+</span>
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                </Collapse>

                <Collapse open={showPanels && (effectivePanel === "style" || activePanel === null)} delayMs={panelRevealDelayMs}>
                  <div className="studio-panel">
                    <div className="studio-panel-title">Pick a mouvement style</div>

                    <div className="studio-style-row">
                      {MOTION_STYLES.map((m) => (
  <button
    key={m.key}
    type="button"
    className={classNames(
      "studio-style-card",
      "studio-motion-style-card",
      motionStyleKeys.includes(m.key) && "active"
    )}
    onClick={() => pickMotionStyle(m.key)}
  >
    <div className={classNames("studio-style-thumb", "studio-motion-style-thumb")}>
      <span aria-hidden="true">{m.label.slice(0, 1)}</span>
    </div>
    <div className="studio-motion-style-label">{m.label}</div>
  </button>
))}

                    </div>
                  </div>
                </Collapse>
              </>
            )}

            {/* Controls */}
            {showControls && (
              <div className="studio-controls">
                <div className="studio-controls-divider" />

                <button type="button" className="studio-vision-toggle" onClick={onToggleVision}>
                  Mina Vision Intelligence: <span className="studio-vision-state">{minaVisionEnabled ? "ON" : "OFF"}</span>
                </button>

                <div className="studio-create-block">
                  <button
                    type="button"
                    aria-busy={createDisabled}
                    className={classNames(
                      "studio-create-link",
                      createDisabled && "disabled",
                      createState === "describe_more" && "state-describe"
                    )}
                    disabled={createDisabled}
                    onClick={handleCreateClick}
                    title={isMotion && !hasMotionHandler ? "Wire onCreateMotion in MinaApp" : undefined}
                  >
                    {createLabel}
                  </button>
                </div>

                {!isMotion && stillError && <div className="error-text">{stillError}</div>}
                {isMotion && motionError && <div className="error-text">{motionError}</div>}
              </div>
            )}
        </div>

        {/* Hidden file inputs */}
        <input
          ref={productInputRef}
          type="file"
          accept="image/*"
          style={{ display: "none" }}
          onChange={(e) => handleFileInput("product", e)}
        />
        <input
          ref={logoInputRef}
          type="file"
          accept="image/*"
          style={{ display: "none" }}
          onChange={(e) => handleFileInput("logo", e)}
        />
        <input
          ref={inspirationInputRef}
          type="file"
          accept="image/*"
          multiple
          style={{ display: "none" }}
          onChange={(e) => handleFileInput("inspiration", e)}
        />
      </div>

      {/* Profile bottom-left */}
      <button type="button" className="studio-profile-float" onClick={onGoProfile}>
        Profile
      </button>
    </div>
  );
};

export default StudioLeft; thisi seventh file // src/StudioRight.tsx
import React, { useEffect, useMemo, useState } from "react";
import "./StudioRight.css";

type StillItem = { id: string; url: string };
type MotionItem = { id: string; url: string };

type StudioRightProps = {
  currentStill: StillItem | null;
  currentMotion: MotionItem | null;

  stillItems: StillItem[];
  stillIndex: number;
  setStillIndex: (i: number) => void;

  feedbackText: string;
  setFeedbackText: (v: string) => void;
  feedbackSending: boolean;
  feedbackError: string | null;
  onSubmitFeedback: () => void;
};

export default function StudioRight(props: StudioRightProps) {
  const {
    currentStill,
    currentMotion,
    stillItems,
    stillIndex,
    setStillIndex,
    feedbackText,
    setFeedbackText,
    feedbackSending,
    feedbackError,
    onSubmitFeedback,
  } = props;

  const isEmpty = !currentStill && !currentMotion;

  const media = useMemo(() => {
    if (currentMotion) return { type: "video" as const, url: currentMotion.url };
    if (currentStill) return { type: "image" as const, url: currentStill.url };
    return null;
  }, [currentMotion, currentStill]);

  // Center click = zoom toggle (cover <-> contain)
  const [containMode, setContainMode] = useState(false);

  // Reset zoom when switching media
  useEffect(() => {
    setContainMode(false);
  }, [media?.url]);

  const hasCarousel = stillItems.length > 1;

  const goPrev = () => {
    if (!hasCarousel) return;
    const n = stillItems.length;
    setStillIndex((stillIndex - 1 + n) % n);
  };

  const goNext = () => {
    if (!hasCarousel) return;
    const n = stillItems.length;
    setStillIndex((stillIndex + 1) % n);
  };

  // Click zones:
  // - left 18% => previous
  // - right 18% => next
  // - middle => zoom toggle
  const handleFrameClick: React.MouseEventHandler<HTMLButtonElement> = (e) => {
    if (!media) return;

    const target = e.currentTarget;
    const rect = target.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const pct = rect.width > 0 ? x / rect.width : 0.5;

    const EDGE = 0.18;

    if (hasCarousel && pct <= EDGE) {
      goPrev();
      return;
    }
    if (hasCarousel && pct >= 1 - EDGE) {
      goNext();
      return;
    }

    setContainMode((v) => !v);
  };

  const canSend = !feedbackSending && feedbackText.trim().length > 0;

  return (
    <div className="studio-right">
      <div className="studio-right-surface">
        {isEmpty ? (
          <div className="studio-empty-text">New ideas don’t actually exist, just recycle.</div>
        ) : (
          <>
            <button type="button" className="studio-output-click" onClick={handleFrameClick} aria-label="Toggle zoom / Navigate">
              <div className={`studio-output-frame ${containMode ? "is-contain" : ""}`}>
                {media?.type === "video" ? (
                  <video className="studio-output-media" src={media.url} autoPlay loop muted controls />
                ) : (
                  <img className="studio-output-media" src={media?.url || ""} alt="" />
                )}
              </div>
            </button>

            {hasCarousel && (
              <div className="studio-dots-row">
                {stillItems.map((item, idx) => (
                  <button
                    key={item.id}
                    type="button"
                    className={`studio-dot ${idx === stillIndex ? "active" : ""}`}
                    onClick={() => setStillIndex(idx)}
                    aria-label={`Go to image ${idx + 1}`}
                  />
                ))}
              </div>
            )}
          </>
        )}
      </div>

      {!isEmpty && (
        <div className="studio-feedback-bar">
          <input
            className="studio-feedback-input--compact"
            placeholder="Speak to me tell me, what you like and dislike about my generation"
            value={feedbackText}
            onChange={(e) => setFeedbackText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && canSend) onSubmitFeedback();
            }}
          />

          <div className="studio-feedback-actions">
            <button type="button" className="studio-action-btn" onClick={onSubmitFeedback} disabled={!canSend}>
              Send
            </button>
          </div>

          {feedbackError && <div className="studio-feedback-error">{feedbackError}</div>}
        </div>
      )}
    </div>
  );
} eigthth // AdminDashboard.tsx
import React, { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "./lib/supabaseClient";
import { isAdmin } from "./lib/adminConfig";
import RuntimeConfigEditor from "./components/RuntimeConfigEditor";
import RuntimeConfigFlatEditor from "./components/RuntimeConfigFlatEditor";
import "./admin.css";

/**
 * Tabs kept:
 * - Runtime Config
 * - AI Config (reads/writes a flat Supabase table)
 * - Customers
 * - Generations (can delete)
 * - Feedback (can delete)
 * - Logs (realtime, fullscreen lines)
 */

type TabKey = "runtime" | "ai" | "customers" | "generations" | "feedback" | "logs";

const TAB_LABELS: Record<TabKey, string> = {
  runtime: "Runtime Config",
  ai: "AI Config (Flat table)",
  customers: "Customers",
  generations: "Generations",
  feedback: "Feedback",
  logs: "Logs (Realtime)",
};

// ✅ CHANGE THIS if your table name is different
const AI_FLAT_TABLE = "flat_ai_config";
// ✅ CHANGE THIS if your logs table name is different
const LOGS_TABLE = "logs";

/* -----------------------------
   UI bits
------------------------------ */

function AdminHeader({
  rightStatus,
  rightActions,
}: {
  rightStatus?: React.ReactNode;
  rightActions?: React.ReactNode;
}) {
  return (
    <header className="admin-header">
      <div>
        <div className="admin-title">Mina Admin</div>
        <div className="admin-subtitle">Editorial dashboard (Supabase live data)</div>
      </div>
      <div className="admin-actions">
        {rightStatus}
        {rightActions}
      </div>
    </header>
  );
}

function Section({
  title,
  description,
  children,
}: React.PropsWithChildren<{ title: string; description?: string }>) {
  return (
    <section className="admin-section">
      <header>
        <div className="admin-section-title">{title}</div>
        {description && <p className="admin-section-desc">{description}</p>}
      </header>
      {children}
    </section>
  );
}

function Table({ headers, children }: React.PropsWithChildren<{ headers: string[] }>) {
  return (
    <div className="admin-table">
      <div className="admin-table-head">
        {headers.map((h) => (
          <div key={h}>{h}</div>
        ))}
      </div>
      <div className="admin-table-body">{children}</div>
    </div>
  );
}

function StickyTabs({ active, onChange }: { active: TabKey; onChange: (k: TabKey) => void }) {
  return (
    <nav className="admin-tabs">
      {(Object.keys(TAB_LABELS) as TabKey[]).map((key) => (
        <button
          key={key}
          className={`admin-tab ${active === key ? "active" : ""}`}
          onClick={() => onChange(key)}
        >
          {TAB_LABELS[key]}
        </button>
      ))}
    </nav>
  );
}

function useAdminGuard() {
  const [allowed, setAllowed] = useState<boolean | null>(null);

  useEffect(() => {
    let mounted = true;

    const check = async () => {
      try {
        const { data } = await supabase.auth.getUser();
        const email = data.user?.email?.toLowerCase() || "";

        if (!email) {
          window.location.replace("/profile");
          return;
        }

        const ok = await isAdmin();
        if (!mounted) return;

        setAllowed(ok);
        if (!ok) window.location.replace("/");
      } catch {
        if (mounted) setAllowed(false);
        window.location.replace("/");
      }
    };

    void check();
    return () => {
      mounted = false;
    };
  }, []);

  return allowed;
}

/* -----------------------------
   Helpers
------------------------------ */

function pickFirstKey(row: any, keys: string[]) {
  for (const k of keys) {
    if (row && Object.prototype.hasOwnProperty.call(row, k)) return k;
  }
  return null;
}

function pickString(row: any, keys: string[], fallback = ""): string {
  for (const k of keys) {
    const v = row?.[k];
    if (typeof v === "string" && v.trim()) return v;
  }
  return fallback;
}

function pickNumber(row: any, keys: string[], fallback = 0): number {
  for (const k of keys) {
    const v = row?.[k];
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string" && v.trim() && !Number.isNaN(Number(v))) return Number(v);
  }
  return fallback;
}

function safeJson(obj: any) {
  try {
    return JSON.stringify(obj ?? {}, null, 2);
  } catch {
    return String(obj);
  }
}

function extractLikelyImageUrl(row: any): string | null {
  const keys = Object.keys(row || {});
  const urlKey =
    keys.find((k) => /^(url|image_url|output_url|result_url|asset_url)$/i.test(k)) ||
    keys.find((k) => /(url|image|output|result)/i.test(k) && typeof row?.[k] === "string");
  const val = urlKey ? row?.[urlKey] : null;
  return typeof val === "string" && val.startsWith("http") ? val : null;
}

function highlightTraceFields(row: any) {
  const keys = Object.keys(row || {});
  const candidates = [
    "gpt_input",
    "gpt_prompt",
    "llm_input",
    "llm_prompt",
    "system_prompt",
    "messages",
    "gpt_output",
    "llm_output",
    "caption",
    "text_output",
    "seedream_prompt",
    "image_prompt",
    "seedream_input",
    "seedream_output",
    "image_url",
    "output_url",
    "url",
    "params",
    "meta",
    "metadata",
    "trace",
    "debug",
  ];

  const present = candidates
    .map((k) => {
      const hit = keys.find((kk) => kk.toLowerCase() === k.toLowerCase());
      return hit || null;
    })
    .filter(Boolean) as string[];

  for (const k of keys) {
    if (/gpt|llm|seedream|prompt|output|trace|debug/i.test(k) && !present.includes(k)) {
      present.push(k);
    }
  }

  return present.slice(0, 18);
}

function truncateId(s: string, max = 22) {
  if (!s) return "";
  if (s.length <= max) return s;
  const head = Math.max(8, Math.floor(max / 2));
  const tail = Math.max(6, max - head - 1);
  return `${s.slice(0, head)}…${s.slice(-tail)}`;
}

/* -----------------------------
   Generic RAW Viewer
------------------------------ */

function RawViewer({ row }: { row: any }) {
  const url = extractLikelyImageUrl(row);
  const highlights = highlightTraceFields(row);

  return (
    <div className="admin-detail">
      {url && (
        <div style={{ marginBottom: 12 }}>
          <strong>Preview</strong>
          <div style={{ marginTop: 8 }}>
            <img src={url} alt="output" style={{ maxWidth: "100%", borderRadius: 12 }} />
          </div>
        </div>
      )}

      {highlights.length > 0 && (
        <div style={{ marginBottom: 12 }}>
          <strong>Important fields (auto-detected)</strong>
          <div style={{ display: "grid", gap: 10, marginTop: 10 }}>
            {highlights.map((k) => (
              <div key={k} style={{ border: "1px solid #eee", borderRadius: 10, padding: 10 }}>
                <div style={{ fontWeight: 700, marginBottom: 6 }}>{k}</div>
                <pre style={{ whiteSpace: "pre-wrap", margin: 0 }}>{safeJson(row?.[k])}</pre>
              </div>
            ))}
          </div>
        </div>
      )}

      <details>
        <summary style={{ cursor: "pointer", fontWeight: 700 }}>Raw JSON (everything)</summary>
        <pre style={{ whiteSpace: "pre-wrap" }}>{safeJson(row)}</pre>
      </details>
    </div>
  );
}

/* -----------------------------
   Live Data helpers
------------------------------ */

type LiveRow = {
  rowKey: string;
  id: string;
  label: string;
  createdAt?: string;
  raw: any;
};

async function loadTable(table: string, limit = 500, orderCol = "created_at") {
  const attempt = await supabase.from(table).select("*").order(orderCol, { ascending: false }).limit(limit);
  if (!attempt.error) return attempt.data ?? [];

  const fallback = await supabase.from(table).select("*").limit(limit);
  if (fallback.error) throw new Error(fallback.error.message);
  return fallback.data ?? [];
}

function makeRowsFromAny(table: string, rows: any[]): LiveRow[] {
  return rows.map((r, idx) => {
    const id =
      pickString(r, ["id", "uuid", "generation_id", "session_id", "tx_id"], "") ||
      pickString(r, ["user_id", "customer_id", "shopify_customer_id", "email"], "") ||
      `${table}-${idx}`;

    const createdAt = pickString(r, ["created_at", "inserted_at", "at", "timestamp"], "");

    const label =
      pickString(r, ["prompt", "input_prompt", "caption", "text"], "") ||
      pickString(r, ["email", "user_email"], "") ||
      pickString(r, ["shopify_customer_id", "customer_id"], "") ||
      pickString(r, ["user_id"], "") ||
      pickString(r, ["status"], "") ||
      id;

    const rowKey = `${table}:${id}:${createdAt || "no-time"}:${idx}`;
    return { rowKey, id, label, createdAt: createdAt || undefined, raw: r };
  });
}

async function deleteRowByBestPk(table: string, raw: any) {
  const pk = pickFirstKey(raw, [
    "id",
    "uuid",
    "generation_id",
    "gen_id",
    "feedback_id",
    "session_id",
    "tx_id",
  ]);
  if (!pk) throw new Error("No obvious primary key field found to delete this row.");
  const pkVal = raw?.[pk];
  const { error } = await supabase.from(table).delete().eq(pk, pkVal);
  if (error) throw new Error(error.message);
}

/* -----------------------------
   LiveTableTab (Generations / Feedback) + delete
------------------------------ */

function LiveTableTab({
  tableName,
  title,
  description,
  rows,
  loading,
  error,
  onRefresh,
  filterLabel,
  allowDelete,
}: {
  tableName: string;
  title: string;
  description: string;
  rows: LiveRow[];
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
  filterLabel?: React.ReactNode;
  allowDelete?: boolean;
}) {
  const [selected, setSelected] = useState<LiveRow | null>(null);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    if (selected && !rows.find((x) => x.rowKey === selected.rowKey)) setSelected(null);
  }, [rows, selected]);

  const doDelete = async () => {
    if (!selected) return;
    const ok = window.confirm(`Delete this row from "${tableName}"?\n\nID: ${selected.id}`);
    if (!ok) return;

    setDeleting(true);
    try {
      await deleteRowByBestPk(tableName, selected.raw);
      setSelected(null);
      onRefresh();
    } catch (e: any) {
      alert(e?.message ?? "Delete failed");
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="admin-grid admin-split">
      <Section title={title} description={description}>
        <div className="admin-inline">
          {filterLabel}
          <button className="admin-button ghost" type="button" onClick={onRefresh} disabled={loading}>
            {loading ? "Refreshing..." : "Refresh"}
          </button>
          <button
            className="admin-button ghost"
            type="button"
            onClick={() => navigator.clipboard?.writeText(JSON.stringify(rows.map((r) => r.raw), null, 2))}
          >
            Copy JSON
          </button>
          {allowDelete && (
            <button
              className="admin-button"
              type="button"
              onClick={doDelete}
              disabled={!selected || deleting}
              title={!selected ? "Select a row first" : "Delete selected"}
            >
              {deleting ? "Deleting..." : "Delete selected"}
            </button>
          )}
        </div>

        {error && (
          <div style={{ padding: 12, marginTop: 10, border: "1px solid crimson", color: "crimson", borderRadius: 8 }}>
            <strong>Load error:</strong> {error}
            <div style={{ marginTop: 6, color: "#333" }}>
              Usually: wrong table name, missing columns in order(), or RLS blocked your admin.
            </div>
          </div>
        )}

        {!error && !loading && rows.length === 0 && (
          <div className="admin-muted" style={{ padding: 12 }}>
            No rows found.
          </div>
        )}

        <div className="admin-grid-gallery">
          {rows.slice(0, 250).map((r) => {
            const url = extractLikelyImageUrl(r.raw);
            return (
              <button
                key={r.rowKey}
                className={`admin-grid-card ${selected?.rowKey === r.rowKey ? "active" : ""}`}
                onClick={() => setSelected(r)}
              >
                {url ? <img src={url} alt={r.label} loading="lazy" /> : <div className="admin-placeholder">no preview</div>}
                <div className="admin-grid-meta">
                  <div className="admin-grid-prompt">{r.label || <span className="admin-muted">—</span>}</div>
                  <div className="admin-grid-sub">
                    {truncateId(r.id)} • {r.createdAt || "—"}
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      </Section>

      <Section title="Details" description="Everything stored for this row">
        {selected ? <RawViewer row={selected.raw} /> : <p className="admin-muted">Select a row to inspect.</p>}
      </Section>
    </div>
  );
}

/* -----------------------------
   Customers (editable credits)
------------------------------ */

type CustomerRow = {
  pkCol: string;
  pkVal: string;
  email: string;
  userId: string | null;
  shopifyCustomerId: string | null;
  credits: number;
  expiresAt: string | null;
  lastActive: string | null;
  raw: any;
};

function normalizeCustomers(rows: any[]): CustomerRow[] {
  return rows.map((r) => {
    const userId = pickString(r, ["user_id", "uid"], "") || null;
    const shopifyCustomerId = pickString(r, ["shopify_customer_id", "shopify_id", "customer_id"], "") || null;
    const email = pickString(r, ["email", "user_email"], "") || (shopifyCustomerId?.includes("@") ? shopifyCustomerId : "(no email)");

    const credits = pickNumber(r, ["credits", "credit", "balance"], 0);
    const expiresAt = pickString(r, ["expires_at", "expiresAt"], "") || null;
    const lastActive = pickString(r, ["last_active", "lastActive", "updated_at"], "") || null;

    let pkCol = "shopify_customer_id";
    let pkVal = shopifyCustomerId || email;

    if (userId) {
      pkCol = "user_id";
      pkVal = userId;
    } else if (pickString(r, ["id"], "")) {
      pkCol = "id";
      pkVal = String(r.id);
    } else if (shopifyCustomerId) {
      pkCol = "shopify_customer_id";
      pkVal = shopifyCustomerId;
    } else if (email) {
      pkCol = "email";
      pkVal = email;
    }

    return { pkCol, pkVal, email, userId, shopifyCustomerId, credits, expiresAt, lastActive, raw: r };
  });
}

async function updateCustomerCreditsAndExpiry(opts: {
  table: string;
  customer: CustomerRow;
  nextCredits: number;
  nextExpiresAt: string | null;
}) {
  const { table, customer, nextCredits, nextExpiresAt } = opts;

  const patch: any = {};
  const creditCol = pickFirstKey(customer.raw, ["credits", "credit", "balance"]) || "credits";
  patch[creditCol] = nextCredits;

  const expCol = pickFirstKey(customer.raw, ["expires_at", "expiresAt"]);
  if (expCol) patch[expCol] = nextExpiresAt;

  const q = supabase.from(table).update(patch).eq(customer.pkCol, customer.pkVal);
  const { error } = await q;
  if (error) throw new Error(error.message);
}

function CustomersTab({
  customers,
  loading,
  error,
  onRefresh,
  customersTable,
}: {
  customers: CustomerRow[];
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
  customersTable: string;
}) {
  const [local, setLocal] = useState<CustomerRow[]>([]);
  const [dirtyMap, setDirtyMap] = useState<Record<string, boolean>>({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setLocal(customers);
    setDirtyMap({});
  }, [customers]);

  const updateRow = (idx: number, next: CustomerRow) => {
    const copy = [...local];
    copy[idx] = next;
    setLocal(copy);
    setDirtyMap((m) => ({ ...m, [next.pkCol + ":" + next.pkVal]: true }));
  };

  const anyDirty = Object.values(dirtyMap).some(Boolean);

  const saveAll = async () => {
    setSaving(true);
    try {
      for (const c of local) {
        const key = c.pkCol + ":" + c.pkVal;
        if (!dirtyMap[key]) continue;
        // eslint-disable-next-line no-await-in-loop
        await updateCustomerCreditsAndExpiry({
          table: customersTable,
          customer: customers.find((x) => x.pkCol === c.pkCol && x.pkVal === c.pkVal) || c,
          nextCredits: c.credits,
          nextExpiresAt: c.expiresAt,
        });
      }
      alert("Customers saved ✅");
      setDirtyMap({});
      onRefresh();
    } catch (e: any) {
      alert(e?.message ?? "Save failed");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="admin-grid">
      <Section title="Customers" description={`Live data from Supabase table "${customersTable}" (edit credits).`}>
        <div className="admin-inline">
          <button className="admin-button ghost" type="button" onClick={onRefresh} disabled={loading}>
            {loading ? "Refreshing..." : "Refresh"}
          </button>
          <button className="admin-button" type="button" onClick={saveAll} disabled={!anyDirty || saving}>
            {saving ? "Saving..." : "Save edits"}
          </button>
          {anyDirty && <span className="admin-muted">Unsaved changes.</span>}
        </div>

        {error && (
          <div style={{ padding: 12, marginTop: 10, border: "1px solid crimson", color: "crimson", borderRadius: 8 }}>
            <strong>Customers load error:</strong> {error}
          </div>
        )}

        <Table headers={["Email / ID", "Credits", "Expires", "Last active"]}>
          {local.map((c, idx) => (
            <div className="admin-table-row" key={`${c.pkCol}:${c.pkVal}`}>
              <div style={{ display: "grid" }}>
                <div style={{ fontWeight: 700 }}>{c.email}</div>
                <div className="admin-muted" style={{ fontSize: 12 }}>
                  {c.userId ? `user_id: ${truncateId(c.userId)}` : c.shopifyCustomerId ? `shopify: ${truncateId(c.shopifyCustomerId)}` : `${c.pkCol}: ${truncateId(c.pkVal)}`}
                </div>
              </div>

              <div>
                <input type="number" value={c.credits} onChange={(e) => updateRow(idx, { ...c, credits: Number(e.target.value) || 0 })} />
              </div>

              <div>
                <input
                  type="date"
                  value={(c.expiresAt || "").slice(0, 10)}
                  onChange={(e) => updateRow(idx, { ...c, expiresAt: e.target.value || null })}
                />
              </div>

              <div>{c.lastActive || "—"}</div>
            </div>
          ))}
        </Table>
      </Section>
    </div>
  );
}

/* -----------------------------
   AI Flat Config tab
------------------------------ */

type FlatAiDraft = {
  defaultProvider: string;
  defaultModel: string;
  temperature: number;
  topP: number;
  maxTokens: number;
  context: string;
  providerParamsJson: string; // JSON string (pre-filled)
};

function normalizeFlatAiRow(row: any): FlatAiDraft {
  const providerParams =
    row?.provider_params ??
    row?.providerParams ??
    row?.provider_parameters ??
    row?.providerParameters ??
    {};

  return {
    defaultProvider: pickString(row, ["default_provider", "defaultProvider", "provider", "default_provider_name"], ""),
    defaultModel: pickString(row, ["default_model", "defaultModel", "model", "default_model_name"], ""),
    temperature: pickNumber(row, ["temperature", "temp"], 0.7),
    topP: pickNumber(row, ["top_p", "topP"], 1),
    maxTokens: pickNumber(row, ["max_tokens", "maxTokens"], 1024),
    context: pickString(row, ["context", "system_prompt", "systemPrompt", "prompt"], ""),
    providerParamsJson: safeJson(providerParams),
  };
}

async function loadFlatAiConfig() {
  const { data, error } = await supabase.from(AI_FLAT_TABLE).select("*").limit(1).maybeSingle();
  if (error) throw new Error(error.message);
  return data ?? null;
}

async function saveFlatAiConfig(existingRow: any | null, draft: FlatAiDraft) {
  let providerParams: any = {};
  try {
    providerParams = draft.providerParamsJson?.trim() ? JSON.parse(draft.providerParamsJson) : {};
  } catch {
    throw new Error("Provider params JSON is invalid. Fix it before saving.");
  }

  const patch: any = {};
  const cols = {
    defaultProvider: pickFirstKey(existingRow ?? {}, ["default_provider", "defaultProvider"]) || "default_provider",
    defaultModel: pickFirstKey(existingRow ?? {}, ["default_model", "defaultModel"]) || "default_model",
    temperature: pickFirstKey(existingRow ?? {}, ["temperature", "temp"]) || "temperature",
    topP: pickFirstKey(existingRow ?? {}, ["top_p", "topP"]) || "top_p",
    maxTokens: pickFirstKey(existingRow ?? {}, ["max_tokens", "maxTokens"]) || "max_tokens",
    context: pickFirstKey(existingRow ?? {}, ["context", "system_prompt", "systemPrompt", "prompt"]) || "context",
    providerParams: pickFirstKey(existingRow ?? {}, ["provider_params", "providerParams"]) || "provider_params",
  };

  patch[cols.defaultProvider] = draft.defaultProvider;
  patch[cols.defaultModel] = draft.defaultModel;
  patch[cols.temperature] = draft.temperature;
  patch[cols.topP] = draft.topP;
  patch[cols.maxTokens] = draft.maxTokens;
  patch[cols.context] = draft.context;
  patch[cols.providerParams] = providerParams;

  // update existing row if possible
  if (existingRow) {
    const pkCol = pickFirstKey(existingRow, ["id", "key", "name"]);
    if (!pkCol) {
      // fallback: update first row by upsert with id=default
      patch.id = "default";
      const { error } = await supabase.from(AI_FLAT_TABLE).upsert(patch);
      if (error) throw new Error(error.message);
      return;
    }

    const pkVal = existingRow[pkCol];
    const { error } = await supabase.from(AI_FLAT_TABLE).update(patch).eq(pkCol, pkVal);
    if (error) throw new Error(error.message);
    return;
  }

  // no row exists -> create singleton row
  patch.id = "default";
  const { error } = await supabase.from(AI_FLAT_TABLE).insert(patch);
  if (error) throw new Error(error.message);
}

function FlatAiConfigTab({
  row,
  draft,
  setDraft,
  loading,
  error,
  onRefresh,
  onSave,
  saving,
  dirty,
}: {
  row: any | null;
  draft: FlatAiDraft | null;
  setDraft: (next: FlatAiDraft) => void;
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
  onSave: () => void;
  saving: boolean;
  dirty: boolean;
}) {
  if (loading || !draft) {
    return (
      <div className="admin-grid">
        <Section title="AI Config" description={`Loading from Supabase table "${AI_FLAT_TABLE}"…`}>
          <div style={{ padding: 12 }}>Loading…</div>
        </Section>
      </div>
    );
  }

  return (
    <div className="admin-grid">
      <Section title="AI Config (Flat)" description={`Edit the existing row in "${AI_FLAT_TABLE}" then hit Save.`}>
        <div className="admin-inline">
          <button className="admin-button ghost" type="button" onClick={onRefresh} disabled={loading || saving}>
            Refresh
          </button>
          <button className="admin-button" type="button" onClick={onSave} disabled={saving || !dirty}>
            {saving ? "Saving..." : "Save"}
          </button>
          {!dirty ? <span className="admin-muted">No changes.</span> : <span className="admin-muted">Unsaved changes.</span>}
        </div>

        {error && (
          <div style={{ padding: 12, marginTop: 10, border: "1px solid crimson", color: "crimson", borderRadius: 8 }}>
            <strong>AI config error:</strong> {error}
          </div>
        )}

        <div className="admin-inline" style={{ marginTop: 12 }}>
          <label>
            <strong>Default provider</strong>
            <input
              value={draft.defaultProvider}
              onChange={(e) => setDraft({ ...draft, defaultProvider: e.target.value })}
            />
          </label>

          <label>
            <strong>Default model</strong>
            <input
              value={draft.defaultModel}
              onChange={(e) => setDraft({ ...draft, defaultModel: e.target.value })}
            />
          </label>

          <label>
            <strong>Temperature</strong>
            <input
              type="number"
              step="0.1"
              value={draft.temperature}
              onChange={(e) => setDraft({ ...draft, temperature: Number(e.target.value) || 0 })}
            />
          </label>

          <label>
            <strong>top_p</strong>
            <input
              type="number"
              step="0.05"
              value={draft.topP}
              onChange={(e) => setDraft({ ...draft, topP: Number(e.target.value) || 0 })}
            />
          </label>

          <label>
            <strong>Max tokens</strong>
            <input
              type="number"
              value={draft.maxTokens}
              onChange={(e) => setDraft({ ...draft, maxTokens: Number(e.target.value) || 0 })}
            />
          </label>
        </div>

        <label style={{ display: "block", marginTop: 12 }}>
          <strong>Context (system prompt override)</strong>
          <textarea
            className="admin-textarea"
            value={draft.context}
            onChange={(e) => setDraft({ ...draft, context: e.target.value })}
          />
        </label>

        <label style={{ display: "block", marginTop: 12 }}>
          <strong>Provider params (JSON)</strong>
          <textarea
            className="admin-textarea"
            value={draft.providerParamsJson}
            onChange={(e) => setDraft({ ...draft, providerParamsJson: e.target.value })}
            style={{ minHeight: 220, fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace" }}
          />
        </label>

        <details style={{ marginTop: 12 }}>
          <summary style={{ cursor: "pointer", fontWeight: 700 }}>Raw row (from DB)</summary>
          <pre style={{ whiteSpace: "pre-wrap" }}>{safeJson(row)}</pre>
        </details>
      </Section>
    </div>
  );
}

/* -----------------------------
   Logs (realtime, fullscreen lines)
------------------------------ */

type LogLine = {
  at: string;
  level: string;
  source: string;
  message: string;
  raw: any;
};

function normalizeLog(r: any): LogLine {
  const at = pickString(r, ["at", "created_at", "timestamp", "time"], "") || new Date().toISOString();
  const level = pickString(r, ["level", "severity"], "info");
  const source = pickString(r, ["source", "svc", "service", "origin"], "logs");
  const message = pickString(r, ["message", "msg", "text"], safeJson(r));
  return { at, level, source, message, raw: r };
}

function emojiForSource(source: string) {
  const s = (source || "").toLowerCase();
  if (s.includes("server")) return "🖥️";
  if (s.includes("api")) return "🧩";
  if (s.includes("ai")) return "🧠";
  if (s.includes("front") || s.includes("web") || s.includes("ui")) return "🧑‍💻";
  return "📜";
}

function emojiForLevel(level: string) {
  const l = (level || "").toLowerCase();
  if (l.includes("error") || l === "err") return "❌";
  if (l.includes("warn")) return "⚠️";
  if (l.includes("debug")) return "🪲";
  return "ℹ️";
}

function RealtimeLogsTab() {
  const [rows, setRows] = useState<LogLine[]>([]);
  const [loading, setLoading] = useState(false);
  const [paused, setPaused] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [sourceFilter, setSourceFilter] = useState<string>("");

  const scrollRef = useRef<HTMLDivElement | null>(null);

  const sources = useMemo(() => {
    const uniq = new Set<string>();
    rows.forEach((r) => uniq.add(r.source));
    return Array.from(uniq).sort();
  }, [rows]);

  const visible = useMemo(() => {
    if (!sourceFilter) return rows;
    return rows.filter((r) => r.source === sourceFilter);
  }, [rows, sourceFilter]);

  const scrollToBottom = () => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  };

  const loadInitial = async () => {
    setLoading(true);
    setErr(null);
    try {
      const data = await loadTable(LOGS_TABLE, 600, "created_at");
      setRows((data as any[]).reverse().map(normalizeLog)); // oldest -> newest
      setTimeout(scrollToBottom, 50);
    } catch (e: any) {
      setErr(e?.message ?? "Failed to load logs");
      setRows([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadInitial();

    const channel = supabase
      .channel(`realtime:${LOGS_TABLE}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: LOGS_TABLE },
        (payload: any) => {
          if (paused) return;
          const next = normalizeLog(payload.new);
          setRows((prev) => {
            const merged = [...prev, next].slice(-2000);
            return merged;
          });
          setTimeout(scrollToBottom, 0);
        }
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paused]);

  return (
    <div className="admin-grid">
      <Section title="Logs (Realtime)" description={`Streaming from Supabase "${LOGS_TABLE}" as fullscreen lines.`}>
        <div className="admin-inline">
          <button className="admin-button ghost" type="button" onClick={() => void loadInitial()} disabled={loading}>
            {loading ? "Loading..." : "Reload"}
          </button>

          <button className="admin-button ghost" type="button" onClick={() => setPaused((p) => !p)}>
            {paused ? "Resume" : "Pause"}
          </button>

          <button className="admin-button ghost" type="button" onClick={() => setRows([])}>
            Clear (local)
          </button>

          <select value={sourceFilter} onChange={(e) => setSourceFilter(e.target.value)}>
            <option value="">All sources</option>
            {sources.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>

          <button
            className="admin-button ghost"
            type="button"
            onClick={() => navigator.clipboard?.writeText(visible.map((l) => `${l.at} ${l.source} ${l.level} ${l.message}`).join("\n"))}
          >
            Copy lines
          </button>
        </div>

        {err && (
          <div style={{ padding: 12, marginTop: 10, border: "1px solid crimson", color: "crimson", borderRadius: 8 }}>
            <strong>Logs error:</strong> {err}
          </div>
        )}

        <div
          ref={scrollRef}
          style={{
            marginTop: 12,
            height: "calc(100vh - 260px)",
            border: "1px solid #eee",
            borderRadius: 12,
            padding: 10,
            overflow: "auto",
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
            fontSize: 12,
            lineHeight: 1.4,
            background: "white",
          }}
        >
          {visible.length === 0 ? (
            <div className="admin-muted">{loading ? "Loading…" : "No logs yet."}</div>
          ) : (
            visible.map((l, i) => (
              <div key={`${l.at}-${i}`} style={{ whiteSpace: "pre-wrap" }}>
                {emojiForSource(l.source)} {emojiForLevel(l.level)}{" "}
                <span style={{ opacity: 0.75 }}>[{l.at}]</span>{" "}
                <span style={{ fontWeight: 700 }}>{l.source}</span>{" "}
                <span style={{ opacity: 0.8 }}>{l.level}</span>{" "}
                {l.message}
              </div>
            ))
          )}
        </div>
      </Section>
    </div>
  );
}

/* -----------------------------
   MAIN
------------------------------ */

export default function AdminDashboard() {
  const allowed = useAdminGuard();

  const [tab, setTab] = useState<TabKey>("customers");

  // runtime api base
  const [apiBase, setApiBase] = useState<string>(() => {
    try {
      return localStorage.getItem("MINA_API_BASE") || "";
    } catch {
      return "";
    }
  });

  // customers
  const [customersTable] = useState("customers");
  const [customers, setCustomers] = useState<CustomerRow[]>([]);
  const [customersLoading, setCustomersLoading] = useState(false);
  const [customersError, setCustomersError] = useState<string | null>(null);

  // generations
  const [generations, setGenerations] = useState<LiveRow[]>([]);
  const [generationsLoading, setGenerationsLoading] = useState(false);
  const [generationsError, setGenerationsError] = useState<string | null>(null);

  // feedback
  const [feedback, setFeedback] = useState<LiveRow[]>([]);
  const [feedbackLoading, setFeedbackLoading] = useState(false);
  const [feedbackError, setFeedbackError] = useState<string | null>(null);

  // filters
  const [userFilter, setUserFilter] = useState<string>("");

  // AI flat config
  const [aiRow, setAiRow] = useState<any | null>(null);
  const [aiDraft, setAiDraft] = useState<FlatAiDraft | null>(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiSaving, setAiSaving] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [aiDirty, setAiDirty] = useState(false);

  const firstLoadRef = useRef(false);

  const refreshCustomers = async () => {
    setCustomersLoading(true);
    setCustomersError(null);
    try {
      let rows = await loadTable("customers", 800, "updated_at");
      const f = userFilter.trim().toLowerCase();
      if (f) {
        rows = (rows as any[]).filter((r) => {
          const email = pickString(r, ["email", "user_email", "shopify_customer_id"], "").toLowerCase();
          const userId = pickString(r, ["user_id", "uid"], "").toLowerCase();
          const shopify = pickString(r, ["shopify_customer_id", "customer_id"], "").toLowerCase();
          return email.includes(f) || userId === f || shopify.includes(f) || String(r?.id ?? "").toLowerCase() === f;
        });
      }
      setCustomers(normalizeCustomers(rows as any[]));
    } catch (e: any) {
      setCustomersError(e?.message ?? "Failed to load customers");
      setCustomers([]);
    } finally {
      setCustomersLoading(false);
    }
  };

  const refreshGenerations = async () => {
    setGenerationsLoading(true);
    setGenerationsError(null);
    try {
      let rows = await loadTable("generations", 900, "created_at");
      const f = userFilter.trim().toLowerCase();
      if (f) {
        rows = (rows as any[]).filter((r) => {
          const email = pickString(r, ["email", "user_email"], "").toLowerCase();
          const userId = pickString(r, ["user_id", "uid"], "").toLowerCase();
          const shopify = pickString(r, ["shopify_customer_id", "customer_id"], "").toLowerCase();
          const prompt = pickString(r, ["prompt", "input_prompt", "caption", "text"], "").toLowerCase();
          return email.includes(f) || userId === f || shopify.includes(f) || prompt.includes(f);
        });
      }
      setGenerations(makeRowsFromAny("generations", rows as any[]));
    } catch (e: any) {
      setGenerationsError(e?.message ?? "Failed to load generations");
      setGenerations([]);
    } finally {
      setGenerationsLoading(false);
    }
  };

  const refreshFeedback = async () => {
    setFeedbackLoading(true);
    setFeedbackError(null);
    try {
      let rows = await loadTable("feedback", 800, "created_at");
      const f = userFilter.trim().toLowerCase();
      if (f) {
        rows = (rows as any[]).filter((r) => {
          const email = pickString(r, ["email", "user_email"], "").toLowerCase();
          const userId = pickString(r, ["user_id", "uid"], "").toLowerCase();
          const genId = pickString(r, ["generation_id", "gen_id"], "").toLowerCase();
          return email.includes(f) || userId === f || genId.includes(f);
        });
      }
      setFeedback(makeRowsFromAny("feedback", rows as any[]));
    } catch (e: any) {
      setFeedbackError(e?.message ?? "Failed to load feedback");
      setFeedback([]);
    } finally {
      setFeedbackLoading(false);
    }
  };

  const refreshAi = async () => {
    setAiLoading(true);
    setAiError(null);
    try {
      const row = await loadFlatAiConfig();
      setAiRow(row);
      setAiDraft(normalizeFlatAiRow(row ?? {}));
      setAiDirty(false);
    } catch (e: any) {
      setAiError(e?.message ?? "Failed to load AI config");
      setAiRow(null);
      setAiDraft({
        defaultProvider: "",
        defaultModel: "",
        temperature: 0.7,
        topP: 1,
        maxTokens: 1024,
        context: "",
        providerParamsJson: "{}",
      });
      setAiDirty(false);
    } finally {
      setAiLoading(false);
    }
  };

  const saveAi = async () => {
    if (!aiDraft) return;
    setAiSaving(true);
    setAiError(null);
    try {
      await saveFlatAiConfig(aiRow, aiDraft);
      await refreshAi();
      alert("AI config saved ✅");
    } catch (e: any) {
      setAiError(e?.message ?? "Save failed");
      alert(e?.message ?? "Save failed");
    } finally {
      setAiSaving(false);
    }
  };

  useEffect(() => {
    if (allowed !== true) return;
    if (firstLoadRef.current) return;
    firstLoadRef.current = true;

    void refreshCustomers();
    void refreshGenerations();
    void refreshFeedback();
    void refreshAi();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allowed]);

  const applyFilter = () => {
    void refreshCustomers();
    void refreshGenerations();
    void refreshFeedback();
  };

  if (allowed === null) return <div style={{ padding: 24 }}>Loading admin…</div>;
  if (allowed === false) return null;

  const rightStatus = (
    <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
      <span className="admin-muted" style={{ fontSize: 12 }}>
        Customers: <strong>{customers.length}</strong>
      </span>
      <span className="admin-muted" style={{ fontSize: 12 }}>
        Generations: <strong>{generations.length}</strong>
      </span>
      <span className="admin-muted" style={{ fontSize: 12 }}>
        Feedback: <strong>{feedback.length}</strong>
      </span>
    </div>
  );

  const rightActions =
    tab === "ai" ? (
      <button className="admin-button" onClick={() => void saveAi()} disabled={aiSaving || !aiDirty}>
        {aiSaving ? "Saving..." : "Save"}
      </button>
    ) : null;

  const filterBar = (
    <>
      <input
        value={userFilter}
        onChange={(e) => setUserFilter(e.target.value)}
        style={{ minWidth: 340 }}
      />
      <button className="admin-button ghost" type="button" onClick={applyFilter}>
        Apply filter
      </button>
      <button
        className="admin-button ghost"
        type="button"
        onClick={() => {
          setUserFilter("");
          setTimeout(() => applyFilter(), 0);
        }}
      >
        Clear
      </button>
    </>
  );

  // mark AI dirty on any draft change
  const setAiDraftDirty = (next: FlatAiDraft) => {
    setAiDraft(next);
    setAiDirty(true);
  };

  return (
    <div className="admin-shell">
      <AdminHeader rightStatus={rightStatus} rightActions={rightActions} />
      <StickyTabs active={tab} onChange={setTab} />

      <div className="admin-content">
        {tab === "runtime" && (
          <div className="admin-grid">
            <Section
              title="Runtime Config (Live backend)"
              description="Edit the live backend runtime config (models, replicate params, GPT temp/tokens, system/user append)."
            >
              <div className="admin-inline">
                <label style={{ minWidth: 420 }}>
                  <strong>API Base URL (optional)</strong>
                  <input
                    value={apiBase}
                    onChange={(e) => {
                      const v = e.target.value;
                      setApiBase(v);
                      try {
                        localStorage.setItem("MINA_API_BASE", v);
                      } catch {}
                    }}
                  />
                </label>

                <button
                  className="admin-button ghost"
                  type="button"
                  onClick={() => {
                    setApiBase("");
                    try {
                      localStorage.removeItem("MINA_API_BASE");
                    } catch {}
                  }}
                >
                  Use same domain
                </button>
              </div>

              <div style={{ marginTop: 12 }}>
                <RuntimeConfigFlatEditor />

                <div style={{ height: 18 }} />

                <details>
                  <summary style={{ cursor: "pointer", fontWeight: 800 }}>
                    Advanced: Raw runtime JSON editor (legacy)
                  </summary>
                  <div style={{ marginTop: 12 }}>
                    <RuntimeConfigEditor apiBase={apiBase} />
                  </div>
                </details>
              </div>
            </Section>
          </div>
        )}

        {tab === "ai" && (
          <FlatAiConfigTab
            row={aiRow}
            draft={aiDraft}
            setDraft={setAiDraftDirty}
            loading={aiLoading}
            error={aiError}
            onRefresh={() => void refreshAi()}
            onSave={() => void saveAi()}
            saving={aiSaving}
            dirty={aiDirty}
          />
        )}

        {tab === "customers" && (
          <CustomersTab
            customers={customers}
            loading={customersLoading}
            error={customersError}
            onRefresh={() => void refreshCustomers()}
            customersTable={customersTable}
          />
        )}

        {tab === "generations" && (
          <LiveTableTab
            tableName="generations"
            title="Generations"
            description="Shows ALL stored columns. Select one to view raw fields. You can delete selected."
            rows={generations}
            loading={generationsLoading}
            error={generationsError}
            onRefresh={() => void refreshGenerations()}
            filterLabel={filterBar}
            allowDelete
          />
        )}

        {tab === "feedback" && (
          <LiveTableTab
            tableName="feedback"
            title="Feedback"
            description="Likes / feedback rows. Select one to view raw fields. You can delete selected."
            rows={feedback}
            loading={feedbackLoading}
            error={feedbackError}
            onRefresh={() => void refreshFeedback()}
            filterLabel={filterBar}
            allowDelete
          />
        )}

        {tab === "logs" && <RealtimeLogsTab />}
      </div>

      <div className="admin-footer">
        Live tables are read/update directly.
        <span className="admin-muted" style={{ marginLeft: 10 }}>
          AI config table: <strong>{AI_FLAT_TABLE}</strong> • Logs table: <strong>{LOGS_TABLE}</strong>
        </span>
      </div>
    </div>
  );
} there is a logique behind the app you need to understand so i suggest you readl all the revious codes i gave you and these new and try to extract the logique the app runs on then the tables its is using and specifically the column next we will start cleaning // src/lib/supabaseClient.ts
import { createClient } from "@supabase/supabase-js";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error("Missing Supabase env vars (VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY)");
}

// Safe storage (prevents crashes in non-browser builds)
const storage =
  typeof window !== "undefined" && window.localStorage
    ? window.localStorage
    : undefined;

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    // ✅ keeps user logged in
    persistSession: true,

    // ✅ where it’s stored in localStorage
    storageKey: "mina-auth",

    // ✅ important for OAuth + magic-link redirects (PKCE flow is recommended)
    flowType: "pkce",
    detectSessionInUrl: true,

    // ✅ keeps JWT fresh
    autoRefreshToken: true,

    // ✅ custom storage (optional but safer)
    storage,
  },
});

/**
 * Mina API helper: returns the Supabase JWT (access token) if logged in.
 * Use this token as: Authorization: Bearer <token>
 */
export async function getSupabaseJwt(): Promise<string | null> {
  const { data, error } = await supabase.auth.getSession();
  if (error) return null;
  return data.session?.access_token ?? null;
}

/**
 * Mina API helper: builds headers with JWT when available.
 */
export async function withSupabaseAuthHeaders(
  base: Record<string, string> = {}
): Promise<Record<string, string>> {
  const jwt = await getSupabaseJwt();
  return jwt ? { ...base, Authorization: `Bearer ${jwt}` } : base;
}  9th file import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "./supabaseClient";

export type AdminStyleAsset = {
  id: string;
  name: string;
  trainingText: string;
  images: string[];
  heroImage?: string;
  status: "draft" | "published";
};

export type AdminProviderKey = {
  provider: string;
  masked?: string;
  // IMPORTANT: we do NOT persist secret in the config JSON.
  // It's only used transiently in the UI when user pastes it.
  secret?: string;
};

export type AdminConfig = {
  ai: {
    providerKeys: AdminProviderKey[];
    defaultProvider: string;
    defaultModel: string;
    temperature: number;
    topP: number;
    maxTokens: number;
    context: string;
    providerParams: { key: string; value: string }[];
    futureReplicateNotes: string;
  };
  pricing: {
    defaultCredits: number;
    expirationDays: number;
    imageCost: number;
    motionCost: number;
  };
  styles: {
    presets: AdminStyleAsset[];
    movementKeywords: string[];
  };
  generations: {
    records: Array<{
      id: string;
      prompt: string;
      user: string;
      model: string;
      status: string;
      url?: string;
      cost?: number;
      liked?: boolean;
      createdAt?: string;
      params?: any;
    }>;
    filters: { status: string; model: string; query: string };
  };
  clients: Array<{
    id: string;
    email: string;
    credits: number;
    expiresAt?: string;
    lastActive?: string;
    disabled?: boolean;
  }>;
  logs: Array<{
    id: string;
    level: "info" | "warn" | "error";
    message: string;
    at: string;
    source: string;
  }>;
  architecture: string;
  assets: {
    primaryColor: string;
    secondaryColor: string;
    fontFamily: string;
    logo: string;
    otherAssets: Array<{ id: string; name: string; url: string }>;
  };
};

const CONFIG_TABLE = "mina_admin_config";
const SECRETS_TABLE = "mina_admin_secrets";
const SINGLETON_ID = "singleton";

function deepMerge<T>(base: T, patch: any): T {
  if (patch == null || typeof patch !== "object") return base;
  if (Array.isArray(base)) return (patch as any) ?? (base as any);

  const out: any = { ...(base as any) };
  for (const k of Object.keys(patch)) {
    const bv = (base as any)[k];
    const pv = patch[k];
    if (bv && typeof bv === "object" && !Array.isArray(bv)) out[k] = deepMerge(bv, pv);
    else out[k] = pv;
  }
  return out;
}

export function createDefaultAdminConfig(): AdminConfig {
  return {
    ai: {
      providerKeys: [{ provider: "replicate", masked: "" }],
      defaultProvider: "replicate",
      defaultModel: "",
      temperature: 0.7,
      topP: 1,
      maxTokens: 2048,
      context: "",
      providerParams: [],
      futureReplicateNotes: "",
    },
    pricing: {
      defaultCredits: 50,
      expirationDays: 30,
      imageCost: 1,
      motionCost: 2,
    },
    styles: {
      presets: [],
      movementKeywords: [],
    },
    generations: {
      records: [],
      filters: { status: "", model: "", query: "" },
    },
    clients: [],
    logs: [],
    architecture: "",
    assets: {
      primaryColor: "#000000",
      secondaryColor: "#ffffff",
      fontFamily: "Inter, system-ui, Arial",
      logo: "",
      otherAssets: [],
    },
  };
}

export function loadAdminConfig(): AdminConfig {
  return createDefaultAdminConfig();
}

function sanitizeConfigForSave(cfg: AdminConfig): AdminConfig {
  const copy: AdminConfig = JSON.parse(JSON.stringify(cfg));

  // never persist secrets inside the config json
  copy.ai.providerKeys = (copy.ai.providerKeys || []).map((k) => ({
    provider: String(k.provider || "").trim(),
    masked: k.masked || "",
  }));

  // remove empty provider params
  copy.ai.providerParams = (copy.ai.providerParams || [])
    .map((p) => ({ key: String(p.key || "").trim(), value: String(p.value || "") }))
    .filter((p) => p.key.length > 0);

  return copy;
}

export async function isAdmin(): Promise<boolean> {
  const { data, error } = await supabase.rpc("is_mina_admin");
  if (error) return false;
  return Boolean(data);
}

export function maskSecret(secret: string): string {
  if (!secret) return "";
  if (secret.length <= 4) return "••••";
  return `${"•".repeat(Math.max(4, secret.length - 4))}${secret.slice(-4)}`;
}

export async function upsertAdminSecret(provider: string, secret: string): Promise<string> {
  const email = (await supabase.auth.getUser()).data.user?.email ?? null;
  const masked = maskSecret(secret);

  const { error } = await supabase
    .from(SECRETS_TABLE)
    .upsert(
      {
        provider,
        secret,
        masked,
        updated_at: new Date().toISOString(),
        updated_by: email,
      },
      { onConflict: "provider" }
    );

  if (error) throw error;
  return masked;
}

async function fetchMaskedSecrets(): Promise<Record<string, string>> {
  const { data, error } = await supabase.from(SECRETS_TABLE).select("provider, masked");
  if (error) throw error;

  const map: Record<string, string> = {};
  for (const row of data ?? []) map[row.provider] = row.masked;
  return map;
}

export async function fetchAdminConfig(): Promise<AdminConfig> {
  const { data, error } = await supabase
    .from(CONFIG_TABLE)
    .select("config")
    .eq("id", SINGLETON_ID)
    .maybeSingle();

  if (error) throw error;

  const base = createDefaultAdminConfig();
  const merged = deepMerge(base, (data?.config as any) ?? {});
  const maskedSecrets = await fetchMaskedSecrets();

  merged.ai.providerKeys = (merged.ai.providerKeys || []).map((k: any) => ({
    provider: k.provider,
    masked: maskedSecrets[k.provider] ?? k.masked ?? "",
  }));

  // ensure there is at least one provider row
  if (!merged.ai.providerKeys.length) merged.ai.providerKeys = [{ provider: "replicate", masked: maskedSecrets["replicate"] ?? "" }];

  return merged;
}

export async function saveAdminConfig(next: AdminConfig): Promise<void> {
  const email = (await supabase.auth.getUser()).data.user?.email ?? null;
  const sanitized = sanitizeConfigForSave(next);

  const { error } = await supabase
    .from(CONFIG_TABLE)
    .upsert(
      {
        id: SINGLETON_ID,
        config: sanitized,
        updated_at: new Date().toISOString(),
        updated_by: email,
      },
      { onConflict: "id" }
    );

  if (error) throw error;
}

export function useAdminConfigState() {
  const [config, setConfig] = useState<AdminConfig>(createDefaultAdminConfig());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const cfg = await fetchAdminConfig();
      setConfig(cfg);
    } catch (e: any) {
      setError(e?.message ?? "Failed to load admin config");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const updateConfig = useCallback(async (next: AdminConfig) => {
    setError(null);
    await saveAdminConfig(next);
    setConfig(next);
  }, []);

  const memo = useMemo(
    () => ({ config, setConfig, updateConfig, refresh, loading, error }),
    [config, updateConfig, refresh, loading, error]
  );

  return memo;
} 10th file //RuntimeConfigFlatEditor.tsx
import React, { useEffect, useMemo, useState } from "react";
import { supabase } from "../lib/supabaseClient";

type FlatRow = {
  id: boolean;

  models_seadream: string | null;
  models_kling: string | null;

  credits_image_cost: number | null;
  credits_motion_cost: number | null;

  kling_mode: string | null;
  kling_negative_prompt: string | null;

  gpt_editorial_temperature: number | null;
  gpt_editorial_max_tokens: number | null;

  prompt_system: string | null;
  prompt_append_system: string | null;
  prompt_append_user: string | null;

  updated_at?: string | null;
};

const DEFAULT_ROW: FlatRow = {
  id: true,

  models_seadream: null,
  models_kling: null,

  credits_image_cost: null,
  credits_motion_cost: null,

  kling_mode: null,
  kling_negative_prompt: null,

  gpt_editorial_temperature: null,
  gpt_editorial_max_tokens: null,

  prompt_system: null,
  prompt_append_system: null,
  prompt_append_user: null,
};

function toNumOrNull(v: string): number | null {
  const s = String(v ?? "").trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

export default function RuntimeConfigFlatEditor() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [row, setRow] = useState<FlatRow>(DEFAULT_ROW);
  const [baseline, setBaseline] = useState<string>("");

  const [effectiveJson, setEffectiveJson] = useState<any>(null);
  const [effectiveMeta, setEffectiveMeta] = useState<{ updated_at?: string; updated_by?: string } | null>(null);
  const [effectiveLoading, setEffectiveLoading] = useState(false);

  const dirty = useMemo(() => {
    const cur = JSON.stringify(row);
    return baseline && cur !== baseline;
  }, [row, baseline]);

  const loadFlat = async () => {
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from("runtime_config_flat")
        .select("*")
        .eq("id", true)
        .maybeSingle();

      if (error) throw new Error(error.message);

      const merged = { ...DEFAULT_ROW, ...(data ?? { id: true }) } as FlatRow;
      setRow(merged);
      setBaseline(JSON.stringify(merged));
    } finally {
      setLoading(false);
    }
  };

  const loadEffective = async () => {
    setEffectiveLoading(true);
    try {
      const { data, error } = await supabase
        .from("app_config")
        .select("value, updated_at, updated_by")
        .eq("key", "runtime")
        .maybeSingle();

      if (error) throw new Error(error.message);

      setEffectiveJson(data?.value ?? null);
      setEffectiveMeta({ updated_at: data?.updated_at, updated_by: data?.updated_by });
    } finally {
      setEffectiveLoading(false);
    }
  };

  useEffect(() => {
    void loadFlat().then(loadEffective);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const save = async () => {
    setSaving(true);
    try {
      const payload: FlatRow = { ...row, id: true };

      const { error } = await supabase
        .from("runtime_config_flat")
        .upsert(payload, { onConflict: "id" });

      if (error) throw new Error(error.message);

      setBaseline(JSON.stringify(payload));
      await loadEffective();
      alert("Runtime flat config saved ✅ (app_config.runtime updated)");
    } catch (e: any) {
      alert(e?.message ?? "Save failed");
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <div className="admin-muted">Loading flat runtime config…</div>;

  return (
    <div style={{ display: "grid", gap: 14 }}>
      <div className="admin-inline" style={{ alignItems: "center" }}>
        <button className="admin-button" type="button" onClick={() => void save()} disabled={saving || !dirty}>
          {saving ? "Saving…" : dirty ? "Save flat runtime" : "Saved"}
        </button>

        <button className="admin-button ghost" type="button" onClick={() => void loadFlat()} disabled={saving}>
          Reload
        </button>

        <button className="admin-button ghost" type="button" onClick={() => void loadEffective()} disabled={effectiveLoading}>
          {effectiveLoading ? "Refreshing…" : "Refresh effective JSON"}
        </button>

        {dirty && <span className="admin-muted">Unsaved changes.</span>}
      </div>

      {/* MODELS */}
      <div className="admin-card">
        <div className="admin-card-title">Models</div>
        <div className="admin-inline">
          <label>
            <strong>Seedream model</strong>
            <input
              value={row.models_seadream ?? ""}
              onChange={(e) => setRow((r) => ({ ...r, models_seadream: e.target.value || null }))}
              placeholder="e.g. seedream-v3"
            />
          </label>

          <label>
            <strong>Kling model</strong>
            <input
              value={row.models_kling ?? ""}
              onChange={(e) => setRow((r) => ({ ...r, models_kling: e.target.value || null }))}
              placeholder="e.g. kling-1.6"
            />
          </label>
        </div>
      </div>

      {/* CREDITS */}
      <div className="admin-card">
        <div className="admin-card-title">Credits (runtime)</div>
        <div className="admin-inline">
          <label>
            <strong>Image cost</strong>
            <input
              type="number"
              value={row.credits_image_cost ?? ""}
              onChange={(e) => setRow((r) => ({ ...r, credits_image_cost: toNumOrNull(e.target.value) }))}
              placeholder="e.g. 4"
            />
          </label>

          <label>
            <strong>Motion cost</strong>
            <input
              type="number"
              value={row.credits_motion_cost ?? ""}
              onChange={(e) => setRow((r) => ({ ...r, credits_motion_cost: toNumOrNull(e.target.value) }))}
              placeholder="e.g. 30"
            />
          </label>
        </div>

        <div className="admin-muted" style={{ marginTop: 8 }}>
          Note: Your backend must **use runtime cfg** when charging. If an endpoint still returns hardcoded consts, it won’t reflect changes.
        </div>
      </div>

      {/* KLING */}
      <div className="admin-card">
        <div className="admin-card-title">Kling (Replicate params)</div>
        <div className="admin-inline">
          <label>
            <strong>Mode</strong>
            <input
              value={row.kling_mode ?? ""}
              onChange={(e) => setRow((r) => ({ ...r, kling_mode: e.target.value || null }))}
              placeholder="e.g. standard / pro"
            />
          </label>
        </div>

        <label>
          <strong>Negative prompt</strong>
          <textarea
            className="admin-textarea"
            value={row.kling_negative_prompt ?? ""}
            onChange={(e) => setRow((r) => ({ ...r, kling_negative_prompt: e.target.value || null }))}
            placeholder="What you want the model to avoid…"
          />
        </label>
      </div>

      {/* GPT */}
      <div className="admin-card">
        <div className="admin-card-title">GPT Editorial</div>
        <div className="admin-inline">
          <label>
            <strong>Temperature</strong>
            <input
              type="number"
              step="0.1"
              value={row.gpt_editorial_temperature ?? ""}
              onChange={(e) => setRow((r) => ({ ...r, gpt_editorial_temperature: toNumOrNull(e.target.value) }))}
              placeholder="e.g. 0.7"
            />
          </label>

          <label>
            <strong>Max tokens</strong>
            <input
              type="number"
              value={row.gpt_editorial_max_tokens ?? ""}
              onChange={(e) => setRow((r) => ({ ...r, gpt_editorial_max_tokens: toNumOrNull(e.target.value) }))}
              placeholder="e.g. 900"
            />
          </label>
        </div>
      </div>

      {/* PROMPTS */}
      <div className="admin-card">
        <div className="admin-card-title">Prompts</div>

        <label>
          <strong>System prompt override</strong>
          <textarea
            className="admin-textarea"
            value={row.prompt_system ?? ""}
            onChange={(e) => setRow((r) => ({ ...r, prompt_system: e.target.value || null }))}
            placeholder="If empty -> backend default stays"
          />
        </label>

        <label>
          <strong>Append to system (after default)</strong>
          <textarea
            className="admin-textarea"
            value={row.prompt_append_system ?? ""}
            onChange={(e) => setRow((r) => ({ ...r, prompt_append_system: e.target.value || null }))}
          />
        </label>

        <label>
          <strong>Append to user message</strong>
          <textarea
            className="admin-textarea"
            value={row.prompt_append_user ?? ""}
            onChange={(e) => setRow((r) => ({ ...r, prompt_append_user: e.target.value || null }))}
          />
        </label>
      </div>

      {/* EFFECTIVE JSON */}
      <div className="admin-card">
        <div className="admin-card-title">Effective runtime JSON (app_config.key='runtime')</div>
        <div className="admin-muted" style={{ marginBottom: 8 }}>
          {effectiveMeta?.updated_at ? `updated_at: ${effectiveMeta.updated_at}` : ""}
          {effectiveMeta?.updated_by ? ` • updated_by: ${effectiveMeta.updated_by}` : ""}
        </div>
        <pre style={{ whiteSpace: "pre-wrap", margin: 0 }}>
          {JSON.stringify(effectiveJson ?? {}, null, 2)}
        </pre>
      </div>
    </div>
  );
} import React, { useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "../lib/supabaseClient";

type AuthGateProps = {
  children: React.ReactNode;
};

const API_BASE_URL =
  import.meta.env.VITE_MINA_API_BASE_URL || "https://mina-editorial-ai-api.onrender.com";
// ✅ baseline: your “3,7k” starting point
const BASELINE_USERS = 0;

/**
 * Create / upsert a Shopify customer (lead) for email marketing.
 * - Non-blocking by design (short timeout).
 * - Returns shopifyCustomerId if backend provides it.
 */
async function syncShopifyWelcome(
  email: string | null | undefined,
  userId?: string,
  timeoutMs: number = 3500
): Promise<string | null> {
  const clean = (email || "").trim().toLowerCase();
  if (!API_BASE_URL || !clean) return null;

  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(`${API_BASE_URL}/auth/shopify-sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: clean, userId }),
      signal: controller.signal,
    });

    const json = await res.json().catch(() => ({} as any));
    if (!res.ok || json?.ok === false) return null;

    const shopifyCustomerId =
      typeof json.shopifyCustomerId === "string"
        ? json.shopifyCustomerId
        : typeof json.customerId === "string"
          ? json.customerId
          : typeof json.id === "string"
            ? json.id
            : null;

    return shopifyCustomerId;
  } catch {
    return null; // non-blocking
  } finally {
    window.clearTimeout(timeout);
  }
}

function getInboxHref(email: string | null): string {
  if (!email) return "mailto:";

  const parts = email.split("@");
  if (parts.length !== 2) return "mailto:";

  const domain = parts[1].toLowerCase();

  if (domain === "gmail.com") return "https://mail.google.com/mail/u/0/#inbox";

  if (["outlook.com", "hotmail.com", "live.com"].includes(domain)) {
    return "https://outlook.live.com/mail/0/inbox";
  }

  if (domain === "yahoo.com") {
    return "https://mail.yahoo.com/d/folders/1";
  }

  if (domain === "icloud.com" || domain.endsWith(".me.com") || domain.endsWith(".mac.com")) {
    return "https://www.icloud.com/mail";
  }

  return `mailto:${email}`;
}

function formatUserCount(n: number | null): string {
  if (!Number.isFinite(n as number) || n === null) return "";
  const value = Math.max(0, Math.round(n));

  if (value >= 1_000_000) {
    const m = value / 1_000_000;
    return `${m.toFixed(m >= 10 ? 0 : 1).replace(/\.0$/, "")}m`;
  }

  if (value >= 1_000) {
    const k = value / 1_000;
    return `${k.toFixed(k >= 10 ? 0 : 1).replace(/\.0$/, "")}k`;
  }

  return String(value);
}

export function AuthGate({ children }: AuthGateProps) {
  const [session, setSession] = useState<Session | null>(null);
  const [initializing, setInitializing] = useState(true);

  const [email, setEmail] = useState("");
  const [otpSent, setOtpSent] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);

  const [emailMode, setEmailMode] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [googleOpening, setGoogleOpening] = useState(false);

  // ✅ this holds “new users count” coming from your API
  const [newUsers, setNewUsers] = useState<number | null>(null);

  const [bypassForNow] = useState(false);

  // ✅ final displayed count
  const displayedUsers = BASELINE_USERS + (newUsers ?? 0);
  const displayedUsersLabel = `${formatUserCount(displayedUsers)} curators use Mina`;

  // Session bootstrap + auth listener
  useEffect(() => {
    let mounted = true;

    const init = async () => {
      try {
        const { data } = await supabase.auth.getSession();
        if (!mounted) return;
        setSession(data.session ?? null);
      } finally {
        if (mounted) setInitializing(false);
      }
    };

    void init();

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, newSession) => {
      setSession(newSession);

      if (event === "SIGNED_OUT") {
        setEmail("");
        setOtpSent(false);
        setSentTo(null);
        setEmailMode(false);
        setError(null);
        setGoogleOpening(false);
        return;
      }

      // ✅ After successful auth, we can sync again with userId (better dedupe / linkage)
      if (event === "SIGNED_IN" && newSession?.user?.email) {
        const signedEmail = newSession.user.email;
        const userId = newSession.user.id;

        void (async () => {
          const shopifyCustomerId = await syncShopifyWelcome(signedEmail, userId);

          if (shopifyCustomerId && typeof window !== "undefined") {
            try {
              window.localStorage.setItem("minaCustomerId", shopifyCustomerId);
            } catch {
              // ignore
            }
          }
        })();
      }
    });

    return () => {
      mounted = false;
      subscription.unsubscribe();
    };
  }, []);

  // Public stats (optional)
  useEffect(() => {
    let cancelled = false;

    const fetchStats = async () => {
      try {
        // IMPORTANT: this endpoint should return the number of *new users* (delta),
        // not the full total, because we add BASELINE_USERS on the frontend.
        const res = await fetch(`${API_BASE_URL}/public/stats/total-users`);
        if (!res.ok) return;

        const json = await res.json().catch(() => ({} as any));

        // expecting: { ok: true, totalUsers: <number> }
        if (!cancelled && json.ok && typeof json.totalUsers === "number" && json.totalUsers >= 0) {
          setNewUsers(json.totalUsers);
        }
      } catch {
        // silent
      }
    };

    void fetchStats();

    return () => {
      cancelled = true;
    };
  }, []);

  // ✅ Email OTP flow — sync Shopify immediately on "Sign in" click (lead capture)
  const handleEmailLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = email.trim();
    if (!trimmed) return;

    setError(null);
    setLoading(true);

    // Fire-and-forget: create/upsert Shopify customer NOW (even if user never clicks magic link)
    void (async () => {
      const preShopifyId = await syncShopifyWelcome(trimmed, undefined);
      if (preShopifyId && typeof window !== "undefined") {
        try {
          window.localStorage.setItem("minaCustomerId", preShopifyId);
        } catch {
          // ignore
        }
      }
    })();

    try {
      const { error: supaError } = await supabase.auth.signInWithOtp({
        email: trimmed,
        options: {
          emailRedirectTo: window.location.origin,
        },
      });

      if (supaError) throw supaError;

      setOtpSent(true);
      setSentTo(trimmed);

      // fallback (don’t overwrite a real Shopify id if it arrives)
      try {
        if (typeof window !== "undefined") {
          const existing = window.localStorage.getItem("minaCustomerId");
          if (!existing) window.localStorage.setItem("minaCustomerId", trimmed);
        }
      } catch {
        // ignore
      }
    } catch (err: any) {
      setError(err?.message || "Failed to send login link.");
    } finally {
      setLoading(false);
    }
  };

  const handleGoogleLogin = async () => {
    setError(null);
    setGoogleOpening(true);
    try {
      const { error: supaError } = await supabase.auth.signInWithOAuth({
        provider: "google",
        options: {
          redirectTo: window.location.origin,
        },
      });
      if (supaError) throw supaError;
    } catch (err: any) {
      setError(err?.message || "Failed to start Google login.");
      setGoogleOpening(false);
    }
  };

  if (initializing) {
    return (
      <div className="mina-auth-shell">
        <div className="mina-auth-left">
          <div className="mina-auth-brand">
            <img
              src="https://cdn.shopify.com/s/files/1/0678/9254/3571/files/Minalogo.svg?v=1765367006"
              alt="Mina"
            />
          </div>
          <div className="mina-auth-card">
            <p className="mina-auth-text">Loading…</p>
          </div>

          {/* ✅ always show baseline+new */}
          <div className="mina-auth-footer">{displayedUsersLabel}</div>
        </div>
        <div className="mina-auth-right" />
      </div>
    );
  }

  if (session || bypassForNow) {
    return <>{children}</>;
  }

  const trimmed = email.trim();
  const hasEmail = trimmed.length > 0;
  const targetEmail = sentTo || (hasEmail ? trimmed : null);
  const inboxHref = getInboxHref(targetEmail);
  const openInNewTab = inboxHref.startsWith("http");

  const showBack = (emailMode && hasEmail) || otpSent;

  return (
    <div className="mina-auth-shell">
      <div className="mina-auth-left">
        <div className="mina-auth-brand">
          <img
            src="https://cdn.shopify.com/s/files/1/0678/9254/3571/files/Minalogo.svg?v=1765367006"
            alt="Mina"
          />
        </div>

        <div className="mina-auth-card">
          <div className={showBack ? "mina-fade mina-auth-back-wrapper" : "mina-fade hidden mina-auth-back-wrapper"}>
            <button
              type="button"
              className="mina-auth-back"
              onClick={() => {
                if (otpSent) {
                  setOtpSent(false);
                  setSentTo(null);
                  setError(null);
                  setEmailMode(true);
                } else {
                  setEmailMode(false);
                  setEmail("");
                  setError(null);
                  setGoogleOpening(false);
                }
              }}
              aria-label="Back"
            >
              <img
                src="https://cdn.shopify.com/s/files/1/0678/9254/3571/files/back-svgrepo-com.svg?v=1765359286"
                alt=""
              />
            </button>
          </div>

          {!otpSent ? (
            <>
              <div className="mina-auth-actions">
                <div className="mina-auth-stack">
                  <div className={"fade-overlay auth-panel auth-panel--google " + (emailMode ? "hidden" : "visible")}>
                    <button type="button" className="mina-auth-link mina-auth-main" onClick={handleGoogleLogin}>
                      {googleOpening ? "Opening Google…" : "Login with Google"}
                    </button>

                    <div style={{ marginTop: 8 }}>
                      <button
                        type="button"
                        className="mina-auth-link secondary"
                        onClick={() => {
                          setEmailMode(true);
                          setError(null);
                        }}
                        disabled={loading}
                      >
                        Use email instead
                      </button>
                    </div>
                  </div>

                  <div className={"fade-overlay auth-panel auth-panel--email " + (emailMode ? "visible" : "hidden")}>
                    <form onSubmit={handleEmailLogin} className="mina-auth-form">
                      <label className="mina-auth-label">
                        <input
                          className="mina-auth-input"
                          type="email"
                          placeholder="Type email here"
                          value={email}
                          onChange={(e) => setEmail(e.target.value)}
                        />
                      </label>

                      <div className={hasEmail ? "fade-block delay" : "fade-block hidden"}>
                        <button type="submit" className="mina-auth-link mina-auth-main small" disabled={loading || !hasEmail}>
                          {loading ? "Sending link…" : "Sign in"}
                        </button>
                      </div>

                      <div className={hasEmail ? "fade-block delay" : "fade-block hidden"}>
                        <p className="mina-auth-hint">
                          We’ll email you a one-time link. If this address is new, that email will also confirm your account.
                        </p>
                      </div>
                    </form>
                  </div>
                </div>
              </div>

              {error && <div className="mina-auth-error">{error}</div>}
            </>
          ) : (
            <>
              <div className="mina-auth-actions">
                <div className="mina-auth-stack">
                  <div className="fade-overlay auth-panel auth-panel--check visible">
                    <a
                      className="mina-auth-link mina-auth-main"
                      href={inboxHref}
                      target={openInNewTab ? "_blank" : undefined}
                      rel={openInNewTab ? "noreferrer" : undefined}
                    >
                      Open email app
                    </a>
                    <p className="mina-auth-text" style={{ marginTop: 8 }}>
                      We’ve sent a sign-in link to {targetEmail ? <strong>{targetEmail}</strong> : "your inbox"}. Open it to continue with Mina.
                    </p>
                  </div>
                </div>
              </div>

              {error && <div className="mina-auth-error">{error}</div>}
            </>
          )}
        </div>

        {/* ✅ always show baseline+new */}
        <div className="mina-auth-footer">{displayedUsersLabel}</div>
      </div>

      <div className="mina-auth-right" />
    </div>
  );
} 11th file import React, { useEffect, useState } from "react";
import { supabase } from "../lib/supabaseClient";

/**
 * Shows an "Admin" link only if the current user is in the allowlist table.
 *
 * IMPORTANT:
 * - Table name assumed: public.admin_allowlist
 * - Column assumed: email (text) UNIQUE
 * If your table is named differently, change TABLE below.
 */
const TABLE = "admin_allowlist";

export default function AdminLink() {
  const [ready, setReady] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);

  useEffect(() => {
    let alive = true;

    (async () => {
      try {
        const { data } = await supabase.auth.getUser();
        const email = (data.user?.email || "").toLowerCase();
        if (!email) {
          if (!alive) return;
          setIsAdmin(false);
          setReady(true);
          return;
        }

        // If user is not admin, RLS might block read — treat as not admin.
        const { data: row, error } = await supabase
          .from(TABLE)
          .select("email")
          .eq("email", email)
          .maybeSingle();

        if (!alive) return;

        if (error) {
          setIsAdmin(false);
        } else {
          setIsAdmin(!!row?.email);
        }

        setReady(true);
      } catch {
        if (!alive) return;
        setIsAdmin(false);
        setReady(true);
      }
    })();

    return () => {
      alive = false;
    };
  }, []);

  if (!ready || !isAdmin) return null;

  // Your app uses pathname switching, so a normal <a href="/admin"> works.
  return (
    <a
      href="/admin"
      style={{
        display: "inline-block",
        fontSize: 12,
        fontWeight: 600,
        letterSpacing: "-0.01em",
        color: "rgba(8,10,0,0.9)",
        textDecoration: "underline",
        textUnderlineOffset: 3,
      }}
    >
      Admin
    </a>
  );
} so before doing anything understand the 3 main part of my code and how they are interacting with tables and type everyhting in file lets namei MINALOGIC and i will storing all the ideas and then when i finish the others files we start brainstomring on minalogic "use strict";

require("dotenv").config();

const express = require("express");
const cors = require("cors");
const morgan = require("morgan");

const { getSupabaseAdmin, logAdminAction } = require("./supabase");
const { requireAdmin, tryAdmin } = require("./auth");
const { sanitizeConfigForPublic, sanitizeConfigForStorage, maskSecret } = require("./sanitize");

const app = express();

app.use(
  cors({
    origin: (origin, cb) => {
      const allow = (process.env.CORS_ORIGINS || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);

      // If no origin (curl/postman) or no allowlist defined, allow.
      if (!origin || allow.length === 0) return cb(null, true);

      if (allow.includes(origin)) return cb(null, true);
      return cb(new Error("CORS blocked"), false);
    },
    credentials: true
  })
);

app.use(express.json({ limit: "10mb" }));
app.use(morgan("tiny"));

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "mina-admin-config-api" });
});

// ---------- Helpers ----------
async function readSingletonConfig() {
  const supabase = getSupabaseAdmin();
  if (!supabase) throw new Error("Supabase not configured");
  const { data, error } = await supabase
    .from("mina_admin_config")
    .select("config")
    .eq("id", "singleton")
    .maybeSingle();

  if (error) throw error;
  return (data && data.config) ? data.config : {};
}

async function writeSingletonConfig(nextConfig, updatedBy) {
  const supabase = getSupabaseAdmin();
  if (!supabase) throw new Error("Supabase not configured");
  const { data, error } = await supabase
    .from("mina_admin_config")
    .upsert(
      {
        id: "singleton",
        config: nextConfig,
        updated_at: new Date().toISOString(),
        updated_by: updatedBy || null
      },
      { onConflict: "id" }
    )
    .select("config")
    .maybeSingle();

  if (error) throw error;
  return (data && data.config) ? data.config : nextConfig;
}

// ---------- PUBLIC: Studio reads this ----------
app.get("/config", async (req, res) => {
  let admin = null;
  try {
    admin = await tryAdmin(req, { audit: true }); // will be null if no/invalid token
    const raw = await readSingletonConfig();

    // If admin: return full config (still never returns raw secrets)
    if (admin && admin.isAdmin) {
      await logAdminAction({
        userId: admin.userId,
        email: admin.email,
        action: "config_read",
        route: "/config",
        method: "GET",
        status: 200,
        detail: { asAdmin: true },
      });
      return res.json({
        ok: true,
        config: raw,
        isAdmin: true
      });
    }

    // Public: return sanitized config (no secrets fields)
    return res.json({
      ok: true,
      config: sanitizeConfigForPublic(raw),
      isAdmin: false
    });
  } catch (e) {
    await logAdminAction({
      userId: admin?.userId,
      email: admin?.email,
      action: "config_read_error",
      route: "/config",
      method: "GET",
      status: 500,
      detail: { message: e?.message },
    });
    return res.status(500).json({ ok: false, message: e?.message || "Failed to load config" });
  }
});

// ---------- ADMIN: Dashboard uses these ----------
app.get("/admin/config", requireAdmin, async (req, res) => {
  try {
    const raw = await readSingletonConfig();
    await logAdminAction({
      userId: req.user.userId,
      email: req.user.email,
      action: "admin_config_read",
      route: "/admin/config",
      method: "GET",
      status: 200,
    });
    res.json({ ok: true, config: raw });
  } catch (e) {
    await logAdminAction({
      userId: req.user?.userId,
      email: req.user?.email,
      action: "admin_config_read_error",
      route: "/admin/config",
      method: "GET",
      status: 500,
      detail: { message: e?.message },
    });
    res.status(500).json({ ok: false, message: e?.message || "Failed to load admin config" });
  }
});

app.put("/admin/config", requireAdmin, async (req, res) => {
  try {
    const incoming = req.body && req.body.config;
    if (!incoming || typeof incoming !== "object") {
      return res.status(400).json({ ok: false, message: "Body must be: { config: {...} }" });
    }

    // IMPORTANT: never store secrets inside config
    const safeToStore = sanitizeConfigForStorage(incoming);

    const saved = await writeSingletonConfig(safeToStore, req.user.email);
    await logAdminAction({
      userId: req.user.userId,
      email: req.user.email,
      action: "admin_config_write",
      route: "/admin/config",
      method: "PUT",
      status: 200,
      detail: { updatedKeys: Object.keys(safeToStore || {}) },
    });
    res.json({ ok: true, config: saved });
  } catch (e) {
    const safeToStore = req.body && typeof req.body.config === "object" ? sanitizeConfigForStorage(req.body.config) : null;
    await logAdminAction({
      userId: req.user?.userId,
      email: req.user?.email,
      action: "admin_config_write_error",
      route: "/admin/config",
      method: "PUT",
      status: 500,
      detail: { message: e?.message, updatedKeys: Object.keys(safeToStore || {}) },
    });
    res.status(500).json({ ok: false, message: e?.message || "Failed to save admin config" });
  }
});

// OPTIONAL: store provider secrets server-side (dashboard can call this)
app.post("/admin/provider-secret", requireAdmin, async (req, res) => {
  try {
    const { provider, secret } = req.body || {};
    if (!provider || typeof provider !== "string") {
      return res.status(400).json({ ok: false, message: "Missing provider" });
    }
    if (!secret || typeof secret !== "string" || secret.trim().length < 6) {
      return res.status(400).json({ ok: false, message: "Secret too short" });
    }

    const supabase = getSupabaseAdmin();
    const masked = maskSecret(secret.trim());

    const { error } = await supabase
      .from("mina_admin_secrets")
      .upsert(
        {
          provider: provider.trim(),
          secret: secret.trim(),
          masked,
          updated_at: new Date().toISOString(),
          updated_by: req.user.email
        },
        { onConflict: "provider" }
      );

    if (error) throw error;

    // Also update the main config to remember the masked value
    const raw = await readSingletonConfig();
    const next = sanitizeConfigForStorage(raw);

    if (!next.ai) next.ai = {};
    if (!Array.isArray(next.ai.providerKeys)) next.ai.providerKeys = [];

    const idx = next.ai.providerKeys.findIndex((x) => x && x.provider === provider.trim());
    if (idx >= 0) {
      next.ai.providerKeys[idx] = { ...next.ai.providerKeys[idx], provider: provider.trim(), masked };
    } else {
      next.ai.providerKeys.push({ provider: provider.trim(), masked });
    }

    const saved = await writeSingletonConfig(next, req.user.email);
    await logAdminAction({
      userId: req.user.userId,
      email: req.user.email,
      action: "admin_provider_secret", 
      route: "/admin/provider-secret",
      method: "POST",
      status: 200,
      detail: { provider: provider.trim(), masked },
    });

    res.json({ ok: true, masked, config: saved });
  } catch (e) {
    await logAdminAction({
      userId: req.user?.userId,
      email: req.user?.email,
      action: "admin_provider_secret_error",
      route: "/admin/provider-secret",
      method: "POST",
      status: 500,
      detail: { message: e?.message, provider: req.body?.provider },
    });
    res.status(500).json({ ok: false, message: e?.message || "Failed to store secret" });
  }
});

const port = Number(process.env.PORT || 3000);
app.listen(port, () => {
  console.log(`✅ mina-admin-config-api listening on :${port}`);
});  those admin reposotory files this file 12 "use strict"; 

const { createClient } = require("@supabase/supabase-js");
const crypto = require("crypto");

let _client = null;

function getSupabaseAdmin() {
  try {
    if (_client) return _client;

    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!url || !key) {
      console.error("[supabase] missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
      return null;
    }

    _client = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    return _client;
  } catch (err) {
    console.error("[supabase] failed to init client:", err?.message || err);
    return null;
  }
}

// ---------------------
// Helpers
// ---------------------
function cleanEmail(email) {
  const e = String(email || "").trim().toLowerCase();
  return e || null;
}

function looksLikeUuid(v) {
  const s = String(v || "").trim();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(s);
}

function nowIso() {
  return new Date().toISOString();
}

function safeUserAgent(ua) {
  if (!ua) return null;
  return String(ua).trim().slice(0, 500);
}

function hashToken(token) {
  if (!token) return null;
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

function randomId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return [4, 2, 2, 2, 6]
    .map((len) => crypto.randomBytes(len).toString("hex"))
    .join("-");
}

// ---------------------
// Writes (non-blocking)
// ---------------------
async function upsertProfileRow({ userId, email, shopifyCustomerId }) {
  try {
    const supabase = getSupabaseAdmin();
    if (!supabase) return { ok: false, reason: "missing_client" };
    const id = String(userId || "").trim();
    if (!looksLikeUuid(id)) return { ok: false, reason: "invalid_userId" };

    const now = nowIso();

    const row = {
      id,
      email: cleanEmail(email),
      shopify_customer_id: shopifyCustomerId ? String(shopifyCustomerId) : null,
      last_seen_at: now,
      updated_at: now,
    };

    const { error } = await supabase.from("profiles").upsert(row, { onConflict: "id" });

    if (error) {
      console.error("[supabase] profiles upsert error:", error);
      return { ok: false, reason: "db_error" };
    }

    return { ok: true };
  } catch (err) {
    // Important: do NOT crash API if env vars missing etc.
    console.error("[supabase] profiles upsert exception:", err?.message || err);
    return { ok: false, reason: "exception" };
  }
}

async function upsertSessionRow({ userId, email, token, ip, userAgent }) {
  try {
    const supabase = getSupabaseAdmin();
    if (!supabase) return { ok: false, reason: "missing_client" };
    const id = String(userId || "").trim();
    const sessionHash = hashToken(token || id);

    if (!sessionHash) return { ok: false, reason: "missing_session" };

    const now = nowIso();
    const row = {
      session_hash: sessionHash,
      user_id: looksLikeUuid(id) ? id : null,
      email: cleanEmail(email),
      ip: ip ? String(ip) : null,
      user_agent: safeUserAgent(userAgent),
      first_seen_at: now,
      last_seen_at: now,
      updated_at: now,
    };

    const { error } = await supabase.from("admin_sessions").upsert(row, { onConflict: "session_hash" });

    if (error) {
      console.error("[supabase] admin_sessions upsert error:", error);
      return { ok: false, reason: "db_error" };
    }

    return { ok: true };
  } catch (err) {
    console.error("[supabase] admin_sessions upsert exception:", err?.message || err);
    return { ok: false, reason: "exception" };
  }
}

async function logAdminAction({
  userId,
  email,
  action,
  route,
  method,
  status,
  detail,
}) {
  try {
    const supabase = getSupabaseAdmin();
    if (!supabase) return { ok: false, reason: "missing_client" };
    const now = nowIso();
    const row = {
      id: randomId(),
      user_id: looksLikeUuid(userId) ? String(userId) : null,
      email: cleanEmail(email),
      action: action ? String(action) : null,
      route: route ? String(route) : null,
      method: method ? String(method) : null,
      status: status ?? null,
      detail: detail ?? null,
      created_at: now,
    };

    const { error } = await supabase.from("admin_audit").insert(row);

    if (error) {
      console.error("[supabase] admin_audit insert error:", error);
      return { ok: false, reason: "db_error" };
    }

    return { ok: true };
  } catch (err) {
    console.error("[supabase] admin_audit insert exception:", err?.message || err);
    return { ok: false, reason: "exception" };
  }
}

async function upsertGenerationRow({
  id,
  userId,
  customerId,
  sessionId,
  type,
  platform,
  prompt,
  outputUrl,
  meta,
  createdAt,
}) {
  try {
    const supabase = getSupabaseAdmin();
    if (!supabase) return { ok: false, reason: "missing_client" };
    const genId = String(id || "").trim();
    if (!genId) return { ok: false, reason: "missing_id" };

    const row = {
      id: genId,
      user_id: looksLikeUuid(userId) ? String(userId) : null,
      customer_id: customerId ? String(customerId) : null,
      session_id: sessionId ? String(sessionId) : null,
      type: type ? String(type) : null,
      platform: platform ? String(platform) : null,
      prompt: prompt ? String(prompt) : null,
      output_url: outputUrl ? String(outputUrl) : null,
      meta: meta ?? null,
      created_at: createdAt ? String(createdAt) : new Date().toISOString(),
    };

    const { error } = await supabase.from("generations").upsert(row, { onConflict: "id" });

    if (error) {
      console.error("[supabase] generations upsert error:", error);
      return { ok: false, reason: "db_error" };
    }

    return { ok: true };
  } catch (err) {
    console.error("[supabase] generations upsert exception:", err?.message || err);
    return { ok: false, reason: "exception" };
  }
}

module.exports = {
  getSupabaseAdmin,
  upsertProfileRow,
  upsertSessionRow,
  upsertGenerationRow,
  logAdminAction,
}; 13th "use strict";

const {
  getSupabaseAdmin,
  upsertProfileRow,
  upsertSessionRow,
  logAdminAction,
} = require("./supabase");

function getAllowlist() {
  return (process.env.ADMIN_ALLOWLIST || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

function getBearerToken(req) {
  const h = req.headers.authorization || "";
  const m = String(h).match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

// Try admin: returns { isAdmin, email } OR null (no/invalid token)
async function tryAdmin(req, { audit } = {}) {
  const token = getBearerToken(req);
  const route = req.path;
  const method = req.method;
  const userAgent = req.get("user-agent") || null;
  const ip = req.ip;
  if (!token) {
    await logAdminAction({
      action: "admin_denied",
      route,
      method,
      status: 401,
      detail: { reason: "missing_token", ip, userAgent },
    });
    return null;
  }

  const supabase = getSupabaseAdmin();
  if (!supabase) {
    await logAdminAction({
      action: "admin_denied",
      route,
      method,
      status: 500,
      detail: { reason: "supabase_unavailable", ip, userAgent },
    });
    return null;
  }

  let data;
  let error;
  try {
    const resp = await supabase.auth.getUser(token);
    data = resp?.data;
    error = resp?.error;
  } catch (err) {
    error = err;
  }

  if (error || !data?.user) {
    await logAdminAction({
      action: "admin_denied",
      route,
      method,
      status: 401,
      detail: { reason: "invalid_token", ip, userAgent, error: error?.message || undefined },
    });
    return null;
  }
  const email = (data.user?.email || "").toLowerCase();
  const userId = data.user?.id;
  if (!email || !userId) {
    await logAdminAction({
      action: "admin_denied",
      route,
      method,
      status: 401,
      detail: { reason: "missing_user_fields", ip, userAgent },
    });
    return null;
  }

  const allow = getAllowlist();
  const isAdmin = allow.includes(email);

  await upsertProfileRow({ userId, email });
  await upsertSessionRow({
    userId,
    email,
    token,
    ip,
    userAgent,
  });

  await logAdminAction({
    userId,
    email,
    action: isAdmin ? "admin_access" : "admin_denied",
    route,
    method,
    status: isAdmin ? 200 : 401,
    detail: {
      ip,
      userAgent,
    },
  });

  return { isAdmin, email, userId };
}

// Require admin middleware
async function requireAdmin(req, res, next) {
  try {
    const admin = await tryAdmin(req, { audit: true });
    if (!admin || !admin.isAdmin) {
      return res.status(401).json({ ok: false, message: "Admin only" });
    }
    req.user = { email: admin.email, userId: admin.userId };
    next();
  } catch (e) {
    return res.status(401).json({ ok: false, message: "Admin auth failed" });
  }
}

module.exports = { requireAdmin, tryAdmin }; env variables VITE_MINA_ADMIN_KEY=mina_dashboard_123
VITE_MINA_API_BASE_URL=https://mina-editorial-ai-api.onrender.com
VITE_MINA_USE_DEV_CUSTOMER=1
VITE_SUPABASE_ANON_KEY=#######
VITE_SUPABASE_URL=https://htqswaqihjeotylhrfep.supabase.co ++++backend ADMIN_DASHBOARD_KEY=mina_dashboard_123
ADMIN_SECRET=#######
CREDIT_PRODUCT_MAP='{"MINA-50":50}'
DATABASE_URL=postgresql://mina_db_kzl0_user:755CMY82ZOkiGQFT2jS8JdyyWqKxcmvw@dpg-d4rpgp24d50c73b11sm0-a/mina_db_kzl0
DEFAULT_FREE_CREDITS=50
IMAGE_CREDITS_COST=1
MOTION_CREDITS_COST=5
OPENAI_API_KEY=#######
R2_ACCESS_KEY_ID=#######
R2_ACCOUNT_ID=e49a81780ae991c645e6ebea8e596adb
R2_BUCKET=mina-assets-prod
R2_PUBLIC_BASE_URL=https://assets.faltastudio.com
R2_SECRET_ACCESS_KEY=#######
REPLICATE_API_TOKEN=#######
SEADREAM_MODEL_VERSION=bytedance/seedream-4
SHOPIFY_ADMIN_TOKEN==#######
SHOPIFY_API_VERSION=2025-10
SHOPIFY_FLOW_WEBHOOK_SECRET==#######
SHOPIFY_MINA_TAG=Mina_users
SHOPIFY_ORDER_WEBHOOK_SECRET=#######
SHOPIFY_STORE_DOMAIN=faltastudio.com
SHOPIFY_WELCOME_MATCHA_VARIANT_ID=43337249488979
SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imh0cXN3YXFpaGplb3R5bGhyZmVwIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2NTI5NDM0MSwiZXhwIjoyMDgwODcwMzQxfQ.5h8lOu0mLDC4Tp6VhL1pzOQlePlZpGUwobEqTqM5iuA
SUPABASE_URL=https://htqswaqihjeotylhrfep.supabase.co admin config ADMIN_ALLOWLIST="madanimoutaa@hotmail.fr, madanimoutaavisions@gmail.com"
CORS_ORIGINS=https://mina-app-bvpn.onrender.com
SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imh0cXN3YXFpaGplb3R5bGhyZmVwIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2NTI5NDM0MSwiZXhwIjoyMDgwODcwMzQxfQ.5h8lOu0mLDC4Tp6VhL1pzOQlePlZpGUwobEqTqM5iuA
SUPABASE_URL=https://htqswaqihjeotylhrfep.supabase.co INow read all the codes sent from the begiging of this chat and explain to me everything happening in MINA from the 3 
