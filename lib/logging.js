"use strict";

import crypto from "node:crypto";
import { getSupabaseAdmin } from "./supabase.js";
import { normalizeError } from "./errors.js";

export { normalizeError };

const FRONTEND_ACTION_PREFIX = "frontend.";

function emojiForContext({ status, action, sourceSystem } = {}) {
  if (typeof action === "string" && action.startsWith(FRONTEND_ACTION_PREFIX)) return "ðŸ–¥ï¸";
  if (sourceSystem === "mina-frontend") return "ðŸ–¥ï¸";
  if (typeof action === "string" && action.startsWith("process.unhandledRejection")) return "ðŸ§µ";
  if (typeof action === "string" && action.startsWith("process.uncaughtException")) return "ðŸ’¥";
  if (status === 401 || status === 403) return "ðŸš«";
  if (typeof status === "number" && status >= 500) return "ðŸ”¥";
  if (status === 408 || status === 504) return "â±ï¸";
  return "âš ï¸";
}

function formatErrorCode(emoji, code = "ERROR") {
  const resolvedEmoji = emoji || "âš ï¸";
  const resolvedCode = typeof code === "string" && code.trim() ? code.trim() : "ERROR";
  return `${resolvedEmoji} ${resolvedCode}`;
}

function isUuid(value) {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  );
}

function truncate(value, max) {
  if (typeof value !== "string") return "";
  if (value.length <= max) return value;
  return `${value.slice(0, max)}â€¦[truncated ${value.length - max} chars]`;
}

export async function logError(input = {}) {
  const safeInput = input || {};
  const status = Number.isFinite(safeInput.status) ? Number(safeInput.status) : 500;
  const emoji =
    safeInput.emoji ||
    emojiForContext({
      status,
      action: safeInput.action,
      sourceSystem: safeInput.sourceSystem,
    });
  const code = safeInput.code || "ERROR";
  const mgErrorCode = formatErrorCode(emoji, code);

  const messageRaw = safeInput.message || "Unknown error";
  const mgErrorMessage = truncate(String(messageRaw), 2000);

  const shouldStoreStack = process.env.NODE_ENV !== "production";
  const stackValue =
    shouldStoreStack && typeof safeInput.stack === "string"
      ? truncate(safeInput.stack, 4000)
      : null;

  const record = {
    mg_id: crypto.randomUUID(),
    mg_record_type: "error",
    mg_action: safeInput.action || "internal.error",
    mg_status: status,
    mg_route: safeInput.route || null,
    mg_method: safeInput.method || null,
    mg_user_id: isUuid(safeInput.userId) ? safeInput.userId : null,
    mg_email: safeInput.email || null,
    mg_ip: safeInput.ip || null,
    mg_user_agent: safeInput.userAgent || null,
    mg_error_message: mgErrorMessage,
    mg_error_stack: stackValue,
    mg_error_code: mgErrorCode,
    mg_detail: safeInput.detail || {},
    mg_payload: safeInput.payload || safeInput.detail || {},
    mg_source_system: safeInput.sourceSystem || "mina-editorial-ai",
    mg_event_at: new Date().toISOString(),
  };

  try {
    const supabase = getSupabaseAdmin();
    if (!supabase) {
      console.error("[logError] Supabase admin client not configured");
      return null;
    }

    const { error } = await supabase.from("mega_admin").insert([record]);
    if (error) {
      console.error("[logError] failed to insert error log", error);
    }
  } catch (err) {
    console.error("[logError] unexpected failure", err);
  }

  return record.mg_id;
}

export async function errorMiddleware(err, req, res, _next) {
  const normalized = normalizeError(err);
  const status = err?.statusCode || err?.status || 500;

  await logError({
    action: "api.error",
    status,
    route: req.originalUrl || req.url,
    method: req.method,
    ip: req.headers["x-forwarded-for"] || req.ip,
    userAgent: req.get("user-agent"),
    message: normalized.message,
    stack: normalized.stack,
    code: "API_ERROR",
    detail: { name: normalized.name },
    sourceSystem: "mina-editorial-ai",
  });

  res.status(status).json({ error: "Internal server error" });
}
