import Replicate from "replicate";

let _replicate = null;
export function getReplicate() {
  if (_replicate) return _replicate;
  if (!process.env.REPLICATE_API_TOKEN) throw new Error("REPLICATE_API_TOKEN_MISSING");
  _replicate = new Replicate({ auth: process.env.REPLICATE_API_TOKEN });
  return _replicate;
}

export function pickFirstUrl(output) {
  const seen = new Set();

  const isUrl = (s) => typeof s === "string" && /^https?:\/\//i.test(s.trim());

  const walk = (v) => {
    if (!v) return "";

    if (typeof v === "string") return isUrl(v) ? v.trim() : "";

    if (v && typeof v === "object" && typeof v.url === "function") {
      try {
        const u = v.url();
        if (isUrl(u)) return u.trim();
      } catch {}
    }

    if (Array.isArray(v)) {
      for (const item of v) {
        const u = walk(item);
        if (u) return u;
      }
      return "";
    }

    if (typeof v === "object") {
      if (seen.has(v)) return "";
      seen.add(v);

      const keys = [
        "url",
        "output",
        "outputs",
        "image",
        "images",
        "video",
        "video_url",
        "videoUrl",
        "mp4",
        "file",
        "files",
        "result",
        "results",
        "data",
      ];

      for (const k of keys) {
        if (Object.prototype.hasOwnProperty.call(v, k)) {
          const u = walk(v[k]);
          if (u) return u;
        }
      }

      for (const val of Object.values(v)) {
        const u = walk(val);
        if (u) return u;
      }
    }

    return "";
  };

  return walk(output);
}

// ---- HARD TIMEOUT settings (4 minutes default) ----
export const REPLICATE_MAX_MS = Number(process.env.MMA_REPLICATE_MAX_MS || 900000) || 900000;
export const REPLICATE_MAX_MS_NANOBANANA =
  Number(process.env.MMA_REPLICATE_MAX_MS_NANOBANANA || 900000) || 900000;
export const REPLICATE_POLL_MS = Number(process.env.MMA_REPLICATE_POLL_MS || 2500) || 2500;
export const REPLICATE_CALL_TIMEOUT_MS = Number(process.env.MMA_REPLICATE_CALL_TIMEOUT_MS || 15000) || 15000;
export const REPLICATE_CANCEL_ON_TIMEOUT =
  String(process.env.MMA_REPLICATE_CANCEL_ON_TIMEOUT || "false").toLowerCase() === "true";
