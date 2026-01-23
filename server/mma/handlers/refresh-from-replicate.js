// ./server/mma/handlers/refresh-from-replicate.js
import { getSupabaseAdmin } from "../../../supabase.js";

import { nowIso } from "../mma-utils.js";
import { getReplicate, pickFirstUrl } from "../mma-replicate.js";
import { storeRemoteToR2Public } from "../mma-r2.js";

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
