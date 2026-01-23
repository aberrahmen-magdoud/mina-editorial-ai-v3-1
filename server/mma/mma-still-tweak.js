import { sendDone } from "./mma-sse.js";
import { getMmaConfig } from "./mma-config.js";
import { MMA_UI, pick } from "./mma-ui.js";
import { asHttpUrl, safeArray, safeStr } from "./mma-shared.js";
import { getMmaCtxConfig } from "./mma-context.js";
import { gptStillOneShotTweak } from "./mma-openai.js";
import {
  buildNanoBananaImageInputs,
  buildSeedreamImageInputs,
  nanoBananaEnabled,
  pickFirstUrl,
  runNanoBanana,
  runSeedream,
} from "./mma-replicate.js";
import { storeRemoteToR2Public } from "./mma-r2.js";
import { resolveStillLane, stillCostForLane } from "./mma-pricing.js";
import { chargeGeneration, refundOnFailure } from "./mma-credits.js";
import { finalizeGeneration, updateStatus, updateVars, writeStep } from "./mma-db.js";
import { emitLine, emitStatus, pushUserMessageLine, startMinaChatter } from "./mma-messages.js";
import { nowIso } from "./mma-utils.js";

export async function runStillTweakPipeline({ supabase, generationId, passId, parent, vars, preferences }) {
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
