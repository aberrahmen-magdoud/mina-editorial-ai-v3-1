// server/mma/mma-gpt-steps.js — GPT pipeline steps for still + motion one-shot
"use strict";

import { openaiJsonVisionLabeled } from "./mma-openai.js";
import { safeStr, safeArray } from "./mma-helpers.js";
import { getMmaConfig } from "./mma-config.js";

export async function gptStillOneShotCreate({ cfg, ctx, input, labeledImages }) {
  const out = await openaiJsonVisionLabeled({
    model: cfg.gptModel,
    system: ctx.still_one_shot,
    introText: JSON.stringify(input, null, 2).slice(0, 14000),
    labeledImages: safeArray(labeledImages).slice(0, 10),
  });

  const clean_prompt = safeStr(out?.parsed?.clean_prompt, "");
  const debug = out?.parsed?.debug && typeof out.parsed.debug === "object" ? out.parsed.debug : null;

  return { clean_prompt, debug, raw: out.raw, request: out.request, parsed_ok: !!out.parsed };
}

export async function gptStillOneShotTweak({ cfg, ctx, input, labeledImages }) {
  const out = await openaiJsonVisionLabeled({
    model: cfg.gptModel,
    system: ctx.still_tweak_one_shot,
    introText: JSON.stringify(input, null, 2).slice(0, 14000),
    labeledImages: safeArray(labeledImages).slice(0, 6),
  });

  const clean_prompt = safeStr(out?.parsed?.clean_prompt, "") || safeStr(out?.parsed?.prompt, "");
  return { clean_prompt, raw: out.raw, request: out.request, parsed_ok: !!out.parsed };
}

export async function gptMotionOneShotAnimate({ cfg, ctx, input, labeledImages }) {
  const out = await openaiJsonVisionLabeled({
    model: cfg.gptModel,
    system: ctx.motion_one_shot,
    introText: JSON.stringify(input, null, 2).slice(0, 14000),
    labeledImages: safeArray(labeledImages).slice(0, 6),
  });

  const p = out?.parsed || {};
  const motion_prompt = safeStr(p.video_prompt, "") || safeStr(p.motion_prompt, "") || safeStr(p.prompt, "");
  const negative_prompt = safeStr(p.negative_prompt, "");
  const duration = Number.isFinite(p.duration) ? p.duration : null;
  return { motion_prompt, negative_prompt, duration, raw: out.raw, request: out.request, parsed_ok: !!out.parsed };
}

export async function gptMotionOneShotTweak({ cfg, ctx, input, labeledImages }) {
  const out = await openaiJsonVisionLabeled({
    model: cfg.gptModel,
    system: ctx.motion_tweak_one_shot,
    introText: JSON.stringify(input, null, 2).slice(0, 14000),
    labeledImages: safeArray(labeledImages).slice(0, 6),
  });

  const p = out?.parsed || {};
  const motion_prompt = safeStr(p.video_prompt, "") || safeStr(p.motion_prompt, "") || safeStr(p.prompt, "");
  const negative_prompt = safeStr(p.negative_prompt, "");
  const duration = Number.isFinite(p.duration) ? p.duration : null;
  return { motion_prompt, negative_prompt, duration, raw: out.raw, request: out.request, parsed_ok: !!out.parsed };
}
