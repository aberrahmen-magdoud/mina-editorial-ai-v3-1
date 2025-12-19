# MEGA_LOGS.md — MEGA-only Logging + MMA Debug Contract

**Date:** 2025-12-19 (Asia/Dubai)  
**Goal:** Make every crash / provider error / timeout / bad GPT output **queryable in Supabase**, and make every MMA run **reproducible** (which ctx_version + settings_version + step failed).  
**MEGA-only constraint:** use existing tables:
- `MEGA_ADMIN` for the **global error stream**
- `MEGA_GENERATIONS` for **per-generation MMA step errors + full step payloads**

---

## 1) What is a “log” in MEGA?
We distinguish **two log planes**:

### A) Ops log plane (global)
**Purpose:** “What is broken right now?” (alerts, dashboards, error feed)  
**Storage:** `MEGA_ADMIN` rows with `mg_record_type='error'` (optionally also `'warn'`)

### B) Run log plane (per generation)
**Purpose:** “What exactly happened in this MMA job?” (audit + replay + debugging)  
**Storage:** `MEGA_GENERATIONS` rows with `mg_record_type='mma_step'` (and the generation row itself)

✅ **Rule:** Every MMA error must appear in **both** planes:
- one row in `MEGA_ADMIN` (ops view)
- one `mma_step` row (run view) + update generation `mg_mma_status='error'`

---

## 2) Emoji logging legend (category tag)
Emoji is a **category label**, not the full log.

| Emoji | Meaning | Example `error_code` |
|---|---|---|
| 🔥 | Backend 5xx / server crash in request handling | `🔥 API_ERROR` |
| 🖥️ | Frontend crash reported to backend (`/api/log-error`) | `🖥️ FRONTEND_CRASH` |
| 🚫 | Auth/permission issue (401/403) | `🚫 AUTH_ERROR` |
| ⚠️ | Validation / 4xx / handled error (non-5xx) | `⚠️ VALIDATION_ERROR` |
| ⏱️ | Timeout (408/504 or known timeout) | `⏱️ TIMEOUT` |
| 🛰️ | External provider error (OpenAI/Stripe/Shopify/Seedream/Kling/network) | `🛰️ PROVIDER_ERROR` |
| 🧵 | Unhandled promise rejection (process-level) | `🧵 UNHANDLED_REJECTION` |
| 💥 | Uncaught exception (process-level) | `💥 UNCAUGHT_EXCEPTION` |
| 🎛️ | Config/template error (bad ctx_*, bad preset merge) | `🎛️ CONFIG_ERROR` |
| 🧠 | GPT output schema/format error (missing keys / invalid JSON) | `🧠 GPT_SCHEMA_ERROR` |

✅ Keep emoji legend. Just ensure logs include **structured context** below.

---

## 3) Where logs are stored (exact tables + columns)

### 3.1 Ops error stream (MEGA_ADMIN)
**Table:** `MEGA_ADMIN`  
**Row selector:** `mg_record_type = 'error'` (and optionally `'warn'`)  
**Primary key rule (recommended):**
- `mg_id = "error:<ulid>"` (or `"error:<request_id>:<n>"`)

**Required columns used:**
- `mg_id` (TEXT, PK)
- `mg_record_type` = `'error'` or `'warn'`
- `mg_created_at` (timestamp)
- `mg_updated_at` (timestamp)
- `mg_actor_pass_id` (store the affected user pass id when known)
- `mg_route`, `mg_method`, `mg_status` (HTTP info when applicable)
- `mg_detail` (JSONB) = **the canonical log payload**

> If you already have columns like `mg_error_code`, `mg_error_message`, keep them. Otherwise put them in `mg_detail`.

#### Canonical `mg_detail` JSON (must-have keys)
```json
{
  "emoji": "🛰️",
  "level": "error",
  "category": "PROVIDER_ERROR",
  "error_code": "MMA_SEEDREAM_TIMEOUT",
  "message": "Seedream request timed out",
  "request_id": "req_abc123",
  "trace_id": "trace_...optional...",
  "pass_id": "pass:user:...",
  "generation_id": "gen_...optional...",
  "step_type": "seedream_generate_optional",
  "provider": "seedream_optional",
  "model": "seedream-vX_optional",
  "ctx": { "key": "mma.ctx.gpt_reader", "version": 4, "id": "app_config:mma.ctx.gpt_reader.v4" },
  "settings": { "key": "mma.provider.seedream.defaults", "version": 3, "id": "app_config:mma.provider.seedream.defaults.v3" },
  "http": { "route": "/mma/still/create", "status": 504 },
  "provider_http_status": 504,
  "retry": { "attempt": 1, "max": 2 },
  "stack": "only_on_backend_or_redacted"
}
```

### 3.2 MMA run audit + errors (MEGA_GENERATIONS)
**Table:** `MEGA_GENERATIONS`  
**Run selector:** `mg_record_type='mma_step' AND mg_generation_id='<generation_id>'`  
**Generation selector:** `mg_id='generation:<generation_id>'`

**Required columns:**
- `mg_record_type='mma_step'`
- `mg_generation_id`
- `mg_step_no`
- `mg_step_type`
- `mg_payload` (JSONB)
- `mg_provider`, `mg_model` (if provider call)
- `mg_latency_ms` (if provider call)
- `mg_mma_mode`, `mg_mma_status` (optional on steps; required on generation row)

#### Canonical `mg_payload` per `mma_step` (must-have keys)
```json
{
  "input": { "...": "..." },
  "output": { "...": "..." },
  "timing": { "started_at": "ISO", "ended_at": "ISO", "duration_ms": 1234 },
  "error": null
}
```

#### For GPT steps, you MUST persist ctx version used
Example (gpt_reader step):
```json
{
  "input": {
    "ctx_key": "mma.ctx.gpt_reader",
    "ctx_version": 4,
    "ctx_id": "app_config:mma.ctx.gpt_reader.v4",
    "input_gpt_reader": "..."
  },
  "output": { "clean_prompt": "..." },
  "error": null
}
```

#### For provider steps, you MUST persist resolved settings used
Example (seedream_generate step):
```json
{
  "input": {
    "prompt": "...",
    "settings_key": "mma.provider.seedream.defaults",
    "settings_version": 3,
    "settings_id": "app_config:mma.provider.seedream.defaults.v3",
    "settings_resolved": { "quality": "high", "aspect_ratio": "1:1" }
  },
  "output": { "output_url": "https://r2/...." },
  "error": { "error_code": "MMA_SEEDREAM_TIMEOUT", "message": "...", "provider_http_status": 504 }
}
```

---

## 4) MMA error handling contract (what to write when something fails)
When an MMA job fails at step `X`:

### 4.1 Update generation row
`MEGA_GENERATIONS` generation row (`mg_id='generation:<id>'`):
- `mg_mma_status='error'`
- `mg_status='failed'`
- `mg_error='<short safe message>'` (UI-safe)
- keep partial `mg_mma_vars` (so frontend can replay scan lines)

### 4.2 Write the failing step row
`MEGA_GENERATIONS` `mma_step` row:
- `mg_step_type = X`
- `mg_payload.error` populated with structured details

### 4.3 Write ops error stream row
`MEGA_ADMIN` error row:
- `mg_record_type='error'`
- `mg_detail` includes `generation_id`, `step_type`, `provider`, `ctx_version`, `settings_version`

✅ This guarantees: **ops visibility + deterministic replay**.

---

## 5) Insert examples (copy-paste SQL)

### 5.1 Insert an ops error row (MEGA_ADMIN)
```sql
insert into public.mega_admin (
  mg_id, mg_record_type, mg_actor_pass_id,
  mg_route, mg_method, mg_status,
  mg_detail, mg_created_at, mg_updated_at
) values (
  'error:' || gen_random_uuid()::text,
  'error',
  $1,              -- pass_id
  $2,              -- route
  $3,              -- method
  $4,              -- http status
  $5::jsonb,       -- mg_detail
  now(),
  now()
);
```

### 5.2 Mark generation as failed (MEGA_GENERATIONS)
```sql
update public.mega_generations
set
  mg_status = 'failed',
  mg_mma_status = 'error',
  mg_error = $2,
  mg_updated_at = now()
where mg_id = 'generation:' || $1;
-- $1 generation_id, $2 short message
```

---

## 6) Query recipes (Supabase)

### 6.1 Latest errors (ops feed)
```sql
select
  mg_created_at,
  mg_detail->>'error_code' as error_code,
  mg_detail->>'message' as message,
  mg_detail->>'generation_id' as generation_id,
  mg_detail->>'step_type' as step_type
from public.mega_admin
where mg_record_type='error'
order by mg_created_at desc
limit 200;
```

### 6.2 Errors for one generation (ops plane)
```sql
select mg_created_at, mg_detail
from public.mega_admin
where mg_record_type='error'
  and mg_detail->>'generation_id' = $1
order by mg_created_at asc;
```

### 6.3 Full MMA step timeline for one generation (run plane)
```sql
select mg_step_no, mg_step_type, mg_created_at, mg_payload
from public.mega_generations
where mg_record_type='mma_step'
  and mg_generation_id = $1
order by mg_step_no asc;
```

### 6.4 Find “which ctx version was used” (gpt_reader)
```sql
select
  mg_payload #>> '{input,ctx_key}' as ctx_key,
  mg_payload #>> '{input,ctx_version}' as ctx_version,
  mg_payload #>> '{input,ctx_id}' as ctx_id
from public.mega_generations
where mg_record_type='mma_step'
  and mg_generation_id = $1
  and mg_step_type = 'gpt_reader'
order by mg_step_no desc
limit 1;
```

### 6.5 Find “which settings version was used” (seedream_generate)
```sql
select
  mg_payload #>> '{input,settings_key}' as settings_key,
  mg_payload #>> '{input,settings_version}' as settings_version,
  mg_payload #>  '{input,settings_resolved}' as settings_resolved
from public.mega_generations
where mg_record_type='mma_step'
  and mg_generation_id = $1
  and mg_step_type = 'seedream_generate'
order by mg_step_no desc
limit 1;
```

### 6.6 Error counts by category (last 24h)
```sql
select
  mg_detail->>'category' as category,
  count(*) as cnt
from public.mega_admin
where mg_record_type='error'
  and mg_created_at >= now() - interval '24 hours'
group by 1
order by cnt desc;
```

---

## 7) Indexes (recommended for performance)
If your error volume grows, add expression indexes for the JSON keys you filter on most.

### 7.1 MEGA_ADMIN
```sql
create index if not exists mega_admin_record_type_created_at
  on public.mega_admin (mg_record_type, mg_created_at desc);

create index if not exists mega_admin_error_generation_id
  on public.mega_admin ((mg_detail->>'generation_id'));

create index if not exists mega_admin_error_step_type
  on public.mega_admin ((mg_detail->>'step_type'));
```

### 7.2 MEGA_GENERATIONS (MMA steps)
```sql
create index if not exists mega_generations_mma_steps_lookup
  on public.mega_generations (mg_generation_id, mg_record_type, mg_step_no);

create index if not exists mega_generations_mma_step_type_lookup
  on public.mega_generations (mg_generation_id, mg_step_type);
```

---

## 8) Frontend crash logging (🖥️)
If frontend reports crashes to backend (`/api/log-error`):
- Write **MEGA_ADMIN** row with emoji `🖥️`, category `FRONTEND_CRASH`
- Include:
  - `client_version`, `route`, `user_agent`, `device`, `stack`, `component`
  - if known: `pass_id`, `generation_id`

**Never** store secrets/tokens in logs.

---

## 9) MMA-specific “enough logs?” checklist
Emoji legend is enough **only if** each error includes these fields:

**Always**
- `request_id`
- `pass_id` (when known)
- `route`, `http_status`
- `error_code`, `message`

**For MMA**
- `generation_id`
- `step_type`
- `provider`, `model` (if provider step)
- `ctx_key`, `ctx_version` (if GPT step)
- `settings_key`, `settings_version` (if provider step)

If any are missing, debugging becomes guesswork.

---

## 10) Minimal retention guidance
- Store **errors + warnings** in `MEGA_ADMIN` (not every info log).
- Store **all MMA steps** in `MEGA_GENERATIONS` (auditability requirement).

If cost becomes a problem, prune `MEGA_ADMIN` old rows first; keep MMA step logs longer.
