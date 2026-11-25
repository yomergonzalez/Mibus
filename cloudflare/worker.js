// Mi bus · A Coruña — Cloudflare Worker (proxy de iTranvías + app)
// Sirve la app y hace de proxy a iTranvías (tiempo real de la Compañía de Tranvías).
// Despliegue: Cloudflare → Workers & Pages → Create → Hello World → Edit code → pegar → Deploy.

const API = 'https://itranvias.com/queryitr_v3.php';
const UPSTREAM_HEADERS = {
  'Accept': 'application/json',
  'Referer': 'https://itranvias.com/',
  'User-Agent': 'Mozilla/5.0 (mibus-coruna)'
};

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);

    if (url.pathname === '/api/stop') {
      const id = parseInt(url.searchParams.get('id'), 10);
      if (!id || id < 1 || id > 99999) return json({ error: 'parada inválida' }, 400);
      try {
        const r = await fetch(API + '?dato=' + id + '&func=0', { headers: UPSTREAM_HEADERS });
        const j = JSON.parse(await r.text());
        return json({ parada: id, at: Date.now(), lineas: (j.buses && j.buses.lineas) || [] });
      } catch (e) {
        return json({ error: 'iTranvías no responde' }, 502);
      }
    }

    if (url.pathname === '/api/meta') {
      const cache = caches.default;
      const key = new Request(url.origin + '/api/meta?v=2');
      const hit = await cache.match(key);
      if (hit) return hit;
      try {
        const r = await fetch(API + '?dato=20160101T000000_gl_0_20160101T000000&func=7', { headers: UPSTREAM_HEADERS });
        const j = JSON.parse(await r.text());
        const a = (j.iTranvias && j.iTranvias.actualizacion) || {};
        const lines = {}, stops = {}, pos = {};
        for (const l of a.lineas || []) {
          let c = String(l.color || '').trim();
          if (c && c[0] !== '#') c = '#' + c;
          lines[l.id] = { n: l.lin_comer, c: c, o: l.nombre_orig, d: l.nombre_dest };
        }
        for (const p of a.paradas || []) { stops[p.id] = p.nombre; if (p.posy && p.posx) pos[p.id] = [Number(p.posy), Number(p.posx)]; }
        const res = json({ lines, stops, pos }, 200, 'public, max-age=86400');
        ctx.waitUntil(cache.put(key, res.clone()));
        return res;
      } catch (e) {
        return json({ lines: {}, stops: {} }, 200);
      }
    }

    if (url.pathname === '/alexa' && req.method === 'POST') {
      return alexa(req, env);
    }

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

    return new Response(HTML, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' } });
  }
};

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
        for (const b of l.buses || []) buses.push({ linea: l.linea, t: Number(b.tiempo), dist: Number(b.distancia) });
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
  ida: [{ id: 50, name: 'Ronda de Nelle 109', lines: [1200], walk: 4 }, { id: 94, name: 'Ronda de Outeiro 249', lines: [1400], walk: 5 }],
  vuelta: [
    { id: 40, name: 'Avenida de Oza 7', lines: [1200, 1400], walk: 7 },
    { id: 269, name: 'Ronda de Outeiro, Pérez Ardá', lines: [1400], walk: 5 },
    { id: 120, name: 'Ronda de Outeiro 126', lines: [1400, 1500, 2000], walk: 6 }
  ]
};
const LINE_NAMES = { 1200: '12', 1400: '14', 1500: '12 A', 2000: '20', 2200: '22' };

function alexaSay(text, end = true) {
  return new Response(JSON.stringify({ version: '1.0', response: { outputSpeech: { type: 'PlainText', text }, shouldEndSession: end } }),
    { headers: { 'content-type': 'application/json; charset=utf-8' } });
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
      const r = await fetch(API + '?dato=' + s.id + '&func=0', { headers: UPSTREAM_HEADERS });
      const j = JSON.parse(await r.text());
      for (const l of (j.buses && j.buses.lineas) || []) {
        if (s.lines.indexOf(l.linea) < 0) continue;
        for (const b of l.buses || []) {
          const min = Math.round(parseMin(b.tiempo));
          if (min >= s.walk) all.push({ line: LINE_NAMES[l.linea] || String(Math.floor(l.linea / 100)), min, stop: s.name, leave: min - s.walk });
        }
      }
    } catch (e) {}
  }));
  return all.sort((a, b) => a.leave - b.leave || a.min - b.min);
}

function when(m) { return m <= 1 ? 'está llegando' : 'en ' + m + ' minutos'; }
function leave(m) { return m <= 1 ? 'Sal ya.' : 'Sal en ' + m + (m === 1 ? ' minuto.' : ' minutos.'); }

async function alexa(req, env) {
  let body = {};
  try { body = await req.json(); } catch (e) { return new Response('bad request', { status: 400 }); }
  const appId = body.session && body.session.application && body.session.application.applicationId;
  if (env && env.ALEXA_SKILL_ID && appId !== env.ALEXA_SKILL_ID) return new Response('forbidden', { status: 403 });

  const type = body.request && body.request.type;
  const intent = body.request && body.request.intent && body.request.intent.name;
  if (type === 'SessionEndedRequest') return alexaSay('', true);
  if (intent === 'AMAZON.StopIntent' || intent === 'AMAZON.CancelIntent') return alexaSay('Vale.');
  if (intent === 'AMAZON.HelpIntent') return alexaSay('Puedes decir: cuándo pasa el bus, el bus al trabajo, o el bus a casa.', false);

  const hour = Number(new Intl.DateTimeFormat('es-ES', { timeZone: 'Europe/Madrid', hour: 'numeric', hourCycle: 'h23' }).format(new Date()));
  let trip = hour < 15 ? 'ida' : 'vuelta';
  if (intent === 'IdaIntent') trip = 'ida';
  if (intent === 'VueltaIntent') trip = 'vuelta';

  const buses = await nextBuses(trip);
  if (!buses.length) return alexaSay('Ahora mismo no tengo buses a los que te dé tiempo a llegar, o iTranvías no responde. Prueba en un momento.');
  const [a, b, c] = buses;
  let text = 'El próximo que te da tiempo es el ' + a.line + ' en ' + a.stop + ', ' + when(a.min) + '. ' + leave(a.leave);
  if (b) text += ' Después, el ' + b.line + ' en ' + b.stop + ', ' + when(b.min) + '.';
  if (c) text += ' Y el ' + c.line + ' en ' + c.stop + ', ' + when(c.min) + '.';
  return alexaSay(text);
}
