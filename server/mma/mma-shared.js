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
    assets.video ||
      assets.video_url ||
      assets.videoUrl ||
      assets.frame2_video_url ||
      assets.frame2VideoUrl
  );

  const assetAudio = asHttpUrl(
    assets.audio ||
      assets.audio_url ||
      assets.audioUrl ||
      assets.frame2_audio_url ||
      assets.frame2AudioUrl
  );

  let kind = kindRaw === "audio" || kindRaw === "video" ? kindRaw : "";

  const urlGuess = guessKindFromUrl(urlRaw);
  if (!kind && urlGuess) kind = urlGuess;
  if (kind && urlGuess && kind !== urlGuess) kind = urlGuess;

  if (!kind) kind = assetVideo ? "video" : assetAudio ? "audio" : "";

  const url =
    urlRaw ||
    (kind === "video" ? assetVideo : kind === "audio" ? assetAudio : "") ||
    "";

  const dur =
    durRaw ||
    Number(assets.frame2_duration_sec || assets.frame2DurationSec || 0) ||
    0;

  if (kind === "video" && url) return { kind: "ref_video", url, rawDurationSec: dur, maxSec: 30 };
  if (kind === "audio" && url) return { kind: "ref_audio", url, rawDurationSec: dur, maxSec: 60 };

  return { kind: null, url: "", rawDurationSec: 0, maxSec: 0 };
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
