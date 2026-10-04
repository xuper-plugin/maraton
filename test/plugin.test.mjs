// Offline tests: the HTML parsers against pages saved from the real site (test/fixtures), and resolve's
// fallbacks with a fake `kino`. Run: node --test test/
import { test } from "node:test";
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
};
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

test("servers: latino first, then streamwish/hglink, voe, unknown, vidhide/morencius last", () => {
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
