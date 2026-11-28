/*
 * «Ver parada»: el mapa de la hoja con la parada, dónde estás y el camino a pie.
 * Se carga solo al abrir la hoja (como planner.js), junto con Leaflet (vendor/leaflet/) y MapLibre
 * (vendor/maplibre/). Fondo: teselas vectoriales de OpenFreeMap (Positron en claro, Dark en oscuro),
 * sin clave ni límite. Si no hay WebGL, no cargó MapLibre o el estilo falla, teselas de OpenStreetMap
 * (en oscuro, invertidas con CSS): nunca sin mapa.
 * index.html pone los textos y pide la ruta a /api/ruta; aquí solo se dibuja.
 *
 *   const m = MiBusMapa.crear(div, { oscuro: true });
 *   m.pintar({ parada: [lat, lon], lineas: [{ n: '12', c: '#019F02' }], yo: { p: [lat, lon], acc: 20 } | null,
 *              camino: [[lat, lon], …] | null, recta: true|false, cerca: false });
 *   m.centrar();  m.destruir();
 */
(function () {
  'use strict';
  const L = window.L;
  // Fondo vectorial de OpenFreeMap (28 nov 2026): más limpio que el estándar de OSM y con oscuro de verdad.
  const ESTILO = { claro: 'https://tiles.openfreemap.org/styles/positron', oscuro: 'https://tiles.openfreemap.org/styles/dark' };
  const A = (h, t) => '<a href="' + h + '" target="_blank" rel="noopener">' + t + '</a>';
  const ATRIB_OFM = A('https://openfreemap.org', 'OpenFreeMap') + ' © ' + A('https://www.openmaptiles.org/', 'OpenMapTiles') + ' © ' + A('https://www.openstreetmap.org/copyright', 'OpenStreetMap');
  // Respaldo: teselas de OpenStreetMap (con atribución; uso pequeño). Las de CARTO salían con
  // «API KEY REQUIRED» (28 nov 2026). En oscuro se invierten con CSS (.smap.oscuro).
  const TESELAS = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
  const ATRIB = '© ' + A('https://www.openstreetmap.org/copyright', 'OpenStreetMap');
  const ESPERA_ESTILO = 8000; // si el fondo vectorial no ha cargado en 8 s, se pasa al de OSM

  function conWebGL() {
    try { const c = document.createElement('canvas'); return !!(c.getContext('webgl2') || c.getContext('webgl')); } catch (e) { return false; }
  }

  // Pone el fondo del mapa: vectorial si se puede; si no (o si falla antes de cargar), raster de OSM.
  function fondo(map, el, oscuro) {
    let vivo = true, raster = false;
    map.once('unload', () => { vivo = false; });
    const aRaster = () => {
      if (!vivo || raster) return;
      raster = true;
      el.classList.toggle('oscuro', oscuro);
      L.tileLayer(TESELAS, { maxZoom: 19, attribution: ATRIB }).addTo(map);
    };
    if (!(L.maplibreGL && window.maplibregl && conWebGL())) { aRaster(); return; }
    el.classList.remove('oscuro'); // el filtro de .oscuro es para el raster: no tocar el vectorial
    el.classList.add('vector');
    const capa = L.maplibreGL({ style: oscuro ? ESTILO.oscuro : ESTILO.claro, attributionControl: { customAttribution: ATRIB_OFM } });
    // El mapa de MapLibre se crea en onAdd, que Leaflet retrasa hasta el primer setView/fitBounds.
    capa.once('add', () => {
      const gl = capa.getMaplibreMap();
      let listo = false;
      const caer = () => {
        if (listo || !vivo || raster) return;
        try { map.removeLayer(capa); } catch (e) { /* ya quitada */ }
        el.classList.remove('vector');
        aRaster();
      };
      gl.once('load', () => { listo = true; });
      gl.on('error', () => caer()); // antes de «load»: estilo caído o sin red. Después, se ignoran (una tesela suelta)
      setTimeout(caer, ESPERA_ESTILO);
    });
    capa.addTo(map);
  }
  const ATRIB_RUTA = 'Ruta: <a href="https://openrouteservice.org" target="_blank" rel="noopener">openrouteservice</a>';
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const colorOk = (c) => (/^#[0-9a-f]{3,8}$/i.test(c || '') ? c : '#6e6e76');

  function iconoParada(lineas) {
    const chips = (lineas || []).slice(0, 3).map((l) => '<span style="background:' + colorOk(l.c) + '">' + esc(l.n) + '</span>').join('');
    return L.divIcon({
      className: 'mm-stop',
      html: (chips ? '<div class="mm-chips">' + chips + '</div>' : '') +
        '<svg width="34" height="42" viewBox="0 0 34 42" aria-hidden="true"><path d="M17 41C17 40 2 27 2 16a15 15 0 0 1 30 0c0 11-15 24-15 25z" fill="#c8102e" stroke="#fff" stroke-width="2.5"/><circle cx="17" cy="16" r="5.5" fill="#fff"/></svg>',
      iconSize: [34, 42], iconAnchor: [17, 41],
    });
  }
  const iconoYo = () => L.divIcon({ className: 'mm-me', html: '<i></i>', iconSize: [22, 22], iconAnchor: [11, 11] });

  function crear(el, o) {
    const map = L.map(el, { zoomControl: false, attributionControl: true, tap: false, maxZoom: 19, zoomSnap: 0.25 });
    map.attributionControl.setPrefix(false);
    fondo(map, el, !!(o && o.oscuro));
    let stop = null, me = null, acc = null, line = null, last = null, rutaAtrib = false;

    function pintar(d) {
      last = d;
      if (!stop) stop = L.marker(d.parada, { icon: iconoParada(d.lineas), keyboard: false, interactive: false }).addTo(map);
      else stop.setLatLng(d.parada);
      if (d.yo) {
        if (!me) {
          acc = L.circle(d.yo.p, { radius: d.yo.acc, stroke: false, fillColor: '#1a73e8', fillOpacity: 0.12, interactive: false }).addTo(map);
          me = L.marker(d.yo.p, { icon: iconoYo(), keyboard: false, interactive: false }).addTo(map);
        } else { me.setLatLng(d.yo.p); acc.setLatLng(d.yo.p).setRadius(d.yo.acc); }
      }
      if (line) { map.removeLayer(line); line = null; }
      if (d.yo && !d.cerca) {
        // El camino real empieza en el origen redondeado (~50 m): se le pone delante dónde estás.
        const pts = d.camino && d.camino.length > 1 ? [d.yo.p].concat(d.camino) : [d.yo.p, d.parada];
        line = L.polyline(pts, { color: '#c8102e', weight: 5, opacity: d.recta ? 0.55 : 0.9, dashArray: d.recta ? '2 10' : '1 9', lineCap: 'round', interactive: false }).addTo(map);
      }
      const conRuta = !!(d.camino && !d.recta);
      if (conRuta !== rutaAtrib) { map.attributionControl[conRuta ? 'addAttribution' : 'removeAttribution'](ATRIB_RUTA); rutaAtrib = conRuta; }
    }

    function centrar() {
      if (!last) return;
      if (!last.yo || last.cerca) { map.setView(last.parada, last.cerca ? 18 : 17); return; }
      const b = L.latLngBounds([last.parada, last.yo.p]);
      if (line) b.extend(line.getBounds());
      // Arriba más margen: el pin y el chip de las líneas quedan por encima de su punto.
      map.fitBounds(b, { paddingTopLeft: [40, 90], paddingBottomRight: [40, 36], maxZoom: 18 });
    }

    return {
      pintar, centrar,
      tamano() { map.invalidateSize(); },
      destruir() { map.remove(); },
    };
  }

  // Paso 3 del asistente: de dónde sales y una letra por parada de subida (roja si está marcada).
  //   const m = MiBusMapa.paradas(div, { oscuro });
  //   m.pintar({ inicio: [lat, lon], inicioTxt: 'Casa', paradas: [{ pos: [lat, lon], letra: 'A', on: true }] });
  function iconoLetra(letra, on) {
    return L.divIcon({
      className: 'mm-stop',
      html: '<svg width="28" height="35" viewBox="0 0 28 35" aria-hidden="true"><path d="M14 34C14 33 2 23 2 13a12 12 0 0 1 24 0c0 10-12 20-12 21z" fill="' + (on ? '#c8102e' : '#6e6e76') + '" stroke="#fff" stroke-width="2.5"/>' +
        '<text x="14" y="17.5" text-anchor="middle" font-family="Figtree, system-ui, sans-serif" font-size="13" font-weight="800" fill="#fff">' + esc(letra) + '</text></svg>',
      iconSize: [28, 35], iconAnchor: [14, 34],
    });
  }
  const iconoInicio = (txt) => L.divIcon({ className: 'mm-me', html: '<i></i><b class="mm-lbl">' + esc(txt) + '</b>', iconSize: [22, 22], iconAnchor: [11, 11] });

  // zoomSnap 0,25 (en los dos mapas): con saltos enteros, fitBounds se quedaba hasta un zoom entero
  // por detrás de lo que cabe (paso 3 de Yomer, 28 nov: zoom 15 → 15,75 con las mismas paradas).
  function paradas(el, o) {
    const map = L.map(el, { zoomControl: false, attributionControl: true, tap: false, maxZoom: 19, zoomSnap: 0.25, scrollWheelZoom: false });
    map.attributionControl.setPrefix(false);
    fondo(map, el, !!(o && o.oscuro));
    const capa = L.layerGroup().addTo(map);
    let encuadre = '';
    return {
      pintar(d) {
        capa.clearLayers();
        L.marker(d.inicio, { icon: iconoInicio(d.inicioTxt || ''), keyboard: false, interactive: false }).addTo(capa);
        for (const p of d.paradas) L.marker(p.pos, { icon: iconoLetra(p.letra, p.on), keyboard: false, interactive: false, zIndexOffset: p.on ? 1000 : 0 }).addTo(capa);
        // Solo se reencuadra si cambian los puntos (al marcar o desmarcar, el mapa se queda donde está).
        const k = JSON.stringify([d.inicio].concat(d.paradas.map((p) => p.pos)));
        if (k !== encuadre) {
          encuadre = k;
          const b = L.latLngBounds([d.inicio].concat(d.paradas.map((p) => p.pos)));
          map.fitBounds(b, { paddingTopLeft: [20, 46], paddingBottomRight: [20, 40], maxZoom: 17 });
        }
      },
      tamano() { map.invalidateSize(); },
      destruir() { map.remove(); },
    };
  }

  window.MiBusMapa = { crear, paradas };
})();
