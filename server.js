// =======================
// PART 1 – Imports & setup
// =======================
import express from "express";
import cors from "cors";
import Replicate from "replicate";
import OpenAI from "openai";
import { v4 as uuidv4 } from "uuid";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: "10mb" }));

// Replicate (SeaDream + Kling)
const replicate = new Replicate({
  auth: process.env.REPLICATE_API_TOKEN,
});

// OpenAI (GPT brain for Mina)
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Models (can override via env if needed)
const SEADREAM_MODEL =
  process.env.SEADREAM_MODEL_VERSION || "bytedance/seedream-4";
const KLING_MODEL =
  process.env.KLING_MODEL_VERSION || "kwaivgi/kling-v2.1";

// In-memory style memory per customer
// key = customerId (string)
// value = [{ prompt, platform, createdAt }]
const styleMemory = new Map();
const MAX_MEMORY_PER_CUSTOMER = 10;

// ---------------- Helpers ----------------
function safeString(value, fallback = "") {
  if (value === null || value === undefined) return fallback;
  if (typeof value !== "string") return String(value);
  const trimmed = value.trim();
  return trimmed.length ? trimmed : fallback;
}

function rememberStyle(customerId, entry) {
  if (!customerId) return;
  const key = String(customerId);
  const existing = styleMemory.get(key) || [];
  existing.push(entry);
  // keep last N
  if (existing.length > MAX_MEMORY_PER_CUSTOMER) {
    const excess = existing.length - MAX_MEMORY_PER_CUSTOMER;
    existing.splice(0, excess);
  }
  styleMemory.set(key, existing);
}

function getStyleHistory(customerId) {
  if (!customerId) return [];
  return styleMemory.get(String(customerId)) || [];
}

// Health check
app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "Mina Editorial AI API",
    time: new Date().toISOString(),
  });
});

// =======================
// PART 2 – GPT helpers
// =======================

async function runChatWithFallback({ systemMessage, userMessage, fallbackPrompt }) {
  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4.1-mini",
      messages: [systemMessage, userMessage],
      temperature: 0.8,
      max_tokens: 280,
    });

    const prompt = completion.choices?.[0]?.message?.content?.trim();
    if (!prompt) throw new Error("Empty GPT response");

    return { prompt, usedFallback: false, gptError: null };
  } catch (err) {
    console.error("OpenAI error, falling back:", err?.status, err?.message);
    return {
      prompt: fallbackPrompt,
      usedFallback: true,
      gptError: {
        status: err?.status || null,
        message: err?.message || String(err),
      },
    };
  }
}

// Build Mina's SeaDream prompt (image), with style memory
async function buildEditorialPrompt(payload) {
  const {
    productImageUrl,
    styleImageUrls = [],
    brief,
    tone,
    platform = "tiktok",
    mode = "image",
    styleHistory = [],
  } = payload;

  const fallbackPrompt = [
    safeString(
      brief,
      "Editorial still-life product photo of the hero product on a simple surface."
    ),
    tone ? `Tone: ${tone}.` : "",
    `Shot for ${platform}, clean composition, professional lighting.`,
    "Hero product in focus, refined minimal background, fashion/editorial style.",
  ]
    .join(" ")
    .trim();

  const historyText = styleHistory.length
    ? styleHistory
        .map(
          (item, idx) =>
            `${idx + 1}) [${item.platform}] ${item.prompt || ""}`
        )
        .join("\n")
    : "none yet – this might be their first request.";

  const systemMessage = {
    role: "system",
    content:
      "You are Mina, an editorial art director for fashion & beauty. " +
      "You write ONE clear prompt for a generative image model. " +
      "The model only understands English descriptions, not URLs. " +
      "Describe subject, environment, lighting, camera, mood, and style. " +
      "Do NOT include line breaks, lists, or bullet points. One paragraph max.",
  };

  const userMessage = {
    role: "user",
    content: `
You are creating a new ${mode} for Mina.

Current request brief:
${safeString(brief, "No extra brand context provided.")}

Tone / mood: ${safeString(tone, "not specified")}
Target platform: ${platform}

Product image URL (reference only, do NOT mention URL in the prompt):
${safeString(productImageUrl, "none")}

Style reference image URLs (reference only, do NOT mention URLs in prompt):
${(styleImageUrls || []).join(", ") || "none"}

Recent successful prompts this customer used (respect this style when possible):
${historyText}

Write the final prompt I should send to the image model.
`.trim(),
  };

  return runChatWithFallback({
    systemMessage,
    userMessage,
    fallbackPrompt,
  });
}

// Build Mina's Kling prompt (motion), with style memory
async function buildMotionPrompt(options) {
  const {
    motionBrief,
    tone,
    platform = "tiktok",
    lastImageUrl,
    styleHistory = [],
  } = options;

  const fallbackPrompt = [
    motionBrief ||
      "Short looping editorial motion of the product with a subtle camera move and gentle light changes.",
    tone ? `Tone: ${tone}.` : "",
    `Optimised for ${platform} vertical content.`,
  ]
    .join(" ")
    .trim();

  const historyText = styleHistory.length
    ? styleHistory
        .map(
          (item, idx) =>
            `${idx + 1}) [${item.platform}] ${item.prompt || ""}`
        )
        .join("\n")
    : "none";

  const systemMessage = {
    role: "system",
    content:
      "You are Mina, an editorial motion director for fashion & beauty. " +
      "You describe a SHORT looping product motion for a generative video model like Kling. " +
      "Keep it 1–2 sentences, no line breaks.",
  };

  const userMessage = {
    role: "user",
    content: `
Static reference frame URL (for you only, don't spell it out in the prompt):
${safeString(lastImageUrl, "none")}

Desired motion description from the user:
${safeString(
  motionBrief,
  "subtle elegant camera move with a small motion in the scene."
)}

Tone / feeling: ${safeString(tone, "not specified")}
Target platform: ${platform}

Recent still-image prompts this customer used (keep motion in same aesthetic family):
${historyText}

Write the final video generation prompt.
`.trim(),
  };

  return runChatWithFallback({
    systemMessage,
    userMessage,
    fallbackPrompt,
  });
}

// =======================
// PART 3 – API routes
// =======================

// ---- Mina Editorial (image) ----
app.post("/editorial/generate", async (req, res) => {
  const requestId = `req_${Date.now()}_${uuidv4()}`;

  try {
    const body = req.body || {};
    const productImageUrl = safeString(body.productImageUrl);
    const styleImageUrls = Array.isArray(body.styleImageUrls)
      ? body.styleImageUrls
      : [];
    const brief = safeString(body.brief);
    const tone = safeString(body.tone);
    const platform = safeString(body.platform || "tiktok").toLowerCase();
    const customerId =
      body.customerId !== null && body.customerId !== undefined
        ? String(body.customerId)
        : "anonymous";

    if (!productImageUrl && !brief) {
      return res.status(400).json({
        ok: false,
        error: "MISSING_INPUT",
        message:
          "Provide at least productImageUrl or brief so Mina knows what to create.",
        requestId,
      });
    }

    const styleHistory = getStyleHistory(customerId);

    const promptResult = await buildEditorialPrompt({
      productImageUrl,
      styleImageUrls,
      brief,
      tone,
      platform,
      mode: "image",
      styleHistory,
    });

    const prompt = promptResult.prompt;

    // Map platform to aspect ratio
    let aspectRatio = "4:5";
    if (platform.includes("tiktok") || platform.includes("reel")) {
      aspectRatio = "9:16";
    } else if (platform.includes("youtube")) {
      aspectRatio = "16:9";
    }

    const input = {
      prompt,
      image_input: productImageUrl
        ? [productImageUrl, ...styleImageUrls]
        : styleImageUrls,
      max_images: body.maxImages || 1,
      size: "2K",
      aspect_ratio: aspectRatio,
      enhance_prompt: true,
      sequential_image_generation: "disabled",
    };

    const output = await replicate.run(SEADREAM_MODEL, { input });

    // Normalise SeaDream output to list of URLs
    let imageUrls = [];
    if (Array.isArray(output)) {
      imageUrls = output
        .map((item) => {
          if (typeof item === "string") return item;
          if (item && typeof item === "object") {
            return item.url || item.image || null;
          }
          return null;
        })
        .filter(Boolean);
    } else if (typeof output === "string") {
      imageUrls = [output];
    } else if (output && typeof output === "object") {
      if (typeof output.url === "string") imageUrls = [output.url];
      else if (Array.isArray(output.output)) {
        imageUrls = output.output.filter((v) => typeof v === "string");
      }
    }

    // Remember customer style for next runs
    if (imageUrls.length && customerId) {
      rememberStyle(customerId, {
        prompt,
        platform,
        createdAt: new Date().toISOString(),
      });
    }

    res.json({
      ok: true,
      message: "Mina Editorial image generated via SeaDream.",
      requestId,
      prompt,
      imageUrl: imageUrls[0] || null,
      imageUrls,
      rawOutput: output,
      payload: body,
      gpt: {
        usedFallback: promptResult.usedFallback,
        error: promptResult.gptError,
      },
    });
  } catch (err) {
    console.error("Error in /editorial/generate:", err);
    res.status(500).json({
      ok: false,
      error: "EDITORIAL_GENERATION_ERROR",
      message: err?.message || "Unexpected error during image generation.",
      requestId,
    });
  }
});

// ---- Mina Motion (video) ----
app.post("/motion/generate", async (req, res) => {
  const requestId = `req_${Date.now()}_${uuidv4()}`;

  try {
    const body = req.body || {};
    const lastImageUrl = safeString(body.lastImageUrl);
    const motionDescription = safeString(body.motionDescription);
    const tone = safeString(body.tone);
    const platform = safeString(body.platform || "tiktok").toLowerCase();
    const customerId =
      body.customerId !== null && body.customerId !== undefined
        ? String(body.customerId)
        : "anonymous";

    if (!lastImageUrl) {
      return res.status(400).json({
        ok: false,
        error: "MISSING_LAST_IMAGE",
        message: "lastImageUrl is required to create motion.",
        requestId,
      });
    }

    if (!motionDescription) {
      return res.status(400).json({
        ok: false,
        error: "MISSING_MOTION_DESCRIPTION",
        message: "Describe how Mina should move the scene.",
        requestId,
      });
    }

    const styleHistory = getStyleHistory(customerId);

    const motionResult = await buildMotionPrompt({
      motionBrief: motionDescription,
      tone,
      platform,
      lastImageUrl,
      styleHistory,
    });

    const prompt = motionResult.prompt;

    const durationSeconds = Number(body.durationSeconds || 5);

    const input = {
      mode: "standard",
      prompt,
      duration: durationSeconds,
      start_image: lastImageUrl,
      negative_prompt: "",
    };

    const output = await replicate.run(KLING_MODEL, { input });

    // Normalise Kling output to a single video URL
    let videoUrl = null;
    if (typeof output === "string") {
      videoUrl = output;
    } else if (Array.isArray(output) && output.length > 0) {
      const first = output[0];
      if (typeof first === "string") {
        videoUrl = first;
      } else if (first && typeof first === "object") {
        if (typeof first.url === "string") videoUrl = first.url;
        else if (typeof first.video === "string") videoUrl = first.video;
      }
    } else if (output && typeof output === "object") {
      if (typeof output.url === "string") videoUrl = output.url;
      else if (typeof output.video === "string") videoUrl = output.video;
      else if (Array.isArray(output.output) && output.output.length > 0) {
        if (typeof output.output[0] === "string") {
          videoUrl = output.output[0];
        }
      }
    }

    res.json({
      ok: true,
      message: "Mina Motion video generated via Kling.",
      requestId,
      prompt,
      videoUrl,
      rawOutput: output,
      payload: {
        lastImageUrl,
        motionDescription,
        tone,
        platform,
        durationSeconds,
        customerId,
      },
      gpt: {
        usedFallback: motionResult.usedFallback,
        error: motionResult.gptError,
      },
    });
  } catch (err) {
    console.error("Error in /motion/generate:", err);
    res.status(500).json({
      ok: false,
      error: "MOTION_GENERATION_ERROR",
      message: err?.message || "Unexpected error during motion generation.",
      requestId,
    });
  }
});

// =======================
// Start server
// =======================
app.listen(PORT, () => {
  console.log(`Mina Editorial AI API listening on port ${PORT}`);
});
