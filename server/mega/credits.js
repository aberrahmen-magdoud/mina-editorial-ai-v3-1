import crypto from "node:crypto";
import { addDaysIso, intOr, maxIso, nowIso, requireSupabase, safeString } from "./internal.js";
import { megaEnsureCustomer } from "./customers.js";

export async function megaGetCredits(passId) {
  const supabase = requireSupabase();
  const pid = safeString(passId, "");
  if (!pid) throw new Error("PASS_ID_REQUIRED");

  const { data, error } = await supabase
    .from("mega_customers")
    .select("mg_credits, mg_expires_at")
    .eq("mg_pass_id", pid)
    .maybeSingle();

  if (error) throw error;

  return {
    credits: intOr(data?.mg_credits, 0),
    expiresAt: data?.mg_expires_at ?? null,
  };
}

export async function megaHasCreditRef({ refType, refId } = {}) {
  const supabase = requireSupabase();
  const rt = safeString(refType, "");
  const rid = safeString(refId, "");
  if (!rt || !rid) return false;

  const { data, error } = await supabase
    .from("mega_generations")
    .select("mg_id")
    .eq("mg_record_type", "credit_transaction")
    .eq("mg_ref_type", rt)
    .eq("mg_ref_id", rid)
    .limit(1);

  if (error) throw error;
  return (data?.length ?? 0) > 0;
}

export async function megaAdjustCredits({
  passId,
  delta,
  reason = "manual",
  source = "api",
  refType = null,
  refId = null,
  grantedAt = null,
} = {}) {
  const supabase = requireSupabase();
  const pid = safeString(passId, "");
  if (!pid) throw new Error("PASS_ID_REQUIRED");

  const d = Number(delta ?? 0);
  if (!Number.isFinite(d) || d === 0) throw new Error("DELTA_INVALID");

  const ts = nowIso();
  const eventAt = grantedAt ? new Date(grantedAt).toISOString() : ts;

  await megaEnsureCustomer({ passId: pid });

  const rt = refType ? safeString(refType, "") : "";
  const rid = refId ? safeString(refId, "") : "";
  const hasRef = Boolean(rt && rid);

  const txId = `credit_transaction:${crypto.randomUUID()}`;

  if (hasRef) {
    const { error: txErr } = await supabase.from("mega_generations").insert({
      mg_id: txId,
      mg_record_type: "credit_transaction",
      mg_pass_id: pid,
      mg_delta: Math.trunc(d),
      mg_reason: safeString(reason, null),
      mg_source: safeString(source, null),
      mg_ref_type: rt,
      mg_ref_id: rid,
      mg_status: "pending",
      mg_meta: {},
      mg_payload: null,
      mg_event_at: eventAt,
      mg_created_at: ts,
      mg_updated_at: ts,
    });

    if (txErr) {
      const code = String(txErr.code || "");
      const msg = String(txErr.message || "");
      const dup =
        code === "23505" ||
        msg.toLowerCase().includes("duplicate") ||
        msg.toLowerCase().includes("unique");

      if (dup) {
        const cur = await megaGetCredits(pid);
        return {
          creditsBefore: cur.credits,
          creditsAfter: cur.credits,
          expiresAt: cur.expiresAt ?? null,
          alreadyApplied: true,
        };
      }

      throw txErr;
    }
  }

  const { data: row, error: readErr } = await supabase
    .from("mega_customers")
    .select("mg_credits, mg_expires_at")
    .eq("mg_pass_id", pid)
    .maybeSingle();

  if (readErr) throw readErr;

  const before = intOr(row?.mg_credits, 0);
  const after = Math.max(0, before + d);

  const expireDays = intOr(process.env.DEFAULT_CREDITS_EXPIRE_DAYS, 30);
  const currentExpiry = row?.mg_expires_at ? new Date(row.mg_expires_at).toISOString() : null;

  let nextExpiry = currentExpiry;
  if (d > 0) {
    const candidate = addDaysIso(eventAt, expireDays);
    nextExpiry = maxIso(currentExpiry, candidate);
  }

  const { error: upErr } = await supabase
    .from("mega_customers")
    .update({
      mg_credits: after,
      mg_expires_at: nextExpiry,
      mg_last_active: ts,
      mg_updated_at: ts,
    })
    .eq("mg_pass_id", pid);

  if (upErr) {
    if (hasRef) {
      try {
        await supabase
          .from("mega_generations")
          .update({
            mg_status: "error",
            mg_error: safeString(upErr.message || upErr, "CREDITS_UPDATE_FAILED"),
            mg_updated_at: nowIso(),
          })
          .eq("mg_id", txId);
      } catch {}
    }
    throw upErr;
  }

  if (hasRef) {
    const { error: finErr } = await supabase
      .from("mega_generations")
      .update({
        mg_status: "succeeded",
        mg_meta: {
          credits_before: before,
          credits_after: after,
          expires_at: nextExpiry,
        },
        mg_updated_at: nowIso(),
      })
      .eq("mg_id", txId);

    if (finErr) throw finErr;
  } else {
    const { error: insErr } = await supabase.from("mega_generations").insert({
      mg_id: txId,
      mg_record_type: "credit_transaction",
      mg_pass_id: pid,
      mg_delta: Math.trunc(d),
      mg_reason: safeString(reason, null),
      mg_source: safeString(source, null),
      mg_ref_type: null,
      mg_ref_id: null,
      mg_status: "succeeded",
      mg_meta: {
        credits_before: before,
        credits_after: after,
        expires_at: nextExpiry,
      },
      mg_payload: null,
      mg_event_at: eventAt,
      mg_created_at: ts,
      mg_updated_at: ts,
    });

    if (insErr) throw insErr;
  }

  return { creditsBefore: before, creditsAfter: after, expiresAt: nextExpiry, alreadyApplied: false };
}
