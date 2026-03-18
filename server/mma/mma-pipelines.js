// server/mma/mma-pipelines.js — The 4 async pipelines (still create, still tweak, video animate, video tweak)
"use strict";

import { getMmaConfig } from "./mma-config.js";
import { nowIso } from "./mma-utils.js";
import {
  safeStr,
  asHttpUrl,
  safeArray,
  parseOptionalBool,
  normalizeUrlForKey,
  pushUserMessageLine,
  lastScanLine,
  pickFirstUrl,
  resolveFrame2Reference,
} from "./mma-helpers.js";
import { MMA_UI, pick, mixedPool, pickAvoid } from "./mma-ui-text.js";
import { addSseClient, sendDone, sendScanLine, sendStatus } from "./mma-sse.js";
import { getMmaCtxConfig } from "./mma-ctx-config.js";
import { gptStillOneShotCreate, gptStillOneShotTweak, gptMotionOneShotAnimate, gptMotionOneShotTweak } from "./mma-gpt-steps.js";
import { buildSeedreamImageInputs, runSeedream } from "./mma-seedream.js";
import { buildNanoBananaImageInputs, runNanoBanana, runNanoBananaGemini } from "./mma-nanobanana.js";
import { runKling, pickKlingStartImage, pickKlingEndImage, KLING_DEFAULT_NEGATIVE_PROMPT } from "./mma-kling.js";
import { runKlingOmni, runKlingMotionControl } from "./mma-kling-omni.js";
import { storeRemoteToR2Public } from "./mma-r2.js";
import {
  resolveStillLane,
  resolveStillEngine,
  resolveStillLaneFromInputs,
  stillCostForLane,
  stillResolutionMeta,
  resolveAppliedStillResolution,
  resolveVideoPricing,
  resolveVideoDurationSec,
  videoCostFromInputs,
  chargeGeneration,
  refundOnFailure,
  commitTypeForMeSuccessAndMaybeCharge,
} from "./mma-credits.js";
import {
  writeGeneration,
  writeStep,
  finalizeGeneration,
  updateVars,
  updateStatus,
} from "./mma-db.js";

// ============================================================================
// SSE emit helpers (local wrappers)
// ============================================================================
function emitStatus(generationId, internalStatus) {
  sendStatus(generationId, String(internalStatus || ""));
}

function emitLine(generationId, vars, fallbackText = "") {
  const line = lastScanLine(vars, fallbackText);
  sendScanLine(generationId, line);
}

// ============================================================================
// Keep Mina talking during long steps (Seedream / Kling)
// ============================================================================
function startMinaChatter({
  supabase,
  generationId,
  getVars,
  setVars,
  stage = "generating",
  intervalMs = 2600,
}) {
  let stopped = false;

  const tick = async () => {
    if (stopped) return;
    try {
      let v = getVars();
      const avoid = (lastScanLine(getVars?.() || v || {}, "") || {}).text || "";
      const line = pickAvoid(mixedPool(stage), avoid, "");
      if (!line) return;

      v = pushUserMessageLine(v, line);
      setVars(v);

      await updateVars({ supabase, generationId, vars: v });
      emitLine(generationId, v);
    } catch {
      // ignore chatter errors
    }
  };

  void tick();

  const id = setInterval(() => {
    void tick();
  }, Math.max(800, Number(intervalMs) || 2600));

  return {
    stop() {
      stopped = true;
      clearInterval(id);
    },
  };
}

// ============================================================================
// STILL CREATE PIPELINE
// ============================================================================
export async function runStillCreatePipeline({ supabase, generationId, passId, vars, preferences }) {
  const cfg = getMmaConfig();
  if (!cfg.enabled) throw new Error("MMA_DISABLED");

  let working = vars;

  const stillLane = resolveStillLane(working);
  const stillCost = stillCostForLane(stillLane);
  await chargeGeneration({
    passId,
    generationId,
    cost: stillCost,
    reason: stillLane === "niche" ? "mma_still_niche" : "mma_still",
    lane: stillLane,
  });

  const ctx = await getMmaCtxConfig(supabase);
  let chatter = null;

  try {
    await updateStatus({ supabase, generationId, status: "prompting" });
    emitStatus(generationId, "prompting");

    working = pushUserMessageLine(working, pick(MMA_UI.quickLines.still_create_start));
    await updateVars({ supabase, generationId, vars: working });
    emitLine(generationId, working);

    let stepNo = 1;

    // Collect assets
    const assets = working?.assets || {};
    const productUrl = asHttpUrl(assets.product_image_url || assets.productImageUrl);
    const logoUrl = asHttpUrl(assets.logo_image_url || assets.logoImageUrl);

    const explicitHero =
      asHttpUrl(
        assets.style_hero_image_url ||
          assets.styleHeroImageUrl ||
          assets.style_hero_url ||
          assets.styleHeroUrl
      ) || "";

    const inspUrlsRaw = safeArray(
      assets.inspiration_image_urls ||
        assets.inspirationImageUrls ||
        assets.style_image_urls ||
        assets.styleImageUrls
    )
      .map(asHttpUrl)
      .filter(Boolean);

    const heroCandidates = []
      .concat(explicitHero ? [explicitHero] : [])
      .concat(safeArray(assets.style_hero_image_urls || assets.styleHeroImageUrls).map(asHttpUrl))
      .concat(safeArray(cfg?.seadream?.styleHeroUrls || cfg?.styleHeroUrls).map(asHttpUrl))
      .filter(Boolean);

    const heroKeySet = new Set(heroCandidates.map((u) => normalizeUrlForKey(u)).filter(Boolean));

    const heroFromInsp = !explicitHero
      ? (inspUrlsRaw.find((u) => heroKeySet.has(normalizeUrlForKey(u))) || "")
      : "";

    const heroUrl = explicitHero || heroFromInsp || "";

    if (heroUrl) {
      working.assets = { ...(working.assets || {}), style_hero_image_url: heroUrl };
    }

    const heroKey = heroUrl ? normalizeUrlForKey(heroUrl) : "";
    const inspUrlsForGpt = inspUrlsRaw
      .filter((u) => {
        const k = normalizeUrlForKey(u);
        if (!k) return false;
        if (heroKey && k === heroKey) return false;
        if (heroKeySet.size && heroKeySet.has(k)) return false;
        return true;
      })
      .slice(0, 8);

    const labeledImages = []
      .concat(productUrl ? [{ role: "SCENE / COMPOSITION / ASTHETIC / VIBE / STYLE", url: productUrl }] : [])
      .concat(logoUrl ? [{ role: "LOGO / LABEL / ICON / TEXT / DESIGN", url: logoUrl }] : [])
      .concat(
        inspUrlsForGpt.map((u, i) => ({
          role: `PRODUCT / ELEMENT / TEXTURE / MATERIAL ${i + 1}`,
          url: u,
        }))
      )
      .slice(0, 10);


    const oneShotInput = {
      user_brief: safeStr(working?.inputs?.brief || working?.inputs?.userBrief, ""),
      style: safeStr(working?.inputs?.style, ""),
      preferences: preferences || {},
      hard_blocks: safeArray(preferences?.hard_blocks),
      notes: "Write a clean image prompt using the labeled images as references.",
    };

    const t0 = Date.now();
    const one = await gptStillOneShotCreate({ cfg, ctx, input: oneShotInput, labeledImages });

    await writeStep({
      supabase,
      generationId,
      passId,
      stepNo: stepNo++,
      stepType: "gpt_still_one_shot",
      payload: {
        ctx: ctx.still_one_shot,
        input: oneShotInput,
        labeledImages,
        request: one.request,
        raw: one.raw,
        output: { clean_prompt: one.clean_prompt, debug: one.debug, parsed_ok: one.parsed_ok },
        timing: { started_at: new Date(t0).toISOString(), ended_at: nowIso(), duration_ms: Date.now() - t0 },
        error: null,
      },
    });

    const usedPrompt =
      safeStr(one.clean_prompt, "") ||
      safeStr(working?.inputs?.prompt, "") ||
      safeStr(working?.prompts?.clean_prompt, "");

    if (!usedPrompt) throw new Error("EMPTY_PROMPT_ONE_SHOT");

    working.prompts = { ...(working.prompts || {}), clean_prompt: usedPrompt };
    await updateVars({ supabase, generationId, vars: working });

    await updateStatus({ supabase, generationId, status: "generating" });
    emitStatus(generationId, "generating");

    chatter = startMinaChatter({
      supabase,
      generationId,
      getVars: () => working,
      setVars: (v) => {
        working = v;
      },
      stage: "generating",
      intervalMs: 2600,
    });

    const stillLane2 = resolveStillLane(working);
    const stillEngine = resolveStillEngine(working);
    const appliedResolution = resolveAppliedStillResolution(working?.inputs || {});

    working.inputs = { ...(working.inputs || {}), ...stillResolutionMeta(appliedResolution) };
    working.meta = {
      ...(working.meta || {}),
      still_lane: stillLane2,
      still_engine: stillEngine,
      ...stillResolutionMeta(appliedResolution),
    };
    await updateVars({ supabase, generationId, vars: working });

    const useNanoLike = stillEngine === "nanobanana" || stillEngine === "nanobanana2";
    const imageInputs = useNanoLike
      ? buildNanoBananaImageInputs(working)
      : buildSeedreamImageInputs(working);

    let aspectRatio =
      safeStr(working?.inputs?.aspect_ratio, "") ||
      (useNanoLike
        ? process.env.MMA_NANOBANANA_ASPECT_RATIO || cfg?.nanobanana?.aspectRatio
        : cfg?.seadream?.aspectRatio || process.env.MMA_SEADREAM_ASPECT_RATIO) ||
      "match_input_image";

    if (!imageInputs.length && String(aspectRatio).toLowerCase().includes("match")) {
      aspectRatio = useNanoLike
        ? process.env.MMA_NANOBANANA_FALLBACK_ASPECT_RATIO || cfg?.nanobanana?.fallbackAspectRatio || "1:1"
        : cfg?.seadream?.fallbackAspectRatio || process.env.MMA_SEADREAM_FALLBACK_ASPECT_RATIO || "1:1";
    }

    let genRes;
    try {
      genRes =
        stillEngine === "nanobanana2"
          ? await runNanoBananaGemini({
              prompt: usedPrompt,
              aspectRatio,
              imageInputs,
              resolution: appliedResolution,
              imageSize: process.env.MMA_MAIN_GEMINI_IMAGE_SIZE || appliedResolution,
              model: process.env.MMA_MAIN_GEMINI_MODEL || "gemini-3.1-flash-image-preview",
              thinkingLevel: process.env.MMA_MAIN_GEMINI_THINKING_LEVEL || "High",
              includeThoughts: parseOptionalBool(process.env.MMA_MAIN_GEMINI_INCLUDE_THOUGHTS),
              useGoogleSearch: parseOptionalBool(process.env.MMA_MAIN_GEMINI_USE_GOOGLE_SEARCH),
              useImageSearch: parseOptionalBool(process.env.MMA_MAIN_GEMINI_USE_IMAGE_SEARCH),
              responseModalities: ["IMAGE"],
              compressToJpeg: true,
            })
          : stillEngine === "nanobanana"
            ? await runNanoBanana({
                prompt: usedPrompt,
                aspectRatio,
                imageInputs,
                resolution: appliedResolution,
                outputFormat: cfg?.nanobanana?.outputFormat,
                safetyFilterLevel: cfg?.nanobanana?.safetyFilterLevel,
              })
            : await runSeedream({
                prompt: usedPrompt,
                aspectRatio,
                imageInputs,
                size: appliedResolution,
                enhancePrompt: cfg?.seadream?.enhancePrompt,
              });

      working.outputs = { ...(working.outputs || {}) };
      if (stillEngine === "nanobanana") {
        working.outputs.nanobanana_prediction_id = genRes.prediction_id || null;
      } else if (stillEngine === "seedream") {
        working.outputs.seedream_prediction_id = genRes.prediction_id || null;
      }

      await updateVars({ supabase, generationId, vars: working });
    } finally {
      try {
        chatter?.stop?.();
      } catch {}
      chatter = null;
    }

    const { input, out, timing } = genRes;

    await writeStep({
      supabase,
      generationId,
      passId,
      stepNo: stepNo++,
      stepType:
        stillEngine === "nanobanana2"
          ? "nanobanana2_generate"
          : stillEngine === "nanobanana"
            ? "nanobanana_generate"
            : "seedream_generate",
      payload: { input, output: out, timing, error: null },
    });

    const url = pickFirstUrl(out);
    if (!url) {
      throw new Error(
        stillEngine === "nanobanana2"
          ? "NANOBANANA2_NO_URL"
          : stillEngine === "nanobanana"
            ? "NANOBANANA_NO_URL"
            : "SEADREAM_NO_URL"
      );
    }

    const remoteUrl = await storeRemoteToR2Public(url, `mma/still/${generationId}`);
    working.outputs = { ...(working.outputs || {}) };
    if (stillEngine === "nanobanana2") {
      working.outputs.nanobanana2_image_url = remoteUrl;
      working.outputs.nanobanana_image_url = remoteUrl;
    } else if (stillEngine === "nanobanana") {
      working.outputs.nanobanana_image_url = remoteUrl;
    } else {
      working.outputs.seedream_image_url = remoteUrl;
    }

    working.mg_output_url = remoteUrl;

    working = pushUserMessageLine(working, pick(MMA_UI.quickLines.saved_image));
    await updateVars({ supabase, generationId, vars: working });
    emitLine(generationId, working);

    await finalizeGeneration({ supabase, generationId, url: remoteUrl, prompt: usedPrompt, vars: working, mode: "still", matchasCharged: stillCost });

    await updateStatus({ supabase, generationId, status: "done" });
    emitStatus(generationId, "done");
    sendDone(generationId, "done");
  } catch (err) {
    try {
      chatter?.stop?.();
    } catch {}
    chatter = null;

    console.error("[mma] still create pipeline error", err);

    await updateStatus({ supabase, generationId, status: "error" });
    await supabase
      .from("mega_generations")
      .update({
        mg_error: {
          code: "PIPELINE_ERROR",
          message: err?.message || String(err || ""),
          provider: err?.provider || null,
        },
        mg_updated_at: nowIso(),
      })
      .eq("mg_generation_id", generationId)
      .eq("mg_record_type", "generation");

    try {
      await refundOnFailure({ supabase, passId, generationId, cost: stillCost, err });
    } catch (e) {
      console.warn("[mma] refund failed (still create)", e?.message || e);
    }

    emitStatus(generationId, "error");
    sendDone(generationId, "error");
  }
}

// ============================================================================
// STILL TWEAK PIPELINE
// ============================================================================
export async function runStillTweakPipeline({ supabase, generationId, passId, parent, vars, preferences }) {
  const cfg = getMmaConfig();
  if (!cfg.enabled) throw new Error("MMA_DISABLED");

  let working = vars;

  const stillLane = resolveStillLane(working);
  const stillCost = stillCostForLane(stillLane);
  await chargeGeneration({
    passId,
    generationId,
    cost: stillCost,
    reason: stillLane === "niche" ? "mma_still_niche" : "mma_still",
    lane: stillLane,
  });

  const ctx = await getMmaCtxConfig(supabase);
  let chatter = null;

  try {
    await updateStatus({ supabase, generationId, status: "prompting" });
    emitStatus(generationId, "prompting");

    working = pushUserMessageLine(working, pick(MMA_UI.quickLines.still_tweak_start));
    await updateVars({ supabase, generationId, vars: working });
    emitLine(generationId, working);

    const parentUrl = asHttpUrl(parent?.mg_output_url);
    if (!parentUrl) throw new Error("PARENT_OUTPUT_URL_MISSING");

    const feedbackText =
      safeStr(working?.feedback?.still_feedback, "") ||
      safeStr(working?.feedback?.feedback_still, "") ||
      safeStr(working?.feedback?.text, "") ||
      safeStr(working?.inputs?.feedback_still, "") ||
      safeStr(working?.inputs?.feedback, "") ||
      safeStr(working?.inputs?.comment, "");

    if (!feedbackText) throw new Error("MISSING_STILL_FEEDBACK");

    let stepNo = 1;

    const oneShotInput = {
      parent_image_url: parentUrl,
      feedback: feedbackText,
      previous_prompt: safeStr(parent?.mg_prompt, ""),
      preferences: preferences || {},
      hard_blocks: safeArray(preferences?.hard_blocks),
      notes: "Keep the main subject consistent. Apply feedback precisely.",
    };

    const labeledImages = [{ role: "PARENT_IMAGE", url: parentUrl }];

    const t0 = Date.now();
    const one = await gptStillOneShotTweak({ cfg, ctx, input: oneShotInput, labeledImages });

    await writeStep({
      supabase,
      generationId,
      passId,
      stepNo: stepNo++,
      stepType: "gpt_still_tweak_one_shot",
      payload: {
        ctx: ctx.still_tweak_one_shot,
        input: oneShotInput,
        labeledImages,
        request: one.request,
        raw: one.raw,
        output: { clean_prompt: one.clean_prompt, parsed_ok: one.parsed_ok },
        timing: { started_at: new Date(t0).toISOString(), ended_at: nowIso(), duration_ms: Date.now() - t0 },
        error: null,
      },
    });

    const usedPrompt = safeStr(one.clean_prompt, "");
    if (!usedPrompt) throw new Error("EMPTY_TWEAK_PROMPT_ONE_SHOT");

    working.prompts = { ...(working.prompts || {}), clean_prompt: usedPrompt };
    await updateVars({ supabase, generationId, vars: working });

    await updateStatus({ supabase, generationId, status: "generating" });
    emitStatus(generationId, "generating");

    chatter = startMinaChatter({
      supabase,
      generationId,
      getVars: () => working,
      setVars: (v) => {
        working = v;
      },
      stage: "generating",
      intervalMs: 2600,
    });

    const stillLane2 = resolveStillLane(working);
    const stillEngine = resolveStillEngine(working);
    const appliedResolution = resolveAppliedStillResolution(working?.inputs || {});

    working.inputs = { ...(working.inputs || {}), ...stillResolutionMeta(appliedResolution) };
    working.meta = {
      ...(working.meta || {}),
      still_lane: stillLane2,
      still_engine: stillEngine,
      ...stillResolutionMeta(appliedResolution),
    };
    await updateVars({ supabase, generationId, vars: working });

    const useNanoLike = stillEngine === "nanobanana" || stillEngine === "nanobanana2";

    let aspectRatio =
      safeStr(working?.inputs?.aspect_ratio, "") ||
      (useNanoLike
        ? process.env.MMA_NANOBANANA_ASPECT_RATIO || cfg?.nanobanana?.aspectRatio
        : cfg?.seadream?.aspectRatio || process.env.MMA_SEADREAM_ASPECT_RATIO) ||
      "match_input_image";

    if (String(aspectRatio).toLowerCase().includes("match") && !parentUrl) {
      aspectRatio = "1:1";
    }

    const forcedInput =
      stillEngine === "nanobanana2"
        ? {
            prompt: usedPrompt,
            resolution: appliedResolution,
            aspect_ratio: aspectRatio,
            image_input: [parentUrl],
          }
        : stillEngine === "nanobanana"
          ? {
              prompt: usedPrompt,
              resolution: appliedResolution,
              aspect_ratio: aspectRatio,
              output_format: cfg?.nanobanana?.outputFormat || process.env.MMA_NANOBANANA_OUTPUT_FORMAT || "jpg",
              safety_filter_level:
                cfg?.nanobanana?.safetyFilterLevel || process.env.MMA_NANOBANANA_SAFETY_FILTER_LEVEL || "block_only_high",
              image_input: [parentUrl],
            }
          : {
              prompt: usedPrompt,
              size: appliedResolution,
              aspect_ratio: aspectRatio,
              enhance_prompt: !!cfg?.seadream?.enhancePrompt,
              sequential_image_generation: "disabled",
              max_images: 1,
              image_input: [parentUrl],
            };

    let genRes;
    try {
      genRes =
        stillEngine === "nanobanana2"
          ? await runNanoBananaGemini({
              prompt: usedPrompt,
              aspectRatio,
              imageInputs: [parentUrl],
              input: forcedInput,
              resolution: appliedResolution,
              imageSize: process.env.MMA_MAIN_GEMINI_IMAGE_SIZE || appliedResolution,
              model: process.env.MMA_MAIN_GEMINI_MODEL || "gemini-3.1-flash-image-preview",
              thinkingLevel: process.env.MMA_MAIN_GEMINI_THINKING_LEVEL || "High",
              includeThoughts: parseOptionalBool(process.env.MMA_MAIN_GEMINI_INCLUDE_THOUGHTS),
              useGoogleSearch: parseOptionalBool(process.env.MMA_MAIN_GEMINI_USE_GOOGLE_SEARCH),
              useImageSearch: parseOptionalBool(process.env.MMA_MAIN_GEMINI_USE_IMAGE_SEARCH),
              responseModalities: ["IMAGE"],
              compressToJpeg: true,
            })
          : stillEngine === "nanobanana"
            ? await runNanoBanana({
                prompt: usedPrompt,
                aspectRatio,
                imageInputs: [parentUrl],
                input: forcedInput,
              })
            : await runSeedream({
                prompt: usedPrompt,
                aspectRatio,
                imageInputs: [parentUrl],
                size: cfg?.seadream?.size,
                enhancePrompt: cfg?.seadream?.enhancePrompt,
                input: forcedInput,
              });
    } finally {
      try {
        chatter?.stop?.();
      } catch {}
      chatter = null;
    }

    const { input, out, timing } = genRes;

    await writeStep({
      supabase,
      generationId,
      passId,
      stepNo: stepNo++,
      stepType:
        stillEngine === "nanobanana2"
          ? "nanobanana2_generate_tweak"
          : stillEngine === "nanobanana"
            ? "nanobanana_generate_tweak"
            : "seedream_generate_tweak",
      payload: { input, output: out, timing, error: null },
    });

    const genUrl = pickFirstUrl(out);
    if (!genUrl) {
      throw new Error(
        stillEngine === "nanobanana2"
          ? "NANOBANANA2_NO_URL_TWEAK"
          : stillEngine === "nanobanana"
            ? "NANOBANANA_NO_URL_TWEAK"
            : "SEADREAM_NO_URL_TWEAK"
      );
    }

    const remoteUrl = await storeRemoteToR2Public(genUrl, `mma/still/${generationId}`);

    working.outputs = { ...(working.outputs || {}) };
    if (stillEngine === "nanobanana2") {
      working.outputs.nanobanana2_image_url = remoteUrl;
      working.outputs.nanobanana_image_url = remoteUrl;
    } else if (stillEngine === "nanobanana") {
      working.outputs.nanobanana_image_url = remoteUrl;
    } else {
      working.outputs.seedream_image_url = remoteUrl;
    }

    working.mg_output_url = remoteUrl;

    working = pushUserMessageLine(working, pick(MMA_UI.quickLines.saved_image));
    await updateVars({ supabase, generationId, vars: working });
    emitLine(generationId, working);

    await finalizeGeneration({ supabase, generationId, url: remoteUrl, prompt: usedPrompt, vars: working, mode: "still", matchasCharged: stillCost });

    await updateStatus({ supabase, generationId, status: "done" });
    emitStatus(generationId, "done");
    sendDone(generationId, "done");
  } catch (err) {
    try {
      chatter?.stop?.();
    } catch {}
    chatter = null;

    console.error("[mma] still tweak pipeline error", err);

    await updateStatus({ supabase, generationId, status: "error" });
    await supabase
      .from("mega_generations")
      .update({
        mg_error: {
          code: "PIPELINE_ERROR",
          message: err?.message || String(err || ""),
          provider: err?.provider || null,
        },
        mg_updated_at: nowIso(),
      })
      .eq("mg_generation_id", generationId)
      .eq("mg_record_type", "generation");

    try {
      await refundOnFailure({ supabase, passId, generationId, cost: stillCost, err });
    } catch (e) {
      console.warn("[mma] refund failed (still tweak)", e?.message || e);
    }

    emitStatus(generationId, "error");
    sendDone(generationId, "error");
  }
}

// ============================================================================
// VIDEO ANIMATE PIPELINE (Kling)
// ============================================================================
export async function runVideoAnimatePipeline({ supabase, generationId, passId, parent, vars }) {
  const cfg = getMmaConfig();
  
  if (!cfg.enabled) throw new Error("MMA_DISABLED");

  let working = vars;
  let videoCost = 5;
  const ctx = await getMmaCtxConfig(supabase);

  let suggestOnly = false;
  let chatter = null;

  try {
    const inputs0 = (working?.inputs && typeof working.inputs === "object") ? working.inputs : {};
    suggestOnly = inputs0.suggest_only === true || inputs0.suggestOnly === true;

    const typeForMe =
      inputs0.type_for_me === true ||
      inputs0.typeForMe === true ||
      inputs0.use_suggestion === true ||
      inputs0.useSuggestion === true;

    let frame2 = resolveFrame2Reference(inputs0, working?.assets);

    if ((frame2.kind === "ref_video" || frame2.kind === "ref_audio") && !frame2.rawDurationSec) {
      const dur =
        Number(inputs0.frame2_duration_sec || inputs0.frame2DurationSec || 0) ||
        Number(inputs0.duration || inputs0.duration_seconds || inputs0.durationSeconds || 0) ||
        0;

      if (dur > 0) inputs0.frame2_duration_sec = dur;
      frame2 = resolveFrame2Reference(inputs0, working?.assets);
    }

    if (!suggestOnly) {
      videoCost = videoCostFromInputs(inputs0, working?.assets);
      await chargeGeneration({ passId, generationId, cost: videoCost, reason: "mma_video", lane: "video" });
    }

    await updateStatus({ supabase, generationId, status: "prompting" });
    emitStatus(generationId, "prompting");

    working = pushUserMessageLine(working, pick(MMA_UI.quickLines.video_animate_start));
    await updateVars({ supabase, generationId, vars: working });
    emitLine(generationId, working);

    let stepNo = 1;

    const startImage = pickKlingStartImage(working, parent);
    const endImage = pickKlingEndImage(working, parent);
    if (!startImage) throw new Error("MISSING_START_IMAGE_FOR_VIDEO");

  const pricing = resolveVideoPricing(inputs0, working?.assets);
  const flow = pricing.flow;
  
  working.inputs = { ...(working.inputs || {}), start_image_url: startImage };
  if (endImage) working.inputs.end_image_url = endImage;
  
  let finalMotionPrompt = "";
  const motionBrief =
  safeStr(
    inputs0.motion_user_brief ||
      inputs0.motionUserBrief ||
      inputs0.brief ||
      inputs0.user_brief ||
      inputs0.userBrief,
    ""
  );

const movementStyle =
  safeStr(
    inputs0.selected_movement_style ||
      inputs0.selectedMovementStyle ||
      inputs0.movement_style ||
      inputs0.movementStyle,
    ""
  );

const promptOverride =
  safeStr(
    inputs0.motion_prompt_override ||
      inputs0.motionPromptOverride ||
      inputs0.prompt_override ||
      inputs0.promptOverride,
    ""
  );

const usePromptOverride = !!promptOverride;

  if (usePromptOverride) {
    await writeStep({
      supabase,
      generationId,
      passId,
      stepNo: stepNo++,
      stepType: "motion_prompt_override",
      payload: {
        source: "frontend",
        flow,
        frame2_kind: frame2?.kind || null,
        frame2_url: frame2?.url || null,
        frame2_duration_sec: frame2?.rawDurationSec || null,
        prompt_override: promptOverride,
        start_image_url: startImage,
        end_image_url: asHttpUrl(endImage) || null,
        motion_user_brief: motionBrief,
        selected_movement_style: movementStyle,
        timing: { started_at: nowIso(), ended_at: nowIso(), duration_ms: 0 },
        error: null,
      },
    });
  
    finalMotionPrompt = promptOverride;
  } else {
    const oneShotInput = {
      flow,
      frame2_kind: frame2?.kind || null,
      frame2_url: frame2?.url || null,
      frame2_duration_sec: frame2?.rawDurationSec || null,
  
      start_image_url: startImage,
      end_image_url: asHttpUrl(endImage) || null,
      motion_user_brief: motionBrief,
      selected_movement_style: movementStyle,
  
      notes:
        "Write ONE clean motion prompt. If audio reference exists, sync motion to beats/phrases. " +
        "If video reference exists, sync motion of the reference while keeping subject consistent. " +
        "Plain English. No emojis. No questions.",
    };
  
    const labeledImages = []
      .concat([{ role: "START_IMAGE", url: startImage }])
      .concat(endImage ? [{ role: "END_IMAGE", url: endImage }] : [])
      .slice(0, 6);
  
    const t0 = Date.now();
    const one = await gptMotionOneShotAnimate({ cfg, ctx, input: oneShotInput, labeledImages });
  
    await writeStep({
      supabase,
      generationId,
      passId,
      stepNo: stepNo++,
      stepType: "gpt_motion_one_shot",
      payload: {
        ctx: ctx.motion_one_shot,
        input: oneShotInput,
        labeledImages,
        request: one.request,
        raw: one.raw,
        output: { motion_prompt: one.motion_prompt, parsed_ok: one.parsed_ok },
        timing: { started_at: new Date(t0).toISOString(), ended_at: nowIso(), duration_ms: Date.now() - t0 },
        error: null,
      },
    });
  
    finalMotionPrompt =
      safeStr(one.motion_prompt, "") ||
      safeStr(working?.inputs?.motion_prompt, "") ||
      safeStr(working?.inputs?.prompt, "") ||
      safeStr(working?.prompts?.motion_prompt, "");

    if (one.negative_prompt) working.prompts = { ...(working.prompts || {}), gpt_negative_prompt: one.negative_prompt };
    if (one.duration) working.prompts = { ...(working.prompts || {}), gpt_duration: one.duration };
  }

  if (!finalMotionPrompt) {
    finalMotionPrompt =
      safeStr(motionBrief, "") ||
      safeStr(working?.inputs?.brief, "") ||
      safeStr(working?.inputs?.prompt, "");
  }

  if (!finalMotionPrompt && flow !== "kling_omni_audio") {
    throw new Error("EMPTY_MOTION_PROMPT");
  }

  working.prompts = { ...(working.prompts || {}), motion_prompt: finalMotionPrompt };
  await updateVars({ supabase, generationId, vars: working });


    if (suggestOnly) {
      await supabase
        .from("mega_generations")
        .update({
          mg_status: "suggested",
          mg_mma_status: "suggested",
          mg_prompt: finalMotionPrompt,
          mg_updated_at: nowIso(),
        })
        .eq("mg_generation_id", generationId)
        .eq("mg_record_type", "generation");

      if (typeForMe) {
        try {
          await commitTypeForMeSuccessAndMaybeCharge({ supabase, passId });
        } catch (e) {
          console.warn("[mma] type-for-me charge failed:", e?.message || e);
        }
      }

      emitStatus(generationId, "suggested");
      sendDone(generationId, "suggested");
      return;
    }

    await updateStatus({ supabase, generationId, status: "generating" });
    emitStatus(generationId, "generating");

    chatter = startMinaChatter({
      supabase,
      generationId,
      getVars: () => working,
      setVars: (v) => {
        working = v;
      },
      stage: "generating",
      intervalMs: 2600,
    });

    const duration =
      Number(working?.inputs?.duration ?? working?.prompts?.gpt_duration ?? cfg?.kling?.duration ?? process.env.MMA_KLING_DURATION ?? 5) || 5;

    const mode =
      safeStr(working?.inputs?.kling_mode || working?.inputs?.mode, "") ||
      cfg?.kling?.mode ||
      process.env.MMA_KLING_MODE ||
      "standard";

    const neg =
      safeStr(working?.inputs?.negative_prompt || working?.inputs?.negativePrompt, "") ||
      safeStr(working?.prompts?.gpt_negative_prompt, "") ||
      cfg?.kling?.negativePrompt ||
      process.env.NEGATIVE_PROMPT_KLING ||
      process.env.MMA_NEGATIVE_PROMPT_KLING ||
      KLING_DEFAULT_NEGATIVE_PROMPT;

    const generateAudioRaw =
      working?.inputs?.generate_audio ??
      working?.inputs?.generateAudio ??
      working?.inputs?.audio_enabled ??
      working?.inputs?.audioEnabled ??
      working?.inputs?.with_audio ??
      working?.inputs?.withAudio;

    const muteRaw =
      working?.inputs?.mute ??
      working?.inputs?.muted ??
      working?.inputs?.audio_muted ??
      working?.inputs?.audioMuted;

    const generateAudioParsed = parseOptionalBool(generateAudioRaw);
    const muteParsed = parseOptionalBool(muteRaw);

    let generateAudio = true;

    if (muteParsed === true) {
      generateAudio = false;
    } else if (generateAudioParsed !== undefined) {
      generateAudio = generateAudioParsed;
    } else if (muteParsed === false) {
      generateAudio = true;
    }

    let genRes;
    let stepType = "kling_generate";

    try {
      if (pricing.flow === "kling_motion_control") {
        if (!frame2?.url) throw new Error("MISSING_FRAME2_VIDEO_URL");

        const kmcMode = safeStr(working?.inputs?.mode || working?.inputs?.kmc_mode, "") || "std";
        const kmcOrientation =
          safeStr(working?.inputs?.character_orientation || working?.inputs?.characterOrientation, "") || "video";
        const keepOriginalSound =
          working?.inputs?.keep_original_sound ?? working?.inputs?.keepOriginalSound ?? generateAudio;

        working.meta = { ...(working.meta || {}), video_engine: "kling_motion_control", video_lane: pricing.videoLane };
        await updateVars({ supabase, generationId, vars: working });

        genRes = await runKlingMotionControl({
          prompt: finalMotionPrompt,
          image: startImage,
          video: frame2.url,
          mode: kmcMode,
          keepOriginalSound,
          characterOrientation: kmcOrientation,
          duration: frame2?.rawDurationSec || duration,
        });

        working.outputs = { ...(working.outputs || {}), kling_motion_control_prediction_id: genRes.prediction_id || null };
        stepType = "kling_motion_control_generate";
        await updateVars({ supabase, generationId, vars: working });
      } else if (pricing.flow === "kling_omni_audio" || pricing.flow === "kling_omni") {
        working.meta = { ...(working.meta || {}), video_engine: pricing.flow, video_lane: pricing.videoLane };
        await updateVars({ supabase, generationId, vars: working });

        genRes = await runKlingOmni({
          prompt: finalMotionPrompt,
          startImage,
          endImage,
          duration,
          mode,
          negativePrompt: neg,
          generateAudio,
        });

        working.outputs = { ...(working.outputs || {}), kling_prediction_id: genRes.prediction_id || null };
        stepType = pricing.flow === "kling_omni_audio" ? "kling_omni_audio_generate" : "kling_omni_generate";
        await updateVars({ supabase, generationId, vars: working });
      } else {
        working.meta = { ...(working.meta || {}), video_engine: "kling", video_lane: pricing.videoLane };
        await updateVars({ supabase, generationId, vars: working });

        genRes = await runKling({
          prompt: finalMotionPrompt,
          startImage,
          endImage,
          duration,
          mode,
          negativePrompt: neg,
          generateAudio,
        });

        working.outputs = { ...(working.outputs || {}), kling_prediction_id: genRes.prediction_id || null };
        stepType = "kling_generate";
        await updateVars({ supabase, generationId, vars: working });
      }
    } finally {
      try {
        chatter?.stop?.();
      } catch {}
      chatter = null;
    }

    const { input, out, timing } = genRes;

    await writeStep({
      supabase,
      generationId,
      passId,
      stepNo: stepNo++,
      stepType,
      payload: { input, output: out, timing, error: null },
    });

    let remote = pickFirstUrl(out);

    if (!remote) {
      const err = new Error("VIDEO_NO_URL");
      err.code = "VIDEO_NO_URL";
      err.details = {
        prediction_id: genRes.prediction_id,
        prediction_status: genRes.prediction_status,
        timed_out: genRes.timed_out,
        task_result_keys: out ? Object.keys(out) : [],
        raw_out: JSON.stringify(out)?.slice(0, 500),
      };
      throw err;
    }

    const remoteUrl = await storeRemoteToR2Public(remote, `mma/video/${generationId}`);

    working.outputs = { ...(working.outputs || {}) };
    working.outputs.kling_video_url = remoteUrl;
    
    if (pricing.flow === "kling_omni_audio") working.outputs.kling_omni_audio_video_url = remoteUrl;
    if (pricing.flow === "kling_omni") working.outputs.kling_omni_video_url = remoteUrl;
    if (pricing.flow === "kling_motion_control") working.outputs.kling_motion_control_video_url = remoteUrl;

    working.mg_output_url = remoteUrl;

    working = pushUserMessageLine(working, pick(MMA_UI.quickLines.saved_video));
    await updateVars({ supabase, generationId, vars: working });
    emitLine(generationId, working);

    await finalizeGeneration({ supabase, generationId, url: remoteUrl, prompt: finalMotionPrompt, vars: working, mode: "video", matchasCharged: videoCost });

    await updateStatus({ supabase, generationId, status: "done" });
    emitStatus(generationId, "done");
    sendDone(generationId, "done");
  } catch (err) {
    try {
      chatter?.stop?.();
    } catch {}
    chatter = null;

    console.error("[mma] video animate pipeline error", err);

    await updateStatus({ supabase, generationId, status: "error" });
    await supabase
      .from("mega_generations")
      .update({
        mg_error: {
          code: "PIPELINE_ERROR",
          message: err?.message || String(err || ""),
          provider: err?.provider || null,
        },
        mg_updated_at: nowIso(),
      })
      .eq("mg_generation_id", generationId)
      .eq("mg_record_type", "generation");

    if (!suggestOnly) {
      try {
        await refundOnFailure({ supabase, passId, generationId, cost: videoCost, err });
      } catch (e) {
        console.warn("[mma] refund failed (video animate)", e?.message || e);
      }
    }

    emitStatus(generationId, "error");
    sendDone(generationId, "error");
  }
}

// ============================================================================
// VIDEO TWEAK PIPELINE (Kling)
// ============================================================================
export async function runVideoTweakPipeline({ supabase, generationId, passId, parent, vars }) {
  const cfg = getMmaConfig();
  if (!cfg.enabled) throw new Error("MMA_DISABLED");

  let working = vars;
  const ctx = await getMmaCtxConfig(supabase);

  const parentVars = parent?.mg_mma_vars && typeof parent.mg_mma_vars === "object" ? parent.mg_mma_vars : {};
  const mergedInputs0 = { ...(parentVars?.inputs || {}), ...(working?.inputs || {}) };
  const mergedAssets0 = { ...(parentVars?.assets || {}), ...(working?.assets || {}) };
  const pricing = resolveVideoPricing(mergedInputs0, mergedAssets0);
  let frame2 = resolveFrame2Reference(mergedInputs0, mergedAssets0);
  const videoCost = videoCostFromInputs(mergedInputs0, mergedAssets0);

  if ((frame2.kind === "ref_video" || frame2.kind === "ref_audio") && !frame2.rawDurationSec) {
    const dur =
      Number(mergedInputs0.frame2_duration_sec || mergedInputs0.frame2DurationSec || 0) ||
      Number(mergedInputs0.duration || mergedInputs0.duration_seconds || mergedInputs0.durationSeconds || 0) ||
      0;

    if (dur > 0) mergedInputs0.frame2_duration_sec = dur;
    frame2 = resolveFrame2Reference(mergedInputs0, mergedAssets0);
  }

  let chatter = null;

  try {
    await chargeGeneration({ passId, generationId, cost: videoCost, reason: "mma_video", lane: "video" });
    await updateStatus({ supabase, generationId, status: "prompting" });
    emitStatus(generationId, "prompting");

    working = pushUserMessageLine(working, pick(MMA_UI.quickLines.video_tweak_start));
    await updateVars({ supabase, generationId, vars: working });
    emitLine(generationId, working);

    let stepNo = 1;

    const startImage =
      asHttpUrl(working?.inputs?.start_image_url || working?.inputs?.startImageUrl) ||
      asHttpUrl(parentVars?.inputs?.start_image_url || parentVars?.inputs?.startImageUrl) ||
      asHttpUrl(parent?.mg_output_url) ||
      "";

    const endImage =
      asHttpUrl(working?.inputs?.end_image_url || working?.inputs?.endImageUrl) ||
      asHttpUrl(parentVars?.inputs?.end_image_url || parentVars?.inputs?.endImageUrl) ||
      "";

    if (!startImage) throw new Error("MISSING_START_IMAGE_FOR_VIDEO_TWEAK");

    const feedbackMotion =
      safeStr(working?.feedback?.motion_feedback, "") ||
      safeStr(working?.feedback?.feedback_motion, "") ||
      safeStr(working?.inputs?.feedback_motion, "") ||
      safeStr(working?.inputs?.feedback, "") ||
      safeStr(working?.inputs?.comment, "");

    if (!feedbackMotion) throw new Error("MISSING_MOTION_FEEDBACK");

    const prevMotionPrompt =
      safeStr(parentVars?.prompts?.motion_prompt, "") || safeStr(parent?.mg_prompt, "");

    const oneShotInput = {
      start_image_url: startImage,
      end_image_url: asHttpUrl(endImage) || null,
      feedback_motion: feedbackMotion,
      previous_motion_prompt: prevMotionPrompt,
      notes: "Keep what works. Apply feedback precisely. Plain English. No emojis. No questions.",
    };

    const labeledImages = []
      .concat([{ role: "START_IMAGE", url: startImage }])
      .concat(endImage ? [{ role: "END_IMAGE", url: endImage }] : [])
      .slice(0, 6);

    const t0 = Date.now();
    const one = await gptMotionOneShotTweak({ cfg, ctx, input: oneShotInput, labeledImages });

    await writeStep({
      supabase,
      generationId,
      passId,
      stepNo: stepNo++,
      stepType: "gpt_motion_tweak_one_shot",
      payload: {
        ctx: ctx.motion_tweak_one_shot,
        input: oneShotInput,
        labeledImages,
        request: one.request,
        raw: one.raw,
        output: { motion_prompt: one.motion_prompt, parsed_ok: one.parsed_ok },
        timing: { started_at: new Date(t0).toISOString(), ended_at: nowIso(), duration_ms: Date.now() - t0 },
        error: null,
      },
    });

    let finalMotionPrompt = safeStr(one.motion_prompt, "");

    if (!finalMotionPrompt) {
      finalMotionPrompt = safeStr(feedbackMotion, "") || safeStr(prevMotionPrompt, "");
    }

    if (!finalMotionPrompt && pricing.flow !== "kling_omni_audio") {
      throw new Error("EMPTY_MOTION_TWEAK_PROMPT_ONE_SHOT");
    }

    if (one.negative_prompt) working.prompts = { ...(working.prompts || {}), gpt_negative_prompt: one.negative_prompt };
    if (one.duration) working.prompts = { ...(working.prompts || {}), gpt_duration: one.duration };

    working.prompts = { ...(working.prompts || {}), motion_prompt: finalMotionPrompt };
    working.inputs = { ...(working.inputs || {}), start_image_url: startImage };
    if (endImage) working.inputs.end_image_url = endImage;

    await updateVars({ supabase, generationId, vars: working });

    await updateStatus({ supabase, generationId, status: "generating" });
    emitStatus(generationId, "generating");

    chatter = startMinaChatter({
      supabase,
      generationId,
      getVars: () => working,
      setVars: (v) => {
        working = v;
      },
      stage: "generating",
      intervalMs: 2600,
    });

    const duration =
      Number(
        working?.inputs?.duration ??
          working?.prompts?.gpt_duration ??
          parentVars?.inputs?.duration ??
          cfg?.kling?.duration ??
          process.env.MMA_KLING_DURATION ??
          5
      ) || 5;

    const mode =
      safeStr(working?.inputs?.kling_mode || working?.inputs?.mode, "") ||
      safeStr(parentVars?.inputs?.kling_mode || parentVars?.inputs?.mode, "") ||
      cfg?.kling?.mode ||
      process.env.MMA_KLING_MODE ||
      "standard";

    const neg =
      safeStr(working?.inputs?.negative_prompt || working?.inputs?.negativePrompt, "") ||
      safeStr(working?.prompts?.gpt_negative_prompt, "") ||
      safeStr(parentVars?.inputs?.negative_prompt || parentVars?.inputs?.negativePrompt, "") ||
      cfg?.kling?.negativePrompt ||
      process.env.NEGATIVE_PROMPT_KLING ||
      process.env.MMA_NEGATIVE_PROMPT_KLING ||
      KLING_DEFAULT_NEGATIVE_PROMPT;

    const mergedInputsAudio = { ...(parentVars?.inputs || {}), ...(working?.inputs || {}) };

    const generateAudioRaw =
      mergedInputsAudio?.generate_audio ??
      mergedInputsAudio?.generateAudio ??
      mergedInputsAudio?.audio_enabled ??
      mergedInputsAudio?.audioEnabled ??
      mergedInputsAudio?.with_audio ??
      mergedInputsAudio?.withAudio;

    const muteRaw =
      mergedInputsAudio?.mute ??
      mergedInputsAudio?.muted;

    const generateAudioParsed = parseOptionalBool(generateAudioRaw);
    const muteParsed = parseOptionalBool(muteRaw);

    let generateAudio =
      generateAudioParsed !== undefined ? generateAudioParsed :
      muteParsed !== undefined ? !muteParsed :
      true;

    let genRes;
    let stepType = "kling_generate_tweak";
    try {
      if (pricing.flow === "kling_motion_control") {
        if (!frame2?.url) throw new Error("MISSING_FRAME2_VIDEO_URL");

        working.meta = { ...(working.meta || {}), video_engine: "kling_motion_control", video_lane: pricing.videoLane };

        genRes = await runKlingMotionControl({
          prompt: finalMotionPrompt,
          image: startImage,
          video: frame2.url,
          mode: safeStr(mergedInputs0?.mode || mergedInputs0?.kmc_mode, "") || "std",
          keepOriginalSound: mergedInputs0?.keep_original_sound ?? mergedInputs0?.keepOriginalSound ?? true,
          characterOrientation:
            safeStr(mergedInputs0?.character_orientation || mergedInputs0?.characterOrientation, "") || "video",
          duration: frame2?.rawDurationSec || duration,
        });

        stepType = "kling_motion_control_generate_tweak";
      } else if (pricing.flow === "kling_omni_audio" || pricing.flow === "kling_omni") {
        working.meta = { ...(working.meta || {}), video_engine: pricing.flow, video_lane: pricing.videoLane };

        genRes = await runKlingOmni({
          prompt: finalMotionPrompt,
          startImage,
          endImage,
          duration,
          mode,
          negativePrompt: neg,
          generateAudio,
        });

        stepType = pricing.flow === "kling_omni_audio" ? "kling_omni_audio_generate_tweak" : "kling_omni_generate_tweak";
      } else {
        working.meta = { ...(working.meta || {}), video_engine: "kling", video_lane: pricing.videoLane };

        genRes = await runKling({
          prompt: finalMotionPrompt,
          startImage,
          endImage,
          duration,
          mode,
          negativePrompt: neg,
          generateAudio,
        });

        stepType = "kling_generate_tweak";
      }
    } finally {
      try {
        chatter?.stop?.();
      } catch {}
      chatter = null;
    }

    const { input, out, timing } = genRes;

    await writeStep({
      supabase,
      generationId,
      passId,
      stepNo: stepNo++,
      stepType,
      payload: { input, output: out, timing, error: null },
    });

    const remote = pickFirstUrl(out);
    if (!remote) {
      const err = new Error("KLING_NO_URL_TWEAK");
      err.code = "KLING_NO_URL_TWEAK";
      err.details = {
        prediction_id: genRes.prediction_id,
        prediction_status: genRes.prediction_status,
        timed_out: genRes.timed_out,
        task_result_keys: out ? Object.keys(out) : [],
        raw_out: JSON.stringify(out)?.slice(0, 500),
      };
      throw err;
    }

    const remoteUrl = await storeRemoteToR2Public(remote, `mma/video/${generationId}`);

    working.outputs = { ...(working.outputs || {}), kling_video_url: remoteUrl };
    working.mg_output_url = remoteUrl;

    working = pushUserMessageLine(working, pick(MMA_UI.quickLines.saved_video));
    await updateVars({ supabase, generationId, vars: working });
    emitLine(generationId, working);

    await finalizeGeneration({ supabase, generationId, url: remoteUrl, prompt: finalMotionPrompt, vars: working, mode: "video", matchasCharged: videoCost });

    await updateStatus({ supabase, generationId, status: "done" });
    emitStatus(generationId, "done");
    sendDone(generationId, "done");
  } catch (err) {
    try {
      chatter?.stop?.();
    } catch {}
    chatter = null;

    console.error("[mma] video tweak pipeline error", err);

    await updateStatus({ supabase, generationId, status: "error" });
    await supabase
      .from("mega_generations")
      .update({
        mg_error: {
          code: "PIPELINE_ERROR",
          message: err?.message || String(err || ""),
          provider: err?.provider || null,
        },
        mg_updated_at: nowIso(),
      })
      .eq("mg_generation_id", generationId)
      .eq("mg_record_type", "generation");

    try {
      await refundOnFailure({ supabase, passId, generationId, cost: videoCost, err });
    } catch (e) {
      console.warn("[mma] refund failed (video tweak)", e?.message || e);
    }

    emitStatus(generationId, "error");
    sendDone(generationId, "error");
  }
}
