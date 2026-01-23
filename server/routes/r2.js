import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

import {
  makeKey,
  publicUrlForKey,
  storeRemoteImageToR2,
  parseDataUrl,
  putBufferToR2,
} from "../../r2.js";
import { normalizeIncomingPassId, setPassIdHeader } from "../utils/pass-id.js";
import { safeString } from "../utils/strings.js";

const ENV = process.env;

const R2_ACCOUNT_ID = ENV.R2_ACCOUNT_ID || "";
const R2_ACCESS_KEY_ID = ENV.R2_ACCESS_KEY_ID || "";
const R2_SECRET_ACCESS_KEY = ENV.R2_SECRET_ACCESS_KEY || "";
const R2_BUCKET = ENV.R2_BUCKET || "";

function r2Enabled() {
  return Boolean(R2_ACCOUNT_ID && R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY && R2_BUCKET);
}

function getR2S3Client() {
  if (!r2Enabled()) return null;
  const endpoint = `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
  return new S3Client({
    region: "auto",
    endpoint,
    forcePathStyle: true,
    credentials: {
      accessKeyId: R2_ACCESS_KEY_ID,
      secretAccessKey: R2_SECRET_ACCESS_KEY,
    },
  });
}

export function registerR2Routes(app) {
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
        Bucket: R2_BUCKET,
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
}
