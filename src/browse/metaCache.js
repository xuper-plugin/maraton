// TMDB ids and title logos for the browse screen's cards, through Kino's own `kino.meta` (no key in the plugin). A card with a
// TMDB id lets Kino complete its page (description, logo, cast) from TMDB; a slide with a logo draws it where its title is.
// One lookup per title, by its name (and year when the card has one), kept in kino.storage (`meta1`, at most MAX entries, the
// oldest dropped) so a title is asked once. Nothing here ever throws: a title that cannot be matched just stays as it was.
const KEY = "meta1";
const MAX = 120;
const CALL_MS = 8_000;
const HTTPS = /^https:\/\//;

export function makeMetaCache({ kino, titleOf = (c) => c.title, clock = { now: () => Date.now() } }) {
  const usable = () => { try { return typeof kino.meta === "function" && kino.meta.byTitle === true; } catch (_) { return false; } };
  let book = null; // id -> { t: tmdb id | 0, l: logo | "" }, 0 / "" = asked and nothing found

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

  /** What is known of card [id]: `{ tmdb?, logo? }`. */
  function known(id) {
    const e = read()[id];
    if (!e) return {};
    return { ...(e.t > 0 ? { tmdb: e.t } : {}), ...(e.l && HTTPS.test(e.l) ? { logo: e.l } : {}) };
  }

  /** The cards with their TMDB id; [cards] untouched when nothing is known. */
  function dress(cards) {
    return cards.map((c) => { const k = known(c.id); return k.tmdb && !(c.ids && c.ids.tmdb) ? { ...c, ids: { ...(c.ids || {}), tmdb: k.tmdb } } : c; });
  }

  /**
   * Asks Kino about the titles of [cards] not asked yet, one after another, until [budgetMs] is spent. Returns how many were asked.
   * A failure (rate limit, no match, a timeout) is remembered as "nothing found" only when Kino answered null; a thrown error is
   * tried again on a later call.
   */
  async function fill(cards, budgetMs) {
    if (!usable()) return 0;
    const b = read();
    const end = clock.now() + budgetMs;
    let asked = 0;
    for (const c of cards) {
      if (clock.now() + CALL_MS > end) break;
      if (!c || typeof c.id !== "string" || Object.hasOwn(b, c.id) || (c.ids && c.ids.tmdb && c.noLogo)) continue;
      const year = c.year !== undefined ? { year: c.year } : {};
      try {
        const a = await kino.meta({ type: c.kind === "series" ? "series" : "movie", title: titleOf(c), ...year });
        b[c.id] = { t: a && a.ids && Number.isInteger(a.ids.tmdb) ? a.ids.tmdb : 0, l: a && typeof a.logo === "string" ? a.logo : "" };
      } catch (e) {
        if (e && e.code === "rate_limited") break; // asked again later
        continue;
      }
      asked++;
    }
    if (asked > 0) write();
    return asked;
  }

  return { known, dress, fill, usable };
}
