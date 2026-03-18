// server.js — Thin orchestrator. All logic lives in server/routes/ and server/middleware/.
"use strict";

import "dotenv/config";
import express from "express";
import cors from "cors";

import { normalizeError } from "./server/logging/normalizeError.js";
import { logError } from "./server/logging/logError.js";
import { errorMiddleware } from "./server/logging/errorMiddleware.js";

// Routers (each file owns one concern)
import mmaRouter from "./server/mma/mma-router.js";
import fingertipsRouter from "./server/fingertips/fingertips-router.js";
import mmaLogAdminRouter from "./src/routes/admin/mma-logadmin.js";
import historyRouter from "./server/history-router.js";

import healthRouter from "./server/routes/health.js";
import publicStatsRouter from "./server/routes/public-stats.js";
import shopifyWebhookRouter from "./server/routes/shopify-webhook.js";
import checkoutRouter from "./server/routes/checkout.js";
import downloadProxyRouter from "./server/routes/download-proxy.js";
import authSyncRouter from "./server/routes/auth-sync.js";
import welcomeMatchaRouter from "./server/routes/welcome-matcha.js";
import creditsRouter from "./server/routes/credits.js";
import r2UploadRouter from "./server/routes/r2-upload.js";
import adminRouter from "./server/routes/admin.js";

// Middleware
import { buildCorsMiddleware, exposePassIdHeader } from "./server/middleware/cors.js";
import { mmaPassIdMiddleware, fingertipsPassIdMiddleware } from "./server/middleware/passId.js";

// ======================================================
// App boot
// ======================================================
const PORT = Number(process.env.PORT || 8080);

const app = express();
app.set("trust proxy", 1);

// ======================================================
// Process-level crash logging
// ======================================================
process.on("unhandledRejection", async (reason) => {
  const normalized = normalizeError(reason);
  try {
    await logError({
      action: "process.unhandledRejection",
      status: 500,
      message: normalized.message,
      stack: normalized.stack,
      emoji: "🧵",
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
      emoji: "💥",
      code: "UNCAUGHT_EXCEPTION",
    });
  } catch (loggingError) {
    console.error("[process.uncaughtException] failed to log", loggingError);
  }
});

// ======================================================
// CORS
// ======================================================
const { corsOptions, corsMiddleware } = buildCorsMiddleware();
app.use(corsMiddleware);
app.options("*", cors(corsOptions));
app.use(exposePassIdHeader);

// ======================================================
// Routes that need RAW body (before express.json)
// ======================================================
app.use(shopifyWebhookRouter);

// ======================================================
// Body parsers
// ======================================================
app.use(express.json({ limit: "30mb" }));
app.use(express.urlencoded({ extended: true, limit: "30mb" }));

// ======================================================
// Public routes
// ======================================================
app.use(healthRouter);
app.use(publicStatsRouter);
app.use(downloadProxyRouter);
app.use(checkoutRouter);
app.use(authSyncRouter);
app.use(welcomeMatchaRouter);
app.use(creditsRouter);
app.use(r2UploadRouter);

// ======================================================
// History (after CORS + body parsers)
// ======================================================
app.use(historyRouter);

// ======================================================
// MMA API (with passId middleware)
// ======================================================
app.use("/mma", mmaPassIdMiddleware);
app.use("/mma", mmaRouter);
app.use("/admin/mma", mmaLogAdminRouter);

// ======================================================
// Fingertips API (with passId middleware)
// ======================================================
app.use("/fingertips", fingertipsPassIdMiddleware);
app.use("/fingertips", fingertipsRouter);

// ======================================================
// Admin API
// ======================================================
app.use(adminRouter);

// ======================================================
// Error middleware + listen
// ======================================================
app.use(errorMiddleware);

app.listen(PORT, () => {
  console.log(`Mina MMA API (MMA+MEGA) listening on port ${PORT}`);
});
