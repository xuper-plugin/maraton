// TMDB ids and title logos for the browse screen's cards, through Kino's own `kino.meta` (no key in the plugin). A card with a
// TMDB id lets Kino complete its page (description, logo, cast) from TMDB; a slide with a logo draws it where its title is.
// One lookup per title, by its name (and year when the card has one), kept in kino.storage (`meta2`, at most MAX entries, the
// oldest dropped) so a title is asked once. Nothing here ever throws: a title that cannot be matched just stays as it was.
// `titleOf` / `typeOf` shape what is asked (an anime site's titles carry words TMDB does not know); `tmdbPictures` puts TMDB's
// poster on the cards (and index.js its backdrop on the slides) for a site whose own pictures do not load.
// A source with posters only gets its slides from what is learned here (a backdrop and a synopsis per title).
const KEY = "meta3"; // v3 also keeps the poster, the backdrop and the synopsis
const MAX = 160; // ~450 bytes each: about 70 KB of the plugin's shared storage
const CONCURRENCY = 3; // lookups at a time: the first slides do not wait for the titles before them one by one
const OVERVIEW_MAX = 160;
const HTTPS = /^https:\/\//;

export function makeMetaCache({ kino, titleOf = (c) => c.title, typeOf = (c) => (c.kind === "series" ? "series" : "movie"), tmdbPictures = false, clock = { now: () => Date.now() } }) {
  const usable = () => { try { return typeof kino.meta === "function" && kino.meta.byTitle === true; } catch (_) { return false; } };
  let book = null; // id -> { t: tmdb id | 0, l: logo, p: poster, b: backdrop, o: synopsis }, 0 / "" = asked and nothing found

  function read() {
    if (book) return book;
    try {
      const o = JSON.parse(kino.storage.get(KEY) || "null");
      book = o && typeof o === "object" && !Array.isArray(o) ? o : {};
    } catch (_) { book = {}; }
    return book;
  }
  function write() {
    try {
      const ids = Object.keys(book);
      if (ids.length > MAX) for (const id of ids.slice(0, ids.length - MAX)) delete book[id];
      kino.storage.set(KEY, JSON.stringify(book));
    } catch (_) { /* full storage: asked again next time */ }
  }

  /** What is known of card [id]: `{ tmdb?, logo?, poster?, backdrop?, overview? }`. */
  function known(id) {
    const e = read()[id];
    if (!e) return {};
    return {
      ...(e.t > 0 ? { tmdb: e.t } : {}), ...(e.l && HTTPS.test(e.l) ? { logo: e.l } : {}),
      ...(e.p && HTTPS.test(e.p) ? { poster: e.p } : {}), ...(e.b && HTTPS.test(e.b) ? { backdrop: e.b } : {}),
      ...(typeof e.o === "string" && e.o ? { overview: e.o } : {}),
    };
  }

  /** Whether card [id] was asked already (found or not). */
  const asked = (id) => Object.hasOwn(read(), id);

  /** The cards with their TMDB id (and TMDB's poster with `tmdbPictures`); [cards] untouched when nothing is known. */
  function dress(cards) {
    return cards.map((c) => {
      const k = known(c.id);
      const poster = tmdbPictures && k.poster ? k.poster : null;
      if (!k.tmdb && !poster) return c;
      return { ...c, ...(k.tmdb && !(c.ids && c.ids.tmdb) ? { ids: { ...(c.ids || {}), tmdb: k.tmdb } } : {}), ...(poster ? { poster } : {}) };
    });
  }

  /**
   * Asks Kino about the titles of [cards] not asked yet, CONCURRENCY at a time, while [budgetMs] is not spent (a call already
   * started runs to its end: Kino answers most from its own cache in a few ms). Returns how many were asked.
   * A failure (rate limit, no match, a timeout) is remembered as "nothing found" only when Kino answered null; a thrown error is
   * tried again on a later call.
   */
  async function fill(cards, budgetMs) {
    if (!usable()) return 0;
    const b = read();
    const end = clock.now() + budgetMs;
    let count = 0;
    let stop = false;
    const seen = new Set();
    const todo = cards.filter((c) => {
      if (!c || typeof c.id !== "string" || seen.has(c.id) || Object.hasOwn(b, c.id) || (c.ids && c.ids.tmdb && c.noLogo)) return false;
      seen.add(c.id);
      return true;
    });
    let next = 0;
    const str = (v, max) => (typeof v === "string" ? v.slice(0, max) : "");
    const worker = async () => {
      while (!stop && next < todo.length && clock.now() < end) {
        const c = todo[next++];
        const year = c.year !== undefined ? { year: c.year } : {};
        try {
          const a = await kino.meta({ type: typeOf(c), title: titleOf(c), ...year });
          b[c.id] = {
            t: a && a.ids && Number.isInteger(a.ids.tmdb) ? a.ids.tmdb : 0, l: str(a && a.logo, 2048),
            p: str(a && a.poster, 2048), b: str(a && a.backdrop, 2048), o: str(a && a.overview, OVERVIEW_MAX),
          };
          count++;
        } catch (e) {
          if (e && e.code === "rate_limited") stop = true; // asked again later
        }
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    if (count > 0) write();
    return count;
  }

  return { known, asked, dress, fill, usable, tmdbPictures };
}
