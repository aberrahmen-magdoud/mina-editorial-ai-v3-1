// ./server/mma/handlers/fetch-generation.js
import { getSupabaseAdmin } from "../../../supabase.js";

import { safeStr } from "../mma-shared.js";
import { toUserStatus } from "../mma-ui.js";

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
