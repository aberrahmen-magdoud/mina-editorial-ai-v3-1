"use strict";

import crypto from "node:crypto";
import { getSupabaseAdmin, sbEnabled } from "./supabase.js";
import { nowIso, safeString } from "./utils.js";

function normalizeEmail(email) {
  const e = safeString(email, "").toLowerCase();
  return e || null;
}

function intOr(v, fallback = 0) {
  const n = Number.parseInt(String(v ?? ""), 10);
  return Number.isFinite(n) ? n : fallback;
}

function addDaysIso(baseIso, days) {
  const d = baseIso ? new Date(baseIso) : new Date();
  d.setUTCDate(d.getUTCDate() + Number(days || 0));
  return d.toISOString();
}

function maxIso(a, b) {
  const ta = a ? Date.parse(a) : NaN;
  const tb = b ? Date.parse(b) : NaN;
  if (!Number.isFinite(ta) && !Number.isFinite(tb)) return null;
  if (!Number.isFinite(ta)) return b || null;
  if (!Number.isFinite(tb)) return a || null;
  return ta >= tb ? a : b;
}

function requireSupabase() {
  const supabase = getSupabaseAdmin();
  if (!supabase) throw new Error("SUPABASE_NOT_CONFIGURED");
  return supabase;
}

// priority: body.customerId/passId -> header X-Mina-Pass-Id -> anon
export function resolvePassId(req, body = {}) {
  const fromBody = safeString(body?.customerId || body?.passId || body?.pass_id, "");
  if (fromBody) return fromBody;

  const fromHeader = safeString(req?.get?.("X-Mina-Pass-Id") || req?.get?.("x-mina-pass-id"), "");
  if (fromHeader) return fromHeader;

  return `pass:anon:${crypto.randomUUID()}`;
}

// Keep pass:user:* intact.
// For pass:anon:* keep the short legacy behavior.
export function normalizeIncomingPassId(raw) {
  const s = safeString(raw, "");
  if (!s) return "";
  if (s.startsWith("pass:anon:")) return s.slice("pass:anon:".length).trim();
  return s;
}

export function setPassIdHeader(res, passId) {
  if (passId) res.set("X-Mina-Pass-Id", passId);
}

async function isUniqueConflict({ supabase, column, value, passId }) {
  if (!value) return false;

  const { data, error } = await supabase
    .from("mega_customers")
    .select("mg_pass_id")
    .eq(column, value)
    .maybeSingle();

  if (error) throw error;

  const existingPassId = data?.mg_pass_id || null;
  return Boolean(existingPassId && existingPassId !== passId);
}

async function touchCustomer(supabase, passId) {
  const ts = nowIso();
  const { error } = await supabase
    .from("mega_customers")
    .update({ mg_last_active: ts, mg_updated_at: ts })
    .eq("mg_pass_id", passId);
  if (error) throw error;
}

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

  const defaultFreeCredits = intOr(process.env.DEFAULT_FREE_CREDITS, 0);
  const expireDays = intOr(process.env.DEFAULT_CREDITS_EXPIRE_DAYS, 30);

  if (isNew) {
    let insertUserId = userId || null;
    let insertEmail = normalizedEmail;

    if (insertUserId) {
      const conflict = await isUniqueConflict({
        supabase,
        column: "mg_user_id",
        value: insertUserId,
        passId: pid,
      });
      if (conflict) insertUserId = null;
    }

    if (insertEmail) {
      const conflict = await isUniqueConflict({
        supabase,
        column: "mg_email",
        value: insertEmail,
        passId: pid,
      });
      if (conflict) insertEmail = null;
    }

    const insertCredits = defaultFreeCredits > 0 ? defaultFreeCredits : 0;
    const insertExpiresAt = defaultFreeCredits > 0 ? addDaysIso(ts, expireDays) : null;

    const { error: insErr } = await supabase.from("mega_customers").insert({
      mg_pass_id: pid,
      mg_shopify_customer_id: shopifyCustomerId || null,
      mg_user_id: insertUserId,
      mg_email: insertEmail,
      mg_mma_preferences: {},
      mg_mma_preferences_updated_at: null,
      mg_credits: insertCredits,
      mg_admin_allowlist: false,
      mg_last_active: ts,
      mg_disabled: false,
      mg_expires_at: insertExpiresAt,
      mg_created_at: ts,
      mg_updated_at: ts,
    });

    if (insErr) throw insErr;

    if (defaultFreeCredits > 0) {
      const { error: ledErr } = await supabase.from("mega_generations").insert({
        mg_id: `credit_transaction:${crypto.randomUUID()}`,
        mg_record_type: "credit_transaction",
        mg_pass_id: pid,
        mg_delta: defaultFreeCredits,
        mg_reason: "free_signup",
        mg_source: "system",
        mg_ref_type: "free_signup",
        mg_ref_id: pid,
        mg_status: "succeeded",
        mg_meta: { credits_before: 0, credits_after: insertCredits, expires_at: insertExpiresAt },
        mg_payload: null,
        mg_event_at: ts,
        mg_created_at: ts,
        mg_updated_at: ts,
      });
      if (ledErr) throw ledErr;
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

  const updates = {
    mg_last_active: ts,
    mg_updated_at: ts,
  };

  if (userId && !existing?.mg_user_id) {
    const conflict = await isUniqueConflict({
      supabase,
      column: "mg_user_id",
      value: userId,
      passId: pid,
    });
    if (!conflict) updates.mg_user_id = userId;
  }
  if (normalizedEmail && !existing?.mg_email) {
    const conflict = await isUniqueConflict({
      supabase,
      column: "mg_email",
      value: normalizedEmail,
      passId: pid,
    });
    if (!conflict) updates.mg_email = normalizedEmail;
  }
  if (shopifyCustomerId && !existing?.mg_shopify_customer_id) {
    updates.mg_shopify_customer_id = shopifyCustomerId;
  }

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

// ---------------------------------------------------------------------------
// Lead capture helper (safe upsert into mega_customers)
// ---------------------------------------------------------------------------
function cleanStr(v) {
  const s = String(v ?? "").trim();
  return s || null;
}

function normalizeLeadEmail(email) {
  const e = String(email ?? "").trim().toLowerCase();
  return e || null;
}

async function tryUpsertRow(supabase, row) {
  const { error } = await supabase.from("mega_customers").upsert(row, { onConflict: "mg_pass_id" });
  if (!error) return { ok: true };
  return { ok: false, error };
}

export async function upsertMegaCustomerLead({
  passId,
  email = null,
  userId = null,
  shopifyCustomerId = null,
} = {}) {
  if (!sbEnabled()) return { ok: false, degraded: true, reason: "NO_SUPABASE" };

  const supabase = getSupabaseAdmin();
  if (!supabase) return { ok: false, degraded: true, reason: "NO_SUPABASE" };

  const pid = cleanStr(passId);
  if (!pid) return { ok: false, error: "MISSING_PASS_ID" };

  const rowBase = { mg_pass_id: pid };

  const em = normalizeLeadEmail(email);
  const uid = cleanStr(userId);
  const sid = cleanStr(shopifyCustomerId);

  if (em) rowBase.mg_email = em;
  if (uid) rowBase.mg_user_id = uid;
  if (sid) rowBase.mg_shopify_customer_id = sid;

  const first = await tryUpsertRow(supabase, rowBase);
  if (first.ok) return { ok: true };

  const msg = String(first.error?.message || "");
  if (msg.toLowerCase().includes("mg_shopify_customer_id") && msg.toLowerCase().includes("does not exist")) {
    const retryRow = { mg_pass_id: pid };
    if (em) retryRow.mg_email = em;
    if (uid) retryRow.mg_user_id = uid;

    const second = await tryUpsertRow(supabase, retryRow);
    if (second.ok) return { ok: true, degraded: true, reason: "NO_SHOPIFY_COLUMN" };
  }

  throw first.error;
}

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

  const d = Number(delta ?? 0);
  if (!Number.isFinite(d) || d === 0) throw new Error("DELTA_INVALID");

  const ts = nowIso();
  const eventAt = grantedAt ? new Date(grantedAt).toISOString() : ts;

  await megaEnsureCustomer({ passId: pid });

  const rt = refType ? safeString(refType, "") : "";
  const rid = refId ? safeString(refId, "") : "";
  const hasRef = Boolean(rt && rid);

  const txId = `credit_transaction:${crypto.randomUUID()}`;

  if (hasRef) {
    const { error: txErr } = await supabase.from("mega_generations").insert({
      mg_id: txId,
      mg_record_type: "credit_transaction",
      mg_pass_id: pid,
      mg_delta: Math.trunc(d),
      mg_reason: safeString(reason, null),
      mg_source: safeString(source, null),
      mg_ref_type: rt,
      mg_ref_id: rid,
      mg_status: "pending",
      mg_meta: {},
      mg_payload: null,
      mg_event_at: eventAt,
      mg_created_at: ts,
      mg_updated_at: ts,
    });

    if (txErr) {
      const code = String(txErr.code || "");
      const msg = String(txErr.message || "");
      const dup =
        code === "23505" ||
        msg.toLowerCase().includes("duplicate") ||
        msg.toLowerCase().includes("unique");

      if (dup) {
        const cur = await megaGetCredits(pid);
        return {
          creditsBefore: cur.credits,
          creditsAfter: cur.credits,
          expiresAt: cur.expiresAt ?? null,
          alreadyApplied: true,
        };
      }

      throw txErr;
    }
  }

  const { data: row, error: readErr } = await supabase
    .from("mega_customers")
    .select("mg_credits, mg_expires_at")
    .eq("mg_pass_id", pid)
    .maybeSingle();

  if (readErr) throw readErr;

  const before = intOr(row?.mg_credits, 0);
  const after = Math.max(0, before + d);

  const expireDays = intOr(process.env.DEFAULT_CREDITS_EXPIRE_DAYS, 30);
  const currentExpiry = row?.mg_expires_at ? new Date(row.mg_expires_at).toISOString() : null;

  let nextExpiry = currentExpiry;
  if (d > 0) {
    const candidate = addDaysIso(eventAt, expireDays);
    nextExpiry = maxIso(currentExpiry, candidate);
  }

  const { error: upErr } = await supabase
    .from("mega_customers")
    .update({
      mg_credits: after,
      mg_expires_at: nextExpiry,
      mg_last_active: ts,
      mg_updated_at: ts,
    })
    .eq("mg_pass_id", pid);

  if (upErr) {
    if (hasRef) {
      try {
        await supabase
          .from("mega_generations")
          .update({
            mg_status: "error",
            mg_error: safeString(upErr.message || upErr, "CREDITS_UPDATE_FAILED"),
            mg_updated_at: nowIso(),
          })
          .eq("mg_id", txId);
      } catch {}
    }
    throw upErr;
  }

  if (hasRef) {
    const { error: finErr } = await supabase
      .from("mega_generations")
      .update({
        mg_status: "succeeded",
        mg_meta: {
          credits_before: before,
          credits_after: after,
          expires_at: nextExpiry,
        },
        mg_updated_at: nowIso(),
      })
      .eq("mg_id", txId);

    if (finErr) throw finErr;
  } else {
    const { error: insErr } = await supabase.from("mega_generations").insert({
      mg_id: txId,
      mg_record_type: "credit_transaction",
      mg_pass_id: pid,
      mg_delta: Math.trunc(d),
      mg_reason: safeString(reason, null),
      mg_source: safeString(source, null),
      mg_ref_type: null,
      mg_ref_id: null,
      mg_status: "succeeded",
      mg_meta: {
        credits_before: before,
        credits_after: after,
        expires_at: nextExpiry,
      },
      mg_payload: null,
      mg_event_at: eventAt,
      mg_created_at: ts,
      mg_updated_at: ts,
    });

    if (insErr) throw insErr;
  }

  return { creditsBefore: before, creditsAfter: after, expiresAt: nextExpiry, alreadyApplied: false };
}

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
  await touchCustomer(supabase, pid);

  const { error: insErr } = await supabase.from("mega_generations").insert({
    mg_id: `session:${sid}`,
    mg_record_type: "session",
    mg_pass_id: pid,
    mg_session_id: sid,
    mg_platform: safeString(platform, "web"),
    mg_title: title ? safeString(title, null) : null,
    mg_status: "succeeded",
    mg_meta: meta && typeof meta === "object" ? meta : {},
    mg_payload: null,
    mg_event_at: ts,
    mg_created_at: ts,
    mg_updated_at: ts,
  });

  if (insErr) throw insErr;

  return { sessionId: sid };
}

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
  await touchCustomer(supabase, pid);

  const { error: insErr } = await supabase.from("mega_generations").insert({
    mg_id: `feedback:${feedbackId}`,
    mg_record_type: "feedback",
    mg_pass_id: pid,
    mg_generation_id: generationId ? safeString(generationId, null) : null,
    mg_status: "succeeded",
    mg_meta: payload && typeof payload === "object" ? payload : { value: payload },
    mg_payload: null,
    mg_event_at: ts,
    mg_created_at: ts,
    mg_updated_at: ts,
  });

  if (insErr) throw insErr;

  return { feedbackId };
}
