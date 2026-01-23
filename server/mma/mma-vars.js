const MMA_VERSION = "2025-12-23";

function safeString(v, fallback = "") {
  if (v === null || v === undefined) return fallback;
  return String(v).trim() || fallback;
}

function asArray(v) {
  return Array.isArray(v) ? v : [];
}

function asStrOrNull(v) {
  const s = safeString(v, "");
  return s ? s : null;
}

// Vars canonicalizer (single source of truth for pipelines)
export function makeInitialVars({
  mode = "still",
  assets = {},
  history = {},
  inputs = {},
  prompts = {},
  feedback = {},
  settings = {},
} = {}) {
  const productUrl = asStrOrNull(assets.productImageUrl || assets.product_image_url || assets.product_url);
  const logoUrl = asStrOrNull(assets.logoImageUrl || assets.logo_image_url || assets.logo_url);

  const inspirationUrls = []
    .concat(asArray(assets.inspiration_image_urls))
    .concat(asArray(assets.inspirationImageUrls))
    .concat(asArray(assets.style_image_urls))
    .concat(asArray(assets.styleImageUrls))
    .concat(asArray(assets.inspiration_urls))
    .filter((x) => typeof x === "string" && x.trim());

  const styleHeroUrl = asStrOrNull(
    assets.style_hero_image_url ||
      assets.styleHeroImageUrl ||
      assets.style_hero_url ||
      assets.styleHeroUrl
  );

  const frame2AudioUrl = asStrOrNull(
    assets.frame2_audio_url ||
      assets.frame2AudioUrl ||
      assets.audio_url ||
      assets.audioUrl ||
      assets.audio
  );

  const frame2VideoUrl = asStrOrNull(
    assets.frame2_video_url ||
      assets.frame2VideoUrl ||
      assets.video_url ||
      assets.videoUrl ||
      assets.video
  );

  const frame2Kind = safeString(
    inputs.frame2_kind ||
      inputs.frame2Kind ||
      (frame2AudioUrl ? "audio" : frame2VideoUrl ? "video" : ""),
    ""
  );

  const frame2Url =
    asStrOrNull(inputs.frame2_url || inputs.frame2Url) ||
    (frame2Kind.toLowerCase().includes("audio") ? frame2AudioUrl : frame2VideoUrl) ||
    frame2AudioUrl ||
    frame2VideoUrl ||
    null;

  const frame2DurationSecRaw =
    inputs.frame2_duration_sec ||
    inputs.frame2DurationSec ||
    assets.frame2_duration_sec ||
    assets.frame2DurationSec ||
    null;

  const frame2DurationSec =
    frame2DurationSecRaw != null && frame2DurationSecRaw !== ""
      ? Number(frame2DurationSecRaw)
      : null;

  const klingUrls = []
    .concat(asArray(assets.kling_images))
    .concat(asArray(assets.klingImages))
    .concat(asArray(assets.kling_image_urls))
    .filter((x) => typeof x === "string" && x.trim());

  const startUrl = asStrOrNull(assets.start_image_url || assets.startImageUrl);
  const endUrl = asStrOrNull(assets.end_image_url || assets.endImageUrl);

  const brief = safeString(inputs.brief || inputs.userBrief || inputs.prompt, "");

  const motionUserBrief = safeString(
    inputs.motion_user_brief ||
      inputs.motionBrief ||
      inputs.motion_description ||
      inputs.motionDescription ||
      "",
    ""
  );

  const selectedMovementStyle = safeString(
    inputs.selected_movement_style ||
      inputs.movement_style ||
      inputs.movementStyle ||
      "",
    ""
  );

  const typeForMe = inputs.type_for_me ?? inputs.typeForMe ?? inputs.use_suggestion ?? false;
  const suggestOnly = inputs.suggest_only ?? inputs.suggestOnly ?? false;

  const cleanPrompt = prompts.clean_prompt || prompts.cleanPrompt || null;
  const motionPrompt = prompts.motion_prompt || prompts.motionPrompt || null;

  const suggPrompt =
    prompts.sugg_prompt ||
    prompts.suggPrompt ||
    prompts.motion_sugg_prompt ||
    prompts.motionSuggPrompt ||
    null;

  const visionIntelligence = history.vision_intelligence ?? true;
  const likeWindow = visionIntelligence === false ? 20 : 5;

  return {
    version: MMA_VERSION,
    mode,

    assets: {
      product_image_id: assets.product_image_id || null,
      logo_image_id: assets.logo_image_id || null,
      inspiration_image_ids: assets.inspiration_image_ids || [],
      style_hero_image_id: assets.style_hero_image_id || null,
      input_still_image_id: assets.input_still_image_id || null,

      product_image_url: productUrl,
      logo_image_url: logoUrl,

      inspiration_image_urls: inspirationUrls,
      style_image_urls: inspirationUrls,

      style_hero_image_url: styleHeroUrl,

      audio: frame2AudioUrl,
      audio_url: frame2AudioUrl,
      frame2_audio_url: frame2AudioUrl,

      video: frame2VideoUrl,
      video_url: frame2VideoUrl,
      frame2_video_url: frame2VideoUrl,

      kling_image_urls: klingUrls,
      start_image_url: startUrl,
      end_image_url: endUrl,

      frame2_duration_sec: frame2DurationSec,
    },

    scans: {
      product_crt: null,
      logo_crt: null,
      inspiration_crt: [],
      still_crt: null,
      output_still_crt: null,
    },

    history: {
      vision_intelligence: visionIntelligence,
      like_window: likeWindow,
      style_history_csv: history.style_history_csv || null,
    },

    inputs: {
      brief,

      still_lane: safeString(
        inputs.still_lane ||
          inputs.stillLane ||
          inputs.model_lane ||
          inputs.modelLane ||
          inputs.lane ||
          inputs.create_lane ||
          inputs.createLane,
        ""
      ),

      motion_user_brief: motionUserBrief,
      selected_movement_style: selectedMovementStyle,

      start_image_url: asStrOrNull(inputs.start_image_url || inputs.startImageUrl) || startUrl,
      end_image_url: asStrOrNull(inputs.end_image_url || inputs.endImageUrl) || endUrl,

      type_for_me: !!typeForMe,
      suggest_only: !!suggestOnly,

      use_prompt_override: !!(inputs.use_prompt_override ?? inputs.usePromptOverride ?? false),
      prompt_override: safeString(
        inputs.prompt_override ||
          inputs.motion_prompt_override ||
          inputs.motionPromptOverride ||
          "",
        ""
      ),

      frame2_kind: frame2Kind,
      frame2_url: frame2Url,
      frame2_duration_sec: frame2DurationSec,

      userBrief: safeString(inputs.userBrief, ""),
      style: safeString(inputs.style, ""),
      movement_style: safeString(inputs.movement_style, ""),

      platform: safeString(inputs.platform || inputs.platformKey, ""),
      aspect_ratio: safeString(inputs.aspect_ratio || inputs.aspectRatio, ""),
      duration: inputs.duration ?? null,
      mode: safeString(inputs.mode || inputs.kling_mode, ""),
      negative_prompt: safeString(inputs.negative_prompt || inputs.negativePrompt, ""),
    },

    prompts: {
      clean_prompt: cleanPrompt,
      motion_prompt: motionPrompt,
      sugg_prompt: suggPrompt,
      motion_sugg_prompt: suggPrompt,
    },

    feedback: {
      still_feedback: feedback.still_feedback || feedback.feedback_still || null,
      motion_feedback: feedback.motion_feedback || feedback.feedback_motion || null,
    },

    userMessages: { scan_lines: [], final_line: null },

    settings: {
      seedream: settings.seedream || {},
      kling: settings.kling || {},
    },

    outputs: {
      seedream_image_url: null,
      kling_video_url: null,
      seedream_image_id: null,
      kling_video_id: null,
    },

    meta: { ctx_versions: {}, settings_versions: {} },
  };
}

// Scan line helper (if you ever want to use it instead of controller helper)
export function appendScanLine(vars, text) {
  const base = vars && typeof vars === "object" ? vars : makeInitialVars({});
  const next = {
    ...base,
    userMessages: {
      ...(base.userMessages || { scan_lines: [], final_line: null }),
    },
  };

  const scanLines = Array.isArray(next.userMessages.scan_lines)
    ? [...next.userMessages.scan_lines]
    : [];

  const t = typeof text === "string" ? text : safeString(text?.text, "");
  if (!t) return next;

  scanLines.push({ index: scanLines.length, text: t });
  next.userMessages.scan_lines = scanLines;
  return next;
}

export function makePlaceholderUrl(kind, id) {
  const base = safeString(process.env.R2_PUBLIC_BASE_URL, "https://example.r2.dev");
  return `${base.replace(/\\/+$/, "")}/${kind}/${id}`;
}

// Backward-compat for callers expecting mma-utils safeArray/safeStr behavior
