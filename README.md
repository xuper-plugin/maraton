# Maratón

Series, anime y películas en español —latino, castellano o subtitulado— para ver de corrido. Todo pasa en tu
propio aparato: el plugin lee los catálogos de los sitios, abre la página del episodio en un navegador oculto y le
pasa al reproductor el video que esa página encuentra. No hay servidores intermedios.

<img src="icon.png" width="96" alt="Maratón">

## Qué trae

- **Buscar**: series, anime y películas en dos catálogos (SeriesKao y AllCalidad). Los títulos de AllCalidad traen
  su ficha de TMDB, así que Kino les completa reparto, clasificación y más.
- **Inicio**: Nuevos episodios, Recién agregado, Series, Anime, Películas, Películas recientes y Series recientes
  (con "Ver más").
- **Episodios** de todas las temporadas, y la ficha de la serie (sinopsis, póster, año).
- **Reproducir**: prueba los servidores en orden y recuerda cuál te funcionó la última vez, así el siguiente
  episodio abre más rápido. Si el mismo episodio se vuelve a abrir en las horas siguientes, arranca sin buscar de nuevo.
- **Subtítulos** en español cuando la página los trae.
- **Descargar** para ver sin conexión (en el celular).

## Cómo instalarlo

En Kino: **Ajustes ▸ Plugins ▸ Agregar**, escribe `xuper-plugin/maraton` y toca **Agregar**. Antes de instalar vas
a ver con qué sitios se conecta y qué permisos pide.

Necesita una versión de Kino con plugins de apiVersion 7 o más nueva; una anterior te dice "Este plugin necesita una
versión más nueva de Kino".

## Permisos que pide, y por qué

- **"Puede abrir páginas web ocultas para encontrar el video"** (en rojo). Los sitios no ponen la dirección del video
  en su HTML: la arma el reproductor de la página cuando corre. Por eso, solo cuando tocas reproducir (o cuando una
  descarga arranca), Kino abre esa página en un navegador oculto de tu aparato, sin cookies de nada más, y se queda
  con la dirección del video que la página pide. La página no puede tocar tu red local, abrir ventanas ni descargar
  archivos, y se borra todo al cerrarse.
- **"Puede reproducir video desde cualquier servidor que indique"** (en rojo). El video vive en el servidor que el
  reproductor de cada página elija, y esos cambian; nunca uno de tu red local.
- **"Puede descargar videos para verlos sin conexión"**.
- **Se conecta con**: `serieskao.top`, `tmdb.allcalidad.re`, `sololatino.net` (los catálogos) y `morencius.com`,
  `hglink.to`, `voe.sx`, `vimeos.net`, `goodstream.one` (los reproductores donde arranca la búsqueda del video).

## Ajustes

**Idioma preferido** (Ajustes ▸ Plugins ▸ Maratón ▸ Configurar): Latino (por defecto), Castellano o Subtitulado.
Ordena los servidores de cada episodio: primero los de tu idioma; si no hay, los otros.

## Bueno saber

- Un sitio caído o que pide una verificación no rompe los demás: la búsqueda muestra lo que sí respondió.
- La dirección de cada video dura unas horas (medido: 12 h). Si se vence mientras pausas, Kino la vuelve a buscar.
- `sololatino.net` hoy pide una verificación de Cloudflare: por ahora no aporta resultados.

## Para quien mantiene el plugin

```
node <kino>/plugins/sdk/validate.mjs .
node <kino>/plugins/sdk/run.mjs . search dark
node <kino>/plugins/sdk/run.mjs . episodes 'sk|/serie/dark'
npm test
```

`resolve` no corre en el kit de Node (no hay navegador: responde `browser_unavailable`); pruébalo en un aparato. En un
build debug de Kino se puede instalar sin publicar con `PluginSideloadProbe`: copia esta carpeta a
`files/debug-plugins/local/maraton/` e instala `local/maraton`.

Las descargas, medidas el 2026-10-04: la lista maestra HLS es VOD (`#EXT-X-ENDLIST`), variantes H.264 + AAC hasta
1080p, y los segmentos llegan como `image/png` (70 bytes de PNG y después paquetes MPEG-TS alineados), que el guardado
HLS de Kino ya limpia.

Al crear el repositorio (no antes):

```
gh repo edit xuper-plugin/maraton --add-topic kino-plugin --description "Series, anime y películas en latino, castellano o subtitulado. El video se busca en tu propio aparato."
```

El ícono sale de `art/icon.svg` (`rsvg-convert -w 512 -h 512 art/icon.svg -o icon.png`).
