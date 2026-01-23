import mmaRouter from "../mma/mma-router.js";
import mmaLogAdminRouter from "../../src/routes/admin/mma-logadmin.js";

import { sbEnabled } from "../../supabase.js";
import { megaEnsureCustomer } from "../../mega-db.js";
import { getAuthUser } from "../utils/auth.js";
import { normalizeIncomingPassId, setPassIdHeader } from "../utils/pass-id.js";
import { resolvePassIdForRequest } from "../utils/resolve-pass-id.js";

export function registerMmaRoutes(app) {
  app.use("/mma", async (req, res, next) => {
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
  });

  app.use("/mma", mmaRouter);
  app.use("/admin/mma", mmaLogAdminRouter);
}
