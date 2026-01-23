import { nowIso, requireSupabase, safeString } from "./internal.js";
import { megaEnsureCustomer, touchCustomer } from "./customers.js";

export async function megaWriteSession({
  passId,
  sessionId,
  platform = "web",
  title = null,
  meta = {},
} = {}) {
  const supabase = requireSupabase();
  const pid = safeString(passId, "");
  const sid = safeString(sessionId, "");
  if (!pid) throw new Error("PASS_ID_REQUIRED");
  if (!sid) throw new Error("SESSION_ID_REQUIRED");

  const ts = nowIso();

  await megaEnsureCustomer({ passId: pid });
  await touchCustomer(supabase, pid);

  const { error: insErr } = await supabase.from("mega_generations").insert({
    mg_id: `session:${sid}`,
    mg_record_type: "session",
    mg_pass_id: pid,
    mg_session_id: sid,
    mg_platform: safeString(platform, "web"),
    mg_title: title ? safeString(title, null) : null,
    mg_status: "succeeded",
    mg_meta: meta && typeof meta === "object" ? meta : {},
    mg_payload: null,
    mg_event_at: ts,
    mg_created_at: ts,
    mg_updated_at: ts,
  });

  if (insErr) throw insErr;

  return { sessionId: sid };
}
