import { resolveFrame2Reference, safeStr } from "./mma-shared.js";
import { nowIso } from "./mma-utils.js";

export const MMA_COSTS = {
  still_main: 1,
  still_niche: 2,
  video: 10,
  typeForMePer: 10,
  typeForMeCharge: 1,
};

function _clamp(n, a, b) {
  const x = Number(n || 0) || 0;
  return Math.max(a, Math.min(b, x));
}

function _ceilTo5(n) {
  const x = Number(n || 0) || 0;
  return Math.ceil(x / 5) * 5;
}

export function resolveVideoDurationSec(inputs) {
  const d = Number(inputs?.duration ?? inputs?.duration_seconds ?? inputs?.durationSeconds ?? 5) || 5;
  return d >= 10 ? 10 : 5;
}

export function resolveVideoPricing(inputsLike, assetsLike) {
  const frame2 = resolveFrame2Reference(inputsLike, assetsLike);
  if (frame2.kind === "ref_video") return { flow: "kling_motion_control" };
  if (frame2.kind === "ref_audio") return { flow: "fabric_audio" };
  return { flow: "kling" };
}

export function videoCostFromInputs(inputsLike, assetsLike) {
  const inputs = inputsLike && typeof inputsLike === "object" ? inputsLike : {};
  const frame2 = resolveFrame2Reference(inputs, assetsLike);

  if (frame2.kind === "ref_video" || frame2.kind === "ref_audio") {
    const maxSec = frame2.maxSec || (frame2.kind === "ref_audio" ? 60 : 30);

    const rawProvided =
      Number(frame2.rawDurationSec || 0) ||
      Number(inputs.frame2_duration_sec || inputs.frame2DurationSec || 0) ||
      Number(inputs.duration || inputs.duration_seconds || inputs.durationSeconds || 0) ||
      Number(inputs.duration_sec || inputs.durationSec || 0) ||
      0;

    const fallback = resolveVideoDurationSec(inputs);
    const raw = rawProvided || fallback;

    const clamped = _clamp(raw, 1, maxSec);
    const billed = _clamp(_ceilTo5(clamped), 5, maxSec);
    return billed;
  }

  const sec = resolveVideoDurationSec(inputs);
  return sec === 10 ? 10 : 5;
}

export function resolveStillLaneFromInputs(inputsLike) {
  const inputs = inputsLike && typeof inputsLike === "object" ? inputsLike : {};
  const raw = safeStr(
    inputs.still_lane ||
      inputs.stillLane ||
      inputs.model_lane ||
      inputs.modelLane ||
      inputs.lane ||
      inputs.create_lane ||
      inputs.createLane,
    "main"
  ).toLowerCase();
  return raw === "niche" ? "niche" : "main";
}

export function resolveStillLane(vars) {
  const inputs = vars?.inputs && typeof vars.inputs === "object" ? vars.inputs : {};
  return resolveStillLaneFromInputs(inputs);
}

export function stillCostForLane(lane) {
  return lane === "niche" ? MMA_COSTS.still_niche : MMA_COSTS.still_main;
}

export function buildInsufficientCreditsDetails({ balance, needed, lane }) {
  const bal = Number(balance || 0);
  const need = Number(needed || 0);
  const requestedLane = lane === "niche" ? "niche" : lane === "main" ? "main" : null;

  const canSwitchToMain = requestedLane === "niche" && bal >= MMA_COSTS.still_main;

  let userMessage = "";
  if (requestedLane === "niche") {
    userMessage =
      `you've got ${bal} matcha left. this mode needs ${need}. ` +
      (canSwitchToMain ? "top up or switch to main?" : "top up to keep going.");
  } else {
    userMessage = `you've got ${bal} matcha left. you need ${need}. top up to keep going.`;
  }

  const actions = [{ id: "buy_matcha", label: "Buy matcha", enabled: true }];

  if (requestedLane === "niche") {
    actions.push({
      id: "switch_to_main",
      label: `Switch to main (${MMA_COSTS.still_main} matcha)`,
      enabled: canSwitchToMain,
      patch: { inputs: { still_lane: "main" } },
    });
  }

  return {
    userMessage,
    balance: bal,
    needed: need,
    lane: requestedLane,
    costs: { still_main: MMA_COSTS.still_main, still_niche: MMA_COSTS.still_niche, video: need },
    canSwitchToMain,
    actions,
  };
}

export function getStillCost(varsOrInputs) {
  const v =
    varsOrInputs && typeof varsOrInputs === "object" && varsOrInputs.inputs
      ? varsOrInputs
      : { inputs: varsOrInputs && typeof varsOrInputs === "object" ? varsOrInputs : {} };

  return stillCostForLane(resolveStillLane(v));
}

export function utcDayKey() {
  return nowIso().slice(0, 10);
}
