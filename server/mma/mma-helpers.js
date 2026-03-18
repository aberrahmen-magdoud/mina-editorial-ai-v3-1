// server/mma/mma-helpers.js — Small utility functions used across MMA modules
"use strict";

export function safeStr(v, fallback = "") {
  if (v === null || v === undefined) return fallback;
  const s = typeof v === "string" ? v : String(v);
  const t = s.trim();
  return t ? t : fallback;
}

export function asHttpUrl(u) {
  const s = safeStr(u, "");
  return s.startsWith("http") ? s : "";
}

export function safeArray(x) {
  return Array.isArray(x) ? x : [];
}

export function parseJsonMaybe(v) {
  if (!v) return null;
  if (typeof v === "object") return v;
  if (typeof v === "string") {
    try {
      return JSON.parse(v);
    } catch {
      return null;
    }
  }
  return null;
}

export function parseOptionalBool(v) {
  if (v === undefined || v === null) return undefined;
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  const s = safeStr(v, "").toLowerCase();
  if (!s) return undefined;
  if (["1", "true", "yes", "y", "on"].includes(s)) return true;
  if (["0", "false", "no", "n", "off"].includes(s)) return false;
  return Boolean(v);
}

export function normalizeUrlForKey(u) {
  const url = asHttpUrl(u);
  if (!url) return "";
  try {
    const x = new URL(url);
    x.search = "";
    x.hash = "";
    return x.toString();
  } catch {
    return url;
  }
}

export function withKlingImageSizing(u) {
  const raw = asHttpUrl(u);
  if (!raw) return "";
  try {
    const parsed = new URL(raw);
    const host = parsed.hostname.toLowerCase();
    if (!host.endsWith("faltastudio.com")) return raw;
    if (parsed.pathname.includes("/cdn-cgi/image/")) return raw;
    const transformedPath =
      `/cdn-cgi/image/width=2048,fit=scale-down,quality=88,format=jpeg${parsed.pathname}`;
    return `${parsed.protocol}//${parsed.host}${transformedPath}${parsed.search}${parsed.hash}`;
  } catch {
    return raw;
  }
}

export function pushUserMessageLine(vars, text) {
  const t = safeStr(text, "");
  if (!t) return vars;
  const next = { ...(vars || {}) };
  next.userMessages = { ...(next.userMessages || {}) };
  const prev = Array.isArray(next.userMessages.scan_lines) ? next.userMessages.scan_lines : [];
  const index = prev.length;
  next.userMessages.scan_lines = [...prev, { text: t, index }];
  return next;
}

export function lastScanLine(vars, fallbackText = "") {
  const lines = vars?.userMessages?.scan_lines;
  const last = Array.isArray(lines) ? lines[lines.length - 1] : null;
  if (last) return last;
  return { text: fallbackText, index: Array.isArray(lines) ? lines.length : 0 };
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
        "url", "output", "outputs", "image", "images", "video", "videos",
        "video_url", "videoUrl", "mp4", "file", "files", "result", "results", "data",
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

export function resolveFrame2Reference(inputsLike, assetsLike) {
  const inputs = inputsLike && typeof inputsLike === "object" ? inputsLike : {};
  const assets = assetsLike && typeof assetsLike === "object" ? assetsLike : {};

  const guessKindFromUrl = (u) => {
    const url = asHttpUrl(u);
    if (!url) return "";
    try {
      const p = new URL(url).pathname.toLowerCase();
      if (/\.(mp3|wav|m4a|aac|flac|ogg|opus)$/i.test(p)) return "audio";
      if (/\.(mp4|mov|webm|mkv|m4v)$/i.test(p)) return "video";
    } catch {}
    return "";
  };

  const kindRaw0 = safeStr(inputs.frame2_kind || inputs.frame2Kind || "", "").toLowerCase();
  const kindRaw = kindRaw0.replace(/^ref_/, "");
  const urlRaw = asHttpUrl(inputs.frame2_url || inputs.frame2Url || "");
  const durRaw = Number(inputs.frame2_duration_sec || inputs.frame2DurationSec || 0) || 0;

  const assetVideo = asHttpUrl(
    assets.video || assets.video_url || assets.videoUrl ||
      assets.frame2_video_url || assets.frame2VideoUrl
  );
  const assetAudio = asHttpUrl(
    assets.audio || assets.audio_url || assets.audioUrl ||
      assets.frame2_audio_url || assets.frame2AudioUrl
  );

  let kind = kindRaw === "audio" || kindRaw === "video" ? kindRaw : "";
  const urlGuess = guessKindFromUrl(urlRaw);
  if (!kind && urlGuess) kind = urlGuess;
  if (kind && urlGuess && kind !== urlGuess) kind = urlGuess;
  if (!kind) kind = assetVideo ? "video" : assetAudio ? "audio" : "";

  const url = urlRaw || (kind === "video" ? assetVideo : kind === "audio" ? assetAudio : "") || "";
  const dur = durRaw || Number(assets.frame2_duration_sec || assets.frame2DurationSec || 0) || 0;

  if (kind === "video" && url) return { kind: "ref_video", url, rawDurationSec: dur, maxSec: 30 };
  if (kind === "audio" && url) return { kind: "ref_audio", url, rawDurationSec: dur, maxSec: 60 };
  return { kind: null, url: "", rawDurationSec: 0, maxSec: 0 };
}
