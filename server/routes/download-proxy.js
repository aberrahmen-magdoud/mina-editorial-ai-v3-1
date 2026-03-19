// server/routes/download-proxy.js — /public/download
"use strict";

import express from "express";

const router = express.Router();

router.get("/public/download", async (req, res) => {
  const url = String(req.query.url || "").trim();
  if (!url) return res.status(400).json({ error: "Missing url param" });

  try {
    const upstream = await fetch(url, { redirect: "follow" });
    if (!upstream.ok) return res.status(upstream.status).json({ error: `Upstream ${upstream.status}` });

    const ct = upstream.headers.get("content-type") || "application/octet-stream";
    const cl = upstream.headers.get("content-length");

    res.setHeader("Content-Type", ct);
    res.setHeader("Access-Control-Allow-Origin", "*");
    if (cl) res.setHeader("Content-Length", cl);

    // Build download filename from query param or URL path
    const rawName = String(req.query.filename || "").trim();
    const fallbackName = decodeURIComponent(new URL(url).pathname.split("/").pop() || "download");
    const dlName = (rawName || fallbackName).replace(/[\r\n"]/g, "_");
    res.setHeader("Content-Disposition", `attachment; filename="${dlName}"`);

    const buf = Buffer.from(await upstream.arrayBuffer());
    res.end(buf);
  } catch (err) {
    console.error("[download-proxy]", err?.message || err);
    res.status(502).json({ error: "Failed to fetch upstream" });
  }
});

export default router;
