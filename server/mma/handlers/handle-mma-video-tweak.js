// ./server/mma/handlers/handle-mma-video-tweak.js
import { getSupabaseAdmin } from "../../../supabase.js";

import { computePassId, makeInitialVars, newUuid } from "../mma-utils.js";
import { asHttpUrl, safeStr } from "../mma-shared.js";
import { videoCostFromInputs } from "../mma-pricing.js";
import { ensureEnoughCredits } from "../mma-credits.js";
import {
  ensureCustomerRow,
  ensureSessionForHistory,
  fetchParentGenerationRow,
  writeGeneration,
} from "../mma-db.js";

import { runVideoTweakPipeline } from "../mma-pipeline-video.js";

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
