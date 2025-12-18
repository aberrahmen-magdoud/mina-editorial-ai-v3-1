import { normalizeError } from "./normalizeError.js";
import { logError } from "./logError.js";

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
