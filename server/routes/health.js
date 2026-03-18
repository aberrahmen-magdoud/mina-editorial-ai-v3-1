// server/routes/health.js — health check endpoint
"use strict";

import express from "express";
import { sbEnabled } from "../../supabase.js";
import { nowIso } from "../helpers.js";

const router = express.Router();
const IS_PROD = process.env.NODE_ENV === "production";

router.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "Mina MMA API (MMA+MEGA)",
    time: nowIso(),
    supabase: sbEnabled(),
    env: IS_PROD ? "production" : "development",
  });
});

export default router;
