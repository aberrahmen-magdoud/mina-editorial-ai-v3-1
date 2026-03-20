// server/mma/mma-credits.js — Credit management for MMA (costs, charge, refund, preferences)
"use strict";

import {
  megaGetCredits,
  megaAdjustCredits,
  megaHasCreditRef,
} from "../../mega-db.js";

import { safeStr, safeArray, asHttpUrl, resolveFrame2Reference } from "./mma-helpers.js";
import { nowIso } from "./mma-utils.js";

// ============================================================================
// Cost constants
// ============================================================================
export const MMA_COSTS = {
  still_main: 1,
  still_niche: 2,
  video: 10,
  ugc_per_shot: 10,
  typeForMePer: 10,
  typeForMeCharge: 1,
};

// ============================================================================
// Duration / lane / resolution helpers
// ============================================================================

function _clamp(n, a, b) {
  const x = Number(n || 0) || 0;
  return Math.max(a, Math.min(b, x));
}

export function resolveVideoDurationSec(inputs) {
  const d =
    Number(
      inputs?.motion_duration_sec ??
        inputs?.motionDurationSec ??
        inputs?.duration ??
        inputs?.duration_seconds ??
        inputs?.durationSeconds ??
        5
    ) || 5;

  if (d >= 15) return 15;
  if (d >= 10) return 10;
  return 5;
}

export function resolveVideoPricing(inputsLike, assetsLike) {
  const inputs = inputsLike && typeof inputsLike === "object" ? inputsLike : {};
  const frame2 = resolveFrame2Reference(inputs, assetsLike);

  const videoLane = safeStr(
    inputs.video_lane || inputs.videoLane || inputs.animate_lane || inputs.animateLane,
    "short"
  ).toLowerCase();
  const isStory = videoLane === "story";

  if (frame2.kind === "ref_video") {
    return { flow: "kling_motion_control", videoLane, model: "kling-v3-omni" };
  }
  if (frame2.kind === "ref_audio") {
    return { flow: "kling_omni_audio", videoLane, model: "kling-v3-omni" };
  }
  if (isStory) {
    return { flow: "kling_omni", videoLane, model: "kling-v3-omni" };
  }
  const hasStart = !!asHttpUrl(inputs.start_image_url || inputs.startImageUrl || inputs.image);
  const hasEnd = !!asHttpUrl(inputs.end_image_url || inputs.endImageUrl || inputs.image_tail);
  if (hasStart && !hasEnd) {
    return { flow: "kling", videoLane, model: "kling-v3" };
  }
  return { flow: "kling_omni", videoLane, model: "kling-v3-omni" };
}

export function videoCostFromInputs(inputsLike, assetsLike) {
  const inputs = inputsLike && typeof inputsLike === "object" ? inputsLike : {};
  const frame2 = resolveFrame2Reference(inputs, assetsLike);

  if (frame2.kind === "ref_video" || frame2.kind === "ref_audio") {
    const maxSec = frame2.maxSec || (frame2.kind === "ref_audio" ? 60 : 30);

    const rawProvided =
      Number(frame2.rawDurationSec || 0) ||
      Number(inputs.frame2_duration_sec || inputs.frame2DurationSec || 0) ||
      Number(inputs.motion_duration_sec || inputs.motionDurationSec || 0) ||
      Number(inputs.duration || inputs.duration_seconds || inputs.durationSeconds || 0) ||
      Number(inputs.duration_sec || inputs.durationSec || 0) ||
      0;

    const fallback = resolveVideoDurationSec(inputs);
    const raw = rawProvided || fallback;

    const billedSeconds = _clamp(raw, 1, maxSec);
    return billedSeconds * 1;
  }

  const sec = resolveVideoDurationSec(inputs);
  return sec * 1;
}

export function resolveStillLaneFromInputs(inputsLike) {
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

export function resolveStillLane(vars) {
  const inputs = vars?.inputs && typeof vars.inputs === "object" ? vars.inputs : {};
  return resolveStillLaneFromInputs(inputs);
}

export function resolveStillEngine(vars) {
  const lane = resolveStillLane(vars);

  if (lane === "niche" && nanoBananaEnabled()) return "nanobanana";
  if (lane === "main" && mainUsesGemini()) return "nanobanana2";

  return "seedream";
}

function nanoBananaUseGemini() {
  return String(process.env.MMA_NANOBANANA_USE_GEMINI || "").trim() === "1";
}

function nanoBananaEnabled() {
  if (nanoBananaUseGemini()) return !!process.env.GEMINI_API_KEY;
  return !!process.env.MMA_NANOBANANA_VERSION;
}

function mainGeminiModel() {
  return safeStr(process.env.MMA_MAIN_GEMINI_MODEL, "");
}

function mainUsesGemini() {
  return !!mainGeminiModel() && !!process.env.GEMINI_API_KEY;
}

export function normalizeStillResolutionValue(rawLike) {
  const raw = safeStr(rawLike, "").toLowerCase();
  if (!raw) return "4K";
  if (raw === "2k" || raw === "2048" || raw === "2") return "2K";
  if (raw === "4k" || raw === "4096" || raw === "4") return "4K";
  return "4K";
}

export function resolveAppliedStillResolution(inputsLike) {
  const inputs = inputsLike && typeof inputsLike === "object" ? inputsLike : {};
  const lane = resolveStillLaneFromInputs(inputs);
  if (lane === "main") return "4K";

  return normalizeStillResolutionValue(
    inputs.still_resolution ||
      inputs.stillResolution ||
      inputs.resolution ||
      inputs.image_resolution ||
      inputs.imageResolution
  );
}

export function stillResolutionMeta(resolution) {
  const canonical = normalizeStillResolutionValue(resolution);
  return {
    still_resolution: canonical,
    resolution: canonical,
    applied_resolution: canonical,
  };
}

export function stillCostForLane(lane) {
  return lane === "niche" ? MMA_COSTS.still_niche : MMA_COSTS.still_main;
}

export function getStillCost(varsOrInputs) {
  const v =
    varsOrInputs && typeof varsOrInputs === "object" && varsOrInputs.inputs
      ? varsOrInputs
      : { inputs: varsOrInputs && typeof varsOrInputs === "object" ? varsOrInputs : {} };

  return stillCostForLane(resolveStillLane(v));
}

export function buildInsufficientCreditsDetails({ balance, needed, lane }) {
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

// ============================================================================
// Credit operations
// ============================================================================

function utcDayKey() {
  return nowIso().slice(0, 10);
}

function makeHttpError(statusCode, code, extra = {}) {
  const err = new Error(code);
  err.statusCode = statusCode;
  err.code = code;
  Object.assign(err, extra);
  return err;
}

export async function ensureEnoughCredits(passId, needed, opts = {}) {
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

export async function chargeGeneration({ passId, generationId, cost, reason, lane }) {
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

export async function refundOnFailure({ supabase, passId, generationId, cost, err }) {
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

// ============================================================================
// Type-for-me credit logic
// ============================================================================

export async function preflightTypeForMe({ supabase, passId }) {
  const prefs = await readMmaPreferences(supabase, passId);
  const n = Number(prefs?.type_for_me_success_count || 0) || 0;
  const next = n + 1;

  if (next % MMA_COSTS.typeForMePer === 0) {
    await ensureEnoughCredits(passId, MMA_COSTS.typeForMeCharge);
  }

  return { prefs, successCount: n };
}

export async function commitTypeForMeSuccessAndMaybeCharge({ supabase, passId }) {
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
// Preferences + safety helpers
// ============================================================================

export async function readMmaPreferences(supabase, passId) {
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

export async function writeMmaPreferences(supabase, passId, nextPrefs) {
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

export function isSafetyBlockError(err) {
  const msg = String(err?.message || err || "").toLowerCase();
  return (
    msg.includes("nsfw") ||
    msg.includes("nud") ||
    msg.includes("nude") ||
    msg.includes("sexual") ||
    msg.includes("safety") ||
    msg.includes("policy") ||
    (msg.includes("content") && msg.includes("block"))
  );
}
