// Relé de respaldo (worker.js → relayJSON): si iTranvías bloquea la IP del Worker (429, como el
// 26 nov), las llegadas se piden por RELAY_URL y siguen saliendo en vivo, no con el horario.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const RD = globalThis.Date;
let now = RD.UTC(2026, 10, 26, 18, 30); // 26 nov, 19:30 en A Coruña
globalThis.Date = class extends RD { constructor(...a) { a.length ? super(...a) : super(now); } static now() { return now; } };

const LIVE = { buses: { lineas: [{ linea: 1400, buses: [{ bus: 341, tiempo: '4' }] }] } };
let calls, relay;
globalThis.fetch = async (u) => {
  u = String(u);
  const m = u.match(/\/(gtfs\/.+\.json)/);
  if (m) {
    const f = path.join(REPO, m[1]);
    return fs.existsSync(f) ? new Response(fs.readFileSync(f)) : new Response('', { status: 404 });
  }
  if (u.startsWith('https://relay.test/')) { calls.relay.push(u); return relay(); }
  if (u.includes('itranvias')) { calls.it++; return new Response('<html>429 Too Many Requests</html>', { status: 429 }); }
  return new Response('', { status: 404 });
};

let n = 0;
async function load() { return (await import(path.join(REPO, 'cloudflare/worker.js') + '?v=' + n++)).default; }
async function stop(w, env, id = 119) {
  return (await w.fetch(new Request('https://x/api/stop?id=' + id), env, { waitUntil() {} })).json();
}

test('bloqueado y con relé: sale en vivo por el relé', async () => {
  calls = { it: 0, relay: [] };
  relay = () => new Response(JSON.stringify(LIVE));
  const w = await load();
  const j = await stop(w, { RELAY_URL: 'https://relay.test/exec?k=abc' });
  assert.equal(j.via, 'rele');
  assert.ok(!j.programado);
  const b = j.lineas.find((l) => l.linea === 1400).buses.find((x) => x.bus === 341);
  assert.ok(b && !b.programado, 'el 14 de 4 min va en vivo');
  assert.equal(calls.it, 1);
  assert.equal(calls.relay[0], 'https://relay.test/exec?k=abc&dato=119&func=0');
});

test('bloqueado y sin relé: horario programado, como antes', async () => {
  calls = { it: 0, relay: [] };
  const w = await load();
  const j = await stop(w, {});
  assert.equal(j.programado, true);
  assert.equal(j.via, undefined);
  assert.equal(calls.relay.length, 0);
});

test('relé también bloqueado: horario programado y 5 min sin insistir', async () => {
  calls = { it: 0, relay: [] };
  relay = () => new Response(JSON.stringify({ error: 'iTranvías 429', status: 429 }));
  const w = await load();
  const env = { RELAY_URL: 'https://relay.test/exec' };
  assert.equal((await stop(w, env, 119)).programado, true);
  assert.equal(calls.relay.length, 1);
  now += 61e3;
  assert.equal((await stop(w, env, 50)).programado, true);
  assert.equal(calls.relay.length, 1, 'no vuelve a llamar al relé durante la pausa');
  now += 5 * 60e3;
  relay = () => new Response(JSON.stringify(LIVE));
  assert.equal((await stop(w, env, 94)).via, 'rele');
});
