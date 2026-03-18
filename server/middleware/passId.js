// server/middleware/passId.js — passId normalization middleware for MMA & Fingertips
"use strict";

import { sbEnabled } from "../../supabase.js";
import { megaEnsureCustomer } from "../../mega-db.js";
import { normalizeIncomingPassId, setPassIdHeader } from "../helpers.js";
import { getAuthUser, resolvePassIdForRequest } from "../auth-helpers.js";

export function mmaPassIdMiddleware(req, res, next) {
  (async () => {
    try {
      if (req.method !== "POST") return next();

      const resolved = resolvePassIdForRequest(req, req.body || {});
      const passId = normalizeIncomingPassId(resolved);
      setPassIdHeader(res, passId);

      req.body = req.body || {};
      if (!req.body.passId) req.body.passId = passId;
      if (!req.body.pass_id) req.body.pass_id = passId;

      if (sbEnabled()) {
        const authUser = await getAuthUser(req);
        await megaEnsureCustomer({
          passId,
          userId: authUser?.userId || null,
          email: authUser?.email || null,
        });
      }

      return next();
    } catch (e) {
      console.error("[mma passId middleware] failed", e);
      return res.status(500).json({
        ok: false,
        error: "MMA_PASSID_MW_FAILED",
        message: e?.message || String(e),
      });
    }
  })();
}

export function fingertipsPassIdMiddleware(req, res, next) {
  (async () => {
    try {
      if (req.method !== "POST" && req.method !== "GET") return next();

      const resolved = resolvePassIdForRequest(req, req.body || {});
      const passId = normalizeIncomingPassId(resolved);
      setPassIdHeader(res, passId);

      if (req.method === "POST") {
        req.body = req.body || {};
        if (!req.body.passId) req.body.passId = passId;
        if (!req.body.pass_id) req.body.pass_id = passId;
      }

      if (sbEnabled()) {
        const authUser = await getAuthUser(req);
        await megaEnsureCustomer({
          passId,
          userId: authUser?.userId || null,
          email: authUser?.email || null,
        });
      }

      return next();
    } catch (e) {
      console.error("[fingertips passId middleware] failed", e);
      return res.status(500).json({
        ok: false,
        error: "FINGERTIPS_PASSID_MW_FAILED",
        message: e?.message || String(e),
      });
    }
  })();
}
