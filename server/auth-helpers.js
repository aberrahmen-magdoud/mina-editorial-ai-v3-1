// server/auth-helpers.js — bearer token extraction + Supabase user resolution
"use strict";

import { getSupabaseAdmin } from "../supabase.js";
import { resolvePassId as megaResolvePassId } from "../mega-db.js";
import { safeString } from "./helpers.js";

export function getBearerToken(req) {
  const raw = String(req.headers.authorization || "");
  const match = raw.match(/^Bearer\s+(.+)$/i);
  if (!match) return null;

  const token = match[1].trim();
  const lower = token.toLowerCase();
  if (!token || lower === "null" || lower === "undefined" || lower === "[object object]") return null;
  return token;
}

export async function getAuthUser(req) {
  const token = getBearerToken(req);
  if (!token) return null;

  const supabase = getSupabaseAdmin();
  if (!supabase) return null;

  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user) return null;

  const userId = safeString(data.user.id, "");
  const email = safeString(data.user.email, "").toLowerCase() || null;
  if (!userId) return null;

  return { userId, email, token };
}

export function resolvePassIdForRequest(req, bodyLike = {}) {
  return megaResolvePassId(req, bodyLike);
}
