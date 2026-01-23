import { safeString } from "./strings.js";

// Keep pass:user:* intact.
// For pass:anon:* keep the short legacy behavior.
export function normalizeIncomingPassId(raw) {
  const s = safeString(raw, "");
  if (!s) return "";
  if (s.startsWith("pass:anon:")) return s.slice("pass:anon:".length).trim();
  return s;
}

export function setPassIdHeader(res, passId) {
  if (passId) res.set("X-Mina-Pass-Id", passId);
}
