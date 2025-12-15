import { getSupabaseAdmin, logAdminAction, upsertProfileRow, upsertSessionRow } from "./supabase.js";

const ADMIN_SECRET = process.env.ADMIN_SECRET || "";
const ADMIN_DASHBOARD_KEY = process.env.ADMIN_DASHBOARD_KEY || "";
const ADMIN_ALLOWLIST = (process.env.ADMIN_ALLOWLIST || "")
  .split(",")
  .map((v) => v.trim().toLowerCase())
  .filter(Boolean);

function normalizeBearer(token) {
  if (!token) return null;
  const trimmed = token.trim();
  if (trimmed.toLowerCase().startsWith("bearer ")) {
    return trimmed.slice(7).trim();
  }
  return trimmed;
}

function isAllowlisted(email) {
  if (!ADMIN_ALLOWLIST.length) return true;
  if (!email) return false;
  return ADMIN_ALLOWLIST.includes(email.trim().toLowerCase());
}

function getRequestMeta(req) {
  return {
    ip: req.ip,
    userAgent: req.get("user-agent"),
    route: req.path,
    method: req.method,
  };
}

export async function tryAdmin(req, { audit = false } = {}) {
  const meta = getRequestMeta(req);
  const tokenFromHeader = normalizeBearer(
    req.get("authorization") || req.get("x-admin-secret")
  );
  const tokenFromQuery = normalizeBearer(req.query?.key);
  const token = tokenFromHeader || tokenFromQuery;

  if (!token) {
    if (audit) {
      void logAdminAction({
        action: "admin_denied",
        status: 401,
        route: meta.route,
        method: meta.method,
        detail: { reason: "missing_token", ip: meta.ip, userAgent: meta.userAgent },
      });
    }
    return { ok: false, status: 401 };
  }

  try {
    // Static secret shortcut for backward compatibility
    if (ADMIN_SECRET && token === ADMIN_SECRET) {
      const email = process.env.ADMIN_EMAIL || null;
      const userId = process.env.ADMIN_USER_ID || null;
      const allowlisted = isAllowlisted(email);
      const status = allowlisted ? 200 : 401;

      void upsertProfileRow({ userId, email });
      void upsertSessionRow({
        userId,
        email,
        token,
        ip: meta.ip,
        userAgent: meta.userAgent,
      });

      if (audit) {
        void logAdminAction({
          userId,
          email,
          action: allowlisted ? "admin_access" : "admin_denied",
          route: meta.route,
          method: meta.method,
          status,
          detail: {
            ip: meta.ip,
            userAgent: meta.userAgent,
            reason: allowlisted ? undefined : "not_allowlisted",
          },
        });
      }

      return { ok: allowlisted, status, email, userId };
    }

    if (ADMIN_DASHBOARD_KEY && token === ADMIN_DASHBOARD_KEY) {
      const email = process.env.ADMIN_EMAIL || null;
      const userId = process.env.ADMIN_USER_ID || null;
      const allowlisted = isAllowlisted(email);
      const status = allowlisted ? 200 : 401;

      void upsertProfileRow({ userId, email });
      void upsertSessionRow({
        userId,
        email,
        token,
        ip: meta.ip,
        userAgent: meta.userAgent,
      });

      if (audit) {
        void logAdminAction({
          userId,
          email,
          action: allowlisted ? "admin_access" : "admin_denied",
          route: meta.route,
          method: meta.method,
          status,
          detail: {
            ip: meta.ip,
            userAgent: meta.userAgent,
            reason: allowlisted ? undefined : "not_allowlisted",
          },
        });
      }

      return { ok: allowlisted, status, email, userId };
    }

    const supabase = getSupabaseAdmin();
    if (!supabase) {
      if (audit) {
        void logAdminAction({
          action: "admin_denied",
          status: 503,
          route: meta.route,
          method: meta.method,
          detail: {
            reason: "missing_supabase_env",
            ip: meta.ip,
            userAgent: meta.userAgent,
          },
        });
      }
      return { ok: false, status: 401 };
    }

    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data?.user) {
      if (audit) {
        void logAdminAction({
          action: "admin_denied",
          status: 401,
          route: meta.route,
          method: meta.method,
          detail: {
            reason: "invalid_token",
            ip: meta.ip,
            userAgent: meta.userAgent,
            error: error?.message,
          },
        });
      }
      return { ok: false, status: 401 };
    }

    const userId = data.user.id;
    const email = data.user.email || null;
    const allowlisted = isAllowlisted(email);
    const status = allowlisted ? 200 : 401;

    void upsertProfileRow({ userId, email });
    void upsertSessionRow({
      userId,
      email,
      token,
      ip: meta.ip,
      userAgent: meta.userAgent,
    });

    if (audit) {
      void logAdminAction({
        userId,
        email,
        action: allowlisted ? "admin_access" : "admin_denied",
        route: meta.route,
        method: meta.method,
        status,
        detail: {
          ip: meta.ip,
          userAgent: meta.userAgent,
          reason: allowlisted ? undefined : "not_allowlisted",
        },
      });
    }

    return { ok: allowlisted, status, email, userId };
  } catch (err) {
    console.error("[auth] tryAdmin failed", err);
    if (audit) {
      void logAdminAction({
        action: "admin_denied",
        status: 500,
        route: meta.route,
        method: meta.method,
        detail: {
          reason: "invalid_token",
          ip: meta.ip,
          userAgent: meta.userAgent,
          error: err?.message,
        },
      });
    }
    return { ok: false, status: 401 };
  }
}

export async function requireAdmin(req, res, next) {
  const result = await tryAdmin(req, { audit: true });
  if (!result.ok) {
    return res.status(result.status || 401).json({ error: "Unauthorized" });
  }
  req.user = { email: result.email || null, userId: result.userId || null };
  next();
}
