// server.js — MMA + MEGA only (Supabase service-role). No legacy editorial/motion shims.
"use strict";

import "dotenv/config";
import express from "express";
import cors from "cors";
import crypto from "node:crypto";

import Replicate from "replicate";
import OpenAI from "openai";

import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

import { normalizeError } from "./server/logging/normalizeError.js";
import { logError } from "./server/logging/logError.js";
import { errorMiddleware } from "./server/logging/errorMiddleware.js";

import {
  getSupabaseAdmin,
  sbEnabled,
  logAdminAction,
  upsertSessionRow,
  upsertProfileRow,
} from "./supabase.js";

import {
  resolvePassId as megaResolvePassId,
  megaEnsureCustomer,
  megaGetCredits,
  megaAdjustCredits,
  megaHasCreditRef,
  megaWriteSession,
  megaWriteFeedback,
} from "./mega-db.js";

import { parseDataUrl } from "./r2.js";
import { requireAdmin } from "./auth.js";

// MMA (robust import; supports router being a Router OR a factory)
import mmaRouterMod from "./server/mma/mma-router.js";
import * as mmaControllerMod from "./server/mma/mma-controller.js";

// Admin MMA logs router (your existing)
import mmaLogAdminRouter from "./src/routes/admin/mma-logadmin.js";

// ======================================================
// Env / boot
// ======================================================
const ENV = process.env;
const IS_PROD = ENV.NODE_ENV === "production";
const PORT = Number(ENV.PORT || 8080);

const app = express();
app.set("trust proxy", 1);

// ======================================================
// Process-level crash logging
// ======================================================
process.on("unhandledRejection", async (reason) => {
  const normalized = normalizeError(reason);
  try {
    await logError({
      action: "process.unhandledRejection",
      status: 500,
      message: normalized.message,
      stack: normalized.stack,
      emoji: "🧵",
      code: "UNHANDLED_REJECTION",
    });
  } catch (err) {
    console.error("[process.unhandledRejection] failed to log", err);
  }
});

process.on("uncaughtException", async (err) => {
  const normalized = normalizeError(err);
  try {
    await logError({
      action: "process.uncaughtException",
      status: 500,
      message: normalized.message,
      stack: normalized.stack,
      emoji: "💥",
      code: "UNCAUGHT_EXCEPTION",
    });
  } catch (loggingError) {
    console.error("[process.uncaughtException] failed to log", loggingError);
  }
});

// ======================================================
// Small helpers
// ======================================================
function nowIso() {
  return new Date().toISOString();
}

function safeString(v, fallback = "") {
  if (v === null || v === undefined) return fallback;
  const s = typeof v === "string" ? v : String(v);
  const t = s.trim();
  return t ? t : fallback;
}

function getBearerToken(req) {
  const raw = String(req.headers.authorization || "");
  const m = raw.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  const token = m[1].trim();
  const lower = token.toLowerCase();
  if (!token || lower === "null" || lower === "undefined" || lower === "[object object]") return null;
  return token;
}

async function getAuthUser(req) {
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

// PassId resolution: header/body/query → else stable user → else anon
function resolvePassIdForRequest(req, bodyLike = {}) {
  // 1) your mega-db resolver (body.customerId or x-mina-pass-id or anon)
  const passFromMega = megaResolvePassId(req, bodyLike);
  const normalized = safeString(passFromMega, "");
  if (normalized) return normalized;

  // Should never happen (megaResolvePassId always returns something), but fallback:
  return `pass:anon:${crypto.randomUUID()}`;
}

function setPassIdHeader(res, passId) {
  if (!passId) return;
  res.set("X-Mina-Pass-Id", passId);
}

function looksLikeExpressRouter(x) {
  return (
    typeof x === "function" &&
    typeof x.use === "function" &&
    Array.isArray(x.stack)
  );
}

// ======================================================
// CORS (allowlist)
// ======================================================
const defaultAllowlist = [
  "http://mina.faltastudio.com",
  "https://mina-app-bvpn.onrender.com",
];

const envAllowlist = (ENV.CORS_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const allowlist = Array.from(new Set([...defaultAllowlist, ...envAllowlist]));

const corsOptions = {
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    if (allowlist.length === 0) return cb(null, false);
    return cb(null, allowlist.includes(origin));
  },
  credentials: false,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "X-Mina-Pass-Id"],
  exposedHeaders: ["X-Mina-Pass-Id"],
  optionsSuccessStatus: 204,
};

app.use(cors(corsOptions));
app.options("*", cors(corsOptions));

// Ensure X-Mina-Pass-Id is exposed even if upstream set something else
app.use((req, res, next) => {
  const existing = res.get("Access-Control-Expose-Headers");
  const headers = existing
    ? existing
        .split(",")
        .map((h) => h.trim())
        .filter(Boolean)
    : [];
  if (!headers.some((h) => h.toLowerCase() === "x-mina-pass-id")) headers.push("X-Mina-Pass-Id");
  res.set("Access-Control-Expose-Headers", headers.join(", "));
  next();
});

// ======================================================
// Shopify webhook (RAW body + HMAC verify) — credits -> MEGA
// ======================================================
const SHOPIFY_STORE_DOMAIN = ENV.SHOPIFY_STORE_DOMAIN || "";
const SHOPIFY_ADMIN_TOKEN = ENV.SHOPIFY_ADMIN_TOKEN || "";
const SHOPIFY_API_VERSION = ENV.SHOPIFY_API_VERSION || "2025-10";
const SHOPIFY_ORDER_WEBHOOK_SECRET = ENV.SHOPIFY_ORDER_WEBHOOK_SECRET || "";
const SHOPIFY_MINA_TAG = ENV.SHOPIFY_MINA_TAG || "Mina_users";
const SHOPIFY_WELCOME_MATCHA_VARIANT_ID = String(ENV.SHOPIFY_WELCOME_MATCHA_VARIANT_ID || "");

let CREDIT_PRODUCT_MAP = {};
try {
  const raw = ENV.CREDIT_PRODUCT_MAP;
  CREDIT_PRODUCT_MAP = raw ? JSON.parse(raw) : {};
  if (!CREDIT_PRODUCT_MAP || typeof CREDIT_PRODUCT_MAP !== "object") CREDIT_PRODUCT_MAP = {};
} catch {
  CREDIT_PRODUCT_MAP = {};
}

function verifyShopifyWebhook({ secret, rawBody, hmacHeader }) {
  if (!secret || !rawBody || !hmacHeader) return false;
  const digest = crypto.createHmac("sha256", secret).update(rawBody, "utf8").digest("base64");
  const a = Buffer.from(digest);
  const b = Buffer.from(String(hmacHeader));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

async function shopifyAdminFetch(path, { method = "GET", body = null } = {}) {
  if (!SHOPIFY_STORE_DOMAIN || !SHOPIFY_ADMIN_TOKEN) throw new Error("SHOPIFY_NOT_CONFIGURED");

  const url = `https://${SHOPIFY_STORE_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/${String(path).replace(
    /^\/+/,
    ""
  )}`;

  const resp = await fetch(url, {
    method,
    headers: {
      "X-Shopify-Access-Token": SHOPIFY_ADMIN_TOKEN,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await resp.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {}

  if (!resp.ok) {
    const err = new Error(`SHOPIFY_${resp.status}`);
    err.status = resp.status;
    err.body = json || text;
    throw err;
  }

  return json;
}

async function addCustomerTag(customerId, tag) {
  const id = String(customerId);
  const get = await shopifyAdminFetch(`customers/${id}.json`);
  const existingStr = get?.customer?.tags || "";
  const existing = existingStr
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);

  if (existing.includes(tag)) return { ok: true, already: true, tags: existing };
  const nextTags = [...existing, tag].join(", ");

  await shopifyAdminFetch(`customers/${id}.json`, {
    method: "PUT",
    body: { customer: { id: Number(id), tags: nextTags } },
  });

  return { ok: true, already: false, tags: [...existing, tag] };
}

function creditsFromOrder(order) {
  const items = Array.isArray(order?.line_items) ? order.line_items : [];
  let credits = 0;

  for (const li of items) {
    const sku = String(li?.sku || "").trim();
    const variantId = li?.variant_id != null ? String(li.variant_id) : "";

    if (SHOPIFY_WELCOME_MATCHA_VARIANT_ID && variantId === SHOPIFY_WELCOME_MATCHA_VARIANT_ID) {
      credits += 50;
      continue;
    }

    if (sku && Object.prototype.hasOwnProperty.call(CREDIT_PRODUCT_MAP, sku)) {
      credits += Number(CREDIT_PRODUCT_MAP[sku] || 0);
    }
  }

  return credits;
}

// Raw webhook MUST be before express.json()
app.post("/api/credits/shopify-order", express.raw({ type: "application/json" }), async (req, res) => {
  const requestId = `shopify_${Date.now()}_${crypto.randomUUID()}`;

  try {
    const rawBody = req.body?.toString("utf8") || "";
    const hmac = req.get("X-Shopify-Hmac-Sha256") || req.get("x-shopify-hmac-sha256") || "";

    const ok = verifyShopifyWebhook({
      secret: SHOPIFY_ORDER_WEBHOOK_SECRET,
      rawBody,
      hmacHeader: hmac,
    });
    if (!ok) return res.status(401).json({ ok: false, error: "INVALID_HMAC", requestId });

    if (!sbEnabled()) return res.status(503).json({ ok: false, error: "NO_SUPABASE", requestId });

    const order = rawBody ? JSON.parse(rawBody) : {};
    const orderId = order?.id != null ? String(order.id) : null;
    if (!orderId) return res.status(400).json({ ok: false, error: "MISSING_ORDER_ID", requestId });

    // Idempotency (MEGA ledger)
    const already = await megaHasCreditRef({ refType: "shopify_order", refId: orderId });
    if (already) return res.status(200).json({ ok: true, requestId, alreadyProcessed: true, orderId });

    const credits = creditsFromOrder(order);
    if (!credits) {
      return res.status(200).json({
        ok: true,
        requestId,
        orderId,
        credited: 0,
        reason: "NO_MATCHING_PRODUCT",
      });
    }

    const shopifyCustomerId = order?.customer?.id != null ? String(order.customer.id) : null;
    const email = safeString(order?.email || order?.customer?.email || "").toLowerCase() || null;

    // Choose a stable passId for MEGA
    const passId =
      shopifyCustomerId
        ? `pass:shopify:${shopifyCustomerId}`
        : email
          ? `pass:email:${email}`
          : `pass:anon:${crypto.randomUUID()}`;

    const grantedAt = order?.processed_at || order?.created_at || nowIso();

    // Ensure row exists + link shopify/email
    await megaEnsureCustomer({
      passId,
      email,
      shopifyCustomerId: shopifyCustomerId || null,
      userId: null,
    });

    const out = await megaAdjustCredits({
      passId,
      delta: credits,
      reason: "shopify-order",
      source: "shopify",
      refType: "shopify_order",
      refId: orderId,
      grantedAt,
    });

    // Optional: tag Shopify customer
    if (shopifyCustomerId) {
      try {
        await addCustomerTag(shopifyCustomerId, SHOPIFY_MINA_TAG);
      } catch (e) {
        console.error("[shopify] add tag failed:", e?.message || e);
      }
    }

    return res.status(200).json({
      ok: true,
      requestId,
      orderId,
      passId,
      credited: credits,
      balance: out.creditsAfter,
      expiresAt: out.expiresAt,
    });
  } catch (e) {
    console.error("[shopify webhook] failed", e);
    return res.status(500).json({
      ok: false,
      error: "WEBHOOK_FAILED",
      requestId,
      message: e?.message || String(e),
    });
  }
});

// ======================================================
// Standard body parsers
// ======================================================
app.use(express.json({ limit: "25mb" }));
app.use(express.urlencoded({ extended: true, limit: "25mb" }));

// ======================================================
// Frontend error logger
// ======================================================
app.post("/api/log-error", async (req, res) => {
  try {
    const body = req.body || {};
    await logError({
      action: "frontend.error",
      status: 500,
      route: body.url || "/(frontend)",
      method: "FRONTEND",
      message: body.message || "Frontend crash",
      stack: body.stack,
      userAgent: body.userAgent || req.get("user-agent"),
      ip: req.headers["x-forwarded-for"] || req.ip,
      userId: body.userId,
      email: body.email,
      emoji: "🖥️",
      code: "FRONTEND_CRASH",
      detail: { ...(body.extra || {}) },
      sourceSystem: "mina-frontend",
    });
  } catch (err) {
    console.error("[POST /api/log-error] failed to record", err);
  }
  res.json({ ok: true });
});

// ======================================================
// Core routes (MEGA)
// ======================================================

// Health
app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "Mina MMA API (MEGA)",
    time: nowIso(),
    supabase: sbEnabled(),
    env: IS_PROD ? "production" : "development",
  });
});

// /me — optional Supabase auth, but always returns a passId
app.get("/me", async (req, res) => {
  const requestId = `me_${Date.now()}_${crypto.randomUUID()}`;
  try {
    const authUser = await getAuthUser(req);

    // Start from incoming header/body passId (no body in GET)
    let passId = resolvePassIdForRequest(req, {});

    // If logged-in and no explicit passId header, prefer stable user passId
    const incomingHeader = safeString(req.get("x-mina-pass-id"), "");
    if (authUser?.userId && !incomingHeader) {
      passId = `pass:user:${authUser.userId}`;
    }

    setPassIdHeader(res, passId);

    if (!sbEnabled()) {
      return res.json({
        ok: true,
        requestId,
        user: authUser ? { id: authUser.userId, email: authUser.email } : null,
        passId,
        degraded: true,
        degradedReason: "Supabase not configured",
      });
    }

    if (authUser) {
      // Light audit helpers (safe no-throw)
      void upsertProfileRow({ userId: authUser.userId, email: authUser.email });
      void upsertSessionRow({
        userId: authUser.userId,
        email: authUser.email,
        token: authUser.token,
        ip: req.ip,
        userAgent: req.get("user-agent"),
      });

      // Ensure MEGA customer exists & link to user/email
      await megaEnsureCustomer({
        passId,
        userId: authUser.userId,
        email: authUser.email,
      });
    } else {
      // Ensure MEGA customer exists for anon passId too (optional but useful)
      await megaEnsureCustomer({ passId });
    }

    return res.json({
      ok: true,
      requestId,
      user: authUser ? { id: authUser.userId, email: authUser.email } : null,
      passId,
    });
  } catch (e) {
    console.error("GET /me failed", e);
    const fallback = resolvePassIdForRequest(req, {});
    setPassIdHeader(res, fallback);
    return res.status(200).json({
      ok: true,
      requestId,
      user: null,
      passId: fallback,
      degraded: true,
      degradedReason: e?.message || String(e),
    });
  }
});

// Credits: balance
app.get("/credits/balance", async (req, res) => {
  const requestId = `credits_${Date.now()}_${crypto.randomUUID()}`;
  try {
    if (!sbEnabled()) {
      return res.status(503).json({ ok: false, requestId, error: "NO_SUPABASE" });
    }

    const passId = resolvePassIdForRequest(req, {
      customerId: req.query.customerId || req.query.passId,
    });
    setPassIdHeader(res, passId);

    // Ensure row exists and link if authed
    const authUser = await getAuthUser(req);
    await megaEnsureCustomer({
      passId,
      userId: authUser?.userId || null,
      email: authUser?.email || null,
    });

    const { credits, expiresAt } = await megaGetCredits(passId);

    return res.json({
      ok: true,
      requestId,
      passId,
      balance: credits,
      expiresAt,
      source: "mega_customers",
    });
  } catch (e) {
    console.error("GET /credits/balance failed", e);
    return res.status(500).json({ ok: false, requestId, error: "CREDITS_FAILED", message: e?.message || String(e) });
  }
});

// Credits: add (manual topup)
app.post("/credits/add", async (req, res) => {
  const requestId = `add_${Date.now()}_${crypto.randomUUID()}`;
  try {
    if (!sbEnabled()) {
      return res.status(503).json({ ok: false, requestId, error: "NO_SUPABASE" });
    }

    const body = req.body || {};
    const amount = typeof body.amount === "number" ? body.amount : Number(body.amount || 0);
    if (!Number.isFinite(amount) || amount === 0) {
      return res.status(400).json({ ok: false, requestId, error: "INVALID_AMOUNT" });
    }

    const passId = resolvePassIdForRequest(req, body);
    setPassIdHeader(res, passId);

    const authUser = await getAuthUser(req);
    await megaEnsureCustomer({
      passId,
      userId: authUser?.userId || null,
      email: authUser?.email || null,
    });

    const out = await megaAdjustCredits({
      passId,
      delta: amount,
      reason: safeString(body.reason, "manual-topup"),
      source: safeString(body.source, "api"),
      refType: "manual",
      refId: requestId,
      grantedAt: nowIso(),
    });

    return res.json({
      ok: true,
      requestId,
      passId,
      creditsBefore: out.creditsBefore,
      creditsAfter: out.creditsAfter,
      expiresAt: out.expiresAt,
    });
  } catch (e) {
    console.error("POST /credits/add failed", e);
    return res.status(500).json({ ok: false, requestId, error: "CREDITS_ADD_FAILED", message: e?.message || String(e) });
  }
});

// Sessions: start
app.post("/sessions/start", async (req, res) => {
  const requestId = `sess_${Date.now()}_${crypto.randomUUID()}`;
  try {
    if (!sbEnabled()) {
      return res.status(503).json({ ok: false, requestId, error: "NO_SUPABASE" });
    }

    const body = req.body || {};
    const passId = resolvePassIdForRequest(req, body);
    setPassIdHeader(res, passId);

    const authUser = await getAuthUser(req);
    await megaEnsureCustomer({
      passId,
      userId: authUser?.userId || null,
      email: authUser?.email || null,
    });

    const sessionId = crypto.randomUUID();
    const platform = safeString(body.platform, "web").toLowerCase();
    const title = safeString(body.title, "Mina session");

    await megaWriteSession({
      passId,
      sessionId,
      platform,
      title,
      meta: {
        requestId,
        ip: req.ip,
        userAgent: req.get("user-agent"),
      },
    });

    // (Optional) audit helper
    if (authUser?.token) {
      void upsertSessionRow({
        userId: authUser.userId,
        email: authUser.email,
        token: authUser.token,
        ip: req.ip,
        userAgent: req.get("user-agent"),
      });
    }

    return res.json({
      ok: true,
      requestId,
      passId,
      session: { id: sessionId, platform, title, createdAt: nowIso() },
    });
  } catch (e) {
    console.error("POST /sessions/start failed", e);
    return res.status(500).json({ ok: false, requestId, error: "SESSION_FAILED", message: e?.message || String(e) });
  }
});

// Feedback: generic event writer (MMA router may have its own; this is a safe MEGA endpoint)
app.post("/feedback", async (req, res) => {
  const requestId = `fb_${Date.now()}_${crypto.randomUUID()}`;
  try {
    if (!sbEnabled()) {
      return res.status(503).json({ ok: false, requestId, error: "NO_SUPABASE" });
    }

    const body = req.body || {};
    const passId = resolvePassIdForRequest(req, body);
    setPassIdHeader(res, passId);

    const authUser = await getAuthUser(req);
    await megaEnsureCustomer({
      passId,
      userId: authUser?.userId || null,
      email: authUser?.email || null,
    });

    const generationId = safeString(body.generationId || body.generation_id, null);

    const payload = body.payload && typeof body.payload === "object"
      ? body.payload
      : {
          type: safeString(body.type, "feedback"),
          tags: Array.isArray(body.tags) ? body.tags : undefined,
          hard_block: safeString(body.hard_block, "") || undefined,
          note: safeString(body.note, "") || undefined,
        };

    const out = await megaWriteFeedback({ passId, generationId, payload });

    return res.json({ ok: true, requestId, passId, feedbackId: out.feedbackId });
  } catch (e) {
    console.error("POST /feedback failed", e);
    return res.status(500).json({ ok: false, requestId, error: "FEEDBACK_FAILED", message: e?.message || String(e) });
  }
});

// History (MEGA): pulls from mega_customers + mega_generations
app.get("/history", async (req, res) => {
  const requestId = `hist_${Date.now()}_${crypto.randomUUID()}`;
  try {
    if (!sbEnabled()) {
      return res.status(503).json({ ok: false, requestId, error: "NO_SUPABASE" });
    }

    const supabase = getSupabaseAdmin();
    const passId = resolvePassIdForRequest(req, {
      customerId: req.query.customerId || req.query.passId,
    });
    setPassIdHeader(res, passId);

    const limit = Math.max(1, Math.min(1000, Number(req.query.limit || 200)));

    // Ensure customer exists
    await megaEnsureCustomer({ passId });

    const [custRes, gensRes] = await Promise.all([
      supabase
        .from("mega_customers")
        .select("mg_pass_id, mg_credits, mg_expires_at, mg_user_id, mg_email, mg_shopify_customer_id, mg_last_active, mg_created_at, mg_updated_at")
        .eq("mg_pass_id", passId)
        .maybeSingle(),
      supabase
        .from("mega_generations")
        .select("*")
        .eq("mg_pass_id", passId)
        .order("mg_created_at", { ascending: false })
        .limit(limit),
    ]);

    if (custRes.error) throw custRes.error;
    if (gensRes.error) throw gensRes.error;

    return res.json({
      ok: true,
      requestId,
      passId,
      customer: custRes.data || null,
      events: gensRes.data || [],
    });
  } catch (e) {
    console.error("GET /history failed", e);
    return res.status(500).json({ ok: false, requestId, error: "HISTORY_FAILED", message: e?.message || String(e) });
  }
});

// ======================================================
// R2 (public) helper endpoints (optional but useful)
// ======================================================
const R2_ACCOUNT_ID = ENV.R2_ACCOUNT_ID || "";
const R2_ACCESS_KEY_ID = ENV.R2_ACCESS_KEY_ID || "";
const R2_SECRET_ACCESS_KEY = ENV.R2_SECRET_ACCESS_KEY || "";
const R2_BUCKET = ENV.R2_BUCKET || "";
const R2_ENDPOINT =
  ENV.R2_ENDPOINT ||
  (R2_ACCOUNT_ID ? `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com` : "");

const R2_PUBLIC_BASE_URL = ENV.R2_PUBLIC_BASE_URL || "";
if (IS_PROD && (R2_ENDPOINT || R2_BUCKET) && !R2_PUBLIC_BASE_URL) {
  throw new Error("R2_PUBLIC_BASE_URL is REQUIRED in production so asset URLs are permanent (non-expiring).");
}

function r2Enabled() {
  return Boolean(R2_ENDPOINT && R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY && R2_BUCKET);
}

const r2 = r2Enabled()
  ? new S3Client({
      region: "auto",
      endpoint: R2_ENDPOINT,
      credentials: {
        accessKeyId: R2_ACCESS_KEY_ID,
        secretAccessKey: R2_SECRET_ACCESS_KEY,
      },
    })
  : null;

function safeName(name = "file") {
  return String(name).replace(/[^a-zA-Z0-9._-]/g, "_");
}
function safeFolderName(name = "uploads") {
  return String(name).replace(/[^a-zA-Z0-9/_-]/g, "_");
}
function guessExtFromContentType(contentType = "") {
  const ct = String(contentType).toLowerCase();
  if (ct.includes("png")) return "png";
  if (ct.includes("jpeg") || ct.includes("jpg")) return "jpg";
  if (ct.includes("webp")) return "webp";
  if (ct.includes("gif")) return "gif";
  if (ct.includes("mp4")) return "mp4";
  return "";
}
function encodeKeyForUrl(key) {
  return String(key || "")
    .split("/")
    .map((p) => encodeURIComponent(p))
    .join("/");
}
function r2PublicUrlForKey(key) {
  if (!key) return "";
  if (R2_PUBLIC_BASE_URL) return `${R2_PUBLIC_BASE_URL}/${encodeKeyForUrl(key)}`;
  if (R2_ACCOUNT_ID && R2_BUCKET) {
    return `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${R2_BUCKET}/${encodeKeyForUrl(key)}`;
  }
  return "";
}

async function r2PutPublic({ key, body, contentType }) {
  if (!r2Enabled() || !r2) throw new Error("R2_NOT_CONFIGURED");

  await r2.send(
    new PutObjectCommand({
      Bucket: R2_BUCKET,
      Key: key,
      Body: body,
      ContentType: contentType || "application/octet-stream",
      CacheControl: "public, max-age=31536000, immutable",
    })
  );

  const publicUrl = r2PublicUrlForKey(key);
  if (!publicUrl) throw new Error("Missing R2_PUBLIC_BASE_URL (or public fallback config).");
  return { key, publicUrl };
}

async function storeRemoteToR2Public({ remoteUrl, kind = "generations", customerId = "anon" }) {
  const resp = await fetch(remoteUrl);
  if (!resp.ok) throw new Error(`REMOTE_FETCH_FAILED (${resp.status})`);

  const contentType = resp.headers.get("content-type") || "application/octet-stream";
  const arrayBuf = await resp.arrayBuffer();
  const buf = Buffer.from(arrayBuf);

  const folder = safeFolderName(kind);
  const cid = String(customerId || "anon");
  const uuid = crypto.randomUUID();
  const extGuess = guessExtFromContentType(contentType);
  const key = `${folder}/${cid}/${Date.now()}-${uuid}${extGuess ? `.${extGuess}` : ""}`;

  return r2PutPublic({ key, body: buf, contentType });
}

// Upload dataURL -> public R2
app.post("/api/r2/upload-public", async (req, res) => {
  const requestId = `r2_${Date.now()}_${crypto.randomUUID()}`;
  try {
    if (!r2Enabled()) return res.status(503).json({ ok: false, requestId, error: "R2_NOT_CONFIGURED" });

    const { dataUrl, kind = "uploads", customerId = "anon", filename = "" } = req.body || {};
    if (!dataUrl) return res.status(400).json({ ok: false, requestId, error: "MISSING_DATAURL" });

    const { buffer, contentType, ext } = parseDataUrl(dataUrl);

    const folder = safeFolderName(kind);
    const cid = String(customerId || "anon");
    const base = safeName(filename || "upload");
    const uuid = crypto.randomUUID();

    const extGuess = ext || guessExtFromContentType(contentType);
    const key = `${folder}/${cid}/${Date.now()}-${uuid}-${base}${
      extGuess && !base.toLowerCase().endsWith(`.${extGuess}`) ? `.${extGuess}` : ""
    }`;

    const stored = await r2PutPublic({ key, body: buffer, contentType });

    return res.json({
      ok: true,
      requestId,
      key: stored.key,
      url: stored.publicUrl,
      publicUrl: stored.publicUrl,
      contentType,
      bytes: buffer.length,
    });
  } catch (e) {
    console.error("POST /api/r2/upload-public failed", e);
    return res.status(500).json({ ok: false, requestId, error: "UPLOAD_FAILED", message: e?.message || String(e) });
  }
});

// Store remote URL -> public R2
app.post("/api/r2/store-remote", async (req, res) => {
  const requestId = `r2s_${Date.now()}_${crypto.randomUUID()}`;
  try {
    if (!r2Enabled()) return res.status(503).json({ ok: false, requestId, error: "R2_NOT_CONFIGURED" });

    const { url, kind = "generations", customerId = "anon" } = req.body || {};
    if (!url) return res.status(400).json({ ok: false, requestId, error: "MISSING_URL" });

    const stored = await storeRemoteToR2Public({ remoteUrl: url, kind, customerId });

    return res.json({ ok: true, requestId, key: stored.key, url: stored.publicUrl, publicUrl: stored.publicUrl });
  } catch (e) {
    console.error("POST /api/r2/store-remote failed", e);
    return res.status(500).json({ ok: false, requestId, error: "STORE_REMOTE_FAILED", message: e?.message || String(e) });
  }
});

// ======================================================
// MMA wiring
// ======================================================
const replicate = new Replicate({ auth: ENV.REPLICATE_API_TOKEN || "" });
const openai = new OpenAI({ apiKey: ENV.OPENAI_API_KEY || "" });

const createMmaController = mmaControllerMod.createMmaController || mmaControllerMod.default;
if (typeof createMmaController !== "function") {
  throw new Error(
    "MMA controller factory not found. Expected createMmaController export in ./server/mma/mma-controller.js"
  );
}

const supabaseAdmin = getSupabaseAdmin(); // may be null in dev if env missing
const mmaController = createMmaController({ supabaseAdmin, openai, replicate });
const mmaHub = typeof mmaController?.getHub === "function" ? mmaController.getHub() : null;

// Resolve router (Router instance OR factory)
let mmaRouter = mmaRouterMod?.default ?? mmaRouterMod;
if (looksLikeExpressRouter(mmaRouter)) {
  app.locals.mma = { controller: mmaController, hub: mmaHub, supabaseAdmin };
  app.use("/mma", mmaRouter);
} else if (typeof mmaRouter === "function") {
  const built = mmaRouter({ controller: mmaController, hub: mmaHub, supabaseAdmin, openai, replicate });
  if (!looksLikeExpressRouter(built)) {
    throw new Error("mma-router factory did not return an express.Router");
  }
  app.locals.mma = { controller: mmaController, hub: mmaHub, supabaseAdmin };
  app.use("/mma", built);
} else {
  console.warn("[mma] router not loaded (check ./server/mma/mma-router.js exports)");
}

// MMA admin logs router
app.use("/admin/mma", mmaLogAdminRouter);

// ======================================================
// Admin API (MEGA)
// ======================================================
app.get("/admin/summary", requireAdmin, async (req, res) => {
  try {
    if (!sbEnabled()) return res.status(503).json({ ok: false, error: "NO_SUPABASE" });
    const supabase = getSupabaseAdmin();

    const { count, error } = await supabase
      .from("mega_customers")
      .select("mg_pass_id", { count: "exact", head: true });

    if (error) throw error;

    // Audit
    void logAdminAction({
      userId: req.user?.userId,
      email: req.user?.email,
      action: "admin.summary",
      status: 200,
      route: "/admin/summary",
      method: "GET",
      detail: { totalCustomers: count ?? 0 },
      ip: req.ip,
      userAgent: req.get("user-agent"),
    });

    res.json({ ok: true, totalCustomers: count ?? 0, source: "mega_customers" });
  } catch (e) {
    console.error("GET /admin/summary failed", e);
    res.status(500).json({ ok: false, error: "ADMIN_SUMMARY_FAILED", message: e?.message || String(e) });
  }
});

app.get("/admin/customers", requireAdmin, async (req, res) => {
  try {
    if (!sbEnabled()) return res.status(503).json({ ok: false, error: "NO_SUPABASE" });
    const supabase = getSupabaseAdmin();

    const limit = Math.max(1, Math.min(1000, Number(req.query.limit || 500)));

    const { data, error } = await supabase
      .from("mega_customers")
      .select("mg_pass_id,mg_email,mg_credits,mg_expires_at,mg_last_active,mg_created_at,mg_updated_at,mg_disabled,mg_shopify_customer_id,mg_user_id")
      .order("mg_created_at", { ascending: false })
      .limit(limit);

    if (error) throw error;

    res.json({ ok: true, customers: data || [], source: "mega_customers" });
  } catch (e) {
    console.error("GET /admin/customers failed", e);
    res.status(500).json({ ok: false, error: "ADMIN_CUSTOMERS_FAILED", message: e?.message || String(e) });
  }
});

app.post("/admin/credits/adjust", requireAdmin, async (req, res) => {
  const requestId = `admcred_${Date.now()}_${crypto.randomUUID()}`;
  try {
    if (!sbEnabled()) return res.status(503).json({ ok: false, requestId, error: "NO_SUPABASE" });

    const { passId, delta, reason } = req.body || {};
    if (!passId || typeof delta !== "number") {
      return res.status(400).json({ ok: false, requestId, error: "passId and numeric delta are required" });
    }

    await megaEnsureCustomer({ passId: String(passId) });

    const out = await megaAdjustCredits({
      passId: String(passId),
      delta,
      reason: safeString(reason, "admin-adjust"),
      source: "admin",
      refType: "admin",
      refId: req.user?.userId || requestId,
      grantedAt: nowIso(),
    });

    void logAdminAction({
      userId: req.user?.userId,
      email: req.user?.email,
      action: "admin.credits.adjust",
      status: 200,
      route: "/admin/credits/adjust",
      method: "POST",
      detail: { passId: String(passId), delta, out },
      ip: req.ip,
      userAgent: req.get("user-agent"),
    });

    res.json({
      ok: true,
      requestId,
      passId: String(passId),
      creditsBefore: out.creditsBefore,
      creditsAfter: out.creditsAfter,
      expiresAt: out.expiresAt,
    });
  } catch (e) {
    console.error("POST /admin/credits/adjust failed", e);
    res.status(500).json({ ok: false, requestId, error: "ADMIN_CREDITS_FAILED", message: e?.message || String(e) });
  }
});

// ======================================================
// Error middleware + listen
// ======================================================
app.use(errorMiddleware);

app.listen(PORT, () => {
  console.log(`Mina MMA API (MEGA) listening on port ${PORT}`);
});
