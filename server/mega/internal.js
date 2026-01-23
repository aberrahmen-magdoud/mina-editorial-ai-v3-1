import { getSupabaseAdmin } from "../../supabase.js";

export function nowIso() {
  return new Date().toISOString();
}

export function safeString(v, fallback = "") {
  if (v === null || v === undefined) return fallback;
  const s = typeof v === "string" ? v : String(v);
  const t = s.trim();
  return t.length ? t : fallback;
}

export function normalizeEmail(email) {
  const e = safeString(email, "").toLowerCase();
  return e || null;
}

export function intOr(v, fallback = 0) {
  const n = Number.parseInt(String(v ?? ""), 10);
  return Number.isFinite(n) ? n : fallback;
}

export function requireSupabase() {
  const supabase = getSupabaseAdmin();
  if (!supabase) throw new Error("SUPABASE_NOT_CONFIGURED");
  return supabase;
}

export function addDaysIso(baseIso, days) {
  const d = baseIso ? new Date(baseIso) : new Date();
  d.setUTCDate(d.getUTCDate() + Number(days || 0));
  return d.toISOString();
}

export function maxIso(a, b) {
  const ta = a ? Date.parse(a) : NaN;
  const tb = b ? Date.parse(b) : NaN;
  if (!Number.isFinite(ta) && !Number.isFinite(tb)) return null;
  if (!Number.isFinite(ta)) return b || null;
  if (!Number.isFinite(tb)) return a || null;
  return ta >= tb ? a : b;
}
