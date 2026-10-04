// Series web: series and anime from Spanish-language streaming sites, played through Kino's hidden browser
// (kino.browser.capture, apiVersion 7). Everything runs on the device: HTML is read with kino.fetch (regex, no
// kino.html, so the Node kit runs it too) and the episode's player page is opened in the hidden browser, which
// reports the video request the page makes.
//
// Refs:  "<site>|<path>"  e.g. "sk|/serie/dark" (a series), "sk|/serie/dark/temporada/1/capitulo/1" (an episode).
// Rows:  "row|<site>|<kind>" with the catalog page number as the cursor.

const UA = "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36";

const SITES = {
  sk: {
    name: "SeriesKao",
    base: "https://serieskao.top",
    search: (q) => `/search?s=${encodeURIComponent(q).replace(/%2F/gi, "/")}`,
    catalog: { serie: "/series?page=", anime: "/animes?page=" },
    episodeRx: /<a[^>]+href="([^"]*?\/temporada\/(\d+)\/capitulo\/(\d+))"[^>]*>([\s\S]*?)<\/a>/gi,
  },
  sl: {
    name: "SoloLatino",
    base: "https://sololatino.net",
    search: (q) => `/buscar?q=${encodeURIComponent(q)}`,
    catalog: { serie: "/series?page=", anime: "/animes?page=" },
    episodeRx: /<a[^>]+href="([^"]*?\/temporada-(\d+)\/episodio-(\d+))"[^>]*>([\s\S]*?)<\/a>/gi,
  },
};

const ORDER = ["sk", "sl"];

// ---------- small helpers ----------

function abs(site, href) {
  if (/^https?:\/\//i.test(href)) return href;
  return site.base + (href.startsWith("/") ? href : "/" + href);
}

function pathOf(site, url) {
  return url.startsWith(site.base) ? url.slice(site.base.length) : url;
}

function text(html) {
  return decode(String(html || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
}

function decode(s) {
  return s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

function attr(tag, name) {
  const m = new RegExp(`${name}="([^"]*)"`, "i").exec(tag);
  return m ? decode(m[1]) : "";
}

function idOf(siteId, path) {
  return (siteId + "-" + path.replace(/^\/+/, "").replace(/[^A-Za-z0-9._~-]+/g, "-")).slice(0, 128);
}

/** Host and path only: never a query string (tokens live there). */
function safe(url) {
  const m = /^https?:\/\/([^/?#]+)([^?#]*)/i.exec(url || "");
  return m ? m[1] + m[2].slice(0, 100) : "?";
}

function looksLikeChallenge(html) {
  return /just a moment/i.test(html || "");
}

async function page(site, path) {
  const t0 = Date.now();
  const r = await kino.fetch(abs(site, path), { headers: { "User-Agent": UA, Accept: "text/html" } });
  kino.log(`fetch ${safe(abs(site, path))} -> ${r.status} in ${Date.now() - t0} ms`);
  if (!r.ok) throw kino.error(r.status === 404 ? "not_found" : "unavailable", `${site.name} respondió ${r.status}`);
  const html = r.text();
  // pelisplus/sololatino sit behind Cloudflare at times: a challenge page is "unavailable", never parsed as content.
  if (looksLikeChallenge(html)) throw kino.error("unavailable", `${site.name} pide verificación de Cloudflare`);
  return html;
}

// ---------- cards (search results, catalogs) ----------

/** serieskao's `<article class="card">`: link, poster, title, year, type badge. */
function skCards(siteId, html) {
  const site = SITES[siteId];
  const out = [];
  const seen = new Set();
  const rx = /<article class="card">([\s\S]*?)<\/article>/gi;
  let m;
  while ((m = rx.exec(html))) {
    const block = m[1];
    const link = /<a href="([^"]+)" class="card__link"/i.exec(block);
    if (!link) continue;
    const path = pathOf(site, decode(link[1]));
    if (!/^\/(serie|anime)\//.test(path) || seen.has(path)) continue;
    seen.add(path);
    const title = text((/<h2 class="card__title">([\s\S]*?)<\/h2>/i.exec(block) || [])[1]);
    if (!title) continue;
    const img = /<img[^>]+>/i.exec(block);
    const year = text((/card__badge--year">([\s\S]*?)</i.exec(block) || [])[1]);
    const item = { id: idOf(siteId, path), ref: `${siteId}|${path}`, title, kind: "series" };
    const poster = img ? attr(img[0], "src") : "";
    if (/^https?:\/\//.test(poster)) item.poster = poster;
    if (/^\d{4}$/.test(year)) item.year = year;
    if (path.startsWith("/anime/")) item.genres = ["Anime"];
    out.push(item);
  }
  return out;
}

/** sololatino's catalog: a JSON-LD ItemList (no year); its search: plain `/serie/` links with the title inside. */
function slCards(siteId, html) {
  const site = SITES[siteId];
  const out = [];
  const seen = new Set();
  const push = (url, title, poster) => {
    const path = pathOf(site, url);
    if (!/^\/(serie|anime)s?\//.test(path) || seen.has(path) || !title) return;
    seen.add(path);
    const item = { id: idOf(siteId, path), ref: `${siteId}|${path}`, title, kind: "series" };
    if (poster && /^https?:\/\//.test(poster)) item.poster = poster;
    out.push(item);
  };
  const ld = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = ld.exec(html))) {
    let data;
    try { data = JSON.parse(m[1]); } catch (_) { continue; }
    for (const node of (data && data["@graph"]) || []) {
      if (node["@type"] !== "ItemList") continue;
      for (const it of node.itemListElement || []) push(it.url || (it.item && it.item.url) || "", it.name || (it.item && it.item.name) || "", it.image || "");
    }
  }
  if (out.length) return out;
  const a = /<a[^>]+href="([^"]*\/(?:serie|anime)s?\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  while ((m = a.exec(html))) {
    const img = /<img[^>]+>/i.exec(m[2]);
    const title = text(m[2]) || (img ? attr(img[0], "alt") : "");
    push(abs(site, decode(m[1])), title, img ? attr(img[0], "data-src") || attr(img[0], "src") : "");
  }
  return out;
}

function cards(siteId, html) {
  return siteId === "sk" ? skCards(siteId, html) : slCards(siteId, html);
}

// ---------- search / home / browse ----------

export async function search(query) {
  const q = String((query && query.q) || "").trim();
  if (!q) return [];
  const tries = [q, kino.rank.shortQuery(q)].filter((v, i, a) => v && a.indexOf(v) === i);
  const lists = await Promise.all(ORDER.map(async (siteId) => {
    const site = SITES[siteId];
    for (const t of tries) {
      try {
        const t0 = Date.now();
        const found = cards(siteId, await page(site, site.search(t)));
        kino.log(`search ${siteId} "${t.slice(0, 60)}": ${found.length} results in ${Date.now() - t0} ms${found.length ? `, first ${found[0].ref}` : ""}`);
        if (found.length) return found;
      } catch (e) {
        kino.log(`search ${siteId}: ${e.code || ""} ${e.message}`);
        return [];
      }
    }
    return [];
  }));
  const all = [].concat(...lists);
  const ranked = kino.rank.filterRelevant(kino.rank.sortBySimilarity(all, q, (it) => it.title), q, (it) => it.title).slice(0, 60);
  kino.log(`search "${q.slice(0, 60)}": ${all.length} found, ${ranked.length} kept${ranked.length ? `, best ${ranked[0].ref}` : ""}`);
  return ranked;
}

export async function home() {
  const rows = [
    { siteId: "sk", kind: "serie", title: "Series · SeriesKao", genre: "series" },
    { siteId: "sk", kind: "anime", title: "Anime · SeriesKao", genre: "anime" },
  ];
  const out = await Promise.all(rows.map(async (r) => {
    try {
      const items = cards(r.siteId, await page(SITES[r.siteId], SITES[r.siteId].catalog[r.kind] + "1"));
      return items.length ? { id: `${r.siteId}-${r.kind}`, title: r.title, items, ref: `row|${r.siteId}|${r.kind}`, genre: r.genre } : null;
    } catch (e) {
      kino.log(`home ${r.siteId}/${r.kind}: ${e.code || ""} ${e.message}`);
      return null;
    }
  }));
  return out.filter(Boolean);
}

export async function browse(ref, cursor) {
  const [, siteId, kind] = String(ref).split("|");
  const site = SITES[siteId];
  if (!site || !site.catalog[kind]) throw kino.error("not_found", "fila desconocida");
  const n = Math.max(1, parseInt(cursor || "1", 10) || 1);
  const items = cards(siteId, await page(site, site.catalog[kind] + n));
  return items.length ? { items, next: String(n + 1) } : { items };
}

// ---------- episodes ----------

function splitRef(ref) {
  const s = String(ref);
  const i = s.indexOf("|");
  const siteId = s.slice(0, i);
  const path = s.slice(i + 1);
  const site = SITES[siteId];
  if (!site || !path.startsWith("/")) throw kino.error("not_found", "referencia inválida");
  return { siteId, site, path };
}

export function parseEpisodes(siteId, html) {
  const site = SITES[siteId];
  const rx = new RegExp(site.episodeRx.source, "gi");
  const seen = new Set();
  const out = [];
  let m;
  while ((m = rx.exec(html))) {
    const path = pathOf(site, decode(m[1]));
    if (seen.has(path)) continue;
    seen.add(path);
    const season = parseInt(m[2], 10);
    const number = parseInt(m[3], 10);
    if (!season || !number) continue;
    const ep = { season, number, ref: `${siteId}|${path}` };
    const t = text((/episode-item__title">([\s\S]*?)</i.exec(m[4]) || [])[1] || m[4]).replace(/^\d+[\s.·:-]*/, "").trim();
    if (t && !/^(episodio|cap[ií]tulo)\s*\d+$/i.test(t)) ep.title = t.slice(0, 200);
    out.push(ep);
  }
  out.sort((a, b) => a.season - b.season || a.number - b.number);
  return out;
}

export async function episodes(ref) {
  const { siteId, site, path } = splitRef(ref);
  const html = await page(site, path);
  const list = parseEpisodes(siteId, html);
  if (!list.length) throw kino.error("not_found", "la serie no tiene episodios en " + site.name);
  const perSeason = {};
  for (const e of list) perSeason[e.season] = (perSeason[e.season] || 0) + 1;
  kino.log(`episodes ${ref}: ${list.length} (${Object.entries(perSeason).map(([k, v]) => `T${k}:${v}`).join(" ")})`);
  const series = {};
  const title = text((/<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html) || [])[1]);
  if (title) series.title = title;
  const og = /<meta property="og:image" content="([^"]+)"/i.exec(html);
  if (og && /^https?:\/\//.test(og[1])) series.poster = og[1];
  // The JSON-LD description is the whole synopsis; the meta one is cut at ~160 characters.
  const ld = /"@type":"TVSeries"[\s\S]*?"description":"((?:[^"\\]|\\.)*)"/.exec(html);
  const desc = /<meta name="description" content="([^"]*)"/i.exec(html);
  if (ld) { try { series.overview = JSON.parse(`"${ld[1]}"`).slice(0, 2000); } catch (_) { /* the meta one below */ } }
  if (!series.overview && desc) series.overview = decode(desc[1]).slice(0, 2000);
  const year = /"datePublished":\s*"?(\d{4})/.exec(html);
  if (year) series.year = year[1];
  // The player pages are keyed by IMDb id (/vidurl/tt5753856-1x01/): Kino joins the series with TMDB through it.
  // The series page has no player, so the first episode's page is read once for it.
  try {
    const first = await page(site, pathOf(site, list[0].ref.split("|")[1]));
    const imdb = /\/(?:vidurl|video)\/(tt\d{5,10})-/i.exec(first);
    if (imdb) series.ids = { imdb: imdb[1] };
    kino.log(`episodes ${siteId}: IMDb ${imdb ? imdb[1] : "not found"}`);
  } catch (e) {
    kino.log(`episodes ${siteId}: no IMDb id (${e.code || ""} ${e.message})`);
  }
  return { series, episodes: list };
}

// ---------- resolve ----------

/** The episode page's servers, in the page's order: `data-url` buttons, then the player iframe. Absolute URLs. */
export function serversOf(siteId, html) {
  const site = SITES[siteId];
  const out = [];
  const add = (u) => {
    if (!u) return;
    const url = abs(site, decode(u));
    if (/^https?:\/\//i.test(url) && !out.includes(url)) out.push(url);
  };
  let m;
  const btn = /<button[^>]+data-url="([^"]+)"/gi;
  while ((m = btn.exec(html))) add(m[1]);
  const li = /data-(?:src|player|link)="(https?:\/\/[^"]+)"/gi;
  while ((m = li.exec(html))) add(m[1]);
  const frame = /<iframe[^>]+(?:data-src|src)="([^"]+)"/gi;
  while ((m = frame.exec(html))) add(m[1]);
  return out;
}

/**
 * Which page to open for one server. A player page on the site itself (`/vidurl/…`) blanks itself when it is not inside
 * a frame, so for those the episode page (which frames it) is opened instead; another host's embed is opened directly.
 */
export function pagesToOpen(siteId, episodeUrl, servers) {
  const site = SITES[siteId];
  const out = [];
  for (const s of servers) {
    const target = s.startsWith(site.base) ? episodeUrl : s;
    if (!out.includes(target)) out.push(target);
  }
  if (!out.length) out.push(episodeUrl);
  return out.slice(0, MAX_PAGES);
}

const MAX_PAGES = 3;
const CAPTURE_MS = 25000;

function startHost(url) {
  try { return new URL(url).host; } catch (_) { return ""; }
}

// ---------- embed69 fast path (same logic web-resolver ran as bypassEmbed69) ----------
//
// serieskao's `/vidurl/<imdb>-<s>x<ee>/` player page is an embed69 page: its `dataLink` JSON lists every server, each
// link AES-CBC encrypted (base64 of iv || ciphertext). The key is either written in the page
// (`decryptLink(server.link, 'KEY')`) or derived from a small SHA-256 proof of work (POW_CHALLENGE / POW_DIFFICULTY /
// POW_SALT). Decrypting here gives the embed hosts' own pages, which the hidden browser can open as the top document
// instead of digging through cross-origin frames.

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const POW_MAX_NONCE = 2000000;

function b64ToHex(b64) {
  const clean = String(b64).replace(/[^A-Za-z0-9+/]/g, "");
  let bits = 0, acc = 0, hex = "";
  for (const ch of clean) {
    acc = (acc << 6) | B64.indexOf(ch);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      hex += ((acc >> bits) & 0xff).toString(16).padStart(2, "0");
    }
  }
  return hex;
}

function utf8ToHex(s) {
  return Array.from(new TextEncoder().encode(s), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** An AES key of 16/24/32 bytes, hex; any other length is zero-padded/cut to 32 (as web-resolver's crylink did). */
function aesKeyHex(keyHex) {
  const len = keyHex.length / 2;
  return [16, 24, 32].includes(len) ? keyHex : (keyHex + "0".repeat(64)).slice(0, 64);
}

function crylink(b64, keyHex) {
  try {
    const all = b64ToHex(b64);
    const key = aesKeyHex(keyHex);
    return kino.crypto.decrypt(`aes-${(key.length / 2) * 8}-cbc`, {
      key, keyEncoding: "hex", iv: all.slice(0, 32), ivEncoding: "hex", data: all.slice(32), inputEncoding: "hex",
    });
  } catch (_) {
    return null;
  }
}

/** The proof of work's key, hex: sha256(challenge + nonce + salt) for the first nonce whose sha256(challenge + nonce) starts with `difficulty` zeros. */
function solvePow(challenge, difficulty, salt) {
  const prefix = "0".repeat(difficulty);
  for (let nonce = 0; nonce < POW_MAX_NONCE; nonce++) {
    if (kino.crypto.hash("sha256", `${challenge}${nonce}`).startsWith(prefix)) {
      return salt ? kino.crypto.hash("sha256", `${challenge}${nonce}${salt}`) : null;
    }
  }
  return null;
}

/** Decrypted servers of an embed69 page: `[{ lang, server, url }]`, latino first, downloads left out. */
export function embed69Servers(html) {
  let keyHex = null;
  const m = /decryptLink\(server\.link,\s*'(.+?)'\),/.exec(html);
  if (m) keyHex = utf8ToHex(m[1]);
  if (!keyHex) {
    const pm = /POW_CHALLENGE\s*=\s*'([^']+)';[\s\S]*?POW_DIFFICULTY\s*=\s*(\d+);[\s\S]*?POW_SALT\s*=\s*'([^']+)';/.exec(html);
    if (pm) keyHex = solvePow(pm[1], parseInt(pm[2], 10), pm[3]);
  }
  const dlm = /dataLink\s*=\s*(\[[\s\S]*?\])\s*;/.exec(html) || /dataLink\s*=\s*([^;]+)/.exec(html);
  if (!dlm || !keyHex) return [];
  let dataLink;
  try { dataLink = JSON.parse(dlm[1].replace(/\\\//g, "/")); } catch (_) { return []; }
  const out = [];
  for (const sec of dataLink || []) {
    const lang = sec.video_language || "LAT";
    for (const emb of sec.sortedEmbeds || []) {
      if (emb.servername === "download") continue;
      const url = crylink(emb.link, keyHex);
      if (url && /^https?:\/\//.test(url)) out.push({ lang, server: emb.servername || "", url });
    }
  }
  return out.sort((a, b) => (/lat/i.test(b.lang) ? 1 : 0) - (/lat/i.test(a.lang) ? 1 : 0));
}

/** Every embed69 server behind the episode's own player pages (`/vidurl/…`), or [] when there is none. */
async function fastServers(site, episodeUrl, servers) {
  const out = [];
  for (const s of servers.filter((u) => u.startsWith(site.base))) {
    const t0 = Date.now();
    const r = await kino.fetch(s, { headers: { "User-Agent": UA, Accept: "text/html", Referer: episodeUrl } });
    if (!r.ok) {
      kino.log(`embed69 ${safe(s)} -> ${r.status}`);
      continue;
    }
    const found = embed69Servers(r.text());
    kino.log(`embed69 ${safe(s)}: ${found.length} server(s) in ${Date.now() - t0} ms [${found.map((f) => `${f.lang}/${f.server}@${startHost(f.url)}`).join(", ")}]`);
    for (const f of found) if (!out.some((o) => o.url === f.url)) out.push(f);
  }
  return out;
}

export async function resolve(ref) {
  const { siteId, site, path } = splitRef(ref);
  const episodeUrl = abs(site, path);
  const html = await page(site, path);
  const servers = serversOf(siteId, html);
  kino.log(`resolve ${ref}: servers [${servers.map(safe).join(", ")}]`);
  // Fast path: decrypt embed69's server list and open each embed host's page directly (its player is then the top
  // document, so autoplay reaches it). Without it, fall back to opening the episode page and digging through frames.
  const fast = await fastServers(site, episodeUrl, servers);
  const pages = fast.length
    ? fast.slice(0, MAX_PAGES).map((f) => f.url)
    : pagesToOpen(siteId, episodeUrl, servers).filter((u) => Object.values(SITES).some((s) => startHost(u) === startHost(s.base)));
  kino.log(`resolve ${siteId}: ${fast.length ? "embed69 fast path" : "no fast path"}, capture on ${pages.length} page(s): [${pages.map(safe).join(", ")}]`);
  let lastError = null;
  for (const url of pages) {
    const started = Date.now();
    kino.log(`capture ${safe(url)} (timeout ${CAPTURE_MS} ms)`);
    try {
      const got = await kino.browser.capture(url, { timeoutMs: CAPTURE_MS, headers: { Referer: site.base + "/" } });
      kino.log(`capture ok in ${Date.now() - started} ms: ${got.media.length} media [${got.media.map((m) => safe(m.url)).join(", ")}], ${got.subtitles.length} subtitles`);
      const [first, ...rest] = got.media;
      if (!first) continue;
      const stream = { url: first.url, headers: first.headers };
      if (first.mime) stream.mime = first.mime;
      if (rest.length) stream.alternatives = rest.slice(0, 8).map((m) => (m.mime ? { url: m.url, mime: m.mime, headers: m.headers } : { url: m.url, headers: m.headers }));
      const subs = (got.subtitles || []).slice(0, 10).map((s) => ({ lang: s.lang || "es", url: s.url, format: /\.srt(\?|$)/i.test(s.url) ? "srt" : "vtt" }));
      if (subs.length) stream.subtitles = subs;
      kino.log(`stream ${safe(stream.url)} mime=${stream.mime || "?"} headers=${Object.keys(stream.headers || {}).join(",")} alternatives=${(stream.alternatives || []).length}`);
      return stream;
    } catch (e) {
      lastError = e;
      kino.log(`capture failed after ${Date.now() - started} ms on ${startHost(url)}: ${e.code || ""} ${e.message}`);
      // No WebView, or the person never approved it: no other page will do better.
      if (e.code === "browser_unavailable" || e.code === "not_allowed") break;
    }
  }
  if (lastError && lastError.code === "browser_unavailable") {
    throw kino.error("unavailable", "sin navegador web", { userMessage: "Este aparato no tiene navegador web, y esta fuente lo necesita para reproducir." });
  }
  throw kino.error("not_found", lastError ? `${lastError.code || ""} ${lastError.message}` : "sin servidores", { userMessage: "No encontramos el video de este episodio. Prueba otra fuente." });
}
