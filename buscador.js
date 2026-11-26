/*
 * Mi bus · buscador de destinos («¿A dónde vas?»)
 *
 * Mezcla tres fuentes, de más a menos fiable:
 *   1. Sitios populares de A Coruña (sin red, salen como botones antes de escribir).
 *   2. Lugares y direcciones de OpenStreetMap vía el Worker (/api/buscar → Photon).
 *   3. Nombres de parada (sin red: sirve si el buscador no responde o ya sabes la parada).
 *
 * Todo devuelve { nombre, detalle, tipo, pos: [lat, lon] } con tipo
 * 'popular' | 'sitio' | 'direccion' | 'calle' | 'parada'. pos es lo que recibe
 * planner.opcionesDirectas() como destino.
 *
 * Funciona en el navegador (window.MiBusBuscador) y en Node (require('./buscador.js')).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MiBusBuscador = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Coordenadas tomadas de las paradas más cercanas del GTFS; El Corte Inglés, aproximada.
  const POPULARES = [
    { nombre: 'El Corte Inglés', detalle: 'Ramón y Cajal', pos: [43.3535, -8.404], alias: ['corte ingles', 'eci', 'ramon y cajal'] },
    { nombre: 'Hospital (CHUAC)', detalle: 'As Xubias', pos: [43.3445, -8.388], alias: ['chuac', 'hospital', 'urgencias', 'xubias', 'materno'] },
    { nombre: 'Campus de Elviña', detalle: 'Universidade', pos: [43.3335, -8.41], alias: ['campus', 'elvina', 'universidad', 'universidade', 'udc', 'facultad'] },
    { nombre: 'Marineda City', detalle: 'Centro comercial', pos: [43.346, -8.429], alias: ['marineda', 'centro comercial'] },
    { nombre: 'Estación de tren', detalle: 'San Cristóbal', pos: [43.3525, -8.409], alias: ['tren', 'renfe', 'adif', 'estacion de trens', 'san cristobal'] },
    { nombre: 'Obelisco', detalle: 'Centro', pos: [43.3687, -8.4018], alias: ['obelisco', 'centro', 'cantones', 'marina'] },
    { nombre: 'Estación de autobuses', detalle: 'Caballeros', pos: [43.3533, -8.4062], alias: ['autobuses', 'estacion de buses', 'alsa', 'monbus', 'caballeros', 'cabaleiros'] },
  ];

  function norm(v) {
    return String(v || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
      .replace(/[^a-z0-9ñ ]/g, ' ').replace(/\s+/g, ' ').trim();
  }

  // ¿Todas las palabras de la búsqueda empiezan alguna palabra del texto? («corte ingl» → «El Corte Inglés»)
  function encaja(q, texto) {
    const palabras = norm(texto).split(' ');
    return norm(q).split(' ').every((w) => palabras.some((p) => p.startsWith(w)));
  }

  function distM(a, b) {
    const rad = Math.PI / 180;
    const dLat = (b[0] - a[0]) * rad, dLon = (b[1] - a[1]) * rad;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * rad) * Math.cos(b[0] * rad) * Math.sin(dLon / 2) ** 2;
    return 2 * 6371000 * Math.asin(Math.sqrt(h));
  }

  function populares(q) {
    const sin = (p) => ({ nombre: p.nombre, detalle: p.detalle, tipo: 'popular', pos: p.pos });
    if (!q || !norm(q)) return POPULARES.map(sin);
    return POPULARES.filter((p) => encaja(q, p.nombre) || p.alias.some((a) => encaja(q, a))).map(sin);
  }

  /** Paradas cuyo nombre encaja con la búsqueda (meta = gtfs/meta.json). */
  function paradas(q, meta, max) {
    if (!q || norm(q).length < 3 || !meta) return [];
    const out = [];
    for (const id of Object.keys(meta.stops || {})) {
      const pos = meta.pos && meta.pos[id];
      if (pos && encaja(q, meta.stops[id])) out.push({ nombre: meta.stops[id], detalle: 'Parada ' + id, tipo: 'parada', pos, id });
    }
    out.sort((a, b) => a.nombre.length - b.nombre.length);
    return out.slice(0, max || 3);
  }

  // «Rda. de Outeiro» y «Ronda de Outeiro» → «outeiro»: sin el tipo de vía, abreviaturas ni artículos.
  const TIPOS_VIA = new Set(['ronda', 'rda', 'avenida', 'avda', 'av', 'rua', 'r', 'calle', 'c', 'praza', 'pza', 'plaza', 'pr', 'paseo', 'pso',
    'travesia', 'trav', 'camino', 'cmno', 'glorieta', 'glor', 'estrada', 'ctra', 'carretera', 'de', 'da', 'do', 'das', 'dos', 'del', 'la', 'el', 'los', 'las', 'os', 'as', 'a', 'o']);
  function nucleoCalle(nombre) {
    return norm(nombre).split(' ').filter((w) => w && !TIPOS_VIA.has(w)).join(' ');
  }

  /** Número de portal al final de la búsqueda («ronda 200» → { calle: 'ronda', num: 200 }). */
  function conNumero(q) {
    const m = /^(.*?)[\s,]*(?:n(?:º|o|um)?\.?\s*)?(\d{1,4})\s*[a-z]?$/i.exec(String(q || '').trim());
    if (!m || !norm(m[1])) return null;
    return { calle: m[1], num: Number(m[2]) };
  }

  /**
   * Posición aproximada de un portal usando las paradas numeradas de la misma calle
   * («Rda. de Outeiro, 212», «…, 172»): se interpola entre las dos que lo rodean,
   * con las del mismo lado (pares o impares) si hay bastantes. null si no se puede.
   */
  function portal(calle, num, meta) {
    if (!meta || !meta.stops) return null;
    const nucleo = nucleoCalle(calle);
    if (!nucleo) return null;
    const pts = [];
    for (const id of Object.keys(meta.stops)) {
      const m = /^(.*),\s*(\d{1,4})\s*$/.exec(meta.stops[id]);
      const pos = meta.pos && meta.pos[id];
      if (m && pos && nucleoCalle(m[1]) === nucleo) pts.push({ n: Number(m[2]), pos });
    }
    const lado = pts.filter((x) => x.n % 2 === num % 2);
    const usa = (lado.length >= 2 ? lado : pts).sort((a, b) => a.n - b.n);
    if (usa.length < 2) return null;
    const ini = usa[0], fin = usa[usa.length - 1];
    if (num < ini.n - 20 || num > fin.n + 20) return null;
    if (num <= ini.n) return ini.pos;
    if (num >= fin.n) return fin.pos;
    let i = 0;
    while (usa[i + 1].n < num) i++;
    const a = usa[i], b = usa[i + 1], t = b.n === a.n ? 0 : (num - a.n) / (b.n - a.n);
    return [Math.round((a.pos[0] + (b.pos[0] - a.pos[0]) * t) * 1e6) / 1e6, Math.round((a.pos[1] + (b.pos[1] - a.pos[1]) * t) * 1e6) / 1e6];
  }

  /**
   * Si escribes un número y el buscador solo devuelve la calle (OpenStreetMap no tiene ese
   * portal), la fila lleva el número: «Ronda de Outeiro, 200», en su sitio aproximado si hay
   * paradas numeradas en esa calle; si no, la calle avisa de que no sabemos dónde cae el número.
   */
  function conPortal(q, remotos, meta) {
    const c = conNumero(q);
    if (!c || !remotos || !remotos.length) return remotos || [];
    const ya = remotos.some((r) => r.tipo === 'direccion' && new RegExp('\\b' + c.num + '\\b').test(r.nombre));
    if (ya) return remotos;
    const out = [];
    for (const r of remotos) {
      if (r.tipo !== 'calle' || !encaja(c.calle, r.nombre)) { out.push(r); continue; }
      const pos = portal(r.nombre, c.num, meta);
      if (pos) out.push({ nombre: r.nombre + ', ' + c.num, detalle: 'Ubicación aproximada' + (r.detalle && r.detalle !== 'Calle' ? ' · ' + r.detalle : ''), tipo: 'direccion', pos, aprox: true });
      else out.push(Object.assign({}, r, { detalle: 'Calle entera · no encontramos el ' + c.num }));
    }
    // Las que llevan tu número, primero.
    return out.filter((r) => r.aprox).concat(out.filter((r) => !r.aprox));
  }

  /**
   * Junta populares + remotos + paradas, quitando repetidos: mismo nombre (o uno contenido en
   * el otro) a menos de 400 m. Así «El Corte Inglés» no sale dos veces aunque OpenStreetMap
   * lo sitúe algo distinto que la lista de populares.
   */
  function mezclar(q, remotos, meta, max) {
    remotos = conPortal(q, remotos, meta);
    const todos = remotos.filter((r) => r.aprox).concat(populares(q), remotos.filter((r) => !r.aprox), paradas(q, meta));
    const out = [];
    for (const r of todos) {
      const rep = out.some((o) => distM(o.pos, r.pos) < 400 && (norm(o.nombre) === norm(r.nombre) || encaja(o.nombre, r.nombre) || encaja(r.nombre, o.nombre)));
      if (!rep) out.push(r);
    }
    return out.slice(0, max || 8);
  }

  /**
   * Busca en el Worker. Devuelve [] si no hay red o el buscador falla:
   * la pantalla sigue funcionando con populares y paradas.
   */
  async function remoto(q, opts) {
    opts = opts || {};
    if (norm(q).length < 3) return [];
    const f = opts.fetch || (typeof fetch !== 'undefined' ? fetch : null);
    if (!f || !opts.base) return [];
    let u = opts.base.replace(/\/$/, '') + '/api/buscar?q=' + encodeURIComponent(q);
    if (opts.cerca) u += '&lat=' + opts.cerca[0].toFixed(2) + '&lon=' + opts.cerca[1].toFixed(2);
    try {
      const r = await f(u, { signal: opts.signal });
      if (!r.ok) return [];
      const j = await r.json();
      return Array.isArray(j.resultados) ? j.resultados : [];
    } catch (e) {
      return [];
    }
  }

  /** Buscar con todo: lo que se llama desde la pantalla, con un pequeño retardo al escribir. */
  async function buscar(q, opts) {
    opts = opts || {};
    return mezclar(q, await remoto(q, opts), opts.meta, opts.max);
  }

  return { POPULARES, populares, paradas, mezclar, remoto, buscar, norm, encaja, conNumero, portal, conPortal };
});
