import { sendScanLine, sendStatus } from "./mma-sse.js";
import { mixedPool, pickAvoid } from "./mma-ui.js";
import { safeStr } from "./mma-shared.js";
import { updateVars } from "./mma-db.js";

export function pushUserMessageLine(vars, text) {
  const t = safeStr(text, "");
  if (!t) return vars;

  const next = { ...(vars || {}) };
  next.userMessages = { ...(next.userMessages || {}) };

  const prev = Array.isArray(next.userMessages.scan_lines) ? next.userMessages.scan_lines : [];
  const index = prev.length;

  next.userMessages.scan_lines = [...prev, { text: t, index }];
  return next;
}

export function lastScanLine(vars, fallbackText = "") {
  const lines = vars?.userMessages?.scan_lines;
  const last = Array.isArray(lines) ? lines[lines.length - 1] : null;
  if (last) return last;
  return { text: fallbackText, index: Array.isArray(lines) ? lines.length : 0 };
}

export function emitStatus(generationId, internalStatus) {
  sendStatus(generationId, String(internalStatus || ""));
}

export function emitLine(generationId, vars, fallbackText = "") {
  const line = lastScanLine(vars, fallbackText);
  sendScanLine(generationId, line);
}

export function startMinaChatter({
  supabase,
  generationId,
  getVars,
  setVars,
  stage = "generating",
  intervalMs = 2600,
}) {
  let stopped = false;

  const tick = async () => {
    if (stopped) return;
    try {
      let v = getVars();
      const avoid = (lastScanLine(getVars?.() || v || {}, "") || {}).text || "";
      const line = pickAvoid(mixedPool(stage), avoid, "");
      if (!line) return;

      v = pushUserMessageLine(v, line);
      setVars(v);

      await updateVars({ supabase, generationId, vars: v });
      emitLine(generationId, v);
    } catch {
      // ignore chatter errors
    }
  };

  void tick();

  const id = setInterval(() => {
    void tick();
  }, Math.max(800, Number(intervalMs) || 2600));

  return {
    stop() {
      stopped = true;
      clearInterval(id);
    },
  };
}
