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
- **Se conecta con**: `serieskao.top`, `tmdb.allcalidad.re` (los catálogos) y `morencius.com`,
  `hglink.to`, `voe.sx`, `vimeos.net`, `goodstream.one` (los reproductores donde arranca la búsqueda del video).

## Su propia página y sus géneros

- **Página de Maratón**: un chip en Inicio (celular) o una entrada en la barra lateral (TV), con pestañas **Series**,
  **Anime**, **Películas** y **Géneros**, en los colores verdes del plugin.
- **Categorías ▸ Maratón**: 22 géneros (Acción, Comedia, Drama, Terror, Animación, Doramas…), cada uno con lo que
  tienen los dos sitios mezclado, página por página.

## Ajustes

En **Ajustes ▸ Maratón** (o Plugins ▸ Maratón ▸ Configurar):

| Ajuste | Qué cambia |
| --- | --- |
| Usar SeriesKao / Usar AllCalidad | De qué sitios salen la búsqueda, Inicio, la página y los géneros. No deja apagar los dos. |
| Idioma preferido | Latino (por defecto), Castellano o Subtitulado: primero se prueban los servidores de ese idioma. |
| Probar primero | Un servidor que quieres que se pruebe antes que los demás (dentro de tu idioma). Por defecto, el que funcionó la última vez. |
| Recordar enlaces unas horas | Si vuelves a abrir algo que ya viste hoy, arranca sin buscar de nuevo. Apágalo si un video se queda pegado. |
| Estado | Cuántos sitios usas, tu idioma y qué servidor funcionó la última vez. |
| Revisar sitios | Prueba ahora cada sitio y te dice cuál responde y cuál pide una verificación. |
| Borrar enlaces guardados | Olvida los enlaces recordados y los servidores que funcionaron. |

## Bueno saber

- Un sitio caído o que pide una verificación no rompe los demás: la búsqueda muestra lo que sí respondió.
- La dirección de cada video dura unas horas (medido: 12 h). Si se vence mientras pausas, Kino la vuelve a buscar.

## Cómo está hecho (para quien escribe plugins)

Maratón usa casi todo lo que ofrece el SDK de plugins de Kino; `plugin.js` está comentado para leerse de arriba abajo.

- **Manifiesto** (`kino-plugin.json`): `apiVersion` 7, `hosts` exactos (nada de comodines), `streamHosts: "any"` porque
  el video vive en el CDN que elija cada reproductor, `browser: true`, `download`, `meta`, `categories` de mercado,
  `section`, `theme` (contrastes revisados con `run.mjs . theme`), ícono propio y ajustes de todos los tipos útiles
  (`section`, `toggle`, `select`, `status`, `action`).
- **Errores** con código y `userMessage` en español para cada falla de red, sitio caído, verificación de Cloudflare o
  servidor que ya no existe; nunca un "no hay resultados" cuando lo que pasó es que nadie respondió.
- **Tiempos**: cada petición 10 s; `resolve` lleva su propio reloj por debajo de los 75 s que Kino le da y nunca abre
  una página sin tiempo; cada página oculta 15 s si quedan otras, 25 s la última.
- **Búsqueda** con `kino.rank` (cabeza del título, orden por parecido, relevancia) y los títulos alternos de TMDB que
  Kino manda (`originalTitle`, `altTitles`).
- **`kino.storage`** con vencimiento (`ttlMs`) para los enlaces, el último servidor que funcionó y el IMDb de cada serie.
- **`expiresInSeconds`** sacado de la URL del CDN, y `resolve(ref, { retry })` que tira la copia guardada.
- **Registros** (`kino.log`) de cada paso con su tiempo, solo host y ruta: nunca una query con tokens.
- **Pruebas** (`npm test`) contra páginas y respuestas guardadas de los sitios reales (`test/fixtures`), con un `kino`
  falso; cada ajuste tiene la suya.
- **Sin llaves**: no carga ninguna clave fija; si algún día hiciera falta, iría sellada en `secrets` y se usaría con
  `kino.secret(name)`, como dice la guía.

## Para quien mantiene el plugin

```
node <kino>/plugins/sdk/validate.mjs .
node <kino>/plugins/sdk/run.mjs . search dark
node <kino>/plugins/sdk/run.mjs . episodes 'sk|/serie/dark'
node <kino>/plugins/sdk/run.mjs . section generos
node <kino>/plugins/sdk/run.mjs . categories
node <kino>/plugins/sdk/run.mjs . theme
node <kino>/plugins/sdk/run.mjs . settingsStatus
node <kino>/plugins/sdk/run.mjs . action check
node <kino>/plugins/sdk/run.mjs . validateSettings '{"useSerieskao":false,"useAllcalidad":false}'
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
