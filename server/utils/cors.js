import cors from "cors";

const DEFAULT_ALLOWLIST = [
  "https://mina.faltastudio.com",
  "https://mina-app-bvpn.onrender.com",
];

export function registerCors(app, env = process.env) {
  const envAllowlist = (env.CORS_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const allowlist = Array.from(new Set([...DEFAULT_ALLOWLIST, ...envAllowlist]));

  const corsOptions = {
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      if (allowlist.length === 0) return cb(null, false);
      return cb(null, allowlist.includes(origin));
    },
    credentials: false,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Mina-Pass-Id"],
    exposedHeaders: ["X-Mina-Pass-Id"],
    optionsSuccessStatus: 204,
  };

  app.use(cors(corsOptions));
  app.options("*", cors(corsOptions));
  app.use((_req, res, next) => {
    const existing = res.get("Access-Control-Expose-Headers");
    const headers = existing
      ? existing
          .split(",")
          .map((h) => h.trim())
          .filter(Boolean)
      : [];
    if (!headers.some((h) => h.toLowerCase() === "x-mina-pass-id")) headers.push("X-Mina-Pass-Id");
    res.set("Access-Control-Expose-Headers", headers.join(", "));
    next();
  });
}
