import express from "express";
import crypto from "crypto";
import { getSupabaseAdmin } from "../../supabase.js";
import { getMmaConfig } from "../mma/mma-config.js";

const router = express.Router();

// ---- Config ----
const PASSWORD = process.env.MMA_LOGADMIN_PASSWORD || "Falta101M";
const COOKIE_SECRET =
  process.env.MMA_LOGADMIN_COOKIE_SECRET ||
  process.env.COOKIE_SECRET ||
  "dev_insecure_change_me";
const COOKIE_NAME = "mma_logadmin";

router.use(express.urlencoded({ extended: false }));

// ---- Helpers ----
function isHttps(req) {
  return req.secure || String(req.headers["x-forwarded-proto"] || "").toLowerCase() === "https";
}

function escapeHtml(s) {
  return String(s || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function prettyJson(obj) {
  try { return JSON.stringify(obj, null, 2); } catch { return String(obj || ""); }
}

function hmacSha256(secret, data) {
  return crypto.createHmac("sha256", secret).update(data).digest("hex");
}

function signToken(payloadObj) {
  const payloadJson = JSON.stringify(payloadObj);
  const payloadB64 = Buffer.from(payloadJson, "utf8").toString("base64url");
  const sig = hmacSha256(COOKIE_SECRET, payloadB64);
  return `${payloadB64}.${sig}`;
}

function verifyToken(token) {
  if (!token || typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [payloadB64, sig] = parts;
  const expected = hmacSha256(COOKIE_SECRET, payloadB64);
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const json = Buffer.from(payloadB64, "base64url").toString("utf8");
    const payload = JSON.parse(json);
    if (!payload || typeof payload !== "object") return null;
    if (typeof payload.exp !== "number") return null;
    if (Date.now() > payload.exp) return null;
    return payload;
  } catch { return null; }
}

function getCookie(req, name) {
  const raw = req.headers.cookie || "";
  for (const p of raw.split(";")) {
    const idx = p.indexOf("=");
    if (idx <= 0) continue;
    if (p.slice(0, idx).trim() === name) return decodeURIComponent(p.slice(idx + 1).trim());
  }
  return null;
}

function setAuthCookie(res, req) {
  const token = signToken({ v: 1, exp: Date.now() + 1000 * 60 * 60 * 12 });
  const flags = [
    `${COOKIE_NAME}=${encodeURIComponent(token)}`,
    "Path=/", "HttpOnly", "SameSite=Lax",
  ];
  if (isHttps(req)) flags.push("Secure");
  res.setHeader("Set-Cookie", flags.join("; "));
}

function clearAuthCookie(res) {
  res.setHeader("Set-Cookie", `${COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`);
}

function isAuthed(req) { return !!verifyToken(getCookie(req, COOKIE_NAME)); }

function requireAuth(req, res, next) {
  if (isAuthed(req)) return next();
  const accept = String(req.headers.accept || "");
  if (req.path.startsWith("/api/") || accept.includes("application/json")) {
    return res.status(401).json({ ok: false, error: "Not authenticated" });
  }
  return res.redirect("/admin/mma/login");
}

/** Resolve pass IDs to emails in bulk */
async function resolveEmails(supabase, passIds) {
  if (!passIds.length) return {};
  const unique = [...new Set(passIds)];
  const map = {};
  // Supabase .in() has a limit, batch by 50
  for (let i = 0; i < unique.length; i += 50) {
    const batch = unique.slice(i, i + 50);
    const { data } = await supabase
      .from("mega_customers")
      .select("mg_pass_id, mg_email")
      .in("mg_pass_id", batch);
    if (data) {
      for (const row of data) {
        if (row.mg_email) map[row.mg_pass_id] = row.mg_email;
      }
    }
  }
  return map;
}

/** Resolve a single pass to email */
async function resolveEmail(supabase, passId) {
  if (!passId) return null;
  const { data } = await supabase
    .from("mega_customers")
    .select("mg_email")
    .eq("mg_pass_id", passId)
    .limit(1)
    .maybeSingle();
  return data?.mg_email || null;
}

function layout(title, bodyHtml, extra = "") {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <style>
    :root { --bg: #faf9f6; --text: #111; --muted: rgba(0,0,0,0.5); --border: rgba(0,0,0,0.08); --accent: #0b57d0; --green: #1a7f37; --red: #b00020; --purple: #7c3aed; --card-bg: #fff; }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; color: var(--text); background: var(--bg); line-height: 1.5; }
    .container { max-width: 1600px; margin: 0 auto; padding: 20px 24px; }
    .topbar { display:flex; gap:12px; align-items:center; justify-content:space-between; margin-bottom:20px; }
    .btn { border:1px solid var(--border); background:var(--card-bg); padding:8px 16px; border-radius:6px; cursor:pointer; font-size:12px; font-weight:600; letter-spacing:0.02em; text-transform:uppercase; transition: all 120ms ease; text-decoration: none; display: inline-flex; align-items: center; gap: 6px; color: var(--text); }
    .btn:hover { background:rgba(0,0,0,0.04); transform: translateY(-1px); }
    .btn--accent { background:var(--accent); color:#fff; border-color:var(--accent); }
    .btn--accent:hover { opacity:0.9; background:var(--accent); }
    .btn--sm { padding: 5px 10px; font-size: 11px; }
    .muted { color: var(--muted); }
    .mono { font-family: 'SF Mono', SFMono-Regular, ui-monospace, Menlo, monospace; font-size: 11px; }
    .tag { display:inline-block; padding:3px 10px; border-radius:20px; font-size:10px; text-transform:uppercase; letter-spacing:0.04em; font-weight:700; }
    .tag--ok { background:#e6f4ea; color:var(--green); }
    .tag--err { background:#fce8e6; color:var(--red); }
    .tag--video { background:#f3e8ff; color:var(--purple); }
    .tag--still { background:#e8f0fe; color:var(--accent); }
    .tag--queued { background:#fff3e0; color:#e65100; }
    .card { background: var(--card-bg); border: 1px solid var(--border); border-radius: 10px; padding: 20px; }
    input[type="text"], input[type="password"] { padding:9px 12px; border:1px solid var(--border); border-radius:6px; font-size:13px; background:var(--card-bg); outline: none; transition: border-color 150ms; }
    input:focus { border-color: var(--accent); box-shadow: 0 0 0 3px rgba(11,87,208,0.1); }
    .err { color: var(--red); }

    /* ---- Grid ---- */
    .gen-grid { display:grid; grid-template-columns:repeat(auto-fill, minmax(110px, 1fr)); gap:4px; }
    .gen-cell { position:relative; aspect-ratio:1; overflow:hidden; cursor:pointer; background:rgba(0,0,0,0.03); border-radius:6px; transition: transform 120ms ease, box-shadow 120ms ease; }
    .gen-cell:hover { transform: scale(1.03); box-shadow: 0 4px 16px rgba(0,0,0,0.15); z-index: 2; }
    .gen-cell img, .gen-cell video { width:100%; height:100%; object-fit:cover; display:block; }
    .gen-cell .badge { position:absolute; top:4px; right:4px; font-size:8px; padding:2px 5px; border-radius:3px; background:rgba(0,0,0,0.6); color:#fff; text-transform:uppercase; font-weight:700; letter-spacing:0.04em; pointer-events:none; }
    .gen-cell .badge--video { background:rgba(124,58,237,0.85); }
    .gen-cell .status-badge { position:absolute; bottom:4px; left:4px; font-size:7px; padding:2px 4px; border-radius:3px; background:rgba(0,0,0,0.55); color:#fff; text-transform:uppercase; font-weight:600; pointer-events:none; }
    .gen-cell .status-badge--err { background:rgba(176,0,32,0.85); }
    .gen-cell--empty { display:flex; align-items:center; justify-content:center; background: rgba(0,0,0,0.04); }
    .gen-cell--empty span { font-size:9px; color:var(--muted); text-align:center; padding:4px; }
    .gen-cell .cell-overlay { position:absolute; inset:0; background:linear-gradient(transparent 40%, rgba(0,0,0,0.7)); opacity:0; transition: opacity 150ms; display:flex; flex-direction:column; justify-content:flex-end; padding:6px; pointer-events:none; }
    .gen-cell:hover .cell-overlay { opacity:1; }
    .cell-overlay .cell-email { color:#fff; font-size:9px; font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    .cell-overlay .cell-time { color:rgba(255,255,255,0.7); font-size:8px; }

    /* ---- Lightbox / Detail Panel ---- */
    .lb-backdrop { position:fixed; inset:0; z-index:998; background:rgba(0,0,0,0.85); animation:fadeIn 200ms ease; }
    .lb { position:fixed; inset:0; z-index:999; display:flex; overflow:hidden; animation:fadeIn 200ms ease; }
    @keyframes fadeIn { from{opacity:0} to{opacity:1} }

    .lb-left { flex:0 0 50%; max-width:50%; display:flex; align-items:center; justify-content:center; background:#000; position:relative; }
    .lb-left img, .lb-left video { max-width:96%; max-height:96vh; object-fit:contain; }
    .lb-right { flex:0 0 50%; max-width:50%; background:var(--bg); overflow-y:auto; padding:0; }
    @media(max-width:900px){
      .lb { flex-direction:column; }
      .lb-left, .lb-right { flex:none; max-width:100%; }
      .lb-left { height:45vh; }
    }

    .lb-close { position:fixed; top:16px; right:20px; z-index:1000; background:rgba(0,0,0,0.5); border:none; color:#fff; font-size:22px; cursor:pointer; width:36px; height:36px; border-radius:50%; display:flex; align-items:center; justify-content:center; transition: background 150ms; }
    .lb-close:hover { background:rgba(0,0,0,0.8); }

    .lb-nav { position:fixed; top:16px; left:16px; z-index:1000; display:flex; gap:8px; }
    .lb-nav-btn { background:rgba(0,0,0,0.5); border:none; color:#fff; font-size:16px; cursor:pointer; width:36px; height:36px; border-radius:50%; display:flex; align-items:center; justify-content:center; transition: background 150ms; }
    .lb-nav-btn:hover { background:rgba(0,0,0,0.8); }

    /* Detail sections */
    .detail-header { padding: 24px 28px 16px; border-bottom: 1px solid var(--border); }
    .detail-section { padding: 16px 28px; border-bottom: 1px solid var(--border); }
    .detail-section:last-child { border-bottom: none; }
    .detail-section h3 { font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--muted); margin-bottom: 12px; font-weight: 700; }

    .field-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 0; }
    .field { padding: 10px 0; border-bottom: 1px solid rgba(0,0,0,0.04); }
    .field:last-child { border-bottom: none; }
    .field-label { font-size: 10px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); font-weight: 600; margin-bottom: 2px; }
    .field-value { font-size: 13px; word-break: break-word; }
    .field-value.big { font-size: 18px; font-weight: 700; }
    .field--full { grid-column: 1 / -1; }

    .image-gallery { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 4px; }
    .image-gallery img { width: 80px; height: 80px; object-fit: cover; border-radius: 6px; border: 1px solid var(--border); cursor: pointer; transition: transform 100ms; }
    .image-gallery img:hover { transform: scale(1.1); }

    .prompt-box { background: rgba(0,0,0,0.03); border: 1px solid var(--border); border-radius: 8px; padding: 14px; font-family: -apple-system, sans-serif; font-size: 13px; line-height: 1.6; white-space: pre-wrap; word-break: break-word; max-height: 300px; overflow-y: auto; }

    .steps-timeline { display: flex; flex-direction: column; gap: 0; }
    .step-item { display: flex; align-items: flex-start; gap: 12px; padding: 12px 0; border-bottom: 1px solid rgba(0,0,0,0.04); }
    .step-item:last-child { border-bottom: none; }
    .step-num { width: 28px; height: 28px; border-radius: 50%; background: var(--accent); color: #fff; display: flex; align-items: center; justify-content: center; font-size: 11px; font-weight: 700; flex-shrink: 0; }
    .step-info { flex: 1; }
    .step-type { font-weight: 700; font-size: 13px; }
    .step-dur { color: var(--muted); font-size: 12px; }

    .user-msg { display: flex; align-items: flex-start; gap: 8px; padding: 8px 12px; background: rgba(11,87,208,0.06); border-radius: 8px; margin-bottom: 6px; font-size: 12px; }
    .user-msg:before { content: '💬'; flex-shrink: 0; }

    .output-item { padding: 8px 0; border-bottom: 1px solid rgba(0,0,0,0.04); }
    .output-item:last-child { border-bottom: none; }

    .error-box { background: #fce8e6; border: 1px solid rgba(176,0,32,0.2); border-radius: 8px; padding: 14px; color: var(--red); font-size: 13px; white-space: pre-wrap; }

    .filter-bar { display:flex; gap:8px; align-items:center; flex-wrap:wrap; margin-bottom:16px; }
    .gen-count { background: var(--card-bg); border: 1px solid var(--border); border-radius: 20px; padding: 4px 14px; font-size: 12px; font-weight: 600; }

    .loading-spinner { display: flex; align-items: center; justify-content: center; padding: 24px; gap: 10px; }
    .spinner { width: 20px; height: 20px; border: 2px solid var(--border); border-top-color: var(--accent); border-radius: 50%; animation: spin 0.6s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
  </style>
  ${extra}
</head>
<body>
${bodyHtml}
</body>
</html>`;
}

// ---- Routes ----
router.get("/login", (req, res) => {
  const err = req.query.err ? String(req.query.err) : "";
  const html = layout(
    "MMA LogAdmin Login",
    `<div class="container">
      <div class="topbar">
        <h2 style="font-size:18px; font-weight:800;">Mina Admin</h2>
        <div class="muted" style="font-size:11px;">mina-editorial-ai</div>
      </div>
      <div class="card" style="max-width:400px;">
        <form method="POST" action="/admin/mma/login">
          <div style="margin-bottom:16px;">
            <label class="muted" style="font-size:11px; display:block; margin-bottom:4px;">Password</label>
            <input type="password" name="password" placeholder="Enter admin password" style="width:100%;" />
          </div>
          ${err ? `<div class="err" style="margin-bottom:12px; font-size:13px;">${escapeHtml(err)}</div>` : ""}
          <button class="btn btn--accent" type="submit" style="width:100%; justify-content:center;">Login</button>
        </form>
      </div>
    </div>`
  );
  res.status(200).send(html);
});

router.post("/login", (req, res) => {
  const pw = String(req.body?.password || "");
  if (pw !== PASSWORD) return res.redirect("/admin/mma/login?err=Wrong%20password");
  setAuthCookie(res, req);
  return res.redirect("/admin/mma");
});

router.post("/logout", (req, res) => {
  clearAuthCookie(res);
  return res.redirect("/admin/mma/login");
});

// ---- JSON API: generations list with emails ----
router.get("/api/generations", requireAuth, async (req, res) => {
  const supabase = getSupabaseAdmin();
  if (!supabase) return res.status(500).json({ ok: false, error: "SUPABASE_NOT_CONFIGURED" });

  const passId = (req.query.passId || "").trim();
  const cursor = (req.query.cursor || "").trim();
  const limit = Math.max(1, Math.min(100, Number(req.query.limit || 60) || 60));

  let q = supabase
    .from("mega_generations")
    .select("mg_generation_id, mg_pass_id, mg_parent_id, mg_mma_mode, mg_mma_status, mg_status, mg_output_url, mg_prompt, mg_created_at, mg_latency_ms, mg_mma_vars")
    .eq("mg_record_type", "generation")
    .order("mg_created_at", { ascending: false })
    .limit(limit);

  if (passId) q = q.eq("mg_pass_id", passId);
  if (cursor) q = q.lt("mg_created_at", cursor);

  const { data, error } = await q;
  if (error) return res.status(500).json({ ok: false, error: error.message });

  // Resolve emails
  const passIds = (data || []).map((g) => g.mg_pass_id).filter(Boolean);
  const emailMap = await resolveEmails(supabase, passIds);

  const items = (data || []).map((g) => {
    const vars = g.mg_mma_vars || {};
    const inputs = vars.inputs || {};
    return {
      id: g.mg_generation_id,
      passId: g.mg_pass_id || "",
      email: emailMap[g.mg_pass_id] || "",
      parentId: g.mg_parent_id || "",
      mode: g.mg_mma_mode || "",
      status: g.mg_mma_status || g.mg_status || "",
      url: g.mg_output_url || "",
      prompt: g.mg_prompt || "",
      brief: inputs.brief || "",
      createdAt: g.mg_created_at || "",
      latencyMs: g.mg_latency_ms || null,
    };
  });

  const nextCursor = items.length === limit ? items[items.length - 1].createdAt : null;
  return res.json({ ok: true, items, nextCursor });
});

// ---- JSON API: single generation detail with email ----
router.get("/api/generation/:id", requireAuth, async (req, res) => {
  const supabase = getSupabaseAdmin();
  if (!supabase) return res.status(500).json({ ok: false, error: "SUPABASE_NOT_CONFIGURED" });

  const id = String(req.params.id || "").trim();
  const { data: gen } = await supabase
    .from("mega_generations")
    .select("*")
    .eq("mg_record_type", "generation")
    .eq("mg_generation_id", id)
    .maybeSingle();

  if (!gen) return res.status(404).json({ ok: false, error: "Not found" });

  // Get email
  const email = await resolveEmail(supabase, gen.mg_pass_id);

  const { data: steps } = await supabase
    .from("mega_generations")
    .select("mg_step_no, mg_step_type, mg_payload, mg_created_at")
    .eq("mg_record_type", "mma_step")
    .eq("mg_generation_id", id)
    .order("mg_step_no", { ascending: true });

  return res.json({ ok: true, generation: gen, email: email || null, steps: steps || [] });
});

// ---- Main admin page ----
router.get("/", requireAuth, async (req, res) => {
  const passId = (req.query.passId ? String(req.query.passId) : "").trim();

  const html = layout(
    "Mina Admin",
    `<div class="container">
      <div class="topbar">
        <div>
          <h2 style="font-size:18px; font-weight:800; letter-spacing:-0.02em;">Mina Admin</h2>
          <div class="muted" style="font-size:11px;">All generations across all users</div>
        </div>
        <div style="display:flex; gap:8px; align-items:center;">
          <a class="btn btn--accent" href="/admin/mma/session-costs">Costs</a>
          <form method="POST" action="/admin/mma/logout" style="margin:0;">
            <button class="btn" type="submit">Logout</button>
          </form>
        </div>
      </div>

      <div class="filter-bar">
        <input type="text" id="filterPass" value="${escapeHtml(passId)}" placeholder="Filter by passId or email..." style="width:280px;" />
        <button class="btn" onclick="applyFilter()">Apply</button>
        <button class="btn" onclick="clearFilter()">Reset</button>
        <span id="genCount" class="gen-count" style="display:none;"></span>
      </div>

      <div class="gen-grid" id="grid"></div>
      <div id="loadMore" class="loading-spinner">
        <div class="spinner"></div>
        <span class="muted" style="font-size:12px;">Loading generations...</span>
      </div>

      <!-- Lightbox -->
      <div id="lbBackdrop" class="lb-backdrop" style="display:none;" onclick="closeLb()"></div>
      <div id="lb" class="lb" style="display:none;">
        <div class="lb-nav">
          <button class="lb-nav-btn" onclick="navLb(-1)" title="Previous">&#8592;</button>
          <button class="lb-nav-btn" onclick="navLb(1)" title="Next">&#8594;</button>
        </div>
        <button class="lb-close" onclick="closeLb()">&times;</button>
        <div class="lb-left" id="lbMedia"></div>
        <div class="lb-right" id="lbDetails"></div>
      </div>
    </div>`,
    `<script>
    let items = [];
    let cursor = null;
    let loading = false;
    let exhausted = false;
    let currentLbIndex = -1;

    function getPassFilter() {
      return (document.getElementById('filterPass').value || '').trim();
    }

    function applyFilter() {
      items = []; cursor = null; exhausted = false;
      document.getElementById('grid').innerHTML = '';
      loadPage();
    }

    function clearFilter() {
      document.getElementById('filterPass').value = '';
      applyFilter();
    }

    async function loadPage() {
      if (loading || exhausted) return;
      loading = true;
      const params = new URLSearchParams({ limit: '60' });
      const pf = getPassFilter();
      if (pf) params.set('passId', pf);
      if (cursor) params.set('cursor', cursor);

      try {
        const r = await fetch('/admin/mma/api/generations?' + params, { credentials: 'same-origin', headers: { 'Accept': 'application/json' } });
        if (r.status === 401) { window.location.href = '/admin/mma/login'; return; }
        if (!r.ok) { loading = false; showLoadError('Error ' + r.status); return; }
        const j = await r.json();
        if (!j.ok) { loading = false; showLoadError(j.error || 'Unknown error'); return; }
        const startIdx = items.length;
        items = items.concat(j.items);
        cursor = j.nextCursor;
        if (!j.nextCursor) exhausted = true;
        renderItems(j.items, startIdx);
        updateCount();
        if (exhausted) {
          document.getElementById('loadMore').style.display = 'none';
        }
        if (!j.items.length && !items.length) {
          document.getElementById('loadMore').innerHTML = '<span class="muted" style="font-size:12px;">No generations found</span>';
        }
      } catch(e) {
        console.error(e);
        showLoadError('Network error');
      }
      loading = false;
    }

    function showLoadError(msg) {
      document.getElementById('loadMore').innerHTML = '<span style="color:var(--red); font-size:12px;">' + esc(msg) + ' — <a href="#" onclick="retryLoad();return false;">Retry</a></span>';
    }

    function retryLoad() {
      document.getElementById('loadMore').innerHTML = '<div class="spinner"></div><span class="muted" style="font-size:12px;">Loading...</span>';
      document.getElementById('loadMore').className = 'loading-spinner';
      loadPage();
    }

    function updateCount() {
      const el = document.getElementById('genCount');
      el.style.display = '';
      el.textContent = items.length + ' generation' + (items.length !== 1 ? 's' : '') + (exhausted ? '' : '+');
    }

    function renderItems(batch, startIdx) {
      const grid = document.getElementById('grid');
      batch.forEach((g, i) => {
        const idx = startIdx + i;
        const cell = document.createElement('div');
        cell.className = 'gen-cell';
        cell.onclick = () => openLb(idx);

        const isVideo = g.mode === 'video';
        const hasUrl = !!g.url;
        const statusOk = g.status === 'done' || g.status === 'completed';

        if (hasUrl && isVideo) {
          cell.innerHTML = '<video src="' + esc(g.url) + '" muted loop playsinline preload="metadata"></video>';
          cell.onmouseenter = () => { const v = cell.querySelector('video'); if(v) v.play().catch(()=>{}); };
          cell.onmouseleave = () => { const v = cell.querySelector('video'); if(v) { v.pause(); v.currentTime=0; } };
        } else if (hasUrl) {
          cell.innerHTML = '<img src="' + esc(g.url) + '" loading="lazy" decoding="async" />';
        } else {
          cell.className += ' gen-cell--empty';
          cell.innerHTML = '<span>' + esc(g.status || 'no output') + '</span>';
        }

        // Mode badge
        if (isVideo) cell.innerHTML += '<span class="badge badge--video">VID</span>';

        // Status badge
        if (!statusOk && g.status) {
          const cls = g.status === 'error' || g.status === 'failed' ? ' status-badge--err' : '';
          cell.innerHTML += '<span class="status-badge' + cls + '">' + esc(g.status) + '</span>';
        }

        // Hover overlay with email + time
        const emailShort = g.email ? g.email.split('@')[0] : (g.passId || '').slice(0, 12);
        const timeStr = g.createdAt ? fmtTimeShort(g.createdAt) : '';
        cell.innerHTML += '<div class="cell-overlay"><div class="cell-email">' + esc(emailShort) + '</div><div class="cell-time">' + esc(timeStr) + '</div></div>';

        grid.appendChild(cell);
      });
    }

    function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

    function fmtTimeShort(s) {
      try {
        const d = new Date(s);
        const now = new Date();
        const diff = now - d;
        if (diff < 60000) return 'just now';
        if (diff < 3600000) return Math.floor(diff/60000) + 'm ago';
        if (diff < 86400000) return Math.floor(diff/3600000) + 'h ago';
        if (diff < 604800000) return Math.floor(diff/86400000) + 'd ago';
        return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      } catch { return s; }
    }

    function fmtDate(s) {
      if (!s) return '—';
      try {
        const d = new Date(s);
        return d.toLocaleDateString('en-US', { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' }) + ' at ' + d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      } catch { return s; }
    }

    function fmtDuration(ms) {
      if (!ms && ms !== 0) return '—';
      if (ms < 1000) return ms + 'ms';
      const s = ms / 1000;
      if (s < 60) return s.toFixed(1) + 's';
      const m = Math.floor(s / 60);
      const rem = (s % 60).toFixed(0);
      return m + 'm ' + rem + 's';
    }

    // Infinite scroll
    const io = new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting && !loading && !exhausted) loadPage();
    }, { rootMargin: '800px' });
    io.observe(document.getElementById('loadMore'));

    // ---- Lightbox ----
    async function openLb(idx) {
      currentLbIndex = idx;
      document.getElementById('lbBackdrop').style.display = '';
      document.getElementById('lb').style.display = '';
      document.body.style.overflow = 'hidden';
      document.getElementById('lbMedia').innerHTML = '<div class="loading-spinner" style="min-height:200px;"><div class="spinner"></div></div>';
      document.getElementById('lbDetails').innerHTML = '<div class="loading-spinner" style="padding:40px;"><div class="spinner"></div><span class="muted">Loading details...</span></div>';

      const g = items[idx];
      if (!g) { closeLb(); return; }

      try {
        const r = await fetch('/admin/mma/api/generation/' + encodeURIComponent(g.id), { credentials: 'same-origin', headers: { 'Accept': 'application/json' } });
        if (r.status === 401) { window.location.href = '/admin/mma/login'; return; }
        const j = await r.json();
        if (!j.ok) { closeLb(); return; }
        renderLbDetail(j.generation, j.steps, j.email);
      } catch(e) {
        console.error(e);
        document.getElementById('lbDetails').innerHTML = '<div style="padding:28px;color:var(--red);">Failed to load details</div>';
      }
    }

    function navLb(dir) {
      const next = currentLbIndex + dir;
      if (next < 0 || next >= items.length) return;
      openLb(next);
    }

    function renderLbDetail(gen, steps, email) {
      const media = document.getElementById('lbMedia');
      const det = document.getElementById('lbDetails');
      const url = gen.mg_output_url || '';
      const isVideo = gen.mg_mma_mode === 'video';

      // Media
      if (url && isVideo) {
        media.innerHTML = '<video src="' + esc(url) + '" controls autoplay loop playsinline style="max-width:96%;max-height:96vh;object-fit:contain;"></video>';
      } else if (url) {
        media.innerHTML = '<img src="' + esc(url) + '" style="max-width:96%;max-height:96vh;object-fit:contain;" />';
      } else {
        media.innerHTML = '<div style="color:rgba(255,255,255,0.4); font-size:14px;">No output</div>';
      }

      const status = gen.mg_mma_status || gen.mg_status || '—';
      const mode = gen.mg_mma_mode || '—';
      const vars = gen.mg_mma_vars || {};
      const inputs = vars.inputs || {};
      const assets = vars.assets || {};
      const prompts = vars.prompts || {};
      const outputs = vars.outputs || {};
      const settings = vars.settings || {};
      const userMsgs = vars.userMessages || [];
      const meta = vars.meta || {};
      const costData = gen.mg_cost_data || {};
      const errorData = gen.mg_error;

      // Calculate wait time
      let waitTime = gen.mg_latency_ms;
      if (!waitTime && steps && steps.length) {
        const first = steps[0];
        const last = steps[steps.length - 1];
        const ft = first?.mg_payload?.timing?.started_at;
        const lt = last?.mg_payload?.timing?.ended_at;
        if (ft && lt) {
          waitTime = new Date(lt) - new Date(ft);
        }
      }

      function statusTag(s) {
        let cls = '';
        if (s === 'done' || s === 'completed') cls = 'tag--ok';
        else if (s === 'error' || s === 'failed') cls = 'tag--err';
        else if (s === 'queued' || s === 'processing') cls = 'tag--queued';
        return '<span class="tag ' + cls + '">' + esc(s) + '</span>';
      }

      function modeTag(m) {
        const cls = m === 'video' ? 'tag--video' : m === 'still' ? 'tag--still' : '';
        return '<span class="tag ' + cls + '">' + esc(m) + '</span>';
      }

      function field(label, value, full) {
        return '<div class="field' + (full ? ' field--full' : '') + '"><div class="field-label">' + esc(label) + '</div><div class="field-value">' + value + '</div></div>';
      }

      function fieldText(label, value, full) {
        return field(label, esc(String(value ?? '—')), full);
      }

      // ---- Build HTML ----
      let html = '';

      // HEADER: User + Status at a glance
      html += '<div class="detail-header">';
      html += '<div style="display:flex; justify-content:space-between; align-items:flex-start; gap:12px; margin-bottom:12px;">';
      html += '<div>';
      html += '<div style="font-size:16px; font-weight:700;">' + (email ? esc(email) : '<span class="muted">Unknown user</span>') + '</div>';
      html += '<div class="muted" style="font-size:11px; margin-top:2px;">' + esc(gen.mg_pass_id || '') + '</div>';
      html += '</div>';
      html += '<div style="text-align:right;">' + statusTag(status) + ' ' + modeTag(mode) + '</div>';
      html += '</div>';
      // Key stats row
      html += '<div style="display:flex; gap:24px; flex-wrap:wrap;">';
      html += '<div><div class="field-label">Created</div><div style="font-size:13px; font-weight:600;">' + esc(fmtDate(gen.mg_created_at)) + '</div></div>';
      html += '<div><div class="field-label">Wait Time</div><div style="font-size:13px; font-weight:600;">' + esc(fmtDuration(waitTime)) + '</div></div>';
      if (costData.matchas_charged != null) {
        html += '<div><div class="field-label">Cost</div><div style="font-size:13px; font-weight:600;">' + costData.matchas_charged + ' matchas</div></div>';
      }
      if (costData.profit_usd != null) {
        const profitColor = costData.profit_usd >= 0 ? 'var(--green)' : 'var(--red)';
        html += '<div><div class="field-label">Profit</div><div style="font-size:13px; font-weight:600; color:' + profitColor + ';">$' + costData.profit_usd.toFixed(3) + '</div></div>';
      }
      html += '</div>';
      html += '</div>';

      // USER INPUT: What the user typed and uploaded
      html += '<div class="detail-section">';
      html += '<h3>What the User Provided</h3>';
      const brief = inputs.brief || inputs.prompt || inputs.text || '';
      if (brief) {
        html += field('User Brief / Description', '<div class="prompt-box">' + esc(brief) + '</div>', true);
      }
      // Show all user-facing inputs as fields
      const inputFields = [
        ['Title', inputs.title],
        ['Mode', inputs.mode],
        ['Style', inputs.style],
        ['Duration', inputs.duration ? inputs.duration + ' seconds' : null],
        ['Platform', inputs.platform],
        ['Orientation', inputs.orientation],
        ['Muted', inputs.muted != null ? String(inputs.muted) : null],
        ['Mute Audio', inputs.mute != null ? String(inputs.mute) : null],
      ].filter(([_, v]) => v != null && v !== '' && v !== 'undefined');
      if (inputFields.length) {
        html += '<div class="field-grid">';
        inputFields.forEach(([label, val]) => { html += fieldText(label, val); });
        html += '</div>';
      }
      html += '</div>';

      // UPLOADED IMAGES
      const imageUrls = [];
      if (assets.start_image_url) imageUrls.push(['Start Image', assets.start_image_url]);
      if (assets.end_image_url) imageUrls.push(['End Image', assets.end_image_url]);
      if (assets.logo_image_url) imageUrls.push(['Logo', assets.logo_image_url]);
      if (inputs.start_image) imageUrls.push(['Start Image (input)', inputs.start_image]);

      if (imageUrls.length) {
        html += '<div class="detail-section">';
        html += '<h3>Uploaded Images</h3>';
        html += '<div class="image-gallery">';
        imageUrls.forEach(([label, u]) => {
          html += '<div style="text-align:center;"><img src="' + esc(u) + '" title="' + esc(label) + '" onclick="window.open(this.src)" /><div class="muted" style="font-size:9px; margin-top:2px;">' + esc(label) + '</div></div>';
        });
        html += '</div>';
        html += '</div>';
      }

      // AI PROMPT (final prompt sent to model)
      if (gen.mg_prompt) {
        html += '<div class="detail-section">';
        html += '<h3>AI Prompt (sent to model)</h3>';
        html += '<div class="prompt-box">' + esc(gen.mg_prompt) + '</div>';
        html += '</div>';
      }

      // AI GENERATED PROMPTS (from pipeline)
      const promptKeys = Object.keys(prompts);
      if (promptKeys.length) {
        html += '<div class="detail-section">';
        html += '<h3>Pipeline Prompts</h3>';
        promptKeys.forEach(key => {
          const val = prompts[key];
          const display = typeof val === 'string' ? val : prettyJ(val);
          html += '<div class="field field--full">';
          html += '<div class="field-label">' + esc(key) + '</div>';
          html += '<div class="prompt-box" style="max-height:200px;">' + esc(display) + '</div>';
          html += '</div>';
        });
        html += '</div>';
      }

      // AI OUTPUTS
      const outputKeys = Object.keys(outputs);
      if (outputKeys.length) {
        html += '<div class="detail-section">';
        html += '<h3>AI Outputs</h3>';
        outputKeys.forEach(key => {
          const val = outputs[key];
          html += '<div class="output-item">';
          html += '<div class="field-label">' + esc(key) + '</div>';
          if (typeof val === 'string' && (val.startsWith('http') && (val.includes('.mp4') || val.includes('.webm')))) {
            html += '<video src="' + esc(val) + '" controls style="max-width:100%; max-height:200px; border-radius:6px;"></video>';
          } else if (typeof val === 'string' && val.startsWith('http') && (val.includes('.jpg') || val.includes('.png') || val.includes('.webp') || val.includes('image'))) {
            html += '<img src="' + esc(val) + '" style="max-width:200px; border-radius:6px; cursor:pointer;" onclick="window.open(this.src)" />';
          } else if (typeof val === 'string' && val.length > 200) {
            html += '<div class="prompt-box" style="max-height:150px;">' + esc(val) + '</div>';
          } else if (typeof val === 'object') {
            html += '<div class="prompt-box" style="max-height:150px;">' + esc(prettyJ(val)) + '</div>';
          } else {
            html += '<div class="field-value">' + esc(String(val ?? '—')) + '</div>';
          }
          html += '</div>';
        });
        html += '</div>';
      }

      // USER MESSAGES (status messages shown to user during generation)
      if (userMsgs && userMsgs.length) {
        html += '<div class="detail-section">';
        html += '<h3>Status Messages Shown to User</h3>';
        userMsgs.forEach(msg => {
          const text = typeof msg === 'string' ? msg : (msg.text || msg.message || prettyJ(msg));
          html += '<div class="user-msg">' + esc(text) + '</div>';
        });
        html += '</div>';
      }

      // ERROR
      if (errorData) {
        html += '<div class="detail-section">';
        html += '<h3>Error</h3>';
        const errText = typeof errorData === 'string' ? errorData : prettyJ(errorData);
        html += '<div class="error-box">' + esc(errText) + '</div>';
        html += '</div>';
      }

      // PIPELINE STEPS
      if (steps && steps.length) {
        html += '<div class="detail-section">';
        html += '<h3>Pipeline Steps (' + steps.length + ')</h3>';
        html += '<div class="steps-timeline">';
        steps.forEach(s => {
          const p = s.mg_payload || {};
          const t = p.timing || {};
          const dur = t.duration_ms != null ? fmtDuration(t.duration_ms) : '—';
          html += '<div class="step-item">';
          html += '<div class="step-num">' + esc(String(s.mg_step_no ?? '?')) + '</div>';
          html += '<div class="step-info"><div class="step-type">' + esc(s.mg_step_type || 'unknown') + '</div><div class="step-dur">' + esc(dur) + '</div></div>';
          html += '</div>';
        });
        html += '</div>';
        html += '</div>';
      }

      // COST DETAILS
      if (costData.api_cost_usd != null) {
        html += '<div class="detail-section">';
        html += '<h3>Cost Breakdown</h3>';
        html += '<div class="field-grid">';
        html += fieldText('Provider Cost', '$' + (costData.api_cost_usd || 0).toFixed(4));
        html += fieldText('Sell Price', '$' + (costData.sell_price_usd || 0).toFixed(3));
        const profit = costData.profit_usd || 0;
        html += field('Profit', '<span style="color:' + (profit >= 0 ? 'var(--green)' : 'var(--red)') + '; font-weight:700;">$' + profit.toFixed(3) + '</span>');
        html += fieldText('Matchas Charged', costData.matchas_charged || 0);
        if (costData.total_cost_usd != null) html += fieldText('Total Cost (w/ fixed)', '$' + costData.total_cost_usd.toFixed(4));
        if (costData.profit_after_fixed_usd != null) {
          const paf = costData.profit_after_fixed_usd;
          html += field('Profit After Fixed', '<span style="color:' + (paf >= 0 ? 'var(--green)' : 'var(--red)') + ';">$' + paf.toFixed(3) + '</span>');
        }
        html += '</div>';
        html += '</div>';
      }

      // SETTINGS
      const settingKeys = Object.keys(settings);
      if (settingKeys.length) {
        html += '<div class="detail-section">';
        html += '<h3>Pipeline Settings</h3>';
        html += '<div class="field-grid">';
        settingKeys.forEach(key => {
          const val = settings[key];
          const display = typeof val === 'object' ? prettyJ(val) : String(val ?? '—');
          html += fieldText(key, display);
        });
        html += '</div>';
        html += '</div>';
      }

      // AUDIO
      if (vars.audio && Object.keys(vars.audio).length) {
        html += '<div class="detail-section">';
        html += '<h3>Audio</h3>';
        const audioData = vars.audio;
        if (typeof audioData === 'object') {
          Object.keys(audioData).forEach(key => {
            const val = audioData[key];
            if (typeof val === 'string' && val.startsWith('http')) {
              html += '<div class="field field--full"><div class="field-label">' + esc(key) + '</div><audio controls src="' + esc(val) + '" style="width:100%;"></audio></div>';
            } else if (val != null) {
              html += fieldText(key, typeof val === 'object' ? prettyJ(val) : String(val), true);
            }
          });
        }
        html += '</div>';
      }

      // META
      if (Object.keys(meta).length) {
        html += '<div class="detail-section">';
        html += '<h3>Metadata</h3>';
        html += '<div class="field-grid">';
        Object.keys(meta).forEach(key => {
          html += fieldText(key, typeof meta[key] === 'object' ? prettyJ(meta[key]) : String(meta[key] ?? '—'));
        });
        html += '</div>';
        html += '</div>';
      }

      // GENERATION IDS
      html += '<div class="detail-section">';
      html += '<h3>Identifiers</h3>';
      html += '<div class="field-grid">';
      html += fieldText('Generation ID', gen.mg_generation_id);
      html += fieldText('Session ID', gen.mg_session_id);
      html += fieldText('Pass ID', gen.mg_pass_id);
      if (gen.mg_parent_id) html += fieldText('Parent ID', gen.mg_parent_id);
      if (gen.mg_model) html += fieldText('Model', gen.mg_model);
      if (gen.mg_provider) html += fieldText('Provider', gen.mg_provider);
      if (gen.mg_platform) html += fieldText('Platform', gen.mg_platform);
      if (gen.mg_content_type) html += fieldText('Content Type', gen.mg_content_type);
      html += fieldText('Created At', fmtDate(gen.mg_created_at));
      if (gen.mg_updated_at) html += fieldText('Updated At', fmtDate(gen.mg_updated_at));
      html += '</div>';
      html += '</div>';

      // ASSETS (remaining ones)
      const shownAssetKeys = ['start_image_url', 'end_image_url', 'logo_image_url'];
      const remainingAssets = Object.keys(assets).filter(k => !shownAssetKeys.includes(k) && assets[k] != null);
      if (remainingAssets.length) {
        html += '<div class="detail-section">';
        html += '<h3>All Assets</h3>';
        html += '<div class="field-grid">';
        remainingAssets.forEach(key => {
          const val = assets[key];
          if (typeof val === 'string' && val.startsWith('http')) {
            html += field(key, '<a href="' + esc(val) + '" target="_blank" style="word-break:break-all;">' + esc(val) + '</a>', true);
          } else if (val != null && val !== '' && val !== 'null') {
            html += fieldText(key, typeof val === 'object' ? prettyJ(val) : String(val));
          }
        });
        html += '</div>';
        html += '</div>';
      }

      // Download JSON link
      html += '<div class="detail-section" style="border-bottom:none;">';
      html += '<a class="btn" href="/admin/mma/generation/' + encodeURIComponent(gen.mg_generation_id) + '.json" target="_blank">Download Full JSON</a>';
      html += '</div>';

      det.innerHTML = html;
    }

    function prettyJ(o) { try { return JSON.stringify(o, null, 2); } catch { return String(o); } }

    function closeLb() {
      document.getElementById('lbBackdrop').style.display = 'none';
      document.getElementById('lb').style.display = 'none';
      document.body.style.overflow = '';
      currentLbIndex = -1;
      const v = document.querySelector('#lbMedia video');
      if (v) { v.pause(); v.src = ''; }
    }

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeLb();
      if (currentLbIndex >= 0) {
        if (e.key === 'ArrowLeft') navLb(-1);
        if (e.key === 'ArrowRight') navLb(1);
      }
    });

    document.getElementById('filterPass').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); applyFilter(); }
    });

    // Initial load
    loadPage();
    </script>`
  );

  res.status(200).send(html);
});

// ---- Standalone generation page (for direct links) ----
router.get("/generation/:id", requireAuth, async (req, res) => {
  // Redirect to main page — the lightbox handles detail view now
  const id = String(req.params.id || "").trim();
  if (!id) return res.redirect("/admin/mma");

  const supabase = getSupabaseAdmin();
  if (!supabase) return res.status(500).send(layout("Error", `<div class="container"><div class="err">SUPABASE_NOT_CONFIGURED</div></div>`));

  const { data: gen, error: genErr } = await supabase
    .from("mega_generations")
    .select("*")
    .eq("mg_record_type", "generation")
    .eq("mg_generation_id", id)
    .maybeSingle();

  if (genErr || !gen) return res.status(404).send(layout("Not found", `<div class="container"><div class="err">Generation not found. <a href="/admin/mma">Back to list</a></div></div>`));

  const email = await resolveEmail(supabase, gen.mg_pass_id);

  const { data: steps } = await supabase
    .from("mega_generations")
    .select("mg_step_no, mg_step_type, mg_payload, mg_created_at")
    .eq("mg_record_type", "mma_step")
    .eq("mg_generation_id", id)
    .order("mg_step_no", { ascending: true });

  const vars = gen.mg_mma_vars || {};
  const inputs = vars.inputs || {};
  const assets = vars.assets || {};
  const prompts = vars.prompts || {};
  const outputs = vars.outputs || {};
  const settings = vars.settings || {};
  const userMsgs = vars.userMessages || [];
  const meta = vars.meta || {};
  const costData = gen.mg_cost_data || {};
  const status = gen.mg_mma_status || gen.mg_status || "—";
  const mode = gen.mg_mma_mode || "—";
  const outUrl = gen.mg_output_url || "";

  function statusTag(s) {
    let cls = "";
    if (s === "done" || s === "completed") cls = "tag--ok";
    else if (s === "error" || s === "failed") cls = "tag--err";
    return `<span class="tag ${cls}">${escapeHtml(s)}</span>`;
  }

  function fieldHtml(label, value) {
    return `<div class="field"><div class="field-label">${escapeHtml(label)}</div><div class="field-value">${value}</div></div>`;
  }

  // Media
  let mediaHtml = "";
  if (outUrl && mode === "video") {
    mediaHtml = `<video src="${escapeHtml(outUrl)}" controls autoplay loop playsinline style="max-width:100%; border-radius:10px;"></video>`;
  } else if (outUrl) {
    mediaHtml = `<img src="${escapeHtml(outUrl)}" style="max-width:100%; border-radius:10px;" />`;
  }

  // Steps HTML
  let stepsHtml = "";
  if (steps && steps.length) {
    stepsHtml = `<div class="detail-section"><h3>Pipeline Steps (${steps.length})</h3><div class="steps-timeline">`;
    for (const s of steps) {
      const p = s.mg_payload || {};
      const t = p.timing || {};
      const dur = t.duration_ms != null ? `${(t.duration_ms / 1000).toFixed(1)}s` : "—";
      stepsHtml += `<div class="step-item"><div class="step-num">${escapeHtml(String(s.mg_step_no ?? "?"))}</div><div class="step-info"><div class="step-type">${escapeHtml(s.mg_step_type || "unknown")}</div><div class="step-dur">${escapeHtml(dur)}</div></div></div>`;
    }
    stepsHtml += `</div></div>`;
  }

  const html = layout(
    `Generation ${id}`,
    `<div class="container">
      <div class="topbar">
        <a class="btn" href="/admin/mma">&larr; Back to All Generations</a>
        <div style="display:flex; gap:8px;">
          <a class="btn" href="/admin/mma/generation/${encodeURIComponent(id)}.json" target="_blank">Download JSON</a>
          <form method="POST" action="/admin/mma/logout" style="margin:0;"><button class="btn" type="submit">Logout</button></form>
        </div>
      </div>

      <div style="display:grid; grid-template-columns:1fr 1fr; gap:24px; margin-top:16px;">
        <div>
          ${mediaHtml || '<div class="card" style="text-align:center; padding:60px; color:var(--muted);">No output</div>'}
        </div>
        <div>
          <div class="card">
            <div style="margin-bottom:16px;">
              <div style="font-size:16px; font-weight:700;">${email ? escapeHtml(email) : '<span class="muted">Unknown user</span>'}</div>
              <div class="muted mono" style="margin-top:2px;">${escapeHtml(gen.mg_pass_id || "")}</div>
            </div>
            <div style="display:flex; gap:8px; margin-bottom:16px;">${statusTag(status)} <span class="tag ${mode === "video" ? "tag--video" : "tag--still"}">${escapeHtml(mode)}</span></div>
            <div class="field-grid">
              ${fieldHtml("Created", escapeHtml(new Date(gen.mg_created_at).toLocaleString()))}
              ${fieldHtml("Wait Time", gen.mg_latency_ms ? `${(gen.mg_latency_ms / 1000).toFixed(1)}s` : "—")}
              ${costData.matchas_charged != null ? fieldHtml("Cost", `${costData.matchas_charged} matchas`) : ""}
              ${costData.profit_usd != null ? fieldHtml("Profit", `<span style="color:${costData.profit_usd >= 0 ? "var(--green)" : "var(--red)"}">$${costData.profit_usd.toFixed(3)}</span>`) : ""}
            </div>
          </div>

          ${inputs.brief ? `<div class="card" style="margin-top:12px;"><h3 style="font-size:11px; text-transform:uppercase; color:var(--muted); margin-bottom:8px;">User Brief</h3><div class="prompt-box">${escapeHtml(inputs.brief)}</div></div>` : ""}

          ${gen.mg_prompt ? `<div class="card" style="margin-top:12px;"><h3 style="font-size:11px; text-transform:uppercase; color:var(--muted); margin-bottom:8px;">AI Prompt</h3><div class="prompt-box">${escapeHtml(gen.mg_prompt)}</div></div>` : ""}
        </div>
      </div>

      ${stepsHtml ? `<div class="card" style="margin-top:16px;">${stepsHtml}</div>` : ""}

      ${gen.mg_error ? `<div class="card" style="margin-top:16px;"><h3 style="font-size:11px; text-transform:uppercase; color:var(--muted); margin-bottom:8px;">Error</h3><div class="error-box">${escapeHtml(prettyJson(gen.mg_error))}</div></div>` : ""}
    </div>`
  );

  res.status(200).send(html);
});

// ---- Session Costs ----
router.get("/session-costs", requireAuth, async (req, res) => {
  const supabase = getSupabaseAdmin();
  if (!supabase) return res.status(500).send(layout("Error", `<div class="container"><div class="err">SUPABASE_NOT_CONFIGURED</div></div>`));

  const sessionId = (req.query.sessionId ? String(req.query.sessionId) : "").trim();
  const passId = (req.query.passId ? String(req.query.passId) : "").trim();
  const dateFrom = (req.query.from ? String(req.query.from) : "").trim();
  const dateTo = (req.query.to ? String(req.query.to) : "").trim();
  const limit = Math.max(1, Math.min(5000, Number(req.query.limit || 500) || 500));

  let q = supabase
    .from("mega_generations")
    .select("mg_generation_id, mg_session_id, mg_pass_id, mg_mma_mode, mg_mma_status, mg_cost_data, mg_delta, mg_created_at")
    .eq("mg_record_type", "generation")
    .order("mg_created_at", { ascending: false })
    .limit(limit);

  if (sessionId) q = q.eq("mg_session_id", sessionId);
  if (passId) q = q.eq("mg_pass_id", passId);
  if (dateFrom) q = q.gte("mg_created_at", dateFrom);
  if (dateTo) q = q.lte("mg_created_at", dateTo + "T23:59:59Z");

  const { data, error } = await q;
  if (error) return res.status(500).send(layout("Error", `<div class="container"><div class="err">${escapeHtml(error.message)}</div></div>`));

  const gens = data || [];
  const sessionMap = new Map();
  for (const g of gens) {
    const sid = g.mg_session_id || "unknown";
    if (!sessionMap.has(sid)) {
      sessionMap.set(sid, {
        session_id: sid, count: 0, stills: 0, videos: 0,
        total_api_cost: 0, total_cost_with_fixed: 0, total_sell_price: 0,
        total_profit: 0, total_profit_after_fixed: 0, total_matchas: 0,
        first_gen: null, last_gen: null,
      });
    }
    const s = sessionMap.get(sid);
    s.count++;
    if (g.mg_mma_mode === "still") s.stills++;
    else if (g.mg_mma_mode === "video") s.videos++;
    const c = g.mg_cost_data || {};
    s.total_api_cost += c.api_cost_usd || 0;
    s.total_cost_with_fixed += c.total_cost_usd || 0;
    s.total_sell_price += c.sell_price_usd || 0;
    s.total_profit += c.profit_usd || 0;
    s.total_profit_after_fixed += c.profit_after_fixed_usd || 0;
    s.total_matchas += c.matchas_charged || 0;
    const ts = g.mg_created_at || "";
    if (!s.first_gen || ts < s.first_gen) s.first_gen = ts;
    if (!s.last_gen || ts > s.last_gen) s.last_gen = ts;
  }

  let grandApi = 0, grandFixed = 0, grandSell = 0, grandProfit = 0, grandProfitFixed = 0, grandMatchas = 0, grandCount = 0;
  for (const s of sessionMap.values()) {
    grandApi += s.total_api_cost;
    grandFixed += s.total_cost_with_fixed;
    grandSell += s.total_sell_price;
    grandProfit += s.total_profit;
    grandProfitFixed += s.total_profit_after_fixed;
    grandMatchas += s.total_matchas;
    grandCount += s.count;
  }

  const usd = (n) => `$${n.toFixed(2)}`;
  const sessions = [...sessionMap.values()].sort((a, b) => (b.last_gen || "").localeCompare(a.last_gen || ""));

  const sessionRows = sessions.map((s) => `
    <tr>
      <td class="mono" style="font-size:10px;">${escapeHtml(s.session_id)}</td>
      <td>${s.count}</td>
      <td>${s.stills} / ${s.videos}</td>
      <td>${s.total_matchas}</td>
      <td class="mono">${usd(s.total_api_cost)}</td>
      <td class="mono">${usd(s.total_cost_with_fixed)}</td>
      <td class="mono">${usd(s.total_sell_price)}</td>
      <td class="mono" style="color:${s.total_profit >= 0 ? 'var(--green)' : 'var(--red)'}">${usd(s.total_profit)}</td>
      <td class="mono" style="color:${s.total_profit_after_fixed >= 0 ? 'var(--green)' : 'var(--red)'}">${usd(s.total_profit_after_fixed)}</td>
      <td class="mono" style="font-size:10px;">${escapeHtml((s.first_gen || "").slice(0, 16))}</td>
      <td class="mono" style="font-size:10px;">${escapeHtml((s.last_gen || "").slice(0, 16))}</td>
    </tr>
  `);

  const html = layout(
    "Session Costs",
    `<div class="container">
      <div class="topbar">
        <div>
          <a class="btn btn--sm" href="/admin/mma">&larr; Back to Generations</a>
          <h2 style="margin:8px 0 0 0; font-size:18px; font-weight:800;">Session Costs</h2>
          <div class="muted" style="font-size:11px;">Aggregated provider costs per session</div>
        </div>
        <form method="POST" action="/admin/mma/logout" style="margin:0;">
          <button class="btn" type="submit">Logout</button>
        </form>
      </div>

      <form method="GET" action="/admin/mma/session-costs" style="margin: 0 0 16px 0; display:flex; gap:8px; flex-wrap:wrap; align-items:end;">
        <div><label class="muted" style="font-size:10px;">Session ID</label><br/><input type="text" name="sessionId" value="${escapeHtml(sessionId)}" placeholder="Filter by session" style="width:200px;" /></div>
        <div><label class="muted" style="font-size:10px;">Pass ID</label><br/><input type="text" name="passId" value="${escapeHtml(passId)}" placeholder="Filter by pass" style="width:160px;" /></div>
        <div><label class="muted" style="font-size:10px;">From</label><br/><input type="text" name="from" value="${escapeHtml(dateFrom)}" placeholder="YYYY-MM-DD" style="width:120px;" /></div>
        <div><label class="muted" style="font-size:10px;">To</label><br/><input type="text" name="to" value="${escapeHtml(dateTo)}" placeholder="YYYY-MM-DD" style="width:120px;" /></div>
        <div><label class="muted" style="font-size:10px;">Limit</label><br/><input type="text" name="limit" value="${escapeHtml(String(limit))}" style="width:70px;" /></div>
        <button class="btn" type="submit">Apply</button>
        <a class="btn" href="/admin/mma/session-costs">Reset</a>
      </form>

      <div class="card" style="margin-bottom:16px;">
        <div class="muted" style="font-size:11px; margin-bottom:8px;">GRAND TOTALS — ${grandCount} generations across ${sessionMap.size} sessions</div>
        <div style="display:flex; gap:24px; flex-wrap:wrap;">
          <div><div class="field-label">Matchas</div><div style="font-size:18px; font-weight:700;">${grandMatchas}</div></div>
          <div><div class="field-label">Provider Cost</div><div style="font-size:18px; font-weight:700;">${usd(grandApi)}</div></div>
          <div><div class="field-label">Revenue</div><div style="font-size:18px; font-weight:700;">${usd(grandSell)}</div></div>
          <div><div class="field-label">Profit</div><div style="font-size:18px; font-weight:700; color:${grandProfit >= 0 ? 'var(--green)' : 'var(--red)'};">${usd(grandProfit)}</div></div>
          <div><div class="field-label">Profit (w/ fixed)</div><div style="font-size:18px; font-weight:700; color:${grandProfitFixed >= 0 ? 'var(--green)' : 'var(--red)'};">${usd(grandProfitFixed)}</div></div>
        </div>
      </div>

      <div class="card" style="overflow-x:auto;">
        <table style="width:100%; border-collapse:collapse;">
          <thead>
            <tr>
              <th style="text-align:left; font-size:9px; color:var(--muted); text-transform:uppercase; padding:8px 6px; border-bottom:2px solid var(--border);">Session</th>
              <th style="text-align:left; font-size:9px; color:var(--muted); text-transform:uppercase; padding:8px 6px; border-bottom:2px solid var(--border);">Gens</th>
              <th style="text-align:left; font-size:9px; color:var(--muted); text-transform:uppercase; padding:8px 6px; border-bottom:2px solid var(--border);">Still/Video</th>
              <th style="text-align:left; font-size:9px; color:var(--muted); text-transform:uppercase; padding:8px 6px; border-bottom:2px solid var(--border);">Matchas</th>
              <th style="text-align:left; font-size:9px; color:var(--muted); text-transform:uppercase; padding:8px 6px; border-bottom:2px solid var(--border);">Provider</th>
              <th style="text-align:left; font-size:9px; color:var(--muted); text-transform:uppercase; padding:8px 6px; border-bottom:2px solid var(--border);">Total</th>
              <th style="text-align:left; font-size:9px; color:var(--muted); text-transform:uppercase; padding:8px 6px; border-bottom:2px solid var(--border);">Revenue</th>
              <th style="text-align:left; font-size:9px; color:var(--muted); text-transform:uppercase; padding:8px 6px; border-bottom:2px solid var(--border);">Profit</th>
              <th style="text-align:left; font-size:9px; color:var(--muted); text-transform:uppercase; padding:8px 6px; border-bottom:2px solid var(--border);">Profit (fixed)</th>
              <th style="text-align:left; font-size:9px; color:var(--muted); text-transform:uppercase; padding:8px 6px; border-bottom:2px solid var(--border);">First</th>
              <th style="text-align:left; font-size:9px; color:var(--muted); text-transform:uppercase; padding:8px 6px; border-bottom:2px solid var(--border);">Last</th>
            </tr>
          </thead>
          <tbody>
            ${sessionRows.join("\n")}
          </tbody>
        </table>
      </div>
    </div>`
  );

  res.status(200).send(html);
});

// ---- Session Costs JSON API ----
router.get("/session-costs.json", requireAuth, async (req, res) => {
  const supabase = getSupabaseAdmin();
  if (!supabase) return res.status(500).json({ ok: false, error: "SUPABASE_NOT_CONFIGURED" });

  const sessionId = (req.query.sessionId ? String(req.query.sessionId) : "").trim();
  const passId = (req.query.passId ? String(req.query.passId) : "").trim();
  const dateFrom = (req.query.from ? String(req.query.from) : "").trim();
  const dateTo = (req.query.to ? String(req.query.to) : "").trim();
  const limit = Math.max(1, Math.min(5000, Number(req.query.limit || 500) || 500));

  let q = supabase
    .from("mega_generations")
    .select("mg_generation_id, mg_session_id, mg_pass_id, mg_mma_mode, mg_cost_data, mg_delta, mg_created_at")
    .eq("mg_record_type", "generation")
    .order("mg_created_at", { ascending: false })
    .limit(limit);

  if (sessionId) q = q.eq("mg_session_id", sessionId);
  if (passId) q = q.eq("mg_pass_id", passId);
  if (dateFrom) q = q.gte("mg_created_at", dateFrom);
  if (dateTo) q = q.lte("mg_created_at", dateTo + "T23:59:59Z");

  const { data, error } = await q;
  if (error) return res.status(500).json({ ok: false, error: error.message });

  const gens = data || [];
  const sessionMap = new Map();
  for (const g of gens) {
    const sid = g.mg_session_id || "unknown";
    if (!sessionMap.has(sid)) {
      sessionMap.set(sid, {
        session_id: sid, count: 0, stills: 0, videos: 0,
        total_api_cost: 0, total_cost_with_fixed: 0, total_sell_price: 0,
        total_profit: 0, total_profit_after_fixed: 0, total_matchas: 0,
      });
    }
    const s = sessionMap.get(sid);
    s.count++;
    if (g.mg_mma_mode === "still") s.stills++;
    else if (g.mg_mma_mode === "video") s.videos++;
    const c = g.mg_cost_data || {};
    s.total_api_cost += c.api_cost_usd || 0;
    s.total_cost_with_fixed += c.total_cost_usd || 0;
    s.total_sell_price += c.sell_price_usd || 0;
    s.total_profit += c.profit_usd || 0;
    s.total_profit_after_fixed += c.profit_after_fixed_usd || 0;
    s.total_matchas += c.matchas_charged || 0;
  }

  return res.json({ ok: true, sessions: [...sessionMap.values()], total_generations: gens.length });
});

router.get("/generation/:id.json", requireAuth, async (req, res) => {
  const supabase = getSupabaseAdmin();
  const id = String(req.params.id || "").trim();
  if (!supabase) return res.status(500).json({ ok: false, error: "SUPABASE_NOT_CONFIGURED" });

  const { data: gen } = await supabase
    .from("mega_generations")
    .select("*")
    .eq("mg_record_type", "generation")
    .eq("mg_generation_id", id)
    .maybeSingle();

  const { data: steps } = await supabase
    .from("mega_generations")
    .select("mg_step_no, mg_step_type, mg_payload, mg_created_at")
    .eq("mg_record_type", "mma_step")
    .eq("mg_generation_id", id)
    .order("mg_step_no", { ascending: true });

  const cfg = getMmaConfig();
  return res.json({ ok: true, generation: gen || null, steps: steps || [], mma_config: cfg });
});

export default router;
