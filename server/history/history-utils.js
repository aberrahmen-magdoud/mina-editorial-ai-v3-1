import { safeString } from "../utils/strings.js";

export function clampInt(n, min, max) {
  const x = Number(n);
  if (!Number.isFinite(x)) return min;
  return Math.max(min, Math.min(max, Math.floor(x)));
}

function tryParseJson(v) {
  if (!v) return null;
  if (typeof v === "object") return v;
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (!s) return null;
  if (!(s.startsWith("{") || s.startsWith("["))) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

// IMPORTANT: send only what Profile needs (inputs + assets), remove outputs (provider stuff)
export function sanitizeMmaVarsForClient(rawVars) {
  const vars = tryParseJson(rawVars) ?? rawVars ?? null;
  if (!vars || typeof vars !== "object") return null;

  return {
    meta: vars.meta ?? null,
    mode: vars.mode ?? null,
    inputs: vars.inputs ?? null,
    assets: vars.assets ?? null,
    history: vars.history ?? null,
    feedback: vars.feedback ?? null,
    settings: vars.settings ?? null,
    version: vars.version ?? null,
  };
}

// Keep pass:* untouched.
// If you receive a legacy anon-short id (uuid only), normalize it to pass:anon:<uuid>.
export function normalizePassId(raw) {
  const s = safeString(raw, "");
  if (!s) return "";
  if (s.startsWith("pass:")) return s;
  return `pass:anon:${s}`;
}

// Build a candidate list so history doesnâ€™t look empty due to legacy/passId mismatches.
export async function buildPassCandidates({ primaryPassId, authUser, supabase }) {
  const set = new Set();

  const pid = normalizePassId(primaryPassId);
  if (pid) set.add(pid);

  if (pid.startsWith("pass:anon:")) {
    set.add(pid.slice("pass:anon:".length));
  } else if (!pid.startsWith("pass:")) {
    set.add(`pass:anon:${pid}`);
  }

  if (authUser?.email) {
    set.add(`pass:email:${authUser.email}`);
  }

  try {
    if (supabase && (authUser?.email || authUser?.userId)) {
      let q = supabase.from("mega_customers").select("mg_pass_id").limit(50);

      if (authUser?.email && authUser?.userId) {
        const { data: byEmail } = await supabase
          .from("mega_customers")
          .select("mg_pass_id")
          .eq("mg_email", authUser.email)
          .limit(50);
        (byEmail || []).forEach((r) => r?.mg_pass_id && set.add(r.mg_pass_id));

        const { data: byUser } = await supabase
          .from("mega_customers")
          .select("mg_pass_id")
          .eq("mg_user_id", authUser.userId)
          .limit(50);
        (byUser || []).forEach((r) => r?.mg_pass_id && set.add(r.mg_pass_id));
      } else if (authUser?.email) {
        const { data } = await q.eq("mg_email", authUser.email);
        (data || []).forEach((r) => r?.mg_pass_id && set.add(r.mg_pass_id));
      } else if (authUser?.userId) {
        const { data } = await q.eq("mg_user_id", authUser.userId);
        (data || []).forEach((r) => r?.mg_pass_id && set.add(r.mg_pass_id));
      }
    }
  } catch {
    // optional
  }

  return Array.from(set).filter(Boolean).slice(0, 20);
}
