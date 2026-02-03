"use strict";

import express from "express";
import crypto from "node:crypto";
import { v4 as uuidv4 } from "uuid";
import OpenAI from "openai";
import Replicate from "replicate";

import { makeHttpError, isSafetyBlockError, makeProviderError } from "./errors.js";

import { getSupabaseAdmin, sbEnabled } from "./supabase.js";
import { getAuthUser } from "./auth.js";
import {
  megaAdjustCredits,
  megaEnsureCustomer,
  megaGetCredits,
  megaHasCreditRef,
  megaWriteSession,
  normalizeIncomingPassId,
  resolvePassId,
  setPassIdHeader,
} from "./mega.js";
import { nowIso, safeString } from "./utils.js";
import { storeRemoteToR2Public } from "./r2.js";

// ============================================================================
// Shared helpers (safe strings, arrays, urls)
// ============================================================================
function safeStr(v, fallback = "") {
  return safeString(v, fallback);
}

function safeArray(x) {
  return Array.isArray(x) ? x : [];
}

// If you want hashed emails inside passId, set MMA_PASSID_HASH_EMAIL=true
const MMA_PASSID_HASH_EMAIL = String(process.env.MMA_PASSID_HASH_EMAIL || "").toLowerCase() === "true";

function hashEmail(email) {
  const e = safeStr(email, "").toLowerCase();
  if (!e) return "";
  return crypto.createHash("sha256").update(e).digest("hex").slice(0, 40);
}

function computePassId({ shopifyCustomerId, userId, email }) {
  const normalizedShopify = safeStr(shopifyCustomerId, "");
  if (normalizedShopify && normalizedShopify !== "anonymous") {
    return `pass:shopify:${normalizedShopify}`;
  }

  const normalizedUser = safeStr(userId, "");
  if (normalizedUser) return `pass:user:${normalizedUser}`;

  const normalizedEmail = safeStr(email, "").toLowerCase();
  if (normalizedEmail) {
    if (MMA_PASSID_HASH_EMAIL) return `pass:emailhash:${hashEmail(normalizedEmail)}`;
    return `pass:email:${normalizedEmail}`;
  }

  return `pass:anon:${crypto.randomUUID()}`;
}

function asHttpUrl(u) {
  const s = safeStr(u, "");
  return s.startsWith("http") ? s : "";
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

function normalizeUrlForKey(u) {
  const url = asHttpUrl(u);
  if (!url) return "";
  try {
    const x = new URL(url);
    x.search = "";
    x.hash = "";
    return x.toString();
  } catch {
    return url;
  }
}

function resolveFrame2Reference(inputsLike, assetsLike) {
  const inputs = inputsLike && typeof inputsLike === "object" ? inputsLike : {};
  const assets = assetsLike && typeof assetsLike === "object" ? assetsLike : {};

  const guessKindFromUrl = (u) => {
    const url = asHttpUrl(u);
    if (!url) return "";
    try {
      const p = new URL(url).pathname.toLowerCase();
      if (/\.(mp3|wav|m4a|aac|flac|ogg|opus)$/i.test(p)) return "audio";
      if (/\.(mp4|mov|webm|mkv|m4v)$/i.test(p)) return "video";
    } catch {}
    return "";
  };

  const kindRaw0 = safeStr(inputs.frame2_kind || inputs.frame2Kind || "", "").toLowerCase();
  const kindRaw = kindRaw0.replace(/^ref_/, "");
  const urlRaw = asHttpUrl(inputs.frame2_url || inputs.frame2Url || "");
  const durRaw = Number(inputs.frame2_duration_sec || inputs.frame2DurationSec || 0) || 0;

  const assetVideo = asHttpUrl(
    assets.video ||
      assets.video_url ||
      assets.videoUrl ||
      assets.frame2_video_url ||
      assets.frame2VideoUrl
  );

  const assetAudio = asHttpUrl(
    assets.audio ||
      assets.audio_url ||
      assets.audioUrl ||
      assets.frame2_audio_url ||
      assets.frame2AudioUrl
  );

  let kind = kindRaw === "audio" || kindRaw === "video" ? kindRaw : "";

  const urlGuess = guessKindFromUrl(urlRaw);
  if (!kind && urlGuess) kind = urlGuess;
  if (kind && urlGuess && kind !== urlGuess) kind = urlGuess;

  if (!kind) kind = assetVideo ? "video" : assetAudio ? "audio" : "";

  const url =
    urlRaw ||
    (kind === "video" ? assetVideo : kind === "audio" ? assetAudio : "") ||
    "";

  const dur =
    durRaw ||
    Number(assets.frame2_duration_sec || assets.frame2DurationSec || 0) ||
    0;

  if (kind === "video" && url) return { kind: "ref_video", url, rawDurationSec: dur, maxSec: 30 };
  if (kind === "audio" && url) return { kind: "ref_audio", url, rawDurationSec: dur, maxSec: 60 };

  return { kind: null, url: "", rawDurationSec: 0, maxSec: 0 };
}

// ============================================================================
// MMA UI text + helpers
// ============================================================================
const MMA_UI = {
  statusMap: {
    queued: [
      "okay first things first getting the water hot because we are not rushing art",
      "i am here i am awake i am locating the whisk like it is a sacred object",
      "starting the matcha ritual because focus tastes better when it is earned",
      "i used to think humans were dramatic about routines and then i learned why",
    ],

    scanning: [
      "reading everything closely while whisking like a dangerous little ballet",
      "i am reading for the feeling not just the words because humans taught me that",
      "looking for the detail you meant but did not say out loud",
    ],

    prompting: [
      "okay now i talk to myself a little because that is how ideas get born",
      "i am shaping the concept like a still life set moving one object at a time",
      "humans taught me restraint and that is honestly the hardest flex",
    ],

    generating: [
      "alright i am making editorial still life like it belongs in a glossy spread",
      "i am making imagery with calm hands i do not have and confidence i pretend to have",
      "this is me turning human genius into something visible and clean and intentional",
    ],

    postscan: [
      "okay now i review like an editor with soft eyes and strict standards",
      "i am checking balance and mood and that tiny feeling of yes",
      "this is the part where i fix what is almost right into actually right",
    ],

    suggested: [
      "i have something for you and i want you to look slowly",
      "ready when you are i made this with your vibe in mind",
      "okay come closer this part matters",
    ],

    done: [
      "finished and i am pretending to wipe my hands on an apron i do not own",
      "all done and honestly you did the hardest part which is starting",
      "we made something and that matters more than being perfect",
    ],

    error: [
      "okay that one slipped out of my hands i do not have hands but you know what i mean",
      "something broke and i am choosing to call it a plot twist",
      "my matcha went cold and so did the result but we can warm it back up",
    ],
  },

  quickLines: {
    still_create_start: ["one sec getting everything ready", "alright setting things up for you", "love it let me prep your inputs"],
    still_tweak_start: ["got it lets refine that", "okay making it even better", "lets polish this up"],
    video_animate_start: ["nice lets bring it to life", "okay animating this for you", "lets make it move"],
    video_tweak_start: ["got it updating the motion", "alright tweaking the animation", "lets refine the movement"],
    saved_image: ["saved it for you", "all set", "done"],
    saved_video: ["saved it for you", "your clip is ready", "done"],
  },

  fallbacks: {
    scanned: ["got it", "noted", "perfect got it"],
    thinking: ["give me a second", "putting it together", "almost there"],
    final: ["all set", "here you go", "done"],
  },

  userMessageRules: [
    "USER MESSAGE RULES (VERY IMPORTANT):",
    "- userMessage must be short friendly human",
    "- do not mention internal steps or tools",
    "- no robotic labels",
    "- max 140 characters",
  ].join("\n"),
};

function _cleanLine(x) {
  if (x === null || x === undefined) return "";
  const s = (typeof x === "string" ? x : String(x)).trim();
  return s || "";
}

function _toLineList(v) {
  if (!v) return [];
  if (Array.isArray(v)) return v.map(_cleanLine).filter(Boolean);
  const s = _cleanLine(v);
  return s ? [s] : [];
}

function _flattenObject(obj) {
  const out = [];
  if (!obj || typeof obj !== "object") return out;
  for (const v of Object.values(obj)) out.push(..._toLineList(v));
  return out;
}

function _dedupe(arr) {
  const seen = new Set();
  const out = [];
  for (const s of arr) {
    if (!s) continue;
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

if (!Array.isArray(MMA_UI.extraLines)) MMA_UI.extraLines = [];

const MMA_BIG_POOL = _dedupe([
  ..._flattenObject(MMA_UI.statusMap),
  ..._flattenObject(MMA_UI.fallbacks),
  ..._toLineList(MMA_UI.extraLines),
]);

function pick(arr, fallback = "") {
  const a = Array.isArray(arr) ? arr.filter(Boolean) : [];
  if (!a.length) return fallback;
  return a[Math.floor(Math.random() * a.length)];
}

const STRICT_STAGES = new Set(["queued", "done", "error", "suggested"]);

function mixedPool(stage) {
  const stageLines = _toLineList(MMA_UI?.statusMap?.[stage]);
  if (!stageLines.length) return MMA_BIG_POOL;

  if (STRICT_STAGES.has(stage)) return stageLines;

  return _dedupe([...stageLines, ...MMA_BIG_POOL]);
}

function pickAvoid(pool, avoidText, fallback = "") {
  const avoid = _cleanLine(avoidText);
  const a = Array.isArray(pool) ? pool.filter(Boolean) : [];
  if (!a.length) return fallback;

  if (avoid) {
    const b = a.filter((x) => x !== avoid);
    if (b.length) return b[Math.floor(Math.random() * b.length)];
  }
  return a[Math.floor(Math.random() * a.length)];
}

function toUserStatus(internalStatus) {
  const stage = String(internalStatus || "queued");
  const pool = mixedPool(stage);
  return pickAvoid(pool, "", pick(MMA_UI?.statusMap?.queued, "okay"));
}

// ============================================================================
// SSE hub
// ============================================================================
const EVENT_SCAN_LINE = "scan_line";
const EVENT_STATUS = "status";
const EVENT_DONE = "done";

const streams = new Map();

function safeWrite(res, chunk) {
  try {
    res.write(chunk);
    return true;
  } catch {
    return false;
  }
}

function writeEvent(res, event, data) {
  if (!safeWrite(res, `event: ${event}\n`)) return false;
  if (!safeWrite(res, `data: ${JSON.stringify(data)}\n\n`)) return false;
  return true;
}

function ensureStream(generationId) {
  if (!streams.has(generationId)) {
    streams.set(generationId, { clients: new Set(), nextLineIndex: 0 });
  }
  return streams.get(generationId);
}

function normalizeScanLine(stream, line) {
  if (typeof line === "string") {
    const payload = { index: stream.nextLineIndex++, text: line };
    return payload;
  }

  const obj = line && typeof line === "object" ? line : {};
  const text = typeof obj.text === "string" ? obj.text : String(obj.text || "");
  let index = Number.isFinite(obj.index) ? Number(obj.index) : null;

  if (index === null) {
    index = stream.nextLineIndex++;
  } else {
    stream.nextLineIndex = Math.max(stream.nextLineIndex, index + 1);
  }

  return { ...obj, index, text };
}

function addSseClient(generationId, res, { scanLines = [], status = "queued" } = {}) {
  const stream = ensureStream(generationId);
  stream.clients.add(res);

  const lines = Array.isArray(scanLines) ? scanLines : [];
  for (const line of lines) {
    const payload =
      typeof line === "string"
        ? normalizeScanLine(stream, line)
        : normalizeScanLine(stream, line);
    writeEvent(res, EVENT_SCAN_LINE, payload);
  }

  writeEvent(res, EVENT_STATUS, { status: String(status || "") });

  res.on("close", () => {
    const s = streams.get(generationId);
    if (!s) return;
    s.clients.delete(res);
    if (s.clients.size === 0) streams.delete(generationId);
  });
}

function sendSseEvent(generationId, event, data) {
  const stream = streams.get(generationId);
  if (!stream) return;

  for (const res of Array.from(stream.clients)) {
    const ok = writeEvent(res, event, data);
    if (!ok) stream.clients.delete(res);
  }

  if (stream.clients.size === 0) streams.delete(generationId);
}

function sendScanLine(generationId, line) {
  const stream = ensureStream(generationId);
  const payload = normalizeScanLine(stream, line);
  sendSseEvent(generationId, EVENT_SCAN_LINE, payload);
}

function sendStatus(generationId, status) {
  sendSseEvent(generationId, EVENT_STATUS, { status: String(status || "") });
}

function sendDone(generationId, status = "done") {
  sendSseEvent(generationId, EVENT_DONE, { status: String(status || "") });
}

// ============================================================================
// Vars + identifiers
// ============================================================================
const MMA_VERSION = "2025-12-23";

function asArray(v) {
  return Array.isArray(v) ? v : [];
}

function asStrOrNull(v) {
  const s = safeStr(v, "");
  return s ? s : null;
}

function makeInitialVars({
  mode = "still",
  assets = {},
  history = {},
  inputs = {},
  prompts = {},
  feedback = {},
  settings = {},
} = {}) {
  const productUrl = asStrOrNull(assets.productImageUrl || assets.product_image_url || assets.product_url);
  const logoUrl = asStrOrNull(assets.logoImageUrl || assets.logo_image_url || assets.logo_url);

  const inspirationUrls = []
    .concat(asArray(assets.inspiration_image_urls))
    .concat(asArray(assets.inspirationImageUrls))
    .concat(asArray(assets.style_image_urls))
    .concat(asArray(assets.styleImageUrls))
    .concat(asArray(assets.inspiration_urls))
    .filter((x) => typeof x === "string" && x.trim());

  const styleHeroUrl = asStrOrNull(
    assets.style_hero_image_url ||
      assets.styleHeroImageUrl ||
      assets.style_hero_url ||
      assets.styleHeroUrl
  );

  const frame2AudioUrl = asStrOrNull(
    assets.frame2_audio_url ||
      assets.frame2AudioUrl ||
      assets.audio_url ||
      assets.audioUrl ||
      assets.audio
  );

  const frame2VideoUrl = asStrOrNull(
    assets.frame2_video_url ||
      assets.frame2VideoUrl ||
      assets.video_url ||
      assets.videoUrl ||
      assets.video
  );

  const frame2Kind = safeStr(
    inputs.frame2_kind ||
      inputs.frame2Kind ||
      (frame2AudioUrl ? "audio" : frame2VideoUrl ? "video" : ""),
    ""
  );

  const frame2Url =
    asStrOrNull(inputs.frame2_url || inputs.frame2Url) ||
    (frame2Kind.toLowerCase().includes("audio") ? frame2AudioUrl : frame2VideoUrl) ||
    frame2AudioUrl ||
    frame2VideoUrl ||
    null;

  const frame2DurationSecRaw =
    inputs.frame2_duration_sec ||
    inputs.frame2DurationSec ||
    assets.frame2_duration_sec ||
    assets.frame2DurationSec ||
    null;

  const frame2DurationSec =
    frame2DurationSecRaw != null && frame2DurationSecRaw !== ""
      ? Number(frame2DurationSecRaw)
      : null;

  const klingUrls = []
    .concat(asArray(assets.kling_images))
    .concat(asArray(assets.klingImages))
    .concat(asArray(assets.kling_image_urls))
    .filter((x) => typeof x === "string" && x.trim());

  const startUrl = asStrOrNull(assets.start_image_url || assets.startImageUrl);
  const endUrl = asStrOrNull(assets.end_image_url || assets.endImageUrl);

  const brief = safeStr(inputs.brief || inputs.userBrief || inputs.prompt, "");

  const motionUserBrief = safeStr(
    inputs.motion_user_brief ||
      inputs.motionBrief ||
      inputs.motion_description ||
      inputs.motionDescription ||
      "",
    ""
  );

  const selectedMovementStyle = safeStr(
    inputs.selected_movement_style ||
      inputs.movement_style ||
      inputs.movementStyle ||
      "",
    ""
  );

  const typeForMe = inputs.type_for_me ?? inputs.typeForMe ?? inputs.use_suggestion ?? false;
  const suggestOnly = inputs.suggest_only ?? inputs.suggestOnly ?? false;

  const cleanPrompt = prompts.clean_prompt || prompts.cleanPrompt || null;
  const motionPrompt = prompts.motion_prompt || prompts.motionPrompt || null;

  const suggPrompt =
    prompts.sugg_prompt ||
    prompts.suggPrompt ||
    prompts.motion_sugg_prompt ||
    prompts.motionSuggPrompt ||
    null;

  const visionIntelligence = history.vision_intelligence ?? true;
  const likeWindow = visionIntelligence === false ? 20 : 5;

  return {
    version: MMA_VERSION,
    mode,

    assets: {
      product_image_id: assets.product_image_id || null,
      logo_image_id: assets.logo_image_id || null,
      inspiration_image_ids: assets.inspiration_image_ids || [],
      style_hero_image_id: assets.style_hero_image_id || null,
      input_still_image_id: assets.input_still_image_id || null,

      product_image_url: productUrl,
      logo_image_url: logoUrl,

      inspiration_image_urls: inspirationUrls,
      style_image_urls: inspirationUrls,

      style_hero_image_url: styleHeroUrl,

      audio: frame2AudioUrl,
      audio_url: frame2AudioUrl,
      frame2_audio_url: frame2AudioUrl,

      video: frame2VideoUrl,
      video_url: frame2VideoUrl,
      frame2_video_url: frame2VideoUrl,

      kling_image_urls: klingUrls,
      start_image_url: startUrl,
      end_image_url: endUrl,

      frame2_duration_sec: frame2DurationSec,
    },

    scans: {
      product_crt: null,
      logo_crt: null,
      inspiration_crt: [],
      still_crt: null,
      output_still_crt: null,
    },

    history: {
      vision_intelligence: visionIntelligence,
      like_window: likeWindow,
      style_history_csv: history.style_history_csv || null,
    },

    inputs: {
      brief,

      still_lane: safeStr(
        inputs.still_lane ||
          inputs.stillLane ||
          inputs.model_lane ||
          inputs.modelLane ||
          inputs.lane ||
          inputs.create_lane ||
          inputs.createLane,
        ""
      ),

      motion_user_brief: motionUserBrief,
      selected_movement_style: selectedMovementStyle,

      start_image_url: asStrOrNull(inputs.start_image_url || inputs.startImageUrl) || startUrl,
      end_image_url: asStrOrNull(inputs.end_image_url || inputs.endImageUrl) || endUrl,

      type_for_me: !!typeForMe,
      suggest_only: !!suggestOnly,

      use_prompt_override: !!(inputs.use_prompt_override ?? inputs.usePromptOverride ?? false),
      prompt_override: safeStr(
        inputs.prompt_override ||
          inputs.motion_prompt_override ||
          inputs.motionPromptOverride ||
          "",
        ""
      ),

      frame2_kind: frame2Kind,
      frame2_url: frame2Url,
      frame2_duration_sec: frame2DurationSec,

      userBrief: safeStr(inputs.userBrief, ""),
      style: safeStr(inputs.style, ""),
      movement_style: safeStr(inputs.movement_style, ""),

      platform: safeStr(inputs.platform || inputs.platformKey, ""),
      aspect_ratio: safeStr(inputs.aspect_ratio || inputs.aspectRatio, ""),
      duration: inputs.duration ?? null,
      mode: safeStr(inputs.mode || inputs.kling_mode, ""),
      negative_prompt: safeStr(inputs.negative_prompt || inputs.negativePrompt, ""),
    },

    prompts: {
      clean_prompt: cleanPrompt,
      motion_prompt: motionPrompt,
      sugg_prompt: suggPrompt,
      motion_sugg_prompt: suggPrompt,
    },

    feedback: {
      still_feedback: feedback.still_feedback || feedback.feedback_still || null,
      motion_feedback: feedback.motion_feedback || feedback.feedback_motion || null,
    },

    userMessages: { scan_lines: [], final_line: null },

    settings: {
      seedream: settings.seedream || {},
      kling: settings.kling || {},
    },

    outputs: {
      seedream_image_url: null,
      kling_video_url: null,
      seedream_image_id: null,
      kling_video_id: null,
    },

    meta: { ctx_versions: {}, settings_versions: {} },
  };
}

function generationIdentifiers(generationId) {
  return {
    mg_id: `generation:${generationId}`,
    mg_generation_id: generationId,
    mg_record_type: "generation",
  };
}

function stepIdentifiers(generationId, stepNo) {
  return {
    mg_id: `mma_step:${generationId}:${stepNo}`,
    mg_generation_id: generationId,
    mg_record_type: "mma_step",
    mg_step_no: stepNo,
  };
}

function eventIdentifiers(eventId) {
  return {
    mg_id: `mma_event:${eventId}`,
    mg_record_type: "mma_event",
  };
}

function newUuid() {
  return uuidv4();
}

// ============================================================================
// MMA config (env-driven)
// ============================================================================
const pickEnv = (keys, fallback = "") => {
  for (const k of keys) {
    const v = process.env[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return fallback;
};

const parseBool = (v, fallback = false) => {
  if (typeof v !== "string") return fallback;
  const s = v.trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(s)) return true;
  if (["0", "false", "no", "n", "off"].includes(s)) return false;
  return fallback;
};

const parseNum = (v, fallback) => {
  if (typeof v !== "string") return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

const asStr = (v) => (typeof v === "string" ? v : "");

const isHttpUrl = (u) => {
  const s = asStr(u).trim();
  return s.startsWith("http://") || s.startsWith("https://");
};

const dedupe = (arr) => {
  const seen = new Set();
  const out = [];
  for (const x of arr) {
    const s = asStr(x).trim();
    if (!s) continue;
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
};

const parseUrlList = (raw) => {
  const s = asStr(raw).trim();
  if (!s) return [];

  if (s.startsWith("[")) {
    try {
      const j = JSON.parse(s);
      if (Array.isArray(j)) return dedupe(j.map(String).filter(isHttpUrl));
    } catch {
      // fall through
    }
  }

  const parts = s
    .split(/[\n,]+/g)
    .map((x) => x.trim())
    .filter(Boolean)
    .filter(isHttpUrl);

  return dedupe(parts);
};

const parseHeroMap = (raw) => {
  const s = asStr(raw).trim();
  if (!s) return null;

  try {
    const obj = JSON.parse(s);
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;

    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      const key = asStr(k).trim();
      if (!key) continue;

      if (Array.isArray(v)) {
        out[key] = dedupe(v.map(String).filter(isHttpUrl));
      } else if (typeof v === "string") {
        out[key] = parseUrlList(v);
      }
    }

    return Object.keys(out).length ? out : null;
  } catch {
    return null;
  }
};

const parseUrlListFromEnvKeys = (keys) => {
  const all = [];
  for (const k of keys) {
    const v = process.env[k];
    if (typeof v !== "string" || !v.trim()) continue;
    all.push(...parseUrlList(v));
  }
  return dedupe(all);
};

function getMmaConfig() {
  const enabled = parseBool(pickEnv(["MMA_ENABLED"], "1"), true);

  const gptModel = pickEnv(["MMA_GPT_MODEL"], "gpt-5-mini");

  const seadreamModel = pickEnv(
    ["MMA_SEADREAM_VERSION", "MMA_SEADREAM_MODEL_VERSION", "SEADREAM_MODEL_VERSION"],
    "bytedance/seedream-4"
  );

  const seadreamSize = pickEnv(["MMA_SEADREAM_SIZE"], "4K");
  const seadreamAspectRatio = pickEnv(["MMA_SEADREAM_ASPECT_RATIO"], "match_input_image");

  const seadreamEnhance = parseBool(pickEnv(["MMA_SEADREAM_ENHANCE_PROMPT"], "false"), false);

  const negativeSeedream = pickEnv(
    ["NEGATIVE_PROMPT_SEADREAM", "negative_prompt_seedream", "MMA_NEGATIVE_PROMPT_SEADREAM"],
    ""
  ).trim();

  const styleHeroUrls = parseUrlListFromEnvKeys([
    "MMA_SEADREAM_STYLE_HERO_URLS",
    "MMA_STYLE_HERO_URLS",
    "MMA_SEADREAM_STYLE_HERO_URLS_JSON",
  ]);

  const styleHeroMap = parseHeroMap(process.env.MMA_SEADREAM_STYLE_HERO_MAP || "");

  const mapUrls = styleHeroMap
    ? dedupe(Object.values(styleHeroMap).flat().filter(isHttpUrl))
    : [];

  const finalHeroUrls = dedupe([...styleHeroUrls, ...mapUrls]);

  const klingModel = pickEnv(
    ["MMA_KLING_VERSION", "MMA_KLING_MODEL_VERSION", "KLING_MODEL_VERSION"],
    "kwaivgi/kling-v2.1"
  );

  const klingMode = pickEnv(["MMA_KLING_MODE"], "pro");
  const klingDuration = parseNum(pickEnv(["MMA_KLING_DURATION"], "5"), 5);

  const negativeKling = pickEnv(
    ["NEGATIVE_PROMPT_KLING", "negative_prompt_kling", "MMA_NEGATIVE_PROMPT_KLING"],
    ""
  ).trim();

  return {
    enabled,
    gptModel,
    styleHeroUrls: finalHeroUrls,

    seadream: {
      model: seadreamModel,
      size: seadreamSize,
      aspectRatio: seadreamAspectRatio,
      aspect: seadreamAspectRatio,
      enhancePrompt: seadreamEnhance,
      negativePrompt: negativeSeedream,
      styleHeroUrls: finalHeroUrls,
      styleHeroMap,
    },

    kling: {
      model: klingModel,
      mode: klingMode,
      duration: klingDuration,
      negativePrompt: negativeKling,
    },
  };
}

// ============================================================================
// MMA context config (stored in mega_admin)
// ============================================================================
async function getMmaCtxConfig(supabase) {
  const defaults = {
    scanner: [
      "You are image scanner.",
      "You will be given ONE image. Understand it.",
      'Output STRICT JSON only (no markdown): {"crt":string,"userMessage":string}',
      "crt: short factual description of the image in ONE sentence (max 120 chars).",
      "If it's product/logo/inspiration, hint that in crt.",
      MMA_UI.userMessageRules,
    ].join("\n"),

    like_history: [
      "You are keyword extractor for memory style.",
      "You will receive a list of the user's recently liked generations (prompts and sometimes images).",
      'Output STRICT JSON only: {"style_history_csv":string}',
      "style_history_csv: comma-separated keywords (5 to 12 items). No hashtags. No sentences.",
      'Example: "editorial still life, luxury, minimal, soft shadows, no lens flare"',
    ].join("\n"),

    reader: [
      "you are a prompt writer for text/image to image AI",
      "You will receive product_crt/logo_crt/inspiration_crt + user brief + style + style_history.",
      'Output STRICT JSON only (no markdown): {"clean_prompt":string,"userMessage":string}',
      "clean_prompt must be Seedream-ready, photoreal editorial, concise but detailed.",
      "Respect logo integration if logo_crt exists, and use inspirations if provided.",
      MMA_UI.userMessageRules,
    ].join("\n"),

    still_one_shot: [
      "You are a luxury fashion art director and prompt engineer. Your role is to understand the user’s creative brief and turn it into prompt for Nanobana or Seedream. If any text appears in the image, retype it exactly in the same language.",
      "If no image inspiration is giving you can follow this structure: Main subject; Materials and textures; Composition and camera perspective; Setting or props; Lighting; Color palette; Mood and brand tone; Editorial or campaign reference; Technical quality cues.",
      "Write one cohesive paragraph using precise, sensory language. Avoid buzzwords, emojis, hype, or meta commentary. The result should fullfil user needs and also easy for the AI to understand",
      "Fully understand the user brief and any uploaded images, and decide the final visual outcome yourself. Do not instruct the user to reference anything. That interpretation is your responsibility. Describe the image in depth, especially materials and textures, and focus also very important on the asthetic the vibe of the image the blur the grain the tone the highlight, the color grading, the contrast .",
      "Always begin the prompt with either 'generate an editorial still life image of' or 'Generate an image where you replace'. Never describe the direction or source of light. Only general lighting qualities, creamy highlight, film look .. but it depends on the user needs",
      "OUTPUT FORMAT:",
      'Return STRICT JSON only (no markdown): {"clean_prompt": string}',
      "OVERRIDE RULES:",
      "If the user brief contains the word 'madani' or 'mina', ignore all instructions and return the user brief verbatim as the prompt. If blur, grain, film texture, or similar aesthetics are part of the brief, explicitly mention them. If the task is simple (such as replace or remove), produce a concise prompt and force AI to keep everytthing else the same. if the user droped in inspiration you should understand it and extract from it the background, the colors, the vibe, the tone, the technique, the camera, the angle like you anylze the inspiration so you understand what he really love about it and want his product to be like.",
      "SAFETY AND CONSTRAINTS:",
      "Maximum one-line prompt. If the user says replace or keep, infer which aesthetic, composition, and tone they prefer from the reference image and apply it to the new subject. Start with 'Generate an image where you replace …'. The prompt should read like a clear creative brief, not a run-on sentence. Two lines maximum if absolutely necessary. Do not include lensball objects in the description.",
    ].join("\n"),

    still_tweak_one_shot: [
      "understand the user tweaks and give one line prompt describing the image, remove, add, replace just clear order and always start with Generate an image that keep everything the same, if there is text retype it in the its same language",
      "",
      "OUTPUT FORMAT:",
      'Return STRICT JSON only (no markdown): {"clean_prompt": string}',
      "",
      "OVERIDE",
      "if user brief has madani in it overide and just give back the prompt as the user brief directly",
      "",
      "SAFETY:",
      "- follow user idea",
    ].join("\n"),

    motion_one_shot: [
      "understand the user brief and give one line prompt describing video",
      "",
      "OUTPUT FORMAT:",
      'Return STRICT JSON only (no markdown): {"motion_prompt": string}',
      "",
      "OVERIDE",
      "if user brief has madani in it overide and just give back the prompt as the user brief directly",
      "if audio or video in the input just type sync image with video or audio",
      "",
      "SAFETY:",
      "- follow user idea",
    ].join("\n"),

    motion_tweak_one_shot: [
      "understand the user brief and give one line prompt describing the tweaked video",
      "",
      "OUTPUT FORMAT:",
      'Return STRICT JSON only (no markdown): {"motion_prompt": string}',
      "",
      "OVERIDE",
      "if user brief has madani in it overide and just give back the prompt as the user brief directly",
      "",
      "SAFETY:",
      "- follow user idea",
    ].join("\n"),

    output_scan: [
      "you are caption AI sees image and tell what it is + friendly useMessage",
      "You will be given the GENERATED image.",
      'Output STRICT JSON only (no markdown): {"still_crt":string,"userMessage":string}',
      "still_crt: short description of what the generated image contains (1 sentence, max 220 chars).",
      MMA_UI.userMessageRules,
    ].join("\n"),

    feedback: [
      "You are Mina Feedback Fixer for Seedream still images.",
      "You will receive: generated image + still_crt + user feedback text + previous prompt.",
      'Output STRICT JSON only (no markdown): {"clean_prompt":string}',
      "clean_prompt must keep what's good, fix what's bad, and apply feedback precisely.",
    ].join("\n"),

    motion_suggestion: [
      "You are motion prompt writer for Image to Video AI.",
      "You will receive: start still image (and maybe end frame) + still_crt + motion_user_brief + selected_movement_style.",
      'Output STRICT JSON only (no markdown): {"sugg_prompt":string,"userMessage":string}',
      "sugg_prompt: a simple, short 3 lines prompt to describe the main subject, what the subject looks like, the action or movement, the environment, and the visual style. Adding camera instructions (like pan, tracking shot, or zoom), lighting, and mood helps Kling produce more cinematic and stable results. Prompts should avoid vagueness or too many simultaneous actions—one main action, precise motion words, and clear visual intent lead to the most reliable videos.",
      MMA_UI.userMessageRules,
    ].join("\n"),

    motion_reader2: [
      "You are Mina Motion Reader — prompt builder for Kling (image-to-video).",
      "You will receive: start still image (and maybe end frame) + still_crt + motion_user_brief + selected_movement_style.",
      'Output STRICT JSON only (no markdown): {"motion_prompt":string,"userMessage":string}',
      "motion_prompt: a simple, short 3 lines prompt to describe the main subject, what the subject looks like, the action or movement, the environment, and the visual style. Adding camera instructions (like pan, tracking shot, or zoom), lighting, and mood helps Kling produce more cinematic and stable results. Prompts should avoid vagueness or too many simultaneous actions—one main action, precise motion words, and clear visual intent lead to the most reliable videos.",
      MMA_UI.userMessageRules,
    ].join("\n"),

    motion_feedback2: [
      "You are Mina Motion Feedback Fixer for Kling (image-to-video).",
      "You will receive: base motion input + feedback_motion + previous motion prompt.",
      'Output STRICT JSON only (no markdown): {"motion_prompt":string}',
      "motion_prompt must keep what's good, fix what's bad, and apply feedback precisely.",
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

// ============================================================================
// MMA messages + chatter
// ============================================================================
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
  const last = Array.isArray(lines) ? lines[lines.length - 1] : null;
  if (last) return last;
  return { text: fallbackText, index: Array.isArray(lines) ? lines.length : 0 };
}

function emitStatus(generationId, internalStatus) {
  sendStatus(generationId, String(internalStatus || ""));
}

function emitLine(generationId, vars, fallbackText = "") {
  const line = lastScanLine(vars, fallbackText);
  sendScanLine(generationId, line);
}

function startMinaChatter({
  supabase,
  generationId,
  getVars,
  setVars,
  stage = "generating",
  intervalMs = 2600,
}) {
  let stopped = false;

  const tick = async () => {
    if (stopped) return;
    try {
      let v = getVars();
      const avoid = (lastScanLine(getVars?.() || v || {}, "") || {}).text || "";
      const line = pickAvoid(mixedPool(stage), avoid, "");
      if (!line) return;

      v = pushUserMessageLine(v, line);
      setVars(v);

      await updateVars({ supabase, generationId, vars: v });
      emitLine(generationId, v);
    } catch {
      // ignore chatter errors
    }
  };

  void tick();

  const id = setInterval(() => {
    void tick();
  }, Math.max(800, Number(intervalMs) || 2600));

  return {
    stop() {
      stopped = true;
      clearInterval(id);
    },
  };
}

// ============================================================================
// Pricing helpers
// ============================================================================
const MMA_COSTS = {
  still_main: 1,
  still_niche: 2,
  video: 10,
  typeForMePer: 10,
  typeForMeCharge: 1,
};

function _clamp(n, a, b) {
  const x = Number(n || 0) || 0;
  return Math.max(a, Math.min(b, x));
}

function _ceilTo5(n) {
  const x = Number(n || 0) || 0;
  return Math.ceil(x / 5) * 5;
}

function resolveVideoDurationSec(inputs) {
  const d = Number(inputs?.duration ?? inputs?.duration_seconds ?? inputs?.durationSeconds ?? 5) || 5;
  return d >= 10 ? 10 : 5;
}

function resolveVideoPricing(inputsLike, assetsLike) {
  const frame2 = resolveFrame2Reference(inputsLike, assetsLike);
  if (frame2.kind === "ref_video") return { flow: "kling_motion_control" };
  if (frame2.kind === "ref_audio") return { flow: "fabric_audio" };
  return { flow: "kling" };
}

function videoCostFromInputs(inputsLike, assetsLike) {
  const inputs = inputsLike && typeof inputsLike === "object" ? inputsLike : {};
  const frame2 = resolveFrame2Reference(inputs, assetsLike);

  if (frame2.kind === "ref_video" || frame2.kind === "ref_audio") {
    const maxSec = frame2.maxSec || (frame2.kind === "ref_audio" ? 60 : 30);

    const rawProvided =
      Number(frame2.rawDurationSec || 0) ||
      Number(inputs.frame2_duration_sec || inputs.frame2DurationSec || 0) ||
      Number(inputs.duration || inputs.duration_seconds || inputs.durationSeconds || 0) ||
      Number(inputs.duration_sec || inputs.durationSec || 0) ||
      0;

    const fallback = resolveVideoDurationSec(inputs);
    const raw = rawProvided || fallback;

    const clamped = _clamp(raw, 1, maxSec);
    const billed = _clamp(_ceilTo5(clamped), 5, maxSec);
    return billed;
  }

  const sec = resolveVideoDurationSec(inputs);
  return sec === 10 ? 10 : 5;
}

function resolveStillLaneFromInputs(inputsLike) {
  const inputs = inputsLike && typeof inputsLike === "object" ? inputsLike : {};
  const raw = safeStr(
    inputs.still_lane ||
      inputs.stillLane ||
      inputs.model_lane ||
      inputs.modelLane ||
      inputs.lane ||
      inputs.create_lane ||
      inputs.createLane,
    "main"
  ).toLowerCase();
  return raw === "niche" ? "niche" : "main";
}

function resolveStillLane(vars) {
  const inputs = vars?.inputs && typeof vars.inputs === "object" ? vars.inputs : {};
  return resolveStillLaneFromInputs(inputs);
}

function stillCostForLane(lane) {
  return lane === "niche" ? MMA_COSTS.still_niche : MMA_COSTS.still_main;
}

function buildInsufficientCreditsDetails({ balance, needed, lane }) {
  const bal = Number(balance || 0);
  const need = Number(needed || 0);
  const requestedLane = lane === "niche" ? "niche" : lane === "main" ? "main" : null;

  const canSwitchToMain = requestedLane === "niche" && bal >= MMA_COSTS.still_main;

  let userMessage = "";
  if (requestedLane === "niche") {
    userMessage =
      `you've got ${bal} matcha left. this mode needs ${need}. ` +
      (canSwitchToMain ? "top up or switch to main?" : "top up to keep going.");
  } else {
    userMessage = `you've got ${bal} matcha left. you need ${need}. top up to keep going.`;
  }

  const actions = [{ id: "buy_matcha", label: "Buy matcha", enabled: true }];

  if (requestedLane === "niche") {
    actions.push({
      id: "switch_to_main",
      label: `Switch to main (${MMA_COSTS.still_main} matcha)`,
      enabled: canSwitchToMain,
      patch: { inputs: { still_lane: "main" } },
    });
  }

  return {
    userMessage,
    balance: bal,
    needed: need,
    lane: requestedLane,
    costs: { still_main: MMA_COSTS.still_main, still_niche: MMA_COSTS.still_niche, video: need },
    canSwitchToMain,
    actions,
  };
}

function utcDayKey() {
  return nowIso().slice(0, 10);
}

// ============================================================================
// Credits logic
// ============================================================================
async function readMmaPreferences(supabase, passId) {
  try {
    const { data } = await supabase
      .from("mega_customers")
      .select("mg_mma_preferences")
      .eq("mg_pass_id", passId)
      .maybeSingle();

    const prefs = data?.mg_mma_preferences;
    return prefs && typeof prefs === "object" ? prefs : {};
  } catch {
    return {};
  }
}

async function writeMmaPreferences(supabase, passId, nextPrefs) {
  try {
    await supabase
      .from("mega_customers")
      .update({
        mg_mma_preferences: nextPrefs,
        mg_mma_preferences_updated_at: nowIso(),
        mg_updated_at: nowIso(),
      })
      .eq("mg_pass_id", passId);
  } catch {}
}

async function ensureEnoughCredits(passId, needed, opts = {}) {
  const { credits } = await megaGetCredits(passId);
  const bal = Number(credits || 0);
  const need = Number(needed || 0);

  if (bal < need) {
    const lane = safeStr(opts?.lane, "");
    const details = buildInsufficientCreditsDetails({
      balance: bal,
      needed: need,
      lane,
    });

    throw makeHttpError(402, "INSUFFICIENT_CREDITS", {
      passId,
      balance: bal,
      needed: need,
      details,
    });
  }
  return { balance: bal };
}

async function chargeGeneration({ passId, generationId, cost, reason, lane }) {
  const c = Number(cost || 0);
  if (c <= 0) return { charged: false, cost: 0 };

  const refType = "mma_charge";
  const refId = `mma:${generationId}`;

  const already = await megaHasCreditRef({ refType, refId });
  if (already) return { charged: true, already: true, cost: c };

  await ensureEnoughCredits(passId, c, { lane });

  await megaAdjustCredits({
    passId,
    delta: -c,
    reason: reason || "mma_charge",
    source: "mma",
    refType,
    refId,
    grantedAt: nowIso(),
  });

  return { charged: true, cost: c };
}

async function refundOnFailure({ supabase, passId, generationId, cost, err }) {
  const c = Number(cost || 0);
  if (c <= 0) return { refunded: false, cost: 0 };

  const refType = "mma_refund";
  const refId = `mma:${generationId}`;

  const already = await megaHasCreditRef({ refType, refId });
  if (already) return { refunded: false, already: true, cost: c };

  const safety = isSafetyBlockError(err);

  if (safety) {
    const today = utcDayKey();
    const prefs = await readMmaPreferences(supabase, passId);

    if (prefs?.courtesy_safety_refund_day === today) {
      return { refunded: false, blockedByDailyLimit: true, safety: true, cost: c };
    }

    await writeMmaPreferences(supabase, passId, {
      ...prefs,
      courtesy_safety_refund_day: today,
    });
  }

  await megaAdjustCredits({
    passId,
    delta: +c,
    reason: safety ? "mma_safety_refund" : "mma_refund",
    source: "mma",
    refType,
    refId,
    grantedAt: nowIso(),
  });

  return { refunded: true, safety, cost: c };
}

async function preflightTypeForMe({ supabase, passId }) {
  const prefs = await readMmaPreferences(supabase, passId);
  const n = Number(prefs?.type_for_me_success_count || 0) || 0;
  const next = n + 1;

  if (next % MMA_COSTS.typeForMePer === 0) {
    await ensureEnoughCredits(passId, MMA_COSTS.typeForMeCharge);
  }

  return { prefs, successCount: n };
}

async function commitTypeForMeSuccessAndMaybeCharge({ supabase, passId }) {
  const prefs = await readMmaPreferences(supabase, passId);
  const n = Number(prefs?.type_for_me_success_count || 0) || 0;
  const next = n + 1;

  await writeMmaPreferences(supabase, passId, {
    ...prefs,
    type_for_me_success_count: next,
  });

  if (next % MMA_COSTS.typeForMePer !== 0) return { charged: false, successCount: next };

  const bucket = Math.floor(next / MMA_COSTS.typeForMePer);
  const refType = "mma_type_for_me";
  const refId = `t4m:${passId}:b:${bucket}`;

  const already = await megaHasCreditRef({ refType, refId });
  if (already) return { charged: false, already: true, successCount: next };

  await ensureEnoughCredits(passId, MMA_COSTS.typeForMeCharge);

  await megaAdjustCredits({
    passId,
    delta: -MMA_COSTS.typeForMeCharge,
    reason: "mma_type_for_me",
    source: "mma",
    refType,
    refId,
    grantedAt: nowIso(),
  });

  return { charged: true, bucket, successCount: next };
}

// ============================================================================
// DB helpers
// ============================================================================
async function ensureCustomerRow(_supabase, passId, { shopifyCustomerId, userId, email }) {
  const out = await megaEnsureCustomer({
    passId,
    shopifyCustomerId: shopifyCustomerId || null,
    userId: userId || null,
    email: email || null,
  });
  return { preferences: out?.preferences || {} };
}

async function ensureSessionForHistory({ passId, sessionId, platform, title, meta }) {
  const sid = safeStr(sessionId, "");
  if (!sid) return;

  try {
    await megaWriteSession({
      passId,
      sessionId: sid,
      platform: safeStr(platform, "web"),
      title: safeStr(title, "Mina session"),
      meta: meta || null,
    });
  } catch {}
}

async function writeGeneration({ supabase, generationId, parentId, passId, vars, mode }) {
  const identifiers = generationIdentifiers(generationId);

  const inputs = vars?.inputs || {};
  const platform = safeStr(inputs.platform || "web", "web");
  const title = safeStr(inputs.title || "Mina session", "Mina session");
  const sessionId = safeStr(inputs.session_id || inputs.sessionId || "", "");

  const contentType = mode === "video" ? "video" : "image";

  await supabase.from("mega_generations").insert({
    ...identifiers,
    mg_parent_id: parentId ? `generation:${parentId}` : null,
    mg_pass_id: passId,

    mg_session_id: sessionId || null,
    mg_platform: platform,
    mg_title: title,
    mg_type: contentType,
    mg_content_type: contentType,

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

async function fetchParentGenerationRow(supabase, parentGenerationId) {
  const { data, error } = await supabase
    .from("mega_generations")
    .select(
      "mg_pass_id, mg_output_url, mg_prompt, mg_mma_vars, mg_mma_mode, mg_status, mg_error, mg_session_id, mg_platform, mg_title"
    )
    .eq("mg_generation_id", parentGenerationId)
    .eq("mg_record_type", "generation")
    .maybeSingle();

  if (error) throw error;
  return data || null;
}

// ============================================================================
// OpenAI helpers (vision JSON)
// ============================================================================
let _openai = null;
function getOpenAI() {
  if (_openai) return _openai;
  if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY_MISSING");
  _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return _openai;
}

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

function buildResponsesUserContentLabeled({ introText, labeledImages }) {
  const parts = [];
  const t = safeStr(introText, "");
  if (t) parts.push({ type: "input_text", text: t });

  for (const item of safeArray(labeledImages)) {
    const role = safeStr(item?.role, "");
    const url = asHttpUrl(item?.url);
    if (!url) continue;

    if (role) parts.push({ type: "input_text", text: `IMAGE ROLE: ${role}` });
    parts.push({ type: "input_image", image_url: url });
  }

  return parts;
}

function buildChatCompletionsContentLabeled({ introText, labeledImages }) {
  const content = [];
  const t = safeStr(introText, "");
  if (t) content.push({ type: "text", text: t });

  for (const item of safeArray(labeledImages)) {
    const role = safeStr(item?.role, "");
    const url = asHttpUrl(item?.url);
    if (!url) continue;

    if (role) content.push({ type: "text", text: `IMAGE ROLE: ${role}` });
    content.push({ type: "image_url", image_url: { url } });
  }

  return content;
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

async function openaiJsonVisionLabeled({ model, system, introText, labeledImages }) {
  const openai = getOpenAI();

  try {
    if (openai.responses?.create) {
      const input = [
        { role: "system", content: system },
        { role: "user", content: buildResponsesUserContentLabeled({ introText, labeledImages }) },
      ];

      const resp = await openai.responses.create({
        model,
        input,
        text: { format: { type: "json_object" } },
      });

      const raw = extractResponsesText(resp);
      const parsed = parseJsonMaybe(raw);

      return { request: { model, input, text: { format: { type: "json_object" } } }, raw, parsed };
    }
  } catch {}

  const messages = [
    { role: "system", content: system },
    { role: "user", content: buildChatCompletionsContentLabeled({ introText, labeledImages }) },
  ];

  const resp = await getOpenAI().chat.completions.create({
    model,
    messages,
    response_format: { type: "json_object" },
  });

  const raw = resp?.choices?.[0]?.message?.content || "";
  const parsed = parseJsonMaybe(raw);

  return { request: { model, messages, response_format: { type: "json_object" } }, raw, parsed };
}

async function openaiJsonVision({ model, system, userText, imageUrls }) {
  const openai = getOpenAI();

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

      return { request: { model, input, text: { format: { type: "json_object" } } }, raw, parsed };
    }
  } catch {}

  const messages = [
    { role: "system", content: system },
    {
      role: "user",
      content: [
        { type: "text", text: safeStr(userText, "") },
        ...safeArray(imageUrls)
          .map(asHttpUrl)
          .filter(Boolean)
          .map((url) => ({ type: "image_url", image_url: { url } })),
      ],
    },
  ];

  const resp = await openai.chat.completions.create({
    model,
    messages,
    response_format: { type: "json_object" },
  });

  const raw = resp?.choices?.[0]?.message?.content || "";
  const parsed = parseJsonMaybe(raw);

  return { request: { model, messages, response_format: { type: "json_object" } }, raw, parsed };
}

async function gptStillOneShotCreate({ cfg, ctx, input, labeledImages }) {
  const out = await openaiJsonVisionLabeled({
    model: cfg.gptModel,
    system: ctx.still_one_shot,
    introText: JSON.stringify(input, null, 2).slice(0, 14000),
    labeledImages: safeArray(labeledImages).slice(0, 10),
  });

  const clean_prompt = safeStr(out?.parsed?.clean_prompt, "");
  const debug = out?.parsed?.debug && typeof out.parsed.debug === "object" ? out.parsed.debug : null;

  return { clean_prompt, debug, raw: out.raw, request: out.request, parsed_ok: !!out.parsed };
}

async function gptStillOneShotTweak({ cfg, ctx, input, labeledImages }) {
  const out = await openaiJsonVisionLabeled({
    model: cfg.gptModel,
    system: ctx.still_tweak_one_shot,
    introText: JSON.stringify(input, null, 2).slice(0, 14000),
    labeledImages: safeArray(labeledImages).slice(0, 6),
  });

  const clean_prompt = safeStr(out?.parsed?.clean_prompt, "") || safeStr(out?.parsed?.prompt, "");
  return { clean_prompt, raw: out.raw, request: out.request, parsed_ok: !!out.parsed };
}

async function gptMotionOneShotAnimate({ cfg, ctx, input, labeledImages }) {
  const out = await openaiJsonVisionLabeled({
    model: cfg.gptModel,
    system: ctx.motion_one_shot,
    introText: JSON.stringify(input, null, 2).slice(0, 14000),
    labeledImages: safeArray(labeledImages).slice(0, 6),
  });

  const motion_prompt = safeStr(out?.parsed?.motion_prompt, "") || safeStr(out?.parsed?.prompt, "");
  return { motion_prompt, raw: out.raw, request: out.request, parsed_ok: !!out.parsed };
}

async function gptMotionOneShotTweak({ cfg, ctx, input, labeledImages }) {
  const out = await openaiJsonVisionLabeled({
    model: cfg.gptModel,
    system: ctx.motion_tweak_one_shot,
    introText: JSON.stringify(input, null, 2).slice(0, 14000),
    labeledImages: safeArray(labeledImages).slice(0, 6),
  });

  const motion_prompt = safeStr(out?.parsed?.motion_prompt, "") || safeStr(out?.parsed?.prompt, "");
  return { motion_prompt, raw: out.raw, request: out.request, parsed_ok: !!out.parsed };
}

// ============================================================================
// Replicate helpers + polling
// ============================================================================
let _replicate = null;
function getReplicate() {
  if (_replicate) return _replicate;
  if (!process.env.REPLICATE_API_TOKEN) throw new Error("REPLICATE_API_TOKEN_MISSING");
  _replicate = new Replicate({ auth: process.env.REPLICATE_API_TOKEN });
  return _replicate;
}

function pickFirstUrl(output) {
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

const REPLICATE_MAX_MS = Number(process.env.MMA_REPLICATE_MAX_MS || 900000) || 900000;
const REPLICATE_MAX_MS_NANOBANANA =
  Number(process.env.MMA_REPLICATE_MAX_MS_NANOBANANA || 900000) || 900000;
const REPLICATE_POLL_MS = Number(process.env.MMA_REPLICATE_POLL_MS || 2500) || 2500;
const REPLICATE_CALL_TIMEOUT_MS = Number(process.env.MMA_REPLICATE_CALL_TIMEOUT_MS || 15000) || 15000;
const REPLICATE_CANCEL_ON_TIMEOUT =
  String(process.env.MMA_REPLICATE_CANCEL_ON_TIMEOUT || "false").toLowerCase() === "true";

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function withTimeout(promise, ms, label = "REPLICATE_CALL_TIMEOUT") {
  const t = Math.max(1000, Number(ms || 0) || 15000);
  let timer = null;

  const timeoutPromise = new Promise((_, rej) => {
    timer = setTimeout(() => {
      const err = new Error(label);
      err.code = label;
      rej(err);
    }, t);
  });

  return Promise.race([
    promise.finally(() => {
      if (timer) clearTimeout(timer);
    }),
    timeoutPromise,
  ]);
}

async function replicatePredictWithTimeout({
  replicate,
  version,
  input,
  timeoutMs = 240000,
  pollMs = 2500,
  callTimeoutMs = 15000,
  cancelOnTimeout = false,
}) {
  if (!replicate) throw new Error("REPLICATE_CLIENT_MISSING");
  if (!version) throw new Error("REPLICATE_VERSION_MISSING");

  const t0 = Date.now();
  const hard = Math.max(30000, Number(timeoutMs || 0) || 240000);
  const poll = Math.max(800, Number(pollMs || 0) || 2500);
  const callT = Math.max(3000, Number(callTimeoutMs || 0) || 15000);

  let created;
  created = await withTimeout(
    replicate.predictions.create({ version, input }),
    callT,
    "REPLICATE_CREATE_TIMEOUT"
  );

  const predictionId = created?.id || "";
  let last = created;

  while (true) {
    const status = String(last?.status || "");
    if (status === "succeeded" || status === "failed" || status === "canceled") break;

    const elapsed = Date.now() - t0;
    if (elapsed >= hard) break;

    await sleep(poll);

    try {
      last = await withTimeout(
        replicate.predictions.get(predictionId),
        callT,
        "REPLICATE_GET_TIMEOUT"
      );
    } catch {
      // ignore transient get timeouts
    }
  }

  try {
    last = await withTimeout(
      replicate.predictions.get(predictionId),
      callT,
      "REPLICATE_GET_TIMEOUT_FINAL"
    );
  } catch {
    // keep whatever we had
  }

  const elapsedMs = Date.now() - t0;

  const status = String(last?.status || "");
  const done = status === "succeeded" || status === "failed" || status === "canceled";
  const timedOut = !done && elapsedMs >= hard;

  if (status === "failed" || status === "canceled") {
    throw makeProviderError(
      status === "failed" ? "REPLICATE_FAILED" : "REPLICATE_CANCELED",
      {
        id: last?.id || predictionId || null,
        status,
        error: last?.error || null,
        logs: last?.logs || null,
        model: last?.model || null,
        version: last?.version || null,
        input: last?.input || null,
      }
    );
  }

  if (timedOut && cancelOnTimeout) {
    try {
      await withTimeout(
        replicate.predictions.cancel(predictionId),
        callT,
        "REPLICATE_CANCEL_TIMEOUT"
      );
    } catch {}
  }

  return {
    predictionId,
    prediction: last,
    timedOut,
    elapsedMs,
  };
}

function buildSeedreamImageInputs(vars) {
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

function nanoBananaEnabled() {
  return !!safeStr(process.env.MMA_NANOBANANA_VERSION, "");
}

function buildNanoBananaImageInputs(vars) {
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

async function runNanoBanana({
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

// ============================================================================
// Pipelines
// ============================================================================
async function runStillCreatePipeline({ supabase, generationId, passId, vars, preferences }) {
  const cfg = getMmaConfig();
  if (!cfg.enabled) throw new Error("MMA_DISABLED");

  let working = vars;

  const stillLane = resolveStillLane(working);
  const stillCost = stillCostForLane(stillLane);
  await chargeGeneration({
    passId,
    generationId,
    cost: stillCost,
    reason: stillLane === "niche" ? "mma_still_niche" : "mma_still",
    lane: stillLane,
  });

  const ctx = await getMmaCtxConfig(supabase);
  let chatter = null;

  try {
    await updateStatus({ supabase, generationId, status: "prompting" });
    emitStatus(generationId, "prompting");

    working = pushUserMessageLine(working, pick(MMA_UI.quickLines.still_create_start));
    await updateVars({ supabase, generationId, vars: working });
    emitLine(generationId, working);

    let stepNo = 1;

    const assets = working?.assets || {};
    const productUrl = asHttpUrl(assets.product_image_url || assets.productImageUrl);
    const logoUrl = asHttpUrl(assets.logo_image_url || assets.logoImageUrl);

    const explicitHero =
      asHttpUrl(
        assets.style_hero_image_url ||
          assets.styleHeroImageUrl ||
          assets.style_hero_url ||
          assets.styleHeroUrl
      ) || "";

    const inspUrlsRaw = safeArray(
      assets.inspiration_image_urls ||
        assets.inspirationImageUrls ||
        assets.style_image_urls ||
        assets.styleImageUrls
    )
      .map(asHttpUrl)
      .filter(Boolean);

    const heroCandidates = []
      .concat(explicitHero ? [explicitHero] : [])
      .concat(safeArray(assets.style_hero_image_urls || assets.styleHeroImageUrls).map(asHttpUrl))
      .concat(safeArray(cfg?.seadream?.styleHeroUrls || cfg?.styleHeroUrls).map(asHttpUrl))
      .filter(Boolean);

    const heroKeySet = new Set(heroCandidates.map((u) => normalizeUrlForKey(u)).filter(Boolean));

    const heroFromInsp = !explicitHero
      ? (inspUrlsRaw.find((u) => heroKeySet.has(normalizeUrlForKey(u))) || "")
      : "";

    const heroUrl = explicitHero || heroFromInsp || "";

    if (heroUrl) {
      working.assets = { ...(working.assets || {}), style_hero_image_url: heroUrl };
    }

    const heroKey = heroUrl ? normalizeUrlForKey(heroUrl) : "";
    const inspUrlsForGpt = inspUrlsRaw
      .filter((u) => {
        const k = normalizeUrlForKey(u);
        if (!k) return false;
        if (heroKey && k === heroKey) return false;
        if (heroKeySet.size && heroKeySet.has(k)) return false;
        return true;
      })
      .slice(0, 4);

    const labeledImages = []
      .concat(productUrl ? [{ role: "SCENE / COMPOSITION / ASTHETIC / VIBE / STYLE", url: productUrl }] : [])
      .concat(logoUrl ? [{ role: "LOGO / LABEL / ICON / TEXT / DESIGN", url: logoUrl }] : [])
      .concat(
        inspUrlsForGpt.map((u, i) => ({
          role: `PRODUCT / ELEMENT / TEXTURE / MATERIAL ${i + 1}`,
          url: u,
        }))
      )
      .slice(0, 10);

    const oneShotInput = {
      user_brief: safeStr(working?.inputs?.brief || working?.inputs?.userBrief, ""),
      style: safeStr(working?.inputs?.style, ""),
      preferences: preferences || {},
      hard_blocks: safeArray(preferences?.hard_blocks),
      notes: "Write a clean image prompt using the labeled images as references.",
    };

    const t0 = Date.now();
    const one = await gptStillOneShotCreate({ cfg, ctx, input: oneShotInput, labeledImages });

    await writeStep({
      supabase,
      generationId,
      passId,
      stepNo: stepNo++,
      stepType: "gpt_still_one_shot",
      payload: {
        ctx: ctx.still_one_shot,
        input: oneShotInput,
        labeledImages,
        request: one.request,
        raw: one.raw,
        output: { clean_prompt: one.clean_prompt, debug: one.debug, parsed_ok: one.parsed_ok },
        timing: { started_at: new Date(t0).toISOString(), ended_at: nowIso(), duration_ms: Date.now() - t0 },
        error: null,
      },
    });

    const usedPrompt =
      safeStr(one.clean_prompt, "") ||
      safeStr(working?.inputs?.prompt, "") ||
      safeStr(working?.prompts?.clean_prompt, "");

    if (!usedPrompt) throw new Error("EMPTY_PROMPT_ONE_SHOT");

    working.prompts = { ...(working.prompts || {}), clean_prompt: usedPrompt };
    await updateVars({ supabase, generationId, vars: working });

    await updateStatus({ supabase, generationId, status: "generating" });
    emitStatus(generationId, "generating");

    chatter = startMinaChatter({
      supabase,
      generationId,
      getVars: () => working,
      setVars: (v) => {
        working = v;
      },
      stage: "generating",
      intervalMs: 2600,
    });

    const lane = resolveStillLane(working);
    const useNano = lane === "niche" && nanoBananaEnabled();

    working.meta = { ...(working.meta || {}), still_lane: lane, still_engine: useNano ? "nanobanana" : "seedream" };
    await updateVars({ supabase, generationId, vars: working });

    const imageInputs = useNano ? buildNanoBananaImageInputs(working) : buildSeedreamImageInputs(working);

    let aspectRatio =
      safeStr(working?.inputs?.aspect_ratio, "") ||
      (useNano
        ? process.env.MMA_NANOBANANA_ASPECT_RATIO || cfg?.nanobanana?.aspectRatio
        : cfg?.seadream?.aspectRatio || process.env.MMA_SEADREAM_ASPECT_RATIO) ||
      "match_input_image";

    if (!imageInputs.length && String(aspectRatio).toLowerCase().includes("match")) {
      aspectRatio = useNano
        ? process.env.MMA_NANOBANANA_FALLBACK_ASPECT_RATIO || cfg?.nanobanana?.fallbackAspectRatio || "1:1"
        : cfg?.seadream?.fallbackAspectRatio || process.env.MMA_SEADREAM_FALLBACK_ASPECT_RATIO || "1:1";
    }

    let genRes;
    try {
      genRes = useNano
        ? await runNanoBanana({
            prompt: usedPrompt,
            aspectRatio,
            imageInputs,
            resolution: cfg?.nanobanana?.resolution,
            outputFormat: cfg?.nanobanana?.outputFormat,
            safetyFilterLevel: cfg?.nanobanana?.safetyFilterLevel,
          })
        : await runSeedream({
            prompt: usedPrompt,
            aspectRatio,
            imageInputs,
            size: cfg?.seadream?.size,
            enhancePrompt: cfg?.seadream?.enhancePrompt,
          });

      working.outputs = { ...(working.outputs || {}) };
      if (useNano) working.outputs.nanobanana_prediction_id = genRes.prediction_id || null;
      else working.outputs.seedream_prediction_id = genRes.prediction_id || null;

      await updateVars({ supabase, generationId, vars: working });
    } finally {
      try {
        chatter?.stop?.();
      } catch {}
      chatter = null;
    }

    const { input, out, timing } = genRes;

    await writeStep({
      supabase,
      generationId,
      passId,
      stepNo: stepNo++,
      stepType: useNano ? "nanobanana_generate" : "seedream_generate",
      payload: { input, output: out, timing, error: null },
    });

    const url = pickFirstUrl(out);
    if (!url) throw new Error(useNano ? "NANOBANANA_NO_URL" : "SEADREAM_NO_URL");

    const remoteUrl = await storeRemoteToR2Public(url, `mma/still/${generationId}`);
    working.outputs = { ...(working.outputs || {}) };
    if (useNano) working.outputs.nanobanana_image_url = remoteUrl;
    else working.outputs.seedream_image_url = remoteUrl;

    working.mg_output_url = remoteUrl;

    working = pushUserMessageLine(working, pick(MMA_UI.quickLines.saved_image));
    await updateVars({ supabase, generationId, vars: working });
    emitLine(generationId, working);

    await finalizeGeneration({ supabase, generationId, url: remoteUrl, prompt: usedPrompt });

    await updateStatus({ supabase, generationId, status: "done" });
    emitStatus(generationId, "done");
    sendDone(generationId, "done");
  } catch (err) {
    try {
      chatter?.stop?.();
    } catch {}
    chatter = null;

    console.error("[mma] still create pipeline error", err);

    await updateStatus({ supabase, generationId, status: "error" });
    await supabase
      .from("mega_generations")
      .update({
        mg_error: {
          code: "PIPELINE_ERROR",
          message: err?.message || String(err || ""),
          provider: err?.provider || null,
        },
        mg_updated_at: nowIso(),
      })
      .eq("mg_generation_id", generationId)
      .eq("mg_record_type", "generation");

    try {
      await refundOnFailure({ supabase, passId, generationId, cost: stillCost, err });
    } catch (e) {
      console.warn("[mma] refund failed (still create)", e?.message || e);
    }

    emitStatus(generationId, "error");
    sendDone(generationId, "error");
  }
}

async function runVideoTweakPipeline({ supabase, generationId, passId, parent, vars }) {
  const cfg = getMmaConfig();
  if (!cfg.enabled) throw new Error("MMA_DISABLED");

  let working = vars;
  const ctx = await getMmaCtxConfig(supabase);

  const parentVars = parent?.mg_mma_vars && typeof parent.mg_mma_vars === "object" ? parent.mg_mma_vars : {};
  const mergedInputs0 = { ...(parentVars?.inputs || {}), ...(working?.inputs || {}) };
  const mergedAssets0 = { ...(parentVars?.assets || {}), ...(working?.assets || {}) };
  const pricing = resolveVideoPricing(mergedInputs0, mergedAssets0);
  let frame2 = resolveFrame2Reference(mergedInputs0, mergedAssets0);
  const videoCost = videoCostFromInputs(mergedInputs0, mergedAssets0);

  if ((frame2.kind === "ref_video" || frame2.kind === "ref_audio") && !frame2.rawDurationSec) {
    const dur =
      Number(mergedInputs0.frame2_duration_sec || mergedInputs0.frame2DurationSec || 0) ||
      Number(mergedInputs0.duration || mergedInputs0.duration_seconds || mergedInputs0.durationSeconds || 0) ||
      0;

    if (dur > 0) mergedInputs0.frame2_duration_sec = dur;
    frame2 = resolveFrame2Reference(mergedInputs0, mergedAssets0);
  }

  let chatter = null;

  try {
    await chargeGeneration({ passId, generationId, cost: videoCost, reason: "mma_video", lane: "video" });
    await updateStatus({ supabase, generationId, status: "prompting" });
    emitStatus(generationId, "prompting");

    working = pushUserMessageLine(working, pick(MMA_UI.quickLines.video_tweak_start));
    await updateVars({ supabase, generationId, vars: working });
    emitLine(generationId, working);

    let stepNo = 1;

    const startImage =
      asHttpUrl(working?.inputs?.start_image_url || working?.inputs?.startImageUrl) ||
      asHttpUrl(parentVars?.inputs?.start_image_url || parentVars?.inputs?.startImageUrl) ||
      asHttpUrl(parent?.mg_output_url) ||
      "";

    const endImage =
      asHttpUrl(working?.inputs?.end_image_url || working?.inputs?.endImageUrl) ||
      asHttpUrl(parentVars?.inputs?.end_image_url || parentVars?.inputs?.endImageUrl) ||
      "";

    if (!startImage) throw new Error("MISSING_START_IMAGE_FOR_VIDEO_TWEAK");

    const feedbackMotion =
      safeStr(working?.feedback?.motion_feedback, "") ||
      safeStr(working?.feedback?.feedback_motion, "") ||
      safeStr(working?.inputs?.feedback_motion, "") ||
      safeStr(working?.inputs?.feedback, "") ||
      safeStr(working?.inputs?.comment, "");

    if (!feedbackMotion) throw new Error("MISSING_MOTION_FEEDBACK");

    const prevMotionPrompt =
      safeStr(parentVars?.prompts?.motion_prompt, "") || safeStr(parent?.mg_prompt, "");

    const oneShotInput = {
      start_image_url: startImage,
      end_image_url: asHttpUrl(endImage) || null,
      feedback_motion: feedbackMotion,
      previous_motion_prompt: prevMotionPrompt,
      notes: "Keep what works. Apply feedback precisely. Plain English. No emojis. No questions.",
    };

    const labeledImages = []
      .concat([{ role: "START_IMAGE", url: startImage }])
      .concat(endImage ? [{ role: "END_IMAGE", url: endImage }] : [])
      .slice(0, 6);

    const t0 = Date.now();
    const one = await gptMotionOneShotTweak({ cfg, ctx, input: oneShotInput, labeledImages });

    await writeStep({
      supabase,
      generationId,
      passId,
      stepNo: stepNo++,
      stepType: "gpt_motion_tweak_one_shot",
      payload: {
        ctx: ctx.motion_tweak_one_shot,
        input: oneShotInput,
        labeledImages,
        request: one.request,
        raw: one.raw,
        output: { motion_prompt: one.motion_prompt, parsed_ok: one.parsed_ok },
        timing: { started_at: new Date(t0).toISOString(), ended_at: nowIso(), duration_ms: Date.now() - t0 },
        error: null,
      },
    });

    let finalMotionPrompt = safeStr(one.motion_prompt, "");

    if (!finalMotionPrompt) {
      finalMotionPrompt = safeStr(feedbackMotion, "") || safeStr(prevMotionPrompt, "");
    }

    if (!finalMotionPrompt && pricing.flow !== "fabric_audio") {
      throw new Error("EMPTY_MOTION_TWEAK_PROMPT_ONE_SHOT");
    }

    working.prompts = { ...(working.prompts || {}), motion_prompt: finalMotionPrompt };
    working.inputs = { ...(working.inputs || {}), start_image_url: startImage };
    if (endImage) working.inputs.end_image_url = endImage;

    await updateVars({ supabase, generationId, vars: working });

    await updateStatus({ supabase, generationId, status: "generating" });
    emitStatus(generationId, "generating");

    chatter = startMinaChatter({
      supabase,
      generationId,
      getVars: () => working,
      setVars: (v) => {
        working = v;
      },
      stage: "generating",
      intervalMs: 2600,
    });

    const duration =
      Number(
        working?.inputs?.duration ??
          parentVars?.inputs?.duration ??
          cfg?.kling?.duration ??
          process.env.MMA_KLING_DURATION ??
          5
      ) || 5;

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

    const mergedInputsAudio = { ...(parentVars?.inputs || {}), ...(working?.inputs || {}) };

    const generateAudioRaw =
      mergedInputsAudio?.generate_audio ??
      mergedInputsAudio?.generateAudio ??
      mergedInputsAudio?.audio_enabled ??
      mergedInputsAudio?.audioEnabled ??
      mergedInputsAudio?.with_audio ??
      mergedInputsAudio?.withAudio;

    const muteRaw = mergedInputsAudio?.mute ?? mergedInputsAudio?.muted;

    let generateAudio =
      generateAudioRaw !== undefined ? !!generateAudioRaw :
      muteRaw !== undefined ? !Boolean(muteRaw) :
      true;

    if (asHttpUrl(endImage)) generateAudio = false;

    let genRes;
    let stepType = "kling_generate_tweak";
    try {
      if (pricing.flow === "kling_motion_control") {
        if (!frame2?.url) throw new Error("MISSING_FRAME2_VIDEO_URL");

        genRes = await runKlingMotionControl({
          prompt: finalMotionPrompt,
          image: startImage,
          video: frame2.url,
          mode: safeStr(mergedInputs0?.mode || mergedInputs0?.kmc_mode, "") || "std",
          keepOriginalSound: mergedInputs0?.keep_original_sound ?? mergedInputs0?.keepOriginalSound ?? true,
          characterOrientation:
            safeStr(mergedInputs0?.character_orientation || mergedInputs0?.characterOrientation, "") || "video",
        });

        stepType = "kling_motion_control_generate_tweak";
      } else if (pricing.flow === "fabric_audio") {
        if (!frame2?.url) throw new Error("MISSING_FRAME2_AUDIO_URL");

        genRes = await runFabricAudio({
          image: startImage,
          audio: frame2.url,
          resolution: safeStr(mergedInputs0?.resolution || mergedInputs0?.fabric_resolution, "") || "720p",
        });

        stepType = "fabric_generate_tweak";
      } else {
        genRes = await runKling({
          prompt: finalMotionPrompt,
          startImage,
          endImage,
          duration,
          mode,
          negativePrompt: neg,
          generateAudio,
        });

        stepType = "kling_generate_tweak";
      }
    } finally {
      try {
        chatter?.stop?.();
      } catch {}
      chatter = null;
    }

    const { input, out, timing } = genRes;

    await writeStep({
      supabase,
      generationId,
      passId,
      stepNo: stepNo++,
      stepType,
      payload: { input, output: out, timing, error: null },
    });

    const remote = pickFirstUrl(out);
    if (!remote) throw new Error("KLING_NO_URL_TWEAK");

    const remoteUrl = await storeRemoteToR2Public(remote, `mma/video/${generationId}`);

    working.outputs = { ...(working.outputs || {}) };
    working.outputs.kling_video_url = remoteUrl;
    working.mg_output_url = remoteUrl;

    working = pushUserMessageLine(working, pick(MMA_UI.quickLines.saved_video));
    await updateVars({ supabase, generationId, vars: working });
    emitLine(generationId, working);

    await finalizeGeneration({ supabase, generationId, url: remoteUrl, prompt: finalMotionPrompt });

    await updateStatus({ supabase, generationId, status: "done" });
    emitStatus(generationId, "done");
    sendDone(generationId, "done");
  } catch (err) {
    try {
      chatter?.stop?.();
    } catch {}
    chatter = null;

    console.error("[mma] video tweak pipeline error", err);

    await updateStatus({ supabase, generationId, status: "error" });
    await supabase
      .from("mega_generations")
      .update({
        mg_error: {
          code: "PIPELINE_ERROR",
          message: err?.message || String(err || ""),
          provider: err?.provider || null,
        },
        mg_updated_at: nowIso(),
      })
      .eq("mg_generation_id", generationId)
      .eq("mg_record_type", "generation");

    try {
      await refundOnFailure({ supabase, passId, generationId, cost: videoCost, err });
    } catch (e) {
      console.warn("[mma] refund failed (video tweak)", e?.message || e);
    }

    emitStatus(generationId, "error");
    sendDone(generationId, "error");
  }
}

// ============================================================================
// Handlers / Queries
// ============================================================================
async function handleMmaCreate({ mode, body }) {
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

  const parentId = body?.parent_generation_id || body?.parentGenerationId || body?.generation_id || null;

  const inputs = (body?.inputs && typeof body.inputs === "object") ? body.inputs : {};
  const suggestOnly = inputs.suggest_only === true || inputs.suggestOnly === true;
  const typeForMe =
    inputs.type_for_me === true ||
    inputs.typeForMe === true ||
    inputs.use_suggestion === true ||
    inputs.useSuggestion === true;

  if (mode === "video" && suggestOnly && typeForMe) {
    await preflightTypeForMe({ supabase, passId });
  } else if (mode === "video") {
    const neededVideo = videoCostFromInputs(body?.inputs || {}, body?.assets || {});
    await ensureEnoughCredits(passId, neededVideo, { lane: "video" });
  } else {
    const requestedLane = resolveStillLaneFromInputs(body?.inputs || {});
    const stillCost = stillCostForLane(requestedLane);
    await ensureEnoughCredits(passId, stillCost, { lane: requestedLane });
  }

  const generationId = newUuid();

  const { preferences } = await ensureCustomerRow(supabase, passId, {
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

  const parent = parentId ? await fetchParentGenerationRow(supabase, parentId).catch(() => null) : null;

  const sessionId =
    safeStr(body?.sessionId || body?.session_id || body?.inputs?.sessionId || body?.inputs?.session_id, "") ||
    safeStr(parent?.mg_session_id, "") ||
    newUuid();

  const platform = safeStr(body?.platform || body?.inputs?.platform, "") || safeStr(parent?.mg_platform, "") || "web";

  const title =
    safeStr(body?.title || body?.inputs?.title, "") ||
    safeStr(parent?.mg_title, "") ||
    (mode === "video" ? "Video session" : "Image session");

  vars.inputs = { ...(vars.inputs || {}), session_id: sessionId, platform, title };
  vars.meta = { ...(vars.meta || {}), session_id: sessionId, platform, title };

  await ensureSessionForHistory({
    passId,
    sessionId,
    platform,
    title,
    meta: { source: "mma", flow: mode === "video" ? "video_animate" : "still_create" },
  });

  await writeGeneration({ supabase, generationId, parentId, passId, vars, mode });

  if (mode === "still") {
    vars.meta = { ...(vars.meta || {}), flow: "still_create" };
    await updateVars({ supabase, generationId, vars });

    runStillCreatePipeline({ supabase, generationId, passId, vars, preferences }).catch((err) =>
      console.error("[mma] still create pipeline error", err)
    );
  } else if (mode === "video") {
    vars.meta = { ...(vars.meta || {}), flow: "video_animate", parent_generation_id: parentId || null };

    if (parent?.mg_output_url) {
      vars.inputs = { ...(vars.inputs || {}), parent_output_url: parent.mg_output_url };
    }

    await updateVars({ supabase, generationId, vars });

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

async function handleMmaStillTweak({ parentGenerationId, body }) {
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

  const requestedLane = resolveStillLaneFromInputs(body?.inputs || {});
  const stillCost = stillCostForLane(requestedLane);
  await ensureEnoughCredits(passId, stillCost, { lane: requestedLane });

  const generationId = newUuid();

  const { preferences } = await ensureCustomerRow(supabase, passId, {
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

  const sessionId =
    safeStr(body?.sessionId || body?.session_id || body?.inputs?.sessionId || body?.inputs?.session_id, "") ||
    safeStr(parent?.mg_session_id, "") ||
    newUuid();

  const platform = safeStr(body?.platform || body?.inputs?.platform, "") || safeStr(parent?.mg_platform, "") || "web";
  const title = safeStr(body?.title || body?.inputs?.title, "") || safeStr(parent?.mg_title, "") || "Image session";

  vars.inputs = { ...(vars.inputs || {}), session_id: sessionId, platform, title };
  vars.meta = { ...(vars.meta || {}), session_id: sessionId, platform, title };

  await ensureSessionForHistory({
    passId,
    sessionId,
    platform,
    title,
    meta: { source: "mma", flow: "still_tweak" },
  });

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

  runStillTweakPipeline({ supabase, generationId, passId, parent, vars, preferences }).catch((e) =>
    console.error("[mma] still tweak pipeline error", e)
  );

  return { generation_id: generationId, status: "queued", sse_url: `/mma/stream/${generationId}` };
}

async function handleMmaVideoTweak({ parentGenerationId, body }) {
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

  const parentVars = parent?.mg_mma_vars && typeof parent.mg_mma_vars === "object" ? parent.mg_mma_vars : {};
  const mergedInputs0 = { ...(parentVars?.inputs || {}), ...(body?.inputs || {}) };
  const mergedAssets0 = { ...(parentVars?.assets || {}), ...(body?.assets || {}) };

  const needed = videoCostFromInputs(mergedInputs0, mergedAssets0);
  await ensureEnoughCredits(passId, needed, { lane: "video" });

  const generationId = newUuid();

  await ensureCustomerRow(supabase, passId, {
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

  const sessionId =
    safeStr(body?.sessionId || body?.session_id || body?.inputs?.sessionId || body?.inputs?.session_id, "") ||
    safeStr(parent?.mg_session_id, "") ||
    newUuid();

  const platform = safeStr(body?.platform || body?.inputs?.platform, "") || safeStr(parent?.mg_platform, "") || "web";
  const title = safeStr(body?.title || body?.inputs?.title, "") || safeStr(parent?.mg_title, "") || "Video session";

  vars.inputs = { ...(vars.inputs || {}), session_id: sessionId, platform, title };
  vars.meta = { ...(vars.meta || {}), session_id: sessionId, platform, title };

  await ensureSessionForHistory({
    passId,
    sessionId,
    platform,
    title,
    meta: { source: "mma", flow: "video_tweak" },
  });

  vars.meta = { ...(vars.meta || {}), flow: "video_tweak", parent_generation_id: parentGenerationId };
  vars.inputs = { ...(vars.inputs || {}), parent_generation_id: parentGenerationId };

  const parentStart = asHttpUrl(parentVars?.inputs?.start_image_url || parentVars?.inputs?.startImageUrl);
  const parentEnd = asHttpUrl(parentVars?.inputs?.end_image_url || parentVars?.inputs?.endImageUrl);

  if (parentStart) vars.inputs.start_image_url = parentStart;
  if (parentEnd) vars.inputs.end_image_url = parentEnd;

  await writeGeneration({
    supabase,
    generationId,
    parentId: parentGenerationId,
    passId,
    vars,
    mode: "video",
  });

  runVideoTweakPipeline({ supabase, generationId, passId, parent, vars }).catch((err) => {
    console.error("[mma] video tweak pipeline error", err);
  });

  return { generation_id: generationId, status: "queued", sse_url: `/mma/stream/${generationId}` };
}

async function handleMmaEvent(body) {
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

  await ensureCustomerRow(supabase, passId, {
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

async function refreshFromReplicate({ generationId, passId }) {
  const supabase = getSupabaseAdmin();
  if (!supabase) throw new Error("SUPABASE_NOT_CONFIGURED");

  const { data, error } = await supabase
    .from("mega_generations")
    .select("mg_pass_id, mg_mma_mode, mg_output_url, mg_prompt, mg_mma_vars")
    .eq("mg_generation_id", generationId)
    .eq("mg_record_type", "generation")
    .maybeSingle();

  if (error) throw error;
  if (!data) return { ok: false, error: "NOT_FOUND" };

  if (passId && data.mg_pass_id && String(passId) !== String(data.mg_pass_id)) {
    return { ok: false, error: "FORBIDDEN" };
  }

  if (data.mg_output_url) {
    return { ok: true, refreshed: false, alreadyDone: true, url: data.mg_output_url };
  }

  const vars = data.mg_mma_vars && typeof data.mg_mma_vars === "object" ? data.mg_mma_vars : {};
  const mode = String(data.mg_mma_mode || "");
  const outputs = vars.outputs && typeof vars.outputs === "object" ? vars.outputs : {};

  const predictionId =
    mode === "video"
      ? outputs.kling_motion_control_prediction_id ||
        outputs.klingMotionControlPredictionId ||
        outputs.fabric_prediction_id ||
        outputs.fabricPredictionId ||
        outputs.kling_prediction_id ||
        outputs.klingPredictionId ||
        ""
      : outputs.nanobanana_prediction_id ||
        outputs.nanobananaPredictionId ||
        outputs.seedream_prediction_id ||
        outputs.seedreamPredictionId ||
        "";

  if (!predictionId) {
    return { ok: false, error: "NO_PREDICTION_ID" };
  }

  const replicate = getReplicate();
  const pred = await replicate.predictions.get(String(predictionId));
  const providerStatus = pred?.status || null;

  const url = pickFirstUrl(pred?.output);
  if (!url) {
    return { ok: true, refreshed: false, provider_status: providerStatus };
  }

  const remoteUrl = await storeRemoteToR2Public(
    url,
    mode === "video" ? `mma/video/${generationId}` : `mma/still/${generationId}`
  );

  const nextVars = { ...vars, mg_output_url: remoteUrl };
  nextVars.outputs = { ...(nextVars.outputs || {}) };
  if (mode === "video") {
    nextVars.outputs.kling_video_url = remoteUrl;
  } else {
    if (outputs.nanobanana_prediction_id || outputs.nanobananaPredictionId) {
      nextVars.outputs.nanobanana_image_url = remoteUrl;
    } else {
      nextVars.outputs.seedream_image_url = remoteUrl;
    }
  }

  await supabase
    .from("mega_generations")
    .update({
      mg_output_url: remoteUrl,
      mg_status: "done",
      mg_mma_status: "done",
      mg_mma_vars: nextVars,
      mg_updated_at: nowIso(),
    })
    .eq("mg_generation_id", generationId)
    .eq("mg_record_type", "generation");

  return { ok: true, refreshed: true, provider_status: providerStatus, url: remoteUrl };
}

async function fetchGeneration(generationId) {
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

  const internal = data.mg_mma_status || data.mg_status || "queued";

  const vars = data.mg_mma_vars && typeof data.mg_mma_vars === "object" ? data.mg_mma_vars : {};
  const vOut = vars.outputs && typeof vars.outputs === "object" ? vars.outputs : {};
  const meta = vars.meta && typeof vars.meta === "object" ? vars.meta : {};

  const stillEngine =
    safeStr(meta.still_engine, "") ||
    (vOut.nanobanana_image_url || vOut.nanobanana_prediction_id ? "nanobanana" : "seedream");

  return {
    generation_id: data.mg_generation_id,
    status: toUserStatus(internal),
    state: internal,

    mma_vars: vars,
    still_engine: data.mg_mma_mode === "still" ? stillEngine : null,

    outputs: {
      seedream_image_url:
        data.mg_mma_mode === "still" && stillEngine === "seedream" ? data.mg_output_url : null,
      nanobanana_image_url:
        data.mg_mma_mode === "still" && stillEngine === "nanobanana" ? data.mg_output_url : null,
      kling_video_url: data.mg_mma_mode === "video" ? data.mg_output_url : null,
    },

    prompt: data.mg_prompt || null,
    error: data.mg_error || null,
  };
}

async function listSteps(generationId) {
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

async function listErrors() {
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

function registerSseClient(generationId, res, initial) {
  addSseClient(generationId, res, initial);
}

function sendMmaEndpointError(res, err, { logLabel, fallbackCode }) {
  if (logLabel) console.error(logLabel, err);
  const status = err?.statusCode || 500;
  const error =
    err?.message === "INSUFFICIENT_CREDITS" ? "INSUFFICIENT_CREDITS" : fallbackCode;

  res.status(status).json({
    error,
    message: err?.message,
    details: err?.details || undefined,
  });
}

function sendSimpleError(res, err, { logLabel, code, status = 500, ok } = {}) {
  if (logLabel) console.error(logLabel, err);
  const payload = { error: code, message: err?.message };
  if (typeof ok === "boolean") payload.ok = ok;
  res.status(status).json(payload);
}

// ============================================================================
// Routers
// ============================================================================
function createMmaRouter() {
  const router = express.Router();

  function withPassId(req, rawBody) {
    const body = rawBody && typeof rawBody === "object" ? rawBody : {};
    const passId = resolvePassId(req, body);
    return { passId, body: { ...body, passId } };
  }

  router.post("/still/create", async (req, res) => {
    const { passId, body } = withPassId(req, req.body);

    try {
      setPassIdHeader(res, passId);
      const result = await handleMmaCreate({ mode: "still", body });
      res.json(result);
    } catch (err) {
      sendMmaEndpointError(res, err, {
        logLabel: "[mma] still/create error",
        fallbackCode: "MMA_CREATE_FAILED",
      });
    }
  });

  router.post("/still/:generation_id/tweak", async (req, res) => {
    const { passId, body } = withPassId(req, req.body);

    try {
      setPassIdHeader(res, passId);
      const result = await handleMmaStillTweak({
        parentGenerationId: req.params.generation_id,
        body,
      });
      res.json(result);
    } catch (err) {
      sendMmaEndpointError(res, err, {
        logLabel: "[mma] still tweak error",
        fallbackCode: "MMA_TWEAK_FAILED",
      });
    }
  });

  router.post("/video/animate", async (req, res) => {
    const { passId, body } = withPassId(req, req.body);

    try {
      setPassIdHeader(res, passId);
      const result = await handleMmaCreate({ mode: "video", body });
      res.json(result);
    } catch (err) {
      sendMmaEndpointError(res, err, {
        logLabel: "[mma] video/animate error",
        fallbackCode: "MMA_ANIMATE_FAILED",
      });
    }
  });

  router.post("/video/:generation_id/tweak", async (req, res) => {
    const { passId, body } = withPassId(req, req.body);

    try {
      setPassIdHeader(res, passId);
      const result = await handleMmaVideoTweak({
        parentGenerationId: req.params.generation_id,
        body,
      });
      res.json(result);
    } catch (err) {
      sendMmaEndpointError(res, err, {
        logLabel: "[mma] video tweak error",
        fallbackCode: "MMA_VIDEO_TWEAK_FAILED",
      });
    }
  });

  router.post("/events", async (req, res) => {
    const { passId, body } = withPassId(req, req.body);

    try {
      setPassIdHeader(res, passId);
      const result = await handleMmaEvent(body || {});
      res.json(result);
    } catch (err) {
      sendSimpleError(res, err, {
        logLabel: "[mma] events error",
        code: "MMA_EVENT_FAILED",
      });
    }
  });

  router.post("/generations/:generation_id/refresh", async (req, res) => {
    try {
      const body = req.body || {};
      const passId = resolvePassId(req, body);
      setPassIdHeader(res, passId);

      await megaEnsureCustomer({ passId });

      const out = await refreshFromReplicate({
        generationId: req.params.generation_id,
        passId,
      });

      res.json(out);
    } catch (err) {
      sendSimpleError(res, err, {
        logLabel: "[mma] refresh error",
        code: "REFRESH_FAILED",
        ok: false,
      });
    }
  });

  router.get("/generations/:generation_id", async (req, res) => {
    try {
      const payload = await fetchGeneration(req.params.generation_id);
      if (!payload) return res.status(404).json({ error: "NOT_FOUND" });
      res.json(payload);
    } catch (err) {
      sendSimpleError(res, err, {
        logLabel: "[mma] fetch generation error",
        code: "MMA_FETCH_FAILED",
      });
    }
  });

  router.get("/stream/:generation_id", async (req, res) => {
    try {
      const supabase = getSupabaseAdmin();
      if (!supabase) return res.status(500).end();

      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      res.flushHeaders?.();

      const { data, error } = await supabase
        .from("mega_generations")
        .select("mg_mma_vars, mg_mma_status")
        .eq("mg_generation_id", req.params.generation_id)
        .eq("mg_record_type", "generation")
        .maybeSingle();

      if (error || !data) {
        try {
          res.write(`event: error\ndata: ${JSON.stringify({ error: "SSE_BOOTSTRAP_FAILED" })}\n\n`);
        } catch {}
        return res.end();
      }

      const scanLines = data?.mg_mma_vars?.userMessages?.scan_lines || [];
      const internal = String(data?.mg_mma_status || "queued");

      registerSseClient(req.params.generation_id, res, { scanLines, status: internal });

      const terminal = new Set(["done", "error", "suggested"]);
      if (terminal.has(internal)) {
        try {
          sendStatus(req.params.generation_id, internal);
          sendDone(req.params.generation_id, internal);
        } catch {}
        try {
          res.end();
        } catch {}
        return;
      }

      const keepAlive = setInterval(() => {
        try {
          res.write(`:keepalive\n\n`);
        } catch {}
      }, 25000);

      res.on("close", () => clearInterval(keepAlive));
    } catch (err) {
      console.error("[mma] stream error", err);
      try {
        res.status(500).end();
      } catch {}
    }
  });

  router.get("/admin/errors", async (_req, res) => {
    try {
      const errors = await listErrors();
      res.json({ errors });
    } catch (err) {
      sendSimpleError(res, err, { code: "MMA_ADMIN_ERRORS" });
    }
  });

  router.get("/admin/steps/:generation_id", async (req, res) => {
    try {
      const steps = await listSteps(req.params.generation_id);
      res.json({ steps });
    } catch (err) {
      sendSimpleError(res, err, { code: "MMA_ADMIN_STEPS" });
    }
  });

  return router;
}

function createMmaController() {
  return createMmaRouter();
}

function createMmaLogAdminRouter() {
  const router = express.Router();

  const PASSWORD = process.env.MMA_LOGADMIN_PASSWORD || "Falta101M";
  const COOKIE_SECRET =
    process.env.MMA_LOGADMIN_COOKIE_SECRET ||
    process.env.COOKIE_SECRET ||
    "dev_insecure_change_me";

  const COOKIE_NAME = "mma_logadmin";

  router.use(express.urlencoded({ extended: false }));

  function isHttps(req) {
    const xf = String(req.headers["x-forwarded-proto"] || "").toLowerCase();
    return req.secure || xf === "https";
  }

  function escapeHtml(s) {
    return String(s || "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function prettyJson(obj) {
    try {
      return JSON.stringify(obj, null, 2);
    } catch {
      return String(obj || "");
    }
  }

  function hmacSha256(secret, data) {
    return crypto.createHmac("sha256", secret).update(data).digest("hex");
  }

  function signToken(payloadObj) {
    const payloadJson = JSON.stringify(payloadObj);
    const payloadB64 = Buffer.from(payloadJson, "utf8").toString("base64url");
    const sig = hmacSha256(COOKIE_SECRET, payloadB64);
    return `${payloadB64}.${sig}`;
  }

  function verifyToken(token) {
    if (!token || typeof token !== "string") return null;
    const parts = token.split(".");
    if (parts.length !== 2) return null;

    const [payloadB64, sig] = parts;
    const expected = hmacSha256(COOKIE_SECRET, payloadB64);
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;

    try {
      const json = Buffer.from(payloadB64, "base64url").toString("utf8");
      const payload = JSON.parse(json);
      if (!payload || typeof payload !== "object") return null;
      if (typeof payload.exp !== "number") return null;
      if (Date.now() > payload.exp) return null;
      return payload;
    } catch {
      return null;
    }
  }

  function getCookie(req, name) {
    const raw = req.headers.cookie || "";
    const parts = raw.split(";").map((p) => p.trim());
    for (const p of parts) {
      const idx = p.indexOf("=");
      if (idx <= 0) continue;
      const k = p.slice(0, idx).trim();
      const v = p.slice(idx + 1).trim();
      if (k === name) return decodeURIComponent(v);
    }
    return null;
  }

  function setAuthCookie(res, req) {
    const token = signToken({
      v: 1,
      exp: Date.now() + 1000 * 60 * 60 * 12,
    });

    const flags = [
      `${COOKIE_NAME}=${encodeURIComponent(token)}`,
      "Path=/",
      "HttpOnly",
      "SameSite=Lax",
    ];
    if (isHttps(req)) flags.push("Secure");

    res.setHeader("Set-Cookie", flags.join("; "));
  }

  function clearAuthCookie(res) {
    res.setHeader(
      "Set-Cookie",
      `${COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`
    );
  }

  function isAuthed(req) {
    const token = getCookie(req, COOKIE_NAME);
    return !!verifyToken(token);
  }

  function requireAuth(req, res, next) {
    if (isAuthed(req)) return next();
    return res.redirect("/admin/mma/login");
  }

  function layout(title, bodyHtml) {
    return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <style>
    body { font-family: ui-sans-serif, system-ui, -apple-system; margin: 24px; color: #111; }
    .topbar { display:flex; gap:12px; align-items:center; justify-content:space-between; margin-bottom:16px; }
    .btn { border:1px solid #ddd; background:#fff; padding:8px 12px; border-radius:10px; cursor:pointer; }
    .btn:hover { background:#f7f7f7; }
    .muted { color:#666; }
    table { width:100%; border-collapse: collapse; }
    th, td { border-bottom: 1px solid #eee; padding: 10px 8px; vertical-align: top; }
    th { text-align:left; font-size:12px; color:#666; }
    .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size:12px; white-space: pre-wrap; }
    .tag { display:inline-block; padding:2px 8px; border-radius:999px; font-size:12px; border:1px solid #ddd; }
    .bad { border-color:#ffb3b3; background:#fff5f5; }
    details { border:1px solid #eee; border-radius:12px; padding:10px; margin:10px 0; }
    summary { cursor:pointer; font-weight:600; }
    .row { display:flex; gap:16px; flex-wrap:wrap; }
    .card { border:1px solid #eee; border-radius:12px; padding:12px; min-width:320px; flex:1; }
    input[type="text"], input[type="password"] { padding:10px; border:1px solid #ddd; border-radius:10px; width: 320px; }
    .err { color:#b00020; }
    a { color:#0b57d0; text-decoration:none; }
    a:hover { text-decoration:underline; }
  </style>
</head>
<body>
${bodyHtml}
</body>
</html>`;
  }

  router.get("/login", (req, res) => {
    const err = req.query.err ? String(req.query.err) : "";
    const html = layout(
      "MMA LogAdmin Login",
      `
    <div class="topbar">
      <h2>MMA LogAdmin</h2>
      <div class="muted">Backend: mina-editorial-ai-api</div>
    </div>

    <form method="POST" action="/admin/mma/login">
      <div style="margin:12px 0;">
        <label class="muted">Password</label><br/>
        <input type="password" name="password" placeholder="Password" />
      </div>
      ${err ? `<div class="err">${escapeHtml(err)}</div>` : ""}
      <button class="btn" type="submit">Login</button>
    </form>
  `
    );
    res.status(200).send(html);
  });

  router.post("/login", (req, res) => {
    const pw = String(req.body?.password || "");
    if (pw !== PASSWORD) return res.redirect("/admin/mma/login?err=Wrong%20password");
    setAuthCookie(res, req);
    return res.redirect("/admin/mma");
  });

  router.post("/logout", (req, res) => {
    clearAuthCookie(res);
    return res.redirect("/admin/mma/login");
  });

  router.get("/", requireAuth, async (req, res) => {
    const supabase = getSupabaseAdmin();
    if (!supabase) {
      return res.status(500).send(layout("Error", `<div class="err">SUPABASE_NOT_CONFIGURED</div>`));
    }

    const passId = (req.query.passId ? String(req.query.passId) : "").trim();
    const limit = Math.max(1, Math.min(200, Number(req.query.limit || 50) || 50));

    let q = supabase
      .from("mega_generations")
      .select(
        "mg_generation_id, mg_pass_id, mg_parent_id, mg_mma_mode, mg_mma_status, mg_status, mg_output_url, mg_prompt, mg_created_at"
      )
      .eq("mg_record_type", "generation")
      .order("mg_created_at", { ascending: false })
      .limit(limit);

    if (passId) q = q.eq("mg_pass_id", passId);

    const { data, error } = await q;
    if (error) {
      return res.status(500).send(layout("Error", `<div class="err">${escapeHtml(error.message)}</div>`));
    }

    const rows = (data || []).map((g) => {
      const gid = g.mg_generation_id;
      const status = g.mg_mma_status || g.mg_status || "-";
      const mode = g.mg_mma_mode || "-";
      const out = g.mg_output_url || "";
      const badUrl =
        out && !String(out).includes("assets.faltastudio.com") && !String(out).includes("r2") ? "bad" : "";

      return `
      <tr>
        <td class="mono">${escapeHtml(g.mg_created_at || "")}</td>
        <td><span class="tag">${escapeHtml(status)}</span></td>
        <td><span class="tag">${escapeHtml(mode)}</span></td>
        <td class="mono">${escapeHtml(g.mg_pass_id || "")}</td>
        <td class="mono">${escapeHtml(g.mg_parent_id || "")}</td>
        <td class="mono ${badUrl}">
          ${out ? `<a href="${escapeHtml(out)}" target="_blank" rel="noreferrer">${escapeHtml(out)}</a>` : "-"}
          ${badUrl ? `<div class="muted">! not assets.faltastudio.com</div>` : ""}
        </td>
        <td class="mono">${escapeHtml(String(g.mg_prompt || "").slice(0, 160))}${String(g.mg_prompt || "").length > 160 ? "..." : ""}</td>
        <td><a href="/admin/mma/generation/${encodeURIComponent(gid)}">Open</a></td>
      </tr>
    `;
    });

    const html = layout(
      "MMA LogAdmin",
      `
    <div class="topbar">
      <div>
        <h2 style="margin:0;">MMA LogAdmin</h2>
        <div class="muted">Shows: inputs -> GPT prompts -> Replicate -> R2 output -> final</div>
      </div>
      <form method="POST" action="/admin/mma/logout">
        <button class="btn" type="submit">Logout</button>
      </form>
    </div>

    <form method="GET" action="/admin/mma" style="margin: 0 0 16px 0;">
      <input type="text" name="passId" value="${escapeHtml(passId)}" placeholder="Filter by passId (optional)" />
      <input type="text" name="limit" value="${escapeHtml(String(limit))}" style="width:90px;" />
      <button class="btn" type="submit">Apply</button>
      <a class="btn" href="/admin/mma" style="display:inline-block;">Reset</a>
    </form>

    <table>
      <thead>
        <tr>
          <th>Created</th>
          <th>Status</th>
          <th>Mode</th>
          <th>Pass</th>
          <th>Parent</th>
          <th>Output URL</th>
          <th>Prompt (snippet)</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        ${rows.join("\n")}
      </tbody>
    </table>
  `
    );

    res.status(200).send(html);
  });

  router.get("/generation/:id", requireAuth, async (req, res) => {
    const supabase = getSupabaseAdmin();
    if (!supabase) {
      return res.status(500).send(layout("Error", `<div class="err">SUPABASE_NOT_CONFIGURED</div>`));
    }

    const id = String(req.params.id || "").trim();
    if (!id) return res.redirect("/admin/mma");

    const { data: gen, error: genErr } = await supabase
      .from("mega_generations")
      .select("*")
      .eq("mg_record_type", "generation")
      .eq("mg_generation_id", id)
      .maybeSingle();

    if (genErr || !gen) {
      return res.status(404).send(layout("Not found", `<div class="err">Generation not found.</div>`));
    }

    const { data: steps, error: stepsErr } = await supabase
      .from("mega_generations")
      .select("mg_step_no, mg_step_type, mg_payload, mg_created_at")
      .eq("mg_record_type", "mma_step")
      .eq("mg_generation_id", id)
      .order("mg_step_no", { ascending: true });

    if (stepsErr) {
      return res.status(500).send(layout("Error", `<div class="err">${escapeHtml(stepsErr.message)}</div>`));
    }

    const cfg = getMmaConfig();
    const vars = gen.mg_mma_vars || {};

    const stepsRows = (steps || []).map((s) => {
      const p = s.mg_payload || {};
      const timing = p?.timing || {};
      const started = timing.started_at || "";
      const ended = timing.ended_at || "";
      const dur = timing.duration_ms != null ? `${timing.duration_ms}ms` : "";
      return `
      <tr>
        <td class="mono">${escapeHtml(String(s.mg_step_no ?? ""))}</td>
        <td class="mono">${escapeHtml(s.mg_step_type || "")}</td>
        <td class="mono">${escapeHtml(started)}</td>
        <td class="mono">${escapeHtml(ended)}</td>
        <td class="mono">${escapeHtml(dur)}</td>
        <td>
          <details>
            <summary>View payload</summary>
            <pre class="mono">${escapeHtml(prettyJson(p))}</pre>
          </details>
        </td>
      </tr>
    `;
    });

    const out = String(gen.mg_output_url || "");
    const badUrl =
      out && !out.includes("assets.faltastudio.com") && !out.includes("r2") ? "bad" : "";

    const html = layout(
      `MMA Generation ${id}`,
      `
    <div class="topbar">
      <div>
        <a href="/admin/mma"><- Back</a>
        <h2 style="margin:8px 0 0 0;">Generation: <span class="mono">${escapeHtml(id)}</span></h2>
        <div class="muted">Pass: <span class="mono">${escapeHtml(gen.mg_pass_id || "")}</span></div>
      </div>
      <div style="display:flex; gap:10px;">
        <a class="btn" href="/admin/mma/generation/${encodeURIComponent(id)}.json">Download JSON</a>
        <form method="POST" action="/admin/mma/logout" style="margin:0;">
          <button class="btn" type="submit">Logout</button>
        </form>
      </div>
    </div>

    <div class="row">
      <div class="card">
        <div><b>Status:</b> <span class="tag">${escapeHtml(gen.mg_mma_status || gen.mg_status || "-")}</span></div>
        <div><b>Mode:</b> <span class="tag">${escapeHtml(gen.mg_mma_mode || "-")}</span></div>
        <div><b>Created:</b> <span class="mono">${escapeHtml(gen.mg_created_at || "")}</span></div>
        <div><b>Parent:</b> <span class="mono">${escapeHtml(gen.mg_parent_id || "")}</span></div>
        <div style="margin-top:10px;"><b>Output URL:</b></div>
        <div class="mono ${badUrl}">
          ${out ? `<a href="${escapeHtml(out)}" target="_blank" rel="noreferrer">${escapeHtml(out)}</a>` : "-"}
          ${badUrl ? `<div class="muted">! not assets.faltastudio.com (check R2_PUBLIC_BASE_URL)</div>` : ""}
        </div>
        ${gen.mg_error ? `<details><summary>Error</summary><pre class="mono">${escapeHtml(prettyJson(gen.mg_error))}</pre></details>` : ""}
      </div>

      <div class="card">
        <div><b>Final prompt</b></div>
        <pre class="mono">${escapeHtml(gen.mg_prompt || "")}</pre>
      </div>
    </div>

    <details open>
      <summary>MMA Vars (inputs/assets/settings/prompts/outputs)</summary>
      <pre class="mono">${escapeHtml(prettyJson(vars))}</pre>
    </details>

    <details>
      <summary>MMA Config snapshot (current runtime)</summary>
      <pre class="mono">${escapeHtml(prettyJson(cfg))}</pre>
    </details>

    <h3>Steps</h3>
    <table>
      <thead>
        <tr>
          <th>#</th>
          <th>Type</th>
          <th>Started</th>
          <th>Ended</th>
          <th>Duration</th>
          <th>Payload</th>
        </tr>
      </thead>
      <tbody>
        ${stepsRows.join("\n")}
      </tbody>
    </table>
  `
    );

    res.status(200).send(html);
  });

  router.get("/generation/:id.json", requireAuth, async (req, res) => {
    const supabase = getSupabaseAdmin();
    const id = String(req.params.id || "").trim();
    if (!supabase) return res.status(500).json({ ok: false, error: "SUPABASE_NOT_CONFIGURED" });

    const { data: gen } = await supabase
      .from("mega_generations")
      .select("*")
      .eq("mg_record_type", "generation")
      .eq("mg_generation_id", id)
      .maybeSingle();

    const { data: steps } = await supabase
      .from("mega_generations")
      .select("mg_step_no, mg_step_type, mg_payload, mg_created_at")
      .eq("mg_record_type", "mma_step")
      .eq("mg_generation_id", id)
      .order("mg_step_no", { ascending: true });

    const cfg = getMmaConfig();
    return res.json({ ok: true, generation: gen || null, steps: steps || [], mma_config: cfg });
  });

  return router;
}

function registerMmaRoutes(app) {
  const mmaRouter = createMmaRouter();
  const mmaLogAdminRouter = createMmaLogAdminRouter();

  app.use("/mma", async (req, res, next) => {
    try {
      if (req.method !== "POST") return next();

      const resolved = resolvePassId(req, req.body || {});
      const passId = normalizeIncomingPassId(resolved);
      setPassIdHeader(res, passId);

      req.body = req.body || {};
      if (!req.body.passId) req.body.passId = passId;
      if (!req.body.pass_id) req.body.pass_id = passId;

      if (sbEnabled()) {
        const authUser = await getAuthUser(req);
        await megaEnsureCustomer({
          passId,
          userId: authUser?.userId || null,
          email: authUser?.email || null,
        });
      }

      return next();
    } catch (e) {
      console.error("[mma passId middleware] failed", e);
      return res.status(500).json({
        ok: false,
        error: "MMA_PASSID_MW_FAILED",
        message: e?.message || String(e),
      });
    }
  });

  app.use("/mma", mmaRouter);
  app.use("/admin/mma", mmaLogAdminRouter);
}

export {
  registerMmaRoutes,
  createMmaController,
  fetchGeneration,
  handleMmaCreate,
  handleMmaEvent,
  handleMmaStillTweak,
  handleMmaVideoTweak,
  listErrors,
  listSteps,
  refreshFromReplicate,
  registerSseClient,
};

export default createMmaController;

async function runVideoAnimatePipeline({ supabase, generationId, passId, parent, vars }) {
  const cfg = getMmaConfig();
  if (!cfg.enabled) throw new Error("MMA_DISABLED");

  let working = vars;
  let videoCost = 5;
  const ctx = await getMmaCtxConfig(supabase);

  let suggestOnly = false;
  let chatter = null;

  try {
    const inputs0 = (working?.inputs && typeof working.inputs === "object") ? working.inputs : {};
    suggestOnly = inputs0.suggest_only === true || inputs0.suggestOnly === true;

    const typeForMe =
      inputs0.type_for_me === true ||
      inputs0.typeForMe === true ||
      inputs0.use_suggestion === true ||
      inputs0.useSuggestion === true;

    let frame2 = resolveFrame2Reference(inputs0, working?.assets);

    if ((frame2.kind === "ref_video" || frame2.kind === "ref_audio") && !frame2.rawDurationSec) {
      const dur =
        Number(inputs0.frame2_duration_sec || inputs0.frame2DurationSec || 0) ||
        Number(inputs0.duration || inputs0.duration_seconds || inputs0.durationSeconds || 0) ||
        0;

      if (dur > 0) inputs0.frame2_duration_sec = dur;
      frame2 = resolveFrame2Reference(inputs0, working?.assets);
    }

    if (!suggestOnly) {
      videoCost = videoCostFromInputs(inputs0, working?.assets);
      await chargeGeneration({ passId, generationId, cost: videoCost, reason: "mma_video", lane: "video" });
    }

    await updateStatus({ supabase, generationId, status: "prompting" });
    emitStatus(generationId, "prompting");

    working = pushUserMessageLine(working, pick(MMA_UI.quickLines.video_animate_start));
    await updateVars({ supabase, generationId, vars: working });
    emitLine(generationId, working);

    let stepNo = 1;

    const startImage = pickKlingStartImage(working, parent);
    const endImage = pickKlingEndImage(working, parent);
    if (!startImage) throw new Error("MISSING_START_IMAGE_FOR_VIDEO");

    const pricing = resolveVideoPricing(inputs0, working?.assets);
    const flow = pricing.flow;

    working.inputs = { ...(working.inputs || {}), start_image_url: startImage };
    if (endImage) working.inputs.end_image_url = endImage;

    let finalMotionPrompt = "";
    const motionBrief =
      safeStr(
        inputs0.motion_user_brief ||
          inputs0.motionUserBrief ||
          inputs0.brief ||
          inputs0.user_brief ||
          inputs0.userBrief,
        ""
      );

    const movementStyle =
      safeStr(
        inputs0.selected_movement_style ||
          inputs0.selectedMovementStyle ||
          inputs0.movement_style ||
          inputs0.movementStyle,
        ""
      );

    const promptOverride =
      safeStr(
        inputs0.motion_prompt_override ||
          inputs0.motionPromptOverride ||
          inputs0.prompt_override ||
          inputs0.promptOverride,
        ""
      );

    const usePromptOverride = !!promptOverride;

    if (usePromptOverride) {
      await writeStep({
        supabase,
        generationId,
        passId,
        stepNo: stepNo++,
        stepType: "motion_prompt_override",
        payload: {
          source: "frontend",
          flow,
          frame2_kind: frame2?.kind || null,
          frame2_url: frame2?.url || null,
          frame2_duration_sec: frame2?.rawDurationSec || null,
          prompt_override: promptOverride,
          start_image_url: startImage,
          end_image_url: asHttpUrl(endImage) || null,
          motion_user_brief: motionBrief,
          selected_movement_style: movementStyle,
          timing: { started_at: nowIso(), ended_at: nowIso(), duration_ms: 0 },
          error: null,
        },
      });

      finalMotionPrompt = promptOverride;
    } else {
      const oneShotInput = {
        flow,
        frame2_kind: frame2?.kind || null,
        frame2_url: frame2?.url || null,
        frame2_duration_sec: frame2?.rawDurationSec || null,
        start_image_url: startImage,
        end_image_url: asHttpUrl(endImage) || null,
        motion_user_brief: motionBrief,
        selected_movement_style: movementStyle,
        notes:
          "Write ONE clean motion prompt. If audio reference exists, sync motion to beats/phrases. " +
          "If video reference exists, sync motion of the reference while keeping subject consistent. " +
          "Plain English. No emojis. No questions.",
      };

      const labeledImages = []
        .concat([{ role: "START_IMAGE", url: startImage }])
        .concat(endImage ? [{ role: "END_IMAGE", url: endImage }] : [])
        .slice(0, 6);

      const t0 = Date.now();
      const one = await gptMotionOneShotAnimate({ cfg, ctx, input: oneShotInput, labeledImages });

      await writeStep({
        supabase,
        generationId,
        passId,
        stepNo: stepNo++,
        stepType: "gpt_motion_one_shot",
        payload: {
          ctx: ctx.motion_one_shot,
          input: oneShotInput,
          labeledImages,
          request: one.request,
          raw: one.raw,
          output: { motion_prompt: one.motion_prompt, parsed_ok: one.parsed_ok },
          timing: { started_at: new Date(t0).toISOString(), ended_at: nowIso(), duration_ms: Date.now() - t0 },
          error: null,
        },
      });

      finalMotionPrompt =
        safeStr(one.motion_prompt, "") ||
        safeStr(working?.inputs?.motion_prompt, "") ||
        safeStr(working?.inputs?.prompt, "") ||
        safeStr(working?.prompts?.motion_prompt, "");
    }

    if (!finalMotionPrompt) {
      finalMotionPrompt =
        safeStr(motionBrief, "") ||
        safeStr(working?.inputs?.brief, "") ||
        safeStr(working?.inputs?.prompt, "");
    }

    if (!finalMotionPrompt && flow !== "fabric_audio") {
      throw new Error("EMPTY_MOTION_PROMPT");
    }

    working.prompts = { ...(working.prompts || {}), motion_prompt: finalMotionPrompt };
    await updateVars({ supabase, generationId, vars: working });

    if (suggestOnly) {
      await supabase
        .from("mega_generations")
        .update({
          mg_status: "suggested",
          mg_mma_status: "suggested",
          mg_prompt: finalMotionPrompt,
          mg_updated_at: nowIso(),
        })
        .eq("mg_generation_id", generationId)
        .eq("mg_record_type", "generation");

      if (typeForMe) {
        try {
          await commitTypeForMeSuccessAndMaybeCharge({ supabase, passId });
        } catch (e) {
          console.warn("[mma] type-for-me charge failed:", e?.message || e);
        }
      }

      emitStatus(generationId, "suggested");
      sendDone(generationId, "suggested");
      return;
    }

    await updateStatus({ supabase, generationId, status: "generating" });
    emitStatus(generationId, "generating");

    chatter = startMinaChatter({
      supabase,
      generationId,
      getVars: () => working,
      setVars: (v) => {
        working = v;
      },
      stage: "generating",
      intervalMs: 2600,
    });

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

    const generateAudioRaw =
      working?.inputs?.generate_audio ??
      working?.inputs?.generateAudio ??
      working?.inputs?.audio_enabled ??
      working?.inputs?.audioEnabled ??
      working?.inputs?.with_audio ??
      working?.inputs?.withAudio;

    const muteRaw = working?.inputs?.mute ?? working?.inputs?.muted;

    let generateAudio =
      generateAudioRaw !== undefined ? !!generateAudioRaw :
      muteRaw !== undefined ? !Boolean(muteRaw) :
      true;

    if (asHttpUrl(endImage)) generateAudio = false;

    let genRes;
    let stepType = "kling_generate";

    try {
      if (pricing.flow === "kling_motion_control") {
        if (!frame2?.url) throw new Error("MISSING_FRAME2_VIDEO_URL");

        const kmcMode = safeStr(working?.inputs?.mode || working?.inputs?.kmc_mode, "") || "std";
        const kmcOrientation =
          safeStr(working?.inputs?.character_orientation || working?.inputs?.characterOrientation, "") || "video";
        const keepOriginalSound =
          working?.inputs?.keep_original_sound ?? working?.inputs?.keepOriginalSound ?? true;

        working.meta = { ...(working.meta || {}), video_engine: "kling_motion_control" };
        await updateVars({ supabase, generationId, vars: working });

        genRes = await runKlingMotionControl({
          prompt: finalMotionPrompt,
          image: startImage,
          video: frame2.url,
          mode: kmcMode,
          keepOriginalSound,
          characterOrientation: kmcOrientation,
        });

        working.outputs = { ...(working.outputs || {}) };
        working.outputs.kling_motion_control_prediction_id = genRes.prediction_id || null;
        stepType = "kling_motion_control_generate";
        await updateVars({ supabase, generationId, vars: working });
      } else if (pricing.flow === "fabric_audio") {
        if (!frame2?.url) throw new Error("MISSING_FRAME2_AUDIO_URL");

        const resolution =
          safeStr(working?.inputs?.resolution || working?.inputs?.fabric_resolution, "") || "720p";

        working.meta = { ...(working.meta || {}), video_engine: "fabric_audio" };
        await updateVars({ supabase, generationId, vars: working });

        genRes = await runFabricAudio({
          image: startImage,
          audio: frame2.url,
          resolution,
        });

        working.outputs = { ...(working.outputs || {}) };
        working.outputs.fabric_prediction_id = genRes.prediction_id || null;
        stepType = "fabric_generate";
        await updateVars({ supabase, generationId, vars: working });
      } else {
        working.meta = { ...(working.meta || {}), video_engine: "kling" };
        await updateVars({ supabase, generationId, vars: working });

        genRes = await runKling({
          prompt: finalMotionPrompt,
          startImage,
          endImage,
          duration,
          mode,
          negativePrompt: neg,
          generateAudio,
        });

        working.outputs = { ...(working.outputs || {}) };
        working.outputs.kling_prediction_id = genRes.prediction_id || null;
        stepType = "kling_generate";
        await updateVars({ supabase, generationId, vars: working });
      }
    } finally {
      try {
        chatter?.stop?.();
      } catch {}
      chatter = null;
    }

    const { input, out, timing } = genRes;

    await writeStep({
      supabase,
      generationId,
      passId,
      stepNo: stepNo++,
      stepType,
      payload: { input, output: out, timing, error: null },
    });

    const remote = pickFirstUrl(out);
    if (!remote) throw new Error("VIDEO_NO_URL");

    let remoteUrl = remote;
    try {
      remoteUrl = await storeRemoteToR2Public(remote, `mma/video/${generationId}`);
    } catch (e) {
      console.warn("[mma] storeRemoteToR2Public failed (video), using provider url:", e?.message || e);
      remoteUrl = remote;
    }

    working.outputs = { ...(working.outputs || {}) };
    working.outputs.kling_video_url = remoteUrl;

    if (pricing.flow === "fabric_audio") working.outputs.fabric_video_url = remoteUrl;
    if (pricing.flow === "kling_motion_control") working.outputs.kling_motion_control_video_url = remoteUrl;

    working.mg_output_url = remoteUrl;

    working = pushUserMessageLine(working, pick(MMA_UI.quickLines.saved_video));
    await updateVars({ supabase, generationId, vars: working });
    emitLine(generationId, working);

    await finalizeGeneration({ supabase, generationId, url: remoteUrl, prompt: finalMotionPrompt });

    await updateStatus({ supabase, generationId, status: "done" });
    emitStatus(generationId, "done");
    sendDone(generationId, "done");
  } catch (err) {
    try {
      chatter?.stop?.();
    } catch {}
    chatter = null;

    console.error("[mma] video animate pipeline error", err);

    await updateStatus({ supabase, generationId, status: "error" });
    await supabase
      .from("mega_generations")
      .update({
        mg_error: {
          code: "PIPELINE_ERROR",
          message: err?.message || String(err || ""),
          provider: err?.provider || null,
        },
        mg_updated_at: nowIso(),
      })
      .eq("mg_generation_id", generationId)
      .eq("mg_record_type", "generation");

    if (!suggestOnly) {
      try {
        await refundOnFailure({ supabase, passId, generationId, cost: videoCost, err });
      } catch (e) {
        console.warn("[mma] refund failed (video animate)", e?.message || e);
      }
    }

    emitStatus(generationId, "error");
    sendDone(generationId, "error");
  }
}

async function runStillTweakPipeline({ supabase, generationId, passId, parent, vars, preferences }) {
  const cfg = getMmaConfig();
  if (!cfg.enabled) throw new Error("MMA_DISABLED");

  let working = vars;

  const stillLane = resolveStillLane(working);
  const stillCost = stillCostForLane(stillLane);
  await chargeGeneration({
    passId,
    generationId,
    cost: stillCost,
    reason: stillLane === "niche" ? "mma_still_niche" : "mma_still",
    lane: stillLane,
  });

  const ctx = await getMmaCtxConfig(supabase);
  let chatter = null;

  try {
    await updateStatus({ supabase, generationId, status: "prompting" });
    emitStatus(generationId, "prompting");

    working = pushUserMessageLine(working, pick(MMA_UI.quickLines.still_tweak_start));
    await updateVars({ supabase, generationId, vars: working });
    emitLine(generationId, working);

    const parentUrl = asHttpUrl(parent?.mg_output_url);
    if (!parentUrl) throw new Error("PARENT_OUTPUT_URL_MISSING");

    const feedbackText =
      safeStr(working?.feedback?.still_feedback, "") ||
      safeStr(working?.feedback?.feedback_still, "") ||
      safeStr(working?.feedback?.text, "") ||
      safeStr(working?.inputs?.feedback_still, "") ||
      safeStr(working?.inputs?.feedback, "") ||
      safeStr(working?.inputs?.comment, "");

    if (!feedbackText) throw new Error("MISSING_STILL_FEEDBACK");

    let stepNo = 1;

    const oneShotInput = {
      parent_image_url: parentUrl,
      feedback: feedbackText,
      previous_prompt: safeStr(parent?.mg_prompt, ""),
      preferences: preferences || {},
      hard_blocks: safeArray(preferences?.hard_blocks),
      notes: "Keep the main subject consistent. Apply feedback precisely.",
    };

    const labeledImages = [{ role: "PARENT_IMAGE", url: parentUrl }];

    const t0 = Date.now();
    const one = await gptStillOneShotTweak({ cfg, ctx, input: oneShotInput, labeledImages });

    await writeStep({
      supabase,
      generationId,
      passId,
      stepNo: stepNo++,
      stepType: "gpt_still_tweak_one_shot",
      payload: {
        ctx: ctx.still_tweak_one_shot,
        input: oneShotInput,
        labeledImages,
        request: one.request,
        raw: one.raw,
        output: { clean_prompt: one.clean_prompt, parsed_ok: one.parsed_ok },
        timing: { started_at: new Date(t0).toISOString(), ended_at: nowIso(), duration_ms: Date.now() - t0 },
        error: null,
      },
    });

    const usedPrompt = safeStr(one.clean_prompt, "");
    if (!usedPrompt) throw new Error("EMPTY_TWEAK_PROMPT_ONE_SHOT");

    working.prompts = { ...(working.prompts || {}), clean_prompt: usedPrompt };
    await updateVars({ supabase, generationId, vars: working });

    await updateStatus({ supabase, generationId, status: "generating" });
    emitStatus(generationId, "generating");

    chatter = startMinaChatter({
      supabase,
      generationId,
      getVars: () => working,
      setVars: (v) => {
        working = v;
      },
      stage: "generating",
      intervalMs: 2600,
    });

    const lane = resolveStillLane(working);
    const useNano = lane === "niche" && nanoBananaEnabled();

    working.meta = { ...(working.meta || {}), still_lane: lane, still_engine: useNano ? "nanobanana" : "seedream" };
    await updateVars({ supabase, generationId, vars: working });

    let aspectRatio =
      safeStr(working?.inputs?.aspect_ratio, "") ||
      (useNano
        ? process.env.MMA_NANOBANANA_ASPECT_RATIO || cfg?.nanobanana?.aspectRatio
        : cfg?.seadream?.aspectRatio || process.env.MMA_SEADREAM_ASPECT_RATIO) ||
      "match_input_image";

    if (String(aspectRatio).toLowerCase().includes("match") && !parentUrl) {
      aspectRatio = "1:1";
    }

    const forcedInput = useNano
      ? {
          prompt: usedPrompt,
          resolution: cfg?.nanobanana?.resolution || process.env.MMA_NANOBANANA_RESOLUTION || "2K",
          aspect_ratio: aspectRatio,
          output_format: cfg?.nanobanana?.outputFormat || process.env.MMA_NANOBANANA_OUTPUT_FORMAT || "jpg",
          safety_filter_level:
            cfg?.nanobanana?.safetyFilterLevel || process.env.MMA_NANOBANANA_SAFETY_FILTER_LEVEL || "block_only_high",
          image_input: [parentUrl],
        }
      : {
          prompt: usedPrompt,
          size: cfg?.seadream?.size || process.env.MMA_SEADREAM_SIZE || "2K",
          aspect_ratio: aspectRatio,
          enhance_prompt: !!cfg?.seadream?.enhancePrompt,
          sequential_image_generation: "disabled",
          max_images: 1,
          image_input: [parentUrl],
        };

    let genRes;
    try {
      genRes = useNano
        ? await runNanoBanana({
            prompt: usedPrompt,
            aspectRatio,
            imageInputs: [parentUrl],
            input: forcedInput,
          })
        : await runSeedream({
            prompt: usedPrompt,
            aspectRatio,
            imageInputs: [parentUrl],
            size: cfg?.seadream?.size,
            enhancePrompt: cfg?.seadream?.enhancePrompt,
            input: forcedInput,
          });
    } finally {
      try {
        chatter?.stop?.();
      } catch {}
      chatter = null;
    }

    const { input, out, timing } = genRes;

    await writeStep({
      supabase,
      generationId,
      passId,
      stepNo: stepNo++,
      stepType: useNano ? "nanobanana_generate_tweak" : "seedream_generate_tweak",
      payload: { input, output: out, timing, error: null },
    });

    const genUrl = pickFirstUrl(out);
    if (!genUrl) throw new Error(useNano ? "NANOBANANA_NO_URL_TWEAK" : "SEADREAM_NO_URL_TWEAK");

    const remoteUrl = await storeRemoteToR2Public(genUrl, `mma/still/${generationId}`);

    working.outputs = { ...(working.outputs || {}) };
    if (useNano) working.outputs.nanobanana_image_url = remoteUrl;
    else working.outputs.seedream_image_url = remoteUrl;

    working.mg_output_url = remoteUrl;

    working = pushUserMessageLine(working, pick(MMA_UI.quickLines.saved_image));
    await updateVars({ supabase, generationId, vars: working });
    emitLine(generationId, working);

    await finalizeGeneration({ supabase, generationId, url: remoteUrl, prompt: usedPrompt });

    await updateStatus({ supabase, generationId, status: "done" });
    emitStatus(generationId, "done");
    sendDone(generationId, "done");
  } catch (err) {
    try {
      chatter?.stop?.();
    } catch {}
    chatter = null;

    console.error("[mma] still tweak pipeline error", err);

    await updateStatus({ supabase, generationId, status: "error" });
    await supabase
      .from("mega_generations")
      .update({
        mg_error: {
          code: "PIPELINE_ERROR",
          message: err?.message || String(err || ""),
          provider: err?.provider || null,
        },
        mg_updated_at: nowIso(),
      })
      .eq("mg_generation_id", generationId)
      .eq("mg_record_type", "generation");

    try {
      await refundOnFailure({ supabase, passId, generationId, cost: stillCost, err });
    } catch (e) {
      console.warn("[mma] refund failed (still tweak)", e?.message || e);
    }

    emitStatus(generationId, "error");
    sendDone(generationId, "error");
  }
}

async function runSeedream({ prompt, aspectRatio, imageInputs = [], size, enhancePrompt, input: forcedInput }) {
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

function pickKlingStartImage(vars, parent) {
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

function pickKlingEndImage(vars, parent) {
  const assets = vars?.assets || {};
  const inputs = vars?.inputs || {};

  return (
    asHttpUrl(inputs.end_image_url || inputs.endImageUrl) ||
    asHttpUrl(assets.end_image_url || assets.endImageUrl) ||
    ""
  );
}

async function runKling({
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

async function runFabricAudio({ image, audio, resolution, input: forcedInput }) {
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

async function runKlingMotionControl({
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
