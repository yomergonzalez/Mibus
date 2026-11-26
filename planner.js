/*
 * Mi bus · planificador de trayectos
 *
 * Funciones puras (sin DOM ni red) para el flujo «Configura tu trayecto»:
 * a partir de un punto de origen y otro de destino, qué paradas tienes cerca
 * y qué líneas te llevan sin transbordo, con el tiempo total estimado.
 *
 * Datos (los genera tools/gtfs_build.py):
 *   meta   = gtfs/meta.json   → { lines: {id: {n, c}}, stops: {id: nombre}, pos: {id: [lat, lon]} }
 *   routes = gtfs/routes.json → { lineId: { sentido: [ { n, p: [[stopId, minDesdeCabecera], …] } ] } }
 *
 * Uso:
 *   const plan = MiBusPlanner.crear({ meta, routes });
 *   plan.paradasCerca([43.362, -8.4185]);
 *   plan.opcionesDirectas([43.362, -8.4185], [43.3535, -8.404]);
 *
 * Funciona en el navegador (window.MiBusPlanner) y en Node (require('./planner.js')).
 *
 * Transbordos (pendiente): opcionesDirectas se apoya en tramos(), que devuelve cada
 * «subir en X → bajar en Y» posible. Un viaje con transbordo es encadenar dos tramos
 * cuya parada de bajada y de subida coinciden o están a pocos metros.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MiBusPlanner = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const R = 6371000;
  const CAMINO = 1.3;        // las calles no son línea recta
  const PASO = 80;           // metros por minuto andando (~4,8 km/h)

  function distM(a, b) {
    const rad = Math.PI / 180;
    const dLat = (b[0] - a[0]) * rad, dLon = (b[1] - a[1]) * rad;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * rad) * Math.cos(b[0] * rad) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  function minAndando(m) {
    return Math.max(1, Math.round((m * CAMINO) / PASO));
  }

  function crear(datos) {
    const meta = datos.meta || {};
    const pos = meta.pos || {};
    const nombres = meta.stops || {};
    const lineas = meta.lines || {};
    const routes = datos.routes || {};

    // Índice: parada → recorridos que pasan por ella, con su posición en el recorrido.
    const recorridos = [];
    const porParada = {};
    for (const linea of Object.keys(routes)) {
      for (const sentido of Object.keys(routes[linea])) {
        routes[linea][sentido].forEach((v, variante) => {
          const r = { linea, sentido, variante, paradas: v.p.map((x) => String(x[0])), min: v.p.map((x) => x[1]) };
          recorridos.push(r);
          r.paradas.forEach((id, i) => {
            (porParada[id] = porParada[id] || []).push({ r, i });
          });
        });
      }
    }

    function nombreLinea(id) {
      const l = lineas[id];
      return (l && l.n) || String(id);
    }

    function lineasDe(id) {
      const out = [];
      for (const { r } of porParada[id] || []) if (out.indexOf(r.linea) < 0) out.push(r.linea);
      return out;
    }

    /** Paradas con algún recorrido a menos de radioM del punto, de la más cercana a la más lejana. */
    function paradasCerca(punto, radioM, max) {
      radioM = radioM || 400;
      const out = [];
      for (const id of Object.keys(porParada)) {
        const p = pos[id];
        if (!p) continue;
        const m = distM(punto, p);
        if (m <= radioM) out.push({ id, nombre: nombres[id] || 'Parada ' + id, metros: Math.round(m), minAndando: minAndando(m), lineas: lineasDe(id) });
      }
      out.sort((a, b) => a.metros - b.metros);
      return max ? out.slice(0, max) : out;
    }

    /**
     * Cada forma de ir en bus, sin transbordo, de una parada de `desde` a una de `hasta`
     * (listas de paradas, como las de paradasCerca). Respeta el sentido: solo vale si el
     * recorrido pasa por la de subida antes que por la de bajada.
     */
    function tramos(desde, hasta) {
      const fin = {};
      for (const p of hasta) fin[p.id] = p;
      const out = [];
      for (const ini of desde) {
        for (const { r, i } of porParada[ini.id] || []) {
          for (let j = i + 1; j < r.paradas.length; j++) {
            const f = fin[r.paradas[j]];
            if (!f || r.paradas[j] === ini.id) continue;
            out.push({ r, ini, fin: f, minBus: Math.max(1, r.min[j] - r.min[i]) });
          }
        }
      }
      return out;
    }

    /**
     * Opciones directas de origen a destino (puntos [lat, lon]).
     * opts: radioM (400 m por defecto), o radioOrigenM / radioDestinoM por separado.
     * Devuelve una opción por línea y parada de subida (la mejor bajada para esa pareja),
     * ordenadas por tiempo total. No incluye las que tardan más que ir andando.
     */
    function opcionesDirectas(origen, destino, opts) {
      opts = opts || {};
      const radio = opts.radioM || 400;
      const desde = paradasCerca(origen, opts.radioOrigenM || radio);
      const hasta = paradasCerca(destino, opts.radioDestinoM || radio);
      const andando = minAndando(distM(origen, destino));
      const mejor = {};
      for (const t of tramos(desde, hasta)) {
        const total = t.ini.minAndando + t.minBus + t.fin.minAndando;
        const k = t.r.linea + '|' + t.ini.id;
        if (mejor[k] && mejor[k].total <= total) continue;
        mejor[k] = {
          linea: t.r.linea,
          nombreLinea: nombreLinea(t.r.linea),
          sentido: t.r.sentido,
          sube: { id: t.ini.id, nombre: t.ini.nombre },
          baja: { id: t.fin.id, nombre: t.fin.nombre },
          minAndandoIni: t.ini.minAndando,
          minBus: t.minBus,
          minAndandoFin: t.fin.minAndando,
          total,
        };
      }
      let out = Object.keys(mejor).map((k) => mejor[k]);
      if (opts.inclusoSiAndarEsMejor !== true) out = out.filter((o) => o.total < andando);
      out.sort((a, b) => a.total - b.total || a.minAndandoIni - b.minAndandoIni);
      return out;
    }

    /**
     * Una opción por línea: la parada de subida que antes te deja en el destino.
     * Es lo que enseña la pantalla «Tus paradas» (Nelle 109 para el 12, no también Nelle 73).
     */
    function mejoresPorLinea(opciones) {
      const vista = {};
      return opciones.filter((o) => (vista[o.linea] ? false : (vista[o.linea] = true)));
    }

    /** Las opciones agrupadas por parada de subida, como en la pantalla «Tus paradas». */
    function porParadaDeSubida(opciones) {
      const grupos = [];
      const idx = {};
      for (const o of opciones) {
        if (!(o.sube.id in idx)) {
          idx[o.sube.id] = grupos.length;
          grupos.push({ parada: o.sube, minAndando: o.minAndandoIni, total: o.total, opciones: [] });
        }
        grupos[idx[o.sube.id]].opciones.push(o);
      }
      return grupos;
    }

    return { paradasCerca, opcionesDirectas, mejoresPorLinea, porParadaDeSubida, tramos, lineasDe, distM, minAndando };
  }

  return { crear, distM, minAndando };
});
