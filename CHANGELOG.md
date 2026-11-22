# Changelog

## 0.7.1

- **The server that loads best for you goes first** (a learned ranking, like the other xuper-plugin sources): every success and failure (a capture that found nothing, only ads, a deleted file, a refused stream, a resolved playlist whose CDN does not answer) is counted per server, Laplace-smoothed and decaying, kept in your storage. Inside your language, and after "Probar primero", the servers that load for you are tried first — within each group (the ones read without the hidden browser first, then the ones that need it), so a server that failed once is still tried before a 20 s hidden page. With no history the order is the usual one. Measured on Breaking Bad (its Streamwish CDN down): the first episode 9 s, the next ones 2.5-3 s.

## 0.7.0

- **Every hoster now opens through the shared Kino Resolver** (`kino.plugins.call("resolver", "resolve")`, declared under `enhancements["20"].consumes` so an older Kino still installs this apiVersion-6 plugin, and `recommends`). PelisYSeries carried its own readers for vidhide, streamwish, vimeos and goodstream; they went stale (streamwish rewrote hglink ids to hlswish.com, now a parked domain, so every Streamwish copy failed). The resolver is asked for every server, known or not (an unknown host answers at once and goes to the hidden browser), so nothing is left out up front; videoapp.zip is still unwrapped here (it frames a vimeos page). Without the resolver every server still plays through the hidden browser.
- A resolved playlist is peeked at (2 KB) before it is played: a CDN that does not answer for that file (a streamwish node timing out, measured on Breaking Bad) moves on to the next server instead of reaching the player.
- **SeriesKao episodes are listed again**: its 2026-11 redesign lists them as `episode-item` cards with `data-season`/`data-episode` and no link; the episode pages keep their `/temporada/N/capitulo/M` address.
- **embed69 decrypts again** (SeriesKao and SoloLatino): the key is now SHA-256(LINK_CHALLENGE + LINK_SALT) and each link comes wrapped in backticks; the older written key and proof of work are still understood.
- **SoloLatino plays from its own servers again**: embed69.org sits behind Anubis (a proof-of-work anti-bot); its challenge is solved in the background (difficulty 4, about a second) and Kino keeps the cookie for the session.

## 0.6.6

- Home (and every call) leaves at its own budget: Kino waits for every request a call left running before it delivers the answer, so a Home that skipped a slow row was still held until that request ended or retried (measured on users' devices: Home ran 21-34 s with rows logged as skipped, and Kino threw the answer away at 20 s). The plugin now asks Kino to drop what a call leaves running (`globalThis.__kinoDropPendingFetches = true`, read by Kino 0.9.55 and later; an older Kino ignores it), with a test (`test/dropFetches.test.mjs`).
