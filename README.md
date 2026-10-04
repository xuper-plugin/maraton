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

## Downloads

Declared (`download`). Kino's queue calls `resolve` when the download runs, like a play; a stream resolved in the last
hours comes from the plugin's cache, otherwise the hidden browser opens the embed page (phones only: Kino never
downloads on a TV). Measured 2026-10-04 on the streamwish/hglink path: a master playlist on `audinifer.com` whose
path carries a Unix expiry 12 h after the capture (it served until then, from another IP too, no Referer needed),
H.264 + AAC muxed variants up to 1080p, `#EXT-X-ENDLIST` (VOD), ~310 segments per variant served from an ad CDN
(`p16-ad-site-sign-sg.tiktokcdn.com`) as `image/png`: each segment is a 70-byte PNG header followed by aligned
MPEG-TS packets, which Kino's HLS saver already strips (`TsSync.start`). Not yet tried on a device.
