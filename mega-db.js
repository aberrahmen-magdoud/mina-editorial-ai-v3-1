// mega-db.js — MEGA-only persistence helpers (customers + credits + sessions + feedback)
// Compatible with server.js imports:
//   resolvePassId, megaEnsureCustomer, megaGetCredits, megaAdjustCredits,
//   megaHasCreditRef, megaWriteSession, megaWriteFeedback
import crypto from "node:crypto";
import { getSupabaseAdmin } from "./supabase.js";

// ---------------------------------------------
// Basics
// ---------------------------------------------
function nowIso() {
  return new Date().toISOString();
}

function safeString(v, fallback = "") {
  if (v === null || v === undefined) return fallback;
  const s = typeof v === "string" ? v : String(v);
  const t = s.trim();
  return t.length ? t : fallback;
}

function normalizeEmail(email) {
  const e = safeString(email, "").toLowerCase();
  return e || null;
}

function intOr(v, fallback = 0) {
  const n = Number.parseInt(String(v ?? ""), 10);
  return Number.isFinite(n) ? n : fallback;
}

function requireSupabase() {
  const supabase = getSupabaseAdmin();
  if (!supabase) throw new Error("SUPABASE_NOT_CONFIGURED");
  return supabase;
}

function addDaysIso(baseIso, days) {
  const base = baseIso ? new Date(baseIso) : new Date();
  if (Number.isFinite(days)) base.setUTCDate(base.getUTCDate() + Number(days));
  return base.toISOString();
}

function maxIso(a, b) {
  const ta = a ? Date.parse(a) : NaN;
  const tb = b ? Date.parse(b) : NaN;
  if (!Number.isFinite(ta) && !Number.isFinite(tb)) return null;
  if (!Number.isFinite(ta)) return b || null;
  if (!Number.isFinite(tb)) return a || null;
  return ta >= tb ? a : b;
}

// ---------------------------------------------
// PassId resolver (used by server.js)
// priority: body.customerId/passId -> header X-Mina-Pass-Id -> anon
// ---------------------------------------------
export function resolvePassId(req, body = {}) {
  const fromBody = safeString(body?.customerId || body?.passId || body?.pass_id, "");
  if (fromBody) return fromBody;

  const fromHeader = safeString(req?.get?.("X-Mina-Pass-Id") || req?.get?.("x-mina-pass-id"), "");
  if (fromHeader) return fromHeader;

  return `pass:anon:${crypto.randomUUID()}`;
}

// ---------------------------------------------
// Ensure customer row exists
// ---------------------------------------------
export async function megaEnsureCustomer({
  passId,
  userId = null,
  email = null,
  shopifyCustomerId = null,
} = {}) {
  const supabase = requireSupabase();
  const ts = nowIso();

  const pid = safeString(passId, "");
  if (!pid) throw new Error("PASS_ID_REQUIRED");

  const normalizedEmail = normalizeEmail(email);

  const { data: existing, error: readErr } = await supabase
    .from("mega_customers")
    .select(
      "mg_pass_id, mg_credits, mg_expires_at, mg_created_at, mg_shopify_customer_id, mg_user_id, mg_email, mg_mma_preferences"
    )
    .eq("mg_pass_id", pid)
    .maybeSingle();

  if (readErr) throw readErr;

  const isNew = !existing?.mg_pass_id;

  // Defaults (optional)
  const defaultFreeCredits = intOr(process.env.DEFAULT_FREE_CREDITS, 0);
  const expireDays = intOr(process.env.DEFAULT_CREDITS_EXPIRE_DAYS, 30);

  if (isNew) {
    const insertCredits = defaultFreeCredits > 0 ? defaultFreeCredits : 0;
    const insertExpiresAt =
      defaultFreeCredits > 0 ? addDaysIso(ts, expireDays) : null;

    const { error: insErr } = await supabase.from("mega_customers").insert({
      mg_pass_id: pid,
      mg_user_id: userId || null,
      mg_email: normalizedEmail,
      mg_shopify_customer_id: shopifyCustomerId || null,
      mg_credits: insertCredits,
      mg_expires_at: insertExpiresAt,
      mg_last_active: ts,
      mg_disabled: false,
      mg_mma_preferences: {}, // safe default; MMA can update later
      mg_mma_preferences_updated_at: null,
      mg_created_at: ts,
      mg_updated_at: ts,
    });

    if (insErr) throw insErr;

    // Optional: ledger row for free credits
    if (defaultFreeCredits > 0) {
      await supabase.from("mega_generations").insert({
        mg_id: `credit_transaction:${crypto.randomUUID()}`,
        mg_record_type: "credit_transaction",
        mg_pass_id: pid,
        mg_delta: defaultFreeCredits,
        mg_reason: "free_signup",
        mg_source: "system",
        mg_ref_type: "free_signup",
        mg_ref_id: pid,
        mg_status: "succeeded",
        mg_meta: { credits_before: 0, credits_after: insertCredits },
        mg_event_at: ts,
        mg_created_at: ts,
        mg_updated_at: ts,
      });
    }

    return {
      passId: pid,
      credits: insertCredits,
      expiresAt: insertExpiresAt,
      createdAt: ts,
      isNew: true,
      preferences: {},
    };
  }

  // Update non-destructively + last_active
  const updates = {
    mg_last_active: ts,
    mg_updated_at: ts,
  };

  if (userId && !existing?.mg_user_id) updates.mg_user_id = userId;
  if (normalizedEmail && !existing?.mg_email) updates.mg_email = normalizedEmail;
  if (shopifyCustomerId && !existing?.mg_shopify_customer_id) updates.mg_shopify_customer_id = shopifyCustomerId;

  const { error: upErr } = await supabase
    .from("mega_customers")
    .update(updates)
    .eq("mg_pass_id", pid);

  if (upErr) throw upErr;

  return {
    passId: pid,
    credits: intOr(existing?.mg_credits, 0),
    expiresAt: existing?.mg_expires_at ?? null,
    createdAt: existing?.mg_created_at ?? null,
    isNew: false,
    preferences: existing?.mg_mma_preferences || {},
  };
}

// ---------------------------------------------
// Credits read
// ---------------------------------------------
export async function megaGetCredits(passId) {
  const supabase = requireSupabase();
  const pid = safeString(passId, "");
  if (!pid) throw new Error("PASS_ID_REQUIRED");

  const { data, error } = await supabase
    .from("mega_customers")
    .select("mg_credits, mg_expires_at")
    .eq("mg_pass_id", pid)
    .maybeSingle();

  if (error) throw error;

  return {
    credits: intOr(data?.mg_credits, 0),
    expiresAt: data?.mg_expires_at ?? null,
  };
}

// ---------------------------------------------
// Idempotency helper for Shopify webhook
// ---------------------------------------------
export async function megaHasCreditRef({ refType, refId } = {}) {
  const supabase = requireSupabase();
  const rt = safeString(refType, "");
  const rid = safeString(refId, "");
  if (!rt || !rid) return false;

  const { data, error } = await supabase
    .from("mega_generations")
    .select("mg_id")
    .eq("mg_record_type", "credit_transaction")
    .eq("mg_ref_type", rt)
    .eq("mg_ref_id", rid)
    .limit(1);

  if (error) throw error;
  return (data?.length ?? 0) > 0;
}

// ---------------------------------------------
// Credits adjust + rolling expiry + ledger row
// NOTE: not fully atomic under concurrency.
// ---------------------------------------------
export async function megaAdjustCredits({
  passId,
  delta,
  reason = "manual",
  source = "api",
  refType = null,
  refId = null,
  grantedAt = null,
} = {}) {
  const supabase = requireSupabase();
  const pid = safeString(passId, "");
  if (!pid) throw new Error("PASS_ID_REQUIRED");

  const ts = nowIso();
  const d = Number(delta ?? 0);
  if (!Number.isFinite(d) || d === 0) throw new Error("DELTA_INVALID");

  // Ensure customer exists
  await megaEnsureCustomer({ passId: pid });

  // Read current
  const { data: row, error: readErr } = await supabase
    .from("mega_customers")
    .select("mg_credits, mg_expires_at")
    .eq("mg_pass_id", pid)
    .maybeSingle();

  if (readErr) throw readErr;

  const before = intOr(row?.mg_credits, 0);
  const after = Math.max(0, before + d);

  // Rolling expiry on positive grants
  const expireDays = intOr(process.env.DEFAULT_CREDITS_EXPIRE_DAYS, 30);
  const eventAt = grantedAt ? new Date(grantedAt).toISOString() : ts;

  const currentExpiry = row?.mg_expires_at ? new Date(row.mg_expires_at).toISOString() : null;
  let nextExpiry = currentExpiry;

  if (d > 0) {
    const candidate = addDaysIso(eventAt, expireDays);
    nextExpiry = maxIso(currentExpiry, candidate);
  }

  // Update customer
  const { error: upErr } = await supabase
    .from("mega_customers")
    .update({
      mg_credits: after,
      mg_expires_at: nextExpiry,
      mg_last_active: ts,
      mg_updated_at: ts,
    })
    .eq("mg_pass_id", pid);

  if (upErr) throw upErr;

  // Ledger row
  const { error: insErr } = await supabase.from("mega_generations").insert({
    mg_id: `credit_transaction:${crypto.randomUUID()}`,
    mg_record_type: "credit_transaction",
    mg_pass_id: pid,
    mg_delta: d,
    mg_reason: safeString(reason, null),
    mg_source: safeString(source, null),
    mg_ref_type: refType ? safeString(refType, null) : null,
    mg_ref_id: refId ? safeString(refId, null) : null,
    mg_status: "succeeded",
    mg_meta: {
      credits_before: before,
      credits_after: after,
      expires_at: nextExpiry,
    },
    mg_event_at: eventAt,
    mg_created_at: ts,
    mg_updated_at: ts,
  });

  if (insErr) throw insErr;

  return { creditsBefore: before, creditsAfter: after, expiresAt: nextExpiry };
}

// ---------------------------------------------
// Session writer (mega_generations)
// ---------------------------------------------
export async function megaWriteSession({
  passId,
  sessionId,
  platform = "web",
  title = null,
  meta = {},
} = {}) {
  const supabase = requireSupabase();
  const pid = safeString(passId, "");
  const sid = safeString(sessionId, "");
  if (!pid) throw new Error("PASS_ID_REQUIRED");
  if (!sid) throw new Error("SESSION_ID_REQUIRED");

  const ts = nowIso();

  await megaEnsureCustomer({ passId: pid });

  // keep customer active
  const { error: upErr } = await supabase
    .from("mega_customers")
    .update({ mg_last_active: ts, mg_updated_at: ts })
    .eq("mg_pass_id", pid);
  if (upErr) throw upErr;

  const { error: insErr } = await supabase.from("mega_generations").insert({
    mg_id: `session:${sid}`,
    mg_record_type: "session",
    mg_pass_id: pid,
    mg_session_id: sid,
    mg_platform: safeString(platform, "web"),
    mg_title: title ? safeString(title, null) : null,
    mg_status: "succeeded",
    mg_meta: meta && typeof meta === "object" ? meta : {},
    mg_event_at: ts,
    mg_created_at: ts,
    mg_updated_at: ts,
  });

  if (insErr) throw insErr;

  return { sessionId: sid };
}

// ---------------------------------------------
// Feedback writer (mega_generations)
// ---------------------------------------------
export async function megaWriteFeedback({
  passId,
  generationId = null,
  payload = {},
} = {}) {
  const supabase = requireSupabase();
  const pid = safeString(passId, "");
  if (!pid) throw new Error("PASS_ID_REQUIRED");

  const ts = nowIso();
  const feedbackId = crypto.randomUUID();

  await megaEnsureCustomer({ passId: pid });

  // keep customer active
  const { error: upErr } = await supabase
    .from("mega_customers")
    .update({ mg_last_active: ts, mg_updated_at: ts })
    .eq("mg_pass_id", pid);
  if (upErr) throw upErr;

  const { error: insErr } = await supabase.from("mega_generations").insert({
    mg_id: `feedback:${feedbackId}`,
    mg_record_type: "feedback",
    mg_pass_id: pid,
    mg_generation_id: generationId ? safeString(generationId, null) : null,
    mg_status: "succeeded",
    mg_meta: payload && typeof payload === "object" ? payload : { value: payload },
    mg_event_at: ts,
    mg_created_at: ts,
    mg_updated_at: ts,
  });

  if (insErr) throw insErr;

  return { feedbackId };
}

export default {
  resolvePassId,
  megaEnsureCustomer,
  megaGetCredits,
  megaAdjustCredits,
  megaHasCreditRef,
  megaWriteSession,
  megaWriteFeedback,
};
