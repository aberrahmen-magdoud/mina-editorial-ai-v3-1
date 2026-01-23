import crypto from "node:crypto";
import { safeString } from "./internal.js";

// priority: body.customerId/passId -> header X-Mina-Pass-Id -> anon
export function resolvePassId(req, body = {}) {
  const fromBody = safeString(body?.customerId || body?.passId || body?.pass_id, "");
  if (fromBody) return fromBody;

  const fromHeader = safeString(req?.get?.("X-Mina-Pass-Id") || req?.get?.("x-mina-pass-id"), "");
  if (fromHeader) return fromHeader;

  return `pass:anon:${crypto.randomUUID()}`;
}
