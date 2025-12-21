// Hero Part 1: Utility helpers for Mina Mind API (MMA)
// Part 1.1: Deterministic pass id + canonical var maps live here so server.js stays slim.
import crypto from "node:crypto";
import { v4 as uuidv4 } from "uuid";

function safeString(v, fallback = "") {
  if (v === null || v === undefined) return fallback;
  return String(v).trim() || fallback;
}

export function computePassId({ shopifyCustomerId, userId, email }) {
  const normalizedShopify = safeString(shopifyCustomerId, "");
  if (normalizedShopify && normalizedShopify !== "anonymous") {
    return `pass:shopify:${normalizedShopify}`;
  }

  const normalizedUser = safeString(userId, "");
  if (normalizedUser) return `pass:user:${normalizedUser}`;

  const normalizedEmail = safeString(email, "").toLowerCase();
  if (normalizedEmail) return `pass:email:${normalizedEmail}`;

  return `pass:anon:${crypto.randomUUID()}`;
}

export function makeInitialVars({
  mode = "still",
  assets = {},
  history = {},
  inputs = {},
  prompts = {},
  feedback = {},
  settings = {},
} = {}) {
  // Keep BOTH ids + urls (so pipeline can run without extra lookups)
  const productUrl =
    assets.productImageUrl || assets.product_image_url || assets.product_url || null;

  const logoUrl =
    assets.logoImageUrl || assets.logo_image_url || assets.logo_url || null;

  const styleUrls =
    assets.styleImageUrls ||
    assets.style_image_urls ||
    assets.inspiration_urls ||
    [];

  const klingUrls =
    assets.kling_images ||
    assets.klingImages ||
    assets.kling_image_urls ||
    [];

  const startUrl =
    assets.start_image_url || assets.startImageUrl || null;

  const endUrl =
    assets.end_image_url || assets.endImageUrl || null;

  const brief =
    inputs.brief ||
    inputs.userBrief ||
    inputs.prompt ||
    "";

  const motionDescription =
    inputs.motion_description ||
    inputs.motionDescription ||
    inputs.motion_user_brief ||
    "";

  return {
    version: "2025-12-21",
    mode,
    assets: {
      // legacy ids (kept)
      product_image_id: assets.product_image_id || null,
      logo_image_id: assets.logo_image_id || null,
      inspiration_image_ids: assets.inspiration_image_ids || [],
      style_hero_image_id: assets.style_hero_image_id || null,
      input_still_image_id: assets.input_still_image_id || null,

      // ✅ urls (NEW)
      product_image_url: typeof productUrl === "string" ? productUrl : null,
      logo_image_url: typeof logoUrl === "string" ? logoUrl : null,
      style_image_urls: Array.isArray(styleUrls) ? styleUrls : [],
      kling_image_urls: Array.isArray(klingUrls) ? klingUrls : [],
      start_image_url: typeof startUrl === "string" ? startUrl : null,
      end_image_url: typeof endUrl === "string" ? endUrl : null,
    },
    scans: {
      product_crt: null,
      logo_crt: null,
      inspiration_crt: [],
      still_crt: null,
      output_still_crt: null,
    },
    history: {
      vision_intelligence: history.vision_intelligence ?? true,
      like_window: history.vision_intelligence === false ? 20 : 5,
      style_history_csv: history.style_history_csv || null,
    },
    inputs: {
      // ✅ canonical fields your controller reads
      brief,
      motion_description: motionDescription,
      motionDescription,

      // keep your existing fields too
      userBrief: inputs.userBrief || "",
      style: inputs.style || "",
      motion_user_brief: inputs.motion_user_brief || "",
      movement_style: inputs.movement_style || "",

      platform: inputs.platform || inputs.platformKey || "",
      aspect_ratio: inputs.aspect_ratio || inputs.aspectRatio || "",
    },
    prompts: {
      clean_prompt: prompts.clean_prompt || null,
      motion_prompt: prompts.motion_prompt || null,
      motion_sugg_prompt: prompts.motion_sugg_prompt || null,
    },
    feedback: {
      still_feedback: feedback.still_feedback || null,
      motion_feedback: feedback.motion_feedback || null,
    },
    userMessages: { scan_lines: [], final_line: null },
    settings: { seedream: settings.seedream || {}, kling: settings.kling || {} },
    outputs: { seedream_image_id: null, kling_video_id: null },
    meta: { ctx_versions: {}, settings_versions: {} },
  };
}

export function appendScanLine(vars, text) {
  const next = { ...(vars || makeInitialVars({})), userMessages: { ...(vars?.userMessages || { scan_lines: [], final_line: null }) } };
  const scanLines = Array.isArray(next.userMessages.scan_lines)
    ? [...next.userMessages.scan_lines]
    : [];
  const payload = typeof text === "string" ? { index: scanLines.length, text } : text;
  scanLines.push(payload);
  next.userMessages.scan_lines = scanLines;
  return next;
}

export function makePlaceholderUrl(kind, id) {
  const base = safeString(process.env.R2_PUBLIC_BASE_URL, "https://example.r2.dev");
  return `${base.replace(/\/+$/, "")}/${kind}/${id}`;
}

export function nowIso() {
  return new Date().toISOString();
}

export function generationIdentifiers(generationId) {
  return {
    mg_id: `generation:${generationId}`,
    mg_generation_id: generationId,
    mg_record_type: "generation",
  };
}

export function stepIdentifiers(generationId, stepNo) {
  return {
    mg_id: `mma_step:${generationId}:${stepNo}`,
    mg_generation_id: generationId,
    mg_record_type: "mma_step",
    mg_step_no: stepNo,
  };
}

export function eventIdentifiers(eventId) {
  return {
    mg_id: `mma_event:${eventId}`,
    mg_record_type: "mma_event",
  };
}

export function newUuid() {
  return uuidv4();
}
