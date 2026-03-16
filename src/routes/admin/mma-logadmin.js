import express from "express";
import crypto from "crypto";
import { getSupabaseAdmin } from "../../supabase.js";
import { getMmaConfig } from "../mma/mma-config.js";

const router = express.Router();

// ---- Config ----
// You asked for password Falta101M.
// ✅ Best practice: set MMA_LOGADMIN_PASSWORD in Render env.
// We default to Falta101M if missing (so it still works).
const PASSWORD = process.env.MMA_LOGADMIN_PASSWORD || "Falta101M";

// MUST set this in prod (Render env) so cookie tokens can’t be forged.
const COOKIE_SECRET =
  process.env.MMA_LOGADMIN_COOKIE_SECRET ||
  process.env.COOKIE_SECRET ||
  "dev_insecure_change_me";

const COOKIE_NAME = "mma_logadmin";

router.use(express.urlencoded({ extended: false }));

// ---- Helpers ----
function isHttps(req) {
  const xf = String(req.headers["x-forwarded-proto"] || "").toLowerCase();
  return req.secure || xf === "https";
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
  try {
    return JSON.stringify(obj, null, 2);
  } catch {
    return String(obj || "");
  }
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
  } catch {
    return null;
  }
}

function getCookie(req, name) {
  const raw = req.headers.cookie || "";
  const parts = raw.split(";").map((p) => p.trim());
  for (const p of parts) {
    const idx = p.indexOf("=");
    if (idx <= 0) continue;
    const k = p.slice(0, idx).trim();
    const v = p.slice(idx + 1).trim();
    if (k === name) return decodeURIComponent(v);
  }
  return null;
}

function setAuthCookie(res, req) {
  const token = signToken({
    v: 1,
    exp: Date.now() + 1000 * 60 * 60 * 12, // 12h
  });

  const flags = [
    `${COOKIE_NAME}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (isHttps(req)) flags.push("Secure");

  res.setHeader("Set-Cookie", flags.join("; "));
}

function clearAuthCookie(res) {
  res.setHeader(
    "Set-Cookie",
    `${COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`
  );
}

function isAuthed(req) {
  const token = getCookie(req, COOKIE_NAME);
  return !!verifyToken(token);
}

function requireAuth(req, res, next) {
  if (isAuthed(req)) return next();
  // Return 401 JSON for API/fetch requests, redirect for browser navigation
  const accept = String(req.headers.accept || "");
  if (req.path.startsWith("/api/") || accept.includes("application/json")) {
    return res.status(401).json({ ok: false, error: "Not authenticated" });
  }
  return res.redirect("/admin/mma/login");
}

function layout(title, bodyHtml, extra = "") {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <style>
    :root { --bg: #faf9f6; --text: #080a00; --muted: rgba(8,10,0,0.55); --border: rgba(8,10,0,0.08); --accent: #0b57d0; }
    * { box-sizing: border-box; }
    body { font-family: ui-sans-serif, system-ui, -apple-system; margin: 0; padding: 20px 24px; color: var(--text); background: var(--bg); }
    .topbar { display:flex; gap:12px; align-items:center; justify-content:space-between; margin-bottom:16px; }
    .btn { border:1px solid var(--border); background:#fff; padding:7px 14px; border-radius:0; cursor:pointer; font-size:12px; font-weight:600; letter-spacing:0.02em; text-transform:uppercase; }
    .btn:hover { background:rgba(8,10,0,0.04); }
    .btn--accent { background:var(--accent); color:#fff; border-color:var(--accent); }
    .btn--accent:hover { opacity:0.9; }
    .muted { color: var(--muted); }
    table { width:100%; border-collapse: collapse; }
    th, td { border-bottom: 1px solid var(--border); padding: 10px 8px; vertical-align: top; }
    th { text-align:left; font-size:10px; color:var(--muted); text-transform:uppercase; letter-spacing:0.06em; }
    .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size:11px; white-space: pre-wrap; }
    .tag { display:inline-block; padding:2px 8px; border-radius:0; font-size:10px; border:1px solid var(--border); text-transform:uppercase; letter-spacing:0.04em; font-weight:600; }
    .tag--ok { border-color:#1a7f37; color:#1a7f37; }
    .tag--err { border-color:#b00020; color:#b00020; }
    .tag--video { border-color:#7c3aed; color:#7c3aed; }
    .tag--still { border-color:var(--accent); color:var(--accent); }
    .bad { border-color:#ffb3b3; background:#fff5f5; }
    details { border:1px solid var(--border); padding:10px; margin:10px 0; }
    summary { cursor:pointer; font-weight:600; font-size:12px; }
    .row { display:flex; gap:16px; flex-wrap:wrap; }
    .card { border:1px solid var(--border); padding:14px; min-width:320px; flex:1; }
    input[type="text"], input[type="password"] { padding:8px 10px; border:1px solid var(--border); border-radius:0; width: 320px; font-size:13px; background:#fff; }
    input:focus { outline:2px solid var(--accent); outline-offset:-1px; }
    .err { color:#b00020; }
    a { color:var(--accent); text-decoration:none; }
    a:hover { text-decoration:underline; }

    /* ---- Grid ---- */
    .gen-grid { display:grid; grid-template-columns:repeat(16,1fr); gap:3px; margin-top:12px; }
    @media(max-width:1400px){ .gen-grid { grid-template-columns:repeat(12,1fr); } }
    @media(max-width:1000px){ .gen-grid { grid-template-columns:repeat(8,1fr); } }
    @media(max-width:600px){ .gen-grid { grid-template-columns:repeat(4,1fr); } }

    .gen-cell { position:relative; aspect-ratio:1; overflow:hidden; cursor:pointer; background:rgba(8,10,0,0.04); }
    .gen-cell img, .gen-cell video { width:100%; height:100%; object-fit:cover; display:block; transition:transform 180ms ease; }
    .gen-cell:hover img, .gen-cell:hover video { transform:scale(1.06); }
    .gen-cell .gen-badge { position:absolute; top:3px; right:3px; font-size:8px; padding:1px 4px; background:rgba(0,0,0,0.6); color:#fff; text-transform:uppercase; font-weight:700; letter-spacing:0.04em; pointer-events:none; }
    .gen-cell .gen-badge--video { background:rgba(124,58,237,0.85); }
    .gen-cell .gen-status { position:absolute; bottom:3px; left:3px; font-size:7px; padding:1px 3px; background:rgba(0,0,0,0.55); color:#fff; text-transform:uppercase; font-weight:600; pointer-events:none; }
    .gen-cell .gen-status--err { background:rgba(176,0,32,0.8); }
    .gen-cell--empty { display:flex; align-items:center; justify-content:center; }
    .gen-cell--empty span { font-size:9px; color:var(--muted); text-align:center; padding:4px; }

    /* ---- Lightbox ---- */
    .lb-backdrop { position:fixed; inset:0; z-index:998; background:rgba(0,0,0,0.88); animation:lb-in 200ms ease forwards; }
    .lb { position:fixed; inset:0; z-index:999; display:flex; overflow:auto; }
    @keyframes lb-in { from{opacity:0} to{opacity:1} }

    .lb-left { flex:0 0 50%; max-width:50%; display:flex; align-items:center; justify-content:center; background:#000; min-height:100vh; }
    .lb-left img, .lb-left video { max-width:96%; max-height:96vh; object-fit:contain; }
    .lb-right { flex:0 0 50%; max-width:50%; background:var(--bg); overflow-y:auto; padding:28px 32px; min-height:100vh; }
    @media(max-width:900px){
      .lb { flex-direction:column; }
      .lb-left, .lb-right { flex:none; max-width:100%; min-height:auto; }
      .lb-left { height:50vh; }
    }

    .lb-close { position:fixed; top:16px; right:20px; z-index:1000; background:none; border:none; color:#fff; font-size:28px; cursor:pointer; opacity:0.7; }
    .lb-close:hover { opacity:1; }

    .lb-section { margin-bottom:18px; }
    .lb-section h4 { margin:0 0 6px; font-size:11px; text-transform:uppercase; letter-spacing:0.06em; color:var(--muted); }
    .lb-kv { display:grid; grid-template-columns: auto 1fr; gap:4px 12px; font-size:12px; }
    .lb-kv dt { font-weight:600; white-space:nowrap; }
    .lb-kv dd { margin:0; word-break:break-all; }

    .lb-steps { width:100%; border-collapse:collapse; font-size:11px; }
    .lb-steps th { text-align:left; font-size:9px; color:var(--muted); text-transform:uppercase; padding:4px 6px; border-bottom:1px solid var(--border); }
    .lb-steps td { padding:4px 6px; border-bottom:1px solid var(--border); vertical-align:top; }

    .lb-prompt { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:11px; line-height:1.5; white-space:pre-wrap; background:rgba(8,10,0,0.03); padding:10px; margin:0; max-height:200px; overflow-y:auto; }

    .lb-vars-grid { display:grid; grid-template-columns:1fr 1fr; gap:10px; }
    @media(max-width:900px){ .lb-vars-grid { grid-template-columns:1fr; } }
    .lb-vars-box { background:rgba(8,10,0,0.03); padding:8px; overflow:auto; max-height:180px; }
    .lb-vars-box h5 { margin:0 0 4px; font-size:10px; text-transform:uppercase; color:var(--muted); letter-spacing:0.04em; }
    .lb-vars-box pre { margin:0; font-size:10px; white-space:pre-wrap; word-break:break-word; }
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
    `
    <div class="topbar">
      <h2>MMA LogAdmin</h2>
      <div class="muted">Backend: mina-editorial-ai-api</div>
    </div>

    <form method="POST" action="/admin/mma/login">
      <div style="margin:12px 0;">
        <label class="muted">Password</label><br/>
        <input type="password" name="password" placeholder="Password" />
      </div>
      ${err ? `<div class="err">${escapeHtml(err)}</div>` : ""}
      <button class="btn" type="submit">Login</button>
    </form>
  `
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

// ---- JSON API for infinite scroll ----
router.get("/api/generations", requireAuth, async (req, res) => {
  const supabase = getSupabaseAdmin();
  if (!supabase) return res.status(500).json({ ok: false, error: "SUPABASE_NOT_CONFIGURED" });

  const passId = (req.query.passId || "").trim();
  const cursor = (req.query.cursor || "").trim(); // ISO timestamp for keyset pagination
  const limit = Math.max(1, Math.min(100, Number(req.query.limit || 60) || 60));

  let q = supabase
    .from("mega_generations")
    .select("mg_generation_id, mg_pass_id, mg_parent_id, mg_mma_mode, mg_mma_status, mg_status, mg_output_url, mg_prompt, mg_created_at")
    .eq("mg_record_type", "generation")
    .order("mg_created_at", { ascending: false })
    .limit(limit);

  if (passId) q = q.eq("mg_pass_id", passId);
  if (cursor) q = q.lt("mg_created_at", cursor);

  const { data, error } = await q;
  if (error) return res.status(500).json({ ok: false, error: error.message });

  const items = (data || []).map((g) => ({
    id: g.mg_generation_id,
    passId: g.mg_pass_id || "",
    parentId: g.mg_parent_id || "",
    mode: g.mg_mma_mode || "",
    status: g.mg_mma_status || g.mg_status || "",
    url: g.mg_output_url || "",
    prompt: g.mg_prompt || "",
    createdAt: g.mg_created_at || "",
  }));

  const nextCursor = items.length === limit ? items[items.length - 1].createdAt : null;
  return res.json({ ok: true, items, nextCursor });
});

// ---- JSON API for single generation detail ----
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

  const { data: steps } = await supabase
    .from("mega_generations")
    .select("mg_step_no, mg_step_type, mg_payload, mg_created_at")
    .eq("mg_record_type", "mma_step")
    .eq("mg_generation_id", id)
    .order("mg_step_no", { ascending: true });

  return res.json({ ok: true, generation: gen, steps: steps || [] });
});

// ---- Main admin page (visual grid + infinite scroll + lightbox) ----
router.get("/", requireAuth, async (req, res) => {
  const passId = (req.query.passId ? String(req.query.passId) : "").trim();

  const html = layout(
    "MMA LogAdmin",
    `
    <div class="topbar">
      <div>
        <h2 style="margin:0; font-size:16px; font-weight:700; letter-spacing:0.02em;">MMA LogAdmin</h2>
        <div class="muted" style="font-size:11px;">All generations across all users</div>
      </div>
      <div style="display:flex; gap:8px; align-items:center;">
        <a class="btn btn--accent" href="/admin/mma/session-costs">Costs</a>
        <form method="POST" action="/admin/mma/logout" style="margin:0;">
          <button class="btn" type="submit">Logout</button>
        </form>
      </div>
    </div>

    <div style="display:flex; gap:8px; margin-bottom:14px; align-items:center; flex-wrap:wrap;">
      <input type="text" id="filterPass" value="${escapeHtml(passId)}" placeholder="Filter by passId" style="width:240px;" />
      <button class="btn" onclick="resetAndLoad()">Apply</button>
      <button class="btn" onclick="document.getElementById('filterPass').value='';resetAndLoad()">Reset</button>
      <span id="genCount" class="muted" style="font-size:11px; margin-left:8px;"></span>
    </div>

    <div class="gen-grid" id="grid"></div>
    <div id="loadMore" style="text-align:center; padding:20px;">
      <span class="muted" style="font-size:11px;">Loading...</span>
    </div>

    <!-- Lightbox -->
    <div id="lbBackdrop" class="lb-backdrop" style="display:none;" onclick="closeLb()"></div>
    <div id="lb" class="lb" style="display:none;">
      <button class="lb-close" onclick="closeLb()">&times;</button>
      <div class="lb-left" id="lbMedia"></div>
      <div class="lb-right" id="lbDetails"></div>
    </div>
  `,
    `<script>
    let items = [];
    let cursor = null;
    let loading = false;
    let exhausted = false;

    function getPassFilter() {
      return (document.getElementById('filterPass').value || '').trim();
    }

    async function loadPage() {
      if (loading || exhausted) return;
      loading = true;
      const params = new URLSearchParams({ limit: '60' });
      const pf = getPassFilter();
      if (pf) params.set('passId', pf);
      if (cursor) params.set('cursor', cursor);

      try {
        const r = await fetch('/admin/mma/api/generations?' + params, { credentials: 'same-origin' });
        if (r.status === 401) { window.location.href = '/admin/mma/login'; return; }
        if (!r.ok) { loading = false; document.getElementById('loadMore').innerHTML = '<span class="muted" style="font-size:11px;color:#b00020;">Error loading (status ' + r.status + ')</span>'; return; }
        const j = await r.json();
        if (!j.ok) { loading = false; document.getElementById('loadMore').innerHTML = '<span class="muted" style="font-size:11px;color:#b00020;">API error: ' + esc(j.error||'unknown') + '</span>'; return; }
        items = items.concat(j.items);
        cursor = j.nextCursor;
        if (!j.nextCursor) exhausted = true;
        renderItems(j.items);
        document.getElementById('genCount').textContent = items.length + ' generations';
        document.getElementById('loadMore').style.display = exhausted ? 'none' : 'block';
        if (!j.items.length && !items.length) { document.getElementById('loadMore').innerHTML = '<span class="muted" style="font-size:11px;">No generations found</span>'; }
      } catch(e) { console.error(e); document.getElementById('loadMore').innerHTML = '<span class="muted" style="font-size:11px;color:#b00020;">Network error — check console</span>'; }
      loading = false;
    }

    function resetAndLoad() {
      items = []; cursor = null; exhausted = false;
      document.getElementById('grid').innerHTML = '';
      loadPage();
    }

    function renderItems(batch) {
      const grid = document.getElementById('grid');
      batch.forEach((g, i) => {
        const cell = document.createElement('div');
        cell.className = 'gen-cell';
        cell.onclick = () => openLb(g.id);

        const isVideo = g.mode === 'video';
        const hasUrl = !!g.url;
        const statusOk = g.status === 'done' || g.status === 'completed';

        if (hasUrl && isVideo) {
          cell.innerHTML = '<video src="' + esc(g.url) + '" muted loop playsinline preload="metadata" loading="lazy"></video>';
          cell.onmouseenter = () => { const v = cell.querySelector('video'); if(v) v.play().catch(()=>{}); };
          cell.onmouseleave = () => { const v = cell.querySelector('video'); if(v) { v.pause(); v.currentTime=0; } };
        } else if (hasUrl) {
          cell.innerHTML = '<img src="' + esc(g.url) + '" loading="lazy" decoding="async" />';
        } else {
          cell.className += ' gen-cell--empty';
          cell.innerHTML = '<span>' + esc(g.status || 'no output') + '</span>';
        }

        // Mode badge
        if (isVideo) cell.innerHTML += '<span class="gen-badge gen-badge--video">VID</span>';

        // Status badge
        if (!statusOk && g.status) {
          const cls = g.status === 'error' || g.status === 'failed' ? ' gen-status--err' : '';
          cell.innerHTML += '<span class="gen-status' + cls + '">' + esc(g.status) + '</span>';
        }

        grid.appendChild(cell);
      });
    }

    function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

    // Infinite scroll via IntersectionObserver
    const io = new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting) loadPage();
    }, { rootMargin: '600px' });
    io.observe(document.getElementById('loadMore'));

    // ---- Lightbox ----
    async function openLb(id) {
      document.getElementById('lbBackdrop').style.display = '';
      document.getElementById('lb').style.display = '';
      document.body.style.overflow = 'hidden';
      document.getElementById('lbMedia').innerHTML = '<span class="muted" style="color:#999;">Loading...</span>';
      document.getElementById('lbDetails').innerHTML = '';

      try {
        const r = await fetch('/admin/mma/api/generation/' + encodeURIComponent(id));
        const j = await r.json();
        if (!j.ok) { closeLb(); return; }
        renderLb(j.generation, j.steps);
      } catch(e) { closeLb(); }
    }

    function renderLb(gen, steps) {
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
        media.innerHTML = '<span class="muted" style="color:#999;">No output</span>';
      }

      const status = gen.mg_mma_status || gen.mg_status || '—';
      const mode = gen.mg_mma_mode || '—';
      const statusCls = status === 'done' || status === 'completed' ? 'tag--ok' : status === 'error' || status === 'failed' ? 'tag--err' : '';
      const modeCls = mode === 'video' ? 'tag--video' : mode === 'still' ? 'tag--still' : '';

      // Cost data
      const c = gen.mg_cost_data || {};
      const costHtml = c.api_cost_usd != null ? '<div class="lb-section"><h4>Cost</h4><div class="lb-kv"><dt>Provider</dt><dd>$' + (c.api_cost_usd||0).toFixed(3) + '</dd><dt>Sell Price</dt><dd>$' + (c.sell_price_usd||0).toFixed(3) + '</dd><dt>Profit</dt><dd style="color:' + ((c.profit_usd||0) >= 0 ? '#1a7f37' : '#b00020') + '">$' + (c.profit_usd||0).toFixed(3) + '</dd><dt>Matchas</dt><dd>' + (c.matchas_charged||0) + '</dd></div></div>' : '';

      // MMA Vars sections
      const vars = gen.mg_mma_vars || {};
      const varSections = ['inputs','assets','settings','prompts','outputs','audio'].filter(k => vars[k]);
      const varsHtml = varSections.length ? '<div class="lb-section"><h4>Pipeline Data</h4><div class="lb-vars-grid">' + varSections.map(k => '<div class="lb-vars-box"><h5>' + esc(k) + '</h5><pre>' + esc(prettyJ(vars[k])) + '</pre></div>').join('') + '</div></div>' : '';

      // Steps
      let stepsHtml = '';
      if (steps && steps.length) {
        stepsHtml = '<div class="lb-section"><h4>Steps (' + steps.length + ')</h4><table class="lb-steps"><thead><tr><th>#</th><th>Type</th><th>Duration</th></tr></thead><tbody>';
        steps.forEach(s => {
          const p = s.mg_payload || {};
          const t = p.timing || {};
          const dur = t.duration_ms != null ? (t.duration_ms / 1000).toFixed(1) + 's' : '—';
          stepsHtml += '<tr><td>' + esc(String(s.mg_step_no ?? '')) + '</td><td style="font-weight:600;">' + esc(s.mg_step_type || '') + '</td><td>' + dur + '</td></tr>';
        });
        stepsHtml += '</tbody></table></div>';
      }

      // Error
      const errHtml = gen.mg_error ? '<div class="lb-section"><h4>Error</h4><pre class="lb-prompt" style="color:#b00020;">' + esc(prettyJ(gen.mg_error)) + '</pre></div>' : '';

      det.innerHTML =
        '<div class="lb-section"><h4>Generation</h4><div class="lb-kv">' +
          '<dt>ID</dt><dd class="mono" style="font-size:10px;">' + esc(gen.mg_generation_id || '') + '</dd>' +
          '<dt>Status</dt><dd><span class="tag ' + statusCls + '">' + esc(status) + '</span></dd>' +
          '<dt>Mode</dt><dd><span class="tag ' + modeCls + '">' + esc(mode) + '</span></dd>' +
          '<dt>Created</dt><dd>' + esc(fmtDate(gen.mg_created_at)) + '</dd>' +
          '<dt>Pass</dt><dd class="mono" style="font-size:10px;"><a href="/admin/mma?passId=' + encodeURIComponent(gen.mg_pass_id||'') + '">' + esc(gen.mg_pass_id || '') + '</a></dd>' +
          (gen.mg_parent_id ? '<dt>Parent</dt><dd class="mono" style="font-size:10px;">' + esc(gen.mg_parent_id) + '</dd>' : '') +
        '</div></div>' +
        costHtml +
        '<div class="lb-section"><h4>Prompt</h4><pre class="lb-prompt">' + esc(gen.mg_prompt || '(none)') + '</pre></div>' +
        errHtml +
        stepsHtml +
        varsHtml +
        '<div style="margin-top:12px;"><a class="btn" href="/admin/mma/generation/' + encodeURIComponent(gen.mg_generation_id) + '.json" target="_blank">Download JSON</a></div>';
    }

    function prettyJ(o) { try { return JSON.stringify(o, null, 2); } catch { return String(o); } }
    function fmtDate(s) { if (!s) return '—'; try { return new Date(s).toLocaleString(); } catch { return s; } }

    function closeLb() {
      document.getElementById('lbBackdrop').style.display = 'none';
      document.getElementById('lb').style.display = 'none';
      document.body.style.overflow = '';
      // Stop any playing video
      const v = document.querySelector('#lbMedia video');
      if (v) { v.pause(); v.src = ''; }
    }

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeLb();
    });

    // Enter key in filter input
    document.getElementById('filterPass').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); resetAndLoad(); }
    });

    // Initial load
    loadPage();
    </script>`
  );

  res.status(200).send(html);
});

router.get("/generation/:id", requireAuth, async (req, res) => {
  const supabase = getSupabaseAdmin();
  if (!supabase) {
    return res.status(500).send(layout("Error", `<div class="err">SUPABASE_NOT_CONFIGURED</div>`));
  }

  const id = String(req.params.id || "").trim();
  if (!id) return res.redirect("/admin/mma");

  const { data: gen, error: genErr } = await supabase
    .from("mega_generations")
    .select("*")
    .eq("mg_record_type", "generation")
    .eq("mg_generation_id", id)
    .maybeSingle();

  if (genErr || !gen) {
    return res.status(404).send(layout("Not found", `<div class="err">Generation not found.</div>`));
  }

  const { data: steps, error: stepsErr } = await supabase
    .from("mega_generations")
    .select("mg_step_no, mg_step_type, mg_payload, mg_created_at")
    .eq("mg_record_type", "mma_step")
    .eq("mg_generation_id", id)
    .order("mg_step_no", { ascending: true });

  if (stepsErr) {
    return res.status(500).send(layout("Error", `<div class="err">${escapeHtml(stepsErr.message)}</div>`));
  }

  const cfg = getMmaConfig();
  const vars = gen.mg_mma_vars || {};

  const stepsRows = (steps || []).map((s) => {
    const p = s.mg_payload || {};
    const timing = p?.timing || {};
    const started = timing.started_at || "";
    const ended = timing.ended_at || "";
    const dur = timing.duration_ms != null ? `${timing.duration_ms}ms` : "";
    return `
      <tr>
        <td class="mono">${escapeHtml(String(s.mg_step_no ?? ""))}</td>
        <td class="mono">${escapeHtml(s.mg_step_type || "")}</td>
        <td class="mono">${escapeHtml(started)}</td>
        <td class="mono">${escapeHtml(ended)}</td>
        <td class="mono">${escapeHtml(dur)}</td>
        <td>
          <details>
            <summary>View payload</summary>
            <pre class="mono">${escapeHtml(prettyJson(p))}</pre>
          </details>
        </td>
      </tr>
    `;
  });

  const out = String(gen.mg_output_url || "");
  const badUrl =
    out && !out.includes("assets.faltastudio.com") && !out.includes("r2") ? "bad" : "";

  const html = layout(
    `MMA Generation ${id}`,
    `
    <div class="topbar">
      <div>
        <a href="/admin/mma">← Back</a>
        <h2 style="margin:8px 0 0 0;">Generation: <span class="mono">${escapeHtml(id)}</span></h2>
        <div class="muted">Pass: <span class="mono">${escapeHtml(gen.mg_pass_id || "")}</span></div>
      </div>
      <div style="display:flex; gap:10px;">
        <a class="btn" href="/admin/mma/generation/${encodeURIComponent(id)}.json">Download JSON</a>
        <form method="POST" action="/admin/mma/logout" style="margin:0;">
          <button class="btn" type="submit">Logout</button>
        </form>
      </div>
    </div>

    <div class="row">
      <div class="card">
        <div><b>Status:</b> <span class="tag">${escapeHtml(gen.mg_mma_status || gen.mg_status || "—")}</span></div>
        <div><b>Mode:</b> <span class="tag">${escapeHtml(gen.mg_mma_mode || "—")}</span></div>
        <div><b>Created:</b> <span class="mono">${escapeHtml(gen.mg_created_at || "")}</span></div>
        <div><b>Parent:</b> <span class="mono">${escapeHtml(gen.mg_parent_id || "")}</span></div>
        <div style="margin-top:10px;"><b>Output URL:</b></div>
        <div class="mono ${badUrl}">
          ${out ? `<a href="${escapeHtml(out)}" target="_blank" rel="noreferrer">${escapeHtml(out)}</a>` : "—"}
          ${badUrl ? `<div class="muted">⚠️ not assets.faltastudio.com (check R2_PUBLIC_BASE_URL)</div>` : ""}
        </div>
        ${gen.mg_error ? `<details><summary>Error</summary><pre class="mono">${escapeHtml(prettyJson(gen.mg_error))}</pre></details>` : ""}
      </div>

      <div class="card">
        <div><b>Final prompt</b></div>
        <pre class="mono">${escapeHtml(gen.mg_prompt || "")}</pre>
      </div>
    </div>

    <details open>
      <summary>MMA Vars (inputs/assets/settings/prompts/outputs)</summary>
      <pre class="mono">${escapeHtml(prettyJson(vars))}</pre>
    </details>

    <details>
      <summary>MMA Config snapshot (current runtime)</summary>
      <pre class="mono">${escapeHtml(prettyJson(cfg))}</pre>
    </details>

    <h3>Steps</h3>
    <table>
      <thead>
        <tr>
          <th>#</th>
          <th>Type</th>
          <th>Started</th>
          <th>Ended</th>
          <th>Duration</th>
          <th>Payload</th>
        </tr>
      </thead>
      <tbody>
        ${stepsRows.join("\n")}
      </tbody>
    </table>
  `
  );

  res.status(200).send(html);
});

// ---- Session Costs ----
router.get("/session-costs", requireAuth, async (req, res) => {
  const supabase = getSupabaseAdmin();
  if (!supabase) {
    return res.status(500).send(layout("Error", `<div class="err">SUPABASE_NOT_CONFIGURED</div>`));
  }

  const sessionId = (req.query.sessionId ? String(req.query.sessionId) : "").trim();
  const passId = (req.query.passId ? String(req.query.passId) : "").trim();
  const dateFrom = (req.query.from ? String(req.query.from) : "").trim();
  const dateTo = (req.query.to ? String(req.query.to) : "").trim();
  const limit = Math.max(1, Math.min(5000, Number(req.query.limit || 500) || 500));

  let q = supabase
    .from("mega_generations")
    .select(
      "mg_generation_id, mg_session_id, mg_pass_id, mg_mma_mode, mg_mma_status, mg_cost_data, mg_delta, mg_created_at"
    )
    .eq("mg_record_type", "generation")
    .order("mg_created_at", { ascending: false })
    .limit(limit);

  if (sessionId) q = q.eq("mg_session_id", sessionId);
  if (passId) q = q.eq("mg_pass_id", passId);
  if (dateFrom) q = q.gte("mg_created_at", dateFrom);
  if (dateTo) q = q.lte("mg_created_at", dateTo + "T23:59:59Z");

  const { data, error } = await q;
  if (error) {
    return res.status(500).send(layout("Error", `<div class="err">${escapeHtml(error.message)}</div>`));
  }

  const gens = data || [];

  // Aggregate by session
  const sessionMap = new Map();
  for (const g of gens) {
    const sid = g.mg_session_id || "unknown";
    if (!sessionMap.has(sid)) {
      sessionMap.set(sid, {
        session_id: sid,
        count: 0,
        stills: 0,
        videos: 0,
        total_api_cost: 0,
        total_cost_with_fixed: 0,
        total_sell_price: 0,
        total_profit: 0,
        total_profit_after_fixed: 0,
        total_matchas: 0,
        first_gen: null,
        last_gen: null,
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

  // Grand totals
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
      <td class="mono">${escapeHtml(s.session_id)}</td>
      <td>${s.count}</td>
      <td>${s.stills} / ${s.videos}</td>
      <td>${s.total_matchas}</td>
      <td class="mono">${usd(s.total_api_cost)}</td>
      <td class="mono">${usd(s.total_cost_with_fixed)}</td>
      <td class="mono">${usd(s.total_sell_price)}</td>
      <td class="mono" style="color:${s.total_profit >= 0 ? '#1a7f37' : '#b00020'}">${usd(s.total_profit)}</td>
      <td class="mono" style="color:${s.total_profit_after_fixed >= 0 ? '#1a7f37' : '#b00020'}">${usd(s.total_profit_after_fixed)}</td>
      <td class="mono">${escapeHtml((s.first_gen || "").slice(0, 16))}</td>
      <td class="mono">${escapeHtml((s.last_gen || "").slice(0, 16))}</td>
    </tr>
  `);

  const html = layout(
    "Session Costs",
    `
    <div class="topbar">
      <div>
        <a href="/admin/mma">&larr; Back to Generations</a>
        <h2 style="margin:8px 0 0 0;">Session Costs</h2>
        <div class="muted">Aggregated provider costs per session from mg_cost_data</div>
      </div>
      <form method="POST" action="/admin/mma/logout" style="margin:0;">
        <button class="btn" type="submit">Logout</button>
      </form>
    </div>

    <form method="GET" action="/admin/mma/session-costs" style="margin: 0 0 16px 0; display:flex; gap:8px; flex-wrap:wrap; align-items:end;">
      <div>
        <label class="muted" style="font-size:11px;">Session ID</label><br/>
        <input type="text" name="sessionId" value="${escapeHtml(sessionId)}" placeholder="Filter by session" style="width:220px;" />
      </div>
      <div>
        <label class="muted" style="font-size:11px;">Pass ID</label><br/>
        <input type="text" name="passId" value="${escapeHtml(passId)}" placeholder="Filter by pass" style="width:180px;" />
      </div>
      <div>
        <label class="muted" style="font-size:11px;">From</label><br/>
        <input type="text" name="from" value="${escapeHtml(dateFrom)}" placeholder="YYYY-MM-DD" style="width:130px;" />
      </div>
      <div>
        <label class="muted" style="font-size:11px;">To</label><br/>
        <input type="text" name="to" value="${escapeHtml(dateTo)}" placeholder="YYYY-MM-DD" style="width:130px;" />
      </div>
      <div>
        <label class="muted" style="font-size:11px;">Limit</label><br/>
        <input type="text" name="limit" value="${escapeHtml(String(limit))}" style="width:70px;" />
      </div>
      <button class="btn" type="submit">Apply</button>
      <a class="btn" href="/admin/mma/session-costs" style="display:inline-block;">Reset</a>
    </form>

    <div class="row" style="margin-bottom:16px;">
      <div class="card">
        <div class="muted" style="font-size:11px;">GRAND TOTALS (${grandCount} generations across ${sessionMap.size} sessions)</div>
        <div style="display:flex; gap:24px; flex-wrap:wrap; margin-top:8px;">
          <div><b>Matchas:</b> ${grandMatchas}</div>
          <div><b>Provider:</b> ${usd(grandApi)}</div>
          <div><b>With Fixed:</b> ${usd(grandFixed)}</div>
          <div><b>Revenue:</b> ${usd(grandSell)}</div>
          <div style="color:${grandProfit >= 0 ? '#1a7f37' : '#b00020'}"><b>Profit:</b> ${usd(grandProfit)}</div>
          <div style="color:${grandProfitFixed >= 0 ? '#1a7f37' : '#b00020'}"><b>Profit (w/ fixed):</b> ${usd(grandProfitFixed)}</div>
        </div>
      </div>
    </div>

    <table>
      <thead>
        <tr>
          <th>Session</th>
          <th>Gens</th>
          <th>Still/Video</th>
          <th>Matchas</th>
          <th>Provider $</th>
          <th>Total $ (w/ fixed)</th>
          <th>Revenue $</th>
          <th>Profit $</th>
          <th>Profit (w/ fixed)</th>
          <th>First</th>
          <th>Last</th>
        </tr>
      </thead>
      <tbody>
        ${sessionRows.join("\n")}
      </tbody>
    </table>
  `
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
    .select(
      "mg_generation_id, mg_session_id, mg_pass_id, mg_mma_mode, mg_cost_data, mg_delta, mg_created_at"
    )
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
