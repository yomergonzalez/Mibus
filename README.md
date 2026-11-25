# Mi bus · A Coruña

Web-app ligera para ver en tiempo real cuándo llegan los buses urbanos de A Coruña a tus paradas, con dos trayectos (ir al trabajo / volver a casa). Datos en vivo de iTranvías (Compañía de Tranvías de A Coruña).

- `index.html`: la app (GitHub Pages). Consulta iTranvías directamente desde el navegador.
- `cloudflare/worker.js`: alternativa con proxy en Cloudflare Workers, por si iTranvías bloquea las peticiones del navegador (CORS). Pon su URL en `const PROXY` dentro de `index.html`.

Las paradas se editan desde la propia app (se guardan en el navegador).
