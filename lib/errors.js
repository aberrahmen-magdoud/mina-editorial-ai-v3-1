"use strict";

export function normalizeError(err) {
  if (!err) {
    return { name: "Error", message: "Unknown error", stack: undefined };
  }

  if (typeof err === "string") {
    return { name: "Error", message: err, stack: undefined };
  }

  const name = typeof err.name === "string" && err.name.trim() ? err.name : "Error";
  const message = typeof err.message === "string" && err.message.trim()
    ? err.message
    : String(err);
  const stack = typeof err.stack === "string" && err.stack.trim() ? err.stack : undefined;

  return { name, message, stack };
}

export function makeHttpError(statusCode, code, extra = {}) {
  const err = new Error(code);
  err.statusCode = statusCode;
  err.code = code;
  Object.assign(err, extra);
  return err;
}

export function makeProviderError(code, provider = null, extra = {}) {
  const err = new Error(code);
  err.code = code;
  if (provider && typeof provider === "object") {
    err.provider = provider;
  }
  Object.assign(err, extra);
  return err;
}

export function isSafetyBlockError(err) {
  const msg = String(err?.message || err || "").toLowerCase();
  return (
    msg.includes("nsfw") ||
    msg.includes("nud") ||
    msg.includes("nude") ||
    msg.includes("sexual") ||
    msg.includes("safety") ||
    msg.includes("policy") ||
    (msg.includes("content") && msg.includes("block"))
  );
}
