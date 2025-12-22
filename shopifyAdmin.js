// shopifyAdmin.js (ESM) — Shopify Admin API helpers used by /auth/shopify-sync
"use strict";

const ENV = process.env;

const SHOPIFY_STORE_DOMAIN = String(ENV.SHOPIFY_STORE_DOMAIN || "").trim(); // MUST be *.myshopify.com
const SHOPIFY_ADMIN_TOKEN = String(ENV.SHOPIFY_ADMIN_TOKEN || "").trim();
const SHOPIFY_API_VERSION = String(ENV.SHOPIFY_API_VERSION || "2025-10").trim();
const SHOPIFY_MINA_TAG = String(ENV.SHOPIFY_MINA_TAG || "Mina_users").trim();

function isConfigured() {
  return !!(SHOPIFY_STORE_DOMAIN && SHOPIFY_ADMIN_TOKEN);
}

function normalizeEmail(email) {
  const e = String(email || "").trim().toLowerCase();
  return e || null;
}

export function getShopifyConfig() {
  return {
    configured: isConfigured(),
    storeDomain: SHOPIFY_STORE_DOMAIN || null,
    apiVersion: SHOPIFY_API_VERSION,
    tag: SHOPIFY_MINA_TAG,
  };
}

export async function shopifyAdminFetch(path, { method = "GET", body = null } = {}) {
  if (!isConfigured()) {
    const err = new Error("SHOPIFY_NOT_CONFIGURED");
    err.code = "SHOPIFY_NOT_CONFIGURED";
    throw err;
  }

  const url = `https://${SHOPIFY_STORE_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/${String(path).replace(
    /^\/+/,
    ""
  )}`;

  const resp = await fetch(url, {
    method,
    headers: {
      "X-Shopify-Access-Token": SHOPIFY_ADMIN_TOKEN,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await resp.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {}

  if (!resp.ok) {
    const err = new Error(`SHOPIFY_${resp.status}`);
    err.status = resp.status;
    err.body = json || text;
    throw err;
  }

  return json;
}

export async function findCustomerIdByEmail(email) {
  const e = normalizeEmail(email);
  if (!e) return null;

  const q = encodeURIComponent(`email:${e}`);
  const json = await shopifyAdminFetch(`customers/search.json?query=${q}`);

  const customers = Array.isArray(json?.customers) ? json.customers : [];
  if (!customers.length) return null;

  // Prefer exact email match if multiple results
  const hit =
    customers.find((c) => String(c?.email || "").trim().toLowerCase() === e) || customers[0];

  const id = hit?.id != null ? String(hit.id) : null;
  return id || null;
}

export async function addCustomerTag(customerId, tag = SHOPIFY_MINA_TAG) {
  const id = String(customerId || "").trim();
  const t = String(tag || "").trim();
  if (!id || !t) return { ok: false };

  const get = await shopifyAdminFetch(`customers/${id}.json`);
  const existingStr = get?.customer?.tags || "";
  const existing = String(existingStr)
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);

  if (existing.includes(t)) return { ok: true, already: true, tags: existing };

  const nextTags = [...existing, t].join(", ");
  await shopifyAdminFetch(`customers/${id}.json`, {
    method: "PUT",
    body: { customer: { id: Number(id), tags: nextTags } },
  });

  return { ok: true, already: false, tags: [...existing, t] };
}

/**
 * Main helper for /auth/shopify-sync.
 * Returns customerId if found + tagged, otherwise null.
 * If Shopify env/token are wrong -> throws (so you’ll see it in logs).
 */
export async function findAndTagCustomerByEmail(email, { tag = SHOPIFY_MINA_TAG } = {}) {
  const e = normalizeEmail(email);
  if (!e) return null;

  // If Shopify isn't configured, treat as "disabled" (non-blocking)
  if (!isConfigured()) return null;

  const customerId = await findCustomerIdByEmail(e);
  if (!customerId) return null;

  await addCustomerTag(customerId, tag);
  return customerId;
}
