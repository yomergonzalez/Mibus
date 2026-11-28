// /api/ruta (worker.js): camino a pie hasta la parada para «Ver parada», con openrouteservice
// simulado. Sin clave, lejos o si falla → { recta: true }; con clave, la ruta y su caché.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let ors = [], orsStatus = 200;
globalThis.fetch = async (u, opts) => {
  u = String(u);
  const m = u.match(/\/(gtfs\/.+\.json)/);
  if (m) {
    const f = path.join(REPO, m[1]);
    return fs.existsSync(f) ? new Response(fs.readFileSync(f), { headers: { 'content-type': 'application/json' } }) : new Response('', { status: 404 });
  }
  if (u.includes('openrouteservice')) {
    ors.push({ u, opts, body: JSON.parse(opts.body) });
    if (orsStatus !== 200) return new Response('{}', { status: orsStatus });
    const [a, b] = JSON.parse(opts.body).coordinates;
    return new Response(JSON.stringify({ features: [{ geometry: { coordinates: [a, [-8.4175, 43.3620], b] }, properties: { summary: { distance: 212.4, duration: 170.2 } } }] }));
  }
  return new Response('', { status: 404 });
};

let n = 0;
async function load() { return (await import(path.join(REPO, 'cloudflare/worker.js') + '?v=' + n++)).default; }
async function ruta(w, env, q) {
  const r = await w.fetch(new Request('https://x/api/ruta?' + q), env, { waitUntil() {} });
  return { status: r.status, j: await r.json() };
}
const CASA = 'id=50&lat=43.36185&lon=-8.41825';

test('sin ORS_KEY: línea recta con los metros en recta, sin llamar a openrouteservice', async () => {
  const w = await load(); ors = [];
  const { status, j } = await ruta(w, {}, CASA);
  assert.equal(status, 200);
  assert.equal(j.recta, true);
  assert.ok(j.m > 100 && j.m < 180, 'casa → Nelle 109 son ~137 m en recta: ' + j.m);
  assert.equal(ors.length, 0);
});

test('con ORS_KEY: ruta real (lat, lon) y la clave va en Authorization', async () => {
  const w = await load(); ors = []; orsStatus = 200;
  const { j } = await ruta(w, { ORS_KEY: 'k1' }, CASA);
  assert.equal(j.recta, false);
  assert.equal(j.m, 212);
  assert.equal(j.s, 170);
  assert.deepEqual(j.linea[1], [43.362, -8.4175]);
  assert.deepEqual(j.linea[j.linea.length - 1], [43.36245, -8.41677]); // Nelle 109
  assert.equal(ors.length, 1);
  assert.equal(ors[0].opts.headers.Authorization, 'k1');
});

test('mismo sitio (dentro de ~50 m): sale de la caché, una sola llamada', async () => {
  const w = await load(); ors = []; orsStatus = 200;
  await ruta(w, { ORS_KEY: 'k1' }, CASA);
  await ruta(w, { ORS_KEY: 'k1' }, 'id=50&lat=43.36195&lon=-8.41815');
  assert.equal(ors.length, 1);
});

test('openrouteservice falla: línea recta, nunca error', async () => {
  const w = await load(); ors = []; orsStatus = 503;
  const { status, j } = await ruta(w, { ORS_KEY: 'k1' }, 'id=94&lat=43.36185&lon=-8.41825');
  assert.equal(status, 200);
  assert.equal(j.recta, true);
  orsStatus = 200;
});

test('lejos (> 2,5 km) o parada sin posición: línea recta sin llamar', async () => {
  const w = await load(); ors = [];
  const lejos = (await ruta(w, { ORS_KEY: 'k1' }, 'id=50&lat=43.30&lon=-8.40')).j;
  assert.equal(lejos.recta, true);
  assert.equal(lejos.motivo, 'lejos');
  assert.equal(ors.length, 0);
  assert.equal((await ruta(w, { ORS_KEY: 'k1' }, 'id=99999&lat=43.36&lon=-8.41')).j.recta, true);
  assert.equal((await ruta(w, { ORS_KEY: 'k1' }, 'id=x&lat=43.36&lon=-8.41')).status, 400);
});
