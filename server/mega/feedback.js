import crypto from "node:crypto";
import { nowIso, requireSupabase, safeString } from "./internal.js";
import { megaEnsureCustomer, touchCustomer } from "./customers.js";

export async function megaWriteFeedback({
  passId,
  generationId = null,
  payload = {},
} = {}) {
  const supabase = requireSupabase();
  const pid = safeString(passId, "");
  if (!pid) throw new Error("PASS_ID_REQUIRED");

  const ts = nowIso();
  const feedbackId = crypto.randomUUID();

  await megaEnsureCustomer({ passId: pid });
  await touchCustomer(supabase, pid);

  const { error: insErr } = await supabase.from("mega_generations").insert({
    mg_id: `feedback:${feedbackId}`,
    mg_record_type: "feedback",
    mg_pass_id: pid,
    mg_generation_id: generationId ? safeString(generationId, null) : null,
    mg_status: "succeeded",
    mg_meta: payload && typeof payload === "object" ? payload : { value: payload },
    mg_payload: null,
    mg_event_at: ts,
    mg_created_at: ts,
    mg_updated_at: ts,
  });

  if (insErr) throw insErr;

  return { feedbackId };
}
