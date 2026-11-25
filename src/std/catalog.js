// The catalog door every std plugin offers (Kino's plugin protocol): Da-Video and any other plugin of the same author finds
// titles through it (kino.plugins.callAll over a consumes entry by author, Kino apiVersion 31), and Kino opens and plays what it
// finds in this plugin, with this plugin's own resolve. A plugin adds CATALOG_PROVIDES to its manifest's "provides" and exports
//   export const proto_catalog_search = catalogDoor(search);

/** At most this many titles per answer (the protocol's 64 KB answer limit stays far away). */
export const CATALOG_MAX = 40;

/** At most this many episodes per answer. */
export const CATALOG_EPISODES_MAX = 500;

/** The manifest's "provides" block of the door (copy it into kino-plugin.json). */
export const CATALOG_PROVIDES = {
  catalog: {
    summary: "Titles this plugin finds, for the author's other plugins",
    calls: {
      search: { in: { q: "string", type: "string?", tmdb: "number?" }, out: "Item[]" },
      episodes: { in: { ref: "string" }, out: "Episode[]" },
    },
    types: {
      Item: {
        id: "string", ref: "string", title: "string", kind: "string",
        poster: "string?", backdrop: "string?", year: "string?", overview: "string?", tmdb: "number?",
      },
      Episode: { season: "number", number: "number", ref: "string", title: "string?" },
    },
  },
};

const OVERVIEW_MAX = 300;
const HTTPS = /^https:\/\//;

/** A plugin's own search results as the door's `Item`s: only what a card needs, the empty fields left out, at most CATALOG_MAX. */
export function catalogItems(found) {
  const out = [];
  const list = Array.isArray(found) ? found : found && Array.isArray(found.items) ? found.items : [];
  for (const it of list) {
    if (out.length >= CATALOG_MAX) break;
    if (!it || typeof it.id !== "string" || !it.id || typeof it.ref !== "string" || !it.ref || typeof it.title !== "string" || !it.title) continue;
    const item = { id: it.id, ref: it.ref, title: it.title, kind: typeof it.kind === "string" && it.kind ? it.kind : "movie" };
    if (typeof it.poster === "string" && HTTPS.test(it.poster)) item.poster = it.poster;
    if (typeof it.backdrop === "string" && HTTPS.test(it.backdrop)) item.backdrop = it.backdrop;
    if (it.year !== undefined && it.year !== null && String(it.year)) item.year = String(it.year);
    if (typeof it.overview === "string" && it.overview.trim()) item.overview = it.overview.trim().slice(0, OVERVIEW_MAX);
    const tmdb = it.ids && Number.isInteger(it.ids.tmdb) ? it.ids.tmdb : Number.isInteger(it.tmdb) ? it.tmdb : 0;
    if (tmdb > 0) item.tmdb = tmdb;
    out.push(item);
  }
  return out;
}

/** The query Kino itself sends a search, from the door's argument: only the words and the kind are the caller's. */
export function catalogQuery(arg) {
  const q = String((arg && arg.q) || "").trim().slice(0, 200);
  const type = arg && (arg.type === "movie" || arg.type === "series") ? arg.type : "any";
  const tmdbId = arg && Number.isInteger(arg.tmdb) && arg.tmdb > 0 ? arg.tmdb : 0;
  return { q, type, season: 0, episode: 0, tmdbId, year: 0, originalTitle: "", altTitles: [], cursor: null };
}

/** The door's `search` call over a plugin's own [search]: empty words answer nothing, without asking the site. */
export function catalogDoor(search) {
  return async (arg) => {
    const query = catalogQuery(arg);
    if (!query.q) return [];
    return catalogItems(await search(query));
  };
}

/** An integer, or an integer-like string ("3", " 12 ") as an integer; anything else null. */
function wholeNumber(v) {
  if (Number.isInteger(v)) return v;
  if (typeof v === "string" && /^\s*\d+\s*$/.test(v)) return parseInt(v, 10);
  return null;
}

/**
 * A plugin's own `episodes` answer (an array or `{ episodes }`) as the door's `Episode`s: season (missing = 1), number, ref,
 * title, in the plugin's order. Past CATALOG_EPISODES_MAX valid rows the LAST ones are kept: plugins list oldest first, so a
 * long anime still shows its newest episodes.
 */
export function catalogEpisodes(list) {
  const rows = Array.isArray(list) ? list : list && Array.isArray(list.episodes) ? list.episodes : [];
  const out = [];
  for (const e of rows) {
    if (!e) continue;
    const number = wholeNumber(e.number);
    if (number === null || number < 1 || typeof e.ref !== "string" || !e.ref) continue;
    const season = e.season === undefined || e.season === null ? 1 : wholeNumber(e.season);
    if (season === null || season < 0) continue;
    const row = { season, number, ref: e.ref };
    if (typeof e.title === "string" && e.title) row.title = e.title;
    out.push(row);
  }
  return out.length > CATALOG_EPISODES_MAX ? out.slice(-CATALOG_EPISODES_MAX) : out;
}

/** The door's `episodes` call over a plugin's own [episodes]: an empty ref answers nothing, without asking the site. */
export function catalogEpisodesDoor(episodes) {
  return async (arg) => {
    const ref = arg && typeof arg.ref === "string" ? arg.ref.trim() : "";
    if (!ref) return [];
    return catalogEpisodes(await episodes(ref));
  };
}
