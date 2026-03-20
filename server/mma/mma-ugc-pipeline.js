// server/mma/mma-ugc-pipeline.js — Multi-clip UGC pipeline: plan → generate N shots → stitch → deliver
"use strict";

import { getMmaConfig } from "./mma-config.js";
import { nowIso } from "./mma-utils.js";
import {
  safeStr,
  asHttpUrl,
  safeArray,
  pushUserMessageLine,
  lastScanLine,
  pickFirstUrl,
} from "./mma-helpers.js";
import { MMA_UI, pick } from "./mma-ui-text.js";
import { sendDone, sendScanLine, sendStatus } from "./mma-sse.js";
import { planUgcShots } from "./mma-ugc-planner.js";
import { runKlingOmni } from "./mma-kling-omni.js";
import { KLING_DEFAULT_NEGATIVE_PROMPT } from "./mma-kling.js";
import { storeRemoteToR2Public } from "./mma-r2.js";
import { stitchClips } from "./mma-ugc-stitch.js";
import {
  chargeGeneration,
  refundOnFailure,
} from "./mma-credits.js";
import {
  writeGeneration,
  writeStep,
  finalizeGeneration,
  updateVars,
  updateStatus,
} from "./mma-db.js";

// ============================================================================
// SSE emit helpers
// ============================================================================
function emitStatus(generationId, status) {
  sendStatus(generationId, String(status || ""));
}

function emitLine(generationId, text) {
  sendScanLine(generationId, String(text || ""));
}

// ============================================================================
// UGC cost calculation
// ============================================================================
const UGC_COST_PER_SHOT = 10; // same as a single video generation

export function ugcCostForShots(shotCount) {
  return Math.max(1, Number(shotCount) || 5) * UGC_COST_PER_SHOT;
}

// ============================================================================
// runUgcPipeline — the main orchestrator
// ============================================================================
export async function runUgcPipeline({ supabase, generationId, passId, vars }) {
  const cfg = getMmaConfig();
  if (!cfg.enabled) throw new Error("MMA_DISABLED");

  let working = vars;
  const inputs = working?.inputs && typeof working.inputs === "object" ? working.inputs : {};

  const brief = safeStr(
    inputs.motion_user_brief || inputs.brief || inputs.user_brief || inputs.userBrief,
    ""
  );
  const targetDuration = Math.max(15, Math.min(120, Number(inputs.ugc_target_duration || inputs.target_duration || 60) || 60));
  const requestedShots = Number(inputs.ugc_shot_count || inputs.shot_count || 0) || 0;

  // Resolve start image from assets
  const assets = working?.assets && typeof working.assets === "object" ? working.assets : {};
  const startImageUrl = asHttpUrl(
    assets.product_image_url || assets.productImageUrl ||
    assets.start_image_url || assets.startImageUrl ||
    inputs.start_image_url || inputs.startImageUrl
  ) || "";

  const audioUrl = asHttpUrl(
    inputs.frame2_url || inputs.audio_url || inputs.audioUrl ||
    assets.audio_url || assets.audioUrl || assets.frame2_audio_url
  ) || "";

  // Estimate cost upfront
  const estimatedShots = requestedShots || Math.ceil(targetDuration / 8);
  const totalCost = ugcCostForShots(estimatedShots);

  await chargeGeneration({
    passId,
    generationId,
    cost: totalCost,
    reason: "mma_ugc",
    lane: "ugc",
  });

  working.meta = {
    ...(working.meta || {}),
    flow: "ugc",
    video_engine: "kling_omni_ugc",
    video_lane: "ugc",
    ugc_target_duration: targetDuration,
    ugc_estimated_shots: estimatedShots,
    ugc_cost: totalCost,
  };
  await updateVars({ supabase, generationId, vars: working });

  let stepNo = 1;

  try {
    // ================================================================
    // STEP 1: GPT Shot Planning
    // ================================================================
    await updateStatus({ supabase, generationId, status: "planning" });
    emitStatus(generationId, "planning");
    emitLine(generationId, "Planning your UGC shots...");

    const labeledImages = [];
    if (startImageUrl) labeledImages.push({ role: "PRODUCT / MAIN SUBJECT", url: startImageUrl });

    // Add inspiration images if provided
    const inspUrls = safeArray(assets.inspiration_image_urls || assets.inspirationImageUrls)
      .map(asHttpUrl)
      .filter(Boolean)
      .slice(0, 4);
    inspUrls.forEach((u, i) => {
      labeledImages.push({ role: `INSPIRATION ${i + 1}`, url: u });
    });

    const plan = await planUgcShots({
      cfg,
      brief,
      targetDuration,
      shotCount: requestedShots || undefined,
      labeledImages,
    });

    const shots = plan.shots;

    working.meta = {
      ...(working.meta || {}),
      ugc_plan: {
        shots: shots.map((s) => ({ shot_no: s.shot_no, duration: s.duration, camera: s.camera })),
        total_duration: plan.total_duration,
        audio_direction: plan.audio_direction,
      },
      ugc_shot_count: shots.length,
    };
    working.prompts = {
      ...(working.prompts || {}),
      ugc_negative_prompt: plan.negative_prompt,
    };
    await updateVars({ supabase, generationId, vars: working });

    await writeStep({
      supabase,
      generationId,
      passId,
      stepNo: stepNo++,
      stepType: "ugc_plan",
      payload: {
        input: { brief, targetDuration, shotCount: requestedShots },
        output: { shots, total_duration: plan.total_duration, negative_prompt: plan.negative_prompt },
        raw: plan.raw,
        timing: { started_at: nowIso(), ended_at: nowIso() },
        error: null,
      },
    });

    emitLine(generationId, `Planned ${shots.length} shots (${plan.total_duration}s total)`);

    // ================================================================
    // STEP 2: Generate Each Shot via Kling Omni
    // ================================================================
    await updateStatus({ supabase, generationId, status: "generating" });
    emitStatus(generationId, "generating");

    const clipUrls = [];

    for (let i = 0; i < shots.length; i++) {
      const shot = shots[i];
      emitLine(generationId, `Generating shot ${i + 1}/${shots.length}...`);

      const shotPrompt = shot.prompt;
      const shotDuration = shot.duration;

      const t0 = Date.now();
      let genRes;

      try {
        genRes = await runKlingOmni({
          prompt: shotPrompt,
          startImage: startImageUrl || undefined,
          duration: shotDuration,
          mode: "standard",
          negativePrompt: plan.negative_prompt || KLING_DEFAULT_NEGATIVE_PROMPT,
          generateAudio: false, // audio added in stitch step
        });
      } catch (shotErr) {
        console.error(`[ugc] shot ${i + 1} generation failed:`, shotErr?.message || shotErr);
        // Write step error but continue with remaining shots
        await writeStep({
          supabase,
          generationId,
          passId,
          stepNo: stepNo++,
          stepType: "ugc_shot_generate",
          payload: {
            shot_no: i + 1,
            prompt: shotPrompt,
            duration: shotDuration,
            error: shotErr?.message || String(shotErr),
            timing: { started_at: new Date(t0).toISOString(), ended_at: nowIso(), duration_ms: Date.now() - t0 },
          },
        });
        throw new Error(`UGC_SHOT_${i + 1}_FAILED: ${shotErr?.message || shotErr}`);
      }

      // Extract video URL from Kling result
      const rawVideoUrl = pickFirstUrl(genRes.out);
      if (!rawVideoUrl) {
        throw new Error(`UGC_SHOT_${i + 1}_NO_URL`);
      }

      // Store clip in R2
      const clipR2Url = await storeRemoteToR2Public(rawVideoUrl, `mma/ugc/${generationId}/shot-${i + 1}`);
      clipUrls.push(clipR2Url);

      await writeStep({
        supabase,
        generationId,
        passId,
        stepNo: stepNo++,
        stepType: "ugc_shot_generate",
        payload: {
          shot_no: i + 1,
          prompt: shotPrompt,
          duration: shotDuration,
          clip_url: clipR2Url,
          prediction_id: genRes.prediction_id || null,
          timing: { started_at: new Date(t0).toISOString(), ended_at: nowIso(), duration_ms: Date.now() - t0 },
          error: null,
        },
      });

      emitLine(generationId, `Shot ${i + 1}/${shots.length} done`);
    }

    working.outputs = { ...(working.outputs || {}), ugc_clip_urls: clipUrls };
    await updateVars({ supabase, generationId, vars: working });

    // ================================================================
    // STEP 3: Stitch All Clips Together
    // ================================================================
    emitLine(generationId, "Stitching your UGC video...");
    await updateStatus({ supabase, generationId, status: "stitching" });
    emitStatus(generationId, "stitching");

    const t0Stitch = Date.now();

    const finalVideoUrl = await stitchClips({
      clipUrls,
      audioUrl: audioUrl || undefined,
      r2KeyPrefix: `mma/ugc/${generationId}`,
    });

    await writeStep({
      supabase,
      generationId,
      passId,
      stepNo: stepNo++,
      stepType: "ugc_stitch",
      payload: {
        clip_count: clipUrls.length,
        clip_urls: clipUrls,
        audio_url: audioUrl || null,
        final_url: finalVideoUrl,
        timing: { started_at: new Date(t0Stitch).toISOString(), ended_at: nowIso(), duration_ms: Date.now() - t0Stitch },
        error: null,
      },
    });

    // ================================================================
    // STEP 4: Finalize
    // ================================================================
    working.outputs = {
      ...(working.outputs || {}),
      ugc_video_url: finalVideoUrl,
      kling_video_url: finalVideoUrl,
    };
    working.mg_output_url = finalVideoUrl;

    await updateVars({ supabase, generationId, vars: working });

    const finalPrompt = shots.map((s) => `[Shot ${s.shot_no}] ${s.prompt}`).join("\n");

    await finalizeGeneration({
      supabase,
      generationId,
      url: finalVideoUrl,
      prompt: finalPrompt,
      vars: working,
      mode: "video",
      matchasCharged: totalCost,
    });

    await updateStatus({ supabase, generationId, status: "done" });
    emitStatus(generationId, "done");
    emitLine(generationId, "Your UGC video is ready!");
    sendDone(generationId, "done");
  } catch (err) {
    console.error("[mma] UGC pipeline error:", err);

    await updateStatus({ supabase, generationId, status: "error" });
    await supabase
      .from("mega_generations")
      .update({
        mg_error: {
          code: "UGC_PIPELINE_ERROR",
          message: err?.message || String(err || ""),
        },
        mg_updated_at: nowIso(),
      })
      .eq("mg_generation_id", generationId)
      .eq("mg_record_type", "generation");

    try {
      await refundOnFailure({ supabase, passId, generationId, cost: totalCost, err });
    } catch (e) {
      console.warn("[mma] UGC refund failed:", e?.message || e);
    }

    emitStatus(generationId, "error");
    sendDone(generationId, "error");
  }
}
