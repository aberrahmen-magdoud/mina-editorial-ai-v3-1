// ./server/mma/mma-controller.js
import express from "express";

import { resolvePassId as megaResolvePassId } from "../../mega-db.js";
import { getSupabaseAdmin } from "../../supabase.js";

import {
  computePassId,
  eventIdentifiers,
  makeInitialVars,
  newUuid,
  nowIso,
} from "./mma-utils.js";

import { addSseClient, sendDone, sendStatus } from "./mma-sse.js";
import { getMmaConfig } from "./mma-config.js";

import { MMA_UI, pick, toUserStatus } from "./mma-ui.js";
import { asHttpUrl, normalizeUrlForKey, resolveFrame2Reference, safeArray, safeStr } from "./mma-shared.js";
import { getMmaCtxConfig } from "./mma-context.js";
import {
  gptMotionOneShotAnimate,
  gptMotionOneShotTweak,
  gptStillOneShotCreate,
  gptStillOneShotTweak,
} from "./mma-openai.js";
import {
  buildNanoBananaImageInputs,
  buildSeedreamImageInputs,
  getReplicate,
  nanoBananaEnabled,
  pickFirstUrl,
  pickKlingEndImage,
  pickKlingStartImage,
  runFabricAudio,
  runKling,
  runKlingMotionControl,
  runNanoBanana,
  runSeedream,
} from "./mma-replicate.js";
import { storeRemoteToR2Public } from "./mma-r2.js";
import {
  resolveStillLane,
  resolveStillLaneFromInputs,
  resolveVideoPricing,
  stillCostForLane,
  videoCostFromInputs,
} from "./mma-pricing.js";
import {
  chargeGeneration,
  commitTypeForMeSuccessAndMaybeCharge,
  ensureEnoughCredits,
  preflightTypeForMe,
  refundOnFailure,
} from "./mma-credits.js";
import {
  ensureCustomerRow,
  ensureSessionForHistory,
  fetchParentGenerationRow,
  finalizeGeneration,
  updateStatus,
  updateVars,
  writeGeneration,
  writeStep,
} from "./mma-db.js";
import { emitLine, emitStatus, pushUserMessageLine, startMinaChatter } from "./mma-messages.js";

// STILL CREATE PIPELINE
// ============================================================================
async function runStillCreatePipeline({ supabase, generationId, passId, vars, preferences }) {
  const cfg = getMmaConfig();
  if (!cfg.enabled) throw new Error("MMA_DISABLED");

  let working = vars;

  const stillLane = resolveStillLane(working);
  const stillCost = stillCostForLane(stillLane); // âœ… niche => 2, main => 1
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
      .slice(0, 4);

    const labeledImages = []
      // Product pill -> Scene / Composition reference
      .concat(productUrl ? [{ role: "SCENE / COMPOSITION / ASTHETIC / VIBE / STYLE", url: productUrl }] : [])

      // Logo pill -> Logo / Label / Icon / Text reference
      .concat(logoUrl ? [{ role: "LOGO / LABEL / ICON / TEXT / DESIGN", url: logoUrl }] : [])

      // Inspiration pill -> Product / Element / Texture / Material references
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

    // lane: "main" (default) => Seedream, "niche" => Nano Banana (if enabled)
    const stillLane = resolveStillLane(working);
    const useNano = stillLane === "niche" && nanoBananaEnabled();

    working.meta = { ...(working.meta || {}), still_lane: stillLane, still_engine: useNano ? "nanobanana" : "seedream" };
    await updateVars({ supabase, generationId, vars: working });

    const imageInputs = useNano ? buildNanoBananaImageInputs(working) : buildSeedreamImageInputs(working);

    let aspectRatio =
      safeStr(working?.inputs?.aspect_ratio, "") ||
      (useNano
        ? process.env.MMA_NANOBANANA_ASPECT_RATIO || cfg?.nanobanana?.aspectRatio
        : cfg?.seadream?.aspectRatio || process.env.MMA_SEADREAM_ASPECT_RATIO) ||
      "match_input_image";

    // If user chose match_input_image but no inputs exist, force a safe fallback aspect ratio
    if (!imageInputs.length && String(aspectRatio).toLowerCase().includes("match")) {
      aspectRatio = useNano
        ? process.env.MMA_NANOBANANA_FALLBACK_ASPECT_RATIO || cfg?.nanobanana?.fallbackAspectRatio || "1:1"
        : cfg?.seadream?.fallbackAspectRatio || process.env.MMA_SEADREAM_FALLBACK_ASPECT_RATIO || "1:1";
    }

    let genRes;
    try {
      genRes = useNano
        ? await runNanoBanana({
            prompt: usedPrompt,
            aspectRatio,
            imageInputs,
            resolution: cfg?.nanobanana?.resolution, // optional (env handles your Render vars)
            outputFormat: cfg?.nanobanana?.outputFormat,
            safetyFilterLevel: cfg?.nanobanana?.safetyFilterLevel,
          })
        : await runSeedream({
            prompt: usedPrompt,
            aspectRatio,
            imageInputs,
            size: cfg?.seadream?.size,
            enhancePrompt: cfg?.seadream?.enhancePrompt,
          });

      // âœ… store prediction id for recovery later
      working.outputs = { ...(working.outputs || {}) };
      if (useNano) working.outputs.nanobanana_prediction_id = genRes.prediction_id || null;
      else working.outputs.seedream_prediction_id = genRes.prediction_id || null;

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
      stepType: useNano ? "nanobanana_generate" : "seedream_generate",
      payload: { input, output: out, timing, error: null },
    });

    const url = pickFirstUrl(out);
    if (!url) throw new Error(useNano ? "NANOBANANA_NO_URL" : "SEADREAM_NO_URL");

    const remoteUrl = await storeRemoteToR2Public(url, `mma/still/${generationId}`);
    working.outputs = { ...(working.outputs || {}) };
    if (useNano) working.outputs.nanobanana_image_url = remoteUrl;
    else working.outputs.seedream_image_url = remoteUrl;

    working.mg_output_url = remoteUrl;

    working = pushUserMessageLine(working, pick(MMA_UI.quickLines.saved_image));
    await updateVars({ supabase, generationId, vars: working });
    emitLine(generationId, working);

    await finalizeGeneration({ supabase, generationId, url: remoteUrl, prompt: usedPrompt });

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
async function runStillTweakPipeline({ supabase, generationId, passId, parent, vars, preferences }) {
  const cfg = getMmaConfig();
  if (!cfg.enabled) throw new Error("MMA_DISABLED");

  let working = vars;

  const stillLane = resolveStillLane(working);
  const stillCost = stillCostForLane(stillLane); // âœ… niche => 2, main => 1
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

    const stillLane = resolveStillLane(working);
    const useNano = stillLane === "niche" && nanoBananaEnabled();

    working.meta = { ...(working.meta || {}), still_lane: stillLane, still_engine: useNano ? "nanobanana" : "seedream" };
    await updateVars({ supabase, generationId, vars: working });

    let aspectRatio =
      safeStr(working?.inputs?.aspect_ratio, "") ||
      (useNano
        ? process.env.MMA_NANOBANANA_ASPECT_RATIO || cfg?.nanobanana?.aspectRatio
        : cfg?.seadream?.aspectRatio || process.env.MMA_SEADREAM_ASPECT_RATIO) ||
      "match_input_image";

    // tweak always has a parent image, so match_input_image is fine, but keep fallback anyway
    if (String(aspectRatio).toLowerCase().includes("match") && !parentUrl) {
      aspectRatio = "1:1";
    }

    const forcedInput = useNano
      ? {
          prompt: usedPrompt,
          resolution: cfg?.nanobanana?.resolution || process.env.MMA_NANOBANANA_RESOLUTION || "2K",
          aspect_ratio: aspectRatio,
          output_format: cfg?.nanobanana?.outputFormat || process.env.MMA_NANOBANANA_OUTPUT_FORMAT || "jpg",
          safety_filter_level:
            cfg?.nanobanana?.safetyFilterLevel || process.env.MMA_NANOBANANA_SAFETY_FILTER_LEVEL || "block_only_high",
          image_input: [parentUrl],
        }
      : {
          prompt: usedPrompt,
          size: cfg?.seadream?.size || process.env.MMA_SEADREAM_SIZE || "2K",
          aspect_ratio: aspectRatio,
          enhance_prompt: !!cfg?.seadream?.enhancePrompt,
          sequential_image_generation: "disabled",
          max_images: 1,
          image_input: [parentUrl],
        };

    let genRes;
    try {
      genRes = useNano
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
      stepType: useNano ? "nanobanana_generate_tweak" : "seedream_generate_tweak",
      payload: { input, output: out, timing, error: null },
    });

    const genUrl = pickFirstUrl(out);
    if (!genUrl) throw new Error(useNano ? "NANOBANANA_NO_URL_TWEAK" : "SEADREAM_NO_URL_TWEAK");

    const remoteUrl = await storeRemoteToR2Public(genUrl, `mma/still/${generationId}`);

    working.outputs = { ...(working.outputs || {}) };
    if (useNano) working.outputs.nanobanana_image_url = remoteUrl;
    else working.outputs.seedream_image_url = remoteUrl;

    working.mg_output_url = remoteUrl;

    working = pushUserMessageLine(working, pick(MMA_UI.quickLines.saved_image));
    await updateVars({ supabase, generationId, vars: working });
    emitLine(generationId, working);

    await finalizeGeneration({ supabase, generationId, url: remoteUrl, prompt: usedPrompt });

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
async function runVideoAnimatePipeline({ supabase, generationId, passId, parent, vars }) {
  const cfg = getMmaConfig();
  
  if (!cfg.enabled) throw new Error("MMA_DISABLED");

  let working = vars;
  let videoCost = 5;
  const ctx = await getMmaCtxConfig(supabase);

    // âœ… keep suggestOnly visible in catch/refund
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

    // âœ… If ref duration is missing, try to use real seconds from inputs.duration (NOT 5/10)
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
  const flow = pricing.flow; // "kling" | "kling_motion_control" | "fabric_audio"
  
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

  // 1) Optional manual override (same behavior as before)
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
    // 2) Always run GPT (even for fabric_audio + motion control)
    const oneShotInput = {
      flow,
      frame2_kind: frame2?.kind || null, // "ref_audio" | "ref_video" | null
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
  }
  
  // If GPT returns empty, do a safe fallback so Fabric never fails because of prompt
  if (!finalMotionPrompt) {
    finalMotionPrompt =
      safeStr(motionBrief, "") ||
      safeStr(working?.inputs?.brief, "") ||
      safeStr(working?.inputs?.prompt, "");
  }
  
  // Only REQUIRE prompt for Kling and motion-control (Fabric doesnâ€™t need it)
  if (!finalMotionPrompt && flow !== "fabric_audio") {
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
      Number(working?.inputs?.duration ?? cfg?.kling?.duration ?? process.env.MMA_KLING_DURATION ?? 5) || 5;

    const mode =
      safeStr(working?.inputs?.kling_mode || working?.inputs?.mode, "") ||
      cfg?.kling?.mode ||
      process.env.MMA_KLING_MODE ||
      "standard";

    const neg =
      safeStr(working?.inputs?.negative_prompt || working?.inputs?.negativePrompt, "") ||
      cfg?.kling?.negativePrompt ||
      process.env.NEGATIVE_PROMPT_KLING ||
      process.env.MMA_NEGATIVE_PROMPT_KLING ||
      "";

    const generateAudioRaw =
      working?.inputs?.generate_audio ??
      working?.inputs?.generateAudio ??
      working?.inputs?.audio_enabled ??
      working?.inputs?.audioEnabled ??
      working?.inputs?.with_audio ??
      working?.inputs?.withAudio;

    const muteRaw =
      working?.inputs?.mute ??
      working?.inputs?.muted;

    // âœ… default ON unless explicitly disabled
    let generateAudio =
      generateAudioRaw !== undefined ? !!generateAudioRaw :
      muteRaw !== undefined ? !Boolean(muteRaw) :
      true;

    // âœ… 2 frames (end frame present) => ALWAYS force mute on backend too
    if (asHttpUrl(endImage)) generateAudio = false;

    let genRes;
    let stepType = "kling_generate";

    try {
      if (pricing.flow === "kling_motion_control") {
        if (!frame2?.url) throw new Error("MISSING_FRAME2_VIDEO_URL");

        // sensible defaults for motion control
        const kmcMode = safeStr(working?.inputs?.mode || working?.inputs?.kmc_mode, "") || "std";
        const kmcOrientation =
          safeStr(working?.inputs?.character_orientation || working?.inputs?.characterOrientation, "") || "video";
        const keepOriginalSound =
          working?.inputs?.keep_original_sound ?? working?.inputs?.keepOriginalSound ?? true;

        working.meta = { ...(working.meta || {}), video_engine: "kling_motion_control" };
        await updateVars({ supabase, generationId, vars: working });

        genRes = await runKlingMotionControl({
          prompt: finalMotionPrompt,
          image: startImage,
          video: frame2.url,
          mode: kmcMode,
          keepOriginalSound,
          characterOrientation: kmcOrientation,
        });

        working.outputs = { ...(working.outputs || {}), kling_motion_control_prediction_id: genRes.prediction_id || null };
        stepType = "kling_motion_control_generate";
        await updateVars({ supabase, generationId, vars: working });
      } else if (pricing.flow === "fabric_audio") {
        if (!frame2?.url) throw new Error("MISSING_FRAME2_AUDIO_URL");

        const resolution =
          safeStr(working?.inputs?.resolution || working?.inputs?.fabric_resolution, "") || "720p";

        working.meta = { ...(working.meta || {}), video_engine: "fabric_audio" };
        await updateVars({ supabase, generationId, vars: working });

        genRes = await runFabricAudio({
          image: startImage,
          audio: frame2.url,
          resolution,
        });

        working.outputs = { ...(working.outputs || {}), fabric_prediction_id: genRes.prediction_id || null };
        stepType = "fabric_generate";
        await updateVars({ supabase, generationId, vars: working });
      } else {
        working.meta = { ...(working.meta || {}), video_engine: "kling" };
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

    const remote = pickFirstUrl(out);
    if (!remote) throw new Error("VIDEO_NO_URL");

    let remoteUrl = remote;
    try {
      remoteUrl = await storeRemoteToR2Public(remote, `mma/video/${generationId}`);
    } catch (e) {
      console.warn("[mma] storeRemoteToR2Public failed (video), using provider url:", e?.message || e);
      remoteUrl = remote;
    }

    working.outputs = { ...(working.outputs || {}) };
    working.outputs.kling_video_url = remoteUrl;
    
    if (pricing.flow === "fabric_audio") working.outputs.fabric_video_url = remoteUrl;
    if (pricing.flow === "kling_motion_control") working.outputs.kling_motion_control_video_url = remoteUrl;

    working.mg_output_url = remoteUrl;

    working = pushUserMessageLine(working, pick(MMA_UI.quickLines.saved_video));
    await updateVars({ supabase, generationId, vars: working });
    emitLine(generationId, working);

    await finalizeGeneration({ supabase, generationId, url: remoteUrl, prompt: finalMotionPrompt });

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
async function runVideoTweakPipeline({ supabase, generationId, passId, parent, vars }) {
  const cfg = getMmaConfig();
  if (!cfg.enabled) throw new Error("MMA_DISABLED");

  let working = vars;
  const ctx = await getMmaCtxConfig(supabase);

  // âœ… compute real cost 5 or 10 (use parent inputs as fallback)
  const parentVars = parent?.mg_mma_vars && typeof parent.mg_mma_vars === "object" ? parent.mg_mma_vars : {};
  const mergedInputs0 = { ...(parentVars?.inputs || {}), ...(working?.inputs || {}) };
  const mergedAssets0 = { ...(parentVars?.assets || {}), ...(working?.assets || {}) };
  const pricing = resolveVideoPricing(mergedInputs0, mergedAssets0);
  let frame2 = resolveFrame2Reference(mergedInputs0, mergedAssets0);
  const videoCost = videoCostFromInputs(mergedInputs0, mergedAssets0);

  // âœ… If ref duration is missing, try to use real seconds from inputs.duration (NOT 5/10)
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
      // safe fallback (so Fabric tweak wonâ€™t fail just because GPT output is empty)
      finalMotionPrompt = safeStr(feedbackMotion, "") || safeStr(prevMotionPrompt, "");
    }
    
    if (!finalMotionPrompt && pricing.flow !== "fabric_audio") {
      throw new Error("EMPTY_MOTION_TWEAK_PROMPT_ONE_SHOT");
    }


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
      safeStr(parentVars?.inputs?.negative_prompt || parentVars?.inputs?.negativePrompt, "") ||
      cfg?.kling?.negativePrompt ||
      process.env.NEGATIVE_PROMPT_KLING ||
      process.env.MMA_NEGATIVE_PROMPT_KLING ||
      "";

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

    // âœ… default ON unless explicitly disabled
    let generateAudio =
      generateAudioRaw !== undefined ? !!generateAudioRaw :
      muteRaw !== undefined ? !Boolean(muteRaw) :
      true;

    // âœ… 2 frames => force mute
    if (asHttpUrl(endImage)) generateAudio = false;

    let genRes;
    let stepType = "kling_generate_tweak";
    try {
      if (pricing.flow === "kling_motion_control") {
        if (!frame2?.url) throw new Error("MISSING_FRAME2_VIDEO_URL");

        genRes = await runKlingMotionControl({
          prompt: finalMotionPrompt,
          image: startImage,
          video: frame2.url,
          mode: safeStr(mergedInputs0?.mode || mergedInputs0?.kmc_mode, "") || "std",
          keepOriginalSound: mergedInputs0?.keep_original_sound ?? mergedInputs0?.keepOriginalSound ?? true,
          characterOrientation:
            safeStr(mergedInputs0?.character_orientation || mergedInputs0?.characterOrientation, "") || "video",
        });

        stepType = "kling_motion_control_generate_tweak";
      } else if (pricing.flow === "fabric_audio") {
        if (!frame2?.url) throw new Error("MISSING_FRAME2_AUDIO_URL");

        genRes = await runFabricAudio({
          image: startImage,
          audio: frame2.url,
          resolution: safeStr(mergedInputs0?.resolution || mergedInputs0?.fabric_resolution, "") || "720p",
        });

        stepType = "fabric_generate_tweak";
      } else {
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
    if (!remote) throw new Error("KLING_NO_URL_TWEAK");

    const remoteUrl = await storeRemoteToR2Public(remote, `mma/video/${generationId}`);

    working.outputs = { ...(working.outputs || {}), kling_video_url: remoteUrl };
    working.mg_output_url = remoteUrl;

    working = pushUserMessageLine(working, pick(MMA_UI.quickLines.saved_video));
    await updateVars({ supabase, generationId, vars: working });
    emitLine(generationId, working);

    await finalizeGeneration({ supabase, generationId, url: remoteUrl, prompt: finalMotionPrompt });

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

// ============================================================================
// Public handlers
// ============================================================================
export async function handleMmaStillTweak({ parentGenerationId, body }) {
  const supabase = getSupabaseAdmin();
  if (!supabase) throw new Error("SUPABASE_NOT_CONFIGURED");

  const parent = await fetchParentGenerationRow(supabase, parentGenerationId);
  if (!parent) throw new Error("PARENT_GENERATION_NOT_FOUND");

  const passId =
    body?.passId ||
    body?.pass_id ||
    parent?.mg_pass_id ||
    computePassId({
      shopifyCustomerId: body?.customer_id,
      userId: body?.user_id,
      email: body?.email,
    });

  const requestedLane = resolveStillLaneFromInputs(body?.inputs || {});
  const stillCost = stillCostForLane(requestedLane);
  await ensureEnoughCredits(passId, stillCost, { lane: requestedLane });

  const generationId = newUuid();

  const { preferences } = await ensureCustomerRow(supabase, passId, {
    shopifyCustomerId: body?.customer_id,
    userId: body?.user_id,
    email: body?.email,
  });

  const vars = makeInitialVars({
    mode: "still",
    assets: body?.assets || {},
    history: body?.history || {},
    inputs: body?.inputs || {},
    settings: body?.settings || {},
    feedback: body?.feedback || {},
    prompts: body?.prompts || {},
  });

  vars.mg_pass_id = passId;

  const sessionId =
    safeStr(body?.sessionId || body?.session_id || body?.inputs?.sessionId || body?.inputs?.session_id, "") ||
    safeStr(parent?.mg_session_id, "") ||
    newUuid();

  const platform = safeStr(body?.platform || body?.inputs?.platform, "") || safeStr(parent?.mg_platform, "") || "web";
  const title = safeStr(body?.title || body?.inputs?.title, "") || safeStr(parent?.mg_title, "") || "Image session";

  vars.inputs = { ...(vars.inputs || {}), session_id: sessionId, platform, title };
  vars.meta = { ...(vars.meta || {}), session_id: sessionId, platform, title };

  await ensureSessionForHistory({
    passId,
    sessionId,
    platform,
    title,
    meta: { source: "mma", flow: "still_tweak" },
  });

  vars.meta = { ...(vars.meta || {}), flow: "still_tweak", parent_generation_id: parentGenerationId };
  vars.inputs = { ...(vars.inputs || {}), parent_output_url: parent?.mg_output_url || null };

  await writeGeneration({
    supabase,
    generationId,
    parentId: parentGenerationId,
    passId,
    vars,
    mode: "still",
  });

  runStillTweakPipeline({ supabase, generationId, passId, parent, vars, preferences }).catch((e) =>
    console.error("[mma] still tweak pipeline error", e)
  );

  return { generation_id: generationId, status: "queued", sse_url: `/mma/stream/${generationId}` };
}

export async function handleMmaVideoTweak({ parentGenerationId, body }) {
  const supabase = getSupabaseAdmin();
  if (!supabase) throw new Error("SUPABASE_NOT_CONFIGURED");

  const parent = await fetchParentGenerationRow(supabase, parentGenerationId);
  if (!parent) throw new Error("PARENT_GENERATION_NOT_FOUND");

  const passId =
    body?.passId ||
    body?.pass_id ||
    parent?.mg_pass_id ||
    computePassId({
      shopifyCustomerId: body?.customer_id,
      userId: body?.user_id,
      email: body?.email,
    });

  const parentVars = parent?.mg_mma_vars && typeof parent.mg_mma_vars === "object" ? parent.mg_mma_vars : {};
  const mergedInputs0 = { ...(parentVars?.inputs || {}), ...(body?.inputs || {}) };
  const mergedAssets0 = { ...(parentVars?.assets || {}), ...(body?.assets || {}) };

  const needed = videoCostFromInputs(mergedInputs0, mergedAssets0);
  await ensureEnoughCredits(passId, needed, { lane: "video" });

  const generationId = newUuid();

  await ensureCustomerRow(supabase, passId, {
    shopifyCustomerId: body?.customer_id,
    userId: body?.user_id,
    email: body?.email,
  });

  const vars = makeInitialVars({
    mode: "video",
    assets: body?.assets || {},
    history: body?.history || {},
    inputs: body?.inputs || {},
    settings: body?.settings || {},
    feedback: body?.feedback || {},
    prompts: body?.prompts || {},
  });

  vars.mg_pass_id = passId;

  const sessionId =
    safeStr(body?.sessionId || body?.session_id || body?.inputs?.sessionId || body?.inputs?.session_id, "") ||
    safeStr(parent?.mg_session_id, "") ||
    newUuid();

  const platform = safeStr(body?.platform || body?.inputs?.platform, "") || safeStr(parent?.mg_platform, "") || "web";
  const title = safeStr(body?.title || body?.inputs?.title, "") || safeStr(parent?.mg_title, "") || "Video session";

  vars.inputs = { ...(vars.inputs || {}), session_id: sessionId, platform, title };
  vars.meta = { ...(vars.meta || {}), session_id: sessionId, platform, title };

  await ensureSessionForHistory({
    passId,
    sessionId,
    platform,
    title,
    meta: { source: "mma", flow: "video_tweak" },
  });

  vars.meta = { ...(vars.meta || {}), flow: "video_tweak", parent_generation_id: parentGenerationId };
  vars.inputs = { ...(vars.inputs || {}), parent_generation_id: parentGenerationId };

  const parentStart = asHttpUrl(parentVars?.inputs?.start_image_url || parentVars?.inputs?.startImageUrl);
  const parentEnd = asHttpUrl(parentVars?.inputs?.end_image_url || parentVars?.inputs?.endImageUrl);

  if (parentStart) vars.inputs.start_image_url = parentStart;
  if (parentEnd) vars.inputs.end_image_url = parentEnd;

  await writeGeneration({
    supabase,
    generationId,
    parentId: parentGenerationId,
    passId,
    vars,
    mode: "video",
  });

  runVideoTweakPipeline({ supabase, generationId, passId, parent, vars }).catch((err) => {
    console.error("[mma] video tweak pipeline error", err);
  });

  return { generation_id: generationId, status: "queued", sse_url: `/mma/stream/${generationId}` };
}

export async function handleMmaCreate({ mode, body }) {
  const supabase = getSupabaseAdmin();
  if (!supabase) throw new Error("SUPABASE_NOT_CONFIGURED");

  const passId =
    body?.passId ||
    body?.pass_id ||
    computePassId({
      shopifyCustomerId: body?.customer_id,
      userId: body?.user_id,
      email: body?.email,
    });

  const parentId = body?.parent_generation_id || body?.parentGenerationId || body?.generation_id || null;

  const inputs = (body?.inputs && typeof body.inputs === "object") ? body.inputs : {};
  const suggestOnly = inputs.suggest_only === true || inputs.suggestOnly === true;
  const typeForMe =
    inputs.type_for_me === true ||
    inputs.typeForMe === true ||
    inputs.use_suggestion === true ||
    inputs.useSuggestion === true;

  if (mode === "video" && suggestOnly && typeForMe) {
    await preflightTypeForMe({ supabase, passId });
  } else if (mode === "video") {
    const neededVideo = videoCostFromInputs(body?.inputs || {}, body?.assets || {});
    await ensureEnoughCredits(passId, neededVideo, { lane: "video" });
  } else {
    const requestedLane = resolveStillLaneFromInputs(body?.inputs || {});
    const stillCost = stillCostForLane(requestedLane);
    await ensureEnoughCredits(passId, stillCost, { lane: requestedLane });
  }

  const generationId = newUuid();

  const { preferences } = await ensureCustomerRow(supabase, passId, {
    shopifyCustomerId: body?.customer_id,
    userId: body?.user_id,
    email: body?.email,
  });

  const vars = makeInitialVars({
    mode,
    assets: body?.assets || {},
    history: body?.history || {},
    inputs: body?.inputs || {},
    settings: body?.settings || {},
    feedback: body?.feedback || {},
    prompts: body?.prompts || {},
  });

  vars.mg_pass_id = passId;

  const parent = parentId ? await fetchParentGenerationRow(supabase, parentId).catch(() => null) : null;

  const sessionId =
    safeStr(body?.sessionId || body?.session_id || body?.inputs?.sessionId || body?.inputs?.session_id, "") ||
    safeStr(parent?.mg_session_id, "") ||
    newUuid();

  const platform = safeStr(body?.platform || body?.inputs?.platform, "") || safeStr(parent?.mg_platform, "") || "web";

  const title =
    safeStr(body?.title || body?.inputs?.title, "") ||
    safeStr(parent?.mg_title, "") ||
    (mode === "video" ? "Video session" : "Image session");

  vars.inputs = { ...(vars.inputs || {}), session_id: sessionId, platform, title };
  vars.meta = { ...(vars.meta || {}), session_id: sessionId, platform, title };

  await ensureSessionForHistory({
    passId,
    sessionId,
    platform,
    title,
    meta: { source: "mma", flow: mode === "video" ? "video_animate" : "still_create" },
  });

  await writeGeneration({ supabase, generationId, parentId, passId, vars, mode });

  if (mode === "still") {
    vars.meta = { ...(vars.meta || {}), flow: "still_create" };
    await updateVars({ supabase, generationId, vars });

    runStillCreatePipeline({ supabase, generationId, passId, vars, preferences }).catch((err) =>
      console.error("[mma] still create pipeline error", err)
    );
  } else if (mode === "video") {
    vars.meta = { ...(vars.meta || {}), flow: "video_animate", parent_generation_id: parentId || null };

    if (parent?.mg_output_url) {
      vars.inputs = { ...(vars.inputs || {}), parent_output_url: parent.mg_output_url };
    }

    await updateVars({ supabase, generationId, vars });

    runVideoAnimatePipeline({ supabase, generationId, passId, parent, vars }).catch((err) =>
      console.error("[mma] video animate pipeline error", err)
    );
  } else {
    await updateStatus({ supabase, generationId, status: "error" });
    await supabase
      .from("mega_generations")
      .update({
        mg_error: { code: "BAD_MODE", message: `Unsupported mode: ${mode}` },
        mg_updated_at: nowIso(),
      })
      .eq("mg_generation_id", generationId)
      .eq("mg_record_type", "generation");
  }

  return { generation_id: generationId, status: "queued", sse_url: `/mma/stream/${generationId}` };
}

export async function handleMmaEvent(body) {
  const supabase = getSupabaseAdmin();
  if (!supabase) throw new Error("SUPABASE_NOT_CONFIGURED");

  const passId =
    body?.passId ||
    body?.pass_id ||
    computePassId({
      shopifyCustomerId: body?.customer_id,
      userId: body?.user_id,
      email: body?.email,
    });

  await ensureCustomerRow(supabase, passId, {
    shopifyCustomerId: body?.customer_id,
    userId: body?.user_id,
    email: body?.email,
  });

  const eventId = newUuid();
  const identifiers = eventIdentifiers(eventId);

  await supabase.from("mega_generations").insert({
    ...identifiers,
    mg_generation_id: body?.generation_id || null,
    mg_pass_id: passId,
    mg_parent_id: body?.generation_id ? `generation:${body.generation_id}` : null,
    mg_meta: { event_type: body?.event_type || "unknown", payload: body?.payload || {} },
    mg_created_at: nowIso(),
    mg_updated_at: nowIso(),
  });

  if (body?.event_type === "like" || body?.event_type === "dislike" || body?.event_type === "preference_set") {
    const { data } = await supabase
      .from("mega_customers")
      .select("mg_mma_preferences")
      .eq("mg_pass_id", passId)
      .maybeSingle();

    const prefs = data?.mg_mma_preferences || {};
    const hardBlocks = new Set(Array.isArray(prefs.hard_blocks) ? prefs.hard_blocks : []);
    const tagWeights = { ...(prefs.tag_weights || {}) };

    if (body?.payload?.hard_block) {
      hardBlocks.add(body.payload.hard_block);
      tagWeights[body.payload.hard_block] = -999;
    }

    await supabase
      .from("mega_customers")
      .update({
        mg_mma_preferences: { ...prefs, hard_blocks: Array.from(hardBlocks), tag_weights: tagWeights },
        mg_mma_preferences_updated_at: nowIso(),
        mg_updated_at: nowIso(),
      })
      .eq("mg_pass_id", passId);
  }

  return { event_id: eventId, status: "ok" };
}

export async function refreshFromReplicate({ generationId, passId }) {
  const supabase = getSupabaseAdmin();
  if (!supabase) throw new Error("SUPABASE_NOT_CONFIGURED");

  const { data, error } = await supabase
    .from("mega_generations")
    .select("mg_pass_id, mg_mma_mode, mg_output_url, mg_prompt, mg_mma_vars")
    .eq("mg_generation_id", generationId)
    .eq("mg_record_type", "generation")
    .maybeSingle();

  if (error) throw error;
  if (!data) return { ok: false, error: "NOT_FOUND" };

  // security: only same passId can refresh
  if (passId && data.mg_pass_id && String(passId) !== String(data.mg_pass_id)) {
    return { ok: false, error: "FORBIDDEN" };
  }

  if (data.mg_output_url) {
    return { ok: true, refreshed: false, alreadyDone: true, url: data.mg_output_url };
  }

  const vars = data.mg_mma_vars && typeof data.mg_mma_vars === "object" ? data.mg_mma_vars : {};
  const mode = String(data.mg_mma_mode || "");
  const outputs = vars.outputs && typeof vars.outputs === "object" ? vars.outputs : {};

  const predictionId =
    mode === "video"
      ? outputs.kling_motion_control_prediction_id ||
        outputs.klingMotionControlPredictionId ||
        outputs.fabric_prediction_id ||
        outputs.fabricPredictionId ||
        outputs.kling_prediction_id ||
        outputs.klingPredictionId ||
        ""
      : outputs.nanobanana_prediction_id ||
        outputs.nanobananaPredictionId ||
        outputs.seedream_prediction_id ||
        outputs.seedreamPredictionId ||
        "";

  if (!predictionId) {
    return { ok: false, error: "NO_PREDICTION_ID" };
  }

  const replicate = getReplicate();
  const pred = await replicate.predictions.get(String(predictionId));
  const providerStatus = pred?.status || null;

  const url = pickFirstUrl(pred?.output);
  if (!url) {
    return { ok: true, refreshed: false, provider_status: providerStatus };
  }

  // store permanent + finalize
  const remoteUrl = await storeRemoteToR2Public(
    url,
    mode === "video" ? `mma/video/${generationId}` : `mma/still/${generationId}`
  );

  // update vars + final row
  const nextVars = { ...vars, mg_output_url: remoteUrl };
  nextVars.outputs = { ...(nextVars.outputs || {}) };
  if (mode === "video") {
    nextVars.outputs.kling_video_url = remoteUrl;
  } else {
    // prefer storing under the engine that was used
    if (outputs.nanobanana_prediction_id || outputs.nanobananaPredictionId) {
      nextVars.outputs.nanobanana_image_url = remoteUrl;
    } else {
      nextVars.outputs.seedream_image_url = remoteUrl;
    }
  }

  await supabase
    .from("mega_generations")
    .update({
      mg_output_url: remoteUrl,
      mg_status: "done",
      mg_mma_status: "done",
      mg_mma_vars: nextVars,
      mg_updated_at: nowIso(),
    })
    .eq("mg_generation_id", generationId)
    .eq("mg_record_type", "generation");

  return { ok: true, refreshed: true, provider_status: providerStatus, url: remoteUrl };
}

// ============================================================================
// Fetch + admin helpers
// ============================================================================
export async function fetchGeneration(generationId) {
  const supabase = getSupabaseAdmin();
  if (!supabase) throw new Error("SUPABASE_NOT_CONFIGURED");

  const { data, error } = await supabase
    .from("mega_generations")
    .select("mg_generation_id, mg_mma_status, mg_status, mg_mma_vars, mg_output_url, mg_prompt, mg_error, mg_mma_mode")
    .eq("mg_generation_id", generationId)
    .eq("mg_record_type", "generation")
    .maybeSingle();

  if (error) throw error;
  if (!data) return null;

  const internal = data.mg_mma_status || data.mg_status || "queued";

  const vars = data.mg_mma_vars && typeof data.mg_mma_vars === "object" ? data.mg_mma_vars : {};
  const vOut = vars.outputs && typeof vars.outputs === "object" ? vars.outputs : {};
  const meta = vars.meta && typeof vars.meta === "object" ? vars.meta : {};

  const stillEngine =
    safeStr(meta.still_engine, "") ||
    (vOut.nanobanana_image_url || vOut.nanobanana_prediction_id ? "nanobanana" : "seedream");

  return {
    generation_id: data.mg_generation_id,
    status: toUserStatus(internal),
    state: internal,

    mma_vars: vars,
    still_engine: data.mg_mma_mode === "still" ? stillEngine : null,

    outputs: {
      seedream_image_url:
        data.mg_mma_mode === "still" && stillEngine === "seedream" ? data.mg_output_url : null,
      nanobanana_image_url:
        data.mg_mma_mode === "still" && stillEngine === "nanobanana" ? data.mg_output_url : null,
      kling_video_url: data.mg_mma_mode === "video" ? data.mg_output_url : null,
    },

    prompt: data.mg_prompt || null,
    error: data.mg_error || null,
  };
}

export async function listSteps(generationId) {
  const supabase = getSupabaseAdmin();
  if (!supabase) throw new Error("SUPABASE_NOT_CONFIGURED");

  const { data, error } = await supabase
    .from("mega_generations")
    .select("*")
    .eq("mg_generation_id", generationId)
    .eq("mg_record_type", "mma_step")
    .order("mg_step_no", { ascending: true });

  if (error) throw error;
  return data || [];
}

export async function listErrors() {
  const supabase = getSupabaseAdmin();
  if (!supabase) throw new Error("SUPABASE_NOT_CONFIGURED");

  const { data, error } = await supabase
    .from("mega_admin")
    .select("*")
    .eq("mg_record_type", "error")
    .order("mg_created_at", { ascending: false })
    .limit(50);

  if (error) throw error;
  return data || [];
}

export function registerSseClient(generationId, res, initial) {
  addSseClient(generationId, res, initial);
}

// ============================================================================
// Router factory (optional; you may also use ./mma-router.js)
// IMPORTANT: inject passId from request so it matches router behavior
// ============================================================================
export function createMmaController() {
  const router = express.Router();

  const injectPassId = (req, raw) => {
    const body = raw && typeof raw === "object" ? raw : {};
    const passId = megaResolvePassId(req, body);
    return { passId, body: { ...body, passId } };
  };

  router.post("/still/create", async (req, res) => {
    try {
      const { passId, body } = injectPassId(req, req.body);
      res.set("X-Mina-Pass-Id", passId);
      const result = await handleMmaCreate({ mode: "still", body });
      res.json(result);
    } catch (err) {
      console.error("[mma] still/create error", err);
      res.status(err?.statusCode || 500).json({ error: "MMA_CREATE_FAILED", message: err?.message });
    }
  });

  router.post("/still/:generation_id/tweak", async (req, res) => {
    try {
      const { passId, body } = injectPassId(req, req.body || {});
      res.set("X-Mina-Pass-Id", passId);
      const result = await handleMmaStillTweak({
        parentGenerationId: req.params.generation_id,
        body,
      });
      res.json(result);
    } catch (err) {
      console.error("[mma] still tweak error", err);
      res.status(err?.statusCode || 500).json({ error: "MMA_TWEAK_FAILED", message: err?.message });
    }
  });

  router.post("/video/animate", async (req, res) => {
    try {
      const { passId, body } = injectPassId(req, req.body);
      res.set("X-Mina-Pass-Id", passId);
      const result = await handleMmaCreate({ mode: "video", body });
      res.json(result);
    } catch (err) {
      console.error("[mma] video/animate error", err);
      res.status(err?.statusCode || 500).json({ error: "MMA_ANIMATE_FAILED", message: err?.message });
    }
  });

  router.post("/video/:generation_id/tweak", async (req, res) => {
    try {
      const { passId, body } = injectPassId(req, req.body || {});
      res.set("X-Mina-Pass-Id", passId);
      const result = await handleMmaVideoTweak({
        parentGenerationId: req.params.generation_id,
        body,
      });
      res.json(result);
    } catch (err) {
      console.error("[mma] video tweak error", err);
      res.status(err?.statusCode || 500).json({ error: "MMA_VIDEO_TWEAK_FAILED", message: err?.message });
    }
  });

  router.post("/events", async (req, res) => {
    try {
      const { passId, body } = injectPassId(req, req.body || {});
      res.set("X-Mina-Pass-Id", passId);
      const result = await handleMmaEvent(body || {});
      res.json(result);
    } catch (err) {
      console.error("[mma] events error", err);
      res.status(500).json({ error: "MMA_EVENT_FAILED", message: err?.message });
    }
  });

  router.get("/generations/:generation_id", async (req, res) => {
    try {
      const payload = await fetchGeneration(req.params.generation_id);
      if (!payload) return res.status(404).json({ error: "NOT_FOUND" });
      res.json(payload);
    } catch (err) {
      console.error("[mma] fetch generation error", err);
      res.status(500).json({ error: "MMA_FETCH_FAILED", message: err?.message });
    }
  });

  router.get("/stream/:generation_id", async (req, res) => {
    const supabase = getSupabaseAdmin();
    if (!supabase) return res.status(500).end();

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      Connection: "keep-alive",
      "Cache-Control": "no-cache",
    });
    res.flushHeaders?.();

    const { data } = await supabase
      .from("mega_generations")
      .select("mg_mma_vars, mg_mma_status")
      .eq("mg_generation_id", req.params.generation_id)
      .eq("mg_record_type", "generation")
      .maybeSingle();

    const scanLines = data?.mg_mma_vars?.userMessages?.scan_lines || [];
    const internal = String(data?.mg_mma_status || "queued");
    const statusText = internal;

    // âœ… Register client first so sendStatus/sendDone hit THIS connection too
    registerSseClient(req.params.generation_id, res, { scanLines, status: statusText });

    // âœ… If it's already finished (done/error/suggested), immediately emit DONE then close
    const TERMINAL = new Set(["done", "error", "suggested"]);
    if (TERMINAL.has(internal)) {
      try {
        // sendStatus uses your existing SSE format
        sendStatus(req.params.generation_id, statusText);
        // sendDone is what your frontend should listen to to stop "Creating..."
        sendDone(req.params.generation_id, statusText);
      } catch {}
      try {
        res.end();
      } catch {}
      return;
    }

    // Normal keepalive for running generations only
    const keepAlive = setInterval(() => {
      try {
        res.write(`:keepalive\n\n`);
      } catch {}
    }, 25000);

    res.on("close", () => clearInterval(keepAlive));
  });

  router.get("/admin/mma/errors", async (_req, res) => {
    try {
      const errors = await listErrors();
      res.json({ errors });
    } catch (err) {
      res.status(500).json({ error: "MMA_ADMIN_ERRORS", message: err?.message });
    }
  });

  router.get("/admin/mma/steps/:generation_id", async (req, res) => {
    try {
      const steps = await listSteps(req.params.generation_id);
      res.json({ steps });
    } catch (err) {
      res.status(500).json({ error: "MMA_ADMIN_STEPS", message: err?.message });
    }
  });

  return router;
}

export default createMmaController;
