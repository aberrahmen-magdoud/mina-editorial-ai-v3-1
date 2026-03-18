// server/routes/welcome-matcha.js — POST /api/welcome-matcha/claim
"use strict";

import express from "express";
import crypto from "node:crypto";
import { sbEnabled } from "../../supabase.js";
import {
  megaEnsureCustomer,
  megaGetCredits,
  megaAdjustCredits,
  megaHasCreditRef,
} from "../../mega-db.js";
import { normalizeIncomingPassId, nowIso } from "../helpers.js";
import { getAuthUser } from "../auth-helpers.js";

const router = express.Router();

router.post("/api/welcome-matcha/claim", async (req, res) => {
  const requestId = `welcome_${Date.now()}_${crypto.randomUUID()}`;

  try {
    if (!sbEnabled()) return res.status(503).json({ ok: false, requestId, error: "NO_SUPABASE" });

    const authUser = await getAuthUser(req);
    if (!authUser?.userId) {
      return res.status(401).json({ ok: false, requestId, error: "NOT_AUTHENTICATED" });
    }

    const passId = normalizeIncomingPassId(`pass:user:${authUser.userId}`);
    await megaEnsureCustomer({ passId, userId: authUser.userId, email: authUser.email || null });

    const refType = "welcome_matcha";
    const refId = `welcome:${passId}`;

    const already = await megaHasCreditRef({ refType, refId });
    if (already) {
      const { credits, expiresAt } = await megaGetCredits(passId);
      return res.json({ ok: true, requestId, passId, alreadyClaimed: true, balance: credits, expiresAt });
    }

    const result = await megaAdjustCredits({
      passId,
      delta: 5,
      reason: "welcome_matcha",
      source: "system",
      refType,
      refId,
      grantedAt: nowIso(),
    });

    return res.json({
      ok: true,
      requestId,
      passId,
      credited: 5,
      balance: result.creditsAfter,
      expiresAt: result.expiresAt,
    });
  } catch (e) {
    console.error("POST /api/welcome-matcha/claim failed", e);
    return res.status(500).json({ ok: false, requestId, error: "INTERNAL" });
  }
});

export default router;
