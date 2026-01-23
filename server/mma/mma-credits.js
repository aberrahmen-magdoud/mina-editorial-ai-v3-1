import { megaAdjustCredits, megaGetCredits, megaHasCreditRef } from "../../mega-db.js";
import { MMA_COSTS, buildInsufficientCreditsDetails, utcDayKey } from "./mma-pricing.js";
import { safeStr } from "./mma-shared.js";
import { nowIso } from "./mma-utils.js";

function makeHttpError(statusCode, code, extra = {}) {
  const err = new Error(code);
  err.statusCode = statusCode;
  err.code = code;
  Object.assign(err, extra);
  return err;
}

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

function isSafetyBlockError(err) {
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
