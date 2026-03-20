// server/mma/mma-ugc-planner.js — GPT shot planner for UGC multi-clip pipeline
"use strict";

import { openaiJsonVisionLabeled } from "./mma-openai.js";
import { safeStr, safeArray } from "./mma-helpers.js";

// ============================================================================
// UGC Shot Planner System Prompt
// ============================================================================
const UGC_PLANNER_SYSTEM = [
  "You are a UGC video director and shot planner. Given a creative brief, break it into a shot-by-shot sequence for a social media video.",
  "",
  "RULES:",
  "- Each shot is 5–10 seconds (Kling AI max per clip is 10s).",
  "- Total shots should fill the target duration (e.g. 60s → 6–8 shots).",
  "- Style: raw, handheld, iPhone-aesthetic, natural lighting, UGC-native.",
  "- Camera angles: selfie, POV, over-shoulder, close-up, mid-shot. Vary them shot-to-shot.",
  "- First shot = hook (attention-grabbing, 3–5s). Last shot = CTA or product hero close-up.",
  "- If a product image is provided, integrate the product naturally (unboxing, applying, showing, holding).",
  "- Keep visual identity consistent across shots: same subject descriptors, same environment, same lighting.",
  "- Each shot must describe: scene/environment, subject action, camera movement, mood.",
  "- Transitions between shots should feel natural for UGC (jump cuts, swipe cuts).",
  "- Write prompts that are production-ready for an AI video generator (Kling).",
  "- Do NOT use emojis, markdown, or meta commentary.",
  "",
  "OUTPUT FORMAT:",
  'Return STRICT JSON only (no markdown):',
  '{',
  '  "shots": [',
  '    { "shot_no": 1, "duration": 8, "prompt": "...", "camera": "selfie|pov|handheld|close-up|mid-shot|wide", "transition": "cut|jump-cut|swipe" },',
  '    ...',
  '  ],',
  '  "total_duration": <sum of all shot durations>,',
  '  "negative_prompt": "morphing, distorted hands, extra fingers, flickering, cartoonish, low resolution, polished cinematic look",',
  '  "audio_direction": "<brief audio/music suggestion>"',
  '}',
].join("\n");

// ============================================================================
// planUgcShots — call GPT to break a brief into N shot prompts
// ============================================================================
export async function planUgcShots({ cfg, brief, targetDuration, shotCount, labeledImages }) {
  const userText = [
    `BRIEF: ${safeStr(brief, "Create a UGC video")}`,
    `TARGET DURATION: ${targetDuration || 60} seconds`,
    shotCount ? `NUMBER OF SHOTS: ${shotCount}` : "NUMBER OF SHOTS: auto (fill the target duration, 5-10s per shot)",
  ].join("\n");

  const model = cfg?.gptModel || "gpt-4o-mini";

  const out = await openaiJsonVisionLabeled({
    model,
    system: UGC_PLANNER_SYSTEM,
    introText: userText,
    labeledImages: safeArray(labeledImages).slice(0, 6),
  });

  const parsed = out?.parsed || {};

  // Validate and normalize shots
  const rawShots = safeArray(parsed.shots);
  const shots = rawShots
    .filter((s) => s && typeof s === "object" && safeStr(s.prompt, ""))
    .map((s, i) => ({
      shot_no: Number(s.shot_no) || i + 1,
      duration: Math.max(3, Math.min(10, Number(s.duration) || 8)),
      prompt: safeStr(s.prompt, ""),
      camera: safeStr(s.camera, "handheld"),
      transition: safeStr(s.transition, "cut"),
    }));

  if (!shots.length) {
    throw new Error("UGC_PLANNER_NO_SHOTS");
  }

  return {
    shots,
    total_duration: shots.reduce((sum, s) => sum + s.duration, 0),
    negative_prompt: safeStr(parsed.negative_prompt, "morphing, distorted hands, extra fingers, flickering, cartoonish, low resolution"),
    audio_direction: safeStr(parsed.audio_direction, ""),
    raw: out.raw,
    request: out.request,
    parsed_ok: !!out.parsed,
  };
}
