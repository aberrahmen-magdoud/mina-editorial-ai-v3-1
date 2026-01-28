# Mina Editorial AI API

Minimal backend for the Mina Editorial AI (MMA + MEGA) service. This repo is now intentionally small: one entry point and a single `lib/` folder that holds all server logic.

## How it runs
- `server.js` starts the Express API and wires all routes.
- `npm start` runs `node server.js`.

## Files and folders

### Root
- `.gitignore` - git ignore rules.
- `package.json` - project metadata, scripts, and dependencies.
- `package-lock.json` - locked dependency tree.
- `server.js` - main Express app and process-level error handlers.
- `README.md` - this file.

### lib/
All runtime code lives here.

- `lib/utils.js` - shared helpers (safe strings, timestamps) plus CORS and body parser setup.
- `lib/supabase.js` - Supabase admin client, feature gating, and admin audit helpers.
- `lib/logging.js` - error normalization, error logging to Supabase, and Express error middleware.
- `lib/auth.js` - auth token parsing and admin guard.
- `lib/mega.js` - MEGA customer/credits logic, passId helpers, sessions, feedback, and lead upsert.
- `lib/credits.js` - credits, session start, and feedback routes.
- `lib/history.js` - history APIs with passId normalization and MMA vars sanitization.
- `lib/public.js` - public stats and health endpoints.
- `lib/mma.js` - MMA pipelines (still + video), OpenAI and Replicate calls, SSE hub, MMA routes, and the admin log UI.
- `lib/shopify.js` - Shopify webhook + sync routes and credit merge utilities.
- `lib/r2.js` - R2 storage helpers, upload/presign routes, and optional browser upload helpers.
- `lib/admin.js` - admin APIs (summary + credit adjustments).

## Required services
Supabase and Shopify are required. R2 is required for media storage. OpenAI and Replicate are required for MMA generation.

## Environment overview (high level)
You will need credentials for:
- Supabase (service role key + URL)
- Shopify (webhooks / store access)
- R2 (Cloudflare R2 keys + bucket + public base URL)
- OpenAI and Replicate (model APIs)

See the code for exact variable names; all logic lives in `lib/`.
