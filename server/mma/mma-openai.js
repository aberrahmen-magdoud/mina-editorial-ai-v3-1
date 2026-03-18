// server/mma/mma-openai.js — OpenAI vision/JSON helpers (Responses API preferred, Chat Completions fallback)
"use strict";

import { getOpenAI } from "./mma-clients.js";
import { safeStr, asHttpUrl, safeArray, parseJsonMaybe } from "./mma-helpers.js";

// ============================================================================
// Content builders
// ============================================================================

export function buildResponsesUserContent({ text, imageUrls }) {
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

export function buildResponsesUserContentLabeled({ introText, labeledImages }) {
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

export function buildChatCompletionsContentLabeled({ introText, labeledImages }) {
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

// ============================================================================
// Response text extractor
// ============================================================================

export function extractResponsesText(resp) {
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

// ============================================================================
// High-level callers
// ============================================================================

export async function openaiJsonVision({ model, system, userText, imageUrls }) {
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

export async function openaiJsonVisionLabeled({ model, system, introText, labeledImages }) {
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
