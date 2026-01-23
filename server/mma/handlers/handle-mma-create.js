// ./server/mma/handlers/handle-mma-create.js
import { getSupabaseAdmin } from "../../../supabase.js";

import { computePassId, makeInitialVars, newUuid, nowIso } from "../mma-utils.js";
import { safeStr } from "../mma-shared.js";
import { resolveStillLaneFromInputs, stillCostForLane, videoCostFromInputs } from "../mma-pricing.js";
import { ensureEnoughCredits, preflightTypeForMe } from "../mma-credits.js";
import {
  ensureCustomerRow,
  ensureSessionForHistory,
  fetchParentGenerationRow,
  updateStatus,
  updateVars,
  writeGeneration,
} from "../mma-db.js";

import { runStillCreatePipeline } from "../mma-pipeline-still.js";
import { runVideoAnimatePipeline } from "../mma-pipeline-video.js";

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
