// ./server/mma/mma-utils.js
// Backward-compatible re-exports for MMA helpers

export { computePassId } from "./mma-pass.js";
export { makeInitialVars, appendScanLine, makePlaceholderUrl } from "./mma-vars.js";
export { nowIso } from "./mma-time.js";
export { generationIdentifiers, stepIdentifiers, eventIdentifiers, newUuid } from "./mma-ids.js";
