// Offline tests: the HTML parsers against pages saved from the real site (test/fixtures), and resolve's
// fallbacks with a fake `kino`. Run: node --test test/
import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, createDecipheriv } from "node:crypto";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => readFileSync(join(here, "fixtures", name), "utf8");

const pages = {
  "https://serieskao.top/search?s=dark": fixture("sk-search-dark.html"),
  "https://serieskao.top/serie/dark": fixture("sk-serie-dark.html"),
  "https://serieskao.top/serie/dark/temporada/1/capitulo/1": fixture("sk-ep-dark-1x01.html"),
};
const captured = [];
let captureAnswer = async () => ({ media: [{ url: "https://cdn.example/master.m3u8", headers: { Referer: "https://x/" } }], subtitles: [], finalUrl: "" });
const kinoError = (code, message, options) => Object.assign(new Error(message), { code, ...(options || {}) });
// Pictures (genre art) load unless listed here; a HEAD is all the plugin asks of them.
const missingImages = new Set();
globalThis.kino = {
  fetch: async (url, init = {}) => {
    if (init.method === "HEAD" && /\.(webp|jpe?g|png)$/.test(url)) {
      const ok = !missingImages.has(url);
      return { ok, status: ok ? 200 : 404, headers: { "content-type": ok ? "image/webp" : "text/html; charset=UTF-8" }, text: () => "" };
    }
    const body = pages[url];
    return { ok: body !== undefined, status: body === undefined ? 404 : 200, text: () => body || "", json: () => JSON.parse(body) };
  },
  browser: { capture: async (url, opts) => { captured.push(url); return captureAnswer(url, opts); } },
  error: kinoError,
  // Real time, but tests shrink LIMITS; an unref'd timer never keeps the test process alive.
  sleep: (ms) => new Promise((r) => { const t = setTimeout(r, ms); if (t.unref) t.unref(); }),
  log: Object.assign(() => {}, { report: (...a) => reports.push(a) }),
  // The two kino.crypto calls the embed69 fast path makes, with Node's crypto (hex in/out like Kino's).
  crypto: {
    hash: (alg, data) => createHash(alg).update(data, "utf8").digest("hex"),
    decrypt: (alg, o) => {
      const d = createDecipheriv(alg, Buffer.from(o.key, "hex"), Buffer.from(o.iv, "hex"));
      return Buffer.concat([d.update(Buffer.from(o.data, "hex")), d.final()]).toString("utf8");
    },
  },
  rank: { shortQuery: (q) => q, sortBySimilarity: (a) => a, filterRelevant: (a) => a },
  storage: {
    get: (k) => (store.has(k) ? store.get(k) : null),
    set: (k, v, o) => { store.set(k, v); ttls.set(k, o && o.ttlMs); },
    remove: (k) => { store.delete(k); },
    keys: () => [...store.keys()],
  },
  config: { get: (k) => config[k] },
};
const reports = [];
const store = new Map();
const ttls = new Map();
const config = {};
// SoloLatino is off by default in these tests (its own tests switch it on): the older tests are about two sites.
beforeEach(() => { missingImages.clear(); plugin.forgetPages(); reports.length = 0; store.clear(); ttls.clear(); for (const k of Object.keys(config)) delete config[k]; config.useSololatino = false; });
const plugin = await import("../plugin.js");

test("search reads serieskao's cards and survives the other site failing", async () => {
  const items = await plugin.search({ q: "dark" });
  const dark = items.find((i) => i.ref === "sk|/serie/dark");
  assert.equal(dark.title, "Dark");
  assert.equal(dark.year, "2017");
  assert.match(dark.poster, /^https:\/\/image\.tmdb\.org\//);
  assert.ok(items.some((i) => i.ref.startsWith("sk|/anime/")));
});

test("episodes: every season, in order, with the IMDb id from the player page", async () => {
  const r = await plugin.episodes("sk|/serie/dark");
  assert.equal(r.episodes.length, 26);
  assert.deepEqual(r.episodes[0], { season: 1, number: 1, ref: "sk|/serie/dark/temporada/1/capitulo/1", title: "Secretos" });
  assert.deepEqual(r.episodes.at(-1).season, 3);
  assert.deepEqual(r.series.ids, { imdb: "tt5753856" });
  assert.ok(r.series.overview.length > 200);
});

test("servers: the data-url buttons and the iframe, absolute and once each", () => {
  assert.deepEqual(plugin.serversOf("sk", fixture("sk-ep-bastard-1x01.html")), [
    "https://serieskao.top/vidurl/tt17736234-1x01/",
    "https://embed69.org/video/tt17736234-1x01/",
  ]);
});

test("a player page on the site itself is opened through the episode page that frames it", () => {
  const ep = "https://serieskao.top/anime/bastard/temporada/1/capitulo/1";
  assert.deepEqual(plugin.pagesToOpen("sk", ep, ["https://serieskao.top/vidurl/tt1-1x01/", "https://other.example/e/1"]), [ep, "https://other.example/e/1"]);
  assert.deepEqual(plugin.pagesToOpen("sk", ep, []), [ep]);
});

test("resolve plays what the hidden browser captured, with its headers", async () => {
  captured.length = 0;
  const s = await plugin.resolve("sk|/serie/dark/temporada/1/capitulo/1");
  assert.deepEqual(captured, ["https://serieskao.top/serie/dark/temporada/1/capitulo/1"]);
  assert.equal(s.url, "https://cdn.example/master.m3u8");
  assert.deepEqual(s.headers, { Referer: "https://x/" });
});

test("resolve without a WebView says so in words the person understands", async () => {
  captureAnswer = async () => { throw kinoError("browser_unavailable", "none"); };
  await assert.rejects(plugin.resolve("sk|/serie/dark/temporada/1/capitulo/1"), (e) => e.code === "unavailable" && /navegador/.test(e.userMessage));
});

test("embed69Servers decrypts serieskao's /vidurl page (proof-of-work key), latino first", () => {
  const servers = plugin.embed69Servers(fixture("sk-vidurl-embed69.html"));
  assert.deepEqual(servers.map((s) => new URL(s.url).host), ["morencius.com", "hglink.to", "voe.sx"]);
  assert.ok(servers.every((s) => s.lang === "LAT"));
});

test("embed69Servers answers [] for a page without dataLink", () => {
  assert.deepEqual(plugin.embed69Servers("<html>nada</html>"), []);
});

test("resolve takes the embed69 fast path: captures the decrypted embed pages, not the episode page", async () => {
  pages["https://serieskao.top/vidurl/tt5753856-1x01/"] = fixture("sk-vidurl-embed69.html");
  captured.length = 0;
  captureAnswer = async () => ({ media: [{ url: "https://cdn.example/master.m3u8", headers: { Referer: "https://x/" } }], subtitles: [], finalUrl: "" });
  try {
    const stream = await plugin.resolve("sk|/serie/dark/temporada/1/capitulo/1");
    assert.equal(stream.url, "https://cdn.example/master.m3u8");
    // Preference order: streamwish (hglink.to) before vidhide (morencius.com), which goes last.
    assert.equal(new URL(captured[0]).host, "hglink.to");
  } finally {
    delete pages["https://serieskao.top/vidurl/tt5753856-1x01/"];
  }
});

test("servers: latino first; within it the servers whose page carries the playlist, then streamwish, unknown, voe", () => {
  const list = [
    { lang: "LAT", server: "vidhide", url: "https://morencius.com/embed/a" },
    { lang: "SUB", server: "streamwish", url: "https://hglink.to/e/s" },
    { lang: "LAT", server: "mystery", url: "https://mystery.example/e/f" },
    { lang: "LAT", server: "voe", url: "https://voe.sx/e/v" },
    { lang: "LAT", server: "streamwish", url: "https://hglink.to/e/l" },
  ];
  assert.deepEqual(plugin.rankServers(list).map((f) => f.url), [
    "https://hglink.to/e/l", "https://morencius.com/embed/a", "https://mystery.example/e/f", "https://voe.sx/e/v", "https://hglink.to/e/s",
  ]);
  assert.ok(plugin.canExtract({ url: "https://hglink.to/e/l" }) && plugin.canExtract({ url: "https://vimeos.net/embed-x.html" }));
  assert.ok(!plugin.canExtract({ url: "https://voe.sx/e/v" }) && !plugin.canExtract({ url: "https://filemoon.sx/e/x" }));
});

test("a page gets 15 s while others remain and the full 25 s when it is the last", () => {
  assert.equal(plugin.captureTimeout(2), 15000);
  assert.equal(plugin.captureTimeout(1), 15000);
  assert.equal(plugin.captureTimeout(0), 25000);
});

const mixed = [
  { lang: "LAT", server: "vidhide", url: "https://morencius.com/embed/a" },
  { lang: "ESP", server: "voe", url: "https://voe.sx/e/esp" },
  { lang: "SUB", server: "streamwish", url: "https://hglink.to/e/sub" },
  { lang: "LAT", server: "streamwish", url: "https://hglink.to/e/lat" },
];

test("Idioma preferido orders the languages; the other two follow in Latino, Castellano, Subtitulado order", () => {
  assert.deepEqual(plugin.rankServers(mixed, "esp").map((f) => f.url), ["https://voe.sx/e/esp", "https://hglink.to/e/lat", "https://morencius.com/embed/a", "https://hglink.to/e/sub"]);
  assert.deepEqual(plugin.rankServers(mixed, "sub").map((f) => f.url), ["https://hglink.to/e/sub", "https://hglink.to/e/lat", "https://morencius.com/embed/a", "https://voe.sx/e/esp"]);
  assert.deepEqual(["LAT", "Latino", "ESP", "CAST", "Español", "SUB", "VOSE", ""].map(plugin.langOf), ["lat", "lat", "esp", "esp", "esp", "sub", "sub", "sub"]);
});

test("the server that last worked on the site goes first within the language, never over the language", () => {
  assert.deepEqual(plugin.rankServers(mixed, "lat", "vidhide").map((f) => f.url).slice(0, 2), ["https://morencius.com/embed/a", "https://hglink.to/e/lat"]);
  assert.equal(plugin.rankServers(mixed, "esp", "vidhide")[0].url, "https://voe.sx/e/esp");
});

test("expiresInOf reads the CDN's Unix time from the path, only when it is ahead and within a week", () => {
  const now = 1791092503;
  assert.equal(plugin.expiresInOf("https://audinifer.com/stream/tok/x/1791135524/63911296/master.m3u8", now), 43021);
  assert.equal(plugin.expiresInOf("https://cdn.example/1791000000/master.m3u8", now), null); // past
  assert.equal(plugin.expiresInOf("https://cdn.example/1899999999/master.m3u8", now), null); // years ahead
  assert.equal(plugin.expiresInOf("https://cdn.example/master.m3u8?e=1791135524", now), null); // query is not read
  assert.equal(plugin.expiresInOf("https://cdn.example/v/1791100000/x.mp4", 1791000000), 86400); // capped
});

test("a cached stream comes back with what is left of its expiry, never when nearly gone", () => {
  const now = 1_000_000;
  const entry = { stream: { url: "https://x/a.m3u8", expiresInSeconds: 3600 }, until: now + 60_000, expiresAtMs: now + 1800_000 };
  assert.equal(plugin.fromCache(entry, now).expiresInSeconds, 1800);
  assert.equal(plugin.fromCache({ ...entry, expiresAtMs: now + 10_000 }, now), null);
  assert.equal(plugin.fromCache({ ...entry, until: now - 1 }, now), null);
  assert.equal(plugin.fromCache(null, now), null);
});

test("resolve: a second play reuses the stream without opening a page; a retry drops it and captures again", async () => {
  pages["https://serieskao.top/vidurl/tt5753856-1x01/"] = fixture("sk-vidurl-embed69.html");
  const exp = Math.floor(Date.now() / 1000) + 12 * 3600;
  captureAnswer = async () => ({ media: [{ url: `https://cdn.example/s/${exp}/1/master.m3u8`, headers: { Referer: "https://x/" } }], subtitles: [{ url: "https://cdn.example/es.vtt" }], finalUrl: "" });
  try {
    captured.length = 0;
    const first = await plugin.resolve("sk|/serie/dark/temporada/1/capitulo/1");
    assert.equal(captured.length, 1);
    assert.ok(first.expiresInSeconds > 12 * 3600 - 60 && first.expiresInSeconds <= 12 * 3600);
    assert.deepEqual(first.subtitles, [{ lang: "es", label: "Español (Latino)", url: "https://cdn.example/es.vtt", format: "vtt" }]);
    assert.ok(ttls.get("stream:sk|/serie/dark/temporada/1/capitulo/1") <= 4 * 3600 * 1000);
    assert.deepEqual(JSON.parse(store.get("server:sk")), { server: "streamwish" });
    const again = await plugin.resolve("sk|/serie/dark/temporada/1/capitulo/1");
    assert.equal(captured.length, 1);
    assert.equal(again.url, first.url);
    await plugin.resolve("sk|/serie/dark/temporada/1/capitulo/1", { retry: { reason: "expired", attempt: 1, status: 403 } });
    assert.equal(captured.length, 2);
  } finally {
    delete pages["https://serieskao.top/vidurl/tt5753856-1x01/"];
  }
});

test("resolve with Idioma preferido Subtitulado opens the subtitled server first when the page has one", async () => {
  pages["https://serieskao.top/vidurl/tt5753856-1x01/"] = fixture("sk-vidurl-embed69.html");
  config.lang = "sub";
  captured.length = 0;
  captureAnswer = async () => ({ media: [{ url: "https://cdn.example/master.m3u8", headers: {} }], subtitles: [], finalUrl: "" });
  try {
    await plugin.resolve("sk|/serie/dark/temporada/1/capitulo/1");
    // This page only has latino servers: the preference changes nothing and resolve still plays.
    assert.equal(new URL(captured[0]).host, "hglink.to");
  } finally {
    delete pages["https://serieskao.top/vidurl/tt5753856-1x01/"];
  }
});

test("a challenge page is recognised; the passive beacon on a real page is not", () => {
  assert.ok(plugin.looksLikeChallenge("<html><head><title>Just a moment...</title>"));
  assert.ok(plugin.looksLikeChallenge("<script>window._cf_chl_opt={}</script>"));
  assert.ok(!plugin.looksLikeChallenge('<html><title>Dark</title><script src="/cdn-cgi/challenge-platform/scripts/jsd/main.js"></script>'));
});

test("a site that times out says so in Spanish and resolve does not hang on it", async () => {
  const saved = kino.fetch;
  kino.fetch = async () => { throw Object.assign(new Error("timeout"), { code: "timeout" }); };
  try {
    await assert.rejects(plugin.episodes("sk|/serie/dark"), (e) => e.code === "unavailable" && /no responde/.test(e.userMessage));
  } finally {
    kino.fetch = saved;
  }
});

test("home's Nuevos episodios: one series per show, newest episode as a badge", () => {
  const items = plugin.latestEpisodes("sk", fixture("sk-home.html"));
  assert.equal(items.length, 12);
  assert.equal(new Set(items.map((i) => i.ref)).size, items.length);
  for (const i of items) {
    assert.equal(i.kind, "series");
    assert.match(i.ref, /^sk\|\/(serie|anime)\/[^/]+$/);
    assert.equal(i.badges[0], "Nuevo episodio");
    assert.match(i.badges[1], /^T\d+ E\d+$/);
  }
});

test("Recién agregado keeps movies as movies and series as series", async () => {
  pages["https://serieskao.top/"] = fixture("sk-home.html");
  pages["https://serieskao.top/series?page=1"] = fixture("sk-search-dark.html");
  try {
    const rows = await plugin.home();
    const recent = rows.find((r) => r.id === "sk-recent");
    assert.ok(recent.items.some((i) => i.kind === "movie" && i.ref.startsWith("sk|/pelicula/")));
    assert.ok(rows.find((r) => r.id === "sk-latest"));
    // Catalogs that failed (404 here) leave no row and break nothing.
    assert.ok(!rows.find((r) => r.id === "sk-anime"));
  } finally {
    delete pages["https://serieskao.top/"];
    delete pages["https://serieskao.top/series?page=1"];
  }
});

test("meta answers only for an IMDb id met in episodes, with the episode list", async () => {
  assert.equal(await plugin.meta({ type: "series", ids: { imdb: "tt5753856" } }), null);
  await plugin.episodes("sk|/serie/dark");
  const m = await plugin.meta({ type: "series", ids: { imdb: "tt5753856" } });
  assert.equal(m.title, "Dark");
  assert.equal(m.episodes.length, 26);
  assert.deepEqual(m.episodes[0], { season: 1, number: 1, title: "Secretos" });
  assert.equal(await plugin.meta({ type: "movie", ids: { imdb: "tt5753856" } }), null);
});

test("the movie page's servers are its own /vidurl/<imdb>/ player page", () => {
  assert.deepEqual(plugin.serversOf("sk", fixture("sk-pelicula-marea-baja.html")), ["https://serieskao.top/vidurl/tt7434324/"]);
});

test("a server ref addresses one language/server; resolve opens only that one", async () => {
  const f = { lang: "SUB", server: "Voe", url: "https://voe.sx/e/x" };
  const r = plugin.serverRef("sk|/serie/dark/temporada/1/capitulo/1", f);
  assert.equal(r, "sk|/serie/dark/temporada/1/capitulo/1#sub/voe");
  assert.deepEqual(plugin.parseServerRef(r), { base: "sk|/serie/dark/temporada/1/capitulo/1", only: { lang: "sub", server: "voe" } });
  assert.deepEqual(plugin.parseServerRef("sk|/x#junk"), { base: "sk|/x", only: null });
  pages["https://serieskao.top/vidurl/tt5753856-1x01/"] = fixture("sk-vidurl-embed69.html");
  captured.length = 0;
  captureAnswer = async () => ({ media: [{ url: "https://cdn.example/master.m3u8", headers: {} }], subtitles: [], finalUrl: "" });
  try {
    await plugin.resolve("sk|/serie/dark/temporada/1/capitulo/1#lat/voe");
    assert.deepEqual(captured.map((u) => new URL(u).host), ["voe.sx"]);
    await assert.rejects(plugin.resolve("sk|/serie/dark/temporada/1/capitulo/1#esp/voe"), (e) => e.code === "not_found");
  } finally {
    delete pages["https://serieskao.top/vidurl/tt5753856-1x01/"];
  }
});

const ACAPI = "https://allcalidad.re/api/rest";

test("allcalidad items from its API: title and year split, images, genres; anime is a series", () => {
  const items = JSON.parse(fixture("ac2-search-dark.json")).data.posts.map(plugin.acItem).filter(Boolean);
  const dark = items.find((i) => i.ref === "ac|tvshows/41641/dark-2017");
  assert.equal(dark.kind, "series");
  assert.equal(dark.title, "Dark");
  assert.equal(dark.year, "2017");
  assert.match(dark.poster, /^https:\/\/allcalidad\.re\/wp-content\/uploads\/thumbs\//);
  assert.match(dark.backdrop, /^https:\/\/allcalidad\.re\/wp-content\/uploads\/backdrops\//);
  assert.equal(dark.id, "ac-tvshows-41641");
  const grimm = items.find((i) => i.ref.startsWith("ac|tvshows/57298/"));
  assert.equal(grimm.title, "A Tale Dark & Grimm");
  assert.equal(grimm.overview, undefined); // the site's "no synopsis yet" placeholder is left out
  assert.ok(items.some((i) => i.kind === "movie" && i.ref.startsWith("ac|movies/")));
  const anime = plugin.acItem({ _id: 4993, type: "animes", slug: "naruto-2002", title: "Naruto (2002)", genres: [51] });
  assert.equal(anime.kind, "series");
  assert.equal(anime.genres[0], "Anime");
  assert.equal(plugin.acItem({ type: "person", _id: 1, title: "x", slug: "x" }), null);
});

test("allcalidad episodes: the show's list with stills, its TMDB id from the episodes", async () => {
  pages[`${ACAPI}/episodes?post_id=41641`] = fixture("ac2-episodes-41641.json");
  try {
    const r = await plugin.episodes("ac|tvshows/41641/dark-2017");
    // The title's own info (single) answers 404 here: the episodes still come.
    assert.deepEqual(r.episodes.map((e) => [e.season, e.number]), [[1, 1], [1, 2], [1, 3], [2, 1]]);
    assert.equal(r.episodes[0].ref, "ac|ep/41663/70523/1/1");
    assert.match(r.episodes[0].still, /^https:\/\/image\.tmdb\.org\/t\/p\/w300\//);
    assert.equal(r.episodes[0].title, undefined); // "Dark: Temporada 1 Episodio 1" says nothing
    assert.ok(r.episodes[0].overview.length > 20);
    assert.deepEqual(r.series.ids, { tmdb: 70523 });
    await assert.rejects(plugin.episodes("ac|tvshow/70523"), (e) => e.code === "not_found" && /busca el título de nuevo/i.test(e.userMessage));
  } finally {
    delete pages[`${ACAPI}/episodes?post_id=41641`];
  }
});

test("allcalidad refs: posts, episodes with their TMDB ids, and the TMDB refs saved before 0.6.2", () => {
  assert.deepEqual(plugin.parseAcRef("ac|movies/27621/matrix-1999"), { type: "movies", post: "27621", slug: "matrix-1999" });
  assert.deepEqual(plugin.parseAcRef("ac|ep/41663/70523/1/1#lat/vimeos"), { ep: true, post: "41663", tmdb: "70523", season: "1", episode: "1" });
  assert.deepEqual(plugin.parseAcRef("ac|tvshow/70523/1/2"), { legacy: true, kind: "tvshow", tmdb: "70523", season: "1", episode: "2" });
  assert.equal(plugin.parseAcRef("ac|nope/1"), null);
  assert.equal(plugin.videoappUrl("movie", "603"), "https://videoapp.zip/e/movie/603");
  assert.equal(plugin.videoappUrl("tv", "70523", "1", "2"), "https://videoapp.zip/e/tv/70523/1/2");
  assert.equal(plugin.videoappUrl("tv", "70523"), "");
  assert.deepEqual(plugin.acServers(JSON.parse(fixture("ac2-player-27621.json")).data).map((f) => [plugin.langOf(f.lang), f.server]),
    [["lat", "vimeos"], ["lat", "goodstream"], ["lat", "hlswish"], ["lat", "voe"], ["lat", "filemoon"], ["lat", "videoapp"]]);
});

test("allcalidad resolve reads vimeos' own page: no hidden browser, the player gets the page's User-Agent and Referer", async () => {
  pages[`${ACAPI}/player?post_id=41663&_any=1`] = fixture("ac2-player-41663.json");
  pages["https://vimeos.net/embed-aeyyn4wosizi.html"] = fixture("emb-vimeos.html");
  captured.length = 0;
  try {
    const st = await plugin.resolve("ac|ep/41663/70523/1/1");
    assert.deepEqual(captured, []);
    assert.match(st.url, /^https:\/\/s10\.vimeos\.net\/hls2\/.*master\.m3u8\?/);
    assert.deepEqual(st.headers, { "User-Agent": plugin.UA, Referer: "https://vimeos.net/", Origin: "https://vimeos.net" });
    assert.equal(st.label, "Latino · Vimeos");
    // The other copy (videoapp, built from the episode's TMDB ids) is offered lazily.
    assert.deepEqual(st.alternatives, [{ label: "Latino · Videoapp", ref: "ac|ep/41663/70523/1/1#lat/videoapp" }]);
    assert.ok(ttls.get("stream:ac|ep/41663/70523/1/1") <= 10 * 60 * 1000); // no expiry in the URL: kept briefly
  } finally {
    delete pages[`${ACAPI}/player?post_id=41663&_any=1`];
    delete pages["https://vimeos.net/embed-aeyyn4wosizi.html"];
  }
});

test("search: one site down is just fewer results; every site down is a sentence, not 'no results'", async () => {
  const saved = kino.fetch;
  try {
    kino.fetch = async (url) => (url.startsWith("https://serieskao.top") ? saved(url) : Promise.reject(Object.assign(new Error("timeout"), { code: "timeout" })));
    assert.ok((await plugin.search({ q: "dark" })).length > 0);
    kino.fetch = async () => { throw Object.assign(new Error("timeout"), { code: "timeout" }); };
    await assert.rejects(plugin.search({ q: "dark" }), (e) => e.code === "unavailable" && /no están respondiendo/.test(e.userMessage));
  } finally {
    kino.fetch = saved;
  }
});

test("resolve never starts a page it has no time left for", async () => {
  pages["https://serieskao.top/vidurl/tt5753856-1x01/"] = fixture("sk-vidurl-embed69.html");
  const realNow = Date.now;
  let fake = realNow();
  Date.now = () => fake;
  captured.length = 0;
  // Each capture "takes" 40 s of the clock and fails: the second page has ~28 s, the third would have none.
  captureAnswer = async (url, opts) => { fake += 40000; throw Object.assign(new Error(`timeout ${opts.timeoutMs}`), { code: "timeout" }); };
  try {
    await assert.rejects(plugin.resolve("sk|/serie/dark/temporada/1/capitulo/1"), (e) => e.code === "not_found");
    assert.equal(captured.length, 2);
  } finally {
    Date.now = realNow;
    delete pages["https://serieskao.top/vidurl/tt5753856-1x01/"];
  }
});

const ACG = `${ACAPI}/listing?tax=genres&term=accion&page=1&post_type=movies,tvshows,animes&posts_per_page=24`;

test("Usar SeriesKao / Usar AllCalidad: a switched-off site is never asked", async () => {
  const asked = [];
  const saved = kino.fetch;
  kino.fetch = async (url, o) => { asked.push(new URL(url).host); return saved(url, o); };
  try {
    config.useSerieskao = false;
    assert.deepEqual(plugin.activeSites(), ["ac"]);
    await plugin.search({ q: "dark" }).catch(() => []);
    assert.ok(asked.length > 0 && asked.every((h) => h === "allcalidad.re"));
    config.useSerieskao = true;
    config.useAllcalidad = false;
    asked.length = 0;
    await plugin.search({ q: "dark" });
    assert.ok(asked.every((h) => h === "serieskao.top"));
  } finally {
    kino.fetch = saved;
  }
});

test("search tries TMDB's original title and the alternative titles when the first ones find nothing", async () => {
  const asked = [];
  const saved = kino.fetch;
  kino.fetch = async (url, o) => { asked.push(url); return saved(url, o); };
  // The site answers an empty results page for the Spanish title, as serieskao does.
  pages["https://serieskao.top/search?s=Oscuro"] = "<html><body><h1>Resultados para: Oscuro</h1></body></html>";
  try {
    config.useAllcalidad = false;
    await plugin.search({ q: "Oscuro", originalTitle: "dark", altTitles: ["Dunkel"] });
    assert.deepEqual(asked.map((u) => decodeURIComponent(new URL(u).search)), ["?s=Oscuro", "?s=dark"]);
  } finally {
    delete pages["https://serieskao.top/search?s=Oscuro"];
    kino.fetch = saved;
  }
});

test("Probar primero puts the chosen server ahead of the remembered one, never ahead of the language", () => {
  assert.equal(plugin.rankServers(mixed, "lat", "streamwish", "vidhide")[0].url, "https://morencius.com/embed/a");
  assert.equal(plugin.rankServers(mixed, "esp", "", "vidhide")[0].url, "https://voe.sx/e/esp");
  assert.equal(plugin.rankServers(mixed, "lat", "", "auto")[0].url, "https://hglink.to/e/lat");
});

test("Recordar enlaces off: nothing cached, every play captures", async () => {
  pages["https://serieskao.top/vidurl/tt5753856-1x01/"] = fixture("sk-vidurl-embed69.html");
  config.keepLinks = false;
  captured.length = 0;
  captureAnswer = async () => ({ media: [{ url: "https://cdn.example/master.m3u8", headers: {} }], subtitles: [], finalUrl: "" });
  try {
    await plugin.resolve("sk|/serie/dark/temporada/1/capitulo/1");
    await plugin.resolve("sk|/serie/dark/temporada/1/capitulo/1");
    assert.equal(captured.length, 2);
    assert.ok(![...store.keys()].some((k) => k.startsWith("stream:")));
  } finally {
    delete pages["https://serieskao.top/vidurl/tt5753856-1x01/"];
  }
});

test("categories: one tile per genre an active site has, each opening a genre browse", async () => {
  const all = await plugin.categories();
  assert.equal(all.length, 22);
  assert.deepEqual(all[0], { id: "genre-accion", title: "Acción", ref: "genre|accion" });
  config.useAllcalidad = false;
  const skOnly = await plugin.categories();
  assert.ok(skOnly.some((t) => t.ref === "genre|dorama"));
  assert.ok(!skOnly.some((t) => t.ref === "genre|musica"));
});

test("a genre page interleaves both sites; one site missing still pages; page 1 keeps the genre's art", async () => {
  pages["https://serieskao.top/generos/accion?page=1"] = fixture("sk-generos-accion-2.html");
  pages[ACG] = fixture("ac2-genre-drama-1.json");
  try {
    const p = await plugin.browse("genre|accion", null);
    assert.equal(p.next, "2");
    assert.deepEqual(p.items.slice(0, 4).map((i) => i.ref.slice(0, 3)), ["sk|", "ac|", "sk|", "ac|"]);
    assert.match(JSON.parse(store.get("art2:accion")).art, /^https:\/\/allcalidad\.re\/wp-content\/uploads\/backdrops\//);
    delete pages[ACG];
    const skOnly = await plugin.browse("genre|accion", null);
    assert.ok(skOnly.items.length > 0 && skOnly.items.every((i) => i.ref.startsWith("sk|")));
    await assert.rejects(plugin.browse("genre|nope", null), (e) => e.code === "not_found");
  } finally {
    delete pages["https://serieskao.top/generos/accion?page=1"];
    delete pages[ACG];
  }
});

test("section: four tabs, the chosen one answered, an unknown tab falls back to Series; nothing at all is a sentence", async () => {
  pages["https://serieskao.top/peliculas?page=1"] = fixture("sk-search-dark.html");
  pages["https://serieskao.top/series?page=1"] = fixture("sk-search-dark.html");
  try {
    const sec = await plugin.section({ tab: "peliculas" });
    assert.deepEqual(sec.tabs.map((t) => t.id), ["series", "anime", "peliculas", "generos"]);
    assert.equal(sec.tab, "peliculas");
    assert.equal(sec.rows[0].id, "sk-pelicula");
    assert.equal((await plugin.section({ tab: "x" })).tab, "series");
  } finally {
    delete pages["https://serieskao.top/peliculas?page=1"];
    delete pages["https://serieskao.top/series?page=1"];
  }
  store.clear();
  await assert.rejects(plugin.section({ tab: "anime" }), (e) => e.code === "unavailable" && /no están respondiendo/.test(e.userMessage));
});

test("settingsStatus names the active sites, the language and the server that last worked", async () => {
  assert.equal((await plugin.settingsStatus()).state, "2 sitios activos (SeriesKao, AllCalidad) · Latino · todavía sin reproducir nada");
  store.set("server:sk", JSON.stringify({ server: "streamwish" }));
  config.useAllcalidad = false;
  config.lang = "esp";
  assert.equal((await plugin.settingsStatus()).state, "1 sitio activo (SeriesKao) · Castellano · último servidor que funcionó: Streamwish");
});

test("Revisar sitios says which site answers; Borrar enlaces guardados empties the cache and the memory", async () => {
  pages["https://serieskao.top/"] = fixture("sk-home.html");
  try {
    const r = await plugin.action("check");
    assert.match(r.message, /^SeriesKao: responde \(\d+ ms\) · AllCalidad: no responde · SoloLatino: no responde$/);
    assert.equal(r.refresh, true);
  } finally {
    delete pages["https://serieskao.top/"];
  }
  store.set("stream:a", "{}"); store.set("stream:b", "{}"); store.set("server:sk", "{}"); store.set("imdb:tt1", "{}");
  assert.match((await plugin.action("clear")).message, /2 enlaces guardados/);
  assert.deepEqual([...store.keys()], ["imdb:tt1"]);
  assert.equal((await plugin.action("clear")).message, "No había enlaces guardados.");
  await assert.rejects(plugin.action("nope"), (e) => e.code === "not_found");
});

test("validateSettings refuses switching every site off, and only that", async () => {
  assert.deepEqual(await plugin.validateSettings({ useSerieskao: false, useAllcalidad: false, useSololatino: false }), { useSololatino: "Deja al menos un sitio activo" });
  assert.equal(await plugin.validateSettings({ useSerieskao: false, useAllcalidad: false }), null); // SoloLatino still on
  assert.equal(await plugin.validateSettings({ useSerieskao: false, useAllcalidad: true }), null);
  assert.equal(await plugin.validateSettings({}), null);
});

test("the playing copy is labelled; every other server and language is a lazy { label, ref } alternative", () => {
  const playing = { lang: "LAT", server: "streamwish", url: "https://hglink.to/e/lat" };
  assert.equal(plugin.copyLabel(playing), "Latino · Streamwish");
  const alts = plugin.alternativesOf(
    [{ url: "https://cdn.example/index-f2.m3u8", mime: "application/vnd.apple.mpegurl", headers: { Referer: "r" } }],
    playing, mixed, "sk|/serie/dark/temporada/1/capitulo/1");
  assert.deepEqual(alts[0], { url: "https://cdn.example/index-f2.m3u8", headers: { Referer: "r" }, mime: "application/vnd.apple.mpegurl", label: "Latino · Streamwish (otra lista)" });
  assert.deepEqual(alts.slice(1), [
    { label: "Latino · Vidhide", ref: "sk|/serie/dark/temporada/1/capitulo/1#lat/vidhide" },
    { label: "Castellano · Voe", ref: "sk|/serie/dark/temporada/1/capitulo/1#esp/voe" },
    { label: "Subtitulado · Streamwish", ref: "sk|/serie/dark/temporada/1/capitulo/1#sub/streamwish" },
  ]);
  const many = Array.from({ length: 12 }, (_, i) => ({ lang: "LAT", server: `s${i}`, url: `https://h${i}.example/e` }));
  assert.equal(plugin.alternativesOf([], playing, many, "r").length, 5);
  // On a device without a usable hidden browser only the servers whose page carries its playlist are offered.
  assert.deepEqual(plugin.alternativesOf([], playing, mixed, "r", new Set(), { needBrowser: true }).map((a) => a.ref), ["r#lat/vidhide", "r#sub/streamwish"]);
});

test("resolve: the stream names its copy and offers the servers it did not try, not the ones that failed", async () => {
  pages["https://serieskao.top/vidurl/tt5753856-1x01/"] = fixture("sk-vidurl-embed69.html");
  captured.length = 0;
  let n = 0;
  captureAnswer = async () => {
    if (n++ === 0) throw Object.assign(new Error("human check"), { code: "blocked" });
    return { media: [{ url: "https://cdn.example/master.m3u8", headers: {} }], subtitles: [], finalUrl: "" };
  };
  try {
    const st = await plugin.resolve("sk|/serie/dark/temporada/1/capitulo/1");
    assert.equal(st.label, "Latino · Vidhide");
    // hglink failed, vidhide plays: only voe is left to offer.
    assert.deepEqual(st.alternatives, [{ label: "Latino · Voe", ref: "sk|/serie/dark/temporada/1/capitulo/1#lat/voe" }]);
    const lazy = await plugin.resolve("sk|/serie/dark/temporada/1/capitulo/1#lat/vidhide");
    assert.equal(lazy.label, "Latino · Vidhide");
    assert.equal(lazy.alternatives, undefined);
  } finally {
    delete pages["https://serieskao.top/vidurl/tt5753856-1x01/"];
  }
});

test("scopedSearch: a catalog row keeps its site and kind; a genre page lets Kino filter (null)", async () => {
  config.useAllcalidad = false;
  const series = await plugin.search({ q: "dark", within: "row|sk|serie" });
  assert.ok(series.length > 0 && series.every((i) => i.ref.startsWith("sk|/serie/")));
  const anime = await plugin.search({ q: "dark", within: "row|sk|anime" });
  assert.ok(anime.length > 0 && anime.every((i) => i.ref.startsWith("sk|/anime/")));
  assert.equal(await plugin.search({ q: "dark", within: "genre|terror" }), null);
  assert.equal(await plugin.search({ q: "dark", within: "row|ac|movie" }), null); // switched off
  assert.equal(plugin.scopeOf("row|zz|x"), null);
});

test("telemetry reports carry only our own codes: site down, Cloudflare, capture timeout per server, embed69 changed", async () => {
  const saved = kino.fetch;
  try {
    kino.fetch = async () => { throw Object.assign(new Error("timeout"), { code: "timeout" }); };
    await plugin.episodes("sk|/serie/dark").catch(() => {});
    assert.deepEqual(reports.pop().slice(0, 4), ["maraton:site", "down", "site=sk", "code=timeout"]);
    kino.fetch = async () => ({ ok: true, status: 200, text: () => "<title>Just a moment...</title>" });
    await plugin.episodes("sk|/serie/dark").catch(() => {});
    assert.deepEqual(reports.pop(), ["maraton:site", "cloudflare", "site=sk"]);
    store.clear(); // the site rested after those failures
    kino.fetch = async (url) => (url.includes("/vidurl/") ? { ok: true, status: 200, text: () => "<html>changed</html>" } : saved(url));
    captureAnswer = async () => { throw Object.assign(new Error("timeout"), { code: "timeout" }); };
    await plugin.resolve("sk|/serie/dark/temporada/1/capitulo/1").catch(() => {});
    assert.ok(reports.some((r) => r[0] === "maraton:embed69" && r[1] === "no_list" && r[2] === "site=sk"));
    assert.ok(reports.some((r) => r[0] === "maraton:capture" && r[1] === "timeout" && r[2] === "server=episode_page"));
    assert.ok(reports.some((r) => r[0] === "maraton:resolve" && r[1] === "timeout" && r[2] === "site=sk"));
    // Nothing reported carries a URL, a host or a title.
    for (const r of reports) for (const c of r) assert.doesNotMatch(String(c), /https?:|\.top|\.net|dark/i);
  } finally {
    kino.fetch = saved;
  }
});

test("a capture timeout on a known server reports that server's name and the window it had", async () => {
  pages["https://serieskao.top/vidurl/tt5753856-1x01/"] = fixture("sk-vidurl-embed69.html");
  captureAnswer = async () => { throw Object.assign(new Error("timeout"), { code: "timeout" }); };
  try {
    await plugin.resolve("sk|/serie/dark/temporada/1/capitulo/1").catch(() => {});
    const caps = reports.filter((r) => r[0] === "maraton:capture");
    assert.deepEqual([...new Set(caps.map((r) => r[2]))], ["server=streamwish", "server=vidhide", "server=voe"]);
    assert.ok(caps.every((r) => /^ms=\d+$/.test(r[3]) && /^win=\d+$/.test(r[4])));
  } finally {
    delete pages["https://serieskao.top/vidurl/tt5753856-1x01/"];
  }
});

test("richer cards: serieskao ratings, allcalidad runtime/rating/genres, series genres from the page", async () => {
  config.useAllcalidad = false;
  const dark = (await plugin.search({ q: "dark" })).find((i) => i.ref === "sk|/serie/dark");
  assert.equal(dark.rating, 7.7);
  const matrix = plugin.acItem(JSON.parse(fixture("ac2-single-matrix.json")).data);
  assert.equal(matrix.runtimeMinutes, 131);
  assert.equal(matrix.rating, 8.2);
  assert.deepEqual(matrix.genres, ["Acción", "Ciencia ficción"]);
  assert.equal(matrix.originalTitle, "The Matrix");
  assert.equal(plugin.acItem({ type: "tvshows", _id: 1, slug: "s", title: "S", runtime: "50" }).runtimeMinutes, undefined);
  const ep = await plugin.episodes("sk|/serie/dark");
  assert.deepEqual(ep.series.genres, ["Crimen", "Drama", "Sci-Fi & Fantasy", "Misterio"]);
});

test("ads are recognised by real-shaped URLs; segment CDNs and film hosts are not", () => {
  for (const u of [
    "https://cdn.jugabet.cl/promo/preroll-15s.mp4",
    "https://static.casinoplay.example/video/intro.mp4",
    "https://imasdk.googleapis.com/js/sdkloader/vast.mp4",
    "https://s.magsrv.com/v1/vast.php?idzone=123",
    "https://media.example/ads/prerolls/300x250.mp4",
    "https://bet365.example/stream/a.mp4",
  ]) assert.ok(plugin.looksLikeAd(u), u);
  for (const u of [
    "https://audinifer.com/stream/680pItk3zi6zc5qNm4WU-Q/kjhhiuahiuhgihdf/1791135524/63911296/master.m3u8",
    "https://p16-ad-site-sign-sg.tiktokcdn.com/ad-site-i18n-sg/202605045d0d9ff77d408f9c468b94d4",
    "https://hls2.goodstream.one/hls2/01/00123/abc_n/master.m3u8?t=x",
    "https://vimeos.net/hls/xyz/index-v1-a1.m3u8",
  ]) assert.ok(!plugin.looksLikeAd(u), u);
});

test("filmMedia: a manifest drops every mp4 and every ad; only-mp4 captures drop short ones by HEAD", async () => {
  const ad = { url: "https://cdn.jugabet.cl/promo/preroll.mp4", headers: {} };
  const m3u8 = { url: "https://cdn.example/hls/x/master.m3u8", mime: "application/vnd.apple.mpegurl", headers: { Cookie: "a=b" } };
  const mp4 = { url: "https://files.example/v/film.mp4", headers: {} };
  assert.deepEqual(await plugin.filmMedia([ad, mp4, m3u8]), [m3u8]);
  const saved = kino.fetch;
  try {
    kino.fetch = async (url, o) => ({ ok: true, status: 200, headers: { "content-length": url.includes("short") ? String(12 * 1048576) : String(900 * 1048576) }, text: () => "" });
    const short = { url: "https://files.example/v/short.mp4", headers: {} };
    assert.deepEqual(await plugin.filmMedia([short, mp4]), [mp4]);
    kino.fetch = async () => { throw Object.assign(new Error("host"), { code: "host_not_allowed" }); };
    assert.deepEqual(await plugin.filmMedia([short]), [short]); // cannot check: kept
    assert.deepEqual(await plugin.filmMedia([ad]), []);
  } finally {
    kino.fetch = saved;
  }
});

test("Matrix as measured: a capture of only a casino preroll is a failure, the next server plays, no mp4 offered", async () => {
  pages[`${ACAPI}/player?post_id=27621&_any=1`] = JSON.stringify({ error: false, message: "", data: { embeds: [
    { lang: "Latino", quality: "Full HD", url: "https://vimeos.net/embed-n1heuxm4500w.html" },
    { lang: "Latino", quality: "Full HD", url: "https://goodstream.one/embed-vqp2pcmwqqmb.html" },
  ] } });
  captured.length = 0;
  // Neither page carries its playlist here (404): the hidden browser. vimeos hands over only the casino preroll.
  captureAnswer = async (url) => (url.includes("vimeos")
    ? { media: [{ url: "https://cdn.jugabet.cl/promo/preroll.mp4", headers: {} }], subtitles: [], finalUrl: "" }
    : { media: [{ url: "https://hls2.goodstream.one/hls2/01/x/master.m3u8", headers: { Referer: "https://goodstream.one/", Cookie: "c=1", "User-Agent": "WebView UA" } },
      { url: "https://cdn.jugabet.cl/promo/preroll.mp4", headers: {} }], subtitles: [], finalUrl: "" });
  try {
    const st = await plugin.resolve("ac|movies/27621/matrix-1999");
    assert.equal(st.url, "https://hls2.goodstream.one/hls2/01/x/master.m3u8");
    // The capture's headers passed exactly as the page sent them.
    assert.deepEqual(st.headers, { Referer: "https://goodstream.one/", Cookie: "c=1", "User-Agent": "WebView UA" });
    assert.ok(ttls.get("stream:ac|movies/27621/matrix-1999") <= 10 * 60 * 1000); // cookie-bound: kept briefly
    assert.ok(!(st.alternatives || []).some((a) => a.url && /\.mp4/.test(a.url)));
    assert.ok(plugin.failedServers("ac").has("vimeos"));
    assert.ok(reports.some((r) => r[1] === "only_ads"));
  } finally {
    delete pages[`${ACAPI}/player?post_id=27621&_any=1`];
  }
});

test("a server that failed lately goes to the back and out of the lazy copies; a success clears it", async () => {
  pages["https://serieskao.top/vidurl/tt5753856-1x01/"] = fixture("sk-vidurl-embed69.html");
  captured.length = 0;
  captureAnswer = async (url) => {
    if (url.includes("hglink")) throw Object.assign(new Error("timeout"), { code: "timeout" });
    return { media: [{ url: "https://cdn.example/master.m3u8", headers: {} }], subtitles: [], finalUrl: "" };
  };
  try {
    await plugin.resolve("sk|/serie/dark/temporada/1/capitulo/1");
    assert.ok(plugin.failedServers("sk").has("streamwish"));
    store.delete("stream:sk|/serie/dark/temporada/1/capitulo/1");
    store.delete("server:sk"); // only the failure memory may move streamwish back
    captured.length = 0;
    const st = await plugin.resolve("sk|/serie/dark/temporada/1/capitulo/1");
    assert.equal(new URL(captured[0]).host, "morencius.com"); // streamwish now last
    assert.ok(!(st.alternatives || []).some((a) => /streamwish/i.test(a.label || "")));
    assert.ok(!plugin.failedServers("sk").has("vidhide"));
    assert.deepEqual(plugin.lastIfFailed(mixed, new Set(["streamwish"])).map((f) => f.server), ["vidhide", "voe", "streamwish", "streamwish"]);
  } finally {
    delete pages["https://serieskao.top/vidurl/tt5753856-1x01/"];
  }
});

test("at most five lazy copies, best first, each server once", () => {
  const many = Array.from({ length: 7 }, (_, i) => ({ lang: "LAT", server: `s${i}`, url: `https://h${i}.example/e` }));
  const alts = plugin.alternativesOf([], { lang: "LAT", server: "x", url: "https://p.example/e" }, [...many, many[0]], "r");
  assert.deepEqual(alts.map((a) => a.ref), ["r#lat/s0", "r#lat/s1", "r#lat/s2", "r#lat/s3", "r#lat/s4"]);
});

test("Voe goes after the other known servers by default (its ALTCHA check blocks the capture)", () => {
  const lat = [
    { lang: "LAT", server: "voe", url: "https://voe.sx/e/1" },
    { lang: "LAT", server: "vidhide", url: "https://morencius.com/embed/1" },
    { lang: "LAT", server: "streamwish", url: "https://hglink.to/e/1" },
  ];
  assert.deepEqual(plugin.rankServers(lat).map((f) => f.server), ["streamwish", "vidhide", "voe"]);
});

test("a blocked capture (human check) is a server failure, remembered and reported", async () => {
  pages["https://serieskao.top/vidurl/tt5753856-1x01/"] = fixture("sk-vidurl-embed69.html");
  captureAnswer = async () => { throw Object.assign(new Error("human check"), { code: "blocked" }); };
  try {
    await plugin.resolve("sk|/serie/dark/temporada/1/capitulo/1").catch(() => {});
    assert.ok(plugin.failedServers("sk").has("voe"));
    assert.ok(reports.some((r) => r[0] === "maraton:capture" && r[1] === "blocked" && r[2] === "server=voe"));
  } finally {
    delete pages["https://serieskao.top/vidurl/tt5753856-1x01/"];
  }
});

test("allcalidad: vimeos before goodstream by default (Probar primero still wins); old TMDB refs play through videoapp", async () => {
  const list = [
    { lang: "Latino", server: "goodstream", url: "https://goodstream.one/embed-b.html" },
    { lang: "Latino", server: "vimeos", url: "https://vimeos.net/embed-a.html" },
  ];
  assert.deepEqual(plugin.rankServers(list).map((f) => f.server), ["vimeos", "goodstream"]);
  assert.deepEqual(plugin.rankServers(list, "lat", "", "goodstream").map((f) => f.server), ["goodstream", "vimeos"]);
  // A movie saved before 0.6.2 (TMDB id 603): videoapp frames a vimeos page, whose playlist is read.
  pages["https://videoapp.zip/e/movie/603"] = fixture("videoapp-movie-603.html");
  pages["https://vimeos.net/embed-n1heuxm4500w.html"] = fixture("emb-vimeos.html");
  captured.length = 0;
  try {
    const st = await plugin.resolve("ac|movie/603");
    assert.deepEqual(captured, []);
    assert.match(st.url, /vimeos\.net\/hls2\//);
    assert.equal(st.headers.Referer, "https://vimeos.net/");
  } finally {
    delete pages["https://videoapp.zip/e/movie/603"];
    delete pages["https://vimeos.net/embed-n1heuxm4500w.html"];
  }
});

test("hero: a featured title's backdrop first, else a poster, else no hero at all", () => {
  const withBackdrop = [{ items: [{ title: "A", poster: "https://p/a.jpg" }, { title: "B", backdrop: "https://b/b.jpg", overview: "Sinopsis B" }] }];
  assert.deepEqual(plugin.heroOf(withBackdrop), { title: "B", text: "Sinopsis B", image: "https://b/b.jpg" });
  const posterOnly = plugin.heroOf([{ items: [{ title: "A", poster: "https://p/a.jpg" }] }]);
  assert.equal(posterOnly.image, "https://p/a.jpg");
  assert.match(posterOnly.text, /latino/);
  config.lang = "sub";
  assert.match(plugin.heroOf([{ items: [{ title: "A", poster: "https://p/a.jpg" }] }]).text, /subtitulada/);
  assert.equal(plugin.heroOf([{ items: [{ title: "A" }] }]), null);
  assert.equal(plugin.heroOf([]), null);
});

// ---------- SoloLatino (apiVersion 7) ----------

const SLB = "https://sololatino.net";
const NARUTO_SEASONS = [{ season: 0, count: 2 }, { season: 1, count: 52 }, { season: 2, count: 52 }, { season: 3, count: 54 }, { season: 4, count: 62 }];

test("sololatino cards: series, anime (badge) and movies from the real catalog pages", () => {
  const series = plugin.slCards(fixture("sl-series.html"));
  assert.ok(series.length >= 30);
  assert.ok(series.every((i) => i.ref.startsWith("sl|/serie/") && i.kind === "series"));
  assert.ok(series.some((i) => i.year === "2026"));
  const anime = plugin.slCards(fixture("sl-animes.html"));
  assert.ok(anime.length >= 30 && anime.every((i) => i.genres && i.genres[0] === "Anime"));
  const movies = plugin.slCards(fixture("sl-peliculas-2.html"));
  assert.ok(movies.length >= 30 && movies.every((i) => i.kind === "movie" && i.ref.startsWith("sl|/pelicula/")));
});

test("sololatino search: the suggest API, cached per text; a challenge on it falls back to the page, never for short text", async () => {
  config.useSololatino = true; config.useSerieskao = false; config.useAllcalidad = false;
  const asked = [];
  const saved = kino.fetch;
  kino.fetch = async (url, o) => {
    asked.push(url);
    if (url.startsWith(`${SLB}/api/search/suggest`)) return { ok: true, status: 200, text: () => "", json: () => JSON.parse(fixture("sl-suggest-dark.json")) };
    return saved(url, o);
  };
  try {
    const found = await plugin.search({ q: "dark" });
    assert.ok(found.some((i) => i.ref === "sl|/serie/dark" && i.year === "2017"));
    assert.ok(found.some((i) => i.kind === "movie"));
    await plugin.search({ q: "dark" });
    assert.equal(asked.filter((u) => u.includes("suggest")).length, 1); // cached
  } finally {
    kino.fetch = saved;
  }
});

function challengeFetch() {
  return async (url) => ({ ok: false, status: 403, text: () => fixture("sl-challenge.html"), json: () => ({}) });
}

test("a Cloudflare challenge is read through the hidden browser, cached 5 min; Home rows never open it", async () => {
  const saved = kino.fetch;
  const pagesRead = [];
  kino.fetch = challengeFetch();
  kino.browser.page = async (url, o) => { pagesRead.push([url, o.timeoutMs]); return { html: fixture("sl-series.html"), finalUrl: url, status: 200, truncated: false }; };
  try {
    const html = await plugin.slRead("/series?page=1");
    assert.match(html, /class="card"/);
    await plugin.slRead("/series?page=1");
    assert.equal(pagesRead.length, 1);
    assert.equal(pagesRead[0][1], 10000);
    // A catalog page (~230 KB) stays in the sandbox's memory, not in kino.storage.
    assert.equal(store.has("slpage:/series?page=1"), false);
    await assert.rejects(plugin.slRead("/animes?page=1", { allowPage: false }), (e) => e.code === "unavailable");
    assert.equal(pagesRead.length, 1);
    assert.ok(reports.some((r) => r[1] === "cloudflare" && r[2] === "site=sl"));
  } finally {
    kino.fetch = saved;
    delete kino.browser.page;
  }
});

test("blocked or timeout from the page read pauses sololatino 15 min; the other sites keep working", async () => {
  const saved = kino.fetch;
  let pageCalls = 0;
  kino.fetch = async (url, o) => (url.startsWith(SLB) ? challengeFetch()(url) : saved(url, o));
  kino.browser.page = async () => { pageCalls++; throw Object.assign(new Error("human check"), { code: "blocked" }); };
  try {
    await assert.rejects(plugin.slRead("/serie/dark"), (e) => e.code === "unavailable" && /SoloLatino no está dejando entrar/.test(e.userMessage));
    assert.ok(plugin.slIsDown());
    assert.equal(ttls.get("sitedown:sl"), 15 * 60 * 1000);
    await assert.rejects(plugin.slRead("/serie/naruto"));
    assert.equal(pageCalls, 1); // paused: no second page read
    config.useSololatino = true; config.useAllcalidad = false;
    const found = await plugin.search({ q: "dark" });
    assert.ok(found.length > 0 && found.every((i) => i.ref.startsWith("sk|")));
    assert.ok(reports.some((r) => r[0] === "maraton:page" && r[1] === "blocked"));
  } finally {
    kino.fetch = saved;
    delete kino.browser.page;
  }
});

test("numbering: Naruto's absolute numbering is detected and remapped onto TMDB's seasons (specials skipped)", () => {
  const list = plugin.slEpisodes(fixture("sl-serie-naruto.html"), "/serie/naruto");
  assert.equal(list.length, 219);
  assert.equal(list[0].still.startsWith("https://image.tmdb.org/"), true);
  assert.equal(list[0].title, "Entra en escena Naruto Uzumaki");
  assert.equal(plugin.numberingStyle(list), "absolute");
  assert.deepEqual(plugin.remapAbsolute(1, NARUTO_SEASONS), [1, 1]);
  assert.deepEqual(plugin.remapAbsolute(53, NARUTO_SEASONS), [2, 1]);
  assert.deepEqual(plugin.remapAbsolute(220, NARUTO_SEASONS), [4, 62]);
  assert.equal(plugin.remapAbsolute(221, NARUTO_SEASONS), null);
  assert.equal(plugin.numberingStyle([{ season: 1, number: 1 }, { season: 2, number: 1 }]), "relative");
});

test("sololatino episodes: absolute shows get TMDB's seasons through allcalidad's episodes; Dark stays relative", async () => {
  pages[`${SLB}/serie/naruto`] = fixture("sl-serie-naruto.html");
  pages[`${SLB}/serie/dark`] = fixture("sl-serie-dark.html");
  const search = `${ACAPI}/search?post_type=movies,tvshows,animes&query=Naruto&posts_per_page=16`;
  pages[search] = JSON.stringify({ error: false, message: "", data: { posts: [
    { _id: 22128, type: "animes", slug: "naruto-shippuden-2007", title: "Naruto Shippuden (2007)" },
    { _id: 4993, type: "animes", slug: "naruto-2002", title: "Naruto (2002)" },
  ] } });
  const eps = (seasons) => JSON.stringify({ error: false, message: "", data: seasons.flatMap(({ season, count }) =>
    Array.from({ length: count }, (_, i) => ({ _id: season * 1000 + i, season_number: season, episode_number: i + 1 }))) });
  pages[`${ACAPI}/episodes?post_id=4993`] = eps(NARUTO_SEASONS);
  try {
    const n = await plugin.episodes("sl|/serie/naruto");
    assert.deepEqual(n.series.ids, { imdb: "tt0409591" });
    const e53 = n.episodes.find((e) => e.ref.endsWith("/temporada-2/episodio-53"));
    assert.deepEqual([e53.season, e53.number], [2, 1]);
    // allcalidad listing only some seasons: no remap, the site's numbers stay.
    store.clear();
    pages[`${ACAPI}/episodes?post_id=4993`] = eps([{ season: 1, count: 52 }]);
    const partial = await plugin.episodes("sl|/serie/naruto");
    assert.equal(partial.episodes.length, 219);
    assert.ok(partial.episodes.some((e) => e.ref.endsWith("/temporada-2/episodio-53") && e.season === 2 && e.number === 53));
    const d = await plugin.episodes("sl|/serie/dark");
    assert.equal(d.episodes[0].ref, "sl|/serie/dark/temporada-1/episodio-1");
    assert.equal(plugin.numberingStyle(d.episodes), "relative");
  } finally {
    for (const k of [`${SLB}/serie/naruto`, `${SLB}/serie/dark`, search, `${ACAPI}/episodes?post_id=4993`]) delete pages[k];
  }
});

test("sololatino player tokens per language, resolved through Sanctum, embed69 decrypted, then captured", async () => {
  assert.deepEqual(plugin.slTokens(fixture("sl-ep-dark-1x01.html")).map((t) => [t.lang, t.label]), [["LAT", "premium"], ["LAT", "uqload"]]);
  const saved = kino.fetch;
  const posted = [];
  kino.fetch = async (url, o = {}) => {
    if (url === `${SLB}/serie/dark/temporada-1/episodio-1`) return { ok: true, status: 200, text: () => fixture("sl-ep-dark-1x01.html") };
    if (url === `${SLB}/sanctum/csrf-cookie`) return { ok: true, status: 204, text: () => "" };
    if (url === `${SLB}/api/player-url`) {
      posted.push(o);
      const second = posted.length === 2;
      return { ok: true, status: 200, text: () => "", json: () => ({ url: second ? "https://embed69.org/f/tt5753856-1x01" : "https://player.pelisserieshoy.com/f/tt5753856-1x01", type: "iframe" }) };
    }
    if (url === "https://embed69.org/f/tt5753856-1x01") return { ok: true, status: 200, text: () => fixture("sl-embed69-f-dark-1x01.html") };
    return saved(url, o);
  };
  kino.cookies = { get: (u, name) => (name === "XSRF-TOKEN" ? "abc%3D" : null) };
  captured.length = 0;
  captureAnswer = async () => ({ media: [{ url: "https://cdn.example/master.m3u8", headers: {} }], subtitles: [], finalUrl: "" });
  try {
    const st = await plugin.resolve("sl|/serie/dark/temporada-1/episodio-1");
    assert.equal(st.url, "https://cdn.example/master.m3u8");
    assert.equal(posted[0].method, "POST");
    assert.equal(posted[0].headers["X-XSRF-TOKEN"], "abc=");
    assert.ok(posted[0].body.json.t.startsWith("eyJ"));
    assert.ok(captured.length > 0 && !captured[0].includes("pelisserieshoy"));
  } finally {
    kino.fetch = saved;
    delete kino.cookies;
  }
});

test("Usar SoloLatino off: sololatino is never read", async () => {
  const asked = [];
  const saved = kino.fetch;
  kino.fetch = async (url, o) => { asked.push(url); return saved(url, o); };
  try {
    config.useSololatino = false;
    await plugin.search({ q: "dark" }).catch(() => []);
    await plugin.home().catch(() => []);
    assert.ok(!asked.some((u) => u.startsWith(SLB)));
  } finally {
    kino.fetch = saved;
  }
});

// ---------- 0.6.2: reading embed pages, devices without a browser, deadlines, art ----------

const DARK_EP = "sk|/serie/dark/temporada/1/capitulo/1";
const withVidurl = async (fn) => {
  pages["https://serieskao.top/vidurl/tt5753856-1x01/"] = fixture("sk-vidurl-embed69.html");
  try { return await fn(); } finally { delete pages["https://serieskao.top/vidurl/tt5753856-1x01/"]; }
};
const shrink = (o) => { const saved = { ...plugin.LIMITS }; Object.assign(plugin.LIMITS, o); return () => Object.assign(plugin.LIMITS, saved); };
const never = () => new Promise(() => {});

test("embed pages: vidhide, streamwish (hlswish) and vimeos unpack their playlists; goodstream's is in the clear; a deleted file says so", () => {
  const vh = plugin.playlistsOf(fixture("emb-vidhide.html"), "https://morencius.com/embed/vr0ps5s4v6bw");
  assert.equal(vh.playlists[0], "https://morencius.com/stream/TOKEN/abc/1791203159/1/master.m3u8"); // hls4, relative to the page
  assert.equal(vh.playlists.length, 2); // hls4, hls2 (hls3 master.txt left out)
  assert.deepEqual(vh.subtitles.map((s) => s.label), ["Español"]);
  const sw = plugin.playlistsOf(fixture("emb-hlswish.html"), "https://hlswish.com/e/7vs4vkrnf7ma");
  assert.match(sw.playlists[0], /^https:\/\/hlswish\.com\/stream\//);
  assert.equal(plugin.playlistsOf(fixture("emb-vimeos.html"), "https://vimeos.net/e").playlists.length, 1);
  assert.match(plugin.playlistsOf(fixture("emb-goodstream.html"), "https://goodstream.one/e").playlists[0], /goodstream\.one\/hls2\/.*master\.m3u8/);
  const gone = plugin.playlistsOf(fixture("emb-gone.html"), "https://hlswish.com/e/x");
  assert.deepEqual([gone.playlists.length, gone.gone], [0, true]);
  assert.equal(plugin.unpackAll("<html>no packer</html>"), "");
  assert.deepEqual(plugin.extractedHeaders("https://vimeos.net/embed-a.html", "https://s10.vimeos.net/x.m3u8"), { "User-Agent": plugin.UA, Referer: "https://vimeos.net/", Origin: "https://vimeos.net" });
  assert.deepEqual(plugin.extractedHeaders("https://morencius.com/embed/a", "https://morencius.com/stream/x.m3u8"), { "User-Agent": plugin.UA, Referer: "https://morencius.com/" });
});

test("streamwish's hglink ids are read on hlswish: the page's playlist plays, the other two lists are concrete alternatives", async () => {
  pages["https://hlswish.com/e/7vs4vkrnf7ma"] = fixture("emb-hlswish.html");
  const saved = kino.fetch;
  const referers = [];
  kino.fetch = async (url, o = {}) => { if (url.startsWith("https://hlswish.com/")) referers.push(o.headers && o.headers.Referer); return saved(url, o); };
  captured.length = 0;
  try {
    const st = await withVidurl(() => plugin.resolve(DARK_EP));
    assert.deepEqual(captured, []);
    assert.match(st.url, /^https:\/\/hlswish\.com\/stream\//);
    assert.deepEqual(st.headers, { "User-Agent": plugin.UA, Referer: "https://hlswish.com/" });
    assert.equal(st.label, "Latino · Streamwish");
    assert.equal(st.expiresInSeconds > 0 || st.expiresInSeconds === undefined, true);
    const concrete = st.alternatives.filter((a) => a.url);
    assert.equal(concrete.length, 1);
    assert.ok(concrete.every((a) => a.headers["User-Agent"] === plugin.UA && a.label === "Latino · Streamwish (otra lista)"));
    assert.deepEqual(st.subtitles.map((s) => s.format), ["vtt"]);
    assert.deepEqual(referers, ["https://embed69.org/"]); // read as embed69 frames it
  } finally {
    kino.fetch = saved;
    delete pages["https://hlswish.com/e/7vs4vkrnf7ma"];
  }
});

test("a device without a usable browser: learned once, later plays go straight to page-read servers, never a capture", async () => {
  pages["https://morencius.com/embed/vr0ps5s4v6bw"] = fixture("emb-vidhide.html");
  let calls = 0;
  captureAnswer = async () => { calls++; throw Object.assign(new Error("none"), { code: "browser_unavailable" }); };
  try {
    // First play: streamwish's page is not readable here (404), its capture says browser_unavailable; vidhide's page plays.
    const st = await withVidurl(() => plugin.resolve(DARK_EP));
    assert.equal(calls, 1);
    assert.match(st.url, /morencius\.com\/stream\//);
    assert.ok(plugin.browserMissing());
    assert.ok(reports.some((r) => r[0] === "maraton:browser" && r[1] === "unavailable"));
    // Voe needs the hidden browser: not offered on this device.
    assert.ok(!(st.alternatives || []).some((a) => /Voe/.test(a.label || "")));
    store.delete(`stream:${DARK_EP}`);
    const again = await withVidurl(() => plugin.resolve(DARK_EP));
    assert.equal(calls, 1); // no capture tried again
    assert.match(again.url, /morencius\.com/);
  } finally {
    delete pages["https://morencius.com/embed/vr0ps5s4v6bw"];
  }
});

test("without a browser and only servers that need one, resolve says so; it never fails while a page-read server exists", async () => {
  store.set("nobrowser", JSON.stringify({ at: 1 }));
  captured.length = 0;
  pages[`${ACAPI}/player?post_id=1&_any=1`] = JSON.stringify({ error: false, message: "", data: { embeds: [{ lang: "Latino", url: "https://voe.sx/e/x" }, { lang: "Latino", url: "https://filemoon.sx/e/y" }] } });
  try {
    await assert.rejects(plugin.resolve("ac|movies/1/x"), (e) => e.code === "unavailable" && /navegador/.test(e.userMessage));
    assert.deepEqual(captured, []);
    assert.ok(reports.some((r) => r[0] === "maraton:resolve" && r[1] === "no_browser"));
  } finally {
    delete pages[`${ACAPI}/player?post_id=1&_any=1`];
  }
});

test("each server gets its own capture window; a page that gives up at once gets one second try; the budget is never exceeded", async () => {
  const windows = [];
  let n = 0;
  captureAnswer = async (url, opts) => {
    windows.push([new URL(url).host, opts.timeoutMs]);
    if (n++ === 0) throw Object.assign(new Error("timeout"), { code: "timeout" }); // gave up after 0 ms
    return { media: [{ url: "https://cdn.example/master.m3u8", headers: {} }], subtitles: [], finalUrl: "" };
  };
  const st = await withVidurl(() => plugin.resolve(DARK_EP));
  assert.equal(st.url, "https://cdn.example/master.m3u8");
  assert.deepEqual(windows, [["hglink.to", 22000], ["hglink.to", 22000]]);
  // Voe's window is shorter (it plays at once or shows its human check).
  assert.equal(plugin.captureWindow({ server: "voe", lang: "LAT", url: "https://voe.sx/e/1" }), 12000);
  // A clock where each capture takes 30 s: resolve stops opening pages once less than the minimum is left.
  const realNow = Date.now;
  let fake = realNow();
  Date.now = () => fake;
  windows.length = 0;
  captureAnswer = async (url, opts) => { windows.push(opts.timeoutMs); fake += 30000; throw Object.assign(new Error("timeout"), { code: "timeout" }); };
  try {
    store.clear();
    await withVidurl(() => plugin.resolve(DARK_EP)).catch(() => {});
    assert.ok(windows.length >= 2 && windows.length <= 3, String(windows));
    assert.ok(windows.every((w) => w >= plugin.LIMITS.minCaptureMs && w <= 25000));
    assert.ok(fake - realNow() <= plugin.LIMITS.resolveMs + 30000);
  } finally {
    Date.now = realNow;
  }
});

test("a refused stream (403 retry) is never reused and its server goes to the back for the new search", async () => {
  captureAnswer = async () => ({ media: [{ url: "https://cdn.example/master.m3u8", headers: { "User-Agent": "WV" } }], subtitles: [], finalUrl: "" });
  await withVidurl(async () => {
    const first = await plugin.resolve(DARK_EP);
    assert.equal(first.label, "Latino · Streamwish");
    captured.length = 0;
    const again = await plugin.resolve(DARK_EP, { retry: { reason: "http", status: 403, attempt: 1 } });
    assert.equal(again.label, "Latino · Vidhide"); // streamwish was refused: tried last now
    assert.ok(plugin.failedServers("sk").has("streamwish"));
    assert.ok(reports.some((r) => r[0] === "maraton:retry" && r[2] === "status=403" && r[3] === "server=streamwish"));
  });
});

test("stream expiry: a path time or s/e in the query; unknown or cookie-bound streams are kept 10 minutes at most", () => {
  const now = 1791092503;
  assert.equal(plugin.expiresInOf(`https://cdn.example/hls2/x/master.m3u8?t=a&s=${now}&e=43200&v=1`, now), 43200);
  assert.equal(plugin.expiresInOf(`https://cdn.example/x/master.m3u8?s=${now - 50000}&e=43200`, now), null); // already over
  assert.equal(plugin.keepStreamMs({ url: "u" }), 10 * 60 * 1000);
  assert.equal(plugin.keepStreamMs({ url: "u", expiresInSeconds: 43200 }), 4 * 3600 * 1000);
  assert.equal(plugin.keepStreamMs({ url: "u", expiresInSeconds: 43200, headers: { Cookie: "a=b" } }), 10 * 60 * 1000);
  assert.deepEqual(plugin.playHeaders({ "User-Agent": "WV", Cookie: "a=b" }, "https://site/"), { "User-Agent": "WV", Cookie: "a=b", Referer: "https://site/" });
  assert.deepEqual(plugin.playHeaders({ referer: "https://e/" }, "https://site/"), { referer: "https://e/" });
});

test("home answers by its deadline with what is ready; a slow site shows its last good rows", async () => {
  const restore = shrink({ homeMs: 150, rowFreshMs: 0 });
  const saved = kino.fetch;
  try {
    pages["https://serieskao.top/series?page=1"] = fixture("sk-search-dark.html");
    config.useAllcalidad = true;
    // First, allcalidad answers: its rows are saved.
    pages[`${ACAPI}/listing?page=1&post_type=movies&posts_per_page=24`] = fixture("ac2-listing-movies-1.json");
    const first = await plugin.home();
    assert.ok(first.find((r) => r.id === "ac-movies"));
    // Then allcalidad hangs: home still answers in time, with its saved row.
    kino.fetch = async (url, o) => (url.startsWith(ACAPI) ? never() : saved(url, o));
    const t0 = Date.now();
    const rows = await plugin.home();
    assert.ok(Date.now() - t0 < 1000, `took ${Date.now() - t0} ms`);
    assert.ok(rows.find((r) => r.id === "sk-serie"));
    const ac = rows.find((r) => r.id === "ac-movies");
    assert.ok(ac && ac.items.length === 4 && ac.items.every((i) => !i.overview)); // saved slim
  } finally {
    restore();
    kino.fetch = saved;
    delete pages["https://serieskao.top/series?page=1"];
    delete pages[`${ACAPI}/listing?page=1&post_type=movies&posts_per_page=24`];
  }
});

test("section's Géneros tab answers by its deadline even when every site hangs (a sentence, never 158 s)", async () => {
  const restore = shrink({ homeMs: 150 });
  const saved = kino.fetch;
  kino.fetch = async () => never();
  try {
    const t0 = Date.now();
    await assert.rejects(plugin.section({ tab: "generos" }), (e) => e.code === "unavailable");
    assert.ok(Date.now() - t0 < 1000);
  } finally {
    restore();
    kino.fetch = saved;
  }
});

test("a site that keeps failing rests: list calls stop asking it for a while; a play still asks", async () => {
  const saved = kino.fetch;
  const asked = [];
  kino.fetch = async (url) => { asked.push(url); throw Object.assign(new Error("timeout"), { code: "timeout" }); };
  config.useAllcalidad = false;
  try {
    for (let i = 0; i < 3; i++) await plugin.search({ q: "dark" }).catch(() => {});
    assert.ok(plugin.siteResting("sk"));
    asked.length = 0;
    await assert.rejects(plugin.search({ q: "dark" }), (e) => e.code === "unavailable");
    assert.equal(asked.length, 0);
    await plugin.resolve(DARK_EP).catch(() => {});
    assert.ok(asked.length > 0);
    assert.match((await plugin.settingsStatus()).state, /en pausa: SeriesKao/);
  } finally {
    kino.fetch = saved;
  }
});

test("search: a site that does not answer in time is left out, never waited for", async () => {
  const restore = shrink({ searchMs: 120 });
  const saved = kino.fetch;
  kino.fetch = async (url, o) => (url.startsWith(ACAPI) ? never() : saved(url, o));
  try {
    const t0 = Date.now();
    const found = await plugin.search({ q: "dark" });
    assert.ok(Date.now() - t0 < 1000);
    assert.ok(found.length > 0 && found.every((i) => i.ref.startsWith("sk|")));
  } finally {
    restore();
    kino.fetch = saved;
  }
});

test("embed69: a title it does not list is quiet; a changed page is reported; sololatino falls back to its own page", async () => {
  assert.deepEqual(plugin.embed69Answer(fixture("embed69-not-listed.json")), { servers: [], why: "not_listed" });
  assert.equal(plugin.embed69Answer("<html>dataLink = [];</html>").why, "no_key");
  assert.equal(plugin.embed69Answer(fixture("sl-embed69-f-dark-1x01.html")).why, "ok");
  config.useSololatino = true;
  const saved = kino.fetch;
  kino.fetch = async (url, o = {}) => {
    if (url === `${SLB}/serie/dark/temporada-1/episodio-1`) return { ok: true, status: 200, text: () => fixture("sl-ep-dark-1x01.html") };
    if (url === `${SLB}/sanctum/csrf-cookie`) return { ok: true, status: 204, text: () => "" };
    if (url === `${SLB}/api/player-url`) return { ok: true, status: 200, text: () => "", json: () => ({ url: "https://embed69.org/f/tt5753856-1x01" }) };
    if (url === "https://embed69.org/f/tt5753856-1x01") return { ok: true, status: 200, text: () => fixture("embed69-not-listed.json") };
    return saved(url, o);
  };
  captured.length = 0;
  captureAnswer = async () => ({ media: [{ url: "https://cdn.example/master.m3u8", headers: {} }], subtitles: [], finalUrl: "" });
  try {
    const st = await plugin.resolve("sl|/serie/dark/temporada-1/episodio-1");
    assert.equal(st.url, "https://cdn.example/master.m3u8");
    assert.deepEqual(captured, [`${SLB}/serie/dark/temporada-1/episodio-1`]);
    assert.deepEqual(st.headers, { Referer: "https://sololatino.net/" });
    assert.ok(!reports.some((r) => r[0] === "maraton:embed69"));
  } finally {
    kino.fetch = saved;
  }
});

test("categories: art from the saved genres at once; the missing ones looked up within ~3 s; a hanging site never slows the tiles", async () => {
  store.set("art2:drama", JSON.stringify({ art: "https://allcalidad.re/wp-content/uploads/backdrops/d.webp" }));
  pages[ACG] = fixture("ac2-genre-drama-1.json");
  const restore = shrink({ artMs: 200 });
  const saved = kino.fetch;
  try {
    // accion's lookup answers (perPage 8 is asked for: the URL differs from the browse one)
    pages[`${ACAPI}/listing?tax=genres&term=accion&page=1&post_type=movies,tvshows,animes&posts_per_page=8`] = fixture("ac2-genre-drama-1.json");
    const tiles = await plugin.categories();
    assert.equal(tiles.length, 22);
    assert.equal(tiles.find((t) => t.id === "genre-drama").art, "https://allcalidad.re/wp-content/uploads/backdrops/d.webp");
    assert.match(tiles.find((t) => t.id === "genre-accion").art, /^https:\/\/allcalidad\.re\/wp-content\/uploads\/backdrops\//);
    assert.equal(tiles.find((t) => t.id === "genre-dorama").art, undefined); // serieskao only, and its page did not answer
    assert.equal(ttls.get("art2:accion"), 24 * 3600 * 1000);
    // allcalidad hangs: the tiles come back in time, with the art already known and none for the rest.
    store.clear();
    store.set("art2:drama", JSON.stringify({ art: "https://allcalidad.re/wp-content/uploads/backdrops/d.webp" }));
    kino.fetch = async () => never();
    const t0 = Date.now();
    const cold = await plugin.categories();
    assert.ok(Date.now() - t0 < 1000, `took ${Date.now() - t0} ms`);
    assert.equal(cold.length, 22);
    assert.deepEqual(cold.filter((t) => t.art).map((t) => t.id), ["genre-drama"]);
  } finally {
    restore();
    kino.fetch = saved;
    delete pages[ACG];
    delete pages[`${ACAPI}/listing?tax=genres&term=accion&page=1&post_type=movies,tvshows,animes&posts_per_page=8`];
  }
});

test("within: the fallback after the deadline, and a late rejection never escapes", async () => {
  assert.equal(await plugin.within(never(), 20, "late"), "late");
  assert.equal(await plugin.within(Promise.resolve(1), 20, "late"), 1);
  await assert.rejects(plugin.within(Promise.reject(Object.assign(new Error("x"), { code: "timeout" })), 50), (e) => e.code === "timeout");
  const lateFail = new Promise((_, rej) => setTimeout(() => rej(new Error("late")), 30));
  assert.equal(await plugin.within(lateFail, 5, "ok"), "ok");
  await new Promise((r) => setTimeout(r, 50)); // the rejection lands with a handler attached: no unhandledRejection
});

test("an embed host that does not answer is skipped at once: no hidden page for it, the next server plays", async () => {
  const saved = kino.fetch;
  kino.fetch = async (url, o) => (url.startsWith("https://hlswish.com/") ? Promise.reject(Object.assign(new Error("timeout"), { code: "timeout" })) : saved(url, o));
  pages["https://morencius.com/embed/vr0ps5s4v6bw"] = fixture("emb-vidhide.html");
  captured.length = 0;
  try {
    const st = await withVidurl(() => plugin.resolve(DARK_EP));
    assert.deepEqual(captured, []); // streamwish's host is down: its capture would not load either
    assert.equal(st.label, "Latino · Vidhide");
    assert.ok(plugin.failedServers("sk").has("streamwish"));
    assert.ok(reports.some((r) => r[0] === "maraton:extract" && r[1] === "host_down" && r[2] === "server=streamwish"));
  } finally {
    kino.fetch = saved;
    delete pages["https://morencius.com/embed/vr0ps5s4v6bw"];
  }
});

test("within() stops its timer once the race is decided: no kino.sleep keeps the call open", async () => {
  const realSleep = globalThis.kino.sleep;
  let pending = 0;
  let slept = 0;
  globalThis.kino.sleep = async (ms) => {
    pending++;
    slept += ms;
    try { await realSleep(ms); } finally { pending--; }
  };
  try {
    const t0 = Date.now();
    const v = await plugin.within(Promise.resolve("ok"), 22000, null);
    assert.equal(v, "ok");
    await realSleep(600); // a cancelled timer ends within one 250 ms step
    assert.equal(pending, 0);
    assert.ok(slept <= 500, `slept ${slept} ms after an instant answer`);
    assert.ok(Date.now() - t0 < 2000);
    assert.equal(await plugin.within(new Promise(() => {}), 300, "late"), "late");
  } finally {
    globalThis.kino.sleep = realSleep;
  }
});

// ---------- 0.6.4: the same title on another site, and genre art that loads ----------

const SKB = "https://serieskao.top";
const defaultCapture = async () => ({ media: [{ url: "https://cdn.example/master.m3u8", headers: { Referer: "https://x/" } }], subtitles: [], finalUrl: "" });

test("pickMatch: the same normalized title and kind, years within one, exactly one title; anything else is no match", () => {
  const items = [
    { ref: "sk|/pelicula/matrix", title: "Matrix", kind: "movie", year: "1999" },
    { ref: "sk|/pelicula/matrix-recargado", title: "Matrix Recargado", kind: "movie", year: "2003" },
    { ref: "sk|/serie/matrix", title: "Matrix", kind: "series", year: "1993" },
  ];
  assert.equal(plugin.pickMatch({ kind: "movie", names: ["Matrix"], year: "1999" }, items).ref, "sk|/pelicula/matrix");
  assert.equal(plugin.pickMatch({ kind: "movie", names: ["MATRIX"], year: "2000" }, items).ref, "sk|/pelicula/matrix"); // ±1
  assert.equal(plugin.pickMatch({ kind: "movie", names: ["Matrix"], year: "2003" }, items), null); // another film's year
  assert.equal(plugin.pickMatch({ kind: "movie", names: ["Matrix"], year: "" }, items).ref, "sk|/pelicula/matrix");
  assert.equal(plugin.pickMatch({ kind: "episode", names: ["Matrix"], year: "" }, items).ref, "sk|/serie/matrix");
  assert.equal(plugin.pickMatch({ kind: "movie", names: ["Matriz"], year: "1999" }, items), null); // close is not equal
  // An original title matches too; accents and punctuation do not count.
  assert.equal(plugin.pickMatch({ kind: "movie", names: ["La desaparición", "The Matrix"], year: "1999" },
    [{ ref: "ac|movies/1/x", title: "Matrix", originalTitle: "The Matrix", kind: "movie", year: "1999" }]).ref, "ac|movies/1/x");
  // Two remakes with the same name and no year to tell them apart: no match. A year picks the right one.
  const remakes = [
    { ref: "sk|/serie/shogun", title: "Shōgun", kind: "series", year: "2024" },
    { ref: "sk|/serie/shogun-1980", title: "Shogun", kind: "series", year: "1980" },
  ];
  assert.equal(plugin.pickMatch({ kind: "episode", names: ["Shogun"], year: "" }, remakes), null);
  assert.equal(plugin.pickMatch({ kind: "episode", names: ["Shogun"], year: "2024" }, remakes).ref, "sk|/serie/shogun");
});

test("refShape and pageInfo: kind, season/episode and the title from the ref's own page or slug", () => {
  assert.deepEqual(plugin.refShape("sk|/serie/dark/temporada/3/capitulo/1"),
    { siteId: "sk", kind: "episode", season: 3, episode: 1, seriesPath: "/serie/dark", slugTitle: "dark", slugYear: "" });
  assert.deepEqual(plugin.refShape("sk|/pelicula/marea-baja-jxVi2n"), { siteId: "sk", kind: "movie", slugTitle: "marea baja", slugYear: "" });
  assert.deepEqual(plugin.refShape("ac|movies/70272/la-pandilla-newton-1998"),
    { siteId: "ac", kind: "movie", acType: "movies", slug: "la-pandilla-newton-1998", slugTitle: "la pandilla newton", slugYear: "1998" });
  assert.equal(plugin.refShape("sl|/serie/dark/temporada-2/episodio-4").season, 2);
  assert.equal(plugin.refShape("ac|ep/41663/70523/1/1").tmdb, "70523");
  assert.equal(plugin.refShape("ac|tvshows/41641/dark-2017"), null); // a show, not something that plays
  assert.deepEqual(plugin.pageInfo(fixture("sk-ep-dark-1x01.html"), "sk", "episode"), { names: ["Dark"], year: "2017" });
  assert.deepEqual(plugin.pageInfo(fixture("sk-pelicula-matrix.html"), "sk", "movie"), { names: ["Matrix"], year: "1999" });
  const sl = plugin.pageInfo(fixture("sl-pelicula.html"), "sl", "movie");
  assert.equal(sl.year, "2025");
  assert.ok(sl.names.includes("La desaparición de Josef Mengele") && sl.names.includes("The Disappearance of Josef Mengele"));
  // An episode page's date is the episode's own: never taken as the show's year.
  assert.deepEqual(plugin.pageInfo(fixture("sl-ep-dark-1x01.html"), "sl", "episode"), { names: ["Dark"], year: "" });
  assert.equal(plugin.acShowName([{ title: "Dark: Temporada 1 Episodio 2" }]), "Dark");
});

test("allcalidad has no embeds (La Pandilla Newton, measured): the same movie is found on serieskao and plays there", async () => {
  // Matrix stands in for a title on both sites; allcalidad answers it the way it answered post 70272.
  const own = `${ACAPI}/player?post_id=27621&_any=1`;
  const single = `${ACAPI}/single?post_name=matrix-1999&post_type=movies`;
  pages[own] = fixture("ac2-player-70272-noembeds.json");
  pages[single] = fixture("ac2-single-matrix.json");
  pages[`${SKB}/search?s=Matrix`] = fixture("sk-search-matrix.html");
  pages[`${SKB}/pelicula/matrix`] = fixture("sk-pelicula-matrix.html");
  captured.length = 0;
  captureAnswer = defaultCapture;
  try {
    const st = await plugin.resolve("ac|movies/27621/matrix-1999");
    assert.equal(st.url, "https://cdn.example/master.m3u8");
    // serieskao's own movie page was opened (its player page is on the site itself), never another Matrix.
    assert.deepEqual(captured, [`${SKB}/pelicula/matrix`]);
    assert.ok(reports.some((r) => r[0] === "maraton:fallback" && r[1] === "ok" && r.includes("from=ac") && r.includes("to=sk") && r.includes("why=no_servers")));
    assert.ok(!reports.some((r) => r[0] === "maraton:resolve"));
    // Kept under the ref Kino asked for: the next play does not search again.
    captured.length = 0;
    assert.equal((await plugin.resolve("ac|movies/27621/matrix-1999")).url, st.url);
    assert.deepEqual(captured, []);
  } finally {
    for (const u of [own, single, `${SKB}/search?s=Matrix`, `${SKB}/pelicula/matrix`]) delete pages[u];
  }
});

test("no confident match anywhere: a clear sentence, nothing played, no other title opened", async () => {
  config.useSololatino = true;
  const own = `${ACAPI}/player?post_id=70272&_any=1`;
  const single = `${ACAPI}/single?post_name=la-pandilla-newton-1998&post_type=movies`;
  const asked = [];
  const saved = kino.fetch;
  pages[own] = fixture("ac2-player-70272-noembeds.json");
  pages[single] = fixture("ac2-single-newton.json");
  pages[`${SKB}/search?s=La%20Pandilla%20Newton`] = fixture("sk-search-none.html");
  pages[`${SKB}/search?s=The%20Newton%20Boys`] = fixture("sk-search-none.html");
  pages[`${SLB}/api/search/suggest?q=La%20Pandilla%20Newton`] = fixture("sl-suggest-none.json");
  pages[`${SLB}/api/search/suggest?q=The%20Newton%20Boys`] = fixture("sl-suggest-none.json");
  // serieskao's search for the original title finds another film with a close name: still no match.
  pages[`${SKB}/search?s=The%20Newton%20Boys`] = fixture("sk-search-matrix.html");
  kino.fetch = async (url, init) => { asked.push(url); return saved(url, init); };
  captured.length = 0;
  try {
    await assert.rejects(plugin.resolve("ac|movies/70272/la-pandilla-newton-1998"),
      (e) => e.code === "not_found" && e.userMessage === "AllCalidad no tiene video para este título y no lo encontramos en los otros sitios. Prueba otra fuente.");
    assert.deepEqual(captured, []);
    assert.ok(asked.includes(`${SKB}/search?s=La%20Pandilla%20Newton`) && asked.includes(`${SKB}/search?s=The%20Newton%20Boys`));
    assert.ok(!asked.some((u) => u.startsWith(`${SKB}/pelicula/`)));
    const r = reports.find((x) => x[0] === "maraton:resolve");
    assert.deepEqual(r.slice(0, 5), ["maraton:resolve", "no_servers", "site=ac", "servers=0", "fb=no_match"]);
  } finally {
    kino.fetch = saved;
    for (const u of [own, single, `${SKB}/search?s=La%20Pandilla%20Newton`, `${SKB}/search?s=The%20Newton%20Boys`,
      `${SLB}/api/search/suggest?q=La%20Pandilla%20Newton`, `${SLB}/api/search/suggest?q=The%20Newton%20Boys`]) delete pages[u];
  }
});

test("episode fallback: an allcalidad episode with no video plays the same season and episode on serieskao", async () => {
  const list = `${ACAPI}/episodes?post_id=41641`;
  const own = `${ACAPI}/player?post_id=41663&_any=1`;
  pages[list] = fixture("ac2-episodes-41641.json");
  pages[own] = fixture("ac2-player-70272-noembeds.json");
  pages[`${SKB}/search?s=Dark`] = fixture("sk-search-dark.html");
  pages[`${SKB}/vidurl/tt5753856-1x01/`] = fixture("sk-vidurl-embed69.html");
  captureAnswer = defaultCapture;
  captured.length = 0;
  try {
    // Listing the show keeps its name for its episode refs, which carry only TMDB ids (/single is not answered here:
    // the name comes from the episodes' own titles).
    await plugin.episodes("ac|tvshows/41641/dark-2017");
    assert.deepEqual(JSON.parse(store.get("show:ac:70523")), { title: "Dark" });
    const st = await plugin.resolve("ac|ep/41663/70523/1/1");
    assert.equal(st.url, "https://cdn.example/master.m3u8");
    // The episode's own servers on serieskao (embed69), 1x01 and nothing else.
    assert.equal(new URL(captured[0]).host, "hglink.to");
    assert.ok(st.alternatives.every((a) => !a.ref || a.ref.startsWith("sk|/serie/dark/temporada/1/capitulo/1#")));
    assert.ok(reports.some((r) => r[0] === "maraton:fallback" && r.includes("to=sk")));
    // Without the kept name there is nothing safe to look for: the old sentence, and no search at all.
    store.clear();
    reports.length = 0;
    captured.length = 0;
    await assert.rejects(plugin.resolve("ac|ep/41663/70523/1/1"), (e) => e.code === "not_found" && /Prueba otra fuente/.test(e.userMessage));
    assert.deepEqual(captured, []);
    assert.ok(reports.some((r) => r[0] === "maraton:resolve" && r.includes("fb=no_title")));
  } finally {
    for (const u of [list, own, `${SKB}/search?s=Dark`, `${SKB}/vidurl/tt5753856-1x01/`]) delete pages[u];
  }
});

test("episode fallback onto SoloLatino: same season and episode, never on a show it numbers absolutely", async () => {
  config.useSololatino = true;
  config.useSerieskao = false;
  const saved = kino.fetch;
  store.set("show:ac:70523", JSON.stringify({ title: "Dark", year: "2017" }));
  store.set("show:ac:46260", JSON.stringify({ title: "Naruto", year: "2002" }));
  pages[`${ACAPI}/player?post_id=41663&_any=1`] = fixture("ac2-player-70272-noembeds.json");
  pages[`${ACAPI}/player?post_id=9&_any=1`] = fixture("ac2-player-70272-noembeds.json");
  pages[`${SLB}/serie/dark`] = fixture("sl-serie-dark.html");
  pages[`${SLB}/serie/naruto`] = fixture("sl-serie-naruto.html");
  pages[`${SLB}/serie/dark/temporada-1/episodio-1`] = fixture("sl-ep-dark-1x01.html");
  const asked = [];
  kino.fetch = async (url, init) => {
    asked.push(url);
    if (url.startsWith(`${SLB}/api/search/suggest`)) {
      const q = new URL(url).searchParams.get("q");
      const all = [{ type: "series", title: "Dark", year: 2017, url: `${SLB}/serie/dark` }, { type: "anime", title: "Naruto", year: 2002, url: `${SLB}/serie/naruto` }];
      const body = JSON.stringify(all.filter((x) => x.title === q));
      return { ok: true, status: 200, text: () => body, json: () => JSON.parse(body) };
    }
    return saved(url, init);
  };
  captureAnswer = defaultCapture;
  captured.length = 0;
  try {
    const st = await plugin.resolve("ac|ep/41663/70523/1/1");
    assert.equal(st.url, "https://cdn.example/master.m3u8");
    // No embed69 player here: SoloLatino's own episode page is the last resort, and it is 1x01's.
    assert.deepEqual(captured, [`${SLB}/serie/dark/temporada-1/episodio-1`]);
    // Naruto 2x01 (TMDB numbering) is not "temporada-2/episodio-1" on SoloLatino, which counts on from 53.
    captured.length = 0;
    await assert.rejects(plugin.resolve("ac|ep/9/46260/2/1"), (e) => e.code === "not_found");
    assert.deepEqual(captured, []);
    assert.ok(!asked.some((u) => /\/serie\/naruto\/temporada-/.test(u)));
  } finally {
    kino.fetch = saved;
    for (const u of [`${ACAPI}/player?post_id=41663&_any=1`, `${ACAPI}/player?post_id=9&_any=1`, `${SLB}/serie/dark`, `${SLB}/serie/naruto`, `${SLB}/serie/dark/temporada-1/episodio-1`]) delete pages[u];
  }
});

test("a copy picked from the Servidor list never falls back to another site", async () => {
  pages[`${ACAPI}/player?post_id=27621&_any=1`] = fixture("ac2-player-27621.json");
  const asked = [];
  const saved = kino.fetch;
  kino.fetch = async (url, init) => { asked.push(url); return saved(url, init); };
  captureAnswer = async () => { throw kinoError("timeout", "no video"); };
  try {
    await assert.rejects(plugin.resolve("ac|movies/27621/matrix-1999#lat/vimeos"), (e) => e.code === "not_found");
    assert.ok(!asked.some((u) => u.includes("/search") || u.includes("/single")));
  } finally {
    kino.fetch = saved;
    captureAnswer = defaultCapture;
    delete pages[`${ACAPI}/player?post_id=27621&_any=1`];
  }
});

test("Comedia's art: a backdrop that does not load is skipped, then posters, then serieskao's genre page; only checked art is kept", async () => {
  const restore = shrink({ artMs: 2000 });
  const comedia = `${ACAPI}/listing?tax=genres&term=comedia&page=1&post_type=movies,tvshows,animes&posts_per_page=8`;
  pages[comedia] = fixture("ac2-genre-drama-1.json");
  const items = JSON.parse(fixture("ac2-genre-drama-1.json")).data.posts;
  const up = (p) => "https://allcalidad.re/wp-content/uploads" + p;
  const saved = kino.fetch;
  try {
    // 1. The newest title's backdrop answers 404 (as allcalidad does for some): the next title's backdrop.
    missingImages.add(up(items[0].images.backdrop));
    let tiles = await plugin.categories();
    assert.equal(tiles.find((t) => t.id === "genre-comedia").art, up(items[1].images.backdrop));
    assert.equal(JSON.parse(store.get("art2:comedia")).art, up(items[1].images.backdrop));
    // 2. The first three backdrops all missing: the first poster.
    store.clear();
    for (const p of items.slice(0, 3)) missingImages.add(up(p.images.backdrop));
    tiles = await plugin.categories();
    assert.equal(tiles.find((t) => t.id === "genre-comedia").art, up(items[0].images.poster));
    // 3. allcalidad does not answer: serieskao's genre page, its first poster that loads.
    store.clear();
    delete pages[comedia];
    pages[`${SKB}/generos/comedia?page=1`] = fixture("sk-generos-accion-2.html");
    tiles = await plugin.categories();
    const art = tiles.find((t) => t.id === "genre-comedia").art;
    assert.match(art, /^https:\/\/image\.tmdb\.org\//);
    assert.equal(JSON.parse(store.get("art2:comedia")).art, art);
    // 4. A picture that cannot be checked (the HEAD fails on the network) is shown but never kept.
    store.clear();
    pages[comedia] = fixture("ac2-genre-drama-1.json");
    missingImages.clear();
    kino.fetch = async (url, init = {}) => {
      if (init.method === "HEAD") throw Object.assign(new Error("network"), { code: "network" });
      return saved(url, init);
    };
    tiles = await plugin.categories();
    assert.equal(tiles.find((t) => t.id === "genre-comedia").art, up(items[0].images.backdrop));
    assert.equal(store.get("art2:comedia"), undefined);
    // 0.6.3's unchecked entries are not read any more.
    kino.fetch = saved;
    store.clear();
    store.set("art:comedia", JSON.stringify({ art: "https://allcalidad.re/wp-content/uploads/backdrops/gone.webp" }));
    delete pages[comedia];
    delete pages[`${SKB}/generos/comedia?page=1`];
    tiles = await plugin.categories();
    assert.equal(tiles.find((t) => t.id === "genre-comedia").art, undefined);
  } finally {
    restore();
    kino.fetch = saved;
    delete pages[comedia];
    delete pages[`${SKB}/generos/comedia?page=1`];
  }
});
