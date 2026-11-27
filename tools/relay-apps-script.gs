// Relé de Corunauta para iTranvías (Google Apps Script).
//
// Para qué: el Worker de Cloudflare sale a internet con una IP compartida con otros servicios.
// El 26 nov iTranvías la bloqueó (429) sin que nos pasáramos del límite y la app se quedó un día
// con el horario programado. Este script consulta iTranvías desde las IPs de Google y el Worker
// lo usa SOLO mientras está bloqueado, y solo para llegadas de una parada (func=0).
// La web no puede consultar iTranvías con la IP del móvil: el navegador lo impide (CORS).
//
// Instalar (una vez, 5 min):
//  1. https://script.google.com → Nuevo proyecto → pegar este archivo entero.
//  2. Configuración del proyecto → Propiedades del script → añadir CLAVE con un texto largo al azar.
//  3. Implementar → Nueva implementación → Tipo «Aplicación web»:
//     Ejecutar como «Yo», Quién tiene acceso «Cualquier usuario». Autorizar.
//  4. Copiar la URL que acaba en /exec y probarla en el navegador:
//     <URL>?k=<CLAVE>&dato=50&func=0  → JSON con "buses".
//  5. Cloudflare → Workers → mibus → Settings → Variables and Secrets → añadir secreto
//     RELAY_URL = <URL>?k=<CLAVE>
//     (o: npx wrangler secret put RELAY_URL, desde cloudflare/).
//
// Quitarlo cuando Tranvías dé acceso oficial.

var API = 'https://itranvias.com/queryitr_v3.php';
var CUPO_MIN = 4;      // como iTranvías: 4/min por IP
var CACHE_S = 30;      // misma parada pedida dos veces en 30 s → una sola llamada

function doGet(e) {
  var p = (e && e.parameter) || {};
  var clave = PropertiesService.getScriptProperties().getProperty('CLAVE');
  if (clave && p.k !== clave) return json({ error: 'clave', status: 403 });
  var dato = String(p.dato || '');
  if (String(p.func) !== '0' || !/^\d{1,5}$/.test(dato)) return json({ error: 'solo func=0 con el número de parada', status: 400 });

  var cache = CacheService.getScriptCache();
  var hit = cache.get('stop:' + dato);
  if (hit) return text(hit);

  var lock = LockService.getScriptLock();
  lock.waitLock(5000);
  try {
    var mk = 'm:' + Math.floor(Date.now() / 60000);
    var usados = Number(cache.get(mk) || 0);
    if (usados >= CUPO_MIN) return json({ error: 'cupo del relé', status: 429 });
    cache.put(mk, String(usados + 1), 120);
  } finally {
    lock.releaseLock();
  }

  var r = UrlFetchApp.fetch(API + '?dato=' + dato + '&func=0', {
    muteHttpExceptions: true,
    followRedirects: true,
    headers: { Accept: 'application/json', Referer: 'https://itranvias.com/' }
  });
  var code = r.getResponseCode();
  var body = r.getContentText();
  if (code !== 200) return json({ error: 'iTranvías ' + code, status: code });
  try { JSON.parse(body); } catch (err) { return json({ error: 'iTranvías no devolvió JSON', status: 502 }); }
  cache.put('stop:' + dato, body, CACHE_S);
  return text(body);
}

function text(s) { return ContentService.createTextOutput(s).setMimeType(ContentService.MimeType.JSON); }
function json(o) { return text(JSON.stringify(o)); }
