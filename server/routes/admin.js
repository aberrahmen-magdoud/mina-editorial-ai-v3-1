// server/routes/admin.js — /admin/summary, /admin/credits/adjust
"use strict";

import express from "express";
import crypto from "node:crypto";
import { getSupabaseAdmin, sbEnabled, logAdminAction } from "../../supabase.js";
import { megaEnsureCustomer, megaAdjustCredits } from "../../mega-db.js";
import { requireAdmin } from "../../auth.js";
import { safeString, nowIso } from "../helpers.js";

const router = express.Router();

router.get("/admin/summary", requireAdmin, async (req, res) => {
  try {
    if (!sbEnabled()) return res.status(503).json({ ok: false, error: "NO_SUPABASE" });

    const supabase = getSupabaseAdmin();
    const { count, error } = await supabase
      .from("mega_customers")
      .select("mg_pass_id", { count: "exact", head: true });

    if (error) throw error;

    void logAdminAction({
      userId: req.user?.userId,
      email: req.user?.email,
      action: "admin.summary",
      status: 200,
      route: "/admin/summary",
      method: "GET",
      detail: { totalCustomers: count ?? 0 },
      ip: req.ip,
      userAgent: req.get("user-agent"),
    });

    return res.json({ ok: true, totalCustomers: count ?? 0, source: "mega_customers" });
  } catch (e) {
    console.error("GET /admin/summary failed", e);
    return res.status(500).json({ ok: false, error: "ADMIN_SUMMARY_FAILED", message: e?.message || String(e) });
  }
});

router.post("/admin/credits/adjust", requireAdmin, async (req, res) => {
  const requestId = `admcred_${Date.now()}_${crypto.randomUUID()}`;

  try {
    if (!sbEnabled()) return res.status(503).json({ ok: false, requestId, error: "NO_SUPABASE" });

    const { passId, delta, reason } = req.body || {};
    if (!passId || typeof delta !== "number") {
      return res.status(400).json({ ok: false, requestId, error: "passId and numeric delta are required" });
    }

    await megaEnsureCustomer({ passId: String(passId) });

    const out = await megaAdjustCredits({
      passId: String(passId),
      delta,
      reason: safeString(reason, "admin-adjust"),
      source: "admin",
      refType: "admin",
      refId: req.user?.userId || requestId,
      grantedAt: nowIso(),
    });

    return res.json({
      ok: true,
      requestId,
      passId: String(passId),
      creditsBefore: out.creditsBefore,
      creditsAfter: out.creditsAfter,
      expiresAt: out.expiresAt,
    });
  } catch (e) {
    console.error("POST /admin/credits/adjust failed", e);
    return res.status(500).json({ ok: false, requestId, error: "ADMIN_CREDITS_FAILED", message: e?.message || String(e) });
  }
});

export default router;
