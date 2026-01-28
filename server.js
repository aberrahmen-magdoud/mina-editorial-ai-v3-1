"use strict";

import "dotenv/config";
import express from "express";

import { normalizeError, logError, errorMiddleware } from "./lib/logging.js";
import { registerCors, registerBodyParsers } from "./lib/utils.js";
import { registerPublicStats, registerHealthRoute } from "./lib/public.js";
import { registerShopifyWebhook, registerShopifySync } from "./lib/shopify.js";
import { registerHistoryRoutes } from "./lib/history.js";
import { registerMmaRoutes } from "./lib/mma.js";
import { registerCreditsRoutes } from "./lib/credits.js";
import { registerR2Routes } from "./lib/r2.js";
import { registerAdminRoutes } from "./lib/admin.js";

const ENV = process.env;
const IS_PROD = ENV.NODE_ENV === "production";
const PORT = Number(ENV.PORT || 8080);

const app = express();
app.set("trust proxy", 1);

process.on("unhandledRejection", async (reason) => {
  const normalized = normalizeError(reason);
  try {
    await logError({
      action: "process.unhandledRejection",
      status: 500,
      message: normalized.message,
      stack: normalized.stack,
      emoji: "ðŸ§µ",
      code: "UNHANDLED_REJECTION",
    });
  } catch (err) {
    console.error("[process.unhandledRejection] failed to log", err);
  }
});

process.on("uncaughtException", async (err) => {
  const normalized = normalizeError(err);
  try {
    await logError({
      action: "process.uncaughtException",
      status: 500,
      message: normalized.message,
      stack: normalized.stack,
      emoji: "ðŸ’¥",
      code: "UNCAUGHT_EXCEPTION",
    });
  } catch (loggingError) {
    console.error("[process.uncaughtException] failed to log", loggingError);
  }
});

registerCors(app);
registerPublicStats(app);
registerShopifyWebhook(app);
registerBodyParsers(app);
registerHistoryRoutes(app);
registerMmaRoutes(app);
registerHealthRoute(app, { isProd: IS_PROD });
registerShopifySync(app);
registerCreditsRoutes(app);
registerR2Routes(app);
registerAdminRoutes(app);

app.use(errorMiddleware);

app.listen(PORT, () => {
  console.log(`Mina MMA API (MMA+MEGA) listening on port ${PORT}`);
});
