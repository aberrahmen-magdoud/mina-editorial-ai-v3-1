# Mina Mind API (MMA) — Frontend Integration + Variable Map
**Date:** 2025-12-19 (Asia/Dubai)  
**Goal:** MMA turns user images + likes + text into (1) friendly **userMessages** and (2) clean AI-specific **PROMPTs** (Seedream for stills, Kling for motion), with feedback loops that learn preferences (Pinterest-like).

---

## 0) Core idea in 1 sentence
MMA is a **pipeline** that **scans inputs**, **builds context**, **generates prompts**, **calls AI adapters**, **post-scans outputs**, and **stores every variable** for audit + personalization.

---

## 1) Entities
### 1.1 Customer
A user in your system.

### 1.2 Generation
One “job” that produces either:
- **Still generation** (Seedream output image)
- **Video generation** (Kling output video)

### 1.3 Asset
Any uploaded or generated media file:
- product image
- logo image
- inspiration images (1–4)
- style hero image (optional)
- still input image (for animate)
- generated still image
- generated video

---

## 2) Naming conventions (important)
These names appear in the DB + API responses + frontend logic.

- `*_id`: Storage reference (Supabase Storage path/id, CDN URL, or internal asset UUID).
- `*_crt`: GPT caption / interpretation of an image (“what is in this image”).
- `ctx_*`: Internal context strings used only inside GPT prompts (usually not shown to user).
- `input_*` / `output_*`: Payloads used for each pipeline stage.
- `userMessage_*`: Friendly lines shown to user while loading (streamed).

---

## 3) MMA pipeline overview
### 3.1 Still creation flow (Seedream)
1) **Upload assets** (optional): product/logo/inspiration/styleHero + user text (brief + style)
2) **GPTscanner** reads each uploaded image (if present) → emits captions + friendly scan lines
3) **Like history scan** (optional) builds style preferences string
4) **GPT reader** produces a **Clean Prompt** for Seedream
5) **Seedream generate** returns image
6) **Post-scan** of output image (still_crt / output_still_crt)
7) **Persist** everything (vars + step logs)

### 3.2 Still tweak flow (Seedream feedback loop)
1) User types `feedback_still`
2) **GPT feedback** takes (output image + still_crt + feedback) → emits tweaked prompt
3) **Seedream generate** again → new image
4) Post-scan + persist

### 3.3 Video creation flow (Kling)
1) User chooses a still to animate OR uploads an image
2) GPT scans still if not already scanned → still_crt + scan line(s)
3) User selects movement style + motion brief
4) If user clicked **“Type for me”**:
   - Motion suggestion GPT → simple motion prompt
5) Else:
   - GPT reader2 → motion prompt adapted to Kling
6) Kling generate → video
7) Persist + preferences update

### 3.4 Video tweak flow (Kling feedback loop)
1) User types `feedback_motion`
2) GPT feedback2 → feedbacked motion prompt
3) Kling generate again → new video
4) Persist

---

## 4) Canonical MMA variable map (what to store + return)
> Store this as a single JSON object per generation (recommended), plus step logs for audit.

```json
{
  "version": "2025-12-19",
  "mode": "still",
  "assets": {
    "product_image_id": null,
    "logo_image_id": null,
    "inspiration_image_ids": [],
    "style_hero_image_id": null,
    "input_still_image_id": null
  },
  "scans": {
    "product_crt": null,
    "logo_crt": null,
    "inspiration_crt": [],
    "still_crt": null,
    "output_still_crt": null
  },
  "history": {
    "vision_intelligence": true,
    "like_window": 5,
    "style_history_csv": "editorial still life, minimal, clean, no light flare"
  },
  "inputs": {
    "userBrief": "",
    "style": "",
    "motion_user_brief": "",
    "movement_style": ""
  },
  "prompts": {
    "clean_prompt": null,
    "motion_prompt": null,
    "motion_sugg_prompt": null
  },
  "feedback": {
    "still_feedback": null,
    "motion_feedback": null
  },
  "userMessages": {
    "scan_lines": [],
    "final_line": null
  },
  "settings": {
    "seedream": {},
    "kling": {}
  },
  "outputs": {
    "seedream_image_id": null,
    "kling_video_id": null
  }
}
```

---

## 5) Variable dictionary (what each variable means)
### 5.1 Image scanning (GPTscanner)
These exist only if the related image exists.

- `product_crt`: Caption/interpretation of **product_image** (e.g., “main object is a red apple on a white plate”)
- `logo_crt`: Caption/interpretation of **logo_image** (e.g., “white wordmark ‘MINA’ with thin serif font”)
- `inspiration_crt[]`: Array of captions for inspiration images (1..4)
  - Example: `["inspiration 1 is editorial still life ...", "inspiration 2 is minimal luxury ..."]`
- `still_crt`: Caption of the **still input image** (used for animation or feedback)
- `output_still_crt`: Caption of **generated still output** (used for audit + future personalization)

### 5.2 Friendly userMessages (loading lines)
- `userMessages.scan_lines[]`: Multiple short lines shown to user while processing.
  - Example: `["Apple trivia: ...", "Nice choice! ...", "Building your prompt..."]`
- `userMessages.final_line`: One final friendly line returned with the final prompt (or final output)

### 5.3 Like history scan
- `history.vision_intelligence`:
  - `true`: scan **last 5** liked/downloaded generations (images + prompts)
  - `false`: scan **last 20** liked/downloaded (images only)  
- `history.like_window`: resolved number used (5 or 20)
- `history.style_history_csv`: comma-separated preference tags
  - Example: `"editorial still life, minimal, luxury, no light flare, no stars"`

### 5.4 Prompt building
- `prompts.clean_prompt`: final still prompt (Seedream-ready)
- `prompts.motion_prompt`: final motion prompt (Kling-ready)
- `prompts.motion_sugg_prompt`: motion prompt produced by the “Type for me” helper

### 5.5 Feedback
- `feedback.still_feedback`: user typed tweak request for still
- `feedback.motion_feedback`: user typed tweak request for motion

### 5.6 Outputs
- `outputs.seedream_image_id`: generated still asset id/path
- `outputs.kling_video_id`: generated video asset id/path

---

## 6) Frontend: how to call MMA (reference API contract)
Below is a **clean reference contract**. If your existing endpoints differ, keep the **payload shape** the same to avoid frontend churn.

### 6.1 Upload assets (recommended pattern)
You can:
- upload to storage first (client → Supabase Storage) and pass back `*_image_id` paths
- OR upload through your backend (backend stores and returns ids)

**Frontend state to keep:**
```ts
type MMAAssets = {
  product_image_id?: string | null;
  logo_image_id?: string | null;
  inspiration_image_ids?: string[]; // 0..4
  style_hero_image_id?: string | null;
  input_still_image_id?: string | null; // for animate
};
```

---

## 7) Still creation API
### 7.1 Start still creation
**POST** `/mma/still/create`

**Request**
```json
{
  "customer_id": "uuid",
  "assets": {
    "product_image_id": "path-or-uuid",
    "logo_image_id": "path-or-uuid",
    "inspiration_image_ids": ["path1", "path2"],
    "style_hero_image_id": "path-or-uuid"
  },
  "inputs": {
    "userBrief": "I want a luxury product shot...",
    "style": "minimal editorial still life"
  },
  "history": {
    "vision_intelligence": true
  },
  "settings": {
    "seedream": {
      "aspect_ratio": "1:1",
      "quality": "high"
    }
  }
}
```

**Response (immediate)**
```json
{
  "generation_id": "uuid",
  "status": "queued",
  "sse_url": "/mma/stream/{generation_id}"
}
```

### 7.2 Stream userMessages (loading lines)
**GET (SSE)** `/mma/stream/{generation_id}`

**Server emits events like:**
```
event: scan_line
data: {"index":1,"text":"Nice apple! Fun fact: ..."}

event: scan_line
data: {"index":2,"text":"Reading your inspirations..."}

event: status
data: {"status":"generating"}

event: done
data: {"status":"done"}
```

**Frontend SSE example (copy-paste):**
```ts
export function streamMMA(generationId: string, onLine: (t: string) => void, onStatus?: (s: string) => void) {
  const es = new EventSource(`/mma/stream/${generationId}`);

  es.addEventListener("scan_line", (ev) => {
    const data = JSON.parse((ev as MessageEvent).data);
    onLine(data.text);
  });

  es.addEventListener("status", (ev) => {
    const data = JSON.parse((ev as MessageEvent).data);
    onStatus?.(data.status);
  });

  es.addEventListener("done", () => es.close());
  es.addEventListener("error", () => es.close());

  return () => es.close();
}
```

### 7.3 Fetch final generation result
**GET** `/mma/generations/{generation_id}`

**Response**
```json
{
  "generation_id": "uuid",
  "status": "done",
  "mma_vars": { "...": "full variable map" },
  "outputs": {
    "seedream_image_url": "https://..."
  }
}
```

**Frontend polling fallback (if no SSE):**
```ts
export async function pollGeneration(generationId: string, timeoutMs = 120_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const r = await fetch(`/mma/generations/${generationId}`);
    const j = await r.json();
    if (j.status === "done" || j.status === "error") return j;
    await new Promise((res) => setTimeout(res, 1200));
  }
  throw new Error("Timeout polling generation");
}
```

---

## 8) Still tweak API (feedback loop)
### 8.1 Tweak existing still
**POST** `/mma/still/{generation_id}/tweak`

**Request**
```json
{
  "customer_id": "uuid",
  "feedback": {
    "still_feedback": "Make the background darker and remove reflections."
  },
  "settings": {
    "seedream": {
      "quality": "high"
    }
  }
}
```

**Response**
```json
{
  "generation_id": "uuid",
  "status": "queued",
  "sse_url": "/mma/stream/{generation_id}"
}
```

Frontend UX recommendation:
- keep showing previous still
- stream new lines
- swap image on `done`

---

## 9) Video creation API (Animate)
### 9.1 Animate from an existing still (or uploaded image)
**POST** `/mma/video/animate`

**Request**
```json
{
  "customer_id": "uuid",
  "assets": {
    "input_still_image_id": "path-or-uuid"
  },
  "inputs": {
    "motion_user_brief": "Slow cinematic camera push-in.",
    "movement_style": "cinematic_smooth"
  },
  "mode": {
    "type_for_me": true
  },
  "settings": {
    "kling": {
      "duration_s": 5,
      "fps": 24
    }
  }
}
```

**Behavior**
- If `type_for_me=true` → MMA uses motion_suggestion GPT and fills `prompts.motion_sugg_prompt`
- Else → MMA generates `prompts.motion_prompt`

**Response**
```json
{
  "generation_id": "uuid",
  "status": "queued",
  "sse_url": "/mma/stream/{generation_id}"
}
```

### 9.2 Get final video result
**GET** `/mma/generations/{generation_id}`

**Response**
```json
{
  "generation_id": "uuid",
  "status": "done",
  "mma_vars": { "...": "full variable map" },
  "outputs": {
    "kling_video_url": "https://..."
  }
}
```

---

## 10) Video tweak API (feedback loop)
**POST** `/mma/video/{generation_id}/tweak`

**Request**
```json
{
  "customer_id": "uuid",
  "feedback": {
    "motion_feedback": "No flickering lights, keep motion very subtle."
  },
  "settings": {
    "kling": {
      "duration_s": 5
    }
  }
}
```

---

## 11) Events (likes, dislikes, downloads) → preference learning
MMA learns “Pinterest-like” preferences by ingesting interaction events.

**POST** `/mma/events`

**Request**
```json
{
  "customer_id": "uuid",
  "generation_id": "uuid",
  "event_type": "like",
  "payload": {
    "source": "gallery",
    "timestamp_ms": 1760000000000
  }
}
```

Recommended event_type values:
- `like`
- `dislike`
- `download`
- `create`
- `tweak`
- `feedback`

How MMA uses them:
- Recent likes feed `history.style_history_csv`
- Dislikes can add hard blocks (example below)

---

## 12) “Never show light movements again” (frontend + MMA contract)
### 12.1 UX
When user clicks “Dislike” or selects “No light movement ever”, the frontend sends a preference event:

**POST** `/mma/events`
```json
{
  "customer_id": "uuid",
  "event_type": "preference_set",
  "payload": {
    "hard_block": "motion.light_flicker"
  }
}
```

### 12.2 MMA behavior
- Stores hard block in customer preference profile
- On any future **motion prompt generation**, MMA injects constraints:
  - e.g., “no flicker, no flare, no strobing, stable lighting”
- On feed/recommendations, MMA filters out generations tagged with blocked motion types

---

## 13) Frontend mapping (UI → MMA variables)
### 13.1 Still screen
- Product upload → `assets.product_image_id`
- Logo upload → `assets.logo_image_id`
- Inspiration uploads (up to 4) → `assets.inspiration_image_ids[]`
- Style hero upload (optional) → `assets.style_hero_image_id`
- Text area “Brief” → `inputs.userBrief`
- Dropdown “Style” → `inputs.style`
- Toggle “Vision intelligence” → `history.vision_intelligence`

### 13.2 Tweak still screen
- Feedback input → `feedback.still_feedback`
- Button “Tweak” → POST `/mma/still/{id}/tweak`

### 13.3 Animate screen
- If animating existing still → `assets.input_still_image_id` = selected still id
- Motion brief → `inputs.motion_user_brief`
- Movement style chips → `inputs.movement_style`
- Toggle “Type for me” → `mode.type_for_me`
- Button “Animate” → POST `/mma/video/animate`

### 13.4 Tweak motion screen
- Feedback motion input → `feedback.motion_feedback`
- Button “Tweak” → POST `/mma/video/{id}/tweak`

---

## 14) What MMA should return to frontend (minimum required)
For every generation fetch:
- `status`: `queued | scanning | prompting | generating | postscan | done | error`
- `mma_vars.userMessages.scan_lines[]`: so frontend can replay messages even if reload
- `mma_vars.prompts.clean_prompt` or `mma_vars.prompts.motion_prompt` (optional to show in “Advanced”)
- `outputs.seedream_image_url` or `outputs.kling_video_url`

---

## 15) Error handling contract (frontend rules)
### 15.1 Error payload
If error:
```json
{
  "status": "error",
  "error": {
    "code": "SEEDREAM_TIMEOUT",
    "message": "Seedream request timed out",
    "step": "seedream_generate"
  }
}
```

### 15.2 Frontend behavior
- Show last streamed `scan_lines`
- Show actionable retry: “Retry generation” (replay with same assets + inputs)
- Keep the last successful output visible

---

## 16) Auditability (why you store everything)
Every step produces:
- input payload
- output payload
- duration
- error (if any)

This allows:
- exact reproduction of a generation
- debugging mismatched prompts
- building better preference learning
- “what happened” timeline in admin UI

---

## 17) Implementation notes (do not skip)
- Always persist **scan_lines** early (so reload still shows “what MMA said”).
- Avoid overwriting prompts: keep `prompts.clean_prompt`, `prompts.motion_prompt`, and feedback outputs.
- Keep `version` in mma_vars to allow migrations of variable meaning over time.

---

## 18) Copy-paste checklist for frontend dev
1) Upload assets → get `*_image_id` strings
2) POST create/animate with assets + inputs + settings
3) Open SSE stream → append scan lines
4) Poll GET generation until `done`
5) Render output image/video
6) POST events for like/dislike/download
7) For tweak, POST tweak endpoint with feedback

---

## Appendix A — Suggested status transitions
- queued
- scanning (GPTscanner)
- prompting (GPT reader)
- generating (Seedream/Kling)
- postscan (scan output)
- done
- error

---

## Appendix B — Minimal TS types for frontend
```ts
export type MMAGenerationStatus =
  | "queued" | "scanning" | "prompting" | "generating" | "postscan" | "done" | "error";

export type MMAVars = {
  version: string;
  mode: "still" | "video";
  assets: {
    product_image_id?: string | null;
    logo_image_id?: string | null;
    inspiration_image_ids?: string[];
    style_hero_image_id?: string | null;
    input_still_image_id?: string | null;
  };
  scans: {
    product_crt?: string | null;
    logo_crt?: string | null;
    inspiration_crt?: string[];
    still_crt?: string | null;
    output_still_crt?: string | null;
  };
  history: {
    vision_intelligence: boolean;
    like_window: number;
    style_history_csv?: string;
  };
  inputs: {
    userBrief?: string;
    style?: string;
    motion_user_brief?: string;
    movement_style?: string;
  };
  prompts: {
    clean_prompt?: string | null;
    motion_prompt?: string | null;
    motion_sugg_prompt?: string | null;
  };
  feedback: {
    still_feedback?: string | null;
    motion_feedback?: string | null;
  };
  userMessages: {
    scan_lines: string[];
    final_line?: string | null;
  };
  settings: {
    seedream?: Record<string, any>;
    kling?: Record<string, any>;
  };
  outputs: {
    seedream_image_id?: string | null;
    kling_video_id?: string | null;
  };
};

export type MMAGenerationResponse = {
  generation_id: string;
  status: MMAGenerationStatus;
  mma_vars: MMAVars;
  outputs?: {
    seedream_image_url?: string;
    kling_video_url?: string;
  };
  error?: { code: string; message: string; step?: string };
};
```

## 19) Config + versioning (ctx_* + provider presets + adding new providers)

This spec supports fast iteration by making **GPT contexts** and **provider presets** fully **versioned configs**.

### 19.1 Where configs live
- Store all configs in `MEGA_ADMIN` with `mg_record_type='app_config'`.
- Do **not** hardcode prompt templates or provider defaults in code (except safe fallbacks).

### 19.2 Versioning rule (never edit in-place)
- Each change = new version key (immutable history)
- Key pattern: `app_config:<config_key>.v<version>`
- Config JSON must include `{"version": <int>, "enabled": true}`

Example keys:
- `mma.ctx.gpt_reader`
- `mma.provider.seedream.defaults`
- `mma.provider.kling.defaults`
- `mma.provider.registry`

### 19.3 What frontend controls vs what backend controls
Frontend should control **only**:
- assets ids/paths
- user inputs (briefs, styles)
- optional overrides in `settings.<provider>`

Backend controls:
- which GPT context template version is active
- provider preset defaults
- merging logic + enforcing hard blocks from preferences

### 19.4 What MMA returns (optional but recommended)
Include config versions used in generation response for debugging:
- `mma_vars.meta.ctx_versions`
- `mma_vars.meta.settings_versions`

Example:
```json
{
  "meta": {
    "ctx_versions": { "gpt_reader": 4, "gpt_scanner": 2 },
    "settings_versions": { "seedream": 3, "kling": 5 }
  }
}
```

### 19.5 Adding a new provider (adapter pattern)
To add a provider `<provider>`:
1) Add defaults config: `mma.provider.<provider>.defaults`
2) Add/adjust translator ctx: reuse `mma.ctx.gpt_reader` or create provider-specific ctx
3) Add a new step type `<provider>_generate`
4) Persist provider request/response in step payload (`mma_step.mg_payload`)
5) Add provider into `mma.provider.registry`

No DB schema changes required if you keep outputs in `mg_output_url` (final) and raw provider responses in step payload.
