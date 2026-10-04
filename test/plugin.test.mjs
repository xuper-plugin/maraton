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
    return { ok: body !== undefined, status: body === undefined ? 404 : 200, text: () => body || "" };
  },
  browser: { capture: async (url, opts) => { captured.push(url); return captureAnswer(url, opts); } },
  error: kinoError,
  log: () => {},
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
  },
  config: { get: (k) => config[k] },
};
const store = new Map();
const ttls = new Map();
const config = {};
beforeEach(() => { store.clear(); ttls.clear(); for (const k of Object.keys(config)) delete config[k]; });
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
    assert.match(i.badges[0], /^T\d+ E\d+$/);
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
