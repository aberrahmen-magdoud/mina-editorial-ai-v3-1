// server/routes/auth-sync.js — POST /auth/shopify-sync
"use strict";

import express from "express";
import { getSupabaseAdmin, sbEnabled } from "../../supabase.js";
import { megaEnsureCustomer } from "../../mega-db.js";
import { normalizeIncomingPassId, setPassIdHeader } from "../helpers.js";
import { getAuthUser } from "../auth-helpers.js";
import { mergeCreditsByEmail } from "./shopify-webhook.js";

const router = express.Router();

router.post("/auth/shopify-sync", async (req, res) => {
  try {
    const authUser = await getAuthUser(req);

    if (!authUser?.userId) {
      return res.status(200).json({ ok: true, loggedIn: false });
    }

    const passId = normalizeIncomingPassId(`pass:user:${authUser.userId}`);
    setPassIdHeader(res, passId);

    let isNewUser = false;
    if (sbEnabled()) {
      const ensureResult = await megaEnsureCustomer({ passId, userId: authUser.userId, email: authUser.email || null });
      isNewUser = !!ensureResult?.isNew;

      try {
        const supabase = getSupabaseAdmin();
        await mergeCreditsByEmail({
          supabase,
          primaryPassId: passId,
          email: authUser.email || null,
        });
      } catch (e) {
        console.warn("[shopify-sync] merge credits failed:", e?.message || e);
      }
    }

    return res.status(200).json({ ok: true, loggedIn: true, passId, email: authUser.email || null, isNewUser });
  } catch {
    return res.status(200).json({ ok: true, loggedIn: false, degraded: true });
  }
});

export default router;
