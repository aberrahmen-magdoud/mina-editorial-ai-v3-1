import { megaAdjustCredits, megaEnsureCustomer, megaGetCredits, megaHasCreditRef } from "../../mega-db.js";
import { nowIso } from "../utils/time.js";

// NOTE: adjust these column names ONLY if your mega_customers schema differs
const MEGA_CUSTOMERS_TABLE = "mega_customers";
const COL_PASS_ID = "mg_pass_id";
const COL_EMAIL = "mg_email";
const COL_SHOPIFY_ID = "mg_shopify_customer_id";
const COL_UPDATED_AT = "mg_updated_at";

// Merge credits from any other passIds with the same email into primaryPassId.
// This fixes "I bought on Shopify but my app balance did not change".
export async function mergeCreditsByEmail({ supabase, primaryPassId, email }) {
  if (!supabase || !primaryPassId || !email) return;

  const { data, error } = await supabase
    .from(MEGA_CUSTOMERS_TABLE)
    .select(`${COL_PASS_ID}, ${COL_EMAIL}, ${COL_SHOPIFY_ID}, ${COL_UPDATED_AT}`)
    .eq(COL_EMAIL, email)
    .order(COL_UPDATED_AT, { ascending: false })
    .limit(10);

  if (error) throw error;

  const rows = Array.isArray(data) ? data : [];
  for (const r of rows) {
    const otherPassId = r?.[COL_PASS_ID];
    const otherShopifyId = r?.[COL_SHOPIFY_ID] || null;
    if (!otherPassId || otherPassId === primaryPassId) continue;

    if (otherShopifyId) {
      try {
        await megaEnsureCustomer({
          passId: primaryPassId,
          email,
          shopifyCustomerId: String(otherShopifyId),
          userId: null,
        });
      } catch {}
    }

    const { credits: otherCredits } = await megaGetCredits(otherPassId);
    const amount = Number(otherCredits || 0);
    if (amount <= 0) continue;

    const refId = `merge:${otherPassId}=>${primaryPassId}`;

    const already = await megaHasCreditRef({ refType: "merge", refId });
    if (already) continue;

    await megaAdjustCredits({
      passId: primaryPassId,
      delta: amount,
      reason: "credits-merge-in",
      source: "shopify-sync",
      refType: "merge",
      refId,
      grantedAt: nowIso(),
    });

    await megaAdjustCredits({
      passId: otherPassId,
      delta: -amount,
      reason: "credits-merge-out",
      source: "shopify-sync",
      refType: "merge_out",
      refId,
      grantedAt: nowIso(),
    });
  }
}
