# Mina Editorial AI — Backend

Express.js + Node.js backend powering Mina's AI generation pipelines, credit billing, asset storage, and admin tooling. All state persists to **Supabase Postgres** (`mega_*` tables). Permanent assets stored on **Cloudflare R2**.

---

## Directory Structure

```
├── index.js                  # Thin entry point → server/index.js
├── server.js                 # Express app setup, middleware, route registration
├── auth.js                   # Admin auth middleware (bearer tokens, Supabase, allowlist)
├── mega-db.js                # Customer/credit/session persistence helpers
├── supabase.js               # Supabase admin client + audit logging functions
├── r2.js                     # Cloudflare R2 storage (upload, fetch, public URLs)
├── shopifyAdmin.js           # Shopify Admin REST API (customer lookup, tagging)
├── shopifySyncRoute.js       # POST /auth/shopify-sync — link Shopify ↔ MEGA
├── package.json
│
├── server/
│   ├── index.js              # R2 presign gateway (POST /api/r2/presign)
│   ├── app-config.js         # Runtime config loader from mega_admin table
│   ├── history-router.js     # GET /history — paginated generation history
│   │
│   ├── fingertips/           # Image editing tools (eraser, inpaint, upscale…)
│   │   ├── fingertips-config.js
│   │   ├── fingertips-controller.js
│   │   └── fingertips-router.js
│   │
│   ├── logging/              # Structured error logging to Supabase
│   │   ├── errorEmoji.js
│   │   ├── errorMiddleware.js
│   │   ├── logError.js
│   │   ├── normalizeError.js
│   │   └── supabaseAdmin.js
│   │
│   └── mma/                  # Mina Mind API — core generation engine
│       ├── mma-router.js
│       ├── mma-controller.js
│       ├── mma-config.js
│       ├── mma-handlers.js
│       ├── mma-pipelines.js
│       ├── mma-gpt-steps.js
│       ├── mma-openai.js
│       ├── mma-clients.js
│       ├── mma-helpers.js
│       ├── mma-db.js
│       ├── mma-credits.js
│       ├── mma-cost-calculator.js
│       ├── mma-ctx-config.js
│       ├── mma-r2.js
│       ├── mma-sse.js
│       ├── mma-utils.js
│       ├── mma-ui-text.js
│       ├── mma-seedream.js
│       ├── mma-nanobanana.js
│       ├── mma-kling.js
│       ├── mma-kling-omni.js
│       └── replicate-poll.js
│
├── src/
│   ├── megaCustomersLead.js
│   ├── supabase.js
│   ├── lib/
│   │   └── r2Upload.js
│   └── routes/
│       ├── admin/
│       │   └── mma-logadmin.js
│       └── mma/
│           └── mma-config.js
│
└── docs-mma/                 # Internal documentation
    ├── costs and third parties.md
    ├── kling3.md
    ├── LOCAL_CURL_FLOWS.md
    ├── MEGA_LOGS.md
    ├── MEGA_MMA.md
    ├── MINA_MIND_USER_JOURNEY.md
    └── MMA_SPEC.md
```

---

## Root Files

### `index.js`
Tiny entry point that imports `server/index.js` as a side effect — directs hosting platforms to the correct server module.

### `server.js`
Main Express orchestrator. Sets up middleware (CORS, JSON body parsing with 30 MB limit, error handling), registers all route routers (`/mma/*`, `/fingertips/*`, `/admin/*`, `/health`, `/checkout`, `/download-proxy`, `/auth/shopify-sync`), configures process-level crash handlers for unhandled rejections and uncaught exceptions, and listens on a configurable port.

### `auth.js`
Admin authentication middleware. Verifies bearer tokens from headers or query params against `ADMIN_SECRET`, `ADMIN_DASHBOARD_KEY`, or Supabase auth tokens. Validates an admin email allowlist and logs all access attempts for audit.  
**Exports:** `tryAdmin(req, opts)` → `{ok, status, email, userId}`

### `mega-db.js`
MEGA-only persistence helpers for customer / credit / session management. Ensures customer rows exist, resolves Pass IDs, manages credit balance + ledger, upserts metadata, and links Shopify customers.  
**Exports:** `resolvePassId()`, `megaEnsureCustomer()`, `megaGetCredits()`, `megaAdjustCredits()`, `touchCustomer()`, `readMmaPreferences()`, `writeMmaPreferences()`

### `supabase.js`
Supabase admin client factory plus audit logging helpers. Singleton client (no session persistence). Writes to `mega_admin` table for debugging and compliance.  
**Exports:** `getSupabaseAdmin()`, `sbEnabled()`, `logAdminAction()`, `upsertProfileRow()`, `upsertSessionRow()`, `stableSessionHash()`

### `r2.js`
Cloudflare R2 (S3-compatible) storage helper for permanent public URLs. Handles buffer uploads, remote image fetching + storage, key generation with safe naming, and immutable 1-year cache headers.  
**Exports:** `publicUrlForKey()`, `isOurAssetUrl()`, `makeKey()`, `putBufferToR2()`, `storeRemoteImageToR2()`

### `shopifyAdmin.js`
Shopify Admin REST API client for customer lookup and tagging. Finds customers by email and adds tags (e.g. `Mina_users`) for segmentation.  
**Exports:** `shopifyConfigured()`, `shopifyAdminFetch()`, `findCustomerByEmail()`, `addCustomerTag()`, `findAndTagCustomerByEmail()`

### `shopifySyncRoute.js`
Express route handler (`POST /auth/shopify-sync`) that synchronises Shopify customer data with MEGA. Finds customer by email, tags them, links Shopify ID to Pass ID, and ensures the MEGA row exists. Gracefully degrades if Shopify or Supabase is unavailable.  
**Exports:** `registerShopifySync(app)`

---

## `server/` — Core Server Modules

### `server/index.js`
R2 presign gateway. Normalises upload "kind" variants, validates content types, and returns presigned PUT URLs plus permanent `publicUrl`. Supports ~11 canonical kinds (product, logo, inspiration, style, generation, etc.) with aliasing for legacy frontend names.  
**Endpoints:** `POST /api/r2/presign` → `{key, putUrl, publicUrl}`, `GET /api/health`

### `server/app-config.js`
Runtime app config loader from the Supabase `mega_admin` table. Queries by key, selects the highest-version enabled row, and caches with a 5 s TTL.  
**Exports:** `getActiveAppConfig()`, `parseVersionFromId()`

### `server/history-router.js`
Express router for the MEGA history API (reads from `mega_generations`). Resolves Pass IDs from headers / body / auth tokens, paginates results, and sanitises MMA vars (strips sensitive provider data).  
**Endpoints:** `GET /history` — paginated generation list with credits balance

---

## `server/fingertips/` — Image Editing Tools

### `fingertips-config.js`
Model catalogue for the Fingertips feature. Defines 6 models (eraser, flux_fill, expand, remove_bg, upscale, vectorise) with fractional matcha costs (0.1–0.5 per generation).  
**Exports:** `FINGERTIPS_MODELS`, `getFingertipsModel()`, `getFingertipsCost()`

### `fingertips-controller.js`
Controller handling fractional matcha billing (pool system), Replicate model calls, GPT vision for image analysis, and CUDA OOM fallback. Manages per-user "fingertips pool" deducting whole matchas and drawing fractional costs.  
**Exports:** `handleFingertipsGenerate()`, `fetchFingertipsGeneration()`, `getPoolStatus()`, `listFingertipsModels()`

### `fingertips-router.js`
Express router for Fingertips API.  
**Endpoints:** `POST /fingertips/generate`, `GET /fingertips/generations/:id`, `GET /fingertips/pool`, `GET /fingertips/models`

---

## `server/logging/` — Structured Error Logging

### `errorEmoji.js`
Maps error status/action/source to emoji codes for log readability (🔥 5xx, 🚫 401, ⏱️ timeout, 🛰️ provider, etc.).  
**Exports:** `emojiForContext()`, `formatErrorCode()`

### `errorMiddleware.js`
Express error middleware. Catches unhandled route errors, normalises them, logs to Supabase, and returns a generic 500 to the client.  
**Exports:** `errorMiddleware(err, req, res, next)`

### `logError.js`
Centralized error logger to `mega_admin`. Truncates large fields, formats error codes with emoji, and persists structured context (status, route, method, user, IP, user agent).  
**Exports:** `logError(input)` → UUID of the inserted record

### `normalizeError.js`
Normalises error objects (or strings) into `{name, message, stack}`.  
**Exports:** `normalizeError(err)`

### `supabaseAdmin.js`
Supabase admin client singleton for logging (isolated from root `supabase.js` to avoid circular deps).  
**Exports:** `supabaseAdmin`

---

## `server/mma/` — Mina Mind API (Core Generation Engine)

The MMA subsystem handles still image and video generation with GPT-orchestrated prompt building, AI provider calls, credit billing, and real-time streaming.

### `mma-router.js`
Express router for all MMA endpoints.  
**Endpoints:**
| Method | Path | Purpose |
|--------|------|---------|
| POST | `/mma/still/create` | Start still generation |
| POST | `/mma/still/:id/tweak` | Provide feedback on a still |
| POST | `/mma/video/animate` | Start video generation |
| POST | `/mma/video/:id/tweak` | Provide motion feedback |
| POST | `/mma/events` | Log client events |
| POST | `/mma/:id/refresh` | Refresh a generation |
| GET | `/mma/:id` | Fetch generation result |
| GET | `/mma/:id/stream` | SSE event stream |
| GET | `/mma/:id/steps` | Pipeline step log |
| GET | `/mma/:id/errors` | Generation errors |
| GET | `/mma/models` | Available model list |

### `mma-controller.js`
Thin barrel file that re-exports all MMA submodules (14+ files). Acts as the single public import for MMA features.

### `mma-config.js`
Centralized config from environment variables. Parses booleans / numbers / URL lists with fallbacks. Configures provider defaults (SeaDream size, Kling model/mode, GPT model, negative prompts) and style hero URL maps.  
**Exports:** `getMmaConfig()`

### `mma-handlers.js`
Public API handlers for Express route callbacks. Houses the final request → response logic for all MMA endpoints.

### `mma-pipelines.js`
Orchestrates the 4 async generation pipelines: still create, still tweak, video animate, video tweak. Imports all AI engine modules and sequences the scan → GPT → provider → store → respond flow.

### `mma-gpt-steps.js`
GPT vision pipeline steps for one-shot still and motion creation/tweaking. Builds structured prompts from user uploads and context, calls OpenAI vision, and parses structured JSON responses.  
**Exports:** `gptStillOneShotCreate()`, `gptStillOneShotTweak()`, `gptMotionOneShotAnimate()`

### `mma-openai.js`
OpenAI helpers using the Responses API (or Chat Completions fallback). Builds vision content blocks with labelled images, parses JSON, and handles retry/fallback.  
**Exports:** `buildResponsesUserContent()`, `openaiJsonVisionLabeled()`

### `mma-clients.js`
Singleton factories for OpenAI and Replicate API clients.  
**Exports:** `getOpenAI()`, `getReplicate()`

### `mma-helpers.js`
Utility functions for safe string / array / URL handling and JSON parsing.  
**Exports:** `safeStr()`, `asHttpUrl()`, `safeArray()`, `parseJsonMaybe()`

### `mma-db.js`
Database operations for storing and updating MMA generations, steps, and metadata in `mega_generations`.  
**Exports:** `writeGeneration()` and various write helpers

### `mma-credits.js`
Credit management — defines matcha costs per generation type, charges credits, issues refunds, and reads/writes user preferences.  
**Exports:** `MMA_COSTS`, credit charge/refund functions

### `mma-cost-calculator.js`
Real USD cost estimation for all generation types. Tables for Kling video (multi-mode/duration), SeaDream stills, Gemini/NanoBanana, GPT calls, and Fingertips tools. Includes fixed monthly overhead amortisation.  
**Exports:** `estimateGenerationCost()`, `estimateSeedreamCost()`, `estimateKlingCost()`, `estimateGeminiImageCost()`, `estimateGptCallCost()`, `estimateFingertipsCost()`

### `mma-ctx-config.js`
Manages editable prompt templates and system instructions from the `mega_admin` table.  
**Exports:** `getMmaCtxConfig()`

### `mma-r2.js`
Cloudflare R2 integration for storing generated content (images, videos) with permanent public URLs.  
**Exports:** `getR2()`, `guessExt()`, `storeRemoteToR2Public()`

### `mma-sse.js`
In-memory Server-Sent Events hub. Manages per-generation subscriber sets, stores scan lines with auto-incrementing indexes, replays history on client connect, and broadcasts status / done events. Cleans up when the last client disconnects.  
**Exports:** `addSseClient()`, `sendSseEvent()`, `sendScanLine()`, `sendStatus()`, `sendDone()`

### `mma-utils.js`
Pass ID computation, variable canonicalisation, and user preference mapping. Generates deterministic Pass IDs, normalises frontend asset URL aliases, and builds the canonical MMA vars object.  
**Exports:** `computePassId()`, `makeInitialVars()`

### `mma-ui-text.js`
All user-facing status messages and randomised pools for UI feedback during generation.  
**Exports:** `MMA_UI`, `KLING_DEFAULT_NEGATIVE_PROMPT`

### `mma-seedream.js`
SeaDream still-image generator via Replicate with hardcoded timeouts.  
**Exports:** `buildSeedreamImageInputs()`, `runSeedream()`

### `mma-nanobanana.js`
NanoBanana still-image generator via Replicate or Gemini with timeouts.  
**Exports:** `nanoBananaEnabled()`, `buildNanoBananaImageInputs()`, `runNanoBanana()`

### `mma-kling.js`
Kling v3 HTTP video generator with JWT auth, polling, and image preprocessing.  
**Exports:** `getKlingHttpConfig()`, `klingRequestJson()`, `extractKlingTaskStatus()`

### `mma-kling-omni.js`
Kling Omni (O3), Motion Control, and Fabric Audio (lip-sync) runners.  
**Exports:** `runFabricAudio()`, `runKlingOmni()`, `runKlingMotionControl()`

### `replicate-poll.js`
Replicate prediction polling with hard timeouts (default 4 min) and exponential backoff. Includes cancel-on-timeout and last-chance fetch.  
**Exports:** `replicatePredictWithTimeout()`

---

## `src/` — Shared / Legacy Helpers

### `src/megaCustomersLead.js`
Safe customer lead upsert to Supabase. Retries without Shopify column if the field doesn't exist (backward compat).  
**Exports:** `upsertMegaCustomerLead()`

### `src/supabase.js`
Re-export barrel for `getSupabaseAdmin()`.

### `src/lib/r2Upload.js`
Browser-facing R2 upload helpers. Presigns via `/api/r2/presign`, executes PUT, and returns the permanent `publicUrl`. Supports XHR progress tracking.  
**Exports:** `presignR2Upload()`, `uploadFileToR2()`, `putWithProgress()`

### `src/routes/admin/mma-logadmin.js`
Admin dashboard for MMA logs. Login flow (cookie-based HMAC-SHA256 tokens), generation gallery with inline lightbox, per-generation step/error drill-down, real-time error stream, and bulk email resolution. Renders styled HTML.  
**Endpoints:** `GET /admin/mma/login`, `POST /admin/mma/login`, `GET /admin/mma`, `GET /api/admin/mma/logs`, `GET /api/admin/mma/generations`, `GET /api/admin/mma/generations/:id`

### `src/routes/mma/mma-config.js`
Re-export barrel for `getMmaConfig()`.

---

## `docs-mma/` — Internal Documentation

| File | Topic |
|------|-------|
| `costs and third parties.md` | Third-party service costs (R2, Render, Supabase, OpenAI, Replicate, Shopify) with pricing tables |
| `kling3.md` | Kling AI Series 3.0 video/image model specs, pricing, endpoints, capabilities |
| `LOCAL_CURL_FLOWS.md` | Local testing guide with curl examples for all MMA endpoints |
| `MEGA_LOGS.md` | Logging contract — ops log vs run log, emoji legend, error payload schema |
| `MEGA_MMA.md` | Supabase schema for MEGA tables (customers, generations, admin) |
| `MINA_MIND_USER_JOURNEY.md` | Plain-English user journey with Mermaid flowchart |
| `MMA_SPEC.md` | MMA spec — entity definitions, naming conventions, variable map |

---

## Key Architecture Patterns

- **Pass ID** as stable customer identity across anonymous, Shopify, and Supabase users
- **Namespaced `mg_id`** prevents collisions across record types in the ledger
- **SSE streaming** for real-time generation progress to the frontend
- **Fractional matcha billing** — Fingertips pool deducts whole matchas, draws fractional costs per tool
- **Provider cost estimation** for USD cost tracking per generation
- **Graceful degradation** when Shopify, Supabase, or AI providers are unavailable
- **Emoji-coded structured logging** to `mega_admin` for operational visibility
