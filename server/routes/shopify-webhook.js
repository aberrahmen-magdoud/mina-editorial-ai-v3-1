import express from "express";
import crypto from "node:crypto";

import { getSupabaseAdmin, sbEnabled } from "../../supabase.js";
import { megaAdjustCredits, megaEnsureCustomer, megaHasCreditRef } from "../../mega-db.js";
import { safeString } from "../utils/strings.js";
import { nowIso } from "../utils/time.js";

const ENV = process.env;

const SHOPIFY_STORE_DOMAIN = ENV.SHOPIFY_STORE_DOMAIN || "";
const SHOPIFY_ADMIN_TOKEN = ENV.SHOPIFY_ADMIN_TOKEN || "";
const SHOPIFY_API_VERSION = ENV.SHOPIFY_API_VERSION || "2025-10";
const SHOPIFY_ORDER_WEBHOOK_SECRET = ENV.SHOPIFY_ORDER_WEBHOOK_SECRET || "";
const SHOPIFY_MINA_TAG = ENV.SHOPIFY_MINA_TAG || "Mina_users";

let CREDIT_PRODUCT_MAP = {};
try {
  const raw = ENV.CREDIT_PRODUCT_MAP;
  CREDIT_PRODUCT_MAP = raw ? JSON.parse(raw) : {};
  if (!CREDIT_PRODUCT_MAP || typeof CREDIT_PRODUCT_MAP !== "object") CREDIT_PRODUCT_MAP = {};
} catch {
  CREDIT_PRODUCT_MAP = {};
}

function verifyShopifyWebhook({ secret, rawBody, hmacHeader }) {
  if (!secret || !rawBody || !hmacHeader) return false;
  const digest = crypto.createHmac("sha256", secret).update(rawBody, "utf8").digest("base64");
  const a = Buffer.from(digest);
  const b = Buffer.from(String(hmacHeader));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

async function shopifyAdminFetch(path, { method = "GET", body = null } = {}) {
  if (!SHOPIFY_STORE_DOMAIN || !SHOPIFY_ADMIN_TOKEN) throw new Error("SHOPIFY_NOT_CONFIGURED");

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

async function addCustomerTag(customerId, tag) {
  const id = String(customerId);
  const get = await shopifyAdminFetch(`customers/${id}.json`);
  const existingStr = get?.customer?.tags || "";
  const existing = existingStr
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);

  if (existing.includes(tag)) return { ok: true, already: true, tags: existing };
  const nextTags = [...existing, tag].join(", ");

  await shopifyAdminFetch(`customers/${id}.json`, {
    method: "PUT",
    body: { customer: { id: Number(id), tags: nextTags } },
  });

  return { ok: true, already: false, tags: [...existing, tag] };
}

function creditsFromOrder(order) {
  const items = Array.isArray(order?.line_items) ? order.line_items : [];
  let credits = 0;

  function parseMinaSkuCredits(skuRaw) {
    const sku = String(skuRaw || "").trim().toUpperCase();
    const m = sku.match(/^MINA-(\d+)\b/);
    if (!m) return 0;

    const n = Number(m[1]);
    if (!Number.isFinite(n)) return 0;

    const clamped = Math.max(0, Math.min(100000, Math.floor(n)));
    return clamped;
  }

  for (const li of items) {
    const sku = String(li?.sku || "").trim();
    const variantId = li?.variant_id != null ? String(li.variant_id) : "";

    const qtyRaw = li?.quantity;
    const qty = Math.max(1, Number.isFinite(Number(qtyRaw)) ? Math.floor(Number(qtyRaw)) : 1);

    const minaPerUnit = parseMinaSkuCredits(sku);
    if (minaPerUnit > 0) {
      credits += minaPerUnit * qty;
      continue;
    }

    let perUnit = 0;
    if (sku && Object.prototype.hasOwnProperty.call(CREDIT_PRODUCT_MAP, sku)) {
      perUnit = Number(CREDIT_PRODUCT_MAP[sku] || 0);
    } else if (variantId && Object.prototype.hasOwnProperty.call(CREDIT_PRODUCT_MAP, variantId)) {
      perUnit = Number(CREDIT_PRODUCT_MAP[variantId] || 0);
    }

    if (perUnit > 0) credits += perUnit * qty;
  }

  return credits;
}

const MEGA_CUSTOMERS_TABLE = "mega_customers";
const COL_PASS_ID = "mg_pass_id";
const COL_EMAIL = "mg_email";
const COL_SHOPIFY_ID = "mg_shopify_customer_id";
const COL_UPDATED_AT = "mg_updated_at";

async function findExistingPassIdForShopify({ supabase, shopifyCustomerId, email }) {
  if (!supabase) return null;

  const filters = [];
  if (shopifyCustomerId) filters.push(`${COL_SHOPIFY_ID}.eq.${shopifyCustomerId}`);
  if (email) filters.push(`${COL_EMAIL}.eq.${email}`);
  if (!filters.length) return null;

  const { data, error } = await supabase
    .from(MEGA_CUSTOMERS_TABLE)
    .select(`${COL_PASS_ID}, ${COL_EMAIL}, ${COL_SHOPIFY_ID}, ${COL_UPDATED_AT}`)
    .or(filters.join(","))
    .order(COL_UPDATED_AT, { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  return data?.[COL_PASS_ID] || null;
}

export function registerShopifyWebhook(app) {
  app.post("/api/credits/shopify-order", express.raw({ type: "application/json" }), async (req, res) => {
    const requestId = `shopify_${Date.now()}_${crypto.randomUUID()}`;

    try {
      const rawBody = req.body?.toString("utf8") || "";
      const hmac = req.get("X-Shopify-Hmac-Sha256") || req.get("x-shopify-hmac-sha256") || "";

      const ok = verifyShopifyWebhook({
        secret: SHOPIFY_ORDER_WEBHOOK_SECRET,
        rawBody,
        hmacHeader: hmac,
      });
      if (!ok) return res.status(401).json({ ok: false, error: "INVALID_HMAC", requestId });

      if (!sbEnabled()) return res.status(503).json({ ok: false, error: "NO_SUPABASE", requestId });

      const order = rawBody ? JSON.parse(rawBody) : {};
      const orderId = order?.id != null ? String(order.id) : null;
      if (!orderId) return res.status(400).json({ ok: false, error: "MISSING_ORDER_ID", requestId });

      const already = await megaHasCreditRef({ refType: "shopify_order", refId: orderId });
      if (already) return res.status(200).json({ ok: true, requestId, alreadyProcessed: true, orderId });

      const credits = creditsFromOrder(order);
      if (!credits) {
        return res
          .status(200)
          .json({ ok: true, requestId, orderId, credited: 0, reason: "NO_MATCHING_PRODUCT" });
      }

      const shopifyCustomerId = order?.customer?.id != null ? String(order.customer.id) : null;
      const email = safeString(order?.email || order?.customer?.email || "").toLowerCase() || null;

      const supabase = getSupabaseAdmin();

      const existingPassId = await findExistingPassIdForShopify({
        supabase,
        shopifyCustomerId,
        email,
      });

      const passId =
        existingPassId ||
        (shopifyCustomerId
          ? `pass:shopify:${shopifyCustomerId}`
          : email
            ? `pass:email:${email}`
            : `pass:anon:${crypto.randomUUID()}`);

      await megaEnsureCustomer({ passId, email, shopifyCustomerId: shopifyCustomerId || null, userId: null });
      await megaEnsureCustomer({ passId, email, shopifyCustomerId: shopifyCustomerId || null, userId: null });

      const grantedAt = order?.processed_at || order?.created_at || nowIso();

      const out = await megaAdjustCredits({
        passId,
        delta: credits,
        reason: "shopify-order",
        source: "shopify",
        refType: "shopify_order",
        refId: orderId,
        grantedAt,
      });

      if (shopifyCustomerId) {
        try {
          await addCustomerTag(shopifyCustomerId, SHOPIFY_MINA_TAG);
        } catch (e) {
          console.error("[shopify] add tag failed:", e?.message || e);
        }
      }

      return res.status(200).json({
        ok: true,
        requestId,
        orderId,
        passId,
        credited: credits,
        balance: out.creditsAfter,
        expiresAt: out.expiresAt,
      });
    } catch (e) {
      console.error("[shopify webhook] failed", e);
      return res
        .status(500)
        .json({ ok: false, error: "WEBHOOK_FAILED", requestId, message: e?.message || String(e) });
    }
  });
}
