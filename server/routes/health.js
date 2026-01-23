import { sbEnabled } from "../../supabase.js";
import { nowIso } from "../utils/time.js";

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
}
