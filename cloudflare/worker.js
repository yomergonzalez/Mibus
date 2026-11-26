// Mi bus · A Coruña — Cloudflare Worker (proxy de iTranvías + app + skill de Alexa + servidor MCP)
// Sirve la app, hace de proxy a iTranvías (tiempo real de la Compañía de Tranvías),
// responde a la skill clásica de Alexa (/alexa) y expone un servidor MCP (/mcp) para Alexa+ y otros clientes,
// más un MCP público y genérico (/mcp/public) sin datos personales.
// Despliegue: push a main → GitHub Actions (wrangler).

const API = 'https://itranvias.com/queryitr_v3.php';
const UPSTREAM_HEADERS = {
  'Accept': 'application/json',
  'Referer': 'https://itranvias.com/',
  'User-Agent': 'Mozilla/5.0 (mibus-coruna)'
};

export default {
  async fetch(req, env, ctx) {
    ENV = env;
    const res = await handle(req, env, ctx);
    if (UPSTREAM_ERR.length && env && env.DB && ctx) {
      const errs = UPSTREAM_ERR.splice(0);
      ctx.waitUntil(logUpstream(env, new URL(req.url).pathname, errs));
    }
    return res;
  }
};

async function handle(req, env, ctx) {
    const url = new URL(req.url);

    // Diagnóstico: qué devuelve iTranvías a este Worker, sin filtrar. /debug/upstream?id=40
    if (url.pathname === '/debug/upstream') {
      const id = parseInt(url.searchParams.get('id'), 10) || 40;
      const t0 = Date.now();
      try {
        const r = await fetch(API + '?dato=' + id + '&func=0', { headers: UPSTREAM_HEADERS, cache: 'no-store' });
        const text = await r.text();
        return json({ parada: id, status: r.status, ms: Date.now() - t0, headers: Object.fromEntries(r.headers), colo: (req.cf && req.cf.colo) || null, body: text.slice(0, 1500) });
      } catch (e) {
        return json({ parada: id, error: String((e && e.message) || e), ms: Date.now() - t0 }, 502);
      }
    }

    if (url.pathname === '/api/stop') {
      const id = parseInt(url.searchParams.get('id'), 10);
      if (!id || id < 1 || id > 99999) return json({ error: 'parada inválida' }, 400);
      // Caché de 60 s compartida con Alexa y los MCP. Sin reintento: con el límite de
      // iTranvías (4/min) un reintento solo gasta cupo; si falla, pubStop ya devuelve
      // el último dato bueno.
      try {
        const d = await pubStop(id);
        return json({ parada: id, at: d.at, lineas: d.lineas, ...(d.stale ? { stale: true, edad_s: d.age } : {}), ...(d.programado ? { programado: true, tipo: d.tipo } : {}) });
      } catch (e) {
        return json({ error: 'iTranvías no responde', detalle: String((e && e.message) || e) }, 502);
      }
    }

    if (url.pathname === '/api/meta') {
      try { return json(await getMeta(), 200, 'public, max-age=86400'); } catch (e) { return json({ lines: {}, stops: {} }, 200); }
    }

    if (url.pathname === '/api/plan') {
      const trip = url.searchParams.get('trip') === 'vuelta' ? 'vuelta' : 'ida';
      const time = parseHHMM(url.searchParams.get('time') || '');
      const date = (url.searchParams.get('date') || madridNow().date).replace(/-/g, '');
      if (time == null || !/^\d{8}$/.test(date)) return json({ error: 'parámetros inválidos' }, 400);
      try { return json(await plan(trip, time, date)); } catch (e) { return json({ error: 'iTranvías no responde' }, 502); }
    }

    if (url.pathname === '/alexa' && req.method === 'POST') {
      const body = await req.clone().json().catch(() => null);
      ALEXA_TRACE = [];
      const trace = ALEXA_TRACE;
      const res = await alexa(req, env, 'alexa');
      ALEXA_TRACE = null;
      if (env && env.DB && ctx) ctx.waitUntil(logAlexa(env, body, res.clone(), trace));
      return res;
    }

    // Prueba rápida sin Alexa: /alexa/test?intent=ConsultaIntent&linea=14&parada=...&hora=...
    if (url.pathname === '/alexa/test') {
      const slots = {};
      for (const k of ['linea', 'parada', 'numero', 'hora', 'dia']) if (url.searchParams.get(k)) slots[k] = url.searchParams.get(k);
      return new Response(await runIntent(url.searchParams.get('intent'), slots, url.searchParams.get('src') || 'alexa'), { headers: { 'content-type': 'text/plain; charset=utf-8' } });
    }

    // ---------- MCP (Alexa+ add-on y cualquier cliente MCP) ----------
    if (url.pathname === '/mcp/public') return mcpPublic(req, env, url);
    if (url.pathname === '/mcp') {
      const reqText = await req.clone().text().catch(() => '');
      ALEXA_TRACE = [];
      const trace = ALEXA_TRACE;
      const res = await mcp(req, env, url);
      ALEXA_TRACE = null;
      if (env && env.DB && ctx) ctx.waitUntil(logMcp(env, req, reqText, res.clone(), trace));
      return res;
    }
    if (url.pathname === '/.well-known/oauth-protected-resource' || url.pathname === '/.well-known/oauth-protected-resource/mcp') {
      return json({ resource: url.origin + '/mcp', authorization_servers: [url.origin], scopes_supported: [MCP_SCOPE], bearer_methods_supported: ['header'], resource_name: 'Mi bus A Coruña' });
    }
    if (url.pathname === '/.well-known/oauth-authorization-server') {
      return json({
        issuer: url.origin, token_endpoint: url.origin + '/oauth/token',
        grant_types_supported: ['client_credentials'], token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
        scopes_supported: [MCP_SCOPE], response_types_supported: [], code_challenge_methods_supported: ['S256']
      });
    }
    if (url.pathname === '/oauth/token') return oauthToken(req, env, url);

    if (url.pathname === '/manifest.webmanifest') {
      return new Response(JSON.stringify({
        name: 'Mi bus Coruña', short_name: 'Mi bus', start_url: '/', display: 'standalone',
        background_color: '#c8102e', theme_color: '#c8102e',
        icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml' }]
      }), { headers: { 'content-type': 'application/manifest+json' } });
    }

    if (url.pathname === '/icon.svg') {
      return new Response(ICON, { headers: { 'content-type': 'image/svg+xml', 'cache-control': 'public, max-age=604800' } });
    }

    return serveApp();
}

// La web es una sola: index.html de GitHub Pages. El Worker la sirve tal cual en su dominio
// (misma configuración guardada en el navegador) y solo usa la copia vieja (HTML) si Pages falla.
var APP_URL = 'https://yomergonzalez.github.io/Mibus/';
async function serveApp() {
  const headers = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' };
  try {
    const html = await pubMemo('app:html', 5 * 60e3, async () => {
      const r = await fetch(APP_URL, { headers: { 'Accept': 'text/html' } });
      if (!r.ok) throw new Error('Pages ' + r.status);
      const t = await r.text();
      if (t.indexOf('const PROXY') < 0) throw new Error('Pages: no parece la app');
      return t;
    });
    return new Response(html, { headers });
  } catch (e) {
    return new Response(HTML, { headers });
  }
}

function json(obj, status = 200, cache = 'no-store') {
  return new Response(JSON.stringify(obj), {
    status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': cache, 'access-control-allow-origin': '*' }
  });
}

const ICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" rx="112" fill="#c8102e"/><rect x="128" y="120" width="256" height="240" rx="40" fill="#fff"/><rect x="156" y="150" width="200" height="100" rx="14" fill="#c8102e"/><circle cx="184" cy="310" r="20" fill="#c8102e"/><circle cx="328" cy="310" r="20" fill="#c8102e"/><rect x="160" y="360" width="44" height="40" rx="10" fill="#fff"/><rect x="308" y="360" width="44" height="40" rx="10" fill="#fff"/></svg>';

const HTML = String.raw`<!DOCTYPE html>
<html lang="es"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Mi bus Coruña</title>
<meta name="theme-color" content="#c8102e">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="Mi bus">
<link rel="manifest" href="/manifest.webmanifest">
<link rel="icon" href="/icon.svg">
<link rel="apple-touch-icon" href="/icon.svg">
<link href="https://fonts.googleapis.com/css2?family=Figtree:wght@500;700;800&display=swap" rel="stylesheet">
<style>
:root{color-scheme:light dark;--red:#c8102e;--bg:light-dark(#f4f2ef,#121214);--card:light-dark(#fff,#1d1d21);--ink:light-dark(#141414,#f2f2f2);--mute:light-dark(#6b6b6b,#a3a3a8);--line:light-dark(#e6e3df,#2c2c31)}
*{box-sizing:border-box;min-width:0}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.45 Figtree,system-ui,sans-serif;-webkit-tap-highlight-color:transparent}
header{background:var(--red);color:#fff;padding:max(18px,env(safe-area-inset-top)) 18px 16px}
.top{display:flex;align-items:center;justify-content:space-between;gap:12px;max-width:640px;margin:0 auto}
h1{font-size:30px;line-height:1.05;margin:0;font-weight:800}
.clock{font-size:15px;opacity:.9;font-variant-numeric:tabular-nums}
.seg{display:grid;grid-template-columns:1fr 1fr;gap:4px;background:rgba(0,0,0,.18);border-radius:14px;padding:4px;max-width:640px;margin:14px auto 0}
.seg button{border:0;border-radius:10px;min-height:44px;font:700 16px Figtree,system-ui,sans-serif;color:#fff;background:transparent}
.seg button[aria-pressed=true]{background:#fff;color:var(--red)}
.status{display:flex;align-items:center;justify-content:space-between;gap:10px;max-width:640px;margin:10px auto 0;font-size:14px;opacity:.92}
.status button{border:1.5px solid rgba(255,255,255,.7);background:transparent;color:#fff;border-radius:999px;min-height:36px;padding:0 14px;font:700 14px Figtree,system-ui,sans-serif}
main{max-width:640px;margin:0 auto;padding:16px 14px 24px;display:grid;gap:14px}
.card{background:var(--card);border-radius:18px;padding:14px 16px 6px;border:1px solid var(--line)}
.card h2{font-size:18px;margin:0;line-height:1.2}
.sub{color:var(--mute);font-size:13px;margin:2px 0 8px}
.row{display:grid;grid-template-columns:auto 1fr auto;align-items:center;gap:12px;padding:10px 0;border-top:1px solid var(--line)}
.chip{min-width:48px;height:34px;padding:0 8px;border-radius:9px;display:grid;place-items:center;color:#fff;font-weight:800;font-size:16px}
.min{font-size:30px;font-weight:800;line-height:1;font-variant-numeric:tabular-nums;white-space:nowrap}
.min small{font-size:15px;font-weight:700;margin-left:3px}
.min.now{color:var(--red)}
.at{text-align:right;white-space:nowrap}
.at b{display:block;font-size:20px;font-variant-numeric:tabular-nums}
.at span{color:var(--mute);font-size:13px}
.empty{color:var(--mute);padding:12px 0;border-top:1px solid var(--line)}
.err{color:var(--red);font-size:14px;padding:6px 0}
.edit{display:none;border-top:1px solid var(--line);padding:10px 0;gap:8px;flex-wrap:wrap;align-items:center}
body.editing .edit{display:flex}
.tg{border:1.5px solid var(--line);background:transparent;color:var(--ink);border-radius:999px;min-height:40px;padding:0 14px;font:700 14px Figtree,system-ui,sans-serif}
.tg[aria-pressed=true]{background:var(--ink);color:var(--card);border-color:var(--ink)}
.tg.rm{color:var(--red);border-color:var(--red);margin-left:auto}
.tools{max-width:640px;margin:0 auto;padding:0 14px 30px;display:grid;gap:10px}
.tools>button{min-height:48px;border-radius:14px;border:1.5px solid var(--line);background:var(--card);color:var(--ink);font:700 16px Figtree,system-ui,sans-serif}
.add{display:none;gap:8px}
body.editing .add{display:grid}
.add input{min-height:48px;border-radius:12px;border:1.5px solid var(--line);background:var(--card);color:var(--ink);font:16px Figtree,system-ui,sans-serif;padding:0 14px}
.res button{display:block;width:100%;text-align:left;min-height:44px;border:0;border-bottom:1px solid var(--line);background:transparent;color:var(--ink);font:16px Figtree,system-ui,sans-serif;padding:8px 4px}
.res small{color:var(--mute)}
footer{color:var(--mute);font-size:13px;text-align:center;padding:0 16px 28px}
:focus-visible{outline:3px solid #ffb400;outline-offset:2px}
@media (prefers-reduced-motion:no-preference){.min.now{animation:p 1.4s ease-in-out infinite}@keyframes p{50%{opacity:.45}}}
</style></head><body>
<header>
  <div class="top"><h1>Mi bus</h1><div class="clock" id="clock"></div></div>
  <div class="seg" role="group" aria-label="Trayecto">
    <button id="t-ida" aria-pressed="true">Ir al trabajo</button>
    <button id="t-vuelta" aria-pressed="false">Volver a casa</button>
  </div>
  <div class="status"><span id="upd">Cargando…</span><button id="refresh">Actualizar</button></div>
</header>
<main id="list"></main>
<div class="tools">
  <div class="add">
    <input id="q" type="search" placeholder="Añadir parada: busca por calle (p. ej. Nelle)" autocomplete="off">
    <div class="res" id="res"></div>
    <button class="tg" id="reset">Restablecer paradas por defecto</button>
  </div>
  <button id="editbtn">Editar paradas</button>
</div>
<footer>Tiempos en vivo de iTranvías (Compañía de Tranvías de A Coruña). Se actualiza cada 30 s.</footer>
<script>
{
const DEF = {
  ida: [{ id: 50, lines: [1200] }, { id: 94, lines: [1400] }],
  vuelta: [{ id: 40, lines: [1200, 1400] }, { id: 269, lines: [1400] }, { id: 120, lines: [1400, 1500, 2000] }]
};
const FALL_STOPS = { 50: 'Rda. de Nelle, 109', 94: 'Rda. de Outeiro, 249', 40: 'Av. de Oza, 7', 269: 'Rda. de Outeiro, Pérez Ardá', 120: 'Rda. de Outeiro, 126' };
const FALL_LINES = { 1200: { n: '12', c: '#019f02' }, 1400: { n: '14' }, 1500: { n: '12A', c: '#4db94c' }, 2000: { n: '20' } };
let meta = { lines: {}, stops: {} };
let cfg = load();
let tab = new Date().getHours() < 15 ? 'ida' : 'vuelta';
const data = {};
let lastAt = 0;
const $ = (s) => document.getElementById(s);
const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const hhmm = (t) => new Date(t).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });

function load() {
  try { const s = JSON.parse(localStorage.getItem('mibus-cfg-v2')); if (s && s.ida && s.vuelta) return s; } catch (e) {}
  return JSON.parse(JSON.stringify(DEF));
}
function save() { try { localStorage.setItem('mibus-cfg-v2', JSON.stringify(cfg)); } catch (e) {} }
function stopName(id) { return meta.stops[id] || FALL_STOPS[id] || ('Parada ' + id); }
function lineInfo(id) {
  const m = meta.lines[id] || FALL_LINES[id] || {};
  const n = m.n || (Math.floor(id / 100) + (id % 100 ? '·' + (id % 100) : ''));
  const c = m.c && /^#[0-9a-f]{3,8}$/i.test(m.c) ? m.c : '#c8102e';
  return { n: n, c: c };
}

function render() {
  $('t-ida').setAttribute('aria-pressed', tab === 'ida');
  $('t-vuelta').setAttribute('aria-pressed', tab === 'vuelta');
  const stops = cfg[tab];
  if (!stops.length) { $('list').innerHTML = '<div class="card"><p class="sub">No hay paradas. Pulsa «Editar paradas» para añadir una.</p></div>'; return; }
  $('list').innerHTML = stops.map((s, i) => {
    const d = data[s.id];
    let rows = '';
    if (!d) rows = '<div class="empty">Consultando…</div>';
    else {
      const elapsed = (Date.now() - d.at) / 60000;
      const buses = [];
      for (const l of d.lineas || []) {
        if (s.lines && s.lines.indexOf(l.linea) < 0) continue;
        for (const b of l.buses || []) buses.push({ linea: l.linea, t: (String(b.tiempo).indexOf('<') >= 0 ? 0 : (parseFloat(String(b.tiempo).replace(/[^0-9.]/g, '')) || 0)), dist: Number(b.distancia) || 0 });
      }
      buses.sort((a, b) => a.t - b.t);
      rows = buses.slice(0, 4).map((b) => {
        const li = lineInfo(b.linea);
        const left = Math.max(0, Math.round(b.t - elapsed));
        const km = b.dist >= 1000 ? (b.dist / 1000).toLocaleString('es-ES', { maximumFractionDigits: 1 }) + ' km' : b.dist + ' m';
        return '<div class="row"><div class="chip" style="background:' + li.c + '">' + esc(li.n) + '</div>' +
          (left <= 1 ? '<div class="min now">Llegando</div>' : '<div class="min">' + left + '<small>min</small></div>') +
          '<div class="at"><b>' + hhmm(d.at + b.t * 60000) + '</b><span>a ' + esc(km) + '</span></div></div>';
      }).join('') || '<div class="empty">Sin buses próximos ahora mismo.</div>';
      if (d.err) rows = '<div class="err">No se pudo actualizar; mostrando el último dato.</div>' + rows;
    }
    const present = new Set((d && d.lineas || []).map((l) => l.linea));
    (s.lines || []).forEach((x) => present.add(x));
    const toggles = [...present].sort((a, b) => a - b).map((lid) =>
      '<button class="tg" data-i="' + i + '" data-l="' + lid + '" aria-pressed="' + (!s.lines || s.lines.indexOf(lid) >= 0) + '">Línea ' + esc(lineInfo(lid).n) + '</button>').join('');
    return '<section class="card"><h2>' + esc(stopName(s.id)) + '</h2><div class="sub">Parada ' + esc(s.id) +
      (s.lines ? ' · líneas ' + s.lines.map((x) => esc(lineInfo(x).n)).join(', ') : ' · todas las líneas') + '</div>' +
      rows + '<div class="edit">' + toggles + '<button class="tg rm" data-rm="' + i + '">Quitar</button></div></section>';
  }).join('');
}

async function refresh() {
  const stops = cfg[tab];
  $('upd').textContent = 'Actualizando…';
  await Promise.all(stops.map((s) => fetch('/api/stop?id=' + s.id).then((r) => r.json()).then((j) => {
    if (j.error) throw new Error(j.error);
    data[s.id] = { at: j.at || Date.now(), lineas: j.lineas };
  }).catch(() => { data[s.id] = Object.assign({ at: Date.now(), lineas: [] }, data[s.id], { err: true }); })));
  lastAt = Date.now();
  tick();
  render();
}

function tick() {
  $('clock').textContent = hhmm(Date.now());
  if (lastAt) {
    const s = Math.round((Date.now() - lastAt) / 1000);
    $('upd').textContent = 'Actualizado ' + (s < 5 ? 'ahora' : 'hace ' + s + ' s');
  }
}

$('t-ida').onclick = () => { tab = 'ida'; render(); refresh(); };
$('t-vuelta').onclick = () => { tab = 'vuelta'; render(); refresh(); };
$('refresh').onclick = refresh;
$('editbtn').onclick = () => { const on = document.body.classList.toggle('editing'); $('editbtn').textContent = on ? 'Listo' : 'Editar paradas'; };
$('reset').onclick = () => { cfg = JSON.parse(JSON.stringify(DEF)); save(); render(); refresh(); };
$('list').onclick = (e) => {
  const b = e.target.closest('button'); if (!b) return;
  if (b.dataset.rm != null) { cfg[tab].splice(Number(b.dataset.rm), 1); save(); render(); return; }
  if (b.dataset.l) {
    const s = cfg[tab][Number(b.dataset.i)], lid = Number(b.dataset.l);
    const d = data[s.id];
    let set = s.lines ? s.lines.slice() : ((d && d.lineas) || []).map((l) => l.linea);
    set = set.indexOf(lid) >= 0 ? set.filter((x) => x !== lid) : set.concat(lid);
    s.lines = set.length ? set : null;
    save(); render();
  }
};
$('q').oninput = () => {
  const q = norm($('q').value.trim());
  if (q.length < 2) { $('res').innerHTML = ''; return; }
  const hits = Object.keys(meta.stops).filter((id) => norm(meta.stops[id]).indexOf(q) >= 0 || id === q).slice(0, 8);
  $('res').innerHTML = hits.map((id) => '<button data-add="' + esc(id) + '">' + esc(meta.stops[id]) + ' <small>· parada ' + esc(id) + '</small></button>').join('') ||
    '<p class="sub">Sin resultados.</p>';
};
$('res').onclick = (e) => {
  const b = e.target.closest('button[data-add]'); if (!b) return;
  cfg[tab].push({ id: Number(b.dataset.add), lines: null }); save();
  $('q').value = ''; $('res').innerHTML = ''; render(); refresh();
};
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });

render();
refresh();
setInterval(refresh, 30000);
setInterval(() => { tick(); }, 1000);
setInterval(render, 15000);
fetch('/api/meta').then((r) => r.json()).then((m) => { meta = m || meta; render(); }).catch(() => {});
}
</script>
</body></html>`;


// ---------- Alexa ----------
// Paradas y líneas favoritas para Alexa (las mismas que la app por defecto).
const ALEXA_TRIPS = {
  // walk = minutos andando hasta la parada (desde casa en la ida, desde El Corte Inglés en la vuelta)
  ida: [{ id: 50, name: 'Ronda de Nelle 109', lines: [1200], walk: 4, main: true }, { id: 94, name: 'Ronda de Outeiro 249', lines: [1400], walk: 5 }],
  vuelta: [
    { id: 40, name: 'Avenida de Oza 7', lines: [1200, 1400], walk: 7 },
    { id: 269, name: 'Ronda de Outeiro, Pérez Ardá', lines: [1400], walk: 5 },
    { id: 120, name: 'Ronda de Outeiro 126', lines: [1400, 1500, 2000], walk: 6 }
  ]
};
const LINE_NAMES = { 1200: '12', 1400: '14', 1500: '12 A', 2000: '20', 2200: '22' };

function alexaSay(text, end = true, attrs) {
  const out = { version: '1.0', response: { outputSpeech: { type: 'PlainText', text }, shouldEndSession: end } };
  if (attrs) out.sessionAttributes = attrs;
  return new Response(JSON.stringify(out), { headers: { 'content-type': 'application/json; charset=utf-8' } });
}

function parseMin(v) {
  if (String(v).indexOf('<') >= 0) return 0;
  const n = parseFloat(String(v == null ? '' : v).replace(/[^0-9.]/g, ''));
  return isFinite(n) ? n : 0;
}

async function nextBuses(trip) {
  const all = [];
  await Promise.all(ALEXA_TRIPS[trip].map(async (s) => {
    try {
      const d = await pubStop(s.id);
      const j = stopAsUpstream(d);
      traceUpstream(s.id, j);
      for (const l of (j.buses && j.buses.lineas) || []) {
        if (s.lines.indexOf(l.linea) < 0) continue;
        for (const b of l.buses || []) {
          const min = Math.round(parseMin(b.tiempo));
          if (min >= s.walk) all.push({ line: LINE_NAMES[l.linea] || String(Math.floor(l.linea / 100)), min, stop: s.name, leave: min - s.walk, main: !!s.main, prog: d.programado ? 'all' : b.programado ? 'part' : '' });
        }
      }
    } catch (e) {}
  }));
  return all.sort((a, b) => a.leave - b.leave || a.min - b.min);
}

let NOW_MIN = 0;
function at(m) { return 'a ' + say(fmt(NOW_MIN + m)); }
function when(m) { return m <= 1 ? 'ahora mismo, está llegando' : at(m) + ', en ' + m + ' minutos'; }

async function alexa(req, env, src = 'alexa') {
  let body = {};
  try { body = await req.json(); } catch (e) { return new Response('bad request', { status: 400 }); }
  const appId = body.session && body.session.application && body.session.application.applicationId;
  if (env && env.ALEXA_SKILL_ID && appId !== env.ALEXA_SKILL_ID) return new Response('forbidden', { status: 403 });

  const type = body.request && body.request.type;
  const intent = body.request && body.request.intent && body.request.intent.name;
  if (type === 'SessionEndedRequest') return alexaSay('', true);
  if (intent === 'AMAZON.StopIntent' || intent === 'AMAZON.CancelIntent') return alexaSay('Vale.');
  if (intent === 'AMAZON.HelpIntent') return alexaSay('Puedes decir: cuándo pasa el bus, el bus a casa, cuándo pasa el 14, o qué buses pasan por Outeiro 126.', false);

  if (intent === 'LlegarIntent' || intent === 'SalirIntent') return alexaPlan(body.request.intent, intent === 'LlegarIntent' ? 'ida' : 'vuelta');
  if (intent === 'PasaIntent') return alexaPasa(body.request.intent, src);
  if (intent === 'ConsultaIntent') return alexaConsulta(body.request.intent, (body.session && body.session.attributes) || {}, src);
  return alexaCommute(intent === 'IdaIntent' ? 'ida' : intent === 'VueltaIntent' ? 'vuelta' : null, src);
}

// Trayecto por defecto. El Echo está en casa: desde Alexa siempre la ida (paradas de casa).
// Desde el MCP (móvil, cualquier sitio): ida antes de las 15:00, vuelta después.
function defaultTrip(src, min) { return src === 'alexa' ? 'ida' : min < 15 * 60 ? 'ida' : 'vuelta'; }

// Respuesta por defecto: próximos buses del trayecto.
async function alexaCommute(trip, src = 'alexa') {
  NOW_MIN = madridNow().min;
  if (!trip) trip = defaultTrip(src, NOW_MIN);
  const buses = await nextBuses(trip);
  if (!buses.length) return alexaSay('Ahora mismo no tengo buses a los que te dé tiempo a llegar, o iTranvías no responde. Prueba en un momento.');
  const note = buses.some((x) => x.prog === 'all') ? PROG_NOTE : buses.some((x) => x.prog) ? PROG_PART : '';
  const main = buses.filter((x) => x.main);
  if (main.length) {
    const m = main[0], alt = buses.find((x) => !x.main && x.leave < m.leave);
    let t = 'El próximo ' + m.line + ' en ' + m.stop + ' pasa ' + when(m.min) + '.';
    if (main[1]) t += ' El siguiente pasa ' + at(main[1].min) + '.';
    if (alt) t += ' Si quieres algo antes, el ' + alt.line + ' en ' + alt.stop + ' pasa ' + at(alt.min) + '.';
    return alexaSay(t + note);
  }
  const [a, b, c] = buses;
  let text = 'El próximo que te da tiempo es el ' + a.line + ' en ' + a.stop + ', ' + when(a.min) + '.';
  if (b) text += ' Después, el ' + b.line + ' en ' + b.stop + ', ' + at(b.min) + '.';
  if (c) text += ' Y el ' + c.line + ' en ' + c.stop + ', ' + at(c.min) + '.';
  return alexaSay(text + note);
}


// ---------- Planificador con horario programado ----------
// off = minutos desde la salida en cabecera hasta la parada (calibrado con Google Maps; * = estimado)
// walkTo = andando hasta la parada; ride = minutos en bus; walkFrom = andando desde la bajada al destino
const PLAN = {
  ida: [
    { id: 50, stop: 'Ronda de Nelle 109', line: 1200, dir: 'ida', off: 14, walkTo: 4, ride: 8, walkFrom: 6, main: true },
    { id: 94, stop: 'Ronda de Outeiro 249', line: 1400, dir: 'ida', off: 17, walkTo: 5, ride: 10, walkFrom: 5 }
  ],
  vuelta: [
    { id: 40, stop: 'Avenida de Oza 7', line: 1200, dir: 'vuelta', off: 15, walkTo: 7, ride: 7, walkFrom: 5 },
    { id: 269, stop: 'Ronda de Outeiro, Pérez Ardá', line: 1400, dir: 'vuelta', off: 23, walkTo: 5, ride: 10, walkFrom: 5 },
    { id: 40, stop: 'Avenida de Oza 7', line: 1400, dir: 'vuelta', off: 18, walkTo: 7, ride: 15, walkFrom: 5 },
    { id: 120, stop: 'Ronda de Outeiro 126', line: 1400, dir: 'vuelta', off: 27, walkTo: 8, ride: 7, walkFrom: 5 },
    { id: 120, stop: 'Ronda de Outeiro 126', line: 1500, dir: 'vuelta', off: 38, walkTo: 8, ride: 5, walkFrom: 5 },
    { id: 120, stop: 'Ronda de Outeiro 126', line: 2000, dir: 'vuelta', off: 30, walkTo: 8, ride: 4, walkFrom: 5 }
  ]
};

function parseHHMM(v) {
  const m = String(v).match(/^(\d{1,2})(?::?(\d{2}))?$/);
  if (!m) return null;
  const h = Number(m[1]), mi = Number(m[2] || 0);
  return h < 24 && mi < 60 ? h * 60 + mi : null;
}
function fmt(m) { m = ((m % 1440) + 1440) % 1440; return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0'); }
function madridNow(at) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(at ? new Date(at) : new Date()).map((x) => [x.type, x.value]));
  return { date: p.year + '-' + p.month + '-' + p.day, min: Number(p.hour) * 60 + Number(p.minute) };
}

// caches.default no hace nada en *.workers.dev: antes cada llamada iba a iTranvías y
// gastaba cupo. Ahora: memoria del isolate → D1 → iTranvías (12 h).
function departures(line, date) {
  return sharedCache('dep:' + line + ':' + date, 12 * 3600e3, () => fetchDepartures(line, date));
}

async function fetchDepartures(line, date) {
  const { j } = await upstreamJSON(API + '?func=8&dato=' + line + '&fecha=' + date, { headers: UPSTREAM_HEADERS });
  const sv = (j.servicios && j.servicios[0]) || {};
  const toMin = (a) => (a || []).map((n) => Math.floor(Number(n) / 100) * 60 + (Number(n) % 100));
  return { tipo: sv.tipo || '', ida: toMin(sv.ida), vuelta: toMin(sv.vuelta) };
}

// ida: time = hora a la que quieres llegar. vuelta: time = hora a la que sales del trabajo.
async function plan(trip, time, date) {
  const entries = PLAN[trip];
  // Primero el horario por parada del GTFS (exacto y sin gastar cupo de iTranvías).
  // Si no cubre la fecha, salidas desde cabecera (func=8) + desfase calibrado.
  const g = {};
  let tipo = '';
  await Promise.all([...new Set(entries.map((e) => e.id))].map(async (id) => {
    const st = await gtfsStopTimes(id, date).catch(() => null);
    if (st) { g[id] = st.lines; tipo = st.tipo; }
  }));
  const lines = [...new Set(entries.filter((e) => !g[e.id]).map((e) => e.line))];
  const deps = {};
  await Promise.all(lines.map(async (l) => { deps[l] = await pubDepartures(l, date); }));
  const opts = [];
  for (const e of entries) {
    const times = g[e.id] ? (g[e.id][e.line] || []) : (deps[e.line][e.dir] || []).map((d) => d + e.off);
    for (const bus of times) {
      const leave = bus - e.walkTo, arrive = bus + e.ride + e.walkFrom;
      if (trip === 'ida' ? arrive <= time : leave >= time) opts.push({ line: LINE_NAMES[e.line] || String(e.line / 100), lineId: e.line, stop: e.stop, main: !!e.main, leave, bus, arrive });
    }
  }
  if (trip === 'ida') opts.sort((a, b) => b.arrive - a.arrive || b.leave - a.leave);
  else opts.sort((a, b) => a.arrive - b.arrive || a.leave - b.leave);
  if (!tipo) tipo = (deps[lines[0]] && deps[lines[0]].tipo) || '';
  return {
    trip, date, tipo, time: fmt(time),
    options: opts.slice(0, 6).map((o) => ({ line: o.line, lineId: o.lineId, stop: o.stop, main: o.main, leave: fmt(o.leave), bus: fmt(o.bus), arrive: fmt(o.arrive) }))
  };
}

function slot(intent, name) { return intent && intent.slots && intent.slots[name] && intent.slots[name].value; }
function say(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  const h12 = h % 12 === 0 ? 12 : h % 12;
  const part = h < 6 ? ' de la madrugada' : h < 13 ? '' : h < 21 ? ' de la tarde' : ' de la noche';
  const base = (h12 === 1 ? 'la 1' : 'las ' + h12) + (m === 0 ? '' : m === 30 ? ' y media' : m === 15 ? ' y cuarto' : ' y ' + m);
  return base + part;
}

async function alexaPlan(intent, trip) {
  const hora = slot(intent, 'hora');
  const now = madridNow();
  const t = parseHHMM(String(hora || '').replace(/[^0-9:]/g, ''));
  if (t == null) return alexaSay(trip === 'ida' ? '¿A qué hora quieres llegar? Por ejemplo: para llegar a las diez.' : '¿A qué hora sales? Por ejemplo: si salgo a las seis.', false);
  let date = slot(intent, 'dia') || now.date;
  if (!slot(intent, 'dia') && t < now.min - 30) {
    const d = new Date(now.date + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + 1); date = d.toISOString().slice(0, 10);
  }
  let p;
  try { p = await plan(trip, t, date.replace(/-/g, '')); } catch (e) { return alexaSay('No he podido consultar los horarios de iTranvías. Prueba en un momento.'); }
  if (!p.options.length) return alexaSay('No encuentro buses para esa hora.');
  const best = p.options.find((o) => o.main) || p.options[0];
  if (trip === 'ida') {
    const prev = p.options.find((o) => o.lineId === best.lineId && o.stop === best.stop && o.bus < best.bus);
    let text = 'Para llegar a ' + say(fmt(t)) + ', coge el ' + best.line + ' en ' + best.stop + ' a ' + say(best.bus) + '; llegas sobre ' + say(best.arrive) + '.';
    if (prev) text += ' Si quieres ir con margen, el anterior pasa a ' + say(prev.bus) + '.';
    return alexaSay(text + ' Es el horario programado; puede variar con el tráfico.');
  }
  const a = p.options[0], b = p.options[1];
  let text = 'Si sales a ' + say(fmt(t)) + ', lo mejor es el ' + a.line + ' en ' + a.stop + ' a ' + say(a.bus) + '; llegas a casa sobre ' + say(a.arrive) + '.';
  if (b) text += ' Si no, el ' + b.line + ' en ' + b.stop + ' a ' + say(b.bus) + '.';
  return alexaSay(text + ' Es el horario programado.');
}

// "¿Qué bus pasa a las 9?" -> buses programados por tus paradas entre 10 min antes y 20 min después
async function alexaPasa(intent, src = 'alexa') {
  const now = madridNow();
  const t = parseHHMM(String(slot(intent, 'hora') || '').replace(/[^0-9:]/g, ''));
  if (t == null) return alexaSay('¿A qué hora? Por ejemplo: qué bus pasa a las nueve.', false);
  let date = slot(intent, 'dia') || now.date;
  if (!slot(intent, 'dia') && t < now.min - 30) { const d = new Date(now.date + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + 1); date = d.toISOString().slice(0, 10); }
  const trip = defaultTrip(src, t);
  const ymd = date.replace(/-/g, '');
  const seen = new Set(), parts = [];
  try {
    for (const e of PLAN[trip]) {
      const k = e.line + '|' + e.stop;
      if (seen.has(k) || parts.length >= 3) continue;
      seen.add(k);
      const st = await gtfsStopTimes(e.id, ymd).catch(() => null);
      const all = st ? (st.lines[e.line] || []) : ((await pubDepartures(e.line, ymd))[e.dir] || []).map((d) => d + e.off);
      const times = all.filter((b) => b >= t - 10 && b <= t + 20).slice(0, 3);
      if (!times.length) continue;
      const list = times.map((b) => 'a ' + say(fmt(b)).replace(/ de la (tarde|noche|madrugada)$/, ''));
      const joined = list.length > 1 ? list.slice(0, -1).join(', ') + ' y ' + list[list.length - 1] : list[0];
      parts.push('el ' + (LINE_NAMES[e.line] || e.line) + ' por ' + e.stop + ' ' + joined);
    }
  } catch (e) { return alexaSay('No he podido consultar los horarios de iTranvías. Prueba en un momento.'); }
  if (!parts.length) return alexaSay('No encuentro buses en tus paradas sobre ' + say(fmt(t)) + '.');
  return alexaSay('Sobre ' + say(fmt(t)) + ' pasan ' + parts.join('; ') + '. Es el horario programado.');
}

// ---------- Catálogo de líneas y paradas (cacheado 1 día) ----------
function getMeta() {
  return sharedCache('meta:v2', 24 * 3600e3, async () => {
    try { return await fetchMeta(); } catch (e) {
      // Sin catálogo no funciona nada (Alexa y los MCP lo piden antes que las paradas):
      // copia del GTFS publicada en GitHub Pages, mismo formato.
      const g = await gtfsJSON('meta.json').catch(() => null);
      if (g && g.stops && Object.keys(g.stops).length) return g;
      throw e;
    }
  });
}

async function fetchMeta() {
  const { j } = await upstreamJSON(API + '?dato=20160101T000000_gl_0_20160101T000000&func=7', { headers: UPSTREAM_HEADERS });
  const a = (j.iTranvias && j.iTranvias.actualizacion) || {};
  const lines = {}, stops = {}, pos = {};
  for (const l of a.lineas || []) {
    let c = String(l.color || '').trim();
    if (c && c[0] !== '#') c = '#' + c;
    lines[l.id] = { n: l.lin_comer, c: c, o: l.nombre_orig, d: l.nombre_dest };
  }
  for (const p of a.paradas || []) { stops[p.id] = p.nombre; if (p.posy && p.posx) pos[p.id] = [Number(p.posy), Number(p.posx)]; }
  if (!Object.keys(stops).length) throw new Error('iTranvías: catálogo vacío');
  return { lines, stops, pos };
}

// ---------- Alexa: consulta por línea y/o parada ----------
const NUM_WORDS = { uno: 1, un: 1, una: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10, once: 11, doce: 12, trece: 13, catorce: 14, quince: 15, dieciseis: 16, diecisiete: 17, dieciocho: 18, diecinueve: 19, veinte: 20, veintiuno: 21, veintiun: 21, veintidos: 22, veintitres: 23, veinticuatro: 24, veinticinco: 25, veintiseis: 26, veintisiete: 27, veintiocho: 28, veintinueve: 29 };
const STOP_ALIASES = { 'corte ingles': 40, 'el corte ingles': 40, 'trabajo': 40, 'casa': 50, 'mi casa': 50 };
const STOP_WORDS = new Set(['de', 'del', 'la', 'el', 'los', 'las', 'a', 'en', 'por', 'parada', 'rda', 'ronda', 'av', 'avda', 'avenida', 'rua', 'calle', 'c', 'pza', 'praza', 'plaza', 'numero', 'n']);
function norm(v) { return String(v || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim(); }
const TENS = { veinte: 20, treinta: 30, cuarenta: 40, cincuenta: 50, sesenta: 60, setenta: 70, ochenta: 80, noventa: 90 };
const HUNDREDS = { cien: 100, ciento: 100, doscientos: 200, trescientos: 300, cuatrocientos: 400, quinientos: 500, seiscientos: 600, setecientos: 700, ochocientos: 800, novecientos: 900 };
function wordsToNum(v) {
  const out = [];
  let acc = null;
  const flush = () => { if (acc != null) { out.push(String(acc)); acc = null; } };
  for (const w of norm(v).split(' ')) {
    if (HUNDREDS[w] != null) { flush(); acc = HUNDREDS[w]; }
    else if (TENS[w] != null) { acc = (acc != null && acc % 100 === 0 ? acc : (flush(), 0)) + TENS[w]; }
    else if (NUM_WORDS[w] != null) { acc = (acc != null && acc % 10 === 0 ? acc : (flush(), 0)) + NUM_WORDS[w]; }
    else if (w === 'y' && acc != null) { /* "cuarenta y nueve" */ }
    else { flush(); out.push(w); }
  }
  flush();
  return out.join(' ');
}
function lineKey(v) { return wordsToNum(v).replace(/^linea /, '').replace(/ /g, ''); }

function findLine(meta, spoken) {
  const k = lineKey(spoken);
  if (!k) return null;
  for (const id in meta.lines) if (lineKey(meta.lines[id].n) === k) return Number(id);
  return null;
}

// iTranvías da los nombres de parada en gallego (Catro Camiños, Porta Real):
// traduce las palabras habituales en castellano antes de buscar.
function esToGl(q) {
  return q.replace(/\bcuatro caminos\b/g, 'catro caminos')
    .split(' ').map((w) => (w !== 'cuatro' && PUB_ES_GL[w]) || w).join(' ');
}
function findStop(meta, spoken, preferred) {
  const q = norm(spoken);
  if (STOP_ALIASES[q] != null) return { id: STOP_ALIASES[q] };
  const toks = wordsToNum(esToGl(q)).split(' ').filter((t) => t && !STOP_WORDS.has(t));
  if (!toks.length) return null;
  const nums = toks.filter((t) => /^\d+$/.test(t));
  let best = [], bestScore = 0;
  for (const id in meta.stops) {
    const nt = wordsToNum(meta.stops[id]).split(' ');
    if (nums.some((n) => nt.indexOf(n) < 0)) continue;
    const score = toks.filter((t) => nt.indexOf(t) >= 0 || (t.length > 3 && nt.some((x) => x.startsWith(t)))).length;
    if (score > bestScore) { bestScore = score; best = [Number(id)]; } else if (score === bestScore && score > 0) best.push(Number(id));
  }
  if (!best.length || bestScore < Math.min(2, toks.length)) return null;
  const pref = best.filter((id) => preferred.indexOf(id) >= 0);
  if (pref.length) return { id: pref[0] };
  if (best.length > 1 && !nums.length) return { ambiguous: best.slice(0, 3).map((id) => meta.stops[id]) };
  return { id: best[0] };
}

function speakStop(name) { return String(name).replace(/^Rda\./, 'Ronda').replace(/^Av\./, 'Avenida').replace(/^Pza\./, 'Plaza'); }

// "el bus", "el próximo"… no son líneas: Alexa a veces los mete en el hueco {linea}.
const GENERIC_LINE = /^(el |mi |un )?(bus|autobus|proximo|siguiente|primero|proximo bus|siguiente bus|proximo autobus|siguiente autobus|mio)$/;
function seq(mins) {
  const [first, ...rest] = mins;
  let t = when(first);
  if (rest.length) {
    const r = rest.map((m) => at(m).replace(/ de la (tarde|noche|madrugada)$/, ''));
    t += '; luego ' + (r.length > 1 ? r.slice(0, -1).join(', ') + ' y ' + r[r.length - 1] : r[0]);
  }
  return t;
}

async function alexaConsulta(intent, attrs = {}, src = 'alexa') {
  NOW_MIN = madridNow().min;
  let meta;
  try { meta = await pubMeta(); } catch (e) { return alexaSay('No he podido consultar iTranvías. Prueba en un momento.'); }
  let lineSpoken = slot(intent, 'linea');
  const stopSpoken = slot(intent, 'parada'), num = slot(intent, 'numero');
  if (lineSpoken && GENERIC_LINE.test(norm(lineSpoken))) lineSpoken = null;
  // Respuesta de seguimiento ("por Cuatro Caminos") tras preguntar por una línea que no pasa por tus paradas.
  if (!lineSpoken && (stopSpoken || num) && attrs.linea) lineSpoken = attrs.linea;
  if (!lineSpoken && !stopSpoken && !num) return alexaCommute(null, src);
  const lineId = lineSpoken ? findLine(meta, lineSpoken) : null;
  if (lineSpoken && !lineId) return alexaSay('No conozco la línea ' + lineSpoken + '. Dime el número, por ejemplo: cuándo pasa el 14.', false);
  const trip = defaultTrip(src, NOW_MIN);
  const mine = [...new Set(ALEXA_TRIPS[trip].map((s) => s.id).concat(ALEXA_TRIPS[trip === 'ida' ? 'vuelta' : 'ida'].map((s) => s.id)))];

  let stops = [];
  if (num && meta.stops[num]) stops = [Number(num)];
  else if (stopSpoken) {
    const f = findStop(meta, stopSpoken, mine);
    if (!f) return alexaSay('No encuentro la parada ' + stopSpoken + '. Prueba con el nombre de la calle y el número.', false);
    if (f.ambiguous) return alexaSay('Hay varias paradas así: ' + f.ambiguous.map(speakStop).join(', ') + '. ¿Cuál?', false);
    stops = [f.id];
  } else if (lineId) stops = ALEXA_TRIPS[trip].map((s) => s.id);
  if (!stops.length) return alexaSay('Dime una línea o una parada. Por ejemplo: cuándo pasa el 14 por Outeiro 126.', false);

  const parts = [];
  let prog = false;
  await Promise.all(stops.map(async (sid) => {
    try {
      const d = await pubStop(sid);
      if (d.programado) prog = 'all';
      const j = stopAsUpstream(d);
      traceUpstream(sid, j);
      const items = [];
      for (const l of (j.buses && j.buses.lineas) || []) {
        if (lineId && l.linea !== lineId) continue;
        const name = (meta.lines[l.linea] && meta.lines[l.linea].n) || String(l.linea);
        const picked = (l.buses || []).slice().sort((a, b) => parseMin(a.tiempo) - parseMin(b.tiempo)).slice(0, lineId ? 3 : 2);
        if (!prog && picked.some((b) => b.programado)) prog = 'part';
        const mins = picked.map((b) => Math.round(parseMin(b.tiempo)));
        if (mins.length) items.push({ name, first: mins[0], text: 'el ' + name.replace(/A$/, ' A') + ' ' + seq(mins) });
      }
      items.sort((a, b) => a.first - b.first);
      if (items.length) parts.push({ sid, text: 'En ' + speakStop(meta.stops[sid] || sid) + ': ' + items.slice(0, 4).map((x) => x.text).join('; ') + '.' });
    } catch (e) {}
  }));
  if (!parts.length) {
    if (lineId && !stopSpoken && !num) {
      const n = meta.lines[lineId].n;
      return alexaSay('El ' + n + ' no tiene buses próximos por tus paradas de ' + (trip === 'ida' ? 'ida' : 'vuelta') + '. ¿Por qué parada lo quieres? Por ejemplo: por Cuatro Caminos.', false, { linea: n });
    }
    return alexaSay('Ahora mismo no hay buses próximos' + (lineId ? ' del ' + meta.lines[lineId].n : '') + ' en esa parada.');
  }
  parts.sort((a, b) => stops.indexOf(a.sid) - stops.indexOf(b.sid));
  return alexaSay(parts.map((p) => p.text).join(' ') + (prog === 'all' ? PROG_NOTE : prog ? PROG_PART : ''));
}

// ---------- Intents reutilizables (Alexa clásica, /alexa/test y MCP) ----------
// Ejecuta la misma lógica que la skill y devuelve el texto que diría Alexa.
async function runIntent(name, slots = {}, src = 'mcp') {
  const s = {};
  for (const k in slots) if (slots[k] != null && slots[k] !== '') s[k] = { value: String(slots[k]) };
  const body = { request: name ? { type: 'IntentRequest', intent: { name, slots: s } } : { type: 'LaunchRequest' } };
  const r = await alexa(new Request('https://mibus.local/alexa', { method: 'POST', body: JSON.stringify(body) }), {}, src);
  const j = await r.json();
  return (j.response && j.response.outputSpeech && j.response.outputSpeech.text) || '';
}

// ---------- Servidor MCP (Streamable HTTP, sin estado, respuestas JSON) ----------
// Alexa+ (MCP Toolkit), Claude u otro cliente MCP llaman a POST /mcp.
// Autenticación de servicio (OAuth 2.1 client_credentials) si existen los secrets
// MCP_CLIENT_ID y MCP_CLIENT_SECRET; sin ellos el endpoint queda abierto (los datos son públicos).
const MCP_SCOPE = 'mcp:service';
const MCP_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26'];
const HORA_RE = /^\d{1,2}(:\d{2})?$/;
const FECHA_RE = /^\d{4}-\d{2}-\d{2}$/;
const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true };

// =====================================================================
// MCP Apps (extensión io.modelcontextprotocol/ui, SEP-1865): panel de llegadas
// dentro del chat (Claude, ChatGPT, VS Code…). Las herramientas con
// _meta.ui.resourceUri devuelven texto (para el modelo y clientes sin UI) y
// structuredContent (para el panel). El panel es HTML sin dependencias que
// habla con el host por postMessage (JSON-RPC) y puede refrescar llamando a
// la misma herramienta con tools/call.
// =====================================================================
var UI_URI = "ui://mibus/llegadas.html";
var UI_MIME = "text/html;profile=mcp-app";
var UI_META = { ui: { resourceUri: UI_URI }, "openai/outputTemplate": UI_URI, "openai/widgetAccessible": true };

function uiResourceList() {
  return { resources: [{ uri: UI_URI, name: "llegadas", title: "Panel de llegadas", description: "Panel con los próximos buses de A Coruña", mimeType: UI_MIME }] };
}

function uiResourceRead(uri) {
  if (uri !== UI_URI) return null;
  return { contents: [{ uri: UI_URI, mimeType: UI_MIME, text: UI_HTML, _meta: { ui: { prefersBorder: true } } }] };
}

// Llegadas de varias paradas en forma de datos para el panel.
// opts.lineId: solo esa línea; opts.lines[sid]: líneas permitidas por parada; opts.walk[sid]: minutos andando; opts.dist[sid]: metros.
async function uiBoards(meta, stops, opts = {}) {
  const now = madridNow().min;
  return Promise.all(stops.map(async (sid) => {
    const b = { id: sid, nombre: pubStopName(meta, sid) };
    if (opts.walk && opts.walk[sid] != null) b.andando = opts.walk[sid];
    if (opts.dist && opts.dist[sid] != null) b.metros = opts.dist[sid];
    let d;
    try { d = await pubStop(sid); } catch (e) { b.error = "iTranvías no responde ahora mismo"; b.llegadas = []; return b; }
    if (d.stale) { b.stale = true; b.edad_s = d.age; }
    if (d.programado) b.programado = true;
    const elapsed = (Date.now() - d.at) / 60000;
    const out = [];
    for (const l of d.lineas || []) {
      if (opts.lineId && l.linea !== opts.lineId) continue;
      const allowed = opts.lines && opts.lines[sid];
      if (allowed && allowed.indexOf(l.linea) < 0) continue;
      const info = meta.lines[l.linea] || {};
      for (const bus of (l.buses || []).slice(0, 4)) {
        const min = Math.max(0, Math.round(parseMin(bus.tiempo) - elapsed));
        const fuente = d.programado || bus.programado ? "horario" : bus.sinSenal ? "sinsenal" : d.stale ? "viejo" : "vivo";
        out.push({ linea: pubLineName(meta, l.linea), color: info.c || null, min, hora: fmt(now + min), metros: Number(bus.distancia) || null, fuente });
      }
    }
    out.sort((x, y) => x.min - y.min);
    b.llegadas = out.slice(0, 8);
    return b;
  }));
}

function uiPayload(titulo, paradas, refresh, extra = {}) {
  return { titulo, generado: Date.now(), paradas, refresh, ...extra };
}

var UI_HTML = String.raw`<!DOCTYPE html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Mi bus</title>
<style>
:root{
  --bg:var(--color-background-primary,#fff);--bg2:var(--color-background-secondary,#f4f5f7);
  --tx:var(--color-text-primary,#16181d);--tx2:var(--color-text-secondary,#5d6470);--tx3:var(--color-text-tertiary,#8a919c);
  --bd:var(--color-border-tertiary,#e3e5e9);--ok:var(--color-text-success,#1a7f45);--warn:var(--color-text-warning,#a15c00);--bad:var(--color-text-danger,#c4291c);
  --font:var(--font-sans,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif);
}
[data-theme=dark]{
  --bg:var(--color-background-primary,#1b1d22);--bg2:var(--color-background-secondary,#25282e);
  --tx:var(--color-text-primary,#eef0f3);--tx2:var(--color-text-secondary,#a7adb7);--tx3:var(--color-text-tertiary,#7c838d);
  --bd:var(--color-border-tertiary,#33373e);--ok:var(--color-text-success,#4cc38a);--warn:var(--color-text-warning,#f0b354);--bad:var(--color-text-danger,#ff7a6b);
}
*{box-sizing:border-box}
html,body{margin:0;background:transparent;color:var(--tx);font-family:var(--font);font-size:14px;-webkit-font-smoothing:antialiased}
.wrap{padding:14px 16px 12px}
header{display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin-bottom:10px}
h1{font-size:15px;font-weight:650;margin:0;letter-spacing:-.01em}
.meta{color:var(--tx3);font-size:12px;white-space:nowrap;display:flex;align-items:center;gap:8px}
button{font:inherit;font-size:12px;color:var(--tx2);background:var(--bg2);border:1px solid var(--bd);border-radius:999px;padding:3px 10px;cursor:pointer}
button:hover{color:var(--tx)}
button[disabled]{opacity:.5;cursor:default}
.stop{border-top:1px solid var(--bd);padding:10px 0 4px}
.stop:first-of-type{border-top:0;padding-top:2px}
.sh{display:flex;justify-content:space-between;align-items:baseline;gap:8px;margin-bottom:6px}
.sn{font-weight:600;font-size:13px}
.sx{color:var(--tx3);font-size:12px;white-space:nowrap}
.row{display:grid;grid-template-columns:auto 1fr auto;align-items:center;gap:10px;padding:5px 0}
.ln{min-width:34px;height:24px;padding:0 7px;border-radius:6px;display:inline-flex;align-items:center;justify-content:center;font-weight:700;font-size:13px;color:#fff;background:#555}
.to{color:var(--tx2);font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.to b{color:var(--tx);font-weight:600;font-size:13px}
.right{text-align:right;white-space:nowrap}
.min{font-size:20px;font-weight:700;font-variant-numeric:tabular-nums;letter-spacing:-.02em}
.min small{font-size:11px;font-weight:600;color:var(--tx3);margin-right:4px;text-transform:uppercase;letter-spacing:.04em}
.now{color:var(--ok)}
.lv{display:block;font-size:12px;font-weight:600;margin-top:1px}
.lv.ok{color:var(--ok)}.lv.warn{color:var(--warn)}.lv.bad{color:var(--bad)}.lv.gone{color:var(--tx3);font-weight:500}
.empty,.err{color:var(--tx3);font-size:13px;padding:4px 0 8px}
.err{color:var(--bad)}
.stale{color:var(--warn);font-size:12px}
.loading{color:var(--tx3);padding:18px 0;text-align:center}
footer{color:var(--tx3);font-size:11px;margin-top:8px}
.sub{color:var(--tx3);font-size:12px;margin:-6px 0 8px}
.opt{display:grid;grid-template-columns:auto 1fr auto;align-items:center;gap:10px;padding:8px 0;border-top:1px solid var(--bd)}
.opt:first-of-type{border-top:0}
.opt.rec{background:var(--bg2);border-radius:8px;padding:8px;border-top:0;margin:2px -8px}
.tag{display:inline-block;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--ok);margin-left:6px}
.hrs{font-variant-numeric:tabular-nums;font-weight:600;font-size:14px;text-align:right}
.live::before{content:"";display:inline-block;width:7px;height:7px;border-radius:50%;background:var(--ok);margin-right:6px;vertical-align:middle;animation:pulse 2s ease-out infinite}
@keyframes pulse{0%{box-shadow:0 0 0 0 rgba(26,159,85,.55)}70%{box-shadow:0 0 0 6px rgba(26,159,85,0)}100%{box-shadow:0 0 0 0 rgba(26,159,85,0)}}
@media (prefers-reduced-motion:reduce){.live::before{animation:none}}
.old::before{content:"";display:inline-block;width:7px;height:7px;border-radius:50%;background:var(--warn);margin-right:6px;vertical-align:middle}
.sched{color:var(--tx2);font-style:italic;font-weight:600}
.sched::before{content:"🕒";font-style:normal;font-size:12px;margin-right:4px}
.badge{font-size:11px;font-weight:600;color:var(--tx3)}
.badge.live,.badge.old{color:var(--tx2)}
</style></head>
<body><div class="wrap" id="app"><div class="loading">Cargando llegadas…</div></div>
<script>
(function(){
  var data = null, gotAt = 0, nextId = 1, pending = {}, busy = false;
  var app = document.getElementById("app");

  function post(m){ try { window.parent.postMessage(m, "*"); } catch (e) {} }
  function request(method, params){
    var id = nextId++;
    post({ jsonrpc: "2.0", id: id, method: method, params: params || {} });
    return new Promise(function(res, rej){ pending[id] = { res: res, rej: rej }; setTimeout(function(){ if (pending[id]) { delete pending[id]; rej(new Error("timeout")); } }, 20000); });
  }
  function notify(method, params){ post({ jsonrpc: "2.0", method: method, params: params || {} }); }

  function applyContext(ctx){
    if (!ctx) return;
    if (ctx.theme) document.documentElement.setAttribute("data-theme", ctx.theme);
    var v = ctx.styles && ctx.styles.variables;
    if (v) for (var k in v) if (v[k]) document.documentElement.style.setProperty(k, v[k]);
  }

  function esc(s){ return String(s == null ? "" : s).replace(/[&<>"']/g, function(c){ return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function pad(n){ return (n < 10 ? "0" : "") + n; }
  function clock(ms){ var d = new Date(ms); return pad(d.getHours()) + ":" + pad(d.getMinutes()); }

  function onResult(r){
    if (!r) return;
    var sc = r.structuredContent;
    if (isData(sc)) { data = sc; gotAt = Date.now(); render(); return; }
    var t = (r.content || []).filter(function(c){ return c.type === "text"; }).map(function(c){ return c.text; }).join("\n");
    app.innerHTML = '<div class="empty" style="white-space:pre-wrap">' + esc(t || "Sin datos.") + "</div>";
    resize();
  }

  // Como en el widget: lo grande es la hora a la que pasa; debajo, cuándo salir. Sin segundos.
  function leave(min, walk){
    var s = min - walk;
    if (s <= 0) return '<span class="lv bad">¡sal ya! · en ' + min + " min</span>";
    return '<span class="lv ' + (s < 5 ? "bad" : s < 10 ? "warn" : "ok") + '">🚶 sal ' + clock(gotAt + s * 60000) + " · en " + s + " min</span>";
  }

  function isData(x){ return !!(x && (x.paradas || x.opciones || x.filas)); }
  function chip(linea, color){
    var bg = color ? ' style="background:' + esc(/^#?[0-9a-f]{3,8}$/i.test(color) ? (color[0] === "#" ? color : "#" + color) : "#555") + '"' : "";
    return '<span class="ln"' + bg + ">" + esc(linea) + "</span>";
  }
  function head(sub){
    var h = "<header><h1>" + esc(data.titulo || "Mi bus") + '</h1><div class="meta"><span class="badge">🕒 Horario</span></div></header>';
    if (sub) h += '<div class="sub">' + esc(sub) + "</div>";
    return h;
  }
  // Plan "qué bus cojo": horario programado, sin refresco.
  function renderPlan(){
    var h = head([data.fecha, data.tipo_dia].filter(Boolean).join(" · "));
    if (!(data.opciones || []).length) h += '<div class="empty">No hay buses para esa hora.</div>';
    (data.opciones || []).forEach(function(o){
      h += '<div class="opt' + (o.recomendado ? " rec" : "") + '">' + chip(o.linea, o.color);
      h += '<span class="to"><b>' + esc(o.parada) + "</b>" + (o.recomendado ? '<span class="tag">recomendado</span>' : "") + "<br>🚶 sal " + esc(o.sal) + " · llegas " + esc(o.llegas) + "</span>";
      h += '<span class="right"><span class="min sched"><small>pasa </small>' + esc(o.pasa) + "</span></span></div>";
    });
    h += "<footer>Horario programado · puede variar con el tráfico</footer>";
    app.innerHTML = h; resize();
  }
  // "Qué bus pasa a las X": horas programadas por parada y línea.
  function renderHorario(){
    var h = head([data.fecha, data.tipo_dia].filter(Boolean).join(" · "));
    if (!(data.filas || []).length) h += '<div class="empty">No hay buses en ese rango.</div>';
    (data.filas || []).forEach(function(f){
      h += '<div class="row">' + chip(f.linea, f.color) + '<span class="to"><b>' + esc(f.parada) + "</b></span>";
      h += '<span class="hrs sched">' + (f.horas || []).map(esc).join(" · ") + "</span></div>";
    });
    h += "<footer>Horario programado · puede variar con el tráfico</footer>";
    app.innerHTML = h; resize();
  }

  function render(){
    if (!data) return;
    if (data.opciones) return renderPlan();
    if (data.filas) return renderHorario();
    var drift = Math.floor((Date.now() - gotAt) / 60000);
    var ps = data.paradas || [];
    var allProg = ps.length && ps.every(function(p){ return p.programado; }), anyOld = ps.some(function(p){ return p.stale || p.programado; });
    var badge = allProg ? '<span class="badge">🕒 Horario</span>' : anyOld ? '<span class="badge old">En vivo (parcial)</span>' : '<span class="badge live">En vivo</span>';
    var h = "<header><h1>" + esc(data.titulo || "Próximos buses") + '</h1><div class="meta">' + badge + "<span>" + clock(gotAt) + "</span>";
    if (data.refresh) h += '<button id="rf"' + (busy ? " disabled" : "") + ">" + (busy ? "Actualizando…" : "Actualizar") + "</button>";
    h += "</div></header>";
    var single = (data.paradas || []).length === 1;
    (data.paradas || []).forEach(function(p){
      var same = single && data.titulo === p.nombre;
      h += '<section class="stop"><div class="sh"><span class="sn">' + (same ? "" : esc(p.nombre)) + '</span><span class="sx">';
      var bits = [];
      if (p.andando != null) bits.push("🚶 " + p.andando + " min");
      if (p.metros != null) bits.push(p.metros + " m");
      bits.push("nº " + p.id);
      h += esc(bits.join(" · ")) + "</span></div>";
      if (p.programado) h += '<div class="stale">🕒 Horario programado: iTranvías no responde, no es tiempo real</div>';
      if (p.stale) h += '<div class="stale">Dato de hace ' + Math.max(1, Math.round((p.edad_s || 0) / 60) + drift) + " min (iTranvías no responde)</div>";
      // En un trayecto solo se muestran los buses a los que llegas andando; como mucho 4 por parada.
      var list = (p.llegadas || []).filter(function(b){ return b.min - drift >= (p.andando != null ? p.andando : 0); }).slice(0, 4);
      if (p.error && !(p.llegadas || []).length) h += '<div class="err">' + esc(p.error) + "</div>";
      else if (!list.length) h += '<div class="empty">' + (p.andando != null && (p.llegadas || []).length ? "Ninguno al que llegues andando." : "Sin buses próximos.") + "</div>";
      list.forEach(function(b){
        var m = Math.max(0, b.min - drift);
        var bg = b.color ? ' style="background:' + esc(/^#?[0-9a-f]{3,8}$/i.test(b.color) ? (b.color[0] === "#" ? b.color : "#" + b.color) : "#555") + '"' : "";
        h += '<div class="row"><span class="ln"' + bg + ">" + esc(b.linea) + "</span>";
        h += '<span class="to">' + (b.hacia ? "→ " + esc(b.hacia) : "") + (b.metros ? (b.hacia ? " · " : "") + (b.metros >= 1000 ? (b.metros / 1000).toFixed(1).replace(".", ",") + " km" : b.metros + " m") : "") + "</span>";
        var src = p.programado || b.fuente === "horario" ? " sched" : p.stale || b.fuente === "sinsenal" || b.fuente === "viejo" ? " old" : " live";
        h += '<span class="right">' + (m <= 0 && !p.programado ? '<span class="min now' + src + '">llegando</span>' : '<span class="min' + src + '"><small>pasa </small>' + clock(gotAt + m * 60000) + "</span>");
        if (p.andando != null) h += leave(m, p.andando); else if (m > 0) h += '<span class="lv gone">en ' + m + " min</span>";
        h += "</span></div>";
      });
      h += "</section>";
    });
    h += "<footer>● en vivo (iTranvías) · 🕒 horario programado · fuente no oficial</footer>";
    app.innerHTML = h;
    var rf = document.getElementById("rf");
    if (rf) rf.onclick = refresh;
    resize();
  }

  function refresh(){
    if (busy || !data || !data.refresh) return;
    busy = true; render();
    var done = function(){ busy = false; render(); };
    if (window.openai && window.openai.callTool) {
      window.openai.callTool(data.refresh.tool, data.refresh.arguments || {}).then(function(r){ busy = false; onResult(r && (r.structuredContent ? r : { structuredContent: r })); }, done);
      return;
    }
    request("tools/call", { name: data.refresh.tool, arguments: data.refresh.arguments || {} }).then(function(r){ busy = false; onResult(r); }, done);
  }

  var lastH = 0;
  function resize(){
    var h = Math.ceil(document.documentElement.scrollHeight);
    if (Math.abs(h - lastH) < 2) return;
    lastH = h;
    notify("ui/notifications/size-changed", { width: Math.ceil(document.documentElement.scrollWidth), height: h });
  }
  if (window.ResizeObserver) new ResizeObserver(resize).observe(document.body);

  window.addEventListener("message", function(ev){
    var m = ev.data;
    if (!m || m.jsonrpc !== "2.0") return;
    if (m.id != null && !m.method && pending[m.id]) {
      var p = pending[m.id]; delete pending[m.id];
      if (m.error) p.rej(new Error(m.error.message || "error")); else p.res(m.result);
      return;
    }
    if (m.method && m.id != null) {
      // Peticiones del host (ping, teardown…): respondemos vacío.
      post({ jsonrpc: "2.0", id: m.id, result: {} });
      return;
    }
    if (m.method === "ui/notifications/tool-result") onResult(m.params);
    else if (m.method === "ui/notifications/host-context-changed") { applyContext(m.params); render(); }
    else if (m.method === "ui/notifications/tool-cancelled") app.innerHTML = '<div class="empty">Consulta cancelada.</div>';
  });

  // Compatibilidad con el puente antiguo de ChatGPT (window.openai)
  // ChatGPT puede dejar los datos en window.openai.toolOutput antes de que el panel escuche,
  // así que se leen al arrancar, tras el saludo, en cada set_globals y unos segundos más.
  var lastOut = null;
  function fromOpenAI(){
    var o = window.openai;
    if (!o) return false;
    if (o.theme) applyContext({ theme: o.theme });
    var out = o.toolOutput;
    if (out && out.structuredContent) out = out.structuredContent;
    if (isData(out) && out !== lastOut) { lastOut = out; data = out; gotAt = Date.now(); render(); }
    return true;
  }
  window.addEventListener("openai:set_globals", fromOpenAI);
  fromOpenAI();
  var tries = 0, poll = setInterval(function(){ if (data || ++tries > 40) return clearInterval(poll); fromOpenAI(); }, 250);

  request("ui/initialize", { appInfo: { name: "mibus-llegadas", version: "1.1.0" }, appCapabilities: {}, protocolVersion: "2026-01-26" })
    .then(function(r){ applyContext(r && r.hostContext); notify("ui/notifications/initialized", {}); fromOpenAI(); })
    .catch(function(){ fromOpenAI(); });

  setInterval(function(){ if (data) render(); }, 30000);
})();
</script></body></html>`;

// Resultado de una herramienta: texto (modelo y clientes sin UI) + datos para el panel (MCP Apps).
async function withUi(text, build) {
  let structured = null;
  try { structured = await build(); } catch (e) {}
  return structured ? { text, structured } : text;
}
function toolResult(out) {
  if (out && typeof out === 'object') {
    const r = { content: [{ type: 'text', text: out.text || 'No tengo datos ahora mismo.' }], isError: false };
    if (out.structured) r.structuredContent = out.structured;
    return r;
  }
  return { content: [{ type: 'text', text: out || 'No tengo datos ahora mismo.' }], isError: false };
}

// ---------- Respuestas para LLMs: horas HH:MM y datos, sin frases de voz ----------
// (La skill de Alexa sigue usando runIntent con sus frases habladas.)
function boardsText(title, boards) {
  const now = madridNow().min;
  const out = [title + ' — ahora ' + fmt(now)];
  let best = null;
  for (const b of boards) {
    const bits = [b.nombre + ' (parada ' + b.id + (b.andando != null ? ', ' + b.andando + ' min andando' : '') + (b.metros != null ? ', a ' + b.metros + ' m' : '') + ')'];
    if (b.programado) bits.push('HORARIO PROGRAMADO (no es tiempo real): iTranvías no responde');
    else if (b.stale) bits.push('último dato en vivo de hace ' + Math.max(1, Math.round((b.edad_s || 0) / 60)) + ' min: iTranvías no responde');
    else if (!b.error) bits.push('en vivo');
    out.push(bits.join(' · '));
    if (b.error && !(b.llegadas || []).length) { out.push('  ' + b.error); continue; }
    const walk = b.andando != null ? b.andando : null;
    const list = (b.llegadas || []).filter((x) => walk == null || x.min >= walk).slice(0, 4);
    if (!list.length) { out.push('  ' + (walk != null && (b.llegadas || []).length ? 'ningún bus al que llegues andando' : 'sin buses próximos')); continue; }
    for (const x of list) {
      let t = '  - Línea ' + x.linea + ': pasa ' + x.hora + ' (' + (x.min <= 0 ? 'llegando' : 'en ' + x.min + ' min') + ')';
      if (!b.programado && x.fuente === 'horario') t += ' [según horario: iTranvías no lo está siguiendo]';
      if (x.fuente === 'sinsenal') t += ' [sin señal: estimado con su último dato en vivo]';
      if (walk != null) {
        const lv = x.min - walk;
        t += ', salir ' + fmt(now + lv) + (lv <= 0 ? ' (¡ya!)' : ' (en ' + lv + ' min)');
        if (!best || lv < best.lv) best = { lv, linea: x.linea, parada: b.nombre, hora: x.hora };
      }
      out.push(t);
    }
  }
  if (best) out.push('Primero al que llegas andando: línea ' + best.linea + ' en ' + best.parada + ', pasa ' + best.hora + ', salir ' + fmt(now + best.lv) + '.');
  return out.join('\n');
}

// Fecha de un plan: la indicada, o mañana si la hora ya pasó (como la skill).
function planDate(hora, fecha) {
  const now = madridNow();
  if (fecha) return fecha;
  if (parseHHMM(hora) < now.min - 30) { const d = new Date(now.date + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10); }
  return now.date;
}

function lineColor(meta, id) { return (meta && meta.lines && meta.lines[id] && meta.lines[id].c) || null; }

// Horas programadas de una línea en una parada: GTFS por parada; si no cubre la fecha, cabecera + desfase.
async function scheduleAt(e, ymd) {
  const st = await gtfsStopTimes(e.id, ymd).catch(() => null);
  if (st) return { tipo: st.tipo, times: st.lines[e.line] || [] };
  const dep = await pubDepartures(e.line, ymd);
  return { tipo: dep.tipo || '', times: (dep[e.dir] || []).map((d) => d + e.off) };
}

const MCP_TOOLS = [
  {
    name: 'proximos_buses',
    title: 'Próximos buses de mi trayecto',
    description: 'Live next buses for the user\'s daily commute in A Coruña (Spain), from iTranvías real-time data. ' +
      'trayecto "ida" = from home to work (El Corte Inglés); "vuelta" = from work back home. If omitted, it picks ida before 15:00 and vuelta after (Europe/Madrid). ' +
      'Returns, per stop, the buses the user can still reach on foot: time it passes (HH:MM), minutes until then, and when to leave. Answer in Spanish. Use for: "¿cuándo pasa mi bus?", "el bus al trabajo", "el bus a casa".',
    inputSchema: { type: 'object', properties: { trayecto: { type: 'string', enum: ['ida', 'vuelta'], description: 'ida = casa → trabajo; vuelta = trabajo → casa' } }, additionalProperties: false },
    annotations: RO,
    _meta: UI_META,
    run: async (a) => {
      const trip = a.trayecto || defaultTrip('mcp', madridNow().min);
      const meta = await pubMeta();
      const st = ALEXA_TRIPS[trip];
      const lines = {}, walk = {};
      for (const x of st) { lines[x.id] = x.lines; walk[x.id] = x.walk; }
      const boards = await uiBoards(meta, st.map((x) => x.id), { lines, walk });
      const title = trip === 'ida' ? 'Ida · casa → trabajo' : 'Vuelta · trabajo → casa';
      return { text: boardsText(title, boards), structured: uiPayload(title, boards, { tool: 'proximos_buses', arguments: { trayecto: trip } }) };
    }
  },
  {
    name: 'consultar_parada',
    title: 'Consultar una línea o parada',
    description: 'Live arrivals for any A Coruña city bus line and/or stop (iTranvías real time). ' +
      'Give a line ("14", "12A"), a stop by street name ("Ronda de Outeiro 126", "corte inglés", "casa") or a stop number, or a combination. ' +
      'With only a line, it checks the user\'s usual stops. Returns times as HH:MM and minutes. Use for: "¿cuándo pasa el 14?", "¿qué buses pasan por Outeiro 126?".',
    inputSchema: {
      type: 'object',
      properties: {
        linea: { type: 'string', description: 'Línea de bus, p. ej. "14" o "12A"' },
        parada: { type: 'string', description: 'Nombre o calle de la parada, p. ej. "Ronda de Outeiro 126"' },
        numero_parada: { type: 'integer', minimum: 1, description: 'Número de parada de iTranvías' }
      },
      additionalProperties: false
    },
    annotations: RO,
    validate: (a) => (a.linea || a.parada || a.numero_parada) ? null : 'Indica una línea, una parada o un número de parada.',
    _meta: UI_META,
    run: async (a) => {
      const meta = await pubMeta();
      const lineId = a.linea ? findLine(meta, a.linea) : null;
      if (a.linea && !lineId) return 'No conozco la línea «' + a.linea + '».';
      const trip = defaultTrip('mcp', madridNow().min);
      const mine = [...new Set(ALEXA_TRIPS.ida.concat(ALEXA_TRIPS.vuelta).map((x) => x.id))];
      let stops = [], walk = null;
      if (a.numero_parada) {
        if (!meta.stops[a.numero_parada]) return 'No existe la parada ' + a.numero_parada + '.';
        stops = [Number(a.numero_parada)];
      } else if (a.parada) {
        const f = findStop(meta, a.parada, mine);
        if (!f) return 'No encuentro la parada «' + a.parada + '». Prueba con la calle y el número, o con el número de parada.';
        if (f.ambiguous) {
          const ids = Object.keys(meta.stops).filter((id) => f.ambiguous.indexOf(meta.stops[id]) >= 0).slice(0, 5);
          return 'Hay varias paradas que encajan con «' + a.parada + '». Pregunta cuál o usa numero_parada:\n' + ids.map((id) => '- Parada ' + id + ': ' + pubStopName(meta, id)).join('\n');
        }
        stops = [f.id];
      } else {
        stops = ALEXA_TRIPS[trip].map((x) => x.id);
        walk = {};
        for (const x of ALEXA_TRIPS[trip]) walk[x.id] = x.walk;
      }
      const boards = await uiBoards(meta, stops, { lineId, walk });
      const title = lineId ? 'Línea ' + pubLineName(meta, lineId) + (stops.length === 1 ? ' · ' + pubStopName(meta, stops[0]) : ' · tus paradas de ' + trip) : pubStopName(meta, stops[0]);
      return { text: boardsText(title, boards), structured: uiPayload(title, boards, { tool: 'consultar_parada', arguments: a }) };
    }
  },
  {
    name: 'planificar_viaje',
    title: 'Planificar el viaje para una hora',
    description: 'Plans the commute with the scheduled timetable (exact times per stop). trayecto "ida": which bus to take to ARRIVE at work by the given time. ' +
      'trayecto "vuelta": best bus home when LEAVING work at the given time. hora in 24h HH:MM; fecha optional (YYYY-MM-DD, defaults to today or tomorrow if the time has passed). ' +
      'Returns options with leave / bus / arrival times (HH:MM) and the recommended one. Use for: "¿qué bus cojo para llegar a las 9?", "si salgo a las 18:30, ¿qué bus me llevo?".',
    inputSchema: {
      type: 'object',
      properties: {
        trayecto: { type: 'string', enum: ['ida', 'vuelta'] },
        hora: { type: 'string', pattern: '^\\d{1,2}(:\\d{2})?$', description: 'Hora en formato 24 h, p. ej. "09:00"' },
        fecha: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: 'Fecha YYYY-MM-DD (opcional)' }
      },
      required: ['trayecto', 'hora'],
      additionalProperties: false
    },
    annotations: { ...RO, openWorldHint: true },
    validate: (a) => !['ida', 'vuelta'].includes(a.trayecto) ? 'trayecto debe ser "ida" o "vuelta".' : !HORA_RE.test(a.hora || '') ? 'hora debe tener formato HH:MM.' : a.fecha && !FECHA_RE.test(a.fecha) ? 'fecha debe tener formato YYYY-MM-DD.' : null,
    _meta: UI_META,
    run: async (a) => {
      const t = parseHHMM(a.hora), date = planDate(a.hora, a.fecha);
      const p = await plan(a.trayecto, t, date.replace(/-/g, ''));
      const meta = await pubMeta().catch(() => null);
      const ida = a.trayecto === 'ida';
      const top = p.options.slice(0, 5);
      const rec = ida ? (top.find((o) => o.main) || top[0]) : top[0];
      const opts = top.slice().sort((x, y) => x.bus.localeCompare(y.bus)); // en orden de paso
      const titulo = ida ? 'Llegar al trabajo a las ' + fmt(t) : 'Volver a casa saliendo a las ' + fmt(t);
      if (!opts.length) return { text: titulo + ' (' + date + '): no hay buses para esa hora.', structured: { titulo, fecha: date, tipo_dia: p.tipo, opciones: [] } };
      const text = [titulo + ' — ' + date + (p.tipo ? ' (' + p.tipo + ')' : '') + ', horario programado (puede variar con el tráfico):']
        .concat(opts.map((o) => '- Línea ' + o.line + ' en ' + o.stop + ': salir ' + o.leave + ', pasa ' + o.bus + ', llegada ' + o.arrive + (o === rec ? '  ← recomendado' : '')))
        .join('\n');
      return {
        text,
        structured: {
          titulo, fecha: date, tipo_dia: p.tipo, trayecto: a.trayecto, hora: fmt(t),
          opciones: opts.map((o) => ({ linea: o.line, color: lineColor(meta, o.lineId), parada: o.stop, sal: o.leave, pasa: o.bus, llegas: o.arrive, recomendado: o === rec }))
        }
      };
    }
  },
  {
    name: 'buses_a_una_hora',
    title: 'Qué buses pasan a una hora',
    description: 'Scheduled buses at the user\'s usual stops around a given time (10 minutes before to 20 minutes after), with exact times per stop (HH:MM). ' +
      'hora in 24h HH:MM; fecha optional (YYYY-MM-DD); trayecto optional (default: ida before 15:00, vuelta after). Use for: "¿qué bus pasa a las nueve?".',
    inputSchema: {
      type: 'object',
      properties: {
        hora: { type: 'string', pattern: '^\\d{1,2}(:\\d{2})?$', description: 'Hora en formato 24 h' },
        fecha: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: 'Fecha YYYY-MM-DD (opcional)' },
        trayecto: { type: 'string', enum: ['ida', 'vuelta'], description: 'Paradas de ida (casa) o de vuelta (trabajo). Opcional.' }
      },
      required: ['hora'],
      additionalProperties: false
    },
    annotations: RO,
    validate: (a) => !HORA_RE.test(a.hora || '') ? 'hora debe tener formato HH:MM.' : a.fecha && !FECHA_RE.test(a.fecha) ? 'fecha debe tener formato YYYY-MM-DD.' : a.trayecto && !['ida', 'vuelta'].includes(a.trayecto) ? 'trayecto debe ser "ida" o "vuelta".' : null,
    _meta: UI_META,
    run: async (a) => {
      const t = parseHHMM(a.hora), date = planDate(a.hora, a.fecha), ymd = date.replace(/-/g, '');
      const trip = a.trayecto || defaultTrip('mcp', t);
      const meta = await pubMeta().catch(() => null);
      const seen = new Set(), filas = [];
      let tipo = '';
      for (const e of PLAN[trip]) {
        const k = e.line + '|' + e.id;
        if (seen.has(k)) continue;
        seen.add(k);
        const sc = await scheduleAt(e, ymd);
        tipo = tipo || sc.tipo;
        const horas = sc.times.filter((b) => b >= t - 10 && b <= t + 20).slice(0, 4).map(fmt);
        if (horas.length) filas.push({ linea: LINE_NAMES[e.line] ? LINE_NAMES[e.line].replace(' ', '') : String(e.line / 100), color: lineColor(meta, e.line), parada: e.stop, horas });
      }
      const titulo = 'Buses sobre las ' + fmt(t) + ' · ' + (trip === 'ida' ? 'paradas de casa' : 'paradas del trabajo');
      const text = filas.length
        ? [titulo + ' — ' + date + (tipo ? ' (' + tipo + ')' : '') + ', horario programado:'].concat(filas.map((f) => '- Línea ' + f.linea + ' en ' + f.parada + ': ' + f.horas.join(', '))).join('\n')
        : titulo + ' — ' + date + ': no hay buses entre ' + fmt(t - 10) + ' y ' + fmt(t + 20) + '.';
      return { text, structured: { titulo, fecha: date, tipo_dia: tipo, filas } };
    }
  }
];

const MCP_CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-allow-headers': 'authorization, content-type, mcp-protocol-version, mcp-session-id',
  'access-control-expose-headers': 'mcp-session-id'
};

function rpc(id, result, status = 200) {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id, result }), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...MCP_CORS } });
}
function rpcError(id, code, message, status = 200) {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...MCP_CORS } });
}

function mcpAuthEnabled(env) { return !!(env && env.MCP_CLIENT_ID && env.MCP_CLIENT_SECRET); }

async function mcp(req, env, url) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: MCP_CORS });
  // Sin stream SSE: este servidor solo responde a POST.
  if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405, headers: { allow: 'POST, OPTIONS', ...MCP_CORS } });

  if (mcpAuthEnabled(env)) {
    const m = (req.headers.get('authorization') || '').match(/^Bearer\s+(\S+)$/i);
    // 401 sin cabecera WWW-Authenticate (requisito de Alexa+).
    if (!m || !(await verifyToken(m[1], env, url.origin))) {
      return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: { 'content-type': 'application/json', ...MCP_CORS } });
    }
  }

  let msg;
  try { msg = await req.json(); } catch (e) { return rpcError(null, -32700, 'Parse error', 400); }
  if (Array.isArray(msg) || !msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    // Las respuestas a peticiones del servidor (no hacemos ninguna) y los lotes no se admiten.
    if (msg && !Array.isArray(msg) && msg.jsonrpc === '2.0' && msg.method === undefined) return new Response(null, { status: 202, headers: MCP_CORS });
    return rpcError(null, -32600, 'Invalid Request', 400);
  }
  // Notificación (sin id): se acepta sin respuesta.
  if (msg.id === undefined) return new Response(null, { status: 202, headers: MCP_CORS });

  const id = msg.id, params = msg.params || {};
  switch (msg.method) {
    case 'initialize': {
      const asked = params.protocolVersion;
      return rpc(id, {
        protocolVersion: MCP_VERSIONS.includes(asked) ? asked : MCP_VERSIONS[0],
        capabilities: { tools: { listChanged: false }, resources: { listChanged: false } },
        serverInfo: { name: 'mibus', title: 'Mi bus A Coruña', version: '1.0.0' },
        instructions: 'Horarios en tiempo real de los buses urbanos de A Coruña (iTranvías) para los trayectos diarios del usuario: ida (casa → trabajo en El Corte Inglés) y vuelta. Las herramientas devuelven horas en formato HH:MM, minutos y datos estructurados; redacta tú la respuesta en español, breve. Si un resultado dice HORARIO PROGRAMADO, avisa de que no es tiempo real.'
      });
    }
    case 'ping':
      return rpc(id, {});
    case 'tools/list':
      return rpc(id, { tools: MCP_TOOLS.map(({ run, validate, ...t }) => t) });
    case 'resources/list':
      return rpc(id, uiResourceList());
    case 'resources/templates/list':
      return rpc(id, { resourceTemplates: [] });
    case 'resources/read': {
      const r = uiResourceRead(params.uri);
      return r ? rpc(id, r) : rpcError(id, -32002, 'Resource not found: ' + params.uri);
    }
    case 'tools/call': {
      const tool = MCP_TOOLS.find((t) => t.name === params.name);
      if (!tool) return rpcError(id, -32602, 'Unknown tool: ' + params.name);
      const args = params.arguments && typeof params.arguments === 'object' ? params.arguments : {};
      const bad = tool.validate && tool.validate(args);
      if (bad) return rpc(id, { content: [{ type: 'text', text: bad }], isError: true });
      try {
        return rpc(id, toolResult(await tool.run(args)));
      } catch (e) {
        return rpc(id, { content: [{ type: 'text', text: 'No he podido consultar iTranvías. Prueba en un momento.' }], isError: true });
      }
    }
    default:
      return rpcError(id, -32601, 'Method not found: ' + msg.method);
  }
}

// ---------- OAuth 2.1 client_credentials (nivel servicio, scope mcp:service) ----------
const TOKEN_TTL = 3600;
const enc = new TextEncoder();
const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64urlText = (s) => b64url(enc.encode(s));
const fromB64url = (s) => atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));

async function hmac(key, data) {
  const k = await crypto.subtle.importKey('raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(await crypto.subtle.sign('HMAC', k, enc.encode(data)));
}
function safeEqual(a, b) {
  a = String(a); b = String(b);
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}
function tokenError(error, status = 400) {
  return new Response(JSON.stringify({ error }), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', pragma: 'no-cache' } });
}

async function oauthToken(req, env, url) {
  if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405, headers: { allow: 'POST' } });
  if (url.searchParams.has('client_id') || url.searchParams.has('client_secret')) return tokenError('invalid_request');
  if (!mcpAuthEnabled(env)) return tokenError('invalid_client', 401);

  let p = {};
  const ct = req.headers.get('content-type') || '';
  try {
    if (ct.includes('application/json')) p = await req.json();
    else p = Object.fromEntries(new URLSearchParams(await req.text()));
  } catch (e) { return tokenError('invalid_request'); }

  if (p.grant_type !== 'client_credentials') return tokenError('unsupported_grant_type');

  let id = p.client_id, secret = p.client_secret;
  const basic = (req.headers.get('authorization') || '').match(/^Basic\s+(\S+)$/i);
  if (basic) {
    try {
      const raw = atob(basic[1]), i = raw.indexOf(':');
      id = decodeURIComponent(raw.slice(0, i)); secret = decodeURIComponent(raw.slice(i + 1));
    } catch (e) { return tokenError('invalid_client', 401); }
  }
  if (!id || !secret || !safeEqual(id, env.MCP_CLIENT_ID) || !safeEqual(secret, env.MCP_CLIENT_SECRET)) return tokenError('invalid_client', 401);

  if (p.scope && p.scope.split(' ').some((s) => s !== MCP_SCOPE)) return tokenError('invalid_scope');
  if (p.resource && !String(p.resource).startsWith(url.origin)) return tokenError('invalid_target');

  const now = Math.floor(Date.now() / 1000);
  const payload = b64urlText(JSON.stringify({ iss: url.origin, aud: url.origin + '/mcp', sub: id, scope: MCP_SCOPE, iat: now, exp: now + TOKEN_TTL }));
  const token = payload + '.' + (await hmac(env.MCP_CLIENT_SECRET, payload));
  // Sin refresh_token en client_credentials.
  return new Response(JSON.stringify({ access_token: token, token_type: 'Bearer', expires_in: TOKEN_TTL, scope: MCP_SCOPE }),
    { headers: { 'content-type': 'application/json', 'cache-control': 'no-store', pragma: 'no-cache' } });
}

async function verifyToken(token, env, origin) {
  const [payload, sig] = String(token).split('.');
  if (!payload || !sig) return false;
  if (!safeEqual(sig, await hmac(env.MCP_CLIENT_SECRET, payload))) return false;
  try {
    const c = JSON.parse(fromB64url(payload));
    return c.aud === origin + '/mcp' && c.scope === MCP_SCOPE && c.exp > Math.floor(Date.now() / 1000);
  } catch (e) { return false; }
}

// =====================================================================
// MCP PÚBLICO (/mcp/public): genérico, sin datos personales ni auth.
// Herramientas: buscar_parada, paradas_cercanas, proximos_buses, horario_parada, horario_linea.
// Caché en memoria (caches.default no funciona en *.workers.dev) + tope global por isolate.
// No se limita por IP: los clientes como Claude llaman desde unas pocas IPs compartidas por
// todos sus usuarios. A iTranvías lo protegen la caché, el presupuesto y la pausa.
// =====================================================================

var PUB_STOP_TTL = 60e3;            // tiempos en vivo: 60 s por parada (iTranvías: máx. 4 peticiones/min por IP)
var PUB_META_TTL = 6 * 3600e3;      // paradas y líneas: 6 h
var PUB_DEP_TTL = 6 * 3600e3;       // horarios programados: 6 h
var PUB_RATE_PER_MIN = 600;         // peticiones por minuto en total (por isolate): solo contra abusos
var pubCache = new Map();
var pubHits = new Map();

// Caché en memoria con deduplicación de peticiones en vuelo.
// (caches.default no hace nada en *.workers.dev)
function pubMemo(key, ttl, fn) {
  const now = Date.now();
  const hit = pubCache.get(key);
  if (hit && hit.exp > now) return hit.p;
  const p = Promise.resolve().then(fn);
  const entry = { p, exp: now + ttl };
  pubCache.set(key, entry);
  p.catch(() => { if (pubCache.get(key) === entry) pubCache.delete(key); });
  if (pubCache.size > 500) pubCache.delete(pubCache.keys().next().value);
  return p;
}

function pubRateLimited(req) {
  const k = String(Math.floor(Date.now() / 60000));
  const n = (pubHits.get(k) || 0) + 1;
  if (!pubHits.has(k)) pubHits.clear();
  pubHits.set(k, n);
  return n > PUB_RATE_PER_MIN;
}

function pubMeta() {
  return pubMemo("meta", PUB_META_TTL, async () => {
    const m = await getMeta();
    if (!m || !m.stops || !Object.keys(m.stops).length) throw new Error("meta vacía");
    return m;
  });
}

// Llegadas de una parada. Orden: memoria del isolate (60 s) → caché compartida en D1 (60 s)
// → iTranvías. Si iTranvías falla o está en pausa, devuelve el último dato bueno
// (hasta STALE_MAX) con los minutos ya descontados y stale: true.
var STALE_MAX = 15 * 60e3;
var lastGood = new Map();

// Lo que ven todos (Alexa, MCP, panel, web): tiempo real + huecos rellenados con el horario.
async function pubStop(id) {
  const d = await pubStopRaw(id);
  if (d.programado) return d;
  try { return await fillFromSchedule(id, d); } catch (e) { return d; }
}

function pubStopRaw(id) {
  return pubMemo("stop:" + id, PUB_STOP_TTL, async () => {
    const shared = await stopCacheGet(id);
    if (shared && Date.now() - shared.at < PUB_STOP_TTL) return shared;
    try {
      const { r, j } = await upstreamJSON(API + "?dato=" + id + "&func=0", { headers: UPSTREAM_HEADERS, cache: "no-store" });
      if (!r.ok) throw new Error("iTranvías " + r.status);
      const prev = lastGood.get(id) || shared;
      const d = { at: Date.now(), lineas: withGhosts(prev, (j.buses && j.buses.lineas) || []) };
      lastGood.set(id, d);
      await stopCachePut(id, d);
      return d;
    } catch (e) {
      const mem = lastGood.get(id);
      const old = mem && (!shared || mem.at >= shared.at) ? mem : shared;
      if (old && Date.now() - old.at < STALE_MAX) return staleStop(old);
      // Sin dato reciente: horario programado del GTFS (no gasta cupo).
      try { return await scheduledStop(id); } catch (e2) {}
      throw e;
    }
  });
}

// iTranvías solo lista los buses que está siguiendo: uno que espera en cabecera o pierde el
// GPS desaparece unos minutos. Dos remedios:
// 1) withGhosts: si un bus visto en vivo desaparece cuando aún le faltaban > 2 min, se mantiene
//    hasta 10 min con su hora estimada y sinSenal: true.
// 2) fillFromSchedule: horas del horario (próximos 60 min) sin ningún bus en vivo cerca
//    (de 3 min antes a 8 min después) se añaden con programado: true.
var GHOST_MAX = 10 * 60e3;
function withGhosts(prev, lineas) {
  if (!prev || !prev.lineas) return lineas;
  const now = Date.now();
  const gone = (now - prev.at) / 60000;
  const out = lineas.map((l) => ({ ...l, buses: (l.buses || []).slice() }));
  for (const pl of prev.lineas) {
    for (const b of pl.buses || []) {
      if (b.programado) continue;
      const left = parseMin(b.tiempo) - gone;
      const lost = b.sinSenal ? b.desde : prev.at;
      if (left <= 2 || now - lost > GHOST_MAX) continue;
      let l = out.find((x) => x.linea === pl.linea);
      const seen = l && l.buses.some((x) => Math.abs(parseMin(x.tiempo) - left) <= 3);
      if (seen) continue;
      if (!l) { l = { ...pl, buses: [] }; out.push(l); }
      l.buses.push({ tiempo: Math.round(left), sinSenal: true, desde: lost });
    }
  }
  for (const l of out) l.buses.sort((a, b) => parseMin(a.tiempo) - parseMin(b.tiempo));
  return out;
}

async function fillFromSchedule(id, d) {
  const t = madridNow(d.at);
  const st = await gtfsStopTimes(id, t.date.replace(/-/g, ""));
  if (!st) return d;
  const lineas = d.lineas.map((l) => ({ ...l, buses: (l.buses || []).slice() }));
  let added = false;
  for (const lid in st.lines) {
    // Desde 2 min: un bus del horario "llegando" que iTranvías no ve probablemente ya pasó.
    const slots = st.lines[lid].filter((m) => m - t.min >= 2 && m - t.min <= 60);
    if (!slots.length) continue;
    let l = lineas.find((x) => x.linea === Number(lid));
    const live = l ? l.buses.map((b) => parseMin(b.tiempo)) : [];
    const used = new Set();
    for (const m of slots) {
      const rel = m - t.min;
      const k = live.findIndex((x, i) => !used.has(i) && x >= rel - 3 && x <= rel + 8);
      if (k >= 0) { used.add(k); continue; }
      if (!l) { l = { linea: Number(lid), buses: [] }; lineas.push(l); }
      l.buses.push({ tiempo: rel, programado: true });
      added = true;
    }
  }
  if (!added) return d;
  for (const l of lineas) l.buses.sort((a, b) => parseMin(a.tiempo) - parseMin(b.tiempo));
  return { ...d, lineas };
}

// Pasa un dato viejo a "ahora": resta los minutos transcurridos y quita los buses que ya pasaron.
function staleStop(d) {
  const now = Date.now();
  const gone = Math.floor((now - d.at) / 60000);
  const lineas = d.lineas.map((l) => ({
    ...l,
    buses: (l.buses || [])
      .map((b) => ({ ...b, tiempo: Math.round(parseMin(b.tiempo)) - gone }))
      .filter((b) => b.tiempo >= 0)
  })).filter((l) => l.buses.length);
  return { at: now, lineas, stale: true, age: Math.round((now - d.at) / 1000) };
}

// Adaptador para el código que esperaba la respuesta cruda de iTranvías
function stopAsUpstream(d) {
  const gone = Math.floor((Date.now() - d.at) / 60000);
  return { buses: { lineas: d.lineas.map((l) => ({ ...l, buses: (l.buses || []).map((b) => ({ ...b, tiempo: Math.max(0, Math.round(parseMin(b.tiempo)) - gone) })) })) } };
}

async function stopCacheGet(id) {
  if (!(await stateReady())) return null;
  try {
    const row = await ENV.DB.prepare("SELECT v FROM state WHERE k = ?").bind("stop:" + id).first();
    return row ? JSON.parse(row.v) : null;
  } catch (e) { return null; }
}

async function stopCachePut(id, d) {
  if (!(await stateReady())) return;
  try { await ENV.DB.prepare("INSERT OR REPLACE INTO state (k, v) VALUES (?, ?)").bind("stop:" + id, JSON.stringify(d)).run(); } catch (e) {}
}

function pubDepartures(lineId, ymd) {
  return pubMemo("dep:" + lineId + ":" + ymd, PUB_DEP_TTL, () => departures(lineId, ymd));
}

function pubLineName(meta, id) {
  return (meta.lines[id] && meta.lines[id].n) || LINE_NAMES[id] || String(Math.floor(id / 100));
}

function pubStopName(meta, id) {
  return speakStop(meta.stops[id] || "Parada " + id);
}

// Búsqueda de paradas por texto (sin alias personales tipo "casa").
// iTranvías da los nombres en gallego: se aceptan equivalentes en castellano.
var PUB_ES_GL = { cuatro: "catro", puerta: "porta", playa: "praia", iglesia: "igrexa", puerto: "porto", universidad: "universidade", ayuntamiento: "concello", castillo: "castelo", nuevo: "novo", nueva: "nova", jardin: "xardin", jardines: "xardins", junta: "xunta", torre: "torre", estacion: "estacion" };
function pubSearchStops(meta, texto, limit = 8) {
  const raw = String(texto == null ? "" : texto).trim();
  if (/^\d+$/.test(raw) && meta.stops[raw]) return [Number(raw)];
  const toks = norm(raw).split(" ").filter((t) => t && !STOP_WORDS.has(t));
  if (!toks.length) return [];
  if (toks.length === 1 && /^\d+$/.test(toks[0]) && meta.stops[toks[0]]) return [Number(toks[0])];
  const nums = toks.filter((t) => /^\d+$/.test(t));
  const words = toks.filter((t) => !/^\d+$/.test(t)).map((t) => [t, PUB_ES_GL[t] || t]);
  const hit = (nt, w) => w.some((v) => nt.indexOf(v) >= 0 || (v.length > 3 && nt.some((x) => x.length > 3 && (x.startsWith(v) || v.startsWith(x)))));
  const scored = [];
  for (const id in meta.stops) {
    const nt = norm(meta.stops[id]).split(" ");
    if (nums.some((n) => nt.indexOf(n) < 0)) continue;
    const score = nums.length + words.filter((w) => hit(nt, w)).length;
    if (score > 0 && (words.length === 0 || words.some((w) => hit(nt, w)))) scored.push({ id: Number(id), score });
  }
  scored.sort((a, b) => b.score - a.score || a.id - b.id);
  const best = scored.length ? scored[0].score : 0;
  return scored.filter((s) => s.score === best).slice(0, limit).map((s) => s.id);
}

// Coordenadas de iTranvías → [lat, lon] en grados (o null si no son grados).
function pubLatLon(p) {
  if (!p || p.length < 2) return null;
  const a = Number(p[0]), b = Number(p[1]);
  if (!isFinite(a) || !isFinite(b) || Math.abs(a) > 180 || Math.abs(b) > 180) return null;
  return a > 0 && b < 0 ? [a, b] : [b, a]; // Galicia: lat > 0, lon < 0
}

function pubDist(a, b) {
  const R = 6371e3, r = Math.PI / 180;
  const dLa = (b[0] - a[0]) * r, dLo = (b[1] - a[1]) * r;
  const h = Math.sin(dLa / 2) ** 2 + Math.cos(a[0] * r) * Math.cos(b[0] * r) * Math.sin(dLo / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

async function pubLiveText(meta, sid, lineId, max = 3) {
  let head = "Parada " + sid + " — " + pubStopName(meta, sid);
  let d;
  try { d = await pubStop(sid); } catch (e) { return head + ": iTranvías no responde ahora mismo."; }
  if (d.programado) head += " (horario programado: iTranvías no responde ahora mismo)";
  const elapsed = (Date.now() - d.at) / 60000;
  const now = madridNow().min;
  const items = [];
  for (const l of d.lineas) {
    if (lineId && l.linea !== lineId) continue;
    const mins = (l.buses || [])
      .map((b) => ({ m: Math.max(0, Math.round(parseMin(b.tiempo) - elapsed)), tag: d.programado ? "" : b.programado ? " según horario" : b.sinSenal ? " sin señal, estimado" : "" }))
      .sort((a, b) => a.m - b.m)
      .slice(0, max);
    if (mins.length) items.push({ n: pubLineName(meta, l.linea), mins });
  }
  items.sort((a, b) => a.mins[0].m - b.mins[0].m);
  if (!items.length) {
    return head + ": no hay buses próximos" + (lineId ? " de la línea " + pubLineName(meta, lineId) : "") + ".";
  }
  return head + "\n" + items.map((x) =>
    "- Línea " + x.n + ": " + x.mins.map((y) => (y.m <= 1 ? "llegando" : y.m + " min (" + fmt(now + y.m) + (y.tag ? "," + y.tag : "") + ")")).join(", ")
  ).join("\n");
}

var PUB_RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true };

var PUB_TOOLS = [
  {
    name: "buscar_parada",
    title: "Buscar parada",
    description: 'Find A Coruña (Spain) city bus stops by street or place name, or by stop number. Returns stop numbers and names. Use it to resolve a stop before calling proximos_buses when the user gives a vague place. Reply in the user\'s language.',
    inputSchema: {
      type: "object",
      properties: { texto: { type: "string", description: 'Calle, lugar o número de parada, p. ej. "Ronda de Outeiro 126", "Cuatro Caminos", "523"' } },
      required: ["texto"],
      additionalProperties: false
    },
    annotations: PUB_RO,
    validate: (a) => (String(a.texto || "").trim().length < 2 ? "Indica al menos 2 caracteres." : null),
    run: async (a) => {
      const meta = await pubMeta();
      const ids = pubSearchStops(meta, a.texto, 8);
      if (!ids.length) return "No encuentro paradas para «" + a.texto + "». Prueba con el nombre de la calle.";
      return "Paradas encontradas:\n" + ids.map((id) => "- Parada " + id + ": " + pubStopName(meta, id)).join("\n");
    }
  },
  {
    name: "paradas_cercanas",
    title: "Paradas cercanas",
    description: "Nearest A Coruña city bus stops to a location (latitude/longitude), with live arrivals for the closest ones. Use for \"¿qué bus pasa cerca de mí?\" when the client knows the user's location or a place's coordinates.",
    inputSchema: {
      type: "object",
      properties: {
        lat: { type: "number", description: "Latitud (grados decimales)" },
        lon: { type: "number", description: "Longitud (grados decimales)" },
        radio_m: { type: "integer", minimum: 50, maximum: 1500, description: "Radio de búsqueda en metros (por defecto 400)" },
        con_tiempos: { type: "boolean", description: "Incluir tiempos en vivo de las 3 más cercanas (por defecto true)" }
      },
      required: ["lat", "lon"],
      additionalProperties: false
    },
    annotations: PUB_RO,
    _meta: UI_META,
    validate: (a) => (typeof a.lat !== "number" || typeof a.lon !== "number" || Math.abs(a.lat) > 90 || Math.abs(a.lon) > 180 ? "lat y lon deben ser números en grados." : null),
    run: async (a) => {
      const meta = await pubMeta();
      const here = [a.lat, a.lon];
      const radio = Math.min(1500, Math.max(50, a.radio_m || 400));
      const all = [];
      for (const id in meta.pos || {}) {
        const p = pubLatLon(meta.pos[id]);
        if (p) all.push({ id: Number(id), m: Math.round(pubDist(here, p)) });
      }
      if (!all.length) return "No tengo coordenadas de paradas ahora mismo. Usa buscar_parada con el nombre de la calle.";
      all.sort((x, y) => x.m - y.m);
      if (all[0].m > 5000) return "Esa ubicación está fuera de la red de buses de A Coruña.";
      const near = all.filter((x) => x.m <= radio).slice(0, 5);
      if (!near.length) return "No hay paradas a menos de " + radio + " m. La más cercana es la " + all[0].id + " (" + pubStopName(meta, all[0].id) + "), a " + all[0].m + " m.";
      let text = "Paradas cercanas:\n" + near.map((x) => "- Parada " + x.id + ": " + pubStopName(meta, x.id) + " (" + x.m + " m)").join("\n");
      if (a.con_tiempos !== false) {
        const live = await Promise.all(near.slice(0, 3).map((x) => pubLiveText(meta, x.id, null, 2)));
        text += "\n\nPróximos buses:\n" + live.join("\n\n");
        return withUi(text, async () => {
          const top = near.slice(0, 3), dist = {};
          for (const x of top) dist[x.id] = x.m;
          return uiPayload("Paradas cercanas", await uiBoards(meta, top.map((x) => x.id), { dist }), { tool: "paradas_cercanas", arguments: a });
        });
      }
      return text;
    }
  },
  {
    name: "proximos_buses",
    title: "Próximos buses en una parada",
    description: 'Live next arrivals (iTranvías real time) at an A Coruña city bus stop, optionally filtered by line. Give the stop by number or by street/place name. Use for "¿cuándo pasa el 14 por Outeiro 126?", "¿qué buses pasan por Cuatro Caminos?".',
    inputSchema: {
      type: "object",
      properties: {
        parada: { type: "string", description: 'Calle o lugar de la parada, p. ej. "Ronda de Outeiro 126"' },
        numero_parada: { type: "integer", minimum: 1, description: "Número de parada de iTranvías" },
        linea: { type: "string", description: 'Línea opcional, p. ej. "14" o "12A"' }
      },
      additionalProperties: false
    },
    annotations: PUB_RO,
    _meta: UI_META,
    validate: (a) => (a.parada || a.numero_parada ? null : "Indica una parada (nombre o número)."),
    run: async (a) => {
      const meta = await pubMeta();
      let lineId = null;
      if (a.linea) {
        lineId = findLine(meta, a.linea);
        if (!lineId) return "No conozco la línea «" + a.linea + "».";
      }
      let ids = [];
      if (a.numero_parada && meta.stops[a.numero_parada]) ids = [Number(a.numero_parada)];
      else if (a.numero_parada && !a.parada) return "No existe la parada " + a.numero_parada + ".";
      else ids = pubSearchStops(meta, a.parada, 8);
      if (!ids.length) return "No encuentro la parada «" + (a.parada || a.numero_parada) + "». Prueba buscar_parada.";
      if (ids.length > 2) {
        return "Hay varias paradas que encajan; pide el número:\n" + ids.map((id) => "- Parada " + id + ": " + pubStopName(meta, id)).join("\n");
      }
      // 1 o 2 resultados (p. ej. la misma calle a cada lado): se muestran ambos
      const out = await Promise.all(ids.map((id) => pubLiveText(meta, id, lineId, 3)));
      return withUi(out.join("\n\n"), async () => {
        const title = lineId ? "Línea " + pubLineName(meta, lineId) : ids.length === 1 ? pubStopName(meta, ids[0]) : "Próximos buses";
        return uiPayload(title, await uiBoards(meta, ids, { lineId }), { tool: "proximos_buses", arguments: a });
      });
    }
  },
  {
    name: "horario_parada",
    title: "Horario programado en una parada",
    description: "Scheduled times (timetable, not real time) at an A Coruña city bus stop for a date, optionally for one line and from a given time. Use for planning ahead: \"¿a qué hora pasa el 14 por Outeiro 126 mañana a las 8?\", first/last bus at a stop. Free of the real-time quota: prefer it over proximos_buses for anything not happening in the next minutes.",
    inputSchema: {
      type: "object",
      properties: {
        parada: { type: "string", description: 'Calle o lugar de la parada, p. ej. "Ronda de Outeiro 126"' },
        numero_parada: { type: "integer", minimum: 1, description: "Número de parada de iTranvías" },
        linea: { type: "string", description: 'Línea opcional, p. ej. "14" o "12A"' },
        fecha: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "Fecha YYYY-MM-DD (por defecto hoy)" },
        desde: { type: "string", pattern: "^\\d{1,2}(:\\d{2})?$", description: "Desde esta hora (HH:MM, por defecto ahora si es hoy)" }
      },
      additionalProperties: false
    },
    annotations: PUB_RO,
    validate: (a) => (!a.parada && !a.numero_parada ? "Indica una parada (nombre o número)." : a.fecha && !/^\d{4}-\d{2}-\d{2}$/.test(a.fecha) ? "fecha debe ser YYYY-MM-DD." : a.desde && parseHHMM(a.desde) == null ? "desde debe ser HH:MM." : null),
    run: async (a) => {
      const meta = await pubMeta();
      let lineId = null;
      if (a.linea) { lineId = findLine(meta, a.linea); if (!lineId) return "No conozco la línea «" + a.linea + "»."; }
      let ids = [];
      if (a.numero_parada && meta.stops[a.numero_parada]) ids = [Number(a.numero_parada)];
      else if (a.numero_parada && !a.parada) return "No existe la parada " + a.numero_parada + ".";
      else ids = pubSearchStops(meta, a.parada, 8);
      if (!ids.length) return "No encuentro la parada «" + (a.parada || a.numero_parada) + "». Prueba buscar_parada.";
      if (ids.length > 2) return "Hay varias paradas que encajan; pide el número:\n" + ids.map((id) => "- Parada " + id + ": " + pubStopName(meta, id)).join("\n");
      const now = madridNow();
      const date = a.fecha || now.date;
      const desde = a.desde ? parseHHMM(a.desde) : date === now.date ? now.min : 0;
      const out = [];
      for (const id of ids) {
        const st = await gtfsStopTimes(id, date.replace(/-/g, ""));
        if (!st) return "No tengo el horario programado para el " + date + " (el GTFS publicado no cubre esa fecha).";
        const rows = [];
        for (const lid in st.lines) {
          if (lineId && Number(lid) !== lineId) continue;
          const xs = st.lines[lid].filter((m) => m >= desde).slice(0, 8);
          if (xs.length) rows.push({ n: pubLineName(meta, Number(lid)), first: xs[0], xs });
        }
        rows.sort((x, y) => x.first - y.first);
        out.push("Parada " + id + " — " + pubStopName(meta, id) + " · " + date + (st.tipo ? " (" + st.tipo + ")" : "") + ", desde las " + fmt(desde) + ", horario programado:\n" +
          (rows.length ? rows.map((r) => "- Línea " + r.n + ": " + r.xs.map(fmt).join(", ")).join("\n") : "- No hay más buses" + (lineId ? " de la línea " + pubLineName(meta, lineId) : "") + " ese día."));
      }
      return out.join("\n\n");
    }
  },
  {
    name: "horario_linea",
    title: "Horario programado de una línea",
    description: "Scheduled departure times of an A Coruña city bus line from each terminus for a given date (not times at intermediate stops). Use for first/last bus questions or planning ahead.",
    inputSchema: {
      type: "object",
      properties: {
        linea: { type: "string", description: 'Línea, p. ej. "14" o "12A"' },
        fecha: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "Fecha YYYY-MM-DD (por defecto hoy)" },
        desde: { type: "string", pattern: "^\\d{1,2}(:\\d{2})?$", description: "Solo salidas a partir de esta hora (HH:MM, opcional)" }
      },
      required: ["linea"],
      additionalProperties: false
    },
    annotations: PUB_RO,
    validate: (a) => (!a.linea ? "Indica la línea." : a.fecha && !/^\d{4}-\d{2}-\d{2}$/.test(a.fecha) ? "fecha debe ser YYYY-MM-DD." : a.desde && parseHHMM(a.desde) == null ? "desde debe ser HH:MM." : null),
    run: async (a) => {
      const meta = await pubMeta();
      const lineId = findLine(meta, a.linea);
      if (!lineId) return "No conozco la línea «" + a.linea + "».";
      const date = a.fecha || madridNow().date;
      const dep = await gtfsDepartures(lineId, date.replace(/-/g, "")) || await pubDepartures(lineId, date.replace(/-/g, ""));
      const info = meta.lines[lineId] || {};
      const desde = a.desde ? parseHHMM(a.desde) : null;
      const pick = (arr) => {
        const xs = (arr || []).filter((m) => desde == null || m >= desde);
        return desde == null ? xs : xs.slice(0, 10);
      };
      const ida = pick(dep.ida), vuelta = pick(dep.vuelta);
      const n = pubLineName(meta, lineId);
      if (!ida.length && !vuelta.length) return "La línea " + n + " no tiene salidas" + (desde != null ? " a partir de las " + fmt(desde) : "") + " el " + date + ".";
      const block = (from, to, xs) => xs.length ? "Desde " + (from || "cabecera") + (to ? " hacia " + to : "") + ": " + xs.map(fmt).join(", ") : "";
      return ["Línea " + n + " — " + date + (dep.tipo ? " (" + dep.tipo + ")" : "") + ". Horas de salida desde cabecera:",
        block(dep.oIda || info.o, dep.dIda || info.d, ida), block(dep.oVuelta || info.d, dep.dVuelta || info.o, vuelta)].filter(Boolean).join("\n");
    }
  }
];

async function mcpPublic(req, env, url) {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: MCP_CORS });
  if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405, headers: { allow: "POST, OPTIONS", ...MCP_CORS } });
  if (pubRateLimited(req)) return rpcError(null, -32000, "Servidor ocupado, prueba en un minuto.", 429);
  let msg;
  try { msg = await req.json(); } catch (e) { return rpcError(null, -32700, "Parse error", 400); }
  if (Array.isArray(msg) || !msg || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
    if (msg && !Array.isArray(msg) && msg.jsonrpc === "2.0" && msg.method === void 0) return new Response(null, { status: 202, headers: MCP_CORS });
    return rpcError(null, -32600, "Invalid Request", 400);
  }
  if (msg.id === void 0) return new Response(null, { status: 202, headers: MCP_CORS });
  const id = msg.id, params = msg.params || {};
  switch (msg.method) {
    case "initialize": {
      const asked = params.protocolVersion;
      return rpc(id, {
        protocolVersion: MCP_VERSIONS.includes(asked) ? asked : MCP_VERSIONS[0],
        capabilities: { tools: { listChanged: false }, resources: { listChanged: false } },
        serverInfo: { name: "bus-coruna", title: "Bus A Coruña", version: "1.0.0" },
        instructions: "Buses urbanos de A Coruña (iTranvías): paradas, tiempos de llegada en vivo y horarios programados. Si el usuario da un lugar vago, usa buscar_parada o paradas_cercanas primero. Para tiempo real (próximos minutos) usa proximos_buses; para planificar o consultar otra hora, horario_parada. Recuerda tú (el cliente) sus paradas habituales; este servidor no guarda nada del usuario. Fuente no oficial: los tiempos pueden fallar."
      });
    }
    case "ping":
      return rpc(id, {});
    case "tools/list":
      return rpc(id, { tools: PUB_TOOLS.map(({ run, validate, ...t }) => t) });
    case "resources/list":
      return rpc(id, uiResourceList());
    case "resources/templates/list":
      return rpc(id, { resourceTemplates: [] });
    case "resources/read": {
      const r = uiResourceRead(params.uri);
      return r ? rpc(id, r) : rpcError(id, -32002, "Resource not found: " + params.uri);
    }
    case "tools/call": {
      const tool = PUB_TOOLS.find((t) => t.name === params.name);
      if (!tool) return rpcError(id, -32602, "Unknown tool: " + params.name);
      const args = params.arguments && typeof params.arguments === "object" ? params.arguments : {};
      const bad = tool.validate && tool.validate(args);
      if (bad) return rpc(id, { content: [{ type: "text", text: bad }], isError: true });
      try {
        return rpc(id, toolResult(await tool.run(args)));
      } catch (e) {
        return rpc(id, { content: [{ type: "text", text: "No he podido consultar iTranvías. Prueba en un momento." }], isError: true });
      }
    }
    default:
      return rpcError(id, -32601, "Method not found: " + msg.method);
  }
}

// =====================================================================
// Registro de peticiones de Alexa en D1 (binding DB): qué intent llegó, con
// qué slots, qué respondió la skill y qué devolvió iTranvías. Últimas 500.
// =====================================================================
var ALEXA_TRACE = null;
// ---------- Registro de fallos de iTranvías ----------
// Cada llamada a iTranvías pasa por aquí. Si falla la red, el HTTP no es 2xx, la respuesta
// no es JSON o una consulta de parada (func=0) viene sin "buses", se guarda en D1
// (tabla upstream_log) el código, las cabeceras útiles y el principio del cuerpo.
var UPSTREAM_ERR = [];

// Límites de iTranvías por IP (su página de 429): 1/s, 4/min, 199/h, 1999/día.
// - Cola: como mucho una petición cada UPSTREAM_GAP ms (por isolate).
// - Pausa: tras un 429 no se llama a iTranvías durante 1, 2, 4, 8… min (máx. 30),
//   compartida entre isolates vía D1. Insistir solo alarga el bloqueo.
var ENV = null;
var UPSTREAM_GAP = 1100;
var upstreamQueue = Promise.resolve();
var upstreamLast = 0;
var breaker = { until: 0, strikes: 0, checked: 0 };

async function breakerLoad() {
  if (Date.now() - breaker.checked < 10e3 || !(await stateReady())) return;
  breaker.checked = Date.now();
  try {
    const row = await ENV.DB.prepare("SELECT v FROM state WHERE k = 'breaker'").first();
    if (row) {
      const b = JSON.parse(row.v);
      if (b.until > breaker.until) { breaker.until = b.until; breaker.strikes = b.strikes; }
      if (b.until === 0 && b.strikes === 0) breaker.strikes = 0;
    }
  } catch (e) {}
}

async function breakerSave() {
  if (!(await stateReady())) return;
  try {
    await ENV.DB.prepare("INSERT OR REPLACE INTO state (k, v) VALUES ('breaker', ?)")
      .bind(JSON.stringify({ until: breaker.until, strikes: breaker.strikes })).run();
  } catch (e) {}
}

function upstreamSlot() {
  const p = upstreamQueue.then(async () => {
    const wait = upstreamLast + UPSTREAM_GAP - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    upstreamLast = Date.now();
  });
  upstreamQueue = p.catch(() => {});
  return p;
}

// Presupuesto compartido entre isolates (D1), un poco por debajo de los límites de
// iTranvías para no llegar nunca al 429: 4/min, 190/h, 1950/día. Si no queda cupo,
// no se llama a iTranvías y quien llama sirve el último dato bueno.
var BUDGET = [["m", 60e3, 4], ["h", 3600e3, 190], ["d", 86400e3, 1950]];

async function budgetTake() {
  if (!(await stateReady())) return true;
  const now = Date.now();
  const keys = BUDGET.map(([k, span]) => "budget:" + k + ":" + Math.floor(now / span));
  try {
    const rows = (await ENV.DB.prepare("SELECT k, v FROM state WHERE k IN (?, ?, ?)").bind(...keys).all()).results || [];
    const used = Object.fromEntries(rows.map((r) => [r.k, Number(r.v) || 0]));
    if (keys.some((k, i) => (used[k] || 0) >= BUDGET[i][2])) return false;
    const up = "INSERT INTO state (k, v) VALUES (?, '1') ON CONFLICT(k) DO UPDATE SET v = CAST(v AS INTEGER) + 1";
    const stmts = keys.map((k) => ENV.DB.prepare(up).bind(k));
    // Limpieza de contadores viejos de vez en cuando
    if (Math.random() < 0.05) {
      stmts.push(ENV.DB.prepare("DELETE FROM state WHERE k LIKE 'budget:m:%' AND k <> ?").bind(keys[0]));
      stmts.push(ENV.DB.prepare("DELETE FROM state WHERE k LIKE 'budget:h:%' AND k <> ?").bind(keys[1]));
      stmts.push(ENV.DB.prepare("DELETE FROM state WHERE k LIKE 'budget:d:%' AND k <> ?").bind(keys[2]));
    }
    await ENV.DB.batch(stmts);
    return true;
  } catch (e) { return true; }
}

// ---------- Horario programado (GTFS de Tranvías publicado en GitHub Pages) ----------
// tools/gtfs_build.py genera gtfs/index.json, gtfs/meta.json y gtfs/stops/<id>.json.
// Se leen de GitHub Pages (no de iTranvías: no gastan cupo) y se guardan 24 h en D1.
var GTFS_BASE = "https://yomergonzalez.github.io/Mibus/gtfs/";
var GTFS_TTL = 24 * 3600e3;
var PROG_NOTE = " Es el horario programado: iTranvías no responde ahora mismo.";
var PROG_PART = " Alguna de esas horas es del horario programado, no del tiempo real.";

function gtfsJSON(path) {
  return pubMemo("gtfs:" + path, 10 * 60e3, () => sharedCache("gtfs:" + path, GTFS_TTL, async () => {
    const r = await fetch(GTFS_BASE + path, { headers: { "Accept": "application/json" } });
    // Un 404 no se guarda: si el Worker se despliega antes que GitHub Pages, se vuelve a probar.
    if (!r.ok) throw new Error("GTFS " + r.status);
    return r.json();
  }));
}

// Tipos de día que rigen una fecha (YYYYMMDD) y su nombre; null si el GTFS no la cubre.
async function gtfsDay(ymd) {
  const idx = await gtfsJSON("index.json");
  const pats = idx && idx.dias && idx.dias[ymd];
  if (!pats || !pats.length) return null;
  const t = (idx.tipos || []).find((x) => x.id === pats[0]);
  return { pats, tipo: (t && t.nombre) || "" };
}

// Horas de paso programadas (minutos desde las 00:00) por línea en una parada y fecha.
async function gtfsStopTimes(id, ymd) {
  const day = await gtfsDay(ymd);
  if (!day) return null;
  const st = await gtfsJSON("stops/" + id + ".json").catch(() => null); // parada sin servicio: sin fichero
  const lines = {};
  for (const lid in (st && st.l) || {}) {
    const set = new Set();
    for (const p of day.pats) for (const m of st.l[lid][p] || []) set.add(m);
    if (set.size) lines[lid] = [...set].sort((a, b) => a - b);
  }
  return { tipo: day.tipo, lines };
}

// Salidas desde cabecera de una línea (como func=8), del GTFS. null si no cubre la fecha.
async function gtfsDepartures(lineId, ymd) {
  const day = await gtfsDay(ymd).catch(() => null);
  if (!day) return null;
  const l = await gtfsJSON("lines/" + lineId + ".json").catch(() => null);
  if (!l) return null;
  const pick = (d) => {
    const set = new Set();
    for (const p of day.pats) for (const m of (d && d.s && d.s[p]) || []) set.add(m);
    return [...set].sort((a, b) => a - b);
  };
  // Sentidos del GTFS (direction_id 0 y 1) con su cabecera y destino reales, para nombrarlos bien.
  const d0 = l.d["0"], d1 = l.d["1"];
  return { tipo: day.tipo, ida: pick(d0), vuelta: pick(d1), oIda: d0 && d0.desde, dIda: d0 && d0.hacia, oVuelta: d1 && d1.desde, dVuelta: d1 && d1.hacia };
}

// Próximos buses según horario, con la forma de pubStop. Solo para cuando iTranvías no responde.
async function scheduledStop(id) {
  const now = madridNow();
  const st = await gtfsStopTimes(id, now.date.replace(/-/g, ""));
  if (!st) throw new Error("sin horario programado para hoy");
  const lineas = [];
  for (const lid in st.lines) {
    const buses = st.lines[lid].filter((m) => m >= now.min && m <= now.min + 90).slice(0, 3).map((m) => ({ tiempo: m - now.min }));
    if (buses.length) lineas.push({ linea: Number(lid), buses });
  }
  return { at: Date.now(), lineas, programado: true, tipo: st.tipo };
}

// Caché compartida genérica: memoria del isolate → tabla state de D1 → fn().
// Si fn falla y hay una copia vieja en D1, se usa la vieja (mejor eso que nada).
var sharedMem = new Map();
async function sharedCache(key, ttl, fn) {
  const now = Date.now();
  const m = sharedMem.get(key);
  if (m && now - m.at < ttl) return m.v;
  let row = null;
  if (await stateReady()) {
    try {
      const r = await ENV.DB.prepare("SELECT v FROM state WHERE k = ?").bind("c:" + key).first();
      row = r ? JSON.parse(r.v) : null;
    } catch (e) {}
  }
  if (row && now - row.at < ttl) { sharedMem.set(key, row); return row.v; }
  try {
    const v = await fn();
    const d = { at: Date.now(), v };
    sharedMem.set(key, d);
    if (sharedMem.size > 200) sharedMem.delete(sharedMem.keys().next().value);
    if (await stateReady()) {
      try { await ENV.DB.prepare("INSERT OR REPLACE INTO state (k, v) VALUES (?, ?)").bind("c:" + key, JSON.stringify(d)).run(); } catch (e) {}
    }
    return v;
  } catch (e) {
    const old = (m && (!row || m.at >= row.at)) ? m : row;
    if (old) return old.v;
    throw e;
  }
}

var stateOk = null;
async function stateReady() {
  if (!ENV || !ENV.DB) return false;
  if (stateOk === null) {
    stateOk = ENV.DB.prepare("CREATE TABLE IF NOT EXISTS state (k TEXT PRIMARY KEY, v TEXT)").run().then(() => true, () => false);
  }
  return stateOk;
}

async function upstreamJSON(url, opts) {
  await breakerLoad();
  if (Date.now() < breaker.until) {
    throw new Error("iTranvías en pausa " + Math.ceil((breaker.until - Date.now()) / 1000) + " s (429)");
  }
  if (!(await budgetTake())) throw new Error("iTranvías: cupo agotado (presupuesto propio)");
  await upstreamSlot();
  if (Date.now() < breaker.until) throw new Error("iTranvías en pausa (429)");
  const t0 = Date.now();
  let r, text;
  try {
    r = await fetch(url, opts);
    text = await r.text();
  } catch (e) {
    noteUpstream(url, null, String((e && e.message) || e), t0);
    throw e;
  }
  if (r.status === 429) {
    noteUpstream(url, r, text, t0);
    breaker.strikes = Math.min(breaker.strikes + 1, 6);
    breaker.until = Date.now() + Math.min(60e3 * 2 ** (breaker.strikes - 1), 30 * 60e3);
    await breakerSave();
    throw new Error("iTranvías 429");
  }
  let j;
  try {
    j = JSON.parse(text);
  } catch (e) {
    noteUpstream(url, r, text, t0);
    throw new Error('iTranvías: respuesta no JSON (' + r.status + ')');
  }
  if (!r.ok || (/func=0/.test(url) && !(j && j.buses))) noteUpstream(url, r, text, t0);
  if (breaker.strikes) { breaker.strikes = 0; breaker.until = 0; await breakerSave(); }
  return { r, j };
}

function noteUpstream(url, r, body, t0) {
  if (UPSTREAM_ERR.length >= 10) return;
  UPSTREAM_ERR.push({
    q: url.replace(API, ''),
    status: r ? r.status : 0,
    ms: Date.now() - t0,
    ct: r ? r.headers.get('content-type') : null,
    server: r ? r.headers.get('server') : null,
    body: String(body || '').slice(0, 300)
  });
}

async function logUpstream(env, path, errs) {
  try {
    await env.DB.prepare('CREATE TABLE IF NOT EXISTS upstream_log (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, path TEXT, q TEXT, status INTEGER, ms INTEGER, ct TEXT, server TEXT, body TEXT)').run();
    const ts = new Date().toISOString();
    await env.DB.batch([
      ...errs.map((e) => env.DB.prepare('INSERT INTO upstream_log (ts, path, q, status, ms, ct, server, body) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(ts, path, e.q, e.status, e.ms, e.ct, e.server, e.body)),
      env.DB.prepare('DELETE FROM upstream_log WHERE id <= (SELECT MAX(id) - 500 FROM upstream_log)')
    ]);
  } catch (e) {}
}

function traceUpstream(stop, j) {
  if (!ALEXA_TRACE) return;
  try {
    ALEXA_TRACE.push({ p: stop, l: ((j.buses && j.buses.lineas) || []).map((l) => [l.linea, (l.buses || []).map((b) => b.tiempo)]) });
  } catch (e) {}
}
async function logAlexa(env, body, res, trace) {
  try {
    const out = await res.json().catch(() => ({}));
    const rq = (body && body.request) || {};
    const slots = {};
    for (const [k, v] of Object.entries((rq.intent && rq.intent.slots) || {})) if (v && v.value) slots[k] = v.value;
    const speech = (out.response && out.response.outputSpeech && out.response.outputSpeech.text) || null;
    await env.DB.batch([
      env.DB.prepare('INSERT INTO alexa_log (ts, req_type, intent, slots, speech, upstream) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(new Date().toISOString(), rq.type || null, (rq.intent && rq.intent.name) || null, JSON.stringify(slots), speech, JSON.stringify(trace || []).slice(0, 4000)),
      env.DB.prepare('DELETE FROM alexa_log WHERE id <= (SELECT MAX(id) - 500 FROM alexa_log)')
    ]);
  } catch (e) {}
}

// Registro de llamadas a herramientas del MCP privado (para ver si Alexa+ lo usa).
async function logMcp(env, req, reqText, res, trace) {
  try {
    let msg = {};
    try { msg = JSON.parse(reqText); } catch (e) {}
    if (!msg || msg.method !== 'tools/call') return;
    const out = await res.json().catch(() => ({}));
    const text = (out.result && out.result.content && out.result.content[0] && out.result.content[0].text) || (out.error && out.error.message) || null;
    const ua = (req.headers.get('user-agent') || '?').slice(0, 120);
    await env.DB.batch([
      env.DB.prepare('INSERT INTO alexa_log (ts, req_type, intent, slots, speech, upstream) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(new Date().toISOString(), 'mcp · ' + ua, (msg.params && msg.params.name) || null, JSON.stringify((msg.params && msg.params.arguments) || {}), text, JSON.stringify(trace || []).slice(0, 4000)),
      env.DB.prepare('DELETE FROM alexa_log WHERE id <= (SELECT MAX(id) - 500 FROM alexa_log)')
    ]);
  } catch (e) {}
}
