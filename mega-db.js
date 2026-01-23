import { resolvePassId } from "./server/mega/pass-id.js";
import { megaEnsureCustomer } from "./server/mega/customers.js";
import { megaAdjustCredits, megaGetCredits, megaHasCreditRef } from "./server/mega/credits.js";
import { megaWriteSession } from "./server/mega/sessions.js";
import { megaWriteFeedback } from "./server/mega/feedback.js";

export {
  resolvePassId,
  megaEnsureCustomer,
  megaAdjustCredits,
  megaGetCredits,
  megaHasCreditRef,
  megaWriteSession,
  megaWriteFeedback,
};

export default {
  resolvePassId,
  megaEnsureCustomer,
  megaGetCredits,
  megaAdjustCredits,
  megaHasCreditRef,
  megaWriteSession,
  megaWriteFeedback,
};
