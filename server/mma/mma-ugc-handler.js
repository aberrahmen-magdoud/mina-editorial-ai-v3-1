// server/mma/mma-ugc-handler.js — Express handler for UGC create endpoint
"use strict";

import { getSupabaseAdmin } from "../../supabase.js";
import { resolvePassId as megaResolvePassId } from "../../mega-db.js";
import {
  computePassId,
  makeInitialVars,
  newUuid,
  nowIso,
} from "./mma-utils.js";
import { safeStr } from "./mma-helpers.js";
import {
  ensureEnoughCredits,
} from "./mma-credits.js";
import {
  writeGeneration,
  updateVars,
  updateStatus,
  ensureCustomerRow,
  ensureSessionForHistory,
} from "./mma-db.js";
import { runUgcPipeline, ugcCostForShots } from "./mma-ugc-pipeline.js";

// ============================================================================
// handleMmaUgcCreate
// ============================================================================
export async function handleMmaUgcCreate({ body }) {
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

  const inputs = body?.inputs && typeof body.inputs === "object" ? body.inputs : {};
  const targetDuration = Math.max(15, Math.min(120, Number(inputs.ugc_target_duration || inputs.target_duration || 60) || 60));
  const requestedShots = Number(inputs.ugc_shot_count || inputs.shot_count || 0) || 0;
  const estimatedShots = requestedShots || Math.ceil(targetDuration / 8);
  const neededCredits = ugcCostForShots(estimatedShots);

  await ensureEnoughCredits(passId, neededCredits, { lane: "ugc" });

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
    safeStr(body?.sessionId || body?.session_id || inputs?.sessionId || inputs?.session_id, "") ||
    newUuid();
  const platform = safeStr(body?.platform || inputs?.platform, "") || "web";
  const title = safeStr(body?.title || inputs?.title, "") || "UGC session";

  vars.inputs = { ...(vars.inputs || {}), session_id: sessionId, platform, title };
  vars.meta = { ...(vars.meta || {}), session_id: sessionId, platform, title, flow: "ugc" };

  await ensureSessionForHistory({
    passId,
    sessionId,
    platform,
    title,
    meta: { source: "mma", flow: "ugc" },
  });

  await writeGeneration({ supabase, generationId, parentId: null, passId, vars, mode: "video" });

  // Fire-and-forget the pipeline
  runUgcPipeline({ supabase, generationId, passId, vars }).catch((err) =>
    console.error("[mma] UGC pipeline error:", err)
  );

  return {
    generation_id: generationId,
    status: "queued",
    sse_url: `/mma/stream/${generationId}`,
  };
}
