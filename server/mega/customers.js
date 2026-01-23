import crypto from "node:crypto";
import { addDaysIso, intOr, normalizeEmail, nowIso, requireSupabase, safeString } from "./internal.js";

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

export async function touchCustomer(supabase, passId) {
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
