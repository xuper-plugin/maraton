// Maratón: series and anime from Spanish-language streaming sites, played through Kino's hidden browser
// (kino.browser.capture). Everything runs on the device: HTML is read with kino.fetch (regex, no
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
    catalog: { serie: "/series?page=", anime: "/animes?page=", pelicula: "/peliculas?page=" },
    episodeRx: /<a[^>]+href="([^"]*?\/temporada\/(\d+)\/capitulo\/(\d+))"[^>]*>([\s\S]*?)<\/a>/gi,
  },
};

/**
 * Every site the plugin can read, in the order results are merged. Which ones are used is the person's choice
 * (Ajustes: "Usar SeriesKao" / "Usar AllCalidad", see [activeSites]). sololatino.net was dropped: it answers a
 * Cloudflare challenge from every network tried, and reading it would need the hidden browser to return a page's HTML
 * (an SDK change the owner asked to wait for).
 */
const ALL_SITES = ["sk", "ac"];
const SITE_SETTING = { sk: "useSerieskao", ac: "useAllcalidad" };

/** The sites switched on in the plugin's settings (both by default; validateSettings refuses switching both off). */
export function activeSites() {
  return ALL_SITES.filter((id) => configValue(SITE_SETTING[id], true) !== false);
}

/** A setting's value, or [fallback] when it is unset or kino.config is not there (an old kit). */
function configValue(key, fallback) {
  try {
    const v = kino.config.get(key);
    return v === undefined || v === null || v === "" ? fallback : v;
  } catch (_) {
    return fallback;
  }
}

// ---------- allcalidad (a JSON API, no HTML) ----------
//
// allcalidad.re's front end reads everything from a JSON API on tmdb.allcalidad.re: search, catalogs, seasons with
// their episodes, and per title (or episode) a list of embeds `{ url, server, host, lang, quality }`. Every title
// carries its TMDB and IMDb ids, so Kino joins it with TMDB directly. The API answers JSON when asked for JSON
// (`Accept: application/json`); without it, a description of its own schema.

const AC = { id: "ac", name: "AllCalidad", api: "https://tmdb.allcalidad.re", img: "https://image.tmdb.org/t/p/" };

async function acGet(path) {
  const t0 = Date.now();
  let r;
  try {
    r = await kino.fetch(AC.api + path, { headers: { "User-Agent": UA, Accept: "application/json" }, timeoutMs: FETCH_TIMEOUT_MS });
  } catch (e) {
    kino.log(`fetch ${safe(AC.api + path)}: ${e.code || ""} ${e.message} after ${Date.now() - t0} ms`);
    report("maraton:site", "down", "site=ac", `code=${e.code || "network"}`);
    throw kino.error("unavailable", `${AC.name}: ${e.code || "network"}`, { userMessage: `${AC.name} no responde. Vuelve a intentar en un rato.` });
  }
  kino.log(`fetch ${safe(AC.api + path)} -> ${r.status} in ${Date.now() - t0} ms`);
  if (!r.ok) {
    if (r.status !== 404) report("maraton:site", "http", "site=ac", `status=${r.status}`);
    throw kino.error(r.status === 404 ? "not_found" : r.status === 429 ? "rate_limited" : "unavailable", `${AC.name} respondió ${r.status}`,
      { userMessage: r.status === 404 ? `${AC.name} ya no tiene este título.` : `${AC.name} no está respondiendo bien (${r.status}).` });
  }
  try {
    return r.json();
  } catch (_) {
    throw kino.error("unavailable", `${AC.name}: respuesta que no es JSON`, { userMessage: `${AC.name} respondió algo que no se entiende.` });
  }
}

const AC_KINDS = ["movie", "tvshow", "anime"];

/** One API title as a Kino item; null for anything that is not a movie, show or anime with a TMDB id. */
export function acItem(it) {
  if (!it || !AC_KINDS.includes(it.kind) || !Number.isInteger(it.tmdb_id) || !it.title) return null;
  const item = {
    id: `ac-${it.kind}-${it.tmdb_id}`, ref: `ac|${it.kind}/${it.tmdb_id}`, title: String(it.title).slice(0, 200),
    kind: it.kind === "movie" ? "movie" : "series",
  };
  if (it.year) item.year = String(it.year);
  if (it.poster_path) item.poster = AC.img + "w342" + it.poster_path;
  if (it.backdrop_path) item.backdrop = AC.img + "w780" + it.backdrop_path;
  if (it.overview) item.overview = String(it.overview).slice(0, 2000);
  if (typeof it.vote_average === "number" && it.vote_average > 0) item.rating = Math.round(it.vote_average * 10) / 10;
  if (it.original_title && it.original_title !== it.title) item.originalTitle = String(it.original_title).slice(0, 200);
  const ids = {};
  // An anime here is a TMDB show: the same id space as tvshow.
  ids.tmdb = it.tmdb_id;
  if (/^tt\d{5,10}$/.test(it.imdb_id || "")) ids.imdb = it.imdb_id;
  item.ids = ids;
  const genres = (it.genres || []).map((g) => g && g.title).filter(Boolean).slice(0, 5);
  if (it.kind === "anime" && !genres.includes("Anime")) genres.unshift("Anime");
  if (genres.length) item.genres = genres.slice(0, 5).map((g) => String(g).slice(0, 30));
  if (it.quality) item.quality = String(it.quality).slice(0, 20);
  // A movie's runtime (a show's is per episode: the guide says leave it out there).
  if (it.kind === "movie" && Number.isInteger(it.runtime) && it.runtime >= 1 && it.runtime <= 1000) item.runtimeMinutes = it.runtime;
  if (it.quality) item.badges = [String(it.quality).slice(0, 20)];
  return item;
}

function acItems(list) {
  const seen = new Set();
  return (list || []).map(acItem).filter((i) => i && !seen.has(i.id) && seen.add(i.id));
}

async function acSearch(q) {
  return acItems((await acGet(`/v1/search?q=${encodeURIComponent(q)}`)).items);
}

/** `ac|tvshow/70523` -> every season's episodes (in parallel), refs `ac|tvshow/70523/<season>/<episode>`. */
async function acEpisodes(ref) {
  const [kind, id] = ref.slice(3).split("/");
  if (!AC_KINDS.includes(kind) || kind === "movie" || !/^\d+$/.test(id || "")) throw kino.error("not_found", "referencia inválida");
  const item = (await acGet(`/v1/items/${kind}/${id}`)).item || {};
  const seasons = (item.episode_seasons || []).map((x) => x.season).filter((n) => Number.isInteger(n) && n >= 1).slice(0, 50);
  const lists = await Promise.all(seasons.map(async (n) => {
    try {
      return ((await acGet(`/v1/items/${kind}/${id}/seasons/${n}`)).season || {}).episodes || [];
    } catch (e) {
      kino.log(`episodes ac ${kind}/${id} T${n}: ${e.code || ""} ${e.message}`);
      return [];
    }
  }));
  const episodes = [];
  for (const e of [].concat(...lists)) {
    if (!e || !Number.isInteger(e.season) || !Number.isInteger(e.episode) || e.episode < 1 || e.playable === false) continue;
    const ep = { season: e.season, number: e.episode, ref: `ac|${kind}/${id}/${e.season}/${e.episode}` };
    if (e.title) ep.title = String(e.title).slice(0, 200);
    if (e.overview) ep.overview = String(e.overview).slice(0, 2000);
    if (e.still_path) ep.still = AC.img + "w300" + e.still_path;
    if (/^\d{4}-\d{2}-\d{2}$/.test(e.air_date || "")) ep.airDate = e.air_date;
    if (Number.isInteger(e.runtime) && e.runtime >= 1 && e.runtime <= 1000) ep.runtimeMinutes = e.runtime;
    episodes.push(ep);
  }
  episodes.sort((a, b) => a.season - b.season || a.number - b.number);
  const base = acItem(item) || {};
  const series = {};
  for (const k of ["title", "poster", "backdrop", "overview", "year", "ids", "genres"]) if (base[k]) series[k] = base[k];
  kino.log(`episodes ${ref}: ${episodes.length} in ${seasons.length} season(s)`);
  return { series, episodes };
}

/** A playback answer's embeds as resolve's server list `{ lang, server, url }` (server named after its host). */
export function acServers(answer) {
  return ((answer && answer.embeds) || [])
    .filter((e) => e && /^https:\/\//.test(e.url || ""))
    .map((e) => ({ lang: e.lang || "", server: String(e.host || startHost(e.url)).toLowerCase().split(".")[0], url: e.url }));
}

/** `ac|movie/603` or `ac|tvshow/70523/1/2` -> its playback path. */
export function acPlaybackPath(ref) {
  const parts = parseServerRef(ref).base.slice(3).split("/");
  const [kind, id, season, episode] = parts;
  if (!AC_KINDS.includes(kind) || !/^\d+$/.test(id || "")) throw kino.error("not_found", "referencia inválida");
  if (kind === "movie") return `/v1/playback/movie/${id}`;
  if (!/^\d+$/.test(season || "") || !/^\d+$/.test(episode || "")) throw kino.error("not_found", "falta el episodio");
  return `/v1/playback/${kind}/${id}?season=${season}&episode=${episode}`;
}

// ---------- telemetry ----------
//
// With "telemetry": true, a failed call's own kino.log lines already reach Kino's error board. kino.log.report is for
// what WORKED but degraded: a site that is down while the others answered, a Cloudflare wall, an embed host whose
// player never asked for video, an embed69 page that yielded no server. Only codes and counts go in a report — our
// own site and server names, a status number — never a URL, a title or anything the person typed (Kino scrubs lines
// too, and allows one report per area an hour).

/** `area` is namespaced ("maraton:site"); the rest are short codes. No-op where kino.log.report does not exist. */
export function report(area, ...codes) {
  try {
    if (kino.log && typeof kino.log.report === "function") kino.log.report(area, ...codes);
    else kino.log(area, ...codes);
  } catch (_) { /* a report never breaks a call */ }
}

const siteCode = (site) => Object.keys(SITES).find((k) => SITES[k] === site) || "?";

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

/**
 * A Cloudflare (or similar) interstitial instead of the page. Not the passive "challenge-platform" beacon some zones
 * add to every real page (hacktorrent-mirror measured that on sololatino): the interstitial's own title or its
 * `_cf_chl_opt` bootstrap.
 */
export function looksLikeChallenge(html) {
  const h = String(html || "");
  return /<title>\s*just a moment/i.test(h) || /_cf_chl_opt/.test(h) || /<title>\s*attention required/i.test(h);
}

async function page(site, path) {
  const t0 = Date.now();
  let r;
  try {
    r = await kino.fetch(abs(site, path), { headers: { "User-Agent": UA, Accept: "text/html" }, timeoutMs: FETCH_TIMEOUT_MS });
  } catch (e) {
    kino.log(`fetch ${safe(abs(site, path))}: ${e.code || ""} ${e.message} after ${Date.now() - t0} ms`);
    report("maraton:site", "down", `site=${siteCode(site)}`, `code=${e.code || "network"}`);
    throw kino.error("unavailable", `${site.name}: ${e.code || "network"}`, { userMessage: `${site.name} no responde. Vuelve a intentar en un rato.` });
  }
  kino.log(`fetch ${safe(abs(site, path))} -> ${r.status} in ${Date.now() - t0} ms`);
  if (!r.ok) {
    if (r.status !== 404) report("maraton:site", "http", `site=${siteCode(site)}`, `status=${r.status}`);
    throw kino.error(r.status === 404 ? "not_found" : r.status === 429 ? "rate_limited" : "unavailable", `${site.name} respondió ${r.status}`,
      { userMessage: r.status === 404 ? `${site.name} ya no tiene esta página.` : `${site.name} no está respondiendo bien (${r.status}).` });
  }
  const html = r.text();
  // Sites behind Cloudflare at times answer an interstitial: "unavailable", never parsed as content.
  if (looksLikeChallenge(html)) report("maraton:site", "cloudflare", `site=${siteCode(site)}`);
  if (looksLikeChallenge(html)) throw kino.error("unavailable", `${site.name} pide verificación de Cloudflare`, { userMessage: `${site.name} está pidiendo una verificación que no se puede pasar desde aquí.` });
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
    if (!/^\/(serie|anime|pelicula)\//.test(path) || seen.has(path)) continue;
    seen.add(path);
    // Search and catalogs say <h2>, the home page's "Recién agregado" says <h3>.
    const title = text((/<h[23] class="card__title">([\s\S]*?)<\/h[23]>/i.exec(block) || [])[1]);
    if (!title) continue;
    const img = /<img[^>]+>/i.exec(block);
    const year = text((/card__badge--year">([\s\S]*?)</i.exec(block) || [])[1]);
    const kind = path.startsWith("/pelicula/") ? "movie" : "series";
    const item = { id: idOf(siteId, path), ref: `${siteId}|${path}`, title, kind };
    const poster = img ? attr(img[0], "src") : "";
    if (/^https?:\/\//.test(poster)) item.poster = poster;
    if (/^\d{4}$/.test(year)) item.year = year;
    if (path.startsWith("/anime/")) item.genres = ["Anime"];
    // "★ 7.7": the site's TMDB rating (0 to 10). A missing or out-of-range one is left out, never guessed.
    const rating = parseFloat(text((/card__rating">([\s\S]*?)<\/span>/i.exec(block) || [])[1]));
    if (rating > 0 && rating <= 10) item.rating = Math.round(rating * 10) / 10;
    out.push(item);
  }
  return out;
}

function cards(siteId, html) {
  return skCards(siteId, html);
}

// ---------- search / home / browse ----------

/**
 * `scopedSearch`: what a "Ver más" page's own search field asks (`query.within` = that page's browse ref). A catalog
 * row is answered with the site's search, kept to that row's site and kind (a "Series" row never shows a movie); a
 * genre page is answered with `null`, which tells Kino to filter the titles it already loaded: neither site can search
 * inside a genre, and serieskao's search results carry no genres to filter by.
 */
export function scopeOf(within) {
  const [head, siteId, kind] = String(within || "").split("|");
  if (head !== "row" || !ALL_SITES.includes(siteId)) return null;
  if (siteId === "sk" && SITES.sk.catalog[kind]) return { siteId, keep: (i) => i.ref.startsWith(`sk|/${kind}/`) };
  if (siteId === AC.id && AC_KINDS.includes(kind)) return { siteId, keep: (i) => i.ref.startsWith(`ac|${kind}/`) };
  return null;
}

async function scopedSearch(query, q) {
  const scope = scopeOf(query.within);
  if (!scope || !activeSites().includes(scope.siteId)) return null;
  const found = scope.siteId === AC.id ? await acSearch(q) : cards("sk", await page(SITES.sk, SITES.sk.search(q)));
  const kept = found.filter(scope.keep);
  kino.log(`search within ${scope.siteId} row: ${found.length} found, ${kept.length} in the row`);
  return kino.rank.sortBySimilarity(kept, q, (it) => it.title).slice(0, 100);
}

export async function search(query) {
  const q = String((query && query.q) || "").trim();
  if (!q) return [];
  if (query.within) return scopedSearch(query, q);
  // The guide's advice: the title Kino typed, its head (kino.rank.shortQuery), then TMDB's original title and the
  // other titles Kino knows, tried in that order until a site answers something. At most four tries per site.
  const tries = [q, kino.rank.shortQuery(q), query.originalTitle, ...(query.altTitles || [])]
    .map((t) => String(t || "").trim()).filter((v, i, a) => v && a.indexOf(v) === i).slice(0, 4);
  const failed = [];
  const sites = activeSites();
  const lists = await Promise.all(sites.map(async (siteId) => {
    if (siteId === AC.id) {
      for (const t of tries) {
        try {
          const t0 = Date.now();
          const found = await acSearch(t);
          kino.log(`search ac "${t.slice(0, 60)}": ${found.length} results in ${Date.now() - t0} ms`);
          if (found.length) return found;
        } catch (e) {
          kino.log(`search ac: ${e.code || ""} ${e.message}`);
          failed.push(e);
          return [];
        }
      }
      return [];
    }
    const site = SITES[siteId];
    for (const t of tries) {
      try {
        const t0 = Date.now();
        const found = cards(siteId, await page(site, site.search(t)));
        kino.log(`search ${siteId} "${t.slice(0, 60)}": ${found.length} results in ${Date.now() - t0} ms${found.length ? `, first ${found[0].ref}` : ""}`);
        if (found.length) return found;
      } catch (e) {
        kino.log(`search ${siteId}: ${e.code || ""} ${e.message}`);
        failed.push(e);
        return [];
      }
    }
    return [];
  }));
  const all = [].concat(...lists);
  // Every site failed: say so, instead of an empty "no results" that reads as "it does not exist".
  if (!all.length && failed.length === sites.length) {
    throw kino.error("unavailable", "ningún sitio respondió", { userMessage: "Los sitios de Maratón no están respondiendo. Vuelve a intentar en un rato." });
  }
  const ranked = kino.rank.filterRelevant(kino.rank.sortBySimilarity(all, q, (it) => it.title), q, (it) => it.title).slice(0, 60);
  kino.log(`search "${q.slice(0, 60)}": ${all.length} found, ${ranked.length} kept${ranked.length ? `, best ${ranked[0].ref}` : ""}`);
  return ranked;
}

/**
 * serieskao's home "Últimos Episodios": one card per new episode. Each becomes its SERIES (Kino opens the show, the
 * person picks the episode), once per show, with the newest episode as a badge ("T1 E3").
 */
export function latestEpisodes(siteId, html) {
  const site = SITES[siteId];
  const out = [];
  const seen = new Set();
  const rx = /<article class="episode-card">([\s\S]*?)<\/article>/gi;
  let m;
  while ((m = rx.exec(html))) {
    const block = m[1];
    const href = (/<a href="([^"]+)"/i.exec(block) || [])[1];
    if (!href) continue;
    const path = pathOf(site, decode(href)).replace(/\/temporada\/\d+\/capitulo\/\d+\/?$/, "");
    if (!/^\/(serie|anime)\/[^/]+$/.test(path) || seen.has(path)) continue;
    seen.add(path);
    const title = text((/episode-card__title">([\s\S]*?)<\/h3>/i.exec(block) || [])[1]);
    if (!title) continue;
    const item = { id: idOf(siteId, path), ref: `${siteId}|${path}`, title, kind: "series" };
    const img = /<img[^>]+>/i.exec(block);
    const poster = img ? attr(img[0], "src") : "";
    if (/^https?:\/\//.test(poster)) item.poster = poster;
    const badge = text((/episode-card__badge">([\s\S]*?)</i.exec(block) || [])[1]);
    item.badges = badge ? ["Nuevo episodio", badge.slice(0, 20)] : ["Nuevo episodio"];
    if (path.startsWith("/anime/")) item.genres = ["Anime"];
    out.push(item);
  }
  return out;
}

/** The home page's "Recién Agregado" section only (its cards, movies included). */
function recentlyAdded(siteId, html) {
  const i = html.search(/section__title">\s*Recién Agregado/i);
  return i < 0 ? [] : cards(siteId, html.slice(i));
}

// ---------- rows (Home, the plugin's own page) ----------

/** A catalog's first page as a row with "Ver más"; null when it failed or came back empty (logged, never thrown). */
async function catalogRow(siteId, kind, title, genre) {
  try {
    const items = siteId === AC.id
      ? acItems((await acGet(`/v1/items?kind=${kind}&page=1`)).items)
      : cards(siteId, await page(SITES[siteId], SITES[siteId].catalog[kind] + "1"));
    return items.length ? { id: `${siteId}-${kind}`, title, items, ref: `row|${siteId}|${kind}`, genre } : null;
  } catch (e) {
    kino.log(`row ${siteId}/${kind}: ${e.code || ""} ${e.message}`);
    return null;
  }
}

/** serieskao's front page: "Nuevos episodios" and "Recién agregado" (no "Ver más": the site has no paged list of them). */
async function frontRows() {
  try {
    const html = await page(SITES.sk, "/");
    const rows = [];
    const latest = latestEpisodes("sk", html);
    if (latest.length) rows.push({ id: "sk-latest", title: "Nuevos episodios", items: latest, genre: "series" });
    const recent = recentlyAdded("sk", html);
    if (recent.length) rows.push({ id: "sk-recent", title: "Recién agregado", items: recent });
    return rows;
  } catch (e) {
    kino.log(`row sk/front: ${e.code || ""} ${e.message}`);
    return [];
  }
}

/**
 * What each kind of content is called on each site, for Home and the plugin page's tabs. `genre` is the SDK's closed
 * vocabulary (contract.json "genres"): it is what lines rows up with other plugins' in Categorías.
 */
const ROWS = {
  series: [{ siteId: "sk", kind: "serie", title: "Series" }, { siteId: "ac", kind: "tvshow", title: "Series recientes" }],
  anime: [{ siteId: "sk", kind: "anime", title: "Anime" }, { siteId: "ac", kind: "anime", title: "Anime reciente" }],
  peliculas: [{ siteId: "sk", kind: "pelicula", title: "Películas" }, { siteId: "ac", kind: "movie", title: "Películas recientes" }],
};

async function rowsOf(groups, sites) {
  const wanted = [];
  for (const g of groups) for (const r of ROWS[g]) if (sites.includes(r.siteId)) wanted.push({ ...r, genre: g });
  return (await Promise.all(wanted.map((r) => catalogRow(r.siteId, r.kind, r.title, r.genre)))).filter(Boolean);
}

export async function home() {
  const sites = activeSites();
  const [front, rest] = await Promise.all([
    sites.includes("sk") ? frontRows() : Promise.resolve([]),
    rowsOf(["series", "anime", "peliculas"], sites),
  ]);
  const out = [...front, ...rest];
  kino.log(`home: ${out.length} rows [${out.map((r) => `${r.id}:${r.items.length}`).join(", ")}]`);
  return out;
}

// ---------- genres (Categorías tiles, browse, the Géneros tab) ----------

/**
 * One tile per genre both sites can list, with each site's own slug (serieskao: /generos/<slug>; allcalidad: the
 * genre taxonomy's slug, accents included). Read from both sites' genre lists on 2026-10-04; a missing slug means that
 * site has no such genre. Static on purpose: Categorías asks for tiles often and must not wait on two sites.
 */
export const GENRES = [
  { key: "accion", title: "Acción", sk: "accion", ac: "acción" },
  { key: "comedia", title: "Comedia", sk: "comedia", ac: "comedia" },
  { key: "drama", title: "Drama", sk: "drama", ac: "drama" },
  { key: "terror", title: "Terror", sk: "terror", ac: "terror" },
  { key: "animacion", title: "Animación", sk: "animacion", ac: "animación" },
  { key: "ciencia-ficcion", title: "Ciencia ficción", sk: "ciencia-ficcion", ac: "ciencia-ficción" },
  { key: "aventura", title: "Aventura", sk: "aventura", ac: "aventura" },
  { key: "suspense", title: "Suspenso", sk: "suspense", ac: "suspense" },
  { key: "crimen", title: "Crimen", sk: "crimen", ac: "crimen" },
  { key: "romance", title: "Romance", sk: "romance", ac: "romance" },
  { key: "misterio", title: "Misterio", sk: "misterio", ac: "misterio" },
  { key: "fantasia", title: "Fantasía", sk: "fantasia", ac: "fantasía" },
  { key: "familia", title: "Familia", sk: "familia", ac: "familia" },
  { key: "documental", title: "Documental", sk: "documental", ac: "documental" },
  { key: "historia", title: "Historia", sk: "historia", ac: "historia" },
  { key: "belica", title: "Bélica", sk: "belica", ac: "bélica" },
  { key: "guerra", title: "Guerra y política", sk: "guerra", ac: "war-politics" },
  { key: "western", title: "Western", sk: "western", ac: "western" },
  { key: "dorama", title: "Doramas", sk: "dorama" },
  { key: "musica", title: "Música", ac: "música" },
  { key: "infantil", title: "Infantil", ac: "kids" },
  { key: "reality", title: "Reality", ac: "reality" },
];

const genreByKey = (key) => GENRES.find((g) => g.key === key);

/** The tiles of the active sites (Categorías ▸ Maratón), each opening `browse("genre|<key>")`. At most 24 (SDK cap). */
export async function categories() {
  const sites = activeSites();
  return GENRES.filter((g) => sites.some((id) => g[id])).slice(0, 24).map((g) => ({ id: `genre-${g.key}`, title: g.title, ref: `genre|${g.key}` }));
}

/**
 * One page of a genre, both sites at once, interleaved so neither buries the other; the cursor is the page number
 * (both sites page by 24). A site that fails or has no such genre just adds nothing.
 */
async function genrePage(key, n) {
  const g = genreByKey(key);
  if (!g) throw kino.error("not_found", "género desconocido");
  const sites = activeSites();
  const [sk, ac] = await Promise.all([
    sites.includes("sk") && g.sk
      ? page(SITES.sk, `/generos/${g.sk}?page=${n}`).then((html) => cards("sk", html)).catch((e) => { kino.log(`genre sk/${key}: ${e.code || ""} ${e.message}`); return []; })
      : Promise.resolve([]),
    sites.includes("ac") && g.ac
      ? acGet(`/v1/taxonomies/genre/${encodeURIComponent(g.ac)}/items?page=${n}`).then((a) => acItems(a.items)).catch((e) => { kino.log(`genre ac/${key}: ${e.code || ""} ${e.message}`); return []; })
      : Promise.resolve([]),
  ]);
  const items = [];
  for (let i = 0; i < Math.max(sk.length, ac.length); i++) {
    if (sk[i]) items.push(sk[i]);
    if (ac[i]) items.push(ac[i]);
  }
  kino.log(`genre ${key} page ${n}: ${sk.length} + ${ac.length}`);
  return items.slice(0, 100);
}

// ---------- the plugin's own page (Inicio chip on the phone, sidebar entry on the TV) ----------

const TABS = [
  { id: "series", label: "Series" },
  { id: "anime", label: "Anime" },
  { id: "peliculas", label: "Películas" },
  { id: "generos", label: "Géneros" },
];
/** The genres the Géneros tab shows as rows (each with "Ver más"); the rest are in Categorías. */
const TAB_GENRES = ["accion", "comedia", "drama", "terror", "animacion", "ciencia-ficcion"];

export async function section({ tab } = {}) {
  const chosen = TABS.some((t) => t.id === tab) ? tab : "series";
  const sites = activeSites();
  let rows;
  if (chosen === "generos") {
    rows = (await Promise.all(TAB_GENRES.map(async (key) => {
      const items = await genrePage(key, 1);
      return items.length ? { id: `genre-${key}`, title: genreByKey(key).title, items: items.slice(0, 30), ref: `genre|${key}` } : null;
    }))).filter(Boolean);
  } else {
    rows = await rowsOf([chosen], sites);
    if (chosen === "series" && sites.includes("sk")) rows = [...(await frontRows()), ...rows];
  }
  const hero = {
    title: "Maratón",
    text: `Series, anime y películas en ${({ lat: "latino", esp: "castellano", sub: "versión subtitulada" })[preferredLang()]}. Cambia el idioma, los sitios y el servidor en Ajustes ▸ Maratón.`,
  };
  kino.log(`section ${chosen}: ${rows.length} rows`);
  return { tabs: TABS, tab: chosen, hero, rows };
}

export async function browse(ref, cursor) {
  if (String(ref).startsWith("genre|")) {
    const n = Math.max(1, parseInt(cursor || "1", 10) || 1);
    const items = await genrePage(String(ref).slice(6), n);
    return items.length ? { items, next: String(n + 1) } : { items };
  }
  const [, siteId, kind] = String(ref).split("|");
  if (siteId === AC.id) {
    if (!AC_KINDS.includes(kind)) throw kino.error("not_found", "fila desconocida");
    const n = Math.max(1, parseInt(cursor || "1", 10) || 1);
    const answer = await acGet(`/v1/items?kind=${kind}&page=${n}`);
    const items = acItems(answer.items);
    const more = answer.pagination && answer.pagination.has_next;
    return more && items.length ? { items, next: String(n + 1) } : { items };
  }
  const site = SITES[siteId];
  if (!site || !site.catalog[kind]) throw kino.error("not_found", "fila desconocida");
  const n = Math.max(1, parseInt(cursor || "1", 10) || 1);
  const items = cards(siteId, await page(site, site.catalog[kind] + n));
  return items.length ? { items, next: String(n + 1) } : { items };
}

// ---------- episodes ----------

/**
 * `<episodeRef>#<lang>/<server>` addresses ONE server of an episode (`sk|/serie/dark/temporada/1/capitulo/1#esp/voe`):
 * what a labeled alternative will hand back to resolve once the SDK resolves alternatives lazily. Without `#`, resolve
 * picks the server itself.
 */
export function serverRef(ref, f) {
  return `${String(ref).split("#")[0]}#${langOf(f.lang)}/${String(f.server || "").toLowerCase()}`;
}

export function parseServerRef(ref) {
  const [base, frag] = String(ref).split("#");
  const m = /^(lat|esp|sub)\/([a-z0-9_-]{1,40})$/.exec(frag || "");
  return { base, only: m ? { lang: m[1], server: m[2] } : null };
}

function splitRef(ref) {
  const s = parseServerRef(ref).base;
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
  if (String(ref).startsWith("ac|")) return acEpisodes(String(ref));
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
  // Genres and rating from the page's own hero (TMDB's, translated by the site).
  const genres = [];
  const grx = /detail-hero__genre">([\s\S]*?)<\/a>/gi;
  let gm;
  while ((gm = grx.exec(html)) && genres.length < 5) genres.push(text(gm[1]).slice(0, 30));
  if (genres.length) series.genres = genres;
  const year = /"datePublished":\s*"?(\d{4})/.exec(html);
  if (year) series.year = year[1];
  // The player pages are keyed by IMDb id (/vidurl/tt5753856-1x01/): Kino joins the series with TMDB through it.
  // The series page has no player, so the first episode's page is read once for it.
  try {
    const first = await page(site, pathOf(site, list[0].ref.split("|")[1]));
    const imdb = /\/(?:vidurl|video)\/(tt\d{5,10})-/i.exec(first);
    if (imdb) {
      series.ids = { imdb: imdb[1] };
      // For meta(): Kino may later ask about this IMDb id from its own info page.
      storageSet(imdbKey(imdb[1]), { ref }, IMDB_MEMORY_MS);
    }
    kino.log(`episodes ${siteId}: IMDb ${imdb ? imdb[1] : "not found"}`);
  } catch (e) {
    kino.log(`episodes ${siteId}: no IMDb id (${e.code || ""} ${e.message})`);
  }
  return { series, episodes: list };
}

// ---------- what a capture saw: the film, not the ad ----------
//
// Measured on the Redmi (allcalidad Matrix, 2026-10-04): an embed's player first loaded a casino preroll MP4, the capture
// handed it over, and Kino played the ad as the movie. These players stream the real video as HLS; their ads come as
// short MP4s from ad servers. So: manifests win, and an MP4 is only kept when the capture saw no manifest at all and it
// does not look like an ad.

/** Words that only an ad's URL carries (whole tokens of host and path; never "ad" alone: segment CDNs use it). */
const AD_TOKENS = new Set([
  "ads", "adserver", "adservice", "advert", "adverts", "advertising", "vast", "vpaid", "preroll", "prerolls", "midroll",
  "sponsor", "sponsored", "banner", "banners", "promo", "casino", "bet", "bets", "betting", "apuesta", "apuestas",
  "jugabet", "bet365", "codere", "rushbet", "wplay", "betplay", "1xbet", "stake", "slots",
]);
/** Ad networks seen in embed players, matched as the host or a parent of it. */
const AD_HOSTS = [
  "doubleclick.net", "googlesyndication.com", "imasdk.googleapis.com", "adnxs.com", "exoclick.com", "juicyads.com",
  "popads.net", "propellerads.com", "trafficjunky.net", "adsterra.com", "a-ads.com", "hilltopads.net", "clickadu.com",
  "tsyndicate.com", "magsrv.com", "realsrv.com", "onclickads.net",
];

export function looksLikeAd(url) {
  const m = /^https?:\/\/([^/?#]+)([^?#]*)/i.exec(String(url || ""));
  if (!m) return false;
  const host = m[1].toLowerCase().replace(/:\d+$/, "");
  if (AD_HOSTS.some((h) => host === h || host.endsWith("." + h))) return true;
  const tokens = (host + " " + m[2]).toLowerCase().split(/[^a-z0-9]+/);
  return tokens.some((t) => AD_TOKENS.has(t) || /casino|betting|jugabet|preroll/.test(t));
}

const isManifest = (m) => /\.m3u8(\?|$)|\.mpd(\?|$)|master\.txt/i.test(m.url) || /mpegurl|dash/i.test(m.mime || "");
const isMp4 = (m) => /\.mp4(\?|$)/i.test(m.url) || /video\/mp4/i.test(m.mime || "");

/** Below this an MP4 is a preroll, not a film or an episode (a 45-minute episode at the lowest quality is > 100 MB). */
const MIN_FILM_MP4_BYTES = 30 * 1024 * 1024;

/**
 * The capture's media without ads: anything [looksLikeAd] out; when a manifest is there, every MP4 out (never the main
 * copy, never an alternative); when only MP4s are left, one a HEAD says is under [MIN_FILM_MP4_BYTES] out too. A HEAD
 * that cannot be made (a host this plugin may not fetch) keeps the MP4: better a copy than nothing.
 */
export async function filmMedia(media) {
  const clean = (media || []).filter((m) => m && m.url && !looksLikeAd(m.url));
  const dropped = (media || []).length - clean.length;
  if (clean.some(isManifest)) {
    const out = clean.filter((m) => !isMp4(m));
    if (dropped || out.length < clean.length) kino.log(`media: ${dropped} ad(s) and ${clean.length - out.length} mp4(s) dropped next to a manifest`);
    return out;
  }
  const out = [];
  for (const m of clean) {
    if (!isMp4(m)) { out.push(m); continue; }
    const size = await contentLength(m);
    if (size !== null && size < MIN_FILM_MP4_BYTES) {
      kino.log(`media: ${safe(m.url)} is ${Math.round(size / 1048576)} MB, a preroll: dropped`);
      continue;
    }
    out.push(m);
  }
  if (dropped) kino.log(`media: ${dropped} ad(s) dropped`);
  return out;
}

async function contentLength(m) {
  try {
    const r = await kino.fetch(m.url, { method: "HEAD", headers: m.headers || {}, timeoutMs: 4000 });
    const v = r.headers && (r.headers["content-length"] || r.headers["Content-Length"]);
    const n = parseInt(v, 10);
    return r.ok && n > 0 ? n : null;
  } catch (_) {
    return null;
  }
}

// ---------- servers that failed lately ----------

/** How long a server that failed stays at the back of the line (a CDN unreachable from this network, a dead host). */
const FAILED_SERVER_MS = 6 * 3600 * 1000;
const failedKey = (siteId) => "failed:" + siteId;

export function failedServers(siteId, nowMs = Date.now()) {
  const all = storageGet(failedKey(siteId)) || {};
  return new Set(Object.keys(all).filter((k) => all[k] > nowMs));
}

function markServer(siteId, f, failed) {
  const name = serverName(f);
  if (name === "episode_page") return;
  const all = storageGet(failedKey(siteId)) || {};
  const now = Date.now();
  for (const k of Object.keys(all)) if (all[k] <= now) delete all[k];
  if (failed) all[name] = now + FAILED_SERVER_MS;
  else delete all[name];
  storageSet(failedKey(siteId), all, FAILED_SERVER_MS);
}

/** [list] with every server in [failed] moved to the end, in the same relative order. */
export function lastIfFailed(list, failed) {
  return [...list.filter((f) => !failed.has(serverName(f))), ...list.filter((f) => failed.has(serverName(f)))];
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
/** Every page fetch: a site that hangs must not eat resolve's budget (kino.fetch's own default is 15 s). */
const FETCH_TIMEOUT_MS = 10000;
const CAPTURE_MS = 25000;
const CAPTURE_MS_WITH_MORE = 15000;
/**
 * resolve's own deadline for starting one more page, under Kino's 75 s for a browser plugin: what is left after it
 * goes to that last page, and a page is not started with less than [MIN_CAPTURE_MS].
 */
const RESOLVE_BUDGET_MS = 68000;
const MIN_CAPTURE_MS = 6000;

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

/**
 * Which embed hosts to try first, measured on a Fire TV (Dark 1x01): streamwish (hglink.to) handed over its m3u8 in
 * 9 s, vidhide (morencius.com) never requested video in 25 s. Unknown servers go between the two ends.
 */
const SERVER_PREFERENCE = [
  { rx: /streamwish|hglink/i, rank: 0 },
  { rx: /voe/i, rank: 1 },
  { rx: /vidhide|morencius/i, rank: 3 },
];
const UNKNOWN_SERVER_RANK = 2;

function serverRank(f) {
  const hit = SERVER_PREFERENCE.find((p) => p.rx.test(f.server || "") || p.rx.test(startHost(f.url)));
  return hit ? hit.rank : UNKNOWN_SERVER_RANK;
}

/**
 * The servers the "Probar primero" setting can name, matched by server name or host (streamwish answers on
 * hglink.to, vidhide on morencius.com). [SERVER_LABEL] is how the status line names them.
 */
const SERVER_MATCH = {
  streamwish: /streamwish|hglink/i, voe: /voe/i, vidhide: /vidhide|morencius/i, vimeos: /vimeos/i, goodstream: /goodstream/i,
};
const SERVER_LABEL = { streamwish: "Streamwish", voe: "Voe", vidhide: "Vidhide", vimeos: "Vimeos", goodstream: "Goodstream" };

/** Our name for a server ("streamwish"), else "other": a code safe to report. */
function serverName(f) {
  return Object.keys(SERVER_MATCH).find((k) => serverMatches(f, k)) || (f && f.lang ? "other" : "episode_page");
}

function serverMatches(f, name) {
  const rx = SERVER_MATCH[name];
  return !!rx && (rx.test(f.server || "") || rx.test(startHost(f.url)));
}

/** The three audio families an embed69 section's `video_language` falls into, in the default order. */
export const LANGS = ["lat", "esp", "sub"];
const LANG_LABEL = { lat: "Latino", esp: "Castellano", sub: "Subtitulado" };

/** `LAT`, `ESP`/`CAST`, `SUB`/`VOSE`… → `lat` / `esp` / `sub`; anything else counts as `sub` (original audio). */
export function langOf(raw) {
  const v = String(raw || "");
  if (/lat/i.test(v)) return "lat";
  if (/esp|cas|spa/i.test(v)) return "esp";
  return "sub";
}

/**
 * The person's language first ("Idioma preferido", default Latino), then the other two in [LANGS] order; within a
 * language the server that last produced a video on this site ([remembered]), then [SERVER_PREFERENCE]; the page's
 * own order breaks ties.
 */
export function rankServers(list, preferred = "lat", remembered = "", chosen = "auto") {
  const langOrder = [preferred, ...LANGS.filter((l) => l !== preferred)];
  const langRank = (f) => { const i = langOrder.indexOf(langOf(f.lang)); return i < 0 ? LANGS.length : i; };
  // "Probar primero" (a setting) beats what worked last, which beats the measured preference.
  const pick = (f) => (chosen && chosen !== "auto" && serverMatches(f, chosen) ? 0 : 1);
  const memo = (f) => (remembered && (f.server || "").toLowerCase() === remembered ? 0 : 1);
  return list
    .map((f, i) => ({ f, i }))
    .sort((a, b) => (langRank(a.f) - langRank(b.f)) || (pick(a.f) - pick(b.f)) || (memo(a.f) - memo(b.f)) || (serverRank(a.f) - serverRank(b.f)) || (a.i - b.i))
    .map((x) => x.f);
}

/** A page gets the whole budget only when it is the last one left; before that, a dead server must not eat it all. */
export function captureTimeout(pagesLeftAfterThis) {
  return pagesLeftAfterThis > 0 ? CAPTURE_MS_WITH_MORE : CAPTURE_MS;
}

/** Every embed69 server behind the episode's own player pages (`/vidurl/…`), or [] when there is none. */
async function fastServers(site, episodeUrl, servers) {
  const out = [];
  for (const s of servers.filter((u) => u.startsWith(site.base))) {
    const t0 = Date.now();
    let r;
    try {
      r = await kino.fetch(s, { headers: { "User-Agent": UA, Accept: "text/html", Referer: episodeUrl }, timeoutMs: FETCH_TIMEOUT_MS });
    } catch (e) {
      kino.log(`embed69 ${safe(s)}: ${e.code || ""} ${e.message}`);
      continue;
    }
    if (!r.ok) {
      kino.log(`embed69 ${safe(s)} -> ${r.status}`);
      continue;
    }
    const found = embed69Servers(r.text());
    // The page loaded but nothing decrypted: embed69 changed its page (key, proof of work or dataLink).
    if (!found.length) report("maraton:embed69", "no_servers", `ms=${Date.now() - t0}`);
    kino.log(`embed69 ${safe(s)}: ${found.length} server(s) in ${Date.now() - t0} ms [${found.map((f) => `${f.lang}/${f.server}@${startHost(f.url)}`).join(", ")}]`);
    for (const f of found) if (!out.some((o) => o.url === f.url)) out.push(f);
  }
  return out;
}

// ---------- what resolve remembers (kino.storage) ----------

const STREAM_CACHE_MAX_MS = 4 * 3600 * 1000;
const STREAM_CACHE_UNKNOWN_MS = 30 * 60 * 1000;
const EXPIRY_MARGIN_S = 10 * 60;
const MAX_EXPIRES_S = 86400;
const MIN_EXPIRES_S = 30;

/**
 * When a captured URL stops working, in seconds from [nowS], or null when it does not say. The CDNs these embeds use
 * put a Unix time in the path (`/stream/<token>/<x>/1791135524/<id>/master.m3u8`): measured 2026-10-04, that time was
 * 12 h after the capture and the URL answered until then. A time in the past or more than a week ahead is not one.
 */
export function expiresInOf(url, nowS = Math.floor(Date.now() / 1000)) {
  const path = String(url).split(/[?#]/)[0];
  const times = (path.match(/(?:^|\/)(1\d{9})(?=\/|$)/g) || []).map((t) => parseInt(t.replace("/", ""), 10));
  const t = times.find((x) => x > nowS + MIN_EXPIRES_S && x < nowS + 7 * 86400);
  return t ? Math.min(MAX_EXPIRES_S, t - nowS) : null;
}

function storageGet(key) {
  try {
    const v = kino.storage.get(key);
    return v == null ? null : JSON.parse(v);
  } catch (_) {
    return null;
  }
}

function storageSet(key, value, ttlMs) {
  try { kino.storage.set(key, JSON.stringify(value), ttlMs ? { ttlMs: Math.max(1, Math.floor(ttlMs)) } : undefined); } catch (e) { kino.log(`storage: ${e.message}`); }
}

function storageRemove(key) {
  try { kino.storage.remove(key); } catch (_) { /* nothing to drop */ }
}

const streamKey = (ref) => "stream:" + ref;
const imdbKey = (imdb) => "imdb:" + imdb;
const IMDB_MEMORY_MS = 30 * 86400 * 1000 - 1;
const serverKey = (siteId) => "server:" + siteId;

/** The cached stream's own expiry, rewritten for how much of it is left; null when it is (nearly) gone. */
export function fromCache(entry, nowMs = Date.now()) {
  if (!entry || !entry.stream || !entry.until || entry.until <= nowMs) return null;
  const stream = { ...entry.stream };
  if (entry.expiresAtMs) {
    const left = Math.floor((entry.expiresAtMs - nowMs) / 1000);
    if (left < MIN_EXPIRES_S) return null;
    stream.expiresInSeconds = Math.min(MAX_EXPIRES_S, left);
  }
  return stream;
}

function preferredLang() {
  const v = configValue("lang", "lat");
  return LANGS.includes(v) ? v : "lat";
}

// ---------- resolve ----------

/** At most this many lazy copies: the automatic fallback walks them in order, so a long tail only delays the error. */
const MAX_LAZY = 3;

/** "Latino · Streamwish": how the player's Servidor list names one copy (at most 48 characters). */
export function copyLabel(f) {
  if (!f || !f.url) return "";
  const known = Object.keys(SERVER_MATCH).find((k) => serverMatches(f, k));
  const name = known ? SERVER_LABEL[known] : (f.server || startHost(f.url) || "Servidor");
  const lang = f.lang ? LANG_LABEL[langOf(f.lang)] : "";
  return (lang ? `${lang} · ${name}` : String(name)).slice(0, 48);
}

/**
 * The other copies of a title as alternatives, best first, at most 8: first the extra playlists the same page asked
 * for (a variant of the copy that is playing, concrete URLs), then every other server and language as a LAZY copy
 * `{ label, ref }` that Kino resolves through `resolve(<ref>#<lang>/<server>)` only if the person picks it in the
 * player's Servidor list or the fallback reaches it — so the first play is never slower for offering them.
 */
export function alternativesOf(rest, playing, others, ref, failed = new Set()) {
  const out = rest.map((m) => {
    const a = { url: m.url, headers: m.headers };
    if (m.mime) a.mime = m.mime;
    if (playing && playing.url) a.label = `${copyLabel(playing)} (otra lista)`.slice(0, 48);
    return a;
  });
  let lazy = 0;
  for (const f of others) {
    if (playing && f.url === playing.url) continue;
    if (failed.has(serverName(f))) continue;
    if (lazy++ >= MAX_LAZY) break;
    out.push({ label: copyLabel(f), ref: serverRef(ref, f) });
  }
  return out.slice(0, 8);
}

function streamOf(got, server, others = [], ref = "", failed = new Set()) {
  const [first, ...more] = got.media;
  // Never an MP4 next to a manifest (filmMedia already drops them; this guards any other caller).
  const rest = got.media.some(isManifest) ? more.filter((m) => !isMp4(m)) : more;
  const stream = { url: first.url, headers: first.headers };
  if (first.mime) stream.mime = first.mime;
  const label = copyLabel(server);
  if (label) stream.label = label;
  const alternatives = alternativesOf(rest, server, others, ref, failed);
  if (alternatives.length) stream.alternatives = alternatives;
  // The embed's own subtitle tracks: these sites only carry Spanish ones; the label says which audio they came with.
  const subLabel = server && server.lang ? `Español (${LANG_LABEL[langOf(server.lang)]})` : "Español";
  const subs = (got.subtitles || []).slice(0, 10).map((s) => ({ lang: s.lang || "es", label: subLabel, url: s.url, format: /\.srt(\?|$)/i.test(s.url) ? "srt" : "vtt" }));
  if (subs.length) stream.subtitles = subs;
  const exp = expiresInOf(first.url);
  if (exp) stream.expiresInSeconds = exp;
  return stream;
}

export async function resolve(ref, options) {
  const isAc = String(ref).startsWith("ac|");
  const { siteId, site, path } = isAc ? { siteId: AC.id, site: null, path: "" } : splitRef(ref);
  const t0 = Date.now();
  // A retry (the CDN said 401/403/409) or a normal call: a retry never gets the cached copy back.
  const keepLinks = configValue("keepLinks", true) !== false;
  if (options && options.retry) {
    storageRemove(streamKey(ref));
    kino.log(`resolve ${ref}: retry ${options.retry.reason || ""} ${options.retry.status || ""}, cache dropped`);
  } else if (keepLinks) {
    const cached = fromCache(storageGet(streamKey(ref)));
    if (cached) {
      kino.log(`resolve ${ref}: cached stream ${safe(cached.url)} (${cached.expiresInSeconds || "?"} s left)`);
      return cached;
    }
  }
  const lang = preferredLang();
  const remembered = (storageGet(serverKey(siteId)) || {}).server || "";
  const chosen = String(configValue("server", "auto"));
  const { only } = parseServerRef(ref);
  const failed = failedServers(siteId);
  let fast;
  let fallbackPages = [];
  if (isAc) {
    // allcalidad lists its embeds itself: no page to read, no fast path needed.
    fast = rankServers(acServers(await acGet(acPlaybackPath(ref))), lang, remembered, chosen);
    kino.log(`resolve ${ref}: ${fast.length} embed(s) [${fast.map((f) => `${f.lang}/${f.server}@${startHost(f.url)}`).join(", ")}]`);
  } else {
    const episodeUrl = abs(site, path);
    const html = await page(site, path);
    const servers = serversOf(siteId, html);
    kino.log(`resolve ${ref}: servers [${servers.map(safe).join(", ")}]`);
    // Fast path: decrypt embed69's server list and open each embed host's page directly (its player is then the top
    // document, so autoplay reaches it). Without it, fall back to opening the episode page and digging through frames.
    fast = rankServers(await fastServers(site, episodeUrl, servers), lang, remembered, chosen);
    fallbackPages = pagesToOpen(siteId, episodeUrl, servers).filter((u) => Object.values(SITES).some((x) => startHost(u) === startHost(x.base)));
  }
  fast = lastIfFailed(fast, failed);
  if (only) {
    fast = fast.filter((f) => langOf(f.lang) === only.lang && (f.server || "").toLowerCase() === only.server);
    if (!fast.length) throw kino.error("not_found", `sin el servidor ${only.lang}/${only.server}`, { userMessage: "Ese servidor ya no está disponible para este video." });
  }
  const targets = fast.length
    ? fast.slice(0, MAX_PAGES)
    : fallbackPages.map((url) => ({ url }));
  kino.log(`resolve ${siteId}: ${isAc ? "API embeds" : fast.length ? "embed69 fast path" : "no fast path"} (idioma ${lang}, último servidor ${remembered || "-"}, fallaron hace poco ${[...failed].join("/") || "-"}), capture on ${targets.length} page(s): [${targets.map((t) => `${t.lang ? t.lang + "/" : ""}${safe(t.url)}`).join(", ")}]`);
  let lastError = null;
  const failedHere = new Set();
  for (let p = 0; p < targets.length; p++) {
    const target = targets[p];
    const started = Date.now();
    const left = RESOLVE_BUDGET_MS - (Date.now() - t0);
    if (left < MIN_CAPTURE_MS) {
      kino.log(`resolve ${ref}: ${left} ms left, ${targets.length - p} page(s) not opened`);
      break;
    }
    const timeoutMs = Math.min(captureTimeout(targets.length - p - 1), left);
    kino.log(`capture ${safe(target.url)} (timeout ${timeoutMs} ms)`);
    try {
      const got = await kino.browser.capture(target.url, { timeoutMs, headers: { Referer: (site ? site.base : "https://allcalidad.re") + "/" } });
      kino.log(`capture ok in ${Date.now() - started} ms: ${got.media.length} media [${got.media.map((m) => safe(m.url)).join(", ")}], ${got.subtitles.length} subtitles`);
      got.media = await filmMedia(got.media);
      if (!got.media.length) {
        // Only ads: as good as a failure for this server.
        failedHere.add(target.url);
        if (target.server) markServer(siteId, target, true);
        report("maraton:capture", "only_ads", `server=${serverName(target)}`);
        continue;
      }
      // A lazy copy (a server ref) offers nothing more: Kino drops a lazy copy's own alternatives anyway.
      const stream = streamOf(got, target, only ? [] : fast.filter((f) => f !== target && !failedHere.has(f.url)), parseServerRef(ref).base, failed);
      if (target.server) {
        storageSet(serverKey(siteId), { server: target.server.toLowerCase() });
        markServer(siteId, target, false);
      }
      const expiresAtMs = stream.expiresInSeconds ? Date.now() + stream.expiresInSeconds * 1000 : 0;
      const keepMs = expiresAtMs ? Math.min(STREAM_CACHE_MAX_MS, expiresAtMs - Date.now() - EXPIRY_MARGIN_S * 1000) : STREAM_CACHE_UNKNOWN_MS;
      if (keepLinks && keepMs > 60000) storageSet(streamKey(ref), { stream, until: Date.now() + keepMs, expiresAtMs }, keepMs);
      kino.log(`stream ${safe(stream.url)} mime=${stream.mime || "?"} headers=${Object.keys(stream.headers || {}).join(",")} alternatives=${(stream.alternatives || []).length} expires=${stream.expiresInSeconds || "?"} s, resolve ${Date.now() - t0} ms`);
      return stream;
    } catch (e) {
      lastError = e;
      failedHere.add(target.url);
      if (target.server && e.code !== "busy" && e.code !== "browser_unavailable" && e.code !== "not_allowed") markServer(siteId, target, true);
      kino.log(`capture failed after ${Date.now() - started} ms on ${startHost(target.url)}: ${e.code || ""} ${e.message}`);
      // Which server's player let us down, by our own name for it (never its URL).
      report("maraton:capture", e.code || "error", `server=${serverName(target)}`, `ms=${Date.now() - started}`);
      // No WebView, or the person never approved it: no other page will do better.
      if (e.code === "browser_unavailable" || e.code === "not_allowed") break;
    }
  }
  if (lastError && lastError.code === "browser_unavailable") {
    throw kino.error("unavailable", "sin navegador web", { userMessage: "Este aparato no tiene navegador web, y esta fuente lo necesita para reproducir." });
  }
  if (lastError && lastError.code === "busy") {
    throw kino.error("unavailable", "navegador ocupado", { userMessage: "Hay otro video buscándose en este momento. Vuelve a intentar en unos segundos." });
  }
  throw kino.error("not_found", lastError ? `${lastError.code || ""} ${lastError.message}` : "sin servidores", { userMessage: "No encontramos el video. Prueba otra fuente." });
}

// ---------- meta ----------

/**
 * Describes a series Kino's info page could not fill from TMDB (a synopsis, a poster, the episode list), for an IMDb id
 * this plugin has already met in `episodes` (the player pages are keyed by it). Any other title: no answer.
 */
export async function meta(query) {
  const imdb = query && query.ids && query.ids.imdb;
  if (!imdb || (query.type && query.type !== "series")) return null;
  const known = storageGet(imdbKey(imdb));
  if (!known || !known.ref) return null;
  const { series, episodes: list } = await episodes(known.ref);
  const out = { episodes: list.map((e) => ({ season: e.season, number: e.number, ...(e.title ? { title: e.title } : {}) })) };
  for (const k of ["title", "overview", "poster", "year"]) if (series[k]) out[k] = series[k];
  kino.log(`meta ${imdb}: ${known.ref}, ${out.episodes.length} episodes`);
  return out;
}

// ---------- the settings form: status line, actions, validation ----------

const SITE_NAME = { sk: "SeriesKao", ac: "AllCalidad" };

/** The "Estado" line: active sites, the language, and the server that last produced a video on each site. */
export async function settingsStatus() {
  const sites = activeSites();
  const last = sites.map((id) => (storageGet(serverKey(id)) || {}).server).filter(Boolean)
    .map((name) => SERVER_LABEL[Object.keys(SERVER_MATCH).find((k) => SERVER_MATCH[k].test(name)) || ""] || name);
  const parts = [
    `${sites.length === 1 ? "1 sitio activo" : `${sites.length} sitios activos`} (${sites.map((id) => SITE_NAME[id]).join(", ")})`,
    ({ lat: "Latino", esp: "Castellano", sub: "Subtitulado" })[preferredLang()],
    last.length ? `último servidor que funcionó: ${[...new Set(last)].join(", ")}` : "todavía sin reproducir nada",
  ];
  return { state: parts.join(" · ").slice(0, 200) };
}

/** How one site answers right now, as a short Spanish phrase (for "Revisar sitios"). */
async function checkSite(id) {
  const t0 = Date.now();
  try {
    if (id === AC.id) await acGet("/v1/items?kind=movie&page=1");
    else await page(SITES.sk, "/");
    return `${SITE_NAME[id]}: responde (${Date.now() - t0} ms)`;
  } catch (e) {
    return `${SITE_NAME[id]}: ${/verificaci/.test(e.userMessage || "") ? "pide verificación" : "no responde"}`;
  }
}

/** Every key this plugin keeps for streams and servers (what "Borrar enlaces guardados" removes). */
function linkKeys() {
  try {
    return (kino.storage.keys() || []).filter((k) => k.startsWith("stream:") || k.startsWith("server:") || k.startsWith("failed:"));
  } catch (_) {
    return [];
  }
}

export async function action(key) {
  if (key === "check") {
    const lines = await Promise.all(ALL_SITES.map(checkSite));
    return { message: lines.join(" · ").slice(0, 300), refresh: true };
  }
  if (key === "clear") {
    const keys = linkKeys();
    for (const k of keys) storageRemove(k);
    const n = keys.filter((k) => k.startsWith("stream:")).length;
    return { message: n ? `Se borraron ${n === 1 ? "1 enlace guardado" : `${n} enlaces guardados`} y los servidores recordados.` : "No había enlaces guardados.", refresh: true };
  }
  throw kino.error("not_found", `acción desconocida: ${String(key).slice(0, 40)}`);
}

/** Refuses a form that switches every site off: the plugin would have nothing to search or play. */
export async function validateSettings(values) {
  const v = values || {};
  if (ALL_SITES.every((id) => v[SITE_SETTING[id]] === false)) {
    return { useAllcalidad: "Deja al menos un sitio activo" };
  }
  return null;
}
