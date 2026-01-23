import crypto from "node:crypto";
import { safeStr } from "./mma-shared.js";

// If you ever want to stop storing plaintext emails inside passId, set:
// MMA_PASSID_HASH_EMAIL=true (will create new passIds for same users).
const MMA_PASSID_HASH_EMAIL = String(process.env.MMA_PASSID_HASH_EMAIL || "").toLowerCase() === "true";

function hashEmail(email) {
  const e = safeStr(email, "").toLowerCase();
  if (!e) return "";
  return crypto.createHash("sha256").update(e).digest("hex").slice(0, 40);
}

export function computePassId({ shopifyCustomerId, userId, email }) {
  const normalizedShopify = safeStr(shopifyCustomerId, "");
  if (normalizedShopify && normalizedShopify !== "anonymous") {
    return `pass:shopify:${normalizedShopify}`;
  }

  const normalizedUser = safeStr(userId, "");
  if (normalizedUser) return `pass:user:${normalizedUser}`;

  const normalizedEmail = safeStr(email, "").toLowerCase();
  if (normalizedEmail) {
    if (MMA_PASSID_HASH_EMAIL) return `pass:emailhash:${hashEmail(normalizedEmail)}`;
    return `pass:email:${normalizedEmail}`;
  }

  return `pass:anon:${crypto.randomUUID()}`;
}
