"use strict";

import { getSupabaseAdmin, sbEnabled } from "./supabase.js";
import { nowIso } from "./utils.js";

export function registerPublicStats(app) {
  app.get("/public/stats/total-users", async (_req, res) => {
    try {
      if (!sbEnabled()) return res.status(200).json({ ok: true, totalUsers: 0, degraded: true });

      const supabase = getSupabaseAdmin();
      const { count, error } = await supabase
        .from("mega_customers")
        .select("mg_pass_id", { count: "exact", head: true });

      if (error) throw error;

      return res.status(200).json({ ok: true, totalUsers: count ?? 0, source: "mega_customers" });
    } catch (e) {
      console.error("GET /public/stats/total-users failed", e);
      return res.status(200).json({ ok: true, totalUsers: 0, degraded: true });
    }
  });
}

export function registerHealthRoute(app, { isProd = false } = {}) {
  app.get("/health", (_req, res) => {
    res.json({
      ok: true,
      service: "Mina MMA API (MMA+MEGA)",
      time: nowIso(),
      supabase: sbEnabled(),
      env: isProd ? "production" : "development",
    });
  });

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true });
  });
}
