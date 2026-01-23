import { sendDone } from "./mma-sse.js";
import { getMmaConfig } from "./mma-config.js";
import { MMA_UI, pick } from "./mma-ui.js";
import { asHttpUrl, resolveFrame2Reference, safeStr } from "./mma-shared.js";
import { getMmaCtxConfig } from "./mma-context.js";
import { gptMotionOneShotAnimate, gptMotionOneShotTweak } from "./mma-openai.js";
import {
  pickFirstUrl,
  pickKlingEndImage,
  pickKlingStartImage,
  runFabricAudio,
  runKling,
  runKlingMotionControl,
} from "./mma-replicate.js";
import { storeRemoteToR2Public } from "./mma-r2.js";
import { resolveVideoPricing, videoCostFromInputs } from "./mma-pricing.js";
import { chargeGeneration, commitTypeForMeSuccessAndMaybeCharge, refundOnFailure } from "./mma-credits.js";
import { finalizeGeneration, updateStatus, updateVars, writeStep } from "./mma-db.js";
import { emitLine, emitStatus, pushUserMessageLine, startMinaChatter } from "./mma-messages.js";
import { nowIso } from "./mma-utils.js";

// VIDEO ANIMATE PIPELINE (Kling)
// ============================================================================
export async function runVideoAnimatePipeline({ supabase, generationId, passId, parent, vars }) {
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
export async function runVideoTweakPipeline({ supabase, generationId, passId, parent, vars }) {
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
