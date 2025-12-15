import crypto from "node:crypto";
import { createClient } from "@supabase/supabase-js";

let cachedClient = null;

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function normalizeEmail(email) {
  if (!email || typeof email !== "string") return null;
  const trimmed = email.trim().toLowerCase();
  return trimmed || null;
}

function safeUserAgent(userAgent) {
  if (!userAgent) return null;
  const str = String(userAgent);
  return str.slice(0, 512);
}

function safeIp(ip) {
  if (!ip) return null;
  return String(ip).slice(0, 128);
}

export function getSupabaseAdmin() {
  try {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) {
      console.error(
        "[supabase] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY; skipping Supabase admin client."
      );
      return null;
    }

    if (cachedClient) return cachedClient;

    cachedClient = createClient(url, key, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    });

    return cachedClient;
  } catch (err) {
    console.error("[supabase] Failed to init admin client", err);
    return null;
  }
}

export async function upsertProfileRow({ userId, email, shopifyCustomerId }) {
  try {
    const supabase = getSupabaseAdmin();
    if (!supabase) return;

    const normalizedEmail = normalizeEmail(email);
    if (!userId) return;
    if (!UUID_REGEX.test(userId)) {
      console.error("[supabase] upsertProfileRow skipped invalid userId", userId);
      return;
    }

    const now = new Date().toISOString();
    const payload = {
      user_id: userId,
      email: normalizedEmail,
      shopify_customer_id: shopifyCustomerId || null,
      updated_at: now,
      created_at: now,
    };

    const { error } = await supabase
      .from("profiles")
      .upsert(payload, { onConflict: "user_id" });
    if (error) {
      console.error("[supabase] upsertProfileRow error", error);
    }
  } catch (err) {
    console.error("[supabase] upsertProfileRow failed", err);
  }
}

export async function upsertSessionRow({
  userId,
  email,
  token,
  ip,
  userAgent,
}) {
  try {
    const supabase = getSupabaseAdmin();
    if (!supabase) return;
    if (!token) {
      console.error("[supabase] upsertSessionRow missing token");
      return;
    }

    const normalizedEmail = normalizeEmail(email);
    const validUserId = userId && UUID_REGEX.test(userId) ? userId : null;
    const hash = crypto.createHash("sha256").update(String(token)).digest("hex");
    const now = new Date().toISOString();

    const payload = {
      session_hash: hash,
      user_id: validUserId,
      email: normalizedEmail,
      ip: safeIp(ip),
      user_agent: safeUserAgent(userAgent),
      first_seen_at: now,
      last_seen_at: now,
      updated_at: now,
    };

    const { error } = await supabase
      .from("admin_sessions")
      .upsert(payload, { onConflict: "session_hash" });
    if (error) {
      console.error("[supabase] upsertSessionRow error", error);
    }
  } catch (err) {
    console.error("[supabase] upsertSessionRow failed", err);
  }
}

export async function logAdminAction({
  userId,
  email,
  action,
  route,
  method,
  status,
  detail,
  id,
}) {
  try {
    const supabase = getSupabaseAdmin();
    if (!supabase) return;

    const normalizedEmail = normalizeEmail(email);
    const validUserId = userId && UUID_REGEX.test(userId) ? userId : null;
    const now = new Date().toISOString();

    const payload = {
      id: id || crypto.randomUUID(),
      user_id: validUserId,
      email: normalizedEmail,
      action: action || null,
      route: route || null,
      method: method || null,
      status: typeof status === "number" ? status : null,
      detail: detail ?? null,
      created_at: now,
    };

    const { error } = await supabase.from("admin_audit").insert(payload);
    if (error) {
      console.error("[supabase] logAdminAction error", error);
    }
  } catch (err) {
    console.error("[supabase] logAdminAction failed", err);
  }
}

export async function upsertGenerationRow({
  id,
  userId,
  email,
  requestId,
  sessionId,
  model,
  provider,
  status,
  inputChars,
  outputChars,
  latencyMs,
  detail,
}) {
  try {
    const supabase = getSupabaseAdmin();
    if (!supabase) return;
    if (!id) {
      console.error("[supabase] upsertGenerationRow requires id");
      return;
    }

    const normalizedEmail = normalizeEmail(email);
    const validUserId = userId && UUID_REGEX.test(userId) ? userId : null;
    const now = new Date().toISOString();

    const payload = {
      id,
      user_id: validUserId,
      email: normalizedEmail,
      request_id: requestId || null,
      session_id: sessionId || null,
      model: model || null,
      provider: provider || null,
      status: status || null,
      input_chars: typeof inputChars === "number" ? inputChars : null,
      output_chars: typeof outputChars === "number" ? outputChars : null,
      latency_ms: typeof latencyMs === "number" ? latencyMs : null,
      detail: detail ?? null,
      created_at: now,
      updated_at: now,
    };

    const { error } = await supabase
      .from("generations")
      .upsert(payload, { onConflict: "id" });
    if (error) {
      console.error("[supabase] upsertGenerationRow error", error);
    }
  } catch (err) {
    console.error("[supabase] upsertGenerationRow failed", err);
  }
}
