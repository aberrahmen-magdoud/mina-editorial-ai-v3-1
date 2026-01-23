// ./server/mma/mma-controller.js
import express from "express";

import { resolvePassId as megaResolvePassId } from "../../mega-db.js";
import { getSupabaseAdmin } from "../../supabase.js";

import { sendDone, sendStatus } from "./mma-sse.js";
import {
  fetchGeneration,
  handleMmaCreate,
  handleMmaEvent,
  handleMmaStillTweak,
  handleMmaVideoTweak,
  listErrors,
  listSteps,
  registerSseClient,
} from "./mma-handlers.js";

export {
  fetchGeneration,
  handleMmaCreate,
  handleMmaEvent,
  handleMmaStillTweak,
  handleMmaVideoTweak,
  listErrors,
  listSteps,
  refreshFromReplicate,
  registerSseClient,
} from "./mma-handlers.js";

// ============================================================================
// Router factory (optional; you may also use ./mma-router.js)
// IMPORTANT: inject passId from request so it matches router behavior
// ============================================================================
export function createMmaController() {
  const router = express.Router();

  const injectPassId = (req, raw) => {
    const body = raw && typeof raw === "object" ? raw : {};
    const passId = megaResolvePassId(req, body);
    return { passId, body: { ...body, passId } };
  };

  router.post("/still/create", async (req, res) => {
    try {
      const { passId, body } = injectPassId(req, req.body);
      res.set("X-Mina-Pass-Id", passId);
      const result = await handleMmaCreate({ mode: "still", body });
      res.json(result);
    } catch (err) {
      console.error("[mma] still/create error", err);
      res.status(err?.statusCode || 500).json({ error: "MMA_CREATE_FAILED", message: err?.message });
    }
  });

  router.post("/still/:generation_id/tweak", async (req, res) => {
    try {
      const { passId, body } = injectPassId(req, req.body || {});
      res.set("X-Mina-Pass-Id", passId);
      const result = await handleMmaStillTweak({
        parentGenerationId: req.params.generation_id,
        body,
      });
      res.json(result);
    } catch (err) {
      console.error("[mma] still tweak error", err);
      res.status(err?.statusCode || 500).json({ error: "MMA_TWEAK_FAILED", message: err?.message });
    }
  });

  router.post("/video/animate", async (req, res) => {
    try {
      const { passId, body } = injectPassId(req, req.body);
      res.set("X-Mina-Pass-Id", passId);
      const result = await handleMmaCreate({ mode: "video", body });
      res.json(result);
    } catch (err) {
      console.error("[mma] video/animate error", err);
      res.status(err?.statusCode || 500).json({ error: "MMA_ANIMATE_FAILED", message: err?.message });
    }
  });

  router.post("/video/:generation_id/tweak", async (req, res) => {
    try {
      const { passId, body } = injectPassId(req, req.body || {});
      res.set("X-Mina-Pass-Id", passId);
      const result = await handleMmaVideoTweak({
        parentGenerationId: req.params.generation_id,
        body,
      });
      res.json(result);
    } catch (err) {
      console.error("[mma] video tweak error", err);
      res.status(err?.statusCode || 500).json({ error: "MMA_VIDEO_TWEAK_FAILED", message: err?.message });
    }
  });

  router.post("/events", async (req, res) => {
    try {
      const { passId, body } = injectPassId(req, req.body || {});
      res.set("X-Mina-Pass-Id", passId);
      const result = await handleMmaEvent(body || {});
      res.json(result);
    } catch (err) {
      console.error("[mma] events error", err);
      res.status(500).json({ error: "MMA_EVENT_FAILED", message: err?.message });
    }
  });

  router.get("/generations/:generation_id", async (req, res) => {
    try {
      const payload = await fetchGeneration(req.params.generation_id);
      if (!payload) return res.status(404).json({ error: "NOT_FOUND" });
      res.json(payload);
    } catch (err) {
      console.error("[mma] fetch generation error", err);
      res.status(500).json({ error: "MMA_FETCH_FAILED", message: err?.message });
    }
  });

  router.get("/stream/:generation_id", async (req, res) => {
    const supabase = getSupabaseAdmin();
    if (!supabase) return res.status(500).end();

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      Connection: "keep-alive",
      "Cache-Control": "no-cache",
    });
    res.flushHeaders?.();

    const { data } = await supabase
      .from("mega_generations")
      .select("mg_mma_vars, mg_mma_status")
      .eq("mg_generation_id", req.params.generation_id)
      .eq("mg_record_type", "generation")
      .maybeSingle();

    const scanLines = data?.mg_mma_vars?.userMessages?.scan_lines || [];
    const internal = String(data?.mg_mma_status || "queued");
    const statusText = internal;

    // âœ… Register client first so sendStatus/sendDone hit THIS connection too
    registerSseClient(req.params.generation_id, res, { scanLines, status: statusText });

    // âœ… If it's already finished (done/error/suggested), immediately emit DONE then close
    const TERMINAL = new Set(["done", "error", "suggested"]);
    if (TERMINAL.has(internal)) {
      try {
        // sendStatus uses your existing SSE format
        sendStatus(req.params.generation_id, statusText);
        // sendDone is what your frontend should listen to to stop "Creating..."
        sendDone(req.params.generation_id, statusText);
      } catch {}
      try {
        res.end();
      } catch {}
      return;
    }

    // Normal keepalive for running generations only
    const keepAlive = setInterval(() => {
      try {
        res.write(`:keepalive\n\n`);
      } catch {}
    }, 25000);

    res.on("close", () => clearInterval(keepAlive));
  });

  router.get("/admin/mma/errors", async (_req, res) => {
    try {
      const errors = await listErrors();
      res.json({ errors });
    } catch (err) {
      res.status(500).json({ error: "MMA_ADMIN_ERRORS", message: err?.message });
    }
  });

  router.get("/admin/mma/steps/:generation_id", async (req, res) => {
    try {
      const steps = await listSteps(req.params.generation_id);
      res.json({ steps });
    } catch (err) {
      res.status(500).json({ error: "MMA_ADMIN_STEPS", message: err?.message });
    }
  });

  return router;
}

export default createMmaController;


