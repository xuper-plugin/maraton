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
globalThis.kino = {
  fetch: async (url) => {
    const body = pages[url];
    return { ok: body !== undefined, status: body === undefined ? 404 : 200, text: () => body || "", json: () => JSON.parse(body) };
  },
  browser: { capture: async (url, opts) => { captured.push(url); return captureAnswer(url, opts); } },
  error: kinoError,
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
beforeEach(() => { reports.length = 0; store.clear(); ttls.clear(); for (const k of Object.keys(config)) delete config[k]; });
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

test("servers: latino first (default), then streamwish/hglink, voe, unknown, vidhide/morencius last", () => {
  const list = [
    { lang: "LAT", server: "vidhide", url: "https://morencius.com/embed/a" },
    { lang: "SUB", server: "streamwish", url: "https://hglink.to/e/s" },
    { lang: "LAT", server: "filemoon", url: "https://filemoon.example/e/f" },
    { lang: "LAT", server: "voe", url: "https://voe.sx/e/v" },
    { lang: "LAT", server: "streamwish", url: "https://hglink.to/e/l" },
  ];
  assert.deepEqual(plugin.rankServers(list).map((f) => f.url), [
    "https://hglink.to/e/l", "https://voe.sx/e/v", "https://filemoon.example/e/f", "https://morencius.com/embed/a", "https://hglink.to/e/s",
  ]);
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

const AC = "https://tmdb.allcalidad.re";

test("allcalidad items carry their TMDB and IMDb ids; anime is a series", () => {
  const items = JSON.parse(fixture("ac-search-dark.json")).items.map(plugin.acItem).filter(Boolean);
  const dark = items.find((i) => i.ref === "ac|tvshow/70523");
  assert.equal(dark.kind, "series");
  assert.deepEqual(dark.ids, { tmdb: 70523, imdb: "tt5753856" });
  assert.match(dark.poster, /^https:\/\/image\.tmdb\.org\/t\/p\/w342\//);
  assert.ok(items.some((i) => i.kind === "movie" && i.ref.startsWith("ac|movie/")));
  const anime = items.find((i) => i.ref.startsWith("ac|anime/"));
  assert.equal(anime.kind, "series");
  assert.equal(anime.genres[0], "Anime");
  assert.equal(plugin.acItem({ kind: "person", tmdb_id: 1, title: "x" }), null);
});

test("allcalidad episodes: every season's list, with stills and air dates", async () => {
  pages[`${AC}/v1/items/tvshow/70523`] = fixture("ac-item-tvshow-70523.json");
  pages[`${AC}/v1/items/tvshow/70523/seasons/1`] = fixture("ac-season-70523-1.json");
  try {
    const r = await plugin.episodes("ac|tvshow/70523");
    // Seasons 2 and 3 answer 404 here: they are just missing, season 1 still comes.
    assert.equal(r.episodes.length, 10);
    assert.equal(r.episodes[0].ref, "ac|tvshow/70523/1/1");
    assert.equal(r.episodes[0].title, "Secretos");
    assert.equal(r.episodes[0].airDate, "2017-12-01");
    assert.deepEqual(r.series.ids, { tmdb: 70523, imdb: "tt5753856" });
  } finally {
    delete pages[`${AC}/v1/items/tvshow/70523`];
    delete pages[`${AC}/v1/items/tvshow/70523/seasons/1`];
  }
});

test("allcalidad playback: refs map to the API path, embeds to servers", () => {
  assert.equal(plugin.acPlaybackPath("ac|movie/603"), "/v1/playback/movie/603");
  assert.equal(plugin.acPlaybackPath("ac|tvshow/70523/1/2#lat/vimeos"), "/v1/playback/tvshow/70523?season=1&episode=2");
  assert.throws(() => plugin.acPlaybackPath("ac|tvshow/70523"));
  assert.deepEqual(plugin.acServers(JSON.parse(fixture("ac-playback-movie-603.json"))).map((f) => [plugin.langOf(f.lang), f.server]),
    [["lat", "vimeos"], ["lat", "goodstream"]]);
});

test("allcalidad resolve opens the embed page the API lists", async () => {
  pages[`${AC}/v1/playback/tvshow/70523?season=1&episode=1`] = fixture("ac-playback-70523-1-1.json");
  captured.length = 0;
  captureAnswer = async () => ({ media: [{ url: "https://cdn.example/master.m3u8", headers: {} }], subtitles: [], finalUrl: "" });
  try {
    const st = await plugin.resolve("ac|tvshow/70523/1/1");
    assert.equal(st.url, "https://cdn.example/master.m3u8");
    assert.deepEqual(captured.map((u) => new URL(u).host), ["vimeos.net"]);
  } finally {
    delete pages[`${AC}/v1/playback/tvshow/70523?season=1&episode=1`];
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

const ACG = "https://tmdb.allcalidad.re/v1/taxonomies/genre/acci%C3%B3n/items?page=1";

test("Usar SeriesKao / Usar AllCalidad: a switched-off site is never asked", async () => {
  const asked = [];
  const saved = kino.fetch;
  kino.fetch = async (url, o) => { asked.push(new URL(url).host); return saved(url, o); };
  try {
    config.useSerieskao = false;
    assert.deepEqual(plugin.activeSites(), ["ac"]);
    await plugin.search({ q: "dark" }).catch(() => []);
    assert.ok(asked.length > 0 && asked.every((h) => h === "tmdb.allcalidad.re"));
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

test("a genre page interleaves both sites; one site missing still pages", async () => {
  pages["https://serieskao.top/generos/accion?page=1"] = fixture("sk-generos-accion-2.html");
  pages[ACG] = fixture("ac-genre-accion-1.json");
  try {
    const p = await plugin.browse("genre|accion", null);
    assert.equal(p.next, "2");
    assert.deepEqual(p.items.slice(0, 4).map((i) => i.ref.slice(0, 3)), ["sk|", "ac|", "sk|", "ac|"]);
    delete pages[ACG];
    const skOnly = await plugin.browse("genre|accion", null);
    assert.ok(skOnly.items.length > 0 && skOnly.items.every((i) => i.ref.startsWith("sk|")));
    await assert.rejects(plugin.browse("genre|nope", null), (e) => e.code === "not_found");
  } finally {
    delete pages["https://serieskao.top/generos/accion?page=1"];
    delete pages[ACG];
  }
});

test("section: four tabs, the chosen one answered, an unknown tab falls back to Series", async () => {
  const sec = await plugin.section({ tab: "peliculas" });
  assert.deepEqual(sec.tabs.map((t) => t.id), ["series", "anime", "peliculas", "generos"]);
  assert.equal(sec.tab, "peliculas");
  assert.match(sec.hero.text, /latino/);
  assert.equal((await plugin.section({ tab: "x" })).tab, "series");
  config.lang = "sub";
  assert.match((await plugin.section({ tab: null })).hero.text, /subtitulada/);
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
    assert.match(r.message, /^SeriesKao: responde \(\d+ ms\) · AllCalidad: no responde$/);
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
  assert.deepEqual(await plugin.validateSettings({ useSerieskao: false, useAllcalidad: false }), { useAllcalidad: "Deja al menos un sitio activo" });
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
  assert.equal(plugin.alternativesOf([], playing, many, "r").length, 3);
});

test("resolve: the stream names its copy and offers the servers it did not try, not the ones that failed", async () => {
  pages["https://serieskao.top/vidurl/tt5753856-1x01/"] = fixture("sk-vidurl-embed69.html");
  captured.length = 0;
  let n = 0;
  captureAnswer = async () => {
    if (n++ === 0) throw Object.assign(new Error("timeout"), { code: "timeout" });
    return { media: [{ url: "https://cdn.example/master.m3u8", headers: {} }], subtitles: [], finalUrl: "" };
  };
  try {
    const st = await plugin.resolve("sk|/serie/dark/temporada/1/capitulo/1");
    assert.equal(st.label, "Latino · Voe");
    // hglink failed, voe plays: only vidhide is left to offer.
    assert.deepEqual(st.alternatives, [{ label: "Latino · Vidhide", ref: "sk|/serie/dark/temporada/1/capitulo/1#lat/vidhide" }]);
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

test("telemetry reports carry only our own codes: site down, Cloudflare, capture timeout per server, embed69 empty", async () => {
  const saved = kino.fetch;
  try {
    kino.fetch = async () => { throw Object.assign(new Error("timeout"), { code: "timeout" }); };
    await plugin.episodes("sk|/serie/dark").catch(() => {});
    assert.deepEqual(reports.pop(), ["maraton:site", "down", "site=sk", "code=timeout"]);
    kino.fetch = async () => ({ ok: true, status: 200, text: () => "<title>Just a moment...</title>" });
    await plugin.episodes("sk|/serie/dark").catch(() => {});
    assert.deepEqual(reports.pop(), ["maraton:site", "cloudflare", "site=sk"]);
    kino.fetch = async (url) => (url.includes("/vidurl/") ? { ok: true, status: 200, text: () => "<html>changed</html>" } : saved(url));
    captureAnswer = async () => { throw Object.assign(new Error("timeout"), { code: "timeout" }); };
    await plugin.resolve("sk|/serie/dark/temporada/1/capitulo/1").catch(() => {});
    assert.ok(reports.some((r) => r[0] === "maraton:embed69" && r[1] === "no_servers"));
    assert.ok(reports.some((r) => r[0] === "maraton:capture" && r[1] === "timeout" && r[2] === "server=episode_page"));
    // Nothing reported carries a URL, a host or a title.
    for (const r of reports) for (const c of r) assert.doesNotMatch(String(c), /https?:|\.top|\.net|dark/i);
  } finally {
    kino.fetch = saved;
  }
});

test("a capture timeout on a known server reports that server's name", async () => {
  pages["https://serieskao.top/vidurl/tt5753856-1x01/"] = fixture("sk-vidurl-embed69.html");
  captureAnswer = async () => { throw Object.assign(new Error("timeout"), { code: "timeout" }); };
  try {
    await plugin.resolve("sk|/serie/dark/temporada/1/capitulo/1").catch(() => {});
    assert.deepEqual(reports.filter((r) => r[0] === "maraton:capture").map((r) => r[2]), ["server=streamwish", "server=voe", "server=vidhide"]);
  } finally {
    delete pages["https://serieskao.top/vidurl/tt5753856-1x01/"];
  }
});

test("richer cards: serieskao ratings, allcalidad runtime/quality/genres, series genres from the page", async () => {
  config.useAllcalidad = false;
  const dark = (await plugin.search({ q: "dark" })).find((i) => i.ref === "sk|/serie/dark");
  assert.equal(dark.rating, 7.7);
  const matrix = plugin.acItem({ kind: "movie", tmdb_id: 603, title: "Matrix", runtime: 131, quality: "HD", vote_average: 8.259, genres: [{ title: "Acción" }] });
  assert.equal(matrix.runtimeMinutes, 131);
  assert.deepEqual(matrix.badges, ["HD"]);
  assert.equal(matrix.rating, 8.3);
  assert.deepEqual(matrix.genres, ["Acción"]);
  assert.equal(plugin.acItem({ kind: "tvshow", tmdb_id: 1, title: "S", runtime: 50 }).runtimeMinutes, undefined);
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
  const AC = "https://tmdb.allcalidad.re";
  pages[`${AC}/v1/playback/movie/603`] = fixture("ac-playback-movie-603.json");
  captured.length = 0;
  captureAnswer = async (url) => (url.includes("vimeos")
    ? { media: [{ url: "https://cdn.jugabet.cl/promo/preroll.mp4", headers: {} }], subtitles: [], finalUrl: "" }
    : { media: [{ url: "https://hls2.goodstream.one/hls2/01/x/master.m3u8", headers: { Referer: "https://goodstream.one/", Cookie: "c=1" } },
      { url: "https://cdn.jugabet.cl/promo/preroll.mp4", headers: {} }], subtitles: [], finalUrl: "" });
  try {
    const st = await plugin.resolve("ac|movie/603");
    assert.equal(st.url, "https://hls2.goodstream.one/hls2/01/x/master.m3u8");
    assert.deepEqual(st.headers, { Referer: "https://goodstream.one/", Cookie: "c=1" }); // capture's headers passed as is
    assert.ok(!(st.alternatives || []).some((a) => a.url && /\.mp4/.test(a.url)));
    assert.ok(plugin.failedServers("ac").has("vimeos"));
    assert.ok(reports.some((r) => r[1] === "only_ads"));
  } finally {
    delete pages[`${AC}/v1/playback/movie/603`];
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
    assert.equal(new URL(captured[0]).host, "voe.sx"); // streamwish now last
    assert.ok(!(st.alternatives || []).some((a) => /streamwish/i.test(a.label || "")));
    assert.ok(!plugin.failedServers("sk").has("voe"));
    assert.deepEqual(plugin.lastIfFailed(mixed, new Set(["streamwish"])).map((f) => f.server), ["vidhide", "voe", "streamwish", "streamwish"]);
  } finally {
    delete pages["https://serieskao.top/vidurl/tt5753856-1x01/"];
  }
});

test("at most three lazy copies, best first", () => {
  const many = Array.from({ length: 7 }, (_, i) => ({ lang: "LAT", server: `s${i}`, url: `https://h${i}.example/e` }));
  const alts = plugin.alternativesOf([], { lang: "LAT", server: "x", url: "https://p.example/e" }, many, "r");
  assert.deepEqual(alts.map((a) => a.ref), ["r#lat/s0", "r#lat/s1", "r#lat/s2"]);
});
