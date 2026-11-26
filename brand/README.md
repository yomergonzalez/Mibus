# Logo de Corunauta

Propuesta B, «Parada en vivo»: un poste de parada con el punto verde de «en vivo» de la app.

- Azul marino `#0f2a44`, verde `#2bd47d`, blanco.
- Nombre en minúsculas, `corunauta`, en DM Sans 700 con `letter-spacing: -0.03em`.

## Archivos

| Archivo | Uso |
|---|---|
| `../icon.svg` | Icono principal (manifest, favicon) |
| `favicon.svg` | Versión sin el anillo del pulso, para 16–32 px |
| `maskable.svg` | Icono maskable de Android (fondo completo, símbolo al 80 %) |
| `apple.svg` | Icono de iPhone (fondo completo, símbolo al 90 %) |
| `og.html` | Imagen para compartir el enlace (1200 × 630) |

## Regenerar los PNG

```
rsvg-convert -w 192 -h 192 icon.svg -o icon-192.png
rsvg-convert -w 512 -h 512 icon.svg -o icon-512.png
rsvg-convert -w 512 -h 512 brand/maskable.svg -o icon-maskable-512.png
rsvg-convert -w 180 -h 180 brand/apple.svg -o apple-touch-icon.png
rsvg-convert -w 32 -h 32 brand/favicon.svg -o favicon-32.png
google-chrome --headless=new --hide-scrollbars --window-size=1200,630 --screenshot=og.png "file://$PWD/brand/og.html"
```

Para `og.png` hace falta la fuente DM Sans instalada.
