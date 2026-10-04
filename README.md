# Maratón

Series and anime from Spanish-language streaming sites, for Kino 0.9.51+ (plugin apiVersion 7). Everything runs on
the device: titles and episodes come from the site's HTML through `kino.fetch`, and an episode plays by opening its
page in Kino's hidden browser (`kino.browser.capture`), which reports the video request the page's own player makes.

- Sites: `serieskao.top` (works), `sololatino.net` (behind a Cloudflare challenge from most networks: its search and
  pages fail quietly and the plugin carries on with serieskao).
- Capabilities: `search`, `home` (+ `browse`: the series and anime catalogs), `episodes`, `resolve`. The series info
  carries the IMDb id read from the player page, so Kino joins it with TMDB.
- Manifest: `"browser": true` and `"streamHosts": "any"` (both shown in red on the consent sheet): the video is on
  whatever CDN the embedded player uses.
- No torrents, no server.

Not published anywhere (no remote). To try it on a debug build, use the app's `PluginSideloadProbe`
(`app/src/debug/.../PluginSideloadProbe.kt`): copy this folder to `files/debug-plugins/local/maraton/` and install
`local/maraton` from Ajustes ▸ Plugins.

```
node <kino>/plugins/sdk/validate.mjs .
node <kino>/plugins/sdk/run.mjs . search dark
node <kino>/plugins/sdk/run.mjs . episodes 'sk|/serie/dark'
node --test test/plugin.test.mjs
```

`resolve` cannot run under the Node kit (no WebView: it answers `browser_unavailable`); try it in the app.
