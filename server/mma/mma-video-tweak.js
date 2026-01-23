import { sendDone } from "./mma-sse.js";
import { getMmaConfig } from "./mma-config.js";
import { MMA_UI, pick } from "./mma-ui.js";
import { asHttpUrl, resolveFrame2Reference, safeStr } from "./mma-shared.js";
import { getMmaCtxConfig } from "./mma-context.js";
import { gptMotionOneShotTweak } from "./mma-openai.js";
import { pickFirstUrl, runFabricAudio, runKling, runKlingMotionControl } from "./mma-replicate.js";
import { storeRemoteToR2Public } from "./mma-r2.js";
import { resolveVideoPricing, videoCostFromInputs } from "./mma-pricing.js";
import { chargeGeneration, refundOnFailure } from "./mma-credits.js";
import { finalizeGeneration, updateStatus, updateVars, writeStep } from "./mma-db.js";
import { emitLine, emitStatus, pushUserMessageLine, startMinaChatter } from "./mma-messages.js";
import { nowIso } from "./mma-utils.js";

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
