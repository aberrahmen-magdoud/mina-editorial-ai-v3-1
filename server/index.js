// mina-editorial-ai/server/index.js
// MMA-compatible R2 presign gateway (PUT only + permanent public URL)
//
// - Returns: { key, putUrl, publicUrl }  ✅ no expiring GET URLs
// - Requires R2_PUBLIC_BASE_URL          ✅ permanent URLs only
// - Sets CacheControl + ContentDisposition on uploaded objects
// - Validates kind/customerId/filename to keep keys safe

import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import crypto from "node:crypto";

import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const app = express();

// --------------------
// CORS
// --------------------
const allowlist = (process.env.CORS_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const corsOptions = {
  origin: (origin, cb) => {
    if (!origin) return cb(null, true); // server-to-server/curl
    if (allowlist.length === 0) return cb(new Error("CORS not configured"), false);
    if (allowlist.includes(origin)) return cb(null, true);
    return cb(new Error(`CORS blocked: ${origin}`), false);
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: [
    "Content-Type",
    "Authorization",
    "X-Mina-Pass-Id",
    "X-Requested-With",
  ],
};

app.use(cors(corsOptions));
app.options("*", cors(corsOptions));
app.use(express.json({ limit: "2mb" }));

// --------------------
// Env
// --------------------
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
  // Permanent URLs require a public base URL (custom domain or r2.dev)
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

// --------------------
// Key helpers
// --------------------
const ALLOWED_KINDS = new Set([
  "product",
  "logo",
  "inspo",
  "style",
  "generation",
  "mma",
  "uploads",
]);

function safePart(v, fallback = "anon") {
  const s = String(v || "").trim();
  if (!s) return fallback;
  return s.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80);
}

function safeFolder(v, fallback = "uploads") {
  const s = String(v || "").trim().toLowerCase();
  const cleaned = s.replace(/[^a-z0-9/_-]/g, "_").replace(/\/+\/g, "/");
  if (!cleaned) return fallback;
  // prevent weird path tricks
  if (cleaned.includes("..")) return fallback;
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

  // Example: mma/pass_shopify_123/2025/12/22/<uuid>-upload.png
  return `${folder}/${cid}/${yyyy}/${mm}/${dd}/${id}-${fileBase}${ext}`;
}

function makePublicUrl(key) {
  const b = baseUrl();
  if (!b || !key) return null;
  // key is already safe, but keep URL tidy
  const encoded = String(key)
    .split("/")
    .map((p) => encodeURIComponent(p))
    .join("/");
  return `${b}/${encoded}`;
}

// --------------------
// Routes
// --------------------
app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

/**
 * POST /api/r2/presign
 * body: {
 *   kind: "mma"|"generation"|...,
 *   contentType: "image/png"|"video/mp4"|...,
 *   customerId?: "pass:shopify:..." | "anon" | etc,
 *   filename?: "source.png"
 * }
 * returns: { key, putUrl, publicUrl }
 */
app.post("/api/r2/presign", async (req, res) => {
  try {
    assertConfigured();

    const { kind, contentType, customerId, filename } = req.body || {};
    const k = String(kind || "").trim().toLowerCase();

    if (!k) return res.status(400).json({ error: "kind is required" });
    if (!ALLOWED_KINDS.has(k)) {
      return res.status(400).json({
        error: "kind not allowed",
        allowed: Array.from(ALLOWED_KINDS),
      });
    }

    if (!contentType) {
      return res.status(400).json({ error: "contentType is required" });
    }

    const key = makeKey({
      kind: k,
      contentType,
      customerId: customerId || "anon",
      filename: filename || "upload",
    });

    const putUrl = await getSignedUrl(
      S3,
      new PutObjectCommand({
        Bucket: R2_BUCKET,
        Key: key,
        ContentType: String(contentType),
        CacheControl: "public, max-age=31536000, immutable",
        ContentDisposition: "inline",
      }),
      { expiresIn: 60 * 10 } // 10 minutes
    );

    const publicUrl = makePublicUrl(key);
    if (!publicUrl) {
      return res.status(500).json({
        error: "R2_PUBLIC_BASE_URL_NOT_SET",
        message: "Set R2_PUBLIC_BASE_URL to your permanent public asset domain (custom domain or r2.dev).",
      });
    }

    return res.json({ key, putUrl, publicUrl });
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
