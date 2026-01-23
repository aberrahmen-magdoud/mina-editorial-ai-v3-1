import OpenAI from "openai";

import { asHttpUrl, parseJsonMaybe, safeArray, safeStr } from "./mma-shared.js";

let _openai = null;
function getOpenAI() {
  if (_openai) return _openai;
  if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY_MISSING");
  _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return _openai;
}

function buildResponsesUserContent({ text, imageUrls }) {
  const parts = [];
  const t = safeStr(text, "");
  if (t) parts.push({ type: "input_text", text: t });

  for (const u of safeArray(imageUrls)) {
    const url = asHttpUrl(u);
    if (!url) continue;
    parts.push({ type: "input_image", image_url: url });
  }
  return parts;
}

function buildResponsesUserContentLabeled({ introText, labeledImages }) {
  const parts = [];
  const t = safeStr(introText, "");
  if (t) parts.push({ type: "input_text", text: t });

  for (const item of safeArray(labeledImages)) {
    const role = safeStr(item?.role, "");
    const url = asHttpUrl(item?.url);
    if (!url) continue;

    if (role) parts.push({ type: "input_text", text: `IMAGE ROLE: ${role}` });
    parts.push({ type: "input_image", image_url: url });
  }

  return parts;
}

function buildChatCompletionsContentLabeled({ introText, labeledImages }) {
  const content = [];
  const t = safeStr(introText, "");
  if (t) content.push({ type: "text", text: t });

  for (const item of safeArray(labeledImages)) {
    const role = safeStr(item?.role, "");
    const url = asHttpUrl(item?.url);
    if (!url) continue;

    if (role) content.push({ type: "text", text: `IMAGE ROLE: ${role}` });
    content.push({ type: "image_url", image_url: { url } });
  }

  return content;
}

function extractResponsesText(resp) {
  if (resp && typeof resp.output_text === "string") return resp.output_text;
  const out = resp?.output;
  if (!Array.isArray(out)) return "";
  let text = "";
  for (const item of out) {
    if (item?.type === "message" && Array.isArray(item?.content)) {
      for (const c of item.content) {
        if (c?.type === "output_text" && typeof c?.text === "string") text += c.text;
      }
    }
  }
  return text || "";
}

async function openaiJsonVisionLabeled({ model, system, introText, labeledImages }) {
  const openai = getOpenAI();

  try {
    if (openai.responses?.create) {
      const input = [
        { role: "system", content: system },
        { role: "user", content: buildResponsesUserContentLabeled({ introText, labeledImages }) },
      ];

      const resp = await openai.responses.create({
        model,
        input,
        text: { format: { type: "json_object" } },
      });

      const raw = extractResponsesText(resp);
      const parsed = parseJsonMaybe(raw);

      return { request: { model, input, text: { format: { type: "json_object" } } }, raw, parsed };
    }
  } catch {}

  const messages = [
    { role: "system", content: system },
    { role: "user", content: buildChatCompletionsContentLabeled({ introText, labeledImages }) },
  ];

  const resp = await getOpenAI().chat.completions.create({
    model,
    messages,
    response_format: { type: "json_object" },
  });

  const raw = resp?.choices?.[0]?.message?.content || "";
  const parsed = parseJsonMaybe(raw);

  return { request: { model, messages, response_format: { type: "json_object" } }, raw, parsed };
}

async function openaiJsonVision({ model, system, userText, imageUrls }) {
  const openai = getOpenAI();

  try {
    if (openai.responses?.create) {
      const input = [
        { role: "system", content: system },
        { role: "user", content: buildResponsesUserContent({ text: userText, imageUrls }) },
      ];

      const resp = await openai.responses.create({
        model,
        input,
        text: { format: { type: "json_object" } },
      });

      const raw = extractResponsesText(resp);
      const parsed = parseJsonMaybe(raw);

      return { request: { model, input, text: { format: { type: "json_object" } } }, raw, parsed };
    }
  } catch {}

  const messages = [
    { role: "system", content: system },
    {
      role: "user",
      content: [
        { type: "text", text: safeStr(userText, "") },
        ...safeArray(imageUrls)
          .map(asHttpUrl)
          .filter(Boolean)
          .map((url) => ({ type: "image_url", image_url: { url } })),
      ],
    },
  ];

  const resp = await openai.chat.completions.create({
    model,
    messages,
    response_format: { type: "json_object" },
  });

  const raw = resp?.choices?.[0]?.message?.content || "";
  const parsed = parseJsonMaybe(raw);

  return { request: { model, messages, response_format: { type: "json_object" } }, raw, parsed };
}

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

  const motion_prompt = safeStr(out?.parsed?.motion_prompt, "") || safeStr(out?.parsed?.prompt, "");
  return { motion_prompt, raw: out.raw, request: out.request, parsed_ok: !!out.parsed };
}

export async function gptMotionOneShotTweak({ cfg, ctx, input, labeledImages }) {
  const out = await openaiJsonVisionLabeled({
    model: cfg.gptModel,
    system: ctx.motion_tweak_one_shot,
    introText: JSON.stringify(input, null, 2).slice(0, 14000),
    labeledImages: safeArray(labeledImages).slice(0, 6),
  });

  const motion_prompt = safeStr(out?.parsed?.motion_prompt, "") || safeStr(out?.parsed?.prompt, "");
  return { motion_prompt, raw: out.raw, request: out.request, parsed_ok: !!out.parsed };
}

export { openaiJsonVision };
