# Mi bus · A Coruña

Web-app ligera para ver en tiempo real cuándo llegan los buses urbanos de A Coruña a tus paradas, con dos trayectos (ir al trabajo / volver a casa). Datos en vivo de iTranvías (Compañía de Tranvías de A Coruña).

- `index.html`: la app (GitHub Pages). Consulta iTranvías directamente desde el navegador.
- `cloudflare/worker.js`: alternativa con proxy en Cloudflare Workers, por si iTranvías bloquea las peticiones del navegador (CORS). Pon su URL en `const PROXY` dentro de `index.html`.

Las paradas se editan desde la propia app (se guardan en el navegador).

## Horario programado (GTFS)

`gtfs/` tiene el horario programado de todas las paradas, sacado del GTFS de Tranvías ("Autobús urbano de la Coruña" en [nap.transportes.gob.es](https://nap.transportes.gob.es)). Se publica con GitHub Pages y no gasta cupo de iTranvías. El Worker lo usa para:

- dar "qué bus cojo" y "qué bus pasa a las 9" con la hora exacta de cada parada (sin pedir `func=8`);
- responder "según horario" cuando iTranvías no responde y no hay un dato reciente;
- tener un catálogo de líneas y paradas de respaldo.

Los IDs de parada y línea son los mismos que en iTranvías. El GTFS actual llega hasta el 31/12/2026. Para actualizarlo, descarga el zip nuevo y ejecuta:

```
python3 tools/gtfs_build.py RUTA/AL/GTFS.zip
```

Haz commit de `gtfs/` y súbelo a `main`.

## Relé de respaldo (si iTranvías bloquea al Worker)

iTranvías limita por IP y el Worker sale con una IP de Cloudflare compartida: a veces la bloquea aunque no nos pasemos. La web no puede consultar con la IP del móvil (el navegador lo impide por CORS), así que el respaldo es un relé con otra IP: `tools/relay-apps-script.gs`, un Google Apps Script gratuito. Las instrucciones están al principio del archivo; al final se guarda su URL como secreto `RELAY_URL` del Worker. Sin `RELAY_URL` no cambia nada.

El Worker solo lo usa para llegadas (`func=0`) y solo mientras iTranvías le devuelve 429 o está en pausa; nunca para saltarse el presupuesto propio. Cupo del relé: 4/min, 120/h, 600/día (contadores `rbudget:*` en D1). `/api/stop` responde `"via": "rele"` cuando el dato llegó por ahí.

## Servidor MCP (Alexa+ y otros asistentes)

El Worker expone un servidor [MCP](https://modelcontextprotocol.io) en `POST /mcp` (Streamable HTTP, sin estado) con cuatro herramientas que reutilizan la lógica de la skill:

| Herramienta | Para qué |
|---|---|
| `proximos_buses` | Próximos buses en vivo de tu trayecto (`ida` casa → trabajo, `vuelta` trabajo → casa) |
| `consultar_parada` | Llegadas en vivo de una línea y/o parada (nombre o número) |
| `planificar_viaje` | Qué bus coger para llegar a una hora (`ida`) o al salir a una hora (`vuelta`) |
| `buses_a_una_hora` | Buses programados en tus paradas alrededor de una hora |

**Autenticación.** Sin secrets, `/mcp` queda abierto (los datos de iTranvías son públicos), y sirve para conectarlo como conector personalizado en Claude u otro cliente. Para Alexa+ define los secrets `MCP_CLIENT_ID` y `MCP_CLIENT_SECRET` (Cloudflare → Workers → mibus → Settings → Variables and Secrets): entonces `/mcp` exige un token OAuth 2.1 `client_credentials` (scope `mcp:service`, 1 h) que emite `POST /oauth/token`. Metadatos en `/.well-known/oauth-protected-resource` y `/.well-known/oauth-authorization-server`.

**Conectar a Alexa+** (MCP Toolkit, necesita macOS o Ubuntu, Node 24+ y cuenta de AWS):

```sh
npm install -g @alexa-ai/cli
alexa-ai configure
alexa-ai new mcp --name "Mi bus" --locale es-US --mcp-server-url "https://mibus.<subdominio>.workers.dev/mcp"
alexa-ai deploy
```

Prueba rápida del servidor: `npx @modelcontextprotocol/inspector` → Streamable HTTP → `https://mibus.<subdominio>.workers.dev/mcp`.

### MCP público y genérico (`POST /mcp/public`)

Versión para compartir con cualquiera: sin autenticación y sin datos personales (no hay alias de "casa"/"trabajo" ni trayectos fijos). El servidor no guarda nada del usuario; sus paradas habituales las recuerda el cliente.

- `buscar_parada` — paradas por calle, lugar o número.
- `paradas_cercanas` — paradas más cercanas a una latitud/longitud, con tiempos en vivo de las 3 primeras.
- `proximos_buses` — llegadas en vivo en una parada (nombre o número), con filtro de línea opcional.
- `horario_linea` — horario programado de salidas desde cabecera para una fecha.

Caché en memoria (25 s por parada, 6 h para el catálogo y horarios; `caches.default` no funciona en `*.workers.dev`) y límite de 60 peticiones/min por IP. Conéctalo como conector personalizado con `https://mibus.<subdominio>.workers.dev/mcp/public`.
