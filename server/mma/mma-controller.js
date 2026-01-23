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

import { toUserStatus } from "./mma-ui.js";
import { asHttpUrl, safeStr } from "./mma-shared.js";
import {
  getReplicate,
  pickFirstUrl,
} from "./mma-replicate.js";
import { storeRemoteToR2Public } from "./mma-r2.js";
import { resolveStillLaneFromInputs, stillCostForLane, videoCostFromInputs } from "./mma-pricing.js";
import { ensureEnoughCredits, preflightTypeForMe } from "./mma-credits.js";
import {
  ensureCustomerRow,
  ensureSessionForHistory,
  fetchParentGenerationRow,
  updateStatus,
  updateVars,
  writeGeneration,
} from "./mma-db.js";

import { runStillCreatePipeline, runStillTweakPipeline } from "./mma-pipeline-still.js";
import { runVideoAnimatePipeline, runVideoTweakPipeline } from "./mma-pipeline-video.js";

// Pipelines are in ./mma-pipeline-still.js and ./mma-pipeline-video.js
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

