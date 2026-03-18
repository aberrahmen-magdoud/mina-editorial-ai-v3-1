// server/mma/mma-controller.js — Thin barrel re-exporting from focused modules
// Original ~4800 lines split into:
//   mma-ui-text.js    – user-facing status text + pool helpers
//   mma-clients.js    – OpenAI & Replicate singleton factories
//   mma-helpers.js    – shared utilities (safeStr, asHttpUrl, pickFirstUrl, …)
//   mma-openai.js     – OpenAI vision/JSON helpers
//   mma-gpt-steps.js  – GPT pipeline steps (still/motion one-shot)
//   mma-r2.js         – R2 storage for MMA content
//   mma-credits.js    – credit management (costs, charge, refund)
//   mma-db.js         – database operations (write/update generation rows)
//   mma-ctx-config.js – editable prompt templates (from mega_admin)
//   mma-seedream.js   – Seedream still-image runner
//   mma-nanobanana.js – NanoBanana still-image runner (Replicate + Gemini)
//   mma-kling.js      – Kling v3 HTTP video runner
//   mma-kling-omni.js – Kling Omni, Motion Control, Fabric Audio
//   mma-pipelines.js  – The 4 async pipelines
//   mma-handlers.js   – Public API handlers + Express router factory

export { toUserStatus, MMA_UI } from "./mma-ui-text.js";
export { getOpenAI, getReplicate } from "./mma-clients.js";
export {
  safeStr,
  asHttpUrl,
  safeArray,
  parseJsonMaybe,
  parseOptionalBool,
  normalizeUrlForKey,
  withKlingImageSizing,
  pushUserMessageLine,
  lastScanLine,
  pickFirstUrl,
  resolveFrame2Reference,
} from "./mma-helpers.js";
export {
  buildResponsesUserContent,
  buildResponsesUserContentLabeled,
  buildChatCompletionsContentLabeled,
  extractResponsesText,
  openaiJsonVision,
  openaiJsonVisionLabeled,
} from "./mma-openai.js";
export {
  gptStillOneShotCreate,
  gptStillOneShotTweak,
  gptMotionOneShotAnimate,
  gptMotionOneShotTweak,
} from "./mma-gpt-steps.js";
export { getR2, guessExt, storeRemoteToR2Public } from "./mma-r2.js";
export {
  MMA_COSTS,
  resolveVideoDurationSec,
  resolveVideoPricing,
  videoCostFromInputs,
  resolveStillLaneFromInputs,
  resolveStillLane,
  resolveStillEngine,
  normalizeStillResolutionValue,
  resolveAppliedStillResolution,
  stillResolutionMeta,
  stillCostForLane,
  getStillCost,
  buildInsufficientCreditsDetails,
  ensureEnoughCredits,
  chargeGeneration,
  refundOnFailure,
  preflightTypeForMe,
  commitTypeForMeSuccessAndMaybeCharge,
  readMmaPreferences,
  writeMmaPreferences,
  isSafetyBlockError,
} from "./mma-credits.js";
export {
  writeGeneration,
  writeStep,
  finalizeGeneration,
  updateVars,
  updateStatus,
  fetchParentGenerationRow,
  ensureCustomerRow,
  ensureSessionForHistory,
} from "./mma-db.js";
export { getMmaCtxConfig } from "./mma-ctx-config.js";
export { buildSeedreamImageInputs, runSeedream } from "./mma-seedream.js";
export {
  nanoBananaUseGemini,
  nanoBananaEnabled,
  mainGeminiModel,
  mainUsesGemini,
  buildNanoBananaImageInputs,
  runNanoBananaReplicate,
  runNanoBananaGemini,
  runNanoBanana,
} from "./mma-nanobanana.js";
export {
  getKlingHttpConfig,
  buildKlingJwt,
  normalizeKlingSourceMode,
  extractKlingTaskId,
  extractKlingTaskStatus,
  extractKlingTaskStatusMsg,
  klingResultHasVideo,
  extractKlingVideoUrl,
  sleepMs,
  klingRequestJson,
  submitAndPollKlingTask,
  pickKlingStartImage,
  pickKlingEndImage,
  runKling,
  KLING_DEFAULT_NEGATIVE_PROMPT,
} from "./mma-kling.js";
export {
  runFabricAudio,
  runKlingMotionControl,
  runKlingOmni,
} from "./mma-kling-omni.js";
export {
  runStillCreatePipeline,
  runStillTweakPipeline,
  runVideoAnimatePipeline,
  runVideoTweakPipeline,
} from "./mma-pipelines.js";
export {
  handleMmaCreate,
  handleMmaStillTweak,
  handleMmaVideoTweak,
  handleMmaEvent,
  refreshFromReplicate,
  fetchGeneration,
  listSteps,
  listErrors,
  registerSseClient,
  createMmaController,
} from "./mma-handlers.js";

export { createMmaController as default } from "./mma-handlers.js";
