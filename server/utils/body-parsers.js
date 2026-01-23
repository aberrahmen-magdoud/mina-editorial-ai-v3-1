import express from "express";

export function registerBodyParsers(app) {
  app.use(express.json({ limit: "25mb" }));
  app.use(express.urlencoded({ extended: true, limit: "25mb" }));
}
