import { resolvePassId as megaResolvePassId } from "../../mega-db.js";

export function resolvePassIdForRequest(req, bodyLike = {}) {
  return megaResolvePassId(req, bodyLike);
}
