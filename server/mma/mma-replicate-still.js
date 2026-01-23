import { asHttpUrl, safeArray, safeStr } from "./mma-shared.js";
import { getMmaConfig } from "./mma-config.js";
import { replicatePredictWithTimeout } from "./replicate-poll.js";
import { nowIso } from "./mma-utils.js";
import {
  REPLICATE_CALL_TIMEOUT_MS,
  REPLICATE_CANCEL_ON_TIMEOUT,
  REPLICATE_MAX_MS,
  REPLICATE_MAX_MS_NANOBANANA,
  REPLICATE_POLL_MS,
  getReplicate,
} from "./mma-replicate-core.js";

export function buildSeedreamImageInputs(vars) {
  const assets = vars?.assets || {};
  const product = asHttpUrl(assets.product_image_url || assets.productImageUrl);
  const logo = asHttpUrl(assets.logo_image_url || assets.logoImageUrl);

  const styleHero = asHttpUrl(
    assets.style_hero_image_url ||
      assets.styleHeroImageUrl ||
      assets.style_hero_url ||
      assets.styleHeroUrl
  );

  const inspiration = safeArray(
    assets.inspiration_image_urls ||
      assets.inspirationImageUrls ||
      assets.style_image_urls ||
      assets.styleImageUrls
  )
    .map(asHttpUrl)
    .filter(Boolean)
    .slice(0, 4);

  return []
    .concat(product ? [product] : [])
    .concat(logo ? [logo] : [])
    .concat(inspiration)
    .concat(styleHero ? [styleHero] : [])
    .filter(Boolean)
    .slice(0, 10);
}

export function nanoBananaEnabled() {
  return !!safeStr(process.env.MMA_NANOBANANA_VERSION, "");
}

export function buildNanoBananaImageInputs(vars) {
  const assets = vars?.assets || {};
  const product = asHttpUrl(assets.product_image_url || assets.productImageUrl);
  const logo = asHttpUrl(assets.logo_image_url || assets.logoImageUrl);

  const styleHero = asHttpUrl(
    assets.style_hero_image_url ||
      assets.styleHeroImageUrl ||
      assets.style_hero_url ||
      assets.styleHeroUrl
  );

  const inspiration = safeArray(
    assets.inspiration_image_urls ||
      assets.inspirationImageUrls ||
      assets.style_image_urls ||
      assets.styleImageUrls
  )
    .map(asHttpUrl)
    .filter(Boolean)
    .slice(0, 10);

  return []
    .concat(product ? [product] : [])
    .concat(logo ? [logo] : [])
    .concat(inspiration)
    .concat(styleHero ? [styleHero] : [])
    .filter(Boolean)
    .slice(0, 14);
}

export async function runNanoBanana({
  prompt,
  aspectRatio,
  imageInputs = [],
  resolution,
  outputFormat,
  safetyFilterLevel,
  input: forcedInput,
}) {
  const replicate = getReplicate();
  const cfg = getMmaConfig();

  const version =
    safeStr(process.env.MMA_NANOBANANA_VERSION, "") ||
    safeStr(cfg?.nanobanana?.model, "") ||
    "google/nano-banana-pro";

  const defaultAspect =
    safeStr(cfg?.nanobanana?.aspectRatio, "") ||
    safeStr(process.env.MMA_NANOBANANA_ASPECT_RATIO, "") ||
    "match_input_image";

  const defaultResolution =
    safeStr(
      String(resolution ?? cfg?.nanobanana?.resolution ?? process.env.MMA_NANOBANANA_RESOLUTION ?? "2K"),
      "2K"
    ) || "2K";

  const defaultFmt =
    safeStr(
      String(outputFormat ?? cfg?.nanobanana?.outputFormat ?? process.env.MMA_NANOBANANA_OUTPUT_FORMAT ?? "jpg"),
      "jpg"
    ) || "jpg";

  const defaultSafety =
    safeStr(
      String(
        safetyFilterLevel ??
          cfg?.nanobanana?.safetyFilterLevel ??
          process.env.MMA_NANOBANANA_SAFETY_FILTER_LEVEL ??
          "block_only_high"
      ),
      "block_only_high"
    ) || "block_only_high";

  const cleanedInputs = safeArray(imageInputs).map(asHttpUrl).filter(Boolean).slice(0, 14);

  const input = forcedInput
    ? { ...forcedInput, prompt: forcedInput.prompt || prompt }
    : {
        prompt,
        resolution: defaultResolution,
        aspect_ratio: aspectRatio || defaultAspect,
        output_format: defaultFmt,
        safety_filter_level: defaultSafety,
        ...(cleanedInputs.length ? { image_input: cleanedInputs } : {}),
      };

  if (!input.prompt) input.prompt = prompt;
  if (!input.resolution) input.resolution = defaultResolution;
  if (!input.aspect_ratio) input.aspect_ratio = aspectRatio || defaultAspect;
  if (!input.output_format) input.output_format = defaultFmt;
  if (!input.safety_filter_level) input.safety_filter_level = defaultSafety;
  if (!input.image_input && cleanedInputs.length) input.image_input = cleanedInputs;

  const t0 = Date.now();

  const pred = await replicatePredictWithTimeout({
    replicate,
    version,
    input,
    timeoutMs: REPLICATE_MAX_MS_NANOBANANA,
    pollMs: REPLICATE_POLL_MS,
    callTimeoutMs: REPLICATE_CALL_TIMEOUT_MS,
    cancelOnTimeout: REPLICATE_CANCEL_ON_TIMEOUT,
  });

  const prediction = pred.prediction || {};
  const out = prediction.output;

  return {
    input,
    out,
    prediction_id: pred.predictionId,
    prediction_status: prediction.status || null,
    timed_out: !!pred.timedOut,
    timing: {
      started_at: new Date(t0).toISOString(),
      ended_at: nowIso(),
      duration_ms: Date.now() - t0,
    },
    provider: { prediction },
  };
}

export async function runSeedream({ prompt, aspectRatio, imageInputs = [], size, enhancePrompt, input: forcedInput }) {
  const replicate = getReplicate();
  const cfg = getMmaConfig();

  const sizeValue = size || cfg?.seadream?.size || process.env.MMA_SEADREAM_SIZE || "2K";
  const defaultAspect =
    cfg?.seadream?.aspectRatio || process.env.MMA_SEADREAM_ASPECT_RATIO || "match_input_image";

  const version =
    process.env.MMA_SEADREAM_VERSION ||
    process.env.MMA_SEADREAM_MODEL_VERSION ||
    cfg?.seadream?.model ||
    "bytedance/seedream-4";

  const neg =
    process.env.NEGATIVE_PROMPT_SEADREAM ||
    process.env.MMA_NEGATIVE_PROMPT_SEADREAM ||
    cfg?.seadream?.negativePrompt ||
    "";

  const finalPrompt = neg ? `${prompt}\n\nAvoid: ${neg}` : prompt;

  const cleanedInputs = safeArray(imageInputs).map(asHttpUrl).filter(Boolean).slice(0, 10);

  const enhance_prompt =
    enhancePrompt !== undefined
      ? enhancePrompt
      : cfg?.seadream?.enhancePrompt !== undefined
        ? !!cfg.seadream.enhancePrompt
        : true;

  const input = forcedInput
    ? { ...forcedInput, prompt: forcedInput.prompt || finalPrompt }
    : {
        prompt: finalPrompt,
        size: sizeValue,
        aspect_ratio: aspectRatio || defaultAspect,
        enhance_prompt,
        sequential_image_generation: "disabled",
        max_images: 1,
        ...(cleanedInputs.length ? { image_input: cleanedInputs } : {}),
      };

  if (!input.aspect_ratio) input.aspect_ratio = aspectRatio || defaultAspect;
  if (!input.size) input.size = sizeValue;
  if (input.enhance_prompt === undefined) input.enhance_prompt = enhance_prompt;
  if (!input.sequential_image_generation) input.sequential_image_generation = "disabled";
  if (!input.max_images) input.max_images = 1;
  if (!input.image_input && cleanedInputs.length) input.image_input = cleanedInputs;

  const t0 = Date.now();

  const pred = await replicatePredictWithTimeout({
    replicate,
    version,
    input,
    timeoutMs: REPLICATE_MAX_MS,
    pollMs: REPLICATE_POLL_MS,
    callTimeoutMs: REPLICATE_CALL_TIMEOUT_MS,
    cancelOnTimeout: REPLICATE_CANCEL_ON_TIMEOUT,
  });

  const prediction = pred.prediction || {};
  const out = prediction.output;

  return {
    input,
    out,
    prediction_id: pred.predictionId,
    prediction_status: prediction.status || null,
    timed_out: !!pred.timedOut,
    timing: {
      started_at: new Date(t0).toISOString(),
      ended_at: nowIso(),
      duration_ms: Date.now() - t0,
    },
    provider: { prediction },
  };
}
