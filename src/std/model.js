// What the browse screen shows, from the section pages the catalog already builds (catalog.js sectionPage): the featured
// slides, the rails of a tab and the cards. Pure functions; index.js keeps the results and view.js draws them.

export const MAX_SLIDES = 5;
export const MAX_RAILS = 8;
export const MAX_RAIL_ITEMS = 20;
const MAX_SLIDE_TEXT = 160;
const HTTPS = /^https:\/\//;

/** The card Kino draws: the fields a rail needs and nothing else (the tree and the stored copy stay small). */
export function cardOf(item) {
  const out = { id: item.id, ref: item.ref, title: item.title, kind: item.kind };
  if (item.poster && HTTPS.test(item.poster)) out.poster = item.poster;
  if (item.backdrop && HTTPS.test(item.backdrop)) out.backdrop = item.backdrop;
  if (item.badges) out.badges = item.badges;
  if (item.rating !== undefined) out.rating = item.rating;
  if (item.year !== undefined) out.year = item.year;
  if (item.ids && item.ids.tmdb) out.ids = { tmdb: item.ids.tmdb };
  if (item.lang) out.lang = item.lang;
  if (item.adult === true) out.adult = true; // Kino shows it only while the 18+ code is unlocked
  return out;
}

/**
 * Up to MAX_SLIDES featured titles: the first items, in row order, that have a backdrop, one per title (the synopsis is shown
 * when the item has one, and is not required). The synopsis is kept on the slide only (a card carries none).
 */
export const slidesOf = (rows) => pickSlides(rows, (item) => item.backdrop);

/** The last resort of a source with no backdrops and no TMDB match: slides from the posters, so every plugin has a hero. */
export const posterSlidesOf = (rows) => pickSlides(rows, (item) => item.poster);

/** Slide text: the synopsis cut to MAX_SLIDE_TEXT, else the year and rating. */
export function slideText(overview, item = {}) {
  const text = typeof overview === "string" ? overview.trim() : "";
  if (text === "") return [item.year, item.rating ? "★ " + item.rating : null].filter(Boolean).join(" · ");
  return text.length <= MAX_SLIDE_TEXT ? text : `${text.slice(0, MAX_SLIDE_TEXT - 1).trimEnd()}…`;
}

function pickSlides(rows, pictureOf) {
  const out = [];
  const seen = new Set();
  for (const row of rows) {
    for (const item of row.items || []) {
      if (out.length >= MAX_SLIDES) return out;
      const image = pictureOf(item);
      if (item.adult === true || seen.has(item.id) || !image || !HTTPS.test(image)) continue;
      seen.add(item.id);
      out.push({ id: item.id, ref: item.ref, kind: item.kind, title: item.title, image, text: slideText(item.overview, item) });
    }
  }
  return out;
}

/** One card shape per rail: Kino draws a card with a backdrop wide, so a rail where only some have one loses them all. */
const uniform = (items) => (items.every((i) => i.backdrop) ? items : items.map(({ backdrop, ...rest }) => rest));

/** The tab's rails: its rows trimmed to what a screen draws. */
export function railsOf(rows) {
  // A row marked `hidden` (a site carousel) feeds the slides only.
  return rows.filter((r) => !r.hidden && r.items && r.items.length > 0).slice(0, MAX_RAILS).map((r) => ({
    id: r.id, title: r.title, ...(r.titleEn ? { titleEn: r.titleEn } : {}), ...(r.ref ? { ref: r.ref } : {}), items: uniform(r.items.slice(0, MAX_RAIL_ITEMS).map(cardOf)),
  }));
}

/** One tab as the screen draws it, from a section page (`{ rows }`); null when it has no row. */
export function tabOf(page) {
  const rows = page && Array.isArray(page.rows) ? page.rows : [];
  const rails = railsOf(rows);
  if (rails.length === 0) return null;
  // Slides are picked from the rows before uniform() drops a rail's backdrops.
  return { slides: slidesOf(rows), posterSlides: posterSlidesOf(rows), rails };
}

/** The key a played ref is remembered under: a TMDB title (a movie, a series or one of its episodes) by its id, else the ref. */
export function playedKey(ref) {
  const m = /^(?:m|s|e):(\d{1,10})(?::|$)/.exec(String(ref || ""));
  return m ? `t:${m[1]}` : String(ref || "");
}

/** The titles played, newest first, found in [tabs] (the loaded tab data) by ref or TMDB id; a title not on screen is not shown. */
export function recentOf(keys, tabs) {
  if (keys.length === 0) return [];
  const byKey = new Map();
  for (const data of tabs) {
    for (const rail of data.rails) {
      for (const card of rail.items) {
        const ks = [card.ref];
        if (card.ids && card.ids.tmdb) ks.push(`t:${card.ids.tmdb}`);
        for (const k of ks) if (!byKey.has(k)) byKey.set(k, card);
      }
    }
  }
  const out = [];
  const used = new Set();
  for (const key of keys) {
    const card = byKey.get(key);
    if (card && !used.has(card.id)) { used.add(card.id); out.push(card); }
  }
  return out;
}
