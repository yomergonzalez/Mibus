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
 * Transbordos: opcionesConTransbordo encadena dos tramos() (cada «subir en X → bajar en Y»)
 * cuya parada de bajada y la de subida del segundo bus están a pocos metros.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MiBusPlanner = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const R = 6371000;
  const CAMINO = 1.5;        // las calles no son línea recta (Google: 483 m en recta = 800 m por la calle)
  const PASO = 70;           // metros por minuto andando (~4,2 km/h, con semáforos)

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

    /**
     * Viajes con un cambio: un bus hasta cerca de otra parada, como mucho `cambioM` andando
     * (250 m por defecto) y otro bus de otra línea hasta el destino.
     * Devuelve, por pareja de líneas y parada de subida, el mejor; ordenados por tiempo total
     * SIN contar la espera del segundo bus (eso se ve en vivo). Quita los que no ahorran nada
     * frente a andar el tramo de antes o el de después.
     * opts: radioOrigenM (600), radioDestinoM (400), cambioM (250).
     */
    function opcionesConTransbordo(origen, destino, opts) {
      opts = opts || {};
      const desde = paradasCerca(origen, opts.radioOrigenM || 600);
      const hasta = paradasCerca(destino, opts.radioDestinoM || 400);
      const cambioM = opts.cambioM || 250;
      const todas = Object.keys(pos).filter((id) => porParada[id]).map((id) => ({ id, nombre: nombres[id] || 'Parada ' + id, minAndando: 0 }));
      // Segundo tramo: cualquier parada → cerca del destino, indexado por parada de subida.
      const segundo = {};
      for (const t of tramos(todas, hasta)) (segundo[t.ini.id] = segundo[t.ini.id] || []).push(t);
      const vecinas = {};
      const cerca = (id) => vecinas[id] || (vecinas[id] = pos[id] ? paradasCerca(pos[id], cambioM) : []);
      const mejor = {};
      for (const a of tramos(desde, todas)) {
        for (const c of cerca(a.fin.id)) {
          for (const b of segundo[c.id] || []) {
            if (b.r.linea === a.r.linea) continue;
            const pie = c.id === a.fin.id ? 0 : c.minAndando;
            const total = a.ini.minAndando + a.minBus + pie + b.minBus + b.fin.minAndando;
            // Si desde la bajada del primero llegas andando igual de rápido, el segundo bus sobra.
            if (minAndando(distM(pos[a.fin.id], destino)) <= pie + b.minBus + b.fin.minAndando + 3) continue;
            // Y si andando hasta la parada del segundo tardas lo mismo que en el primer bus, el primero sobra.
            if (pos[c.id] && minAndando(distM(origen, pos[c.id])) <= a.ini.minAndando + a.minBus + pie) continue;
            const k = a.r.linea + '>' + b.r.linea + '|' + a.ini.id;
            if (mejor[k] && mejor[k].total <= total) continue;
            mejor[k] = {
              linea: a.r.linea, nombreLinea: nombreLinea(a.r.linea),
              sube: { id: a.ini.id, nombre: a.ini.nombre },
              baja: { id: a.fin.id, nombre: a.fin.nombre },
              minAndandoIni: a.ini.minAndando, minBus: a.minBus,
              minCambio: pie,
              linea2: b.r.linea, nombreLinea2: nombreLinea(b.r.linea),
              sube2: { id: c.id, nombre: c.nombre },
              baja2: { id: b.fin.id, nombre: b.fin.nombre },
              minBus2: b.minBus, minAndandoFin: b.fin.minAndando,
              total,
            };
          }
        }
      }
      // Una por pareja de líneas y parada de subida, las más rápidas primero.
      return Object.keys(mejor).map((k) => mejor[k])
        .sort((x, y) => x.total - y.total || x.minAndandoIni - y.minAndandoIni);
    }

    return { paradasCerca, opcionesDirectas, opcionesConTransbordo, mejoresPorLinea, porParadaDeSubida, tramos, lineasDe, distM, minAndando };
  }

  return { crear, distM, minAndando };
});
