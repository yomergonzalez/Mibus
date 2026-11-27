// Huecos del tiempo real (worker.js): fantasmas por número de coche y horas del horario
// asociadas a cada bus. Casos reales de la parada 119 (Estación de Trens) el 27 nov 2026.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const RD = globalThis.Date;
let now = 0, feed = [];
globalThis.Date = class extends RD { constructor(...a) { a.length ? super(...a) : super(now); } static now() { return now; } };
globalThis.fetch = async (u) => {
  u = String(u);
  const m = u.match(/\/(gtfs\/.+\.json)/);
  if (m) {
    const f = path.join(REPO, m[1]);
    return fs.existsSync(f) ? new Response(fs.readFileSync(f), { headers: { 'content-type': 'application/json' } }) : new Response('', { status: 404 });
  }
  if (u.includes('itranvias')) return new Response(JSON.stringify({ buses: { lineas: feed } }), { headers: { 'content-type': 'application/json' } });
  return new Response('', { status: 404 });
};

let n = 0;
async function load() { return (await import(path.join(REPO, 'cloudflare/worker.js') + '?v=' + n++)).default; }
const at = (h, mi, s = 0) => RD.UTC(2026, 10, 27, h - 1, mi, s); // 27 nov: UTC+1
async function stop(w, t, lineas, linea) {
  now = at(...t); feed = lineas;
  const j = await (await w.fetch(new Request('https://x/api/stop?id=119'), {}, { waitUntil() {} })).json();
  return (j.lineas.find((l) => l.linea === linea) || { buses: [] }).buses;
}
const B = (bus, tiempo) => ({ bus, tiempo: String(tiempo) });
const horario = (bs) => bs.filter((b) => b.programado).map((b) => b.tiempo);

test('14 adelantado: el bus en vivo se queda con su hora y no sale otro «según horario»', async () => {
  const w = await load();
  await stop(w, [7, 42], [{ linea: 1400, buses: [B(301, 4), B(302, 17), B(341, 30)] }], 1400);
  const bs = await stop(w, [8, 3, 44], [{ linea: 1400, buses: [B(341, 4), B(345, 23), B(395, 39)] }], 1400);
  assert.equal(bs.find((b) => b.bus === 341).slot, 8 * 60 + 12);
  assert.ok(!horario(bs).includes(9), 'no debe añadir 08:12 según horario');
});

test('14 con retraso: conserva las 07:59 y la de las 08:12 sí sale según horario', async () => {
  const w = await load();
  await stop(w, [7, 42], [{ linea: 1400, buses: [B(301, 4), B(341, 17), B(350, 30)] }], 1400);
  const bs = await stop(w, [8, 3, 44], [{ linea: 1400, buses: [B(341, 4), B(345, 23), B(395, 39)] }], 1400);
  assert.equal(bs.find((b) => b.bus === 341).slot, 7 * 60 + 59);
  assert.ok(horario(bs).includes(9), 'debe añadir 08:12 según horario');
});

test('20 que desaparece y vuelve con otra hora: no queda el fantasma', async () => {
  const w = await load();
  await stop(w, [7, 57], [{ linea: 2000, buses: [B(392, 44), B(417, 55)] }], 2000);
  const lost = await stop(w, [7, 58, 30], [{ linea: 2000, buses: [] }], 2000);
  assert.deepEqual(lost.filter((b) => b.sinSenal).map((b) => b.bus), [392, 417]);
  const bs = await stop(w, [8, 3, 44], [{ linea: 2000, buses: [B(392, 33), B(417, 55)] }], 2000);
  assert.equal(bs.filter((b) => b.sinSenal).length, 0);
});

test('20 adelantado tras pasar el anterior: no se queda la hora ya servida ni sale otro «según horario»', async () => {
  const w = await load();
  await stop(w, [8, 3, 44], [{ linea: 2000, buses: [B(392, 33), B(417, 55)] }], 2000);   // 08:36 y 08:58
  await stop(w, [8, 35], [{ linea: 2000, buses: [B(392, 1), B(417, 20)] }], 2000);
  await stop(w, [8, 38], [{ linea: 2000, buses: [B(417, 10), B(392, 60)] }], 2000);       // 392 ya pasó: otra vuelta
  const bs = await stop(w, [8, 47, 44], [{ linea: 2000, buses: [B(417, 0), B(396, 33), B(392, 55)] }], 2000);
  assert.equal(bs.find((b) => b.bus === 417).slot, 8 * 60 + 58);
  assert.ok(!horario(bs).includes(10) && !horario(bs).includes(11), 'no debe añadir 08:58 según horario');
});
