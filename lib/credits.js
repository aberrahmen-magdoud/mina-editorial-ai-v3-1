"use strict";

import crypto from "node:crypto";
import { sbEnabled } from "./supabase.js";
import { getAuthUser } from "./auth.js";
import {
  megaEnsureCustomer,
  megaGetCredits,
  megaWriteFeedback,
  megaWriteSession,
  normalizeIncomingPassId,
  resolvePassId,
  setPassIdHeader,
} from "./mega.js";
import { nowIso, safeString } from "./utils.js";

export function registerCreditsRoutes(app) {
  app.get("/credits/balance", async (req, res) => {
    const requestId = `credits_${Date.now()}_${crypto.randomUUID()}`;

    try {
      if (!sbEnabled()) return res.status(503).json({ ok: false, requestId, error: "NO_SUPABASE" });

      const q = normalizeIncomingPassId(req.query.customerId || req.query.passId || "");
      const passId = q || normalizeIncomingPassId(resolvePassId(req, { customerId: q }));
      setPassIdHeader(res, passId);

      const authUser = await getAuthUser(req);
      await megaEnsureCustomer({ passId, userId: authUser?.userId || null, email: authUser?.email || null });

      const { credits, expiresAt } = await megaGetCredits(passId);
      return res.json({ ok: true, requestId, passId, balance: credits, expiresAt, source: "mega_customers" });
    } catch (e) {
      console.error("GET /credits/balance failed", e);
      return res
        .status(500)
        .json({ ok: false, requestId, error: "CREDITS_FAILED", message: e?.message || String(e) });
    }
  });

  app.post("/sessions/start", async (req, res) => {
    const requestId = `sess_${Date.now()}_${crypto.randomUUID()}`;

    try {
      if (!sbEnabled()) return res.status(503).json({ ok: false, requestId, error: "NO_SUPABASE" });

      const body = req.body || {};
      const passId = normalizeIncomingPassId(resolvePassId(req, body));
      setPassIdHeader(res, passId);

      const authUser = await getAuthUser(req);
      await megaEnsureCustomer({ passId, userId: authUser?.userId || null, email: authUser?.email || null });

      const sessionId = crypto.randomUUID();
      const platform = safeString(body.platform, "web").toLowerCase();
      const title = safeString(body.title, "Mina session");

      await megaWriteSession({
        passId,
        sessionId,
        platform,
        title,
        meta: { requestId, ip: req.ip, userAgent: req.get("user-agent") },
      });

      return res.json({
        ok: true,
        requestId,
        passId,
        sessionId,
        session: { id: sessionId, platform, title, createdAt: nowIso() },
      });
    } catch (e) {
      console.error("POST /sessions/start failed", e);
      return res
        .status(500)
        .json({ ok: false, requestId, error: "SESSION_FAILED", message: e?.message || String(e) });
    }
  });

  app.post("/feedback/like", async (req, res) => {
    const requestId = `like_${Date.now()}_${crypto.randomUUID()}`;

    try {
      if (!sbEnabled()) return res.status(503).json({ ok: false, requestId, error: "NO_SUPABASE" });

      const body = req.body || {};
      const passId = normalizeIncomingPassId(resolvePassId(req, body));
      setPassIdHeader(res, passId);

      const authUser = await getAuthUser(req);
      await megaEnsureCustomer({ passId, userId: authUser?.userId || null, email: authUser?.email || null });

      const generationId = safeString(body.generationId || body.generation_id, null);

      const payload = {
        event_type: "feedback.like",
        liked: body.liked !== false,
        resultType: safeString(body.resultType, "image"),
        platform: safeString(body.platform, "web"),
        prompt: safeString(body.prompt, ""),
        comment: safeString(body.comment, ""),
        imageUrl: safeString(body.imageUrl, ""),
        videoUrl: safeString(body.videoUrl, ""),
        sessionId: safeString(body.sessionId, ""),
        createdAt: nowIso(),
      };

      const out = await megaWriteFeedback({ passId, generationId, payload });
      return res.json({ ok: true, requestId, passId, feedbackId: out.feedbackId });
    } catch (e) {
      console.error("POST /feedback/like failed", e);
      return res
        .status(500)
        .json({ ok: false, requestId, error: "FEEDBACK_FAILED", message: e?.message || String(e) });
    }
  });
}
