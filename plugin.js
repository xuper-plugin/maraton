// PelisYSeries (formerly Maratón; id and telemetry areas stay "maraton"): series and anime from Spanish-language streaming sites. Everything runs on the device: HTML is read with
// kino.fetch (regex, no kino.html, so the Node kit runs it too); each embed's player page is read for its own playlist
// when it carries one (no hidden browser needed), and otherwise opened in Kino's hidden browser
// (kino.browser.capture), which reports the video request the page makes.
//
// Refs:  "<site>|<path>"  e.g. "sk|/serie/dark" (a series), "sk|/serie/dark/temporada/1/capitulo/1" (an episode).
// Rows:  "row|<site>|<kind>" with the catalog page number as the cursor.

export const UA = "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36";

const SITES = {
  sk: {
    name: "SeriesKao",
    base: "https://serieskao.top",
    search: (q) => `/search?s=${encodeURIComponent(q).replace(/%2F/gi, "/")}`,
    catalog: { serie: "/series?page=", anime: "/animes?page=", pelicula: "/peliculas?page=" },
    episodeRx: /<a[^>]+href="([^"]*?\/temporada\/(\d+)\/capitulo\/(\d+))"[^>]*>([\s\S]*?)<\/a>/gi,
  },
};

/** Every site the plugin can read, in the order results are merged ("Usar …" in Ajustes picks which ones). */
const ALL_SITES = ["sk", "ac", "sl"];
const SITE_SETTING = { sk: "useSerieskao", ac: "useAllcalidad", sl: "useSololatino" };
const SITE_NAME = { sk: "SeriesKao", ac: "AllCalidad", sl: "SoloLatino" };

/** The sites switched on in the plugin's settings (all by default; validateSettings refuses switching all off). */
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

// ---------- time: every window in one place ----------
//
// Kino gives home/section/browse 20 s, search 15 s and a browser plugin's resolve 75 s, and switches a plugin off after
// three timeouts in a row. So no list call waits for its slowest site: each answers with what is ready by its own
// deadline (a site that is late shows its last good rows), and resolve keeps its own clock well inside Kino's.

/** Tests shrink these; nothing else changes them. */
export const LIMITS = {
  /** One fetch inside resolve or episodes. */
  fetchMs: 10000,
  /** Reading an embed's page for its playlist: they answer in about a second (measured 0.5-1.6 s). */
  extractMs: 6000,
  /** One fetch for home, section, browse, search or categories: a slow site must not hold the screen. */
  listFetchMs: 6000,
  /** home and section answer with what is ready by then (Kino allows 20 s). */
  homeMs: 12000,
  /** search's sites (Kino allows 15 s; a SoloLatino page read may take 12 of them). */
  searchMs: 12500,
  /** categories' art lookups, all of them together. */
  artMs: 3000,
  /** resolve: listing an episode's servers (site page, embed69, SoloLatino's player tokens), before any video search. */
  serversMs: 22000,
  /** resolve's own budget for starting one more attempt, under Kino's 75 s. */
  resolveMs: 68000,
  /** A hidden page is never opened with less than this left. */
  minCaptureMs: 8000,
  /** A Home row younger than this is shown without asking the site again. */
  rowFreshMs: 15 * 60 * 1000,
  /** How long a site's last good rows stay as the stand-in when it is down. */
  rowKeepMs: 3 * 86400 * 1000,
  /** A site that failed this many list reads in a row rests for [breakerMs]: only its saved rows are shown. */
  breakerFails: 3,
  breakerMs: 5 * 60 * 1000,
};

/**
 * Waits [ms] with kino.sleep (there is no setTimeout in Kino's engine). [cancel] stops it within one short step:
 * Kino ends a call only once every pending kino.sleep is over, so a timer left running after its race was decided
 * held the whole answer back (measured 2026-10-04 on a Redmi: the video found in 4.5 s, resolve answered at 22 s).
 */
async function sleepFor(ms, cancel = null) {
  let left = Math.max(0, Math.floor(ms));
  while (left > 0 && !(cancel && cancel.done)) {
    const step = Math.min(cancel ? SLEEP_STEP_MS : 5000, left);
    await kino.sleep(step);
    left -= step;
  }
}

/** How late a cancelled timer may still keep a call open. */
const SLEEP_STEP_MS = 250;

/**
 * [p]'s value, or [fallback] once [ms] passed. A late rejection of [p] is handled here: one nobody listens to would
 * fail the whole call ("una llamada a Kino falló sin decir por qué"). The timer stops as soon as the race is decided.
 */
export async function within(p, ms, fallback = null) {
  const guarded = Promise.resolve(p).then((v) => ({ v }), (e) => ({ e }));
  if (ms <= 0) return fallback;
  const cancel = { done: false };
  const timer = sleepFor(ms, cancel).then(() => null, () => null);
  try {
    const r = await Promise.race([guarded, timer]);
    if (!r) return fallback;
    if (r.e) throw r.e;
    return r.v;
  } finally {
    cancel.done = true;
  }
}

// ---------- site health: a site that keeps failing rests a few minutes ----------

const healthKey = (siteId) => "health:" + siteId;

/** True while [siteId] rests after [LIMITS.breakerFails] failures in a row: list calls do not ask it at all. */
export function siteResting(siteId, nowMs = Date.now()) {
  const h = storageGet(healthKey(siteId));
  return !!h && (h.until || 0) > nowMs;
}

function siteFailed(siteId, code) {
  const h = storageGet(healthKey(siteId)) || {};
  const fails = (h.fails || 0) + 1;
  if (fails >= LIMITS.breakerFails) {
    kino.log(`site ${siteId}: ${fails} failures in a row (${code}), resting ${Math.round(LIMITS.breakerMs / 1000)} s`);
    storageSet(healthKey(siteId), { fails: 0, until: Date.now() + LIMITS.breakerMs }, LIMITS.breakerMs + 60000);
  } else {
    storageSet(healthKey(siteId), { fails, until: h.until || 0 }, 3600 * 1000);
  }
}

function siteAnswered(siteId) {
  if (storageGet(healthKey(siteId))) storageRemove(healthKey(siteId));
}

function restingError(siteId) {
  return kino.error("unavailable", `${SITE_NAME[siteId]}: en pausa tras varias fallas`, {
    userMessage: `${SITE_NAME[siteId]} no está respondiendo; se vuelve a probar en unos minutos.`,
  });
}

/**
 * One request to a site's own host. `list` marks a Home/section/browse/search/categories read: it is refused at once
 * while the site rests and gets the short timeout. A timeout, a network error or a 5xx/429 counts towards resting;
 * any 2xx clears it. Network failures become a typed "unavailable" with a sentence for the person.
 */
async function siteFetch(siteId, url, init = {}, { list = false } = {}) {
  await null;
  if (list && siteResting(siteId)) throw restingError(siteId);
  const t0 = Date.now();
  let r;
  try {
    r = await kino.fetch(url, { ...init, timeoutMs: init.timeoutMs || (list ? LIMITS.listFetchMs : LIMITS.fetchMs) });
  } catch (e) {
    kino.log(`fetch ${safe(url)}: ${e.code || ""} ${e.message} after ${Date.now() - t0} ms`);
    if (e.code === "host_not_allowed" || e.code === "invalid_request") {
      throw kino.error("unavailable", `${SITE_NAME[siteId]}: ${e.code}`, { userMessage: `${SITE_NAME[siteId]} no se pudo consultar desde aquí.` });
    }
    siteFailed(siteId, e.code || "network");
    report("maraton:site", "down", `site=${siteId}`, `code=${e.code || "network"}`, `ms=${Date.now() - t0}`);
    throw kino.error("unavailable", `${SITE_NAME[siteId]}: ${e.code || "network"}`, { userMessage: `${SITE_NAME[siteId]} no responde. Vuelve a intentar en un rato.` });
  }
  kino.log(`fetch ${safe(url)} -> ${r.status} in ${Date.now() - t0} ms`);
  if (r.ok) siteAnswered(siteId);
  else if (r.status >= 500 || r.status === 429) siteFailed(siteId, `http${r.status}`);
  return r;
}

// ---------- allcalidad (a JSON API, no HTML) ----------
//
// allcalidad.re's front end (measured 2026-10-04 evening, after it left its old tmdb.* API) reads everything from
// /api/rest: `search`, `listing` (a type, or a genre), `episodes?post_id=` and `player?post_id=`, whose `embeds` are
// `{ lang, quality, url }`. Titles are WordPress posts: `_id`, `slug`, `type` (movies / tvshows / animes), images
// under /wp-content/uploads. A post carries no TMDB id; an episode does (`show_id`), and so does the `videoapp.zip`
// embed (`/e/movie/<tmdb>`, `/e/tv/<tmdb>/<s>/<e>`), which old refs (`ac|movie/603`, `ac|tvshow/70523/1/2`) still play.

const AC = {
  id: "ac", name: "AllCalidad", base: "https://allcalidad.re", api: "https://allcalidad.re/api/rest",
  uploads: "https://allcalidad.re/wp-content/uploads", tmdbImg: "https://image.tmdb.org/t/p/",
};
const AC_TYPES = { movies: "movie", tvshows: "series", animes: "series" };
/** The site's genre ids (window.siteConfig.datas.genres), named the way Kino shows genres. */
const AC_GENRES = {
  26: "Acción", 677: "Acción y aventura", 51: "Animación", 25: "Aventura", 157: "Bélica", 27: "Ciencia ficción", 216: "Comedia",
  135: "Crimen", 4657: "Documental", 156: "Drama", 52: "Familia", 109: "Fantasía", 429: "Historia", 695: "Infantil",
  273: "Misterio", 332: "Música", 6357: "Película de TV", 11125: "Reality", 239: "Romance", 658: "Ciencia ficción y fantasía",
  17921: "Telenovela", 295: "Suspenso", 447: "Terror", 755: "Guerra y política", 182: "Western",
};
const VIDEOAPP = "https://videoapp.zip";

/** One API answer's `data`; `{ error: true }` answers are typed errors, never parsed as content. */
async function acGet(path, { list = false } = {}) {
  const r = await siteFetch(AC.id, AC.api + path, { headers: { "User-Agent": UA, Accept: "application/json", Referer: AC.base + "/" } }, { list });
  if (!r.ok) {
    if (r.status !== 404) report("maraton:site", "http", "site=ac", `status=${r.status}`);
    throw kino.error(r.status === 404 ? "not_found" : r.status === 429 ? "rate_limited" : "unavailable", `${AC.name} respondió ${r.status}`,
      { userMessage: r.status === 404 ? `${AC.name} ya no tiene este título.` : `${AC.name} no está respondiendo bien (${r.status}).` });
  }
  let body;
  try {
    body = r.json();
  } catch (_) {
    siteFailed(AC.id, "not_json");
    report("maraton:site", "not_json", "site=ac");
    throw kino.error("unavailable", `${AC.name}: respuesta que no es JSON`, { userMessage: `${AC.name} respondió algo que no se entiende.` });
  }
  if (!body || body.error) {
    const msg = String((body && body.message) || "error").slice(0, 60);
    throw kino.error(msg === "404" ? "not_found" : "unavailable", `${AC.name}: ${msg}`,
      { userMessage: msg === "404" ? `${AC.name} ya no tiene este título.` : `${AC.name} no está respondiendo bien.` });
  }
  return body.data;
}

const acImage = (p) => (!p ? "" : /^https?:\/\//.test(p) ? p : p.startsWith("/") ? AC.uploads + p : "");
const AC_NO_OVERVIEW = /aún no hemos añadido una sinopsis/i;

/** One API post as a Kino item; null for anything that is not a movie, show or anime. */
export function acItem(p) {
  if (!p || !AC_TYPES[p.type] || !Number.isInteger(p._id) || !p.title || !/^[a-z0-9-]{1,200}$/.test(p.slug || "")) return null;
  let title = decode(String(p.title)).trim();
  let year = "";
  const ym = /\s*\((\d{4})\)\s*$/.exec(title);
  if (ym) { year = ym[1]; title = title.slice(0, ym.index).trim(); }
  if (!year && /^\d{4}-/.test(p.release_date || "")) year = p.release_date.slice(0, 4);
  const item = { id: `ac-${p.type}-${p._id}`, ref: `ac|${p.type}/${p._id}/${p.slug}`, title: title.slice(0, 200), kind: AC_TYPES[p.type] };
  if (year) item.year = year;
  const images = p.images || {};
  const poster = acImage(images.poster);
  if (poster) item.poster = poster;
  const backdrop = acImage(images.backdrop);
  if (backdrop) item.backdrop = backdrop;
  const overview = text(p.overview || "");
  if (overview && !AC_NO_OVERVIEW.test(overview)) item.overview = overview.slice(0, 2000);
  const rating = parseFloat(p.rating);
  if (rating > 0 && rating <= 10) item.rating = Math.round(rating * 10) / 10;
  const original = decode(String(p.original_title || "")).trim();
  if (original && original !== title) item.originalTitle = original.slice(0, 200);
  const genres = (p.genres || []).map((g) => AC_GENRES[g]).filter(Boolean);
  if (p.type === "animes" && !genres.includes("Anime")) genres.unshift("Anime");
  if (genres.length) item.genres = [...new Set(genres)].slice(0, 5).map((g) => g.slice(0, 30));
  const runtime = Math.round(parseFloat(p.runtime));
  if (p.type === "movies" && runtime >= 1 && runtime <= 1000) item.runtimeMinutes = runtime;
  return item;
}

function acItems(list) {
  const seen = new Set();
  return (list || []).map(acItem).filter((i) => i && !seen.has(i.id) && seen.add(i.id));
}

async function acSearch(q, { list = true } = {}) {
  const data = await acGet(`/search?post_type=movies,tvshows,animes&query=${encodeURIComponent(q)}&posts_per_page=16`, { list });
  return acItems(data && data.posts);
}

/** A row of the catalog: the newest updated titles of one type, 24 a page. */
async function acListing(type, n, { list = true } = {}) {
  const data = await acGet(`/listing?page=${n}&post_type=${type}&posts_per_page=24`, { list });
  const pg = (data && data.pagination) || {};
  return { items: acItems(data && data.posts), more: Number.isInteger(pg.last_page) ? n < pg.last_page : !!pg.next_page_url };
}

async function acGenre(slug, n, { list = true, perPage = 24 } = {}) {
  const data = await acGet(`/listing?tax=genres&term=${encodeURIComponent(slug)}&page=${n}&post_type=movies,tvshows,animes&posts_per_page=${perPage}`, { list });
  return acItems(data && data.posts);
}

/**
 * `ac|<type>/<id>/<slug>` (new) or `ac|<movie|tvshow|anime>/<tmdb>[/<s>/<e>]` (before 0.6.2, TMDB ids), or an episode
 * `ac|ep/<post>/<tmdb show>/<s>/<e>`.
 */
export function parseAcRef(ref) {
  const parts = parseServerRef(ref).base.slice(3).split("/");
  const [a, b, c, d, e] = parts;
  if (a === "ep" && /^\d+$/.test(b || "")) {
    return { ep: true, post: b, tmdb: /^\d+$/.test(c || "") ? c : "", season: /^\d+$/.test(d || "") ? d : "", episode: /^\d+$/.test(e || "") ? e : "" };
  }
  if (AC_TYPES[a] && /^\d+$/.test(b || "")) return { type: a, post: b, slug: c || "" };
  if (["movie", "tvshow", "anime"].includes(a) && /^\d+$/.test(b || "")) {
    return { legacy: true, kind: a, tmdb: b, season: /^\d+$/.test(c || "") ? c : "", episode: /^\d+$/.test(d || "") ? d : "" };
  }
  return null;
}

const acLegacyError = () => kino.error("not_found", "referencia anterior a 0.6.2", {
  userMessage: "AllCalidad cambió su catálogo. Busca el título de nuevo para ver sus episodios.",
});

/** `ac|tvshows/41641/dark-2017` -> its episodes, refs `ac|ep/<post>/<tmdb>/<s>/<e>`. */
async function acEpisodes(ref) {
  const r = parseAcRef(ref);
  if (r && r.legacy) throw acLegacyError();
  if (!r || !r.type || r.type === "movies") throw kino.error("not_found", "referencia inválida");
  const [list, info] = await Promise.all([
    acGet(`/episodes?post_id=${r.post}`),
    r.slug ? acGet(`/single?post_name=${encodeURIComponent(r.slug)}&post_type=${r.type}`).catch((e) => { kino.log(`episodes ac: no title info (${e.code || ""})`); return null; }) : null,
  ]);
  const episodes = [];
  let tmdb = "";
  const seen = new Set();
  for (const e of Array.isArray(list) ? list : []) {
    if (!e || !Number.isInteger(e._id) || !Number.isInteger(e.season_number) || !Number.isInteger(e.episode_number) || e.episode_number < 1) continue;
    const key = `${e.season_number}x${e.episode_number}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const show = /^\d+$/.test(String(e.show_id || "")) ? String(e.show_id) : "";
    if (show && !tmdb) tmdb = show;
    const ep = { season: e.season_number, number: e.episode_number, ref: `ac|ep/${e._id}/${show || 0}/${e.season_number}/${e.episode_number}` };
    const t = decode(String(e.title || "")).trim();
    if (t && !/temporada\s*\d+\s*episodio\s*\d+\s*$/i.test(t)) ep.title = t.slice(0, 200);
    const ov = text(e.overview || "");
    if (ov && !AC_NO_OVERVIEW.test(ov)) ep.overview = ov.slice(0, 2000);
    if (/^\/\w+\.(jpg|png|webp)$/i.test(e.still_path || "")) ep.still = AC.tmdbImg + "w300" + e.still_path;
    const rt = Math.round(parseFloat(e.runtime));
    if (rt >= 1 && rt <= 1000) ep.runtimeMinutes = rt;
    episodes.push(ep);
  }
  if (!episodes.length) throw kino.error("not_found", "la serie no tiene episodios en AllCalidad", { userMessage: "AllCalidad todavía no tiene episodios de esta serie." });
  episodes.sort((a, b) => a.season - b.season || a.number - b.number);
  const series = {};
  const base = acItem(info) || {};
  for (const k of ["title", "poster", "backdrop", "overview", "year", "genres"]) if (base[k]) series[k] = base[k];
  if (tmdb) series.ids = { tmdb: parseInt(tmdb, 10) };
  // An episode ref carries only the show's TMDB id: its name is kept here, for resolve's search on the other sites.
  const name = base.title || acShowName(list);
  if (tmdb && name) storageSet(showKey(tmdb), { title: name, ...(base.originalTitle ? { originalTitle: base.originalTitle } : {}), ...(base.year ? { year: base.year } : {}) }, IMDB_MEMORY_MS);
  kino.log(`episodes ${ref}: ${episodes.length}${tmdb ? ", TMDB id known" : ""}`);
  return { series, episodes };
}

/** "Dark: Temporada 1 Episodio 2" -> "Dark": the show's name as its episodes' titles carry it (when /single fails). */
export function acShowName(list) {
  for (const e of Array.isArray(list) ? list : []) {
    const m = /^(.+?):\s*Temporada\s*\d+\s*Episodio\s*\d+\s*$/i.exec(decode(String((e && e.title) || "")).trim());
    if (m) return m[1].trim().slice(0, 200);
  }
  return "";
}

/** What allcalidad's episode refs need to be found elsewhere: the show's name, per TMDB id. */
const showKey = (tmdb) => "show:ac:" + tmdb;

/** The videoapp page for a TMDB title: movie, or a show's episode. */
export function videoappUrl(kind, tmdb, season, episode) {
  if (!/^\d+$/.test(String(tmdb || "")) || String(tmdb) === "0") return "";
  if (kind === "movie") return `${VIDEOAPP}/e/movie/${tmdb}`;
  if (!/^\d+$/.test(String(season || "")) || !/^\d+$/.test(String(episode || ""))) return "";
  return `${VIDEOAPP}/e/tv/${tmdb}/${season}/${episode}`;
}

/** A player answer's embeds as resolve's server list `{ lang, server, url, referer }` (server named after its host). */
export function acServers(answer) {
  return ((answer && answer.embeds) || [])
    .filter((e) => e && /^https:\/\//.test(e.url || ""))
    .map((e) => ({ lang: e.lang || "", server: hostLabel(e.url), url: e.url, referer: AC.base + "/" }));
}

/** allcalidad's servers for a ref: the player API's embeds; for an old TMDB ref, its videoapp page only. */
async function acServerList(ref) {
  const r = parseAcRef(ref);
  if (!r) throw kino.error("not_found", "referencia inválida");
  if (r.legacy) {
    const url = videoappUrl(r.kind === "movie" ? "movie" : "tv", r.tmdb, r.season, r.episode);
    if (!url) throw acLegacyError();
    return [{ lang: "LAT", server: "videoapp", url, referer: AC.base + "/" }];
  }
  const out = acServers(await acGet(`/player?post_id=${r.post}&_any=1`));
  const app = r.ep ? videoappUrl("tv", r.tmdb, r.season, r.episode) : "";
  if (app && !out.some((f) => startHost(f.url) === startHost(app))) out.push({ lang: "LAT", server: "videoapp", url: app, referer: AC.base + "/" });
  return out;
}

// ---------- sololatino ("browser": "pages": kino.browser.page where a plain read hits Cloudflare) ----------
//
// sololatino.net, measured 2026-10-04: its catalogs, series, movie and episode pages answer a plain request; its
// /buscar page answers Cloudflare's "Just a moment…", but the site's own search box reads a JSON suggest API that
// answers fine. Each episode or movie page lists its servers as encrypted "player tokens" per language
// (data-lang-group mx / es / sub); the page's own script turns one into the player URL with Laravel Sanctum
// (GET /sanctum/csrf-cookie, then POST /api/player-url { t } with the XSRF cookie's value as X-XSRF-TOKEN). One of
// those players is an embed69 page (embed69.org/f/<imdb>-<s>x<ee>), the same as serieskao's, so the same decryption
// follows. When a plain read does get the challenge page, the hidden browser reads the page instead
// (kino.browser.page), never for Home rows.

const SL = { id: "sl", name: "SoloLatino", base: "https://sololatino.net" };
/** A desktop browser's headers: with them the catalog and title pages answer a plain request (a phone's UA got 403). */
const SL_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml", "Accept-Language": "es-CO,es;q=0.9",
};
const SL_CATALOG = { serie: "/series?page=", anime: "/animes?page=", pelicula: "/peliculas?page=" };
/** A page read through the hidden browser is kept this long: a person paging back and forth never re-opens it. */
const SL_PAGE_CACHE_MS = 5 * 60 * 1000;
/**
 * Pages read through the hidden browser, kept in the sandbox's memory (it lives while the person keeps using the
 * plugin): a real catalog page is ~230 KB, too big for kino.storage's 256 KB in all. At most [SL_PAGE_MEMO_MAX].
 */
const slPageMemo = new Map();
const SL_PAGE_MEMO_MAX = 8;

function slMemoGet(path) {
  const hit = slPageMemo.get(path);
  if (hit && hit.until > Date.now()) return hit.html;
  slPageMemo.delete(path);
  const stored = storageGet("slpage:" + path);
  return stored && stored.html ? stored.html : null;
}

function slMemoSet(path, html) {
  slPageMemo.delete(path);
  slPageMemo.set(path, { html, until: Date.now() + SL_PAGE_CACHE_MS });
  while (slPageMemo.size > SL_PAGE_MEMO_MAX) slPageMemo.delete(slPageMemo.keys().next().value);
  // Small pages also survive a sandbox restart.
  if (html.length <= 40000) storageSet("slpage:" + path, { html }, SL_PAGE_CACHE_MS);
}

/** Test hook: forget the pages read in this sandbox. */
export function forgetPages() {
  slPageMemo.clear();
}
/** After the hidden browser was blocked or timed out, sololatino is left alone this long (no page after page). */
const SL_DOWN_MS = 15 * 60 * 1000;
const SL_PAGE_TIMEOUT_MS = 10000;
const slDownKey = "sitedown:sl";

export function slIsDown(nowMs = Date.now()) {
  const until = (storageGet(slDownKey) || {}).until || 0;
  return until > nowMs;
}

function slUnavailable(why) {
  return kino.error("unavailable", `${SL.name}: ${why}`, { userMessage: `${SL.name} no está dejando entrar en este momento. Las otras fuentes siguen funcionando.` });
}

/**
 * One sololatino page: a plain read first; on Cloudflare's challenge, the hidden browser ("browser": "pages") when
 * [allowPage] — never for Home rows, which Kino also asks for on its own. A blocked or timed-out page read marks the
 * site down for [SL_DOWN_MS]; while down, nothing is read at all.
 */
export async function slRead(path, { allowPage = true, waitFor, list = false } = {}) {
  await null;
  if (slIsDown()) throw slUnavailable("en pausa tras un bloqueo");
  const url = SL.base + path;
  const cached = slMemoGet(path);
  if (cached) return cached;
  const r = await siteFetch(SL.id, url, { headers: SL_HEADERS }, { list });
  const html = r.text();
  if (r.ok && !looksLikeChallenge(html)) return html;
  if (r.status === 404) throw kino.error("not_found", `${SL.name} respondió 404`, { userMessage: `${SL.name} ya no tiene esta página.` });
  if (!looksLikeChallenge(html) && r.status !== 403) {
    report("maraton:site", "http", "site=sl", `status=${r.status}`);
    throw kino.error("unavailable", `${SL.name} respondió ${r.status}`, { userMessage: `${SL.name} no está respondiendo bien (${r.status}).` });
  }
  report("maraton:site", "cloudflare", "site=sl");
  if (!allowPage || browserMissing() || !kino.browser || typeof kino.browser.page !== "function") {
    if (list) siteFailed(SL.id, "cloudflare");
    throw slUnavailable("verificación de Cloudflare");
  }
  const t1 = Date.now();
  try {
    const got = await kino.browser.page(url, { timeoutMs: SL_PAGE_TIMEOUT_MS, ...(waitFor ? { waitFor } : {}) });
    kino.log(`page ${safe(url)} -> ${got.status} in ${Date.now() - t1} ms${got.truncated ? " (truncated)" : ""}`);
    slMemoSet(path, got.html);
    return got.html;
  } catch (e) {
    kino.log(`page ${safe(url)}: ${e.code || ""} ${e.message} after ${Date.now() - t1} ms`);
    if (e.code === "browser_unavailable") noteNoBrowser();
    if (e.code === "blocked" || e.code === "timeout") {
      storageSet(slDownKey, { until: Date.now() + SL_DOWN_MS }, SL_DOWN_MS);
      report("maraton:page", e.code, "site=sl");
    }
    throw slUnavailable(e.code || "page");
  }
}

/** sololatino's `<div class="card">`: link, poster (alt = title), kind badge, rating, year. */
export function slCards(html) {
  const out = [];
  const seen = new Set();
  const rx = /<div class="card">\s*<a href="([^"]+)">([\s\S]*?)<\/div>\s*<\/div>/gi;
  let m;
  while ((m = rx.exec(html))) {
    const path = String(m[1]).replace(SL.base, "");
    if (!/^\/(serie|pelicula)\/[^/]+$/.test(path) || seen.has(path)) continue;
    seen.add(path);
    const block = m[2];
    const img = /<img[\s\S]*?>/i.exec(block);
    const title = text((/card__title">([\s\S]*?)<\/p>/i.exec(block) || [])[1]) || (img ? attr(img[0], "alt") : "");
    if (!title) continue;
    const kind = path.startsWith("/pelicula/") ? "movie" : "series";
    const item = { id: idOf("sl", path), ref: `sl|${path}`, title, kind };
    const poster = img ? attr(img[0], "src") : "";
    if (/^https?:\/\//.test(poster)) item.poster = poster;
    const year = text((/card__year">([\s\S]*?)</i.exec(block) || [])[1]);
    if (/^\d{4}$/.test(year)) item.year = year;
    const rating = parseFloat((/card__rating">\s*★?\s*([\d.]+)/i.exec(block) || [])[1]);
    if (rating > 0 && rating <= 10) item.rating = Math.round(rating * 10) / 10;
    if (/badge-anime/.test(block)) item.genres = ["Anime"];
    out.push(item);
  }
  return out;
}

/** The suggest API's answer as items (series, anime and movies; its own type names them). */
export function slSuggestItems(list) {
  const out = [];
  for (const it of Array.isArray(list) ? list : []) {
    const path = String((it && it.url) || "").replace(SL.base, "");
    if (!/^\/(serie|pelicula)\/[^/]+$/.test(path) || !it.title) continue;
    const item = { id: idOf("sl", path), ref: `sl|${path}`, title: String(it.title).slice(0, 200), kind: path.startsWith("/pelicula/") ? "movie" : "series" };
    if (/^https?:\/\//.test(it.poster || "")) item.poster = it.poster;
    if (it.year) item.year = String(it.year);
    if (it.type === "anime") item.genres = ["Anime"];
    out.push(item);
  }
  return out;
}

/** Search: the JSON suggest API (plain), else the /buscar page through the hidden browser. Cached 10 min per text. */
async function slSearch(q) {
  await null;
  const key = "slsearch:" + q.toLowerCase().slice(0, 100);
  const cached = storageGet(key);
  if (cached && Array.isArray(cached.items)) return cached.items;
  if (slIsDown()) throw slUnavailable("en pausa tras un bloqueo");
  if (siteResting(SL.id)) throw restingError(SL.id);
  let items = null;
  try {
    const r = await siteFetch(SL.id, `${SL.base}/api/search/suggest?q=${encodeURIComponent(q)}`, {
      headers: { ...SL_HEADERS, Accept: "application/json", Referer: SL.base + "/" },
    }, { list: true });
    if (r.ok) items = slSuggestItems(r.json());
    else kino.log(`search sl suggest -> ${r.status}`);
  } catch (e) {
    kino.log(`search sl suggest: ${e.code || ""} ${e.message}`);
    // The site itself did not answer: a page read would not do better.
    if (e.code === "unavailable") throw e;
  }
  // Short texts never open the hidden browser: the person is still typing.
  if (!items && q.length >= 3) items = slCards(await slRead(`/buscar?q=${encodeURIComponent(q)}`, { waitFor: 'class="card"', list: true }));
  if (!items) items = [];
  storageSet(key, { items }, 10 * 60 * 1000);
  return items;
}

/**
 * hacktorrent-mirror's normalize.py: sololatino numbers some shows ABSOLUTELY (Naruto's "temporada-2" starts at
 * episode 53). A show is absolute when any season after the first starts above episode 2.
 */
export function numberingStyle(list) {
  const bySeason = new Map();
  for (const e of list) {
    const s = bySeason.get(e.season) || [];
    s.push(e.number);
    bySeason.set(e.season, s);
  }
  const seasons = [...bySeason.keys()].sort((a, b) => a - b);
  return seasons.slice(1).some((s) => Math.min(...bySeason.get(s)) > 2) ? "absolute" : "relative";
}

/** An absolute episode number placed in TMDB's seasons ([{ season, count }], specials skipped); null past the end. */
export function remapAbsolute(n, seasons) {
  let left = n;
  for (const s of [...seasons].sort((a, b) => a.season - b.season)) {
    if (s.season === 0) continue;
    if (left <= s.count) return [s.season, left];
    left -= s.count;
  }
  return null;
}

const titleKey = (t) => String(t || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\(\d{4}\)/g, "").replace(/[^a-z0-9]+/g, " ").trim();

/**
 * TMDB's season sizes for a show, counted from allcalidad's episode list of the show with the same title (its episodes
 * are TMDB's). Used only when it covers [needed] episodes: a partial list would squeeze every later episode out.
 */
async function tmdbSeasonsFor(title, needed) {
  const want = titleKey(title);
  const found = (await acSearch(title, { list: false })).find((i) => i.kind === "series" && titleKey(i.title) === want);
  if (!found) return null;
  const r = parseAcRef(found.ref);
  const list = await acGet(`/episodes?post_id=${r.post}`);
  const counts = new Map();
  for (const e of Array.isArray(list) ? list : []) {
    if (e && Number.isInteger(e.season_number) && e.season_number >= 1 && Number.isInteger(e.episode_number)) {
      counts.set(e.season_number, Math.max(counts.get(e.season_number) || 0, e.episode_number));
    }
  }
  const seasons = [...counts.entries()].map(([season, count]) => ({ season, count })).sort((a, b) => a.season - b.season);
  const total = seasons.reduce((n, s) => n + s.count, 0);
  if (!seasons.length || total < needed || seasons.some((s, i) => s.season !== i + 1)) return null;
  return seasons;
}

/** A sololatino series page's episodes: anchors to /temporada-N/episodio-M with their still and title. */
export function slEpisodes(html, path) {
  const out = [];
  const seen = new Set();
  const rx = /<a href="(https:\/\/sololatino\.net\/serie\/[^"]+\/temporada-(\d+)\/episodio-(\d+))"([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = rx.exec(html))) {
    const epPath = m[1].replace(SL.base, "");
    if (seen.has(epPath)) continue;
    seen.add(epPath);
    const ep = { season: parseInt(m[2], 10), number: parseInt(m[3], 10), ref: `sl|${epPath}` };
    if (!ep.season || !ep.number) continue;
    const img = /<img[^>]+>/i.exec(m[4]);
    const still = img ? attr(img[0], "src") : "";
    if (/^https?:\/\//.test(still)) ep.still = still;
    const t = text((/<p class="text-sm[^"]*">([\s\S]*?)<\/p>/i.exec(m[4]) || [])[1]);
    if (t && !/^E\d+$/.test(t)) ep.title = t.slice(0, 200);
    out.push(ep);
  }
  out.sort((a, b) => a.season - b.season || a.number - b.number);
  return out;
}

async function slEpisodesOf(ref) {
  const path = ref.slice(3);
  const html = await slRead(path, { waitFor: "episodio-" });
  let list = slEpisodes(html, path);
  if (!list.length) throw kino.error("not_found", "la serie no tiene episodios en SoloLatino");
  const series = {};
  const ld = /"@type":"TVSeries"[\s\S]*?"name":"((?:[^"\\]|\\.)*)"/.exec(html);
  if (ld) { try { series.title = JSON.parse(`"${ld[1]}"`); } catch (_) { /* the h1 below */ } }
  if (!series.title) series.title = text((/<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html) || [])[1]);
  const og = /<meta property="og:image" content="([^"]+)"/i.exec(html);
  if (og && /^https?:\/\//.test(og[1])) series.poster = og[1];
  const desc = /<meta name="description" content="([^"]*)"/i.exec(html);
  if (desc) series.overview = decode(desc[1]).slice(0, 2000);
  const imdb = (/imdb\.com\/title\/(tt\d{5,10})/.exec(html) || [])[1];
  if (imdb) {
    series.ids = { imdb };
    storageSet(imdbKey(imdb), { ref }, IMDB_MEMORY_MS);
  }
  if (numberingStyle(list) === "absolute" && series.title && activeSites().includes(AC.id) && !siteResting(AC.id)) {
    try {
      const needed = Math.max(...list.map((e) => e.number));
      const seasons = await within(tmdbSeasonsFor(series.title, needed), 6000, null);
      if (seasons) {
        const remapped = [];
        for (const e of list) {
          const at = remapAbsolute(e.number, seasons);
          if (at) remapped.push({ ...e, season: at[0], number: at[1] });
        }
        kino.log(`episodes ${ref}: absolute numbering remapped onto ${seasons.length} seasons (${list.length} -> ${remapped.length})`);
        list = remapped;
      } else kino.log(`episodes ${ref}: absolute numbering, but no complete season list: the site's numbers stay`);
    } catch (e) {
      kino.log(`episodes ${ref}: no season list for the remap (${e.code || ""} ${e.message}); the site's numbers stay`);
    }
  }
  kino.log(`episodes ${ref}: ${list.length}`);
  return { series, episodes: list };
}

/** The episode or movie page's player tokens, per language group: `[{ lang, token, label }]`. */
export function slTokens(html) {
  const out = [];
  const groups = /<div data-lang-group="([a-z]+)"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/gi;
  let g;
  while ((g = groups.exec(html))) {
    const lang = g[1] === "mx" ? "LAT" : g[1] === "es" ? "ESP" : "SUB";
    const btn = /<button[^>]*data-player-token="([^"]+)"[^>]*>([\s\S]*?)<\/button>/gi;
    let b;
    while ((b = btn.exec(g[2]))) out.push({ lang, token: b[1], label: text(b[2]).replace(/[^\p{L}\p{N} ]/gu, "").trim().toLowerCase() });
  }
  return out;
}

/** One player token to its player URL, the way the page's own script does (POST with the XSRF cookie's value). */
async function slPlayerUrl(token, referer, xsrf) {
  const r = await kino.fetch(`${SL.base}/api/player-url`, {
    method: "POST",
    headers: { ...SL_HEADERS, Accept: "application/json", "Content-Type": "application/json", Referer: referer, Origin: SL.base, ...(xsrf ? { "X-XSRF-TOKEN": xsrf } : {}) },
    body: { json: { t: token } }, timeoutMs: LIMITS.fetchMs,
  });
  if (!r.ok) {
    kino.log(`sl player-url -> ${r.status}`);
    return null;
  }
  const url = (r.json() || {}).url;
  return /^https:\/\//.test(url || "") ? url : null;
}

/**
 * sololatino's servers for an episode or movie: the player tokens resolved together (one XSRF cookie for all), embed69
 * players decrypted. `pages` is the episode page itself: the last resort when no embed69 player listed anything.
 */
async function slServers(ref) {
  const path = parseServerRef(ref).base.slice(3);
  const pageUrl = SL.base + path;
  const html = await slRead(path, { waitFor: "data-player-token" });
  const tokens = slTokens(html).slice(0, 6);
  kino.log(`resolve ${ref}: ${tokens.length} player token(s) [${tokens.map((t) => `${t.lang}/${t.label}`).join(", ")}]`);
  if (tokens.length) {
    await kino.fetch(`${SL.base}/sanctum/csrf-cookie`, { headers: { ...SL_HEADERS, Referer: pageUrl }, timeoutMs: LIMITS.fetchMs })
      .catch((e) => kino.log(`sl csrf-cookie: ${e.code || ""} ${e.message}`));
  }
  const xsrf = decodeURIComponent((kino.cookies && kino.cookies.get(SL.base + "/", "XSRF-TOKEN")) || "");
  const urls = await Promise.all(tokens.map((t) => slPlayerUrl(t.token, pageUrl, xsrf).catch((e) => { kino.log(`sl player-url: ${e.code || ""} ${e.message}`); return null; })));
  const players = [...new Set(urls.filter(Boolean))];
  const lists = await Promise.all(players.map(async (url) => {
    if (!/^https:\/\/embed69\.org\//.test(url)) {
      kino.log(`sl player ${safe(url)}: not an embed69 page, skipped`);
      return [];
    }
    return embed69From(url, pageUrl, "sl");
  }));
  const out = [];
  for (const f of [].concat(...lists)) if (!out.some((o) => o.url === f.url)) out.push(f);
  return { servers: out, pages: out.length ? [] : [pageUrl], html };
}

// ---------- telemetry ----------
//
// With "telemetry": true, a failed call's own kino.log lines already reach Kino's error board. kino.log.report is for
// what WORKED but degraded, by area: maraton:site (a site down, a 5xx, Cloudflare), maraton:page (a page read blocked),
// maraton:embed69 (its page changed or could not be read), maraton:extract (an embed's page no longer carries its
// playlist), maraton:capture (a hidden page showed no video, per server), maraton:browser (a device without a usable
// WebView), maraton:retry (Kino came back because the stream was refused), maraton:fallback (the ref's own site had no
// video and another site played the same title) and maraton:resolve (no copy at all, why, and how the fallback ended).
// Only codes and counts go in a report — our own site and server names, a status number, milliseconds — never a URL, a
// title or anything the person typed. Kino scrubs lines too, and allows one report per area an hour and 3 per plugin
// until it restarts, so the rare and telling ones are the ones reported.

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
  return String(s).replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
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

function startHost(url) {
  try { return new URL(url).host; } catch (_) { return ""; }
}

function originOf(url) {
  const m = /^(https?:\/\/[^/?#]+)/i.exec(url || "");
  return m ? m[1] : "";
}

/** `https://www.vimeos.net/…` -> "vimeos": the name a server goes by when the site does not give one. */
function hostLabel(url) {
  return startHost(url).toLowerCase().replace(/^www\./, "").split(".")[0] || "";
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

async function page(site, path, { list = false } = {}) {
  const id = siteCode(site);
  const r = await siteFetch(id, abs(site, path), { headers: { "User-Agent": UA, Accept: "text/html" } }, { list });
  if (!r.ok) {
    if (r.status !== 404) report("maraton:site", "http", `site=${id}`, `status=${r.status}`);
    throw kino.error(r.status === 404 ? "not_found" : r.status === 429 ? "rate_limited" : "unavailable", `${site.name} respondió ${r.status}`,
      { userMessage: r.status === 404 ? `${site.name} ya no tiene esta página.` : `${site.name} no está respondiendo bien (${r.status}).` });
  }
  const html = r.text();
  // Sites behind Cloudflare at times answer an interstitial: "unavailable", never parsed as content.
  if (looksLikeChallenge(html)) {
    siteFailed(id, "cloudflare");
    report("maraton:site", "cloudflare", `site=${id}`);
    throw kino.error("unavailable", `${site.name} pide verificación de Cloudflare`, { userMessage: `${site.name} está pidiendo una verificación que no se puede pasar desde aquí.` });
  }
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

// ---------- search ----------

/**
 * `scopedSearch`: what a "Ver más" page's own search field asks (`query.within` = that page's browse ref). A catalog
 * row is answered with the site's search, kept to that row's site and kind (a "Series" row never shows a movie); a
 * genre page is answered with `null`, which tells Kino to filter the titles it already loaded.
 */
export function scopeOf(within) {
  const [head, siteId, kind] = String(within || "").split("|");
  if (head !== "row" || !ALL_SITES.includes(siteId)) return null;
  if (siteId === "sk" && SITES.sk.catalog[kind]) return { siteId, keep: (i) => i.ref.startsWith(`sk|/${kind}/`) };
  if (siteId === AC.id && AC_TYPES[kind]) return { siteId, keep: (i) => i.ref.startsWith(`ac|${kind}/`) };
  return null;
}

async function scopedSearch(query, q) {
  const scope = scopeOf(query.within);
  if (!scope || !activeSites().includes(scope.siteId)) return null;
  const found = scope.siteId === AC.id ? await acSearch(q) : cards("sk", await page(SITES.sk, SITES.sk.search(q), { list: true }));
  const kept = found.filter(scope.keep);
  kino.log(`search within ${scope.siteId} row: ${found.length} found, ${kept.length} in the row`);
  return kino.rank.sortBySimilarity(kept, q, (it) => it.title).slice(0, 100);
}

/** One site's search, trying [tries] in order until something comes back. Throws when the site failed. */
async function searchSite(siteId, tries) {
  if (siteId === SL.id) return slSearch(tries[0]); // one try only: each may cost a page read
  for (const t of tries) {
    const t0 = Date.now();
    const found = siteId === AC.id ? await acSearch(t) : cards(siteId, await page(SITES[siteId], SITES[siteId].search(t), { list: true }));
    kino.log(`search ${siteId} "${t.slice(0, 60)}": ${found.length} results in ${Date.now() - t0} ms`);
    if (found.length) return found;
  }
  return [];
}

export async function search(query) {
  const q = String((query && query.q) || "").trim();
  if (!q) return [];
  if (query.within) return scopedSearch(query, q);
  // The guide's advice: the title Kino typed, its head (kino.rank.shortQuery), then TMDB's original title and the
  // other titles Kino knows, tried in that order until a site answers something. At most four tries per site.
  const tries = [q, kino.rank.shortQuery(q), query.originalTitle, ...(query.altTitles || [])]
    .map((t) => String(t || "").trim()).filter((v, i, a) => v && a.indexOf(v) === i).slice(0, 4);
  const sites = activeSites();
  let failed = 0;
  const late = [];
  const lists = await Promise.all(sites.map(async (siteId) => {
    try {
      const found = await within(searchSite(siteId, tries), LIMITS.searchMs, null);
      if (found === null) {
        late.push(siteId);
        failed++;
        return [];
      }
      return found;
    } catch (e) {
      kino.log(`search ${siteId}: ${e.code || ""} ${e.message}`);
      failed++;
      return [];
    }
  }));
  if (late.length) kino.log(`search: ${late.join(", ")} did not answer in ${LIMITS.searchMs} ms, left out`);
  const all = [].concat(...lists);
  // Every site failed: say so, instead of an empty "no results" that reads as "it does not exist".
  if (!all.length && failed === sites.length) {
    throw kino.error("unavailable", "ningún sitio respondió", { userMessage: "Los sitios de PelisYSeries no están respondiendo. Vuelve a intentar en un rato." });
  }
  const ranked = kino.rank.filterRelevant(kino.rank.sortBySimilarity(all, q, (it) => it.title), q, (it) => it.title).slice(0, 60);
  kino.log(`search: ${all.length} found, ${ranked.length} kept${ranked.length ? `, best ${ranked[0].ref}` : ""}`);
  return ranked;
}

// ---------- rows (Home, the plugin's own page) ----------

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

const ROW_ITEM_KEYS = ["id", "ref", "title", "kind", "year", "poster", "backdrop", "badges"];
/**
 * What a saved row keeps of each item, and how many: kino.storage holds 256 KB for everything (measured: 18 full rows
 * of 24 took 134 KB; 12 Home rows of 16 plus 6 genre rows of 10, slim, 67 KB).
 */
const slimItem = (i) => Object.fromEntries(ROW_ITEM_KEYS.filter((k) => i[k] !== undefined).map((k) => [k, i[k]]));
const rowKey = (id) => "row:" + id;

/**
 * One row's items with stale-while-revalidate: a row read in the last [LIMITS.rowFreshMs] is shown as it is; else the
 * site is asked, and whatever it does not answer by [deadlineAt] — late, down, resting — is replaced by its last good
 * items (kept [LIMITS.rowKeepMs]). The late read still saves its answer if it lands while the sandbox lives. Never
 * throws: no items at all is [].
 */
async function freshRow(id, load, deadlineAt, keep = 16) {
  const cached = storageGet(rowKey(id));
  if (cached && Array.isArray(cached.items) && Date.now() - (cached.at || 0) < LIMITS.rowFreshMs) return cached.items;
  const t0 = Date.now();
  const loading = Promise.resolve().then(load).then((items) => {
    if (items && items.length) storageSet(rowKey(id), { items: items.slice(0, keep).map(slimItem), at: Date.now() }, LIMITS.rowKeepMs);
    return items || [];
  });
  let items = null;
  try {
    items = await within(loading, deadlineAt - Date.now(), null);
    if (items === null) kino.log(`row ${id}: no answer in ${Date.now() - t0} ms${cached ? ", last good rows shown" : ""}`);
  } catch (e) {
    kino.log(`row ${id}: ${e.code || ""} ${e.message}${cached ? ", last good rows shown" : ""}`);
  }
  if (items && items.length) return items;
  return cached && Array.isArray(cached.items) ? cached.items : [];
}

/** What each catalog row reads (the first page of the site's own catalog). */
function catalogLoad(siteId, kind) {
  if (siteId === AC.id) return () => acListing(kind, 1).then((x) => x.items);
  // Home rows are also asked for by Kino on its own: a plain read only, never the hidden browser.
  if (siteId === SL.id) return () => slRead(SL_CATALOG[kind] + "1", { allowPage: false, list: true }).then(slCards);
  return () => page(SITES[siteId], SITES[siteId].catalog[kind] + "1", { list: true }).then((html) => cards(siteId, html));
}

async function catalogRow(siteId, kind, title, genre, deadlineAt) {
  const items = await freshRow(`${siteId}-${kind}`, catalogLoad(siteId, kind), deadlineAt);
  return items.length ? { id: `${siteId}-${kind}`, title, items, ref: `row|${siteId}|${kind}`, genre } : null;
}

/** serieskao's front page: "Nuevos episodios" and "Recién agregado" (no "Ver más": the site has no paged list of them). */
async function frontRows(deadlineAt) {
  let html = null;
  const load = (part) => async () => {
    if (html === null) html = page(SITES.sk, "/", { list: true });
    const h = await html;
    return part === "latest" ? latestEpisodes("sk", h) : recentlyAdded("sk", h);
  };
  const [latest, recent] = await Promise.all([freshRow("sk-latest", load("latest"), deadlineAt), freshRow("sk-recent", load("recent"), deadlineAt)]);
  const rows = [];
  if (latest.length) rows.push({ id: "sk-latest", title: "Nuevos episodios", items: latest, genre: "series" });
  if (recent.length) rows.push({ id: "sk-recent", title: "Recién agregado", items: recent });
  return rows;
}

/**
 * What each kind of content is called on each site, for Home and the plugin page's tabs. `genre` is the SDK's closed
 * vocabulary (contract.json "genres"): it is what lines rows up with other plugins' in Categorías.
 */
const ROWS = {
  series: [{ siteId: "sk", kind: "serie", title: "Series" }, { siteId: "ac", kind: "tvshows", title: "Series recientes" }, { siteId: "sl", kind: "serie", title: "Series en latino" }],
  anime: [{ siteId: "sk", kind: "anime", title: "Anime" }, { siteId: "ac", kind: "animes", title: "Anime reciente" }, { siteId: "sl", kind: "anime", title: "Anime en latino" }],
  peliculas: [{ siteId: "sk", kind: "pelicula", title: "Películas" }, { siteId: "ac", kind: "movies", title: "Películas recientes" }, { siteId: "sl", kind: "pelicula", title: "Películas en latino" }],
};

async function rowsOf(groups, sites, deadlineAt) {
  const wanted = [];
  for (const g of groups) for (const r of ROWS[g]) if (sites.includes(r.siteId)) wanted.push({ ...r, genre: g });
  return (await Promise.all(wanted.map((r) => catalogRow(r.siteId, r.kind, r.title, r.genre, deadlineAt).catch(() => null)))).filter(Boolean);
}

/** No rows at all and nothing saved: a sentence instead of an empty Home row. */
function nothingAnswered() {
  return kino.error("unavailable", "ningún sitio respondió", { userMessage: "Los sitios de PelisYSeries no están respondiendo. Vuelve a intentar en un rato." });
}

export async function home() {
  const t0 = Date.now();
  const deadlineAt = t0 + LIMITS.homeMs;
  const sites = activeSites();
  let out = [];
  try {
    const [front, rest] = await Promise.all([
      sites.includes("sk") ? frontRows(deadlineAt).catch(() => []) : [],
      rowsOf(["series", "anime", "peliculas"], sites, deadlineAt),
    ]);
    out = [...front, ...rest];
  } catch (e) {
    kino.log(`home: ${e.code || ""} ${e.message}`);
  }
  kino.log(`home: ${out.length} rows in ${Date.now() - t0} ms [${out.map((r) => `${r.id}:${r.items.length}`).join(", ")}]`);
  if (!out.length) throw nothingAnswered();
  return out;
}

// ---------- genres (Categorías tiles, browse, the Géneros tab) ----------

/**
 * One tile per genre the sites can list, with each site's own slug (serieskao: /generos/<slug>; allcalidad: its genre
 * taxonomy's slug). Read from both sites' genre lists on 2026-10-04; a missing slug means that site has no such genre.
 * Static on purpose: Categorías asks for tiles often and must not wait on the sites.
 */
export const GENRES = [
  { key: "accion", title: "Acción", sk: "accion", ac: "accion" },
  { key: "comedia", title: "Comedia", sk: "comedia", ac: "comedia" },
  { key: "drama", title: "Drama", sk: "drama", ac: "drama" },
  { key: "terror", title: "Terror", sk: "terror", ac: "terror" },
  { key: "animacion", title: "Animación", sk: "animacion", ac: "animacion" },
  { key: "ciencia-ficcion", title: "Ciencia ficción", sk: "ciencia-ficcion", ac: "ciencia-ficcion" },
  { key: "aventura", title: "Aventura", sk: "aventura", ac: "aventura" },
  { key: "suspense", title: "Suspenso", sk: "suspense", ac: "suspense" },
  { key: "crimen", title: "Crimen", sk: "crimen", ac: "crimen" },
  { key: "romance", title: "Romance", sk: "romance", ac: "romance" },
  { key: "misterio", title: "Misterio", sk: "misterio", ac: "misterio" },
  { key: "fantasia", title: "Fantasía", sk: "fantasia", ac: "fantasia" },
  { key: "familia", title: "Familia", sk: "familia", ac: "familia" },
  { key: "documental", title: "Documental", sk: "documental", ac: "documental" },
  { key: "historia", title: "Historia", sk: "historia", ac: "historia" },
  { key: "belica", title: "Bélica", sk: "belica", ac: "belica" },
  { key: "guerra", title: "Guerra y política", sk: "guerra", ac: "war-politics" },
  { key: "western", title: "Western", sk: "western", ac: "western" },
  { key: "dorama", title: "Doramas", sk: "dorama" },
  { key: "musica", title: "Música", ac: "musica" },
  { key: "infantil", title: "Infantil", ac: "kids" },
  { key: "reality", title: "Reality", ac: "reality" },
];

const genreByKey = (key) => GENRES.find((g) => g.key === key);

// A genre tile's picture: a real title of that genre, its wide backdrop first. Kept a day per genre; set when the
// genre's first page is read and none is kept; looked up for the missing ones in categories() within [LIMITS.artMs].
//
// Only a picture that was checked to load is kept (0.6.4). allcalidad lists backdrops that do not exist (measured
// 2026-10-04: two of Terror's first four backdrops answer 404 with an HTML page), and its newest title of a genre
// changes several times a day; 0.6.3 kept the first backdrop unchecked for 24 h, so one missing file left a tile
// blank for a whole day (Comedia on the Redmi). Now the backdrops are checked in order, then the posters, then
// serieskao's genre page; a candidate that cannot be checked in time is shown but not kept.
const ART_MS = 24 * 3600 * 1000;
/** "art2:": 0.6.3's unchecked "art:" entries are never read again. */
const artKey = (key) => "art2:" + key;
/** How many candidates one genre may check, one after another (each a HEAD, about half a second). */
const ART_TRIES = 5;

/**
 * A genre's picture candidates in order: the first three titles' wide backdrops, then every poster (a title whose
 * backdrop is missing usually has its poster: The Veil, measured), then the other backdrops; https only, each once.
 */
export function artCandidates(items) {
  const list = items || [];
  const out = [];
  for (const u of [...list.slice(0, 3).map((x) => x.backdrop), ...list.map((x) => x.poster), ...list.slice(3).map((x) => x.backdrop)]) {
    if (/^https:\/\//.test(u || "") && !out.includes(u)) out.push(u);
  }
  return out;
}

/** true: the picture loads; false: it does not (404, an HTML page); null: it could not be checked in time. */
async function artLoads(url, deadlineAt) {
  const ms = Math.min(2500, deadlineAt - Date.now());
  if (ms < 100) return null;
  try {
    const r = await kino.fetch(url, { method: "HEAD", headers: { "User-Agent": UA, Accept: "image/*" }, timeoutMs: ms });
    const h = r.headers || {};
    const type = String(h["content-type"] || h["Content-Type"] || "");
    return !!r.ok && (!type || /^image\//i.test(type));
  } catch (_) {
    return null;
  }
}

/**
 * The first candidate of [items] that loads: `{ art, sure }`, `sure` false when it could not be checked (shown, never
 * kept). `{ art: "" }` when every candidate tried is missing.
 */
export async function pickArt(items, deadlineAt) {
  const candidates = artCandidates(items).slice(0, ART_TRIES);
  for (const url of candidates) {
    const ok = await artLoads(url, deadlineAt);
    if (ok) return { art: url, sure: true };
    if (ok === null) return { art: url, sure: false };
  }
  return { art: "", sure: false };
}

/** Checks and keeps a genre's picture; the picture found ("" for none). */
async function refreshArt(key, items, deadlineAt) {
  const { art, sure } = await pickArt(items, deadlineAt);
  if (sure) storageSet(artKey(key), { art }, ART_MS);
  return art;
}

/** One genre's picture from allcalidad's first titles, else from serieskao's genre page (its posters). */
async function lookUpArt(g, sites, deadlineAt) {
  if (g.ac && sites.includes(AC.id) && !siteResting(AC.id)) {
    try {
      const art = await refreshArt(g.key, await acGenre(g.ac, 1, { perPage: 8 }), deadlineAt);
      if (art) return art;
      kino.log(`art ${g.key}: no allcalidad picture loads`);
    } catch (e) {
      kino.log(`art ${g.key}: allcalidad ${e.code || ""}`);
    }
  }
  if (g.sk && sites.includes("sk") && !siteResting("sk") && deadlineAt - Date.now() > 800) {
    const html = await page(SITES.sk, `/generos/${g.sk}?page=1`, { list: true });
    return refreshArt(g.key, cards("sk", html), deadlineAt);
  }
  return "";
}

/**
 * The tiles of the active sites (Categorías ▸ PelisYSeries), each opening `browse("genre|<key>")`, at most 24 (SDK cap),
 * each with `art` when one is known. Never slower than [LIMITS.artMs] and never failing because of a picture.
 */
export async function categories() {
  const sites = activeSites();
  const genres = GENRES.filter((g) => sites.some((id) => g[id])).slice(0, 24);
  const art = {};
  for (const g of genres) art[g.key] = (storageGet(artKey(g.key)) || {}).art || "";
  const missing = genres.filter((g) => !art[g.key]);
  if (missing.length) {
    const t0 = Date.now();
    const deadlineAt = t0 + LIMITS.artMs;
    const lookups = Promise.all(missing.map((g) => lookUpArt(g, sites, deadlineAt)
      .then((found) => { art[g.key] = found || art[g.key]; })
      .catch((e) => kino.log(`art ${g.key}: ${e.code || ""}`))));
    const done = await within(lookups, LIMITS.artMs, null).catch(() => null);
    kino.log(`categories: art for ${missing.filter((g) => art[g.key]).length}/${missing.length} missing genre(s) in ${Date.now() - t0} ms${done === null ? " (cut)" : ""}`);
  }
  return genres.map((g) => {
    const tile = { id: `genre-${g.key}`, title: g.title, ref: `genre|${g.key}` };
    if (/^https:\/\//.test(art[g.key] || "")) tile.art = art[g.key];
    return tile;
  });
}

/**
 * One page of a genre, both sites at once, interleaved so neither buries the other; the cursor is the page number
 * (both sites page by 24). A site that fails, rests or has no such genre just adds nothing.
 */
async function genrePage(key, n, deadlineAt = Date.now() + LIMITS.homeMs) {
  const g = genreByKey(key);
  if (!g) throw kino.error("not_found", "género desconocido");
  const sites = activeSites();
  const part = (on, load, label) => (on ? within(Promise.resolve().then(load), deadlineAt - Date.now(), null)
    .then((x) => { if (x === null) kino.log(`genre ${label}/${key}: no answer in time`); return x || []; })
    .catch((e) => { kino.log(`genre ${label}/${key}: ${e.code || ""} ${e.message}`); return []; }) : Promise.resolve([]));
  const [sk, ac] = await Promise.all([
    part(sites.includes("sk") && g.sk, () => page(SITES.sk, `/generos/${g.sk}?page=${n}`, { list: true }).then((html) => cards("sk", html)), "sk"),
    part(sites.includes("ac") && g.ac, () => acGenre(g.ac, n), "ac"),
  ]);
  const items = [];
  for (let i = 0; i < Math.max(sk.length, ac.length); i++) {
    if (sk[i]) items.push(sk[i]);
    if (ac[i]) items.push(ac[i]);
  }
  // Page 1 refreshes the genre's picture (checked, so a missing file is never kept), in what is left of a short window.
  if (n === 1 && items.length && !storageGet(artKey(key))) {
    await within(refreshArt(key, ac.length ? ac : items, Math.min(deadlineAt, Date.now() + 1500)), 1500, null).catch(() => null);
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

/**
 * The page's hero: a featured title of the tab with a real picture — the first with a wide backdrop, else the first
 * with a poster. No picture at all, no hero: a text-only hero left a blank band above the rows on the phone (Redmi,
 * v0.5.5).
 */
export function heroOf(rows) {
  const items = rows.flatMap((r) => r.items || []);
  const featured = items.find((i) => i.backdrop) || items.find((i) => i.poster);
  if (!featured) return null;
  const lang = ({ lat: "latino", esp: "castellano", sub: "versión subtitulada" })[preferredLang()];
  const text = featured.overview || `Para ver en ${lang}. Cambia el idioma, los sitios y el servidor en Ajustes ▸ PelisYSeries.`;
  return { title: featured.title, text: text.slice(0, 300), image: featured.backdrop || featured.poster };
}

export async function section({ tab } = {}) {
  const t0 = Date.now();
  const deadlineAt = t0 + LIMITS.homeMs;
  const chosen = TABS.some((t) => t.id === tab) ? tab : "series";
  const sites = activeSites();
  let rows = [];
  try {
    if (chosen === "generos") {
      rows = (await Promise.all(TAB_GENRES.map(async (key) => {
        const items = await freshRow(`genre-${key}`, () => genrePage(key, 1, deadlineAt), deadlineAt, 10);
        return items.length ? { id: `genre-${key}`, title: genreByKey(key).title, items: items.slice(0, 30), ref: `genre|${key}` } : null;
      }))).filter(Boolean);
    } else {
      const [front, rest] = await Promise.all([
        chosen === "series" && sites.includes("sk") ? frontRows(deadlineAt).catch(() => []) : [],
        rowsOf([chosen], sites, deadlineAt),
      ]);
      rows = [...front, ...rest];
    }
  } catch (e) {
    kino.log(`section ${chosen}: ${e.code || ""} ${e.message}`);
  }
  const hero = heroOf(rows);
  kino.log(`section ${chosen}: ${rows.length} rows in ${Date.now() - t0} ms, hero ${hero ? "with image" : "none"}`);
  if (!rows.length) throw nothingAnswered();
  return hero ? { tabs: TABS, tab: chosen, hero, rows } : { tabs: TABS, tab: chosen, rows };
}

export async function browse(ref, cursor) {
  const n = Math.max(1, parseInt(cursor || "1", 10) || 1);
  if (String(ref).startsWith("genre|")) {
    const items = await genrePage(String(ref).slice(6), n);
    if (!items.length && n === 1) throw nothingAnswered();
    return items.length ? { items, next: String(n + 1) } : { items };
  }
  const [, siteId, kind] = String(ref).split("|");
  if (siteId === SL.id) {
    if (!SL_CATALOG[kind]) throw kino.error("not_found", "fila desconocida");
    const items = slCards(await slRead(SL_CATALOG[kind] + n, { waitFor: 'class="card"', list: true }));
    return items.length ? { items, next: String(n + 1) } : { items };
  }
  if (siteId === AC.id) {
    // Rows saved before 0.6.2 name the old API's kinds.
    const type = { movie: "movies", tvshow: "tvshows", anime: "animes" }[kind] || kind;
    if (!AC_TYPES[type]) throw kino.error("not_found", "fila desconocida");
    const { items, more } = await acListing(type, n);
    return more && items.length ? { items, next: String(n + 1) } : { items };
  }
  const site = SITES[siteId];
  if (!site || !site.catalog[kind]) throw kino.error("not_found", "fila desconocida");
  const items = cards(siteId, await page(site, site.catalog[kind] + n, { list: true }));
  return items.length ? { items, next: String(n + 1) } : { items };
}

// ---------- episodes ----------

/**
 * `<episodeRef>#<lang>/<server>` addresses ONE server of an episode (`sk|/serie/dark/temporada/1/capitulo/1#esp/voe`):
 * what a labeled alternative hands back to resolve. Without `#`, resolve picks the server itself.
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
  await null;
  if (String(ref).startsWith("ac|")) return acEpisodes(String(ref));
  if (String(ref).startsWith("sl|")) return slEpisodesOf(String(ref));
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

// ---------- a device without a usable hidden browser ----------
//
// Some TV boxes' WebView cannot run a hidden page in isolation (Kino answers `browser_unavailable`). Learned once, it is
// kept for [NO_BROWSER_MS]: those devices go straight to the servers whose page carries its own playlist.

const NO_BROWSER_KEY = "nobrowser";
const NO_BROWSER_MS = 6 * 3600 * 1000;

export function browserMissing() {
  if (!kino.browser || typeof kino.browser.capture !== "function") return true;
  return !!storageGet(NO_BROWSER_KEY);
}

function noteNoBrowser() {
  if (storageGet(NO_BROWSER_KEY)) return;
  storageSet(NO_BROWSER_KEY, { at: Date.now() }, NO_BROWSER_MS);
  kino.log("browser: this device has no usable hidden browser; servers that need it are skipped for a while");
  report("maraton:browser", "unavailable");
}

// ---------- resolve: listing the servers ----------

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
  return out.slice(0, MAX_CAPTURES);
}

/** At most this many hidden pages per resolve (plus one second try of a page that gave up early). */
const MAX_CAPTURES = 3;

// ---------- embed69 (same logic web-resolver ran as bypassEmbed69) ----------
//
// serieskao's `/vidurl/<imdb>-<s>x<ee>/` player page and sololatino's embed69 player are embed69 pages: their `dataLink`
// JSON lists every server, each link AES-CBC encrypted (base64 of iv || ciphertext). The key is either written in the
// page (`decryptLink(server.link, 'KEY')`) or derived from a small SHA-256 proof of work (POW_CHALLENGE /
// POW_DIFFICULTY / POW_SALT). A title embed69 does not have answers a small JSON error ("No folders found").

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const POW_MAX_NONCE = 2000000;
const EMBED69_REFERER = "https://embed69.org/";

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

/**
 * An embed69 answer, classified: `{ servers, why }` with `why` "ok", "not_listed" (embed69 has no such title: its JSON
 * error), "no_key" (neither a written key nor a proof of work: the page changed), "no_list" (no dataLink) or "empty"
 * (a list whose links did not decrypt into any server).
 */
export function embed69Answer(html) {
  const h = String(html || "");
  if (/^\s*\{[\s\S]*"error"/.test(h) || /No folders found/i.test(h)) return { servers: [], why: "not_listed" };
  let keyHex = null;
  const m = /decryptLink\(server\.link,\s*'(.+?)'\),/.exec(h);
  if (m) keyHex = utf8ToHex(m[1]);
  if (!keyHex) {
    const pm = /POW_CHALLENGE\s*=\s*'([^']+)';[\s\S]*?POW_DIFFICULTY\s*=\s*(\d+);[\s\S]*?POW_SALT\s*=\s*'([^']+)';/.exec(h);
    if (pm) keyHex = solvePow(pm[1], parseInt(pm[2], 10), pm[3]);
  }
  const dlm = /dataLink\s*=\s*(\[[\s\S]*?\])\s*;/.exec(h) || /dataLink\s*=\s*([^;]+)/.exec(h);
  if (!dlm) return { servers: [], why: "no_list" };
  if (!keyHex) return { servers: [], why: "no_key" };
  let dataLink;
  try { dataLink = JSON.parse(dlm[1].replace(/\\\//g, "/")); } catch (_) { return { servers: [], why: "no_list" }; }
  const out = [];
  for (const sec of Array.isArray(dataLink) ? dataLink : []) {
    const lang = (sec && sec.video_language) || "LAT";
    for (const emb of (sec && sec.sortedEmbeds) || []) {
      if (!emb || emb.servername === "download") continue;
      const url = crylink(emb.link, keyHex);
      if (url && /^https?:\/\//.test(url)) out.push({ lang, server: String(emb.servername || hostLabel(url)).toLowerCase(), url: url.trim(), referer: EMBED69_REFERER });
    }
  }
  out.sort((a, b) => (/lat/i.test(b.lang) ? 1 : 0) - (/lat/i.test(a.lang) ? 1 : 0));
  return { servers: out, why: out.length ? "ok" : "empty" };
}

/** Decrypted servers of an embed69 page: `[{ lang, server, url }]`, latino first, downloads left out. */
export function embed69Servers(html) {
  return embed69Answer(html).servers;
}

/** One embed69 page read and classified; a title it does not list is a quiet [], a changed page is reported. */
async function embed69From(url, referer, siteId) {
  const t0 = Date.now();
  let r;
  try {
    r = await kino.fetch(url, { headers: { "User-Agent": UA, Accept: "text/html", Referer: referer }, timeoutMs: LIMITS.fetchMs });
  } catch (e) {
    kino.log(`embed69 ${safe(url)}: ${e.code || ""} ${e.message}`);
    report("maraton:embed69", "fetch", `site=${siteId}`, `code=${e.code || "network"}`);
    return [];
  }
  if (!r.ok) {
    kino.log(`embed69 ${safe(url)} -> ${r.status}`);
    if (r.status !== 404) report("maraton:embed69", "http", `site=${siteId}`, `status=${r.status}`);
    return [];
  }
  const { servers, why } = embed69Answer(r.text());
  kino.log(`embed69 ${safe(url)}: ${why}, ${servers.length} server(s) in ${Date.now() - t0} ms [${servers.map((f) => `${f.lang}/${f.server}@${startHost(f.url)}`).join(", ")}]`);
  // The page loaded but nothing decrypted: embed69 changed its page (key, proof of work or dataLink).
  if (why !== "ok" && why !== "not_listed") report("maraton:embed69", why, `site=${siteId}`, `ms=${Date.now() - t0}`);
  return servers;
}

/** Every embed69 server behind the episode's own player pages (`/vidurl/…`), or [] when there is none. */
async function fastServers(site, episodeUrl, servers) {
  const lists = await Promise.all(servers.filter((u) => u.startsWith(site.base)).slice(0, 3).map((s) => embed69From(s, episodeUrl, siteCode(site))));
  const out = [];
  for (const f of [].concat(...lists)) if (!out.some((o) => o.url === f.url)) out.push(f);
  return out;
}

// ---------- reading an embed's own playlist (no hidden browser) ----------
//
// Measured 2026-10-04: vimeos.net, morencius.com (vidhide), hlswish.com (streamwish; the ids hglink.to hands out work
// there too) and goodstream.one write the playlist into their page — vidhide and streamwish as `links = { hls4, hls2,
// hls3 }` inside a p,a,c,k,e,d-packed script, vimeos as a packed jwplayer `sources`, goodstream in the clear.
// videoapp.zip frames a vimeos page. The playlist's token is tied to the address that read the page (and some CDNs to
// its User-Agent), so the page is read with [UA] and the Stream carries that same User-Agent and the embed's Referer:
// the player then asks exactly as the page's own player would.

/** Hosts whose page carries the playlist; `page` maps an embed URL to the page that is read. */
const EXTRACTORS = [
  { name: "vimeos", rx: /(^|\.)vimeos\.net$/i, page: (u) => u },
  { name: "goodstream", rx: /(^|\.)goodstream\.one$/i, page: (u) => u },
  { name: "vidhide", rx: /(^|\.)morencius\.com$/i, page: (u) => u },
  { name: "streamwish", rx: /(^|\.)(hglink\.to|hlswish\.com)$/i, page: (u) => u.replace(/^https:\/\/[^/]+\/e\/([A-Za-z0-9]+).*$/, "https://hlswish.com/e/$1") },
  { name: "videoapp", rx: /(^|\.)videoapp\.zip$/i, page: (u) => u, frames: true },
];

const extractorOf = (f) => EXTRACTORS.find((x) => x.rx.test(startHost((f && f.url) || ""))) || null;
export const canExtract = (f) => !!extractorOf(f);

/** Every `eval(function(p,a,c,k,e,d){…}('…',a,c,'…'.split('|')…))` in [html], unpacked. */
export function unpackAll(html) {
  const out = [];
  const rx = /\}\('((?:[^'\\]|\\.)*)',\s*(\d+),\s*(\d+),\s*'((?:[^'\\]|\\.)*)'\.split\('\|'\)/g;
  let m;
  while ((m = rx.exec(String(html || "")))) {
    const a = parseInt(m[2], 10);
    let c = parseInt(m[3], 10);
    const k = m[4].split("|");
    const p = m[1].replace(/\\'/g, "'").replace(/\\\\/g, "\\");
    if (!(a >= 2 && a <= 62) || c > 50000) continue;
    const enc = (n) => (n < a ? "" : enc(Math.floor(n / a))) + ((n = n % a) > 35 ? String.fromCharCode(n + 29) : n.toString(36));
    const dict = Object.create(null);
    while (c--) dict[enc(c)] = k[c] || enc(c);
    out.push(p.replace(/\b\w+\b/g, (w) => (w in dict ? dict[w] : w)));
  }
  return out.join("\n");
}

/** The playlists and subtitles an embed page writes for its player: `{ playlists: [url], subtitles: [{ url, label }], gone }`. */
export function playlistsOf(html, pageUrl) {
  const src = `${html}\n${unpackAll(html)}`;
  const playlists = [];
  const add = (u) => {
    if (!u || typeof u !== "string") return;
    let url = u.replace(/\\\//g, "/").trim();
    if (url.startsWith("/") && !url.startsWith("//")) url = originOf(pageUrl) + url;
    // Only real .m3u8 playlists: the `hls3` master.txt hung on every read measured (2026-10-04), a dead alternative.
    if (/^https:\/\//.test(url) && /\.m3u8(\?|$)/i.test(url) && !looksLikeAd(url) && !playlists.includes(url)) playlists.push(url);
  };
  const links = /links\s*=\s*(\{[^{}]*\})/.exec(src);
  if (links) {
    try {
      const o = JSON.parse(links[1]);
      for (const k of ["hls4", "hls2", "hls3"]) add(o[k]);
      for (const k of Object.keys(o)) add(o[k]);
    } catch (_) { /* the sources below */ }
  }
  const files = /(?:file|src)\s*:\s*["']([^"']+)["']/g;
  let m;
  while ((m = files.exec(src))) add(m[1]);
  const subtitles = [];
  const tracks = /\{\s*file\s*:\s*"([^"]+\.(?:vtt|srt)[^"]*)"\s*,\s*label\s*:\s*"([^"]*)"\s*,\s*kind\s*:\s*"captions"/g;
  while ((m = tracks.exec(src))) {
    if (/^https:\/\//.test(m[1]) && !/empty\.srt/.test(m[1])) subtitles.push({ url: m[1], label: m[2] });
  }
  const gone = /file is no longer available|file was deleted|video not found|has been deleted|file not found/i.test(html);
  return { playlists, subtitles, gone };
}

/** The headers a playlist from [pageUrl] goes with: our User-Agent (the one that read the page) and the page as Referer. */
export function extractedHeaders(pageUrl, mediaUrl) {
  const origin = originOf(pageUrl);
  const h = { "User-Agent": UA, Referer: origin + "/" };
  if (startHost(mediaUrl) !== startHost(pageUrl)) h.Origin = origin;
  return h;
}

/**
 * One server's playlist read from its page with kino.fetch, as a capture-shaped answer `{ media, subtitles, how }`;
 * `{ gone: true }` when the page says the file was deleted and `{ down }` when the host did not answer (no hidden page
 * will do better in either case); null (logged) when the page answered without a playlist. Never throws.
 */
async function extractServer(f, timeoutMs) {
  const x = extractorOf(f);
  if (!x) return null;
  const t0 = Date.now();
  let url = x.page(f.url);
  let referer = f.referer || EMBED69_REFERER;
  try {
    for (let hop = 0; hop < 2; hop++) {
      const r = await kino.fetch(url, { headers: { "User-Agent": UA, Accept: "text/html", Referer: referer }, timeoutMs: Math.max(1000, Math.min(timeoutMs, LIMITS.fetchMs)) });
      if (!r.ok) {
        kino.log(`extract ${x.name}: ${safe(url)} -> ${r.status}`);
        return null;
      }
      const html = r.text();
      if (x.frames && hop === 0) {
        // videoapp: the real player is the page it frames.
        const inner = (/<iframe[^>]+src="(https:\/\/[^"]+)"/i.exec(html) || [])[1];
        if (!inner || !EXTRACTORS.some((e) => !e.frames && e.rx.test(startHost(inner)))) {
          kino.log(`extract ${x.name}: no player frame (${/no disponible/i.test(html) ? "not available" : "changed"})`);
          return null;
        }
        referer = originOf(url) + "/";
        // Framed with `?cf=<session>` the vimeos page is another player (its setup compressed in the page); without
        // it, the plain embed page with its packed playlist (measured 2026-10-04).
        url = decode(inner).split("?")[0];
        continue;
      }
      const { playlists, subtitles, gone } = playlistsOf(html, url);
      if (!playlists.length) {
        kino.log(`extract ${x.name}: ${gone ? "file gone" : "no playlist in the page"} after ${Date.now() - t0} ms`);
        if (gone) return { gone: true };
        report("maraton:extract", "no_playlist", `server=${x.name}`);
        return null;
      }
      kino.log(`extract ${x.name}: ${playlists.length} playlist(s) in ${Date.now() - t0} ms [${playlists.map(safe).join(", ")}]`);
      return {
        how: "page",
        media: playlists.map((u) => ({ url: u, mime: "application/vnd.apple.mpegurl", headers: extractedHeaders(url, u) })),
        subtitles: subtitles.slice(0, 5).map((s) => ({ url: s.url })),
      };
    }
  } catch (e) {
    kino.log(`extract ${x.name}: ${e.code || ""} ${e.message} after ${Date.now() - t0} ms`);
    // The embed's own host does not answer this device: its hidden page would not load either.
    if (e.code === "timeout" || e.code === "network") return { down: e.code };
  }
  return null;
}

// ---------- resolve: choosing the order ----------

/**
 * Which embed hosts to try first, measured on a Fire TV (Dark 1x01): streamwish (hglink.to) handed over its m3u8 in
 * 9 s; vidhide (morencius.com) works when opened top-level (Redmi: 8.9 s). Unknown servers go between.
 */
const SERVER_PREFERENCE = [
  { rx: /streamwish|hglink|hlswish/i, rank: 0 },
  // allcalidad's vimeos plays (its 403 was Kino's proxy connecting over IPv6, fixed); goodstream's video hosts were
  // unreachable from the test network (Redmi, 2026-10-04), so vimeos goes first.
  { rx: /vimeos/i, rank: 1 },
  { rx: /goodstream/i, rank: 2.5 },
  { rx: /vidhide|morencius/i, rank: 3 },
  { rx: /filemoon/i, rank: 3.5 },
  // Redmi, 2026-10-04: voe.sx now shows an ALTCHA human check before its player, so its capture comes back `blocked`.
  { rx: /voe/i, rank: 4 },
  // videoapp frames a vimeos page that the same title usually lists by itself.
  { rx: /videoapp/i, rank: 5 },
];
const UNKNOWN_SERVER_RANK = 2;

function serverRank(f) {
  const hit = SERVER_PREFERENCE.find((p) => p.rx.test(f.server || "") || p.rx.test(startHost(f.url)));
  return hit ? hit.rank : UNKNOWN_SERVER_RANK;
}

/**
 * The servers the "Probar primero" setting can name, matched by server name or host (streamwish answers on
 * hglink.to and hlswish.com, vidhide on morencius.com). [SERVER_LABEL] is how the status line names them.
 */
const SERVER_MATCH = {
  streamwish: /streamwish|hglink|hlswish/i, voe: /voe/i, vidhide: /vidhide|morencius/i, vimeos: /vimeos/i, goodstream: /goodstream/i,
  filemoon: /filemoon/i, videoapp: /videoapp/i,
};
const SERVER_LABEL = { streamwish: "Streamwish", voe: "Voe", vidhide: "Vidhide", vimeos: "Vimeos", goodstream: "Goodstream", filemoon: "Filemoon", videoapp: "Videoapp" };

/** Our name for a server ("streamwish"), else "other": a code safe to report. */
function serverName(f) {
  return Object.keys(SERVER_MATCH).find((k) => serverMatches(f, k)) || (f && f.lang ? "other" : "episode_page");
}

function serverMatches(f, name) {
  const rx = SERVER_MATCH[name];
  return !!rx && !!f && (rx.test(f.server || "") || rx.test(startHost(f.url)));
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
 * language the server "Probar primero" names, then the servers whose page carries its own playlist (no hidden browser,
 * about a second; on a device without a usable browser the only ones that can play), then the one that last produced a
 * video on this site ([remembered]), then [SERVER_PREFERENCE]; the page's own order breaks ties.
 */
export function rankServers(list, preferred = "lat", remembered = "", chosen = "auto") {
  const langOrder = [preferred, ...LANGS.filter((l) => l !== preferred)];
  const langRank = (f) => { const i = langOrder.indexOf(langOf(f.lang)); return i < 0 ? LANGS.length : i; };
  const pick = (f) => (chosen && chosen !== "auto" && serverMatches(f, chosen) ? 0 : 1);
  const direct = (f) => (canExtract(f) ? 0 : 1);
  const memo = (f) => (remembered && ((f.server || "").toLowerCase() === remembered || serverName(f) === remembered) ? 0 : 1);
  return list
    .map((f, i) => ({ f, i }))
    .sort((a, b) => (langRank(a.f) - langRank(b.f)) || (pick(a.f) - pick(b.f)) || (direct(a.f) - direct(b.f)) || (memo(a.f) - memo(b.f)) || (serverRank(a.f) - serverRank(b.f)) || (a.i - b.i))
    .map((x) => x.f);
}

/**
 * How long a hidden page may look for its video, per server, measured: streamwish's hglink page hops two or three
 * hosts before its player starts (9 s on a Fire TV, up to 20 s on a slow box); vidhide 9 s; voe either plays at once or
 * shows its human check (which ends the capture by itself). Capped by what is left of resolve's budget.
 */
const CAPTURE_WINDOW_MS = { streamwish: 22000, vidhide: 16000, vimeos: 14000, goodstream: 14000, filemoon: 16000, videoapp: 16000, voe: 12000, other: 16000, episode_page: 25000 };

export function captureWindow(f) {
  return CAPTURE_WINDOW_MS[serverName(f)] || CAPTURE_WINDOW_MS.other;
}

/** Kept for the kit and older tests: a page gets 15 s while others remain and the whole 25 s when it is the last. */
export function captureTimeout(pagesLeftAfterThis) {
  return pagesLeftAfterThis > 0 ? 15000 : 25000;
}

// ---------- what resolve remembers (kino.storage) ----------

const STREAM_CACHE_MAX_MS = 4 * 3600 * 1000;
/** A stream that does not say when it ends, or that leans on the page's cookies, is kept only briefly. */
const STREAM_CACHE_SHORT_MS = 10 * 60 * 1000;
const EXPIRY_MARGIN_S = 10 * 60;
const MAX_EXPIRES_S = 86400;
const MIN_EXPIRES_S = 30;

/**
 * When a captured URL stops working, in seconds from [nowS], or null when it does not say. Two shapes, measured
 * 2026-10-04: a Unix time in the path (`/stream/<token>/<x>/1791135524/<id>/master.m3u8`, 12 h after the capture), or
 * `s=<issued>&e=<lifetime in s>` in the query (vimeos, goodstream, vidhide's hls2: 12 h or 36 h). A time in the past or
 * more than a week ahead is not one.
 */
export function expiresInOf(url, nowS = Math.floor(Date.now() / 1000)) {
  const [path, query = ""] = String(url).split("#")[0].split("?");
  const ok = (x) => x > nowS + MIN_EXPIRES_S && x < nowS + 7 * 86400;
  const times = (path.match(/(?:^|\/)(1\d{9})(?=\/|$)/g) || []).map((t) => parseInt(t.replace("/", ""), 10));
  let t = times.find(ok);
  if (!t) {
    const q = new URLSearchParams(query);
    const s = parseInt(q.get("s"), 10);
    const e = parseInt(q.get("e"), 10);
    if (/^1\d{9}$/.test(String(s)) && e > 0 && e <= 7 * 86400 && ok(s + e)) t = s + e;
  }
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
  try { kino.storage.set(key, JSON.stringify(value), ttlMs ? { ttlMs: Math.max(1, Math.min(2592000000, Math.floor(ttlMs))) } : undefined); } catch (e) { kino.log(`storage: ${e.message}`); }
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

/** How long a stream may be reused: never past its own expiry (with a margin), briefly when unknown or cookie-bound. */
export function keepStreamMs(stream, nowMs = Date.now()) {
  const exp = stream.expiresInSeconds ? stream.expiresInSeconds * 1000 - EXPIRY_MARGIN_S * 1000 : 0;
  let keep = exp > 0 ? Math.min(STREAM_CACHE_MAX_MS, exp) : STREAM_CACHE_SHORT_MS;
  if (Object.keys(stream.headers || {}).some((k) => k.toLowerCase() === "cookie")) keep = Math.min(keep, STREAM_CACHE_SHORT_MS);
  return keep;
}

function preferredLang() {
  const v = configValue("lang", "lat");
  return LANGS.includes(v) ? v : "lat";
}

// ---------- resolve ----------

/** At most this many lazy copies: the automatic fallback walks them in order, so a long tail only delays the error. */
const MAX_LAZY = 5;

/** "Latino · Streamwish": how the player's Servidor list names one copy (at most 48 characters). */
export function copyLabel(f) {
  if (!f || !f.url) return "";
  const known = Object.keys(SERVER_MATCH).find((k) => serverMatches(f, k));
  const name = known ? SERVER_LABEL[known] : (f.server || startHost(f.url) || "Servidor");
  const lang = f.lang ? LANG_LABEL[langOf(f.lang)] : "";
  return (lang ? `${lang} · ${name}` : String(name)).slice(0, 48);
}

/**
 * The headers the player sends, exactly the ones the page's own request carried (User-Agent, Referer, Origin, Cookie…);
 * only a missing Referer is filled with the page's origin. Kino sends them with the playlist, its segments and keys.
 */
export function playHeaders(headers, fallbackReferer) {
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) if (typeof v === "string" && v && !/[\r\n]/.test(v)) out[k] = v;
  if (fallbackReferer && !Object.keys(out).some((k) => k.toLowerCase() === "referer")) out.Referer = fallbackReferer;
  return out;
}

/**
 * The other copies of a title as alternatives, best first, at most 8: first the extra playlists the same page gave (a
 * variant of the copy that is playing, concrete URLs), then every other server and language as a LAZY copy
 * `{ label, ref }` that Kino resolves through `resolve(<ref>#<lang>/<server>)` only if the person picks it in the
 * player's Servidor list or the fallback reaches it. Servers that failed lately or here are left out, and so is
 * every server that needs the hidden browser on a device that has none.
 */
export function alternativesOf(rest, playing, others, ref, failed = new Set(), { needBrowser = false } = {}) {
  const out = rest.map((m) => {
    const a = { url: m.url, headers: m.headers };
    if (m.mime) a.mime = m.mime;
    if (playing && playing.url) a.label = `${copyLabel(playing)} (otra lista)`.slice(0, 48);
    return a;
  });
  let lazy = 0;
  const seen = new Set();
  for (const f of others) {
    if (playing && f.url === playing.url) continue;
    if (failed.has(serverName(f))) continue;
    if (needBrowser && !canExtract(f)) continue;
    const r = serverRef(ref, f);
    if (seen.has(r)) continue;
    seen.add(r);
    if (lazy++ >= MAX_LAZY) break;
    out.push({ label: copyLabel(f), ref: r });
  }
  return out.slice(0, 8);
}

function streamOf(got, server, others = [], ref = "", failed = new Set(), opts = {}) {
  const [first, ...more] = got.media;
  // Never an MP4 next to a manifest (filmMedia already drops them; this guards any other caller).
  const rest = (got.media.some(isManifest) ? more.filter((m) => !isMp4(m)) : more).slice(0, 3);
  const referer = opts.referer || "";
  const stream = { url: first.url, headers: playHeaders(first.headers, referer) };
  if (first.mime) stream.mime = first.mime;
  const label = copyLabel(server);
  if (label) stream.label = label;
  const alternatives = alternativesOf(rest.map((m) => ({ ...m, headers: playHeaders(m.headers, referer) })), server, others, ref, failed, opts);
  if (alternatives.length) stream.alternatives = alternatives;
  // The embed's own subtitle tracks: these sites only carry Spanish ones; the label says which audio they came with.
  const subLabel = server && server.lang ? `Español (${LANG_LABEL[langOf(server.lang)]})` : "Español";
  const subs = (got.subtitles || []).slice(0, 10).map((s) => ({ lang: s.lang || "es", label: subLabel, url: s.url, format: /\.srt(\?|$)/i.test(s.url) ? "srt" : "vtt" }));
  if (subs.length) stream.subtitles = subs;
  const exp = expiresInOf(first.url);
  if (exp) stream.expiresInSeconds = exp;
  return stream;
}

const siteOfRef = (ref) => String(ref).slice(0, String(ref).indexOf("|"));

/** The servers of a ref, the pages a hidden browser may still dig a video out of, and the page itself (for its title). */
async function listServers(ref) {
  const siteId = siteOfRef(ref);
  if (siteId === AC.id) return { servers: await acServerList(ref), pages: [] };
  if (siteId === SL.id) return slServers(ref);
  const { site, path } = splitRef(ref);
  const episodeUrl = abs(site, path);
  const html = await page(site, path);
  const servers = serversOf(siteId, html);
  kino.log(`resolve ${ref}: servers [${servers.map(safe).join(", ")}]`);
  const fast = await fastServers(site, episodeUrl, servers);
  const pages = fast.length ? [] : pagesToOpen(siteId, episodeUrl, servers).filter((u) => startHost(u) === startHost(site.base));
  return { servers: fast, pages, html };
}

function refererOf(siteId) {
  return (siteId === AC.id ? AC.base : siteId === SL.id ? SL.base : (SITES[siteId] || SITES.sk).base) + "/";
}

// ---------- resolve: the same title on another site ----------
//
// Measured 2026-10-04 on a Redmi: allcalidad's "La Pandilla Newton" (post 70272) answers its player API with
// `embeds: []` (downloads only), so the title could not play at all. When a ref's own site has no server, or none of
// them gave a video, resolve looks the same title up on the other active sites with their own search and plays it
// there, in what is left of its budget. Only a confident match is used: the same normalized title (or original title),
// the same kind (a movie for a movie, a show for an episode, then the same season and episode), the years within one
// when both are known, and exactly one such title on that site. No match is better than a wrong one.

/** What a fallback needs before it is worth starting (a search, a server list, a page read). */
const FALLBACK_MIN_MS = 10000;
/** What a matched title needs left to be played (a server list and a page read). */
const FALLBACK_PLAY_MS = 6000;

/** A ref's shape: movie or episode, its season/episode, and a title read from its slug (the last resort). */
export function refShape(base) {
  const siteId = siteOfRef(base);
  const path = String(base).slice(siteId.length + 1);
  const fromSlug = (slug) => {
    // serieskao's movie slugs end in a random id ("marea-baja-jxVi2n"); a year at the end is the year.
    let s = String(slug || "").replace(/-(?=[A-Za-z0-9]{5,8}$)(?=[a-z0-9]*[A-Z])[A-Za-z0-9]+$/, "");
    let year = "";
    const y = /^(.+)-((?:19|20)\d{2})$/.exec(s);
    if (y) { s = y[1]; year = y[2]; }
    return { slugTitle: s.replace(/-+/g, " ").trim(), slugYear: year };
  };
  let m;
  if (siteId === "sk") {
    if ((m = /^\/(serie|anime)\/([^/]+)\/temporada\/(\d+)\/capitulo\/(\d+)\/?$/.exec(path))) {
      return { siteId, kind: "episode", season: +m[3], episode: +m[4], seriesPath: `/${m[1]}/${m[2]}`, ...fromSlug(m[2]) };
    }
    if ((m = /^\/pelicula\/([^/]+)\/?$/.exec(path))) return { siteId, kind: "movie", ...fromSlug(m[1]) };
  } else if (siteId === SL.id) {
    if ((m = /^\/serie\/([^/]+)\/temporada-(\d+)\/episodio-(\d+)\/?$/.exec(path))) {
      return { siteId, kind: "episode", season: +m[2], episode: +m[3], seriesPath: `/serie/${m[1]}`, ...fromSlug(m[1]) };
    }
    if ((m = /^\/pelicula\/([^/]+)\/?$/.exec(path))) return { siteId, kind: "movie", ...fromSlug(m[1]) };
  } else if (siteId === AC.id) {
    const r = parseAcRef(base);
    if (!r) return null;
    if (r.ep) return { siteId, kind: "episode", season: +r.season, episode: +r.episode, tmdb: r.tmdb !== "0" ? r.tmdb : "", slugTitle: "", slugYear: "" };
    if (r.legacy) {
      if (r.kind === "movie") return { siteId, kind: "movie", slugTitle: "", slugYear: "" };
      return r.season && r.episode ? { siteId, kind: "episode", season: +r.season, episode: +r.episode, tmdb: r.tmdb, slugTitle: "", slugYear: "" } : null;
    }
    if (r.type === "movies") return { siteId, kind: "movie", acType: r.type, slug: r.slug, ...fromSlug(r.slug) };
  }
  return null;
}

const jsonString = (s) => { try { return JSON.parse(`"${s}"`); } catch (_) { return ""; } };

/**
 * The title a site's own page names (its JSON-LD): a show's name on an episode page, a movie's name and its other
 * names on a movie page, and the year when the page states it for the whole title (serieskao's hero line; SoloLatino's
 * datePublished on a movie or series page, never an episode's, which is the episode's own date).
 */
export function pageInfo(html, siteId, kind) {
  const h = String(html || "");
  const names = [];
  let year = "";
  if (kind === "movie") {
    const m = /"@type":"Movie",(?:"@id":"[^"]*",)?"name":"((?:[^"\\]|\\.)*)"(?:,"alternateName":\[((?:"(?:[^"\\]|\\.)*",?)*)\])?/.exec(h);
    if (m) {
      names.push(jsonString(m[1]));
      for (const a of (m[2] || "").match(/"((?:[^"\\]|\\.)*)"/g) || []) names.push(jsonString(a.slice(1, -1)));
    }
  } else {
    const m = /"@type":"TVSeries","name":"((?:[^"\\]|\\.)*)"/.exec(h);
    if (m) names.push(jsonString(m[1]));
  }
  if (siteId === "sk") year = (/detail-hero__type">[^<]*<\/span>\s*<span>((?:19|20)\d{2})<\/span>/.exec(h) || [])[1] || "";
  else if (siteId === SL.id && (kind === "movie" || kind === "series")) year = (/"datePublished":"((?:19|20)\d{2})/.exec(h) || [])[1] || "";
  return { names: names.filter((n) => titleKey(n)).slice(0, 6), year };
}

/**
 * The confident match for [info] (`{ names, year, kind }`) among one site's search results, or null: the same
 * normalized name (title or original title), a movie for a movie and a show for an episode, the years within one when
 * both are known, and exactly one such title (an exact year breaks a tie; anything else left over is no match).
 */
export function pickMatch(info, items) {
  const want = new Set((info.names || []).map(titleKey).filter(Boolean));
  if (!want.size) return null;
  const year = parseInt(info.year, 10) || 0;
  const yearOf = (i) => parseInt(i.year, 10) || 0;
  const kindOk = (i) => (info.kind === "movie" ? i.kind === "movie" : i.kind === "series");
  const seen = new Set();
  let hits = (items || []).filter((i) => i && i.ref && kindOk(i) && [i.title, i.originalTitle].some((t) => want.has(titleKey(t)))
    && (!year || !yearOf(i) || Math.abs(yearOf(i) - year) <= 1) && !seen.has(i.ref) && seen.add(i.ref));
  if (hits.length > 1 && year) {
    const dated = hits.filter((i) => yearOf(i));
    if (dated.length) hits = dated;
    if (hits.length > 1) hits = hits.filter((i) => yearOf(i) === year);
  }
  return hits.length === 1 ? hits[0] : null;
}

/** One site's search for the fallback (not a list read: it is part of a play). */
async function searchOn(siteId, q) {
  if (siteId === AC.id) return acSearch(q, { list: false });
  if (siteId === SL.id) return slSearch(q);
  return cards("sk", await page(SITES.sk, SITES.sk.search(q)));
}

/**
 * The names, year and kind of what [base] points at, cheaply: the page the server list already read, else the site's
 * own title data (allcalidad's /single for a movie, the show name kept from its episode list, SoloLatino's series
 * page), else the ref's slug.
 */
async function titleOf(base, shape, listed) {
  const kind = shape.kind;
  const info = { kind, year: "", names: [], from: "" };
  const take = (names, year, from) => {
    info.names = [...new Set(names.filter((n) => titleKey(n)))].slice(0, 6);
    info.year = year || "";
    info.from = from;
  };
  if (shape.siteId === AC.id) {
    if (kind === "movie" && shape.slug) {
      try {
        const it = acItem(await acGet(`/single?post_name=${encodeURIComponent(shape.slug)}&post_type=${shape.acType}`));
        if (it) take([it.title, it.originalTitle || ""], it.year, "single");
      } catch (e) {
        kino.log(`fallback: no allcalidad title data (${e.code || ""})`);
      }
    } else if (shape.tmdb) {
      const kept = storageGet(showKey(shape.tmdb));
      if (kept && kept.title) take([kept.title, kept.originalTitle || ""], kept.year, "kept");
    }
  } else if (shape.siteId === SL.id && kind === "episode") {
    // The episode page names the show but dates the episode: the series page has both, and its numbering.
    try {
      const html = await slRead(shape.seriesPath, { waitFor: "episodio-" });
      const p = pageInfo(html, SL.id, "series");
      if (p.names.length) take(p.names, p.year, "series_page");
      if (shape.season > 1 && numberingStyle(slEpisodes(html, shape.seriesPath)) === "absolute") info.absolute = true;
    } catch (e) {
      kino.log(`fallback: no SoloLatino series page (${e.code || ""})`);
      // Its numbering is unknown: a later season's number may be absolute, so only season 1 is safe.
      if (shape.season > 1) info.absolute = true;
    }
  } else if (listed && listed.html) {
    const p = pageInfo(listed.html, shape.siteId, kind);
    if (p.names.length) take(p.names, p.year, "page");
  }
  if (!info.names.length && shape.slugTitle) take([shape.slugTitle], shape.slugYear, "slug");
  return info;
}

/** The ref to play on [siteId] for a matched title [m]: the movie itself, or the same season and episode of the show. */
async function refOn(siteId, m, shape) {
  if (shape.kind === "movie") return m.ref;
  const { season, episode } = shape;
  if (siteId === "sk") return `${m.ref}/temporada/${season}/capitulo/${episode}`;
  if (siteId === AC.id) {
    const r = parseAcRef(m.ref);
    if (!r || !r.post || r.legacy) return null;
    const list = await acGet(`/episodes?post_id=${r.post}`);
    const e = (Array.isArray(list) ? list : []).find((x) => x && x.season_number === season && x.episode_number === episode && Number.isInteger(x._id));
    return e ? `ac|ep/${e._id}/${/^\d+$/.test(String(e.show_id || "")) ? e.show_id : 0}/${season}/${episode}` : null;
  }
  if (siteId === SL.id) {
    const path = m.ref.slice(3);
    const list = slEpisodes(await slRead(path, { waitFor: "episodio-" }), path);
    // An absolutely numbered show (Naruto's "temporada-2" starts at 53) cannot be matched by season and episode.
    if (numberingStyle(list) === "absolute") return null;
    const e = list.find((x) => x.season === season && x.number === episode);
    return e ? e.ref : null;
  }
  return null;
}

/** The first confident match on [siteId] for any of [info]'s names (at most two searches). */
async function matchOn(siteId, info) {
  for (const q of info.names.slice(0, 2)) {
    const m = pickMatch(info, await searchOn(siteId, q));
    if (m) return m;
  }
  return null;
}

/**
 * The same title on another active site, played there: `{ stream, to }`, or `{ why }` ("no_title", "no_site",
 * "no_match", "failed", "time"). Sites resting, down or switched off are not asked.
 */
async function fromAnotherSite(base, siteId, listed, run) {
  const shape = refShape(base);
  if (!shape) return { why: "no_title" };
  const sites = activeSites().filter((id) => id !== siteId && !siteResting(id) && !(id === SL.id && slIsDown()));
  if (!sites.length) return { why: "no_site" };
  const info = await within(titleOf(base, shape, listed), Math.min(8000, run.left() - FALLBACK_PLAY_MS), null).catch(() => null);
  if (!info || !info.names.length) return { why: "no_title" };
  if (info.absolute) {
    kino.log(`fallback ${base}: SoloLatino numbers this show absolutely, no safe season/episode on another site`);
    return { why: "no_title" };
  }
  kino.log(`fallback ${base}: looking for ${info.kind} "${info.names.join('" / "').slice(0, 120)}"${info.year ? ` (${info.year})` : ""}${shape.kind === "episode" ? ` ${shape.season}x${shape.episode}` : ""} [${info.from}] on ${sites.join(", ")}`);
  const searchMs = Math.min(LIMITS.searchMs, run.left() - FALLBACK_PLAY_MS);
  const matches = await Promise.all(sites.map((id) => within(matchOn(id, info), searchMs, null)
    .catch((e) => { kino.log(`fallback ${id}: search ${e.code || ""} ${e.message}`); return null; })));
  let matched = 0;
  for (let i = 0; i < sites.length; i++) {
    const id = sites[i];
    const m = matches[i];
    if (!m) { kino.log(`fallback ${id}: no confident match`); continue; }
    matched++;
    if (run.left() < FALLBACK_PLAY_MS) return { why: "time" };
    const ref = await within(refOn(id, m, shape), Math.min(10000, run.left() - FALLBACK_PLAY_MS), null)
      .catch((e) => { kino.log(`fallback ${id}: ${e.code || ""} ${e.message}`); return null; });
    if (!ref) { kino.log(`fallback ${id}: ${m.ref} has no such ${shape.kind === "episode" ? "episode" : "title"}`); continue; }
    kino.log(`fallback: ${base} -> ${ref}`);
    const got = await playOn(ref, run, null);
    if (got.stream) return { stream: got.stream, to: id };
  }
  return { why: matched ? "failed" : "no_match" };
}

// ---------- resolve ----------

/**
 * One ref's servers tried in order, inside [run]'s budget: `{ stream }`, or `{ why, error, servers, listed }` when
 * none gave a video ("no_servers", "no_browser", "list_timeout", "list_failed", a capture's code or "all_failed").
 */
async function playOn(base, run, only) {
  const siteId = siteOfRef(base);
  const { left, t0 } = run;
  const lang = preferredLang();
  const remembered = (storageGet(serverKey(siteId)) || {}).server || "";
  const chosen = String(configValue("server", "auto"));
  const failed = failedServers(siteId);

  // 1. The servers, under their own cap: a slow site page or embed69 must leave the capture its time.
  let listed;
  try {
    listed = await within(listServers(base), Math.min(LIMITS.serversMs, Math.max(1000, left() - 3000)), null);
  } catch (e) {
    kino.log(`resolve ${base}: listing failed: ${e.code || ""} ${e.message}`);
    return { why: "list_failed", error: e, servers: 0 };
  }
  if (!listed) return { why: "list_timeout", servers: 0 };
  let servers = lastIfFailed(rankServers(listed.servers, lang, remembered, chosen), failed);
  if (only) {
    servers = servers.filter((f) => langOf(f.lang) === only.lang && ((f.server || "").toLowerCase() === only.server || serverName(f) === only.server));
    if (!servers.length) throw kino.error("not_found", `sin el servidor ${only.lang}/${only.server}`, { userMessage: "Ese servidor ya no está disponible para este video." });
  }
  const pages = only ? [] : listed.pages;
  kino.log(`resolve ${siteId}: ${servers.length} server(s) in ${Date.now() - t0} ms (idioma ${lang}, último ${remembered || "-"}, fallaron hace poco ${[...failed].join("/") || "-"}${browserMissing() ? ", sin navegador" : ""}): [${servers.map((t) => `${t.lang}/${serverName(t)}${canExtract(t) ? "*" : ""}`).join(", ")}]${pages.length ? `, ${pages.length} page(s) as last resort` : ""}`);

  const failedHere = new Set();
  let lastError = null;
  let captures = 0;
  let skippedForBrowser = 0;
  const later = [];
  const canCapture = () => !run.captureOff && !browserMissing();

  const finish = async (got, target) => {
    if (got.how !== "page") got.media = await filmMedia(got.media);
    if (!got.media.length) {
      failedHere.add(target.url);
      if (target.server) markServer(siteId, target, true);
      report("maraton:capture", "only_ads", `server=${serverName(target)}`);
      return null;
    }
    const others = only ? [] : servers.filter((f) => f !== target && !failedHere.has(f.url));
    const stream = streamOf(got, target, others, base, failed, { referer: target.server ? undefined : refererOf(siteId), needBrowser: browserMissing() });
    if (target.server) {
      storageSet(serverKey(siteId), { server: serverName(target) });
      markServer(siteId, target, false);
    }
    const keepMs = keepStreamMs(stream);
    const expiresAtMs = stream.expiresInSeconds ? Date.now() + stream.expiresInSeconds * 1000 : 0;
    // Kept under the ref Kino asked for, even when another site played it.
    if (run.keepLinks) storageSet(streamKey(run.ref), { stream, until: Date.now() + keepMs, expiresAtMs, site: siteId, server: target.server ? { server: target.server, url: target.url, lang: target.lang } : null }, keepMs);
    kino.log(`stream (${got.how || "capture"}) ${safe(stream.url)} headers=${Object.keys(stream.headers || {}).join(",")} alternatives=${(stream.alternatives || []).length} expires=${stream.expiresInSeconds || "?"} s, resolve ${Date.now() - t0} ms`);
    return stream;
  };

  /** One hidden page; a page that gave up well before its window gets one more try right away. */
  const capture = async (target) => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const win = Math.min(captureWindow(target), left(), 25000);
      if (win < LIMITS.minCaptureMs) {
        kino.log(`capture ${serverName(target)}: ${left()} ms left, not opened`);
        return null;
      }
      if (attempt === 0) captures++;
      const started = Date.now();
      kino.log(`capture ${serverName(target)} ${safe(target.url)} (window ${win} ms${attempt ? ", second try" : ""})`);
      try {
        const got = await kino.browser.capture(target.url, { timeoutMs: win, headers: { Referer: target.referer || refererOf(siteId) } });
        kino.log(`capture ok in ${Date.now() - started} ms: ${got.media.length} media, ${(got.subtitles || []).length} subtitles`);
        got.how = "capture";
        got.subtitles = got.subtitles || [];
        return await finish(got, target);
      } catch (e) {
        lastError = e;
        const took = Date.now() - started;
        kino.log(`capture failed after ${took} ms on ${serverName(target)}: ${e.code || ""} ${e.message}`);
        if (e.code === "browser_unavailable") {
          noteNoBrowser();
          return null;
        }
        // Another page is open, or this resolve may not open one (Kino's own background check): no capture this call.
        if (e.code === "busy" || e.code === "not_allowed") {
          run.captureOff = true;
          run.busy = run.busy || e.code === "busy";
          return null;
        }
        report("maraton:capture", e.code || "error", `server=${serverName(target)}`, `ms=${took}`, `win=${win}`);
        // Gave up in under half its window (a page that failed to load, a redirect hop that broke): one more try.
        if (e.code === "timeout" && attempt === 0 && took < win / 2 && left() - LIMITS.minCaptureMs > 0) continue;
        failedHere.add(target.url);
        if (target.server) markServer(siteId, target, true);
        return null;
      }
    }
    return null;
  };

  // 2. In order: a server whose page carries its playlist is read directly (about a second); one that needs the hidden
  //    browser gets a window sized for it. A failure moves on at once; a dead page never eats the whole budget.
  for (const f of servers) {
    if (left() < 3000) break;
    if (canExtract(f)) {
      const got = await extractServer(f, Math.min(LIMITS.extractMs, left() - 2000));
      if (got && got.gone) { failedHere.add(f.url); continue; }
      if (got && got.down) {
        failedHere.add(f.url);
        markServer(siteId, f, true);
        report("maraton:extract", "host_down", `server=${serverName(f)}`, `code=${got.down}`);
        continue;
      }
      const stream = got ? await finish(got, f) : null;
      if (stream) return { stream };
      // Its page did not give the playlist: the hidden browser may still find it (videoapp only frames vimeos).
      if (f.url.includes("videoapp.zip")) continue;
    }
    if (!canCapture()) { skippedForBrowser++; continue; }
    if (captures >= MAX_CAPTURES) { later.push(f); continue; }
    const stream = await capture(f);
    if (stream) return { stream };
  }
  for (const f of later) {
    if (!canCapture() || captures > MAX_CAPTURES || left() < LIMITS.minCaptureMs) break;
    if (failedHere.has(f.url)) continue;
    const stream = await capture(f);
    if (stream) return { stream };
  }
  // 3. Nothing listed played: the site's own page in the hidden browser, digging through its frames.
  for (const url of pages) {
    if (!canCapture() || left() < LIMITS.minCaptureMs) break;
    const stream = await capture({ url, referer: refererOf(siteId) });
    if (stream) return { stream };
  }
  const why = !servers.length && !pages.length ? "no_servers" : browserMissing() && (skippedForBrowser || pages.length) ? "no_browser" : lastError ? (lastError.code || "error") : "all_failed";
  return { why, error: lastError, servers: servers.length, listed };
}

export async function resolve(ref, options) {
  await null;
  const t0 = Date.now();
  const base = parseServerRef(ref).base;
  const siteId = siteOfRef(base);
  if (!ALL_SITES.includes(siteId)) throw kino.error("not_found", "referencia inválida");
  const left = () => LIMITS.resolveMs - (Date.now() - t0);
  // A retry (the CDN said 401/403/409…) or a normal call: a retry never gets the cached copy back, and a server whose
  // stream was refused goes to the back for a while, so the new search starts elsewhere.
  const keepLinks = configValue("keepLinks", true) !== false;
  if (options && options.retry) {
    const entry = storageGet(streamKey(ref));
    storageRemove(streamKey(ref));
    const status = Number(options.retry.status) || 0;
    if (entry && entry.server && [401, 403, 404, 410].includes(status)) markServer(entry.site || siteId, entry.server, true);
    kino.log(`resolve ${ref}: retry ${options.retry.reason || ""} ${status || ""}, cache dropped${entry && entry.server ? `, ${serverName(entry.server)} to the back` : ""}`);
    report("maraton:retry", String(options.retry.reason || "retry").slice(0, 20), `status=${status}`, `server=${entry && entry.server ? serverName(entry.server) : "none"}`);
  } else if (keepLinks) {
    const cached = fromCache(storageGet(streamKey(ref)));
    if (cached) {
      kino.log(`resolve ${ref}: cached stream ${safe(cached.url)} (${cached.expiresInSeconds || "?"} s left)`);
      return cached;
    }
  }
  const { only } = parseServerRef(ref);
  const run = { t0, left, ref, keepLinks, captureOff: false, busy: false };
  const own = await playOn(base, run, only);
  if (own.stream) return own.stream;

  // The ref's own site gave no video: the same title on another site, if there is time for it. A copy picked from the
  // player's Servidor list (`only`) is that copy or nothing.
  let fb = { why: only ? "only" : "time" };
  if (!only && !run.busy && left() >= FALLBACK_MIN_MS) {
    fb = await fromAnotherSite(base, siteId, own.listed, run).catch((e) => {
      kino.log(`fallback ${base}: ${e.code || ""} ${e.message}`);
      return { why: e.code === "not_found" ? "failed" : "error" };
    });
    if (fb.stream) {
      kino.log(`resolve ${ref}: ${SITE_NAME[siteId]} gave no video (${own.why}); played from ${SITE_NAME[fb.to]} in ${Date.now() - t0} ms`);
      report("maraton:fallback", "ok", `from=${siteId}`, `to=${fb.to}`, `why=${own.why}`);
      return fb.stream;
    }
    kino.log(`resolve ${ref}: no other site has it (${fb.why})`);
  }

  const why = own.why;
  report("maraton:resolve", why, `site=${siteId}`, `servers=${own.servers}`, `fb=${fb.why}`, `ms=${Date.now() - t0}`);
  if (why === "list_failed") throw own.error;
  if (why === "list_timeout") {
    throw kino.error("unavailable", "los servidores no respondieron a tiempo", { userMessage: `${SITE_NAME[siteId]} tardó demasiado en responder. Vuelve a intentar en un rato.` });
  }
  if (why === "no_browser") {
    throw kino.error("unavailable", "sin navegador web", { userMessage: "Este aparato no tiene navegador web, y esta fuente lo necesita para reproducir. Prueba otra fuente." });
  }
  if (run.busy || (own.error && own.error.code === "busy")) {
    throw kino.error("unavailable", "navegador ocupado", { userMessage: "Hay otro video buscándose en este momento. Vuelve a intentar en unos segundos." });
  }
  if (why === "no_servers" && (fb.why === "no_match" || fb.why === "failed")) {
    throw kino.error("not_found", `no_servers, fallback ${fb.why}`, {
      userMessage: `${SITE_NAME[siteId]} no tiene video para este título y no lo encontramos en los otros sitios. Prueba otra fuente.`,
    });
  }
  const lastError = own.error;
  throw kino.error("not_found", lastError ? `${lastError.code || ""} ${lastError.message}` : why, { userMessage: "No encontramos el video. Prueba otra fuente." });
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

/** The "Estado" line: active sites, the language, and the server that last produced a video on each site. */
export async function settingsStatus() {
  const sites = activeSites();
  const last = sites.map((id) => (storageGet(serverKey(id)) || {}).server).filter(Boolean)
    .map((name) => SERVER_LABEL[Object.keys(SERVER_MATCH).find((k) => SERVER_MATCH[k].test(name)) || ""] || name);
  const resting = sites.filter((id) => siteResting(id)).map((id) => SITE_NAME[id]);
  const parts = [
    `${sites.length === 1 ? "1 sitio activo" : `${sites.length} sitios activos`} (${sites.map((id) => SITE_NAME[id]).join(", ")})`,
    ({ lat: "Latino", esp: "Castellano", sub: "Subtitulado" })[preferredLang()],
    last.length ? `último servidor que funcionó: ${[...new Set(last)].join(", ")}` : "todavía sin reproducir nada",
  ];
  if (resting.length) parts.push(`en pausa: ${resting.join(", ")}`);
  return { state: parts.join(" · ").slice(0, 200) };
}

/** How one site answers right now, as a short Spanish phrase (for "Revisar sitios"). Asks even a resting site. */
async function checkSite(id) {
  const t0 = Date.now();
  try {
    if (id === SL.id) await slRead(SL_CATALOG.serie + "1", { allowPage: false });
    else if (id === AC.id) await acGet("/listing?page=1&post_type=movies&posts_per_page=1");
    else await page(SITES.sk, "/");
    return `${SITE_NAME[id]}: responde (${Date.now() - t0} ms)`;
  } catch (e) {
    return `${SITE_NAME[id]}: ${/verificaci|dejando entrar/.test(e.userMessage || "") ? "pide verificación" : "no responde"}`;
  }
}

/** Every key this plugin keeps for streams, servers and site health (what "Borrar enlaces guardados" removes). */
function linkKeys() {
  try {
    return (kino.storage.keys() || []).filter((k) => /^(stream|server|failed|health|sitedown|nobrowser|slpage):?/.test(k));
  } catch (_) {
    return [];
  }
}

export async function action(key) {
  if (key === "check") {
    const lines = await Promise.all(ALL_SITES.map((id) => within(checkSite(id), 9000, `${SITE_NAME[id]}: no responde`)));
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
    return { useSololatino: "Deja al menos un sitio activo" };
  }
  return null;
}
