import { getSupabaseAdmin, sbEnabled } from "../../supabase.js";
import { megaEnsureCustomer } from "../../mega-db.js";
import { mergeCreditsByEmail } from "../shopify/mergeCreditsByEmail.js";
import { getAuthUser } from "../utils/auth.js";
import { normalizeIncomingPassId, setPassIdHeader } from "../utils/pass-id.js";

export function registerShopifySync(app) {
  app.post("/auth/shopify-sync", async (req, res) => {
    try {
      const authUser = await getAuthUser(req);

      if (!authUser?.userId) {
        return res.status(200).json({ ok: true, loggedIn: false });
      }

      const passId = normalizeIncomingPassId(`pass:user:${authUser.userId}`);
      setPassIdHeader(res, passId);

      if (sbEnabled()) {
        await megaEnsureCustomer({ passId, userId: authUser.userId, email: authUser.email || null });

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

      return res.status(200).json({ ok: true, loggedIn: true, passId, email: authUser.email || null });
    } catch {
      return res.status(200).json({ ok: true, loggedIn: false, degraded: true });
    }
  });
}
