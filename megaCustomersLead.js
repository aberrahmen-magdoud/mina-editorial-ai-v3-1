// src/megaCustomersLead.js
// Small helper used by /auth/shopify-sync (lead capture).
// Keeps MEGA customer identity aligned with passId/email.
// No UI/UX impact — backend only.

"use strict";

import crypto from "node:crypto";
import { sbEnabled } from "./supabase.js";
import { megaEnsureCustomer } from "./mega-db.js";

function safeString(v, fallback = "") {
  if (v === null || v === undefined) return fallback;
  const s = typeof v === "string" ? v : String(v);
  const t = s.trim();
  return t ? t : fallback;
}

export function normalizeEmail(email) {
  const e = safeString(email, "").toLowerCase();
  return e || null;
}

export function canonicalizePassId({ passId, email } = {}) {
  const pid = safeString(passId, "");
  if (pid) return pid;

  const cleanEmail = normalizeEmail(email);
  if (cleanEmail) return `pass:email:${cleanEmail}`;

  return `pass:anon:${crypto.randomUUID()}`;
}

/**
 * Upsert/link a MEGA customer row (lead capture).
 * - Does NOT authenticate with Shopify
 * - Does NOT change your login flow
 * - Safe to call even when Supabase is disabled (returns degraded)
 */
export async function upsertMegaCustomerLead({
  passId = null,
  email = null,
  userId = null,
  shopifyCustomerId = null,
  source = "shopify-sync",
} = {}) {
  const cleanEmail = normalizeEmail(email);
  const pid = canonicalizePassId({ passId, email: cleanEmail });

  // If Supabase isn’t configured, we still return ok so AuthGate never breaks.
  if (!sbEnabled()) {
    return {
      ok: true,
      passId: pid,
      degraded: true,
      degradedReason: "NO_SUPABASE",
    };
  }

  // Use your existing MEGA helper so schema stays centralized.
  await megaEnsureCustomer({
    passId: pid,
    email: cleanEmail,
    userId: userId ? String(userId) : null,
    shopifyCustomerId: shopifyCustomerId ? String(shopifyCustomerId) : null,
    source,
  });

  return { ok: true, passId: pid };
}

export default upsertMegaCustomerLead;
