// node --test test/
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const MiBusPlanner = require('../planner.js');

// Red de juguete (0,001° de latitud ≈ 111 m):
//   línea 100, sentido 0: A → C → D    sentido 1: D' → C' → A'
//   línea 200, sentido 0: D → A        (va al revés de lo que queremos)
const meta = {
  lines: { 100: { n: '1' }, 200: { n: '2' } },
  stops: { 1: 'A', 2: "A'", 3: 'C', 4: 'D', 5: "D'", 6: "C'" },
  pos: {
    1: [43.0, -8.0], 2: [43.0005, -8.0], 3: [43.01, -8.0],
    4: [43.03, -8.0], 5: [43.0305, -8.0], 6: [43.0105, -8.0],
  },
};
const routes = {
  100: {
    0: [{ n: 50, p: [[1, 0], [3, 5], [4, 12]] }],
    1: [{ n: 50, p: [[5, 0], [6, 7], [2, 12]] }],
  },
  200: { 0: [{ n: 20, p: [[4, 0], [1, 10]] }] },
};
const plan = MiBusPlanner.crear({ meta, routes });
const ORIGEN = [43.0002, -8.0];
const DESTINO = [43.0302, -8.0];

test('paradasCerca: solo las del radio, de la más cercana a la más lejana, con sus líneas', () => {
  const p = plan.paradasCerca(ORIGEN, 400);
  assert.deepEqual(p.map((x) => x.id), ['1', '2']);
  assert.ok(p[0].metros < p[1].metros);
  assert.deepEqual(p[0].lineas.sort(), ['100', '200']);
  assert.equal(p[0].minAndando, 1);
});

test('opcionesDirectas: respeta el sentido del recorrido', () => {
  const o = plan.opcionesDirectas(ORIGEN, DESTINO);
  assert.equal(o.length, 1, JSON.stringify(o));
  assert.equal(o[0].linea, '100');
  assert.equal(o[0].sentido, '0');
  assert.equal(o[0].sube.id, '1');
  assert.equal(o[0].baja.id, '4');
  assert.equal(o[0].minBus, 12);
  assert.equal(o[0].total, o[0].minAndandoIni + o[0].minBus + o[0].minAndandoFin);
});

test('opcionesDirectas: a la vuelta usa el otro sentido', () => {
  const o = plan.opcionesDirectas(DESTINO, ORIGEN);
  const l100 = o.find((x) => x.linea === '100');
  assert.equal(l100.sentido, '1');
  assert.equal(l100.sube.id, '5');
  assert.equal(l100.baja.id, '2');
  assert.ok(o.some((x) => x.linea === '200'), 'la 200 sí sirve en este sentido');
});

test('opcionesDirectas: descarta el bus si andando se llega antes', () => {
  const cerca = [43.0035, -8.0]; // ~370 m: andando ~6 min
  assert.equal(plan.opcionesDirectas(ORIGEN, cerca, { radioM: 400 }).length, 0);
});

test('porParadaDeSubida agrupa las líneas de cada parada', () => {
  const g = plan.porParadaDeSubida(plan.opcionesDirectas(DESTINO, ORIGEN));
  const d = g.find((x) => x.parada.id === '4');
  assert.deepEqual(d.opciones.map((x) => x.linea), ['200']);
});

// ---------- Datos reales (solo si ya existe gtfs/routes.json) ----------
const GTFS = path.join(__dirname, '..', 'gtfs');
const hayRutas = fs.existsSync(path.join(GTFS, 'routes.json'));

test('real: Casa → El Corte Inglés', { skip: !hayRutas && 'falta gtfs/routes.json (lo genera tools/gtfs_build.py)' }, () => {
  const real = MiBusPlanner.crear({
    meta: JSON.parse(fs.readFileSync(path.join(GTFS, 'meta.json'), 'utf8')),
    routes: JSON.parse(fs.readFileSync(path.join(GTFS, 'routes.json'), 'utf8')),
  });
  const CASA = [43.362, -8.4185];
  const ECI = [43.357, -8.402];
  const ida = real.opcionesDirectas(CASA, ECI);
  const ver = (o) => `${o.nombreLinea} ${o.sube.nombre} → ${o.baja.nombre} (${o.total} min)`;
  console.log('Ida:\n  ' + ida.map(ver).join('\n  '));

  const de = (linea, sube) => ida.find((o) => o.nombreLinea === linea && o.sube.id === sube);
  const doce = de('12', '50');
  assert.ok(doce, 'el 12 desde Rda. de Nelle, 109');
  assert.equal(doce.baja.id, '40', 'el 12 baja en Av. de Oza, 7');
  for (const l of ['14', 'BUH']) {
    const o = de(l, '94');
    assert.ok(o, `el ${l} desde Rda. de Outeiro, 249`);
    assert.ok(['40', '268'].includes(o.baja.id), `el ${l} baja en Av. de Oza, 7 o Casa do Mar`);
  }

  const vuelta = real.opcionesDirectas(ECI, CASA);
  console.log('Vuelta:\n  ' + vuelta.map(ver).join('\n  '));
  const doceVuelta = vuelta.find((o) => o.nombreLinea === '12');
  assert.ok(doceVuelta, 'el 12 también sirve para volver');
  assert.notEqual(doceVuelta.sentido, doce.sentido, 'la vuelta va en el otro sentido');
  assert.ok(!vuelta.some((o) => o.sube.id === '50'), 'no se vuelve subiendo en Nelle 109 (va hacia el centro)');
});
