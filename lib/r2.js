"use strict";

import express from "express";
import crypto from "node:crypto";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

import { normalizeIncomingPassId, setPassIdHeader } from "./mega.js";
import { safeString } from "./utils.js";

// ============================================================================
// Base R2 helpers (public, non-expiring URLs)
// ============================================================================
const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID || "";
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID || "";
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY || "";
const R2_BUCKET = process.env.R2_BUCKET || "";

const R2_ENDPOINT =
  process.env.R2_ENDPOINT || (R2_ACCOUNT_ID ? `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com` : "");

const R2_PUBLIC_BASE_URL = (process.env.R2_PUBLIC_BASE_URL || "").replace(/\/+$/, "");

const r2 =
  R2_ENDPOINT && R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY
    ? new S3Client({
        region: "auto",
        endpoint: R2_ENDPOINT,
        credentials: {
          accessKeyId: R2_ACCESS_KEY_ID,
          secretAccessKey: R2_SECRET_ACCESS_KEY,
        },
      })
    : null;

function assertR2Configured() {
  if (!r2) throw new Error("R2 is not configured (missing R2_ENDPOINT / credentials).");
  if (!R2_BUCKET) throw new Error("R2_BUCKET is missing.");
}

function safeFolderName(name = "uploads") {
  return String(name).replace(/[^a-zA-Z0-9/_-]/g, "_");
}

function safeName(name = "file") {
  return String(name).replace(/[^a-zA-Z0-9._-]/g, "_");
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

export function publicUrlForKey(key) {
  if (!key) return "";

  if (R2_PUBLIC_BASE_URL) return `${R2_PUBLIC_BASE_URL}/${encodeKeyForUrl(key)}`;

  if (R2_ACCOUNT_ID && R2_BUCKET) {
    return `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${R2_BUCKET}/${encodeKeyForUrl(key)}`;
  }

  return "";
}

export function isOurAssetUrl(u) {
  try {
    const url = new URL(String(u));
    const host = url.hostname.toLowerCase();

    if (R2_PUBLIC_BASE_URL) {
      const baseHost = new URL(R2_PUBLIC_BASE_URL).hostname.toLowerCase();
      if (host === baseHost) return true;
    }

    if (host.endsWith("r2.cloudflarestorage.com")) return true;
    return false;
  } catch {
    return false;
  }
}

export function makeKey({ kind = "uploads", customerId = "anon", filename = "", contentType = "" } = {}) {
  const folder = safeFolderName(kind);
  const cid = String(customerId || "anon");
  const uuid = crypto.randomUUID();
  const base = safeName(filename || "upload");

  const extGuess = guessExtFromContentType(contentType);
  const ext =
    extGuess && !base.toLowerCase().endsWith(`.${extGuess}`) ? `.${extGuess}` : "";

  return `${folder}/${cid}/${Date.now()}-${uuid}-${base}${ext}`;
}

export async function putBufferToR2({ key, buffer, contentType } = {}) {
  assertR2Configured();
  if (!key) throw new Error("putBufferToR2: key is required.");
  if (!buffer) throw new Error("putBufferToR2: buffer is required.");

  await r2.send(
    new PutObjectCommand({
      Bucket: R2_BUCKET,
      Key: key,
      Body: buffer,
      ContentType: contentType || "application/octet-stream",
      CacheControl: "public, max-age=31536000, immutable",
      ContentDisposition: "inline",
    })
  );

  const publicUrl = publicUrlForKey(key);
  if (!publicUrl) {
    throw new Error(
      "Public URL could not be built. Set R2_PUBLIC_BASE_URL to a permanent public domain."
    );
  }

  return { key, publicUrl, url: publicUrl };
}

export async function storeRemoteImageToR2({ url, kind = "generations", customerId = "anon" } = {}) {
  if (!url) throw new Error("storeRemoteImageToR2: url is required.");

  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`REMOTE_FETCH_FAILED (${resp.status})`);

  const contentType = resp.headers.get("content-type") || "application/octet-stream";
  const arrayBuf = await resp.arrayBuffer();
  const buf = Buffer.from(arrayBuf);

  const key = makeKey({
    kind,
    customerId,
    filename: "remote",
    contentType,
  });

  return putBufferToR2({ key, buffer: buf, contentType });
}

export async function r2PutAndSignGet({ key, buffer, contentType } = {}) {
  const stored = await putBufferToR2({ key, buffer, contentType });
  return {
    key: stored.key,
    getUrl: stored.publicUrl,
    publicUrl: stored.publicUrl,
    url: stored.publicUrl,
  };
}

export function parseDataUrl(dataUrl) {
  const s = String(dataUrl || "");
  const m = s.match(/^data:([^;]+);base64,(.+)$/);
  if (!m) throw new Error("Invalid dataUrl format (expected data:<mime>;base64,...)");

  const contentType = m[1] || "application/octet-stream";
  const b64 = m[2] || "";
  const buffer = Buffer.from(b64, "base64");
  const ext = guessExtFromContentType(contentType);

  return { buffer, contentType, ext };
}

// ============================================================================
// MMA helper: store remote output to permanent public URL
// ============================================================================
function getR2ForMma() {
  const accountId = process.env.R2_ACCOUNT_ID || "";
  const endpoint = process.env.R2_ENDPOINT || (accountId ? `https://${accountId}.r2.cloudflarestorage.com` : "");

  const accessKeyId = process.env.R2_ACCESS_KEY_ID || "";
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY || "";
  const bucket = process.env.R2_BUCKET || "";
  const publicBase = process.env.R2_PUBLIC_BASE_URL || "";

  const enabled = !!(endpoint && accessKeyId && secretAccessKey && bucket && publicBase);
  const client = enabled
    ? new S3Client({
        region: "auto",
        endpoint,
        credentials: { accessKeyId, secretAccessKey },
      })
    : null;

  return { enabled, client, bucket, publicBase };
}

function guessExt(url, fallback = ".bin") {
  try {
    const p = new URL(url).pathname.toLowerCase();
    if (p.endsWith(".png")) return ".png";
    if (p.endsWith(".jpg") || p.endsWith(".jpeg")) return ".jpg";
    if (p.endsWith(".webp")) return ".webp";
    if (p.endsWith(".gif")) return ".gif";
    if (p.endsWith(".mp4")) return ".mp4";
    if (p.endsWith(".webm")) return ".webm";
    if (p.endsWith(".mov")) return ".mov";
    return fallback;
  } catch {
    return fallback;
  }
}

export async function storeRemoteToR2Public(url, keyPrefix) {
  const { enabled, client, bucket, publicBase } = getR2ForMma();
  if (!enabled || !client) return url;
  if (!url || typeof url !== "string") return url;

  if (publicBase && url.startsWith(publicBase)) return url;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`R2_FETCH_FAILED_${res.status}`);

  const buf = Buffer.from(await res.arrayBuffer());
  const contentType = res.headers.get("content-type") || "application/octet-stream";
  const ext = guessExt(url, contentType.includes("video") ? ".mp4" : ".png");
  const objKey = `${keyPrefix}${ext}`;

  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: objKey,
      Body: buf,
      ContentType: contentType,
    })
  );

  return `${publicBase.replace(/\/$/, "")}/${objKey}`;
}

// ============================================================================
// R2 routes
// ============================================================================
const ENV = process.env;

const R2_UPLOAD_ACCOUNT_ID = ENV.R2_ACCOUNT_ID || "";
const R2_UPLOAD_ACCESS_KEY_ID = ENV.R2_ACCESS_KEY_ID || "";
const R2_UPLOAD_SECRET_ACCESS_KEY = ENV.R2_SECRET_ACCESS_KEY || "";
const R2_UPLOAD_BUCKET = ENV.R2_BUCKET || "";

function r2Enabled() {
  return Boolean(R2_UPLOAD_ACCOUNT_ID && R2_UPLOAD_ACCESS_KEY_ID && R2_UPLOAD_SECRET_ACCESS_KEY && R2_UPLOAD_BUCKET);
}

function getR2S3Client() {
  if (!r2Enabled()) return null;
  const endpoint = `https://${R2_UPLOAD_ACCOUNT_ID}.r2.cloudflarestorage.com`;
  return new S3Client({
    region: "auto",
    endpoint,
    forcePathStyle: true,
    credentials: {
      accessKeyId: R2_UPLOAD_ACCESS_KEY_ID,
      secretAccessKey: R2_UPLOAD_SECRET_ACCESS_KEY,
    },
  });
}

// ============================================================================
// /api/r2/presign (canonicalized)
// ============================================================================
const JSON_LIMIT = process.env.R2_PRESIGN_JSON_LIMIT || "2mb";
const PRESIGN_EXPIRES_SECONDS = Number(process.env.R2_PRESIGN_EXPIRES_SECONDS || 60 * 10);
const DEFAULT_CACHE_CONTROL =
  process.env.R2_UPLOAD_CACHE_CONTROL || "public, max-age=31536000, immutable";
const DEFAULT_CONTENT_DISPOSITION =
  process.env.R2_UPLOAD_CONTENT_DISPOSITION || "inline";

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

const KIND_ALIASES = {
  inspo: "inspiration",
  inspiration: "inspiration",
  inspirations: "inspiration",
  insp: "inspiration",
  style_ref: "inspiration",
  style_refs: "inspiration",

  stylehero: "style_hero",
  style_hero: "style_hero",
  "style-hero": "style_hero",

  product_image: "product",
  productimage: "product",
  logo_image: "logo",
  logoimage: "logo",

  start: "start",
  start_image: "start",
  startimage: "start",
  "start-image": "start",
  end: "end",
  end_image: "end",
  endimage: "end",
  "end-image": "end",

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

const S3 = new S3Client({
  region: "auto",
  endpoint: R2_ACCOUNT_ID ? `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com` : undefined,
  credentials: {
    accessKeyId: R2_ACCESS_KEY_ID || "",
    secretAccessKey: R2_SECRET_ACCESS_KEY || "",
  },
});

function normalizeKind(kindRaw) {
  const raw = String(kindRaw || "").trim();
  if (!raw) return "";

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

function safePart(v, fallback = "anon") {
  const s = String(v || "").trim();
  if (!s) return fallback;
  return s.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80);
}

function safeFolder(v, fallback = "uploads") {
  const s = String(v || "").trim().toLowerCase();
  if (!s) return fallback;

  const cleaned = s
    .replace(/[^a-z0-9/_-]/g, "_")
    .replace(/\/+/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");

  if (!cleaned) return fallback;
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

function makePresignKey({ kind, contentType, customerId, filename } = {}) {
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

export function registerR2Routes(app) {
  // /api/r2/upload-signed
  app.post("/api/r2/upload-signed", async (req, res) => {
    try {
      if (!r2Enabled()) return res.status(503).json({ ok: false, error: "R2_NOT_CONFIGURED" });

      const body = req.body || {};

      const kind = safeString(body.kind || body.folder || "uploads", "uploads");
      const filename = safeString(body.fileName || body.filename || body.file_name || "upload", "upload");
      const contentType = safeString(body.contentType || "application/octet-stream", "application/octet-stream");

      const rawPass =
        body.passId || body.customerId || req.get("x-mina-pass-id") || req.query.passId || req.query.customerId;
      const passId = normalizeIncomingPassId(rawPass) || "anonymous";
      setPassIdHeader(res, passId);

      const key = makeKey({ kind, customerId: passId, filename, contentType });

      const client = getR2S3Client();
      const cmd = new PutObjectCommand({
        Bucket: R2_UPLOAD_BUCKET,
        Key: key,
        ContentType: contentType,
      });

      const uploadUrl = await getSignedUrl(client, cmd, { expiresIn: 600 });
      const publicUrl = publicUrlForKey(key);

      return res.status(200).json({
        ok: true,
        key,
        uploadUrl,
        publicUrl,
        url: publicUrl,
        expiresIn: 600,
      });
    } catch (e) {
      console.error("POST /api/r2/upload-signed failed", e);
      return res
        .status(500)
        .json({ ok: false, error: "UPLOAD_SIGN_FAILED", message: e?.message || String(e) });
    }
  });

  // /api/r2/store-remote-signed
  app.post("/api/r2/store-remote-signed", async (req, res) => {
    try {
      const body = req.body || {};
      const url = safeString(body.sourceUrl || body.url || "", "");
      if (!url) return res.status(400).json({ ok: false, error: "MISSING_URL" });

      const kind = safeString(body.kind || body.folder || "generations", "generations");
      const rawPass = body.passId || body.customerId || req.get("x-mina-pass-id");
      const passId = normalizeIncomingPassId(rawPass) || "anonymous";
      setPassIdHeader(res, passId);

      const out = await storeRemoteImageToR2({ url, kind, customerId: passId });
      return res.status(200).json({ ok: true, key: out.key, publicUrl: out.publicUrl, url: out.publicUrl });
    } catch (e) {
      console.error("POST /api/r2/store-remote-signed failed", e);
      return res
        .status(500)
        .json({ ok: false, error: "STORE_REMOTE_FAILED", message: e?.message || String(e) });
    }
  });

  // /api/r2/upload-dataurl
  app.post("/api/r2/upload-dataurl", async (req, res) => {
    try {
      const body = req.body || {};
      const dataUrl = safeString(body.dataUrl, "");
      if (!dataUrl) return res.status(400).json({ ok: false, error: "MISSING_DATAURL" });

      const kind = safeString(body.kind || body.folder || "uploads", "uploads");
      const filename = safeString(body.filename || body.fileName || "upload", "upload");
      const rawPass = body.passId || body.customerId || req.get("x-mina-pass-id");
      const passId = normalizeIncomingPassId(rawPass) || "anonymous";
      setPassIdHeader(res, passId);

      const parsed = parseDataUrl(dataUrl);
      const key = makeKey({ kind, customerId: passId, filename, contentType: parsed.contentType });

      const out = await putBufferToR2({ key, buffer: parsed.buffer, contentType: parsed.contentType });
      return res.status(200).json({ ok: true, key: out.key, publicUrl: out.publicUrl, url: out.publicUrl });
    } catch (e) {
      console.error("POST /api/r2/upload-dataurl failed", e);
      return res
        .status(500)
        .json({ ok: false, error: "UPLOAD_DATAURL_FAILED", message: e?.message || String(e) });
    }
  });

  // /api/r2/presign (newer presign flow)
  app.use(express.json({ limit: JSON_LIMIT }));
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

      const key = makePresignKey({
        kind: k,
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
        { expiresIn: Math.max(60, Math.min(PRESIGN_EXPIRES_SECONDS, 60 * 60)) }
      );

      const publicUrl = makePublicUrl(key);
      if (!publicUrl) {
        return res.status(500).json({
          error: "R2_PUBLIC_BASE_URL_NOT_SET",
          message:
            "Set R2_PUBLIC_BASE_URL to your permanent public asset domain (custom domain or r2.dev).",
        });
      }

      return res.json({ key, putUrl, publicUrl, kind: k });
    } catch (err) {
      console.error("[/api/r2/presign] error:", err);
      return res.status(500).json({
        error: "Failed to presign",
        message: err?.message || "unknown",
      });
    }
  });
}

// ============================================================================
// Client helpers (optional usage in browser apps)
// ============================================================================
export async function presignR2Upload({
  apiBase = "",
  kind = "mma",
  contentType,
  customerId = "anon",
  filename = "upload",
} = {}) {
  if (!contentType) throw new Error("presignR2Upload: contentType is required");

  const resp = await fetch(`${apiBase}/api/r2/presign`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind, contentType, customerId, filename }),
  });

  if (!resp.ok) {
    const msg = await safeReadJson(resp);
    throw new Error(msg?.error || `PRESIGN_FAILED_${resp.status}`);
  }

  return resp.json();
}

export async function uploadFileToR2({
  file,
  apiBase = "",
  kind = "mma",
  customerId = "anon",
  filename,
  onProgress,
} = {}) {
  if (!file) throw new Error("uploadFileToR2: file is required");

  const contentType = file.type || "application/octet-stream";
  const name = filename || file.name || "upload";

  const { key, putUrl, publicUrl } = await presignR2Upload({
    apiBase,
    kind,
    contentType,
    customerId,
    filename: name,
  });

  if (onProgress && typeof XMLHttpRequest === "function") {
    await putWithProgress(putUrl, file, contentType, onProgress);
  } else {
    const putResp = await fetch(putUrl, {
      method: "PUT",
      headers: { "Content-Type": contentType },
      body: file,
    });

    if (!putResp.ok) {
      throw new Error(`R2_PUT_FAILED_${putResp.status}`);
    }
  }

  return { key, publicUrl, url: publicUrl };
}

export function putWithProgress(putUrl, file, contentType, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", putUrl, true);
    xhr.setRequestHeader("Content-Type", contentType || "application/octet-stream");

    xhr.upload.onprogress = (evt) => {
      if (!evt.lengthComputable) return;
      onProgress?.(evt.loaded / evt.total);
    };

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve(true);
      else reject(new Error(`R2_PUT_FAILED_${xhr.status}`));
    };

    xhr.onerror = () => reject(new Error("R2_PUT_NETWORK_ERROR"));
    xhr.send(file);
  });
}

async function safeReadJson(resp) {
  try {
    return await resp.json();
  } catch {
    return null;
  }
}
