// mina-editorial-ai/server/index.js
// MMA-compatible R2 presign gateway (PUT only + permanent public URL)
//
// - Returns: { key, putUrl, publicUrl } ✅ permanent publicUrl, no expiring GET URLs
// - Requires R2_PUBLIC_BASE_URL         ✅ permanent URLs only
// - Validates + normalizes kind/contentType to keep keys safe + consistent
// - Normalizes Mina frontend "kind" variants (inspo/inspiration/styleHero/style_hero/etc)

import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import crypto from "node:crypto";

import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const app = express();

// ============================================================================
// CONFIG (edit these easily)
// ============================================================================
const JSON_LIMIT = process.env.R2_PRESIGN_JSON_LIMIT || "2mb";
const PRESIGN_EXPIRES_SECONDS = Number(process.env.R2_PRESIGN_EXPIRES_SECONDS || 60 * 10); // 10 min
const DEFAULT_CACHE_CONTROL =
  process.env.R2_UPLOAD_CACHE_CONTROL || "public, max-age=31536000, immutable";
const DEFAULT_CONTENT_DISPOSITION =
  process.env.R2_UPLOAD_CONTENT_DISPOSITION || "inline";

// If CORS_ORIGINS is empty:
// - production: block
// - non-prod: allow all (more convenient)
const ALLOW_ALL_ORIGINS_IF_EMPTY_IN_DEV = true;

/**
 * ✅ CANONICAL kinds (what we store to R2 folders)
 * Recommended for frontend:
 * - product
 * - logo
 * - inspiration
 * - style
 * - style_hero
 * - start
 * - end
 * - generation
 * - mma
 * - uploads
 */
const CANONICAL_KINDS = new Set([
  "product",
  "logo",
  "inspiration",
  "style",
  "style_hero",
  "start",
  "end",
  "generation",
  "mma",
  "uploads",
]);

/**
 * ✅ Aliases we accept from older frontend code / UI labels.
 * Everything maps to CANONICAL_KINDS.
 */
const KIND_ALIASES = {
  // inspo/inspiration
  inspo: "inspiration",
  inspiration: "inspiration",
  inspirations: "inspiration",
  insp: "inspiration",
  style_ref: "inspiration",
  style_refs: "inspiration",

  // style hero
  stylehero: "style_hero",
  style_hero: "style_hero",
  "style-hero": "style_hero",

  // product/logo (common variations)
  product_image: "product",
  productimage: "product",
  logo_image: "logo",
  logoimage: "logo",

  // Kling
  start: "start",
  start_image: "start",
  startimage: "start",
  "start-image": "start",
  end: "end",
  end_image: "end",
  endimage: "end",
  "end-image": "end",

  // generic buckets
  generation: "generation",
  mma: "mma",
  upload: "uploads",
  uploads: "uploads",
};

const ALLOWED_CONTENT_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
  "image/gif",
  "video/mp4",
]);

// ============================================================================
// CORS
// ============================================================================
const allowlist = (process.env.CORS_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const corsOptions = {
  origin: (origin, cb) => {
    if (!origin) return cb(null, true); // server-to-server/curl

    if (allowlist.length === 0) {
      const isProd = String(process.env.NODE_ENV || "").toLowerCase() === "production";
      if (!isProd && ALLOW_ALL_ORIGINS_IF_EMPTY_IN_DEV) return cb(null, true);
      return cb(new Error("CORS not configured"), false);
    }

    if (allowlist.includes(origin)) return cb(null, true);
    return cb(new Error(`CORS blocked: ${origin}`), false);
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "X-Mina-Pass-Id", "X-Requested-With"],
};

app.use(cors(corsOptions));
app.options("*", cors(corsOptions));
app.use(express.json({ limit: JSON_LIMIT }));

// ============================================================================
// Env
// ============================================================================
const {
  R2_ACCOUNT_ID,
  R2_ACCESS_KEY_ID,
  R2_SECRET_ACCESS_KEY,
  R2_BUCKET,
  R2_PUBLIC_BASE_URL,
  PORT,
} = process.env;

function mustEnv(name, value) {
  if (!value) throw new Error(`Missing env var: ${name}`);
}

function assertConfigured() {
  mustEnv("R2_ACCOUNT_ID", R2_ACCOUNT_ID);
  mustEnv("R2_ACCESS_KEY_ID", R2_ACCESS_KEY_ID);
  mustEnv("R2_SECRET_ACCESS_KEY", R2_SECRET_ACCESS_KEY);
  mustEnv("R2_BUCKET", R2_BUCKET);
  mustEnv("R2_PUBLIC_BASE_URL", R2_PUBLIC_BASE_URL);
}

function baseUrl() {
  return String(R2_PUBLIC_BASE_URL || "").replace(/\/+$/, "");
}

// Cloudflare R2 S3 endpoint + region auto
const S3 = new S3Client({
  region: "auto",
  endpoint: R2_ACCOUNT_ID ? `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com` : undefined,
  credentials: {
    accessKeyId: R2_ACCESS_KEY_ID || "",
    secretAccessKey: R2_SECRET_ACCESS_KEY || "",
  },
});

// ============================================================================
// Normalization helpers
// ============================================================================
function normalizeKind(kindRaw) {
  const raw = String(kindRaw || "").trim();
  if (!raw) return "";

  // normalize: lower, spaces->underscore, strip weird chars a bit
  const k = raw
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/[^a-z0-9_-]/g, "_");

  const mapped = KIND_ALIASES[k] || k;
  return CANONICAL_KINDS.has(mapped) ? mapped : "";
}

function normalizeContentType(ctRaw) {
  return String(ctRaw || "").trim().toLowerCase();
}

// ============================================================================
// Key helpers
// ============================================================================
function safePart(v, fallback = "anon") {
  const s = String(v || "").trim();
  if (!s) return fallback;
  return s.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80);
}

function safeFolder(v, fallback = "uploads") {
  const s = String(v || "").trim().toLowerCase();
  if (!s) return fallback;

  // collapse repeated slashes properly
  const cleaned = s
    .replace(/[^a-z0-9/_-]/g, "_")
    .replace(/\/+/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");

  if (!cleaned) return fallback;
  if (cleaned.includes("..")) return fallback; // prevent path tricks
  return cleaned.slice(0, 80);
}

function extFromContentType(contentType = "") {
  const ct = String(contentType).toLowerCase();
  if (ct.includes("png")) return ".png";
  if (ct.includes("jpeg") || ct.includes("jpg")) return ".jpg";
  if (ct.includes("webp")) return ".webp";
  if (ct.includes("gif")) return ".gif";
  if (ct.includes("mp4")) return ".mp4";
  return "";
}

function makeKey({ kind, contentType, customerId, filename } = {}) {
  const now = new Date();
  const yyyy = String(now.getUTCFullYear());
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(now.getUTCDate()).padStart(2, "0");

  const folder = safeFolder(kind, "uploads");
  const cid = safePart(customerId, "anon");
  const fileBase = safePart(filename, "upload");
  const id = crypto.randomUUID();
  const ext = extFromContentType(contentType);

  return `${folder}/${cid}/${yyyy}/${mm}/${dd}/${id}-${fileBase}${ext}`;
}

function makePublicUrl(key) {
  const b = baseUrl();
  if (!b || !key) return null;
  const encoded = String(key)
    .split("/")
    .map((p) => encodeURIComponent(p))
    .join("/");
  return `${b}/${encoded}`;
}

// ============================================================================
// Routes
// ============================================================================
app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

/**
 * POST /api/r2/presign
 * body: { kind, contentType, customerId?, filename? }
 * returns: { key, putUrl, publicUrl, kind }
 */
app.post("/api/r2/presign", async (req, res) => {
  try {
    assertConfigured();

    const { kind, contentType, customerId, filename } = req.body || {};
    const k = normalizeKind(kind);
    const ct = normalizeContentType(contentType);

    if (!k) {
      return res.status(400).json({
        error: "kind not allowed",
        message: "Use a valid kind or one of the supported aliases.",
        canonical: Array.from(CANONICAL_KINDS),
        aliases: Object.keys(KIND_ALIASES),
      });
    }

    if (!ct) return res.status(400).json({ error: "contentType is required" });
    if (!ALLOWED_CONTENT_TYPES.has(ct)) {
      return res.status(400).json({
        error: "contentType not allowed",
        allowed: Array.from(ALLOWED_CONTENT_TYPES),
      });
    }

    const key = makeKey({
      kind: k, // ✅ normalized canonical kind
      contentType: ct,
      customerId: customerId || "anon",
      filename: filename || "upload",
    });

    const putUrl = await getSignedUrl(
      S3,
      new PutObjectCommand({
        Bucket: R2_BUCKET,
        Key: key,
        ContentType: ct,
        CacheControl: DEFAULT_CACHE_CONTROL,
        ContentDisposition: DEFAULT_CONTENT_DISPOSITION,
      }),
      { expiresIn: Math.max(60, Math.min(PRESIGN_EXPIRES_SECONDS, 60 * 60)) } // clamp 1m..1h
    );

    const publicUrl = makePublicUrl(key);
    if (!publicUrl) {
      return res.status(500).json({
        error: "R2_PUBLIC_BASE_URL_NOT_SET",
        message:
          "Set R2_PUBLIC_BASE_URL to your permanent public asset domain (custom domain or r2.dev).",
      });
    }

    // ✅ return normalized kind too (frontend can store/display it if it wants)
    return res.json({ key, putUrl, publicUrl, kind: k });
  } catch (err) {
    console.error("[/api/r2/presign] error:", err);
    return res.status(500).json({
      error: "Failed to presign",
      message: err?.message || "unknown",
    });
  }
});

// Serve Vite build (dist) in production
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const distDir = path.join(__dirname, "..", "dist");

app.use(express.static(distDir));
app.get("*", (_req, res) => {
  res.sendFile(path.join(distDir, "index.html"));
});

app.listen(Number(PORT) || 3000, () => {
  console.log(`Server listening on ${Number(PORT) || 3000}`);
});
