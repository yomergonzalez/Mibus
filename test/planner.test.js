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

test('real: Casa → El Corte Inglés y vuelta', { skip: !hayRutas && 'falta gtfs/routes.json (lo genera tools/gtfs_build.py)' }, () => {
  const real = MiBusPlanner.crear({
    meta: JSON.parse(fs.readFileSync(path.join(GTFS, 'meta.json'), 'utf8')),
    routes: JSON.parse(fs.readFileSync(path.join(GTFS, 'routes.json'), 'utf8')),
  });
  const CASA = [43.362, -8.4185];   // entre Rda. de Nelle 109 y Rda. de Outeiro 249 (aprox.)
  const ECI = [43.3535, -8.404];    // Rúa Ramón y Cajal, 57 (aprox.)
  const ver = (o) => `${o.nombreLinea} ${o.sube.nombre} → ${o.baja.nombre} (${o.minAndandoIni}+${o.minBus}+${o.minAndandoFin} = ${o.total} min)`;

  const ida = real.opcionesDirectas(CASA, ECI);
  const idaRes = real.mejoresPorLinea(ida);
  console.log('Ida:\n  ' + idaRes.map(ver).join('\n  '));
  const doce = idaRes.find((o) => o.nombreLinea === '12');
  const catorce = idaRes.find((o) => o.nombreLinea === '14');
  assert.equal(doce && doce.sube.id, '50', 'el 12 desde Rda. de Nelle, 109');
  assert.equal(catorce && catorce.sube.id, '94', 'el 14 desde Rda. de Outeiro, 249');
  assert.equal(new Set(idaRes.map((o) => o.linea)).size, idaRes.length, 'una opción por línea');

  const vuelta = real.mejoresPorLinea(real.opcionesDirectas(ECI, CASA));
  console.log('Vuelta:\n  ' + vuelta.map(ver).join('\n  '));
  const doceV = vuelta.find((o) => o.nombreLinea === '12');
  const catorceV = vuelta.find((o) => o.nombreLinea === '14');
  assert.equal(doceV && doceV.sube.id, '40', 'vuelta en el 12 desde Av. de Oza, 7');
  assert.equal(catorceV && catorceV.sube.id, '269', 'vuelta en el 14 desde Rda. de Outeiro, Pérez Ardá');
  assert.notEqual(doceV.sentido, doce.sentido, 'la vuelta va en el otro sentido');
});

test('lineasDe: líneas que pasan por una parada, sin repetir', () => {
  assert.deepEqual(plan.lineasDe('1').sort(), ['100', '200']);
  assert.deepEqual(plan.lineasDe('99'), []);
});

test('opcionesConTransbordo: un bus, cambio a pocos metros y otro bus (GTFS real, casa → Marineda)', () => {
  const real = MiBusPlanner.crear({
    meta: JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'gtfs', 'meta.json'), 'utf8')),
    routes: JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'gtfs', 'routes.json'), 'utf8')),
  });
  const casa = [43.3606, -8.4162], marineda = [43.345977, -8.428935];
  const o = real.opcionesConTransbordo(casa, marineda);
  assert.ok(o.length > 0);
  // El segundo bus siempre es el 11 (1100), el único que llega a Marineda, y nunca la misma línea dos veces.
  for (const x of o) { assert.equal(x.linea2, '1100'); assert.notEqual(x.linea, x.linea2); assert.ok(x.minCambio <= 5); }
  // El 14 (1400) de Outeiro cambiando en Vioño al 11 de Av. de Arteixo está entre las opciones.
  assert.ok(o.some((x) => x.linea === '1400' && /Vio/.test(x.baja.nombre) && /Arteixo/.test(x.sube2.nombre)), JSON.stringify(o.slice(0, 5).map((x) => [x.linea, x.baja.nombre, x.sube2.nombre])));
  // Ordenadas por tiempo total.
  for (let i = 1; i < o.length; i++) assert.ok(o[i - 1].total <= o[i].total);
});
