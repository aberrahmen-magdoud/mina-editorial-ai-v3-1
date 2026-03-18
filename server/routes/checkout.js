// server/routes/checkout.js — Shopify checkout return + draft order creation
"use strict";

import express from "express";
import { safeString, normalizeIncomingPassId } from "../helpers.js";
import { getAuthUser, resolvePassIdForRequest } from "../auth-helpers.js";
import { shopifyAdminFetch } from "./shopify-webhook.js";

const router = express.Router();

const ENV = process.env;
const FRONTEND_URL = ENV.FRONTEND_URL || "https://mina.faltastudio.com";
const MATCHA_VARIANT_ID = ENV.MATCHA_VARIANT_ID || "43328351928403";
const MATCHA_5000_VARIANT_ID = ENV.MATCHA_5000_VARIANT_ID || "44184397283411";

router.get("/checkout/return", (_req, res) => {
  res.redirect(302, `${FRONTEND_URL}?checkout=complete`);
});

router.post("/api/checkout/create", async (req, res) => {
  try {
    const qty = Math.max(1, Math.min(100, Math.floor(Number(req.body?.qty || 1))));

    const resolved = resolvePassIdForRequest(req, req.body || {});
    const passId = normalizeIncomingPassId(resolved);
    if (!passId) return res.status(400).json({ ok: false, error: "MISSING_PASS_ID" });

    const authUser = await getAuthUser(req);
    const email = authUser?.email || req.body?.email || null;

    const is5000 = qty === 100 && MATCHA_5000_VARIANT_ID;
    const variantId = is5000 ? MATCHA_5000_VARIANT_ID : MATCHA_VARIANT_ID;
    const lineQty = is5000 ? 1 : qty;

    const draftOrder = {
      draft_order: {
        line_items: [{ variant_id: Number(variantId), quantity: lineQty }],
        note_attributes: [{ name: "mina_pass_id", value: passId }],
        use_customer_default_address: true,
      },
    };

    if (email) draftOrder.draft_order.email = email;

    const created = await shopifyAdminFetch("draft_orders.json", {
      method: "POST",
      body: draftOrder,
    });

    const invoiceUrl = created?.draft_order?.invoice_url;
    const draftId = created?.draft_order?.id;
    if (!invoiceUrl) {
      console.error("[checkout] draft order created but no invoice_url", created);
      return res.status(500).json({ ok: false, error: "NO_INVOICE_URL" });
    }

    return res.json({ ok: true, checkoutUrl: invoiceUrl, draftOrderId: draftId });
  } catch (e) {
    console.error("[checkout/create] failed", e);
    return res.status(500).json({ ok: false, error: "CHECKOUT_FAILED", message: e?.message || String(e) });
  }
});

export default router;
