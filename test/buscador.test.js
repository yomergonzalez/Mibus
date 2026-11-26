// node --test test/*.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const B = require('../buscador.js');
const MiBusPlanner = require('../planner.js');

const GTFS = path.join(__dirname, '..', 'gtfs');
const meta = JSON.parse(fs.readFileSync(path.join(GTFS, 'meta.json'), 'utf8'));
const hayRutas = fs.existsSync(path.join(GTFS, 'routes.json'));

test('populares: sin escribir salen todos; escribiendo, por nombre o alias', () => {
  assert.equal(B.populares('').length, B.POPULARES.length);
  assert.equal(B.populares('hospital')[0].nombre, 'Hospital (CHUAC)');
  assert.equal(B.populares('corte ingl')[0].nombre, 'El Corte Inglés');
  assert.equal(B.populares('Universidad')[0].nombre, 'Campus de Elviña');
  assert.equal(B.populares('renfe')[0].nombre, 'Estación de tren');
  assert.deepEqual(B.populares('zzzz'), []);
});

test('paradas: por nombre, con o sin tildes, y con número', () => {
  const p = B.paradas('outeiro 249', meta);
  assert.equal(p[0].id, '94');
  assert.equal(p[0].tipo, 'parada');
  assert.ok(B.paradas('pérez arda', meta).some((x) => x.id === '269'));
  assert.deepEqual(B.paradas('ou', meta), [], 'menos de 3 letras no busca');
});

test('mezclar: populares primero, sin repetir el mismo sitio de OpenStreetMap', () => {
  const remotos = [
    { nombre: 'El Corte Inglés', detalle: 'Rúa Ramón y Cajal, 57', tipo: 'sitio', pos: [43.3541, -8.4035] },
    { nombre: 'Rúa Ramón y Cajal, 57', detalle: 'Os Mallos', tipo: 'direccion', pos: [43.3541, -8.4036] },
  ];
  const r = B.mezclar('corte ingles', remotos, meta);
  assert.equal(r[0].tipo, 'popular');
  assert.equal(r.filter((x) => B.norm(x.nombre) === 'el corte ingles').length, 1);
  assert.ok(r.some((x) => x.tipo === 'direccion'));
});

test('remoto: llama al Worker con la búsqueda y la zona; si falla devuelve []', async () => {
  let pedido = '';
  const ok = async (u) => { pedido = u; return { ok: true, json: async () => ({ resultados: [{ nombre: 'X', tipo: 'sitio', pos: [43.36, -8.41] }] }) }; };
  const r = await B.remoto('marineda', { base: 'https://w.dev/', fetch: ok, cerca: [43.3621, -8.4183] });
  assert.equal(pedido, 'https://w.dev/api/buscar?q=marineda&lat=43.36&lon=-8.42');
  assert.equal(r.length, 1);
  const falla = async () => { throw new Error('sin red'); };
  assert.deepEqual(await B.remoto('marineda', { base: 'https://w.dev', fetch: falla }), []);
  assert.deepEqual(await B.remoto('ma', { base: 'https://w.dev', fetch: ok }), [], 'menos de 3 letras no llama');
});

test('Worker: Photon → resultados limpios', async () => {
  fs.copyFileSync(path.join(__dirname, '..', 'cloudflare', 'worker.js'), path.join(require('node:os').tmpdir(), 'mibus-worker.mjs'));
  const { photonResultados } = await import(path.join(require('node:os').tmpdir(), 'mibus-worker.mjs'));
  const f = (props, lon, lat) => ({ type: 'Feature', properties: props, geometry: { type: 'Point', coordinates: [lon, lat] } });
  const geo = {
    features: [
      f({ name: 'El Corte Inglés', street: 'Rúa Ramón y Cajal', housenumber: '57', osm_key: 'shop', city: 'A Coruña' }, -8.4035, 43.3541),
      f({ name: 'El Corte Inglés', street: 'Rúa Ramón y Cajal', housenumber: '57', osm_key: 'shop', city: 'A Coruña' }, -8.4036, 43.3542),
      f({ street: 'Ronda de Outeiro', housenumber: '200', district: 'Os Mallos', osm_key: 'place', type: 'house' }, -8.41, 43.356),
      f({ name: 'Ronda de Outeiro', osm_key: 'highway', type: 'street', city: 'A Coruña' }, -8.41, 43.357),
      f({ name: 'El Corte Inglés', osm_key: 'shop', city: 'Madrid' }, -3.69, 40.42),
      f({ osm_key: 'place' }, -8.41, 43.36),
    ],
  };
  const r = photonResultados(geo);
  assert.deepEqual(r.map((x) => x.tipo), ['sitio', 'direccion', 'calle']);
  assert.equal(r[0].detalle, 'Rúa Ramón y Cajal, 57');
  assert.equal(r[1].nombre, 'Ronda de Outeiro, 200');
  assert.deepEqual(r[0].pos, [43.3541, -8.4035]);
});

test('de punta a punta: «corte» → El Corte Inglés → el 12 y el 14 desde casa', { skip: !hayRutas && 'falta gtfs/routes.json' }, () => {
  const destino = B.mezclar('corte', [], meta)[0];
  const plan = MiBusPlanner.crear({ meta, routes: JSON.parse(fs.readFileSync(path.join(GTFS, 'routes.json'), 'utf8')) });
  const ops = plan.mejoresPorLinea(plan.opcionesDirectas([43.362, -8.4185], destino.pos));
  const lineas = ops.map((o) => o.nombreLinea);
  assert.ok(lineas.includes('12') && lineas.includes('14'), lineas.join(','));
});
