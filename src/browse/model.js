// What the browse screen shows: the featured slides, the rails of a tab and the cards. Pure functions; index.js keeps the
// results and view.js draws them.

export const MAX_SLIDES = 6;
export const MAX_RAILS = 8;
export const MAX_RAIL_ITEMS = 20;
const MAX_SLIDE_TEXT = 160;
const HTTPS = /^https:\/\//;

/** The card Kino draws: the fields a rail needs and nothing else (the tree and the stored copy stay small). */
export function cardOf(item) {
  const out = { id: item.id, ref: item.ref, title: item.title, kind: item.kind };
  if (item.poster && HTTPS.test(item.poster)) out.poster = item.poster;
  if (item.backdrop && HTTPS.test(item.backdrop)) out.backdrop = item.backdrop;
  if (item.year !== undefined) out.year = item.year;
  if (item.lang) out.lang = item.lang;
  return out;
}

/** Up to MAX_SLIDES featured titles: the first items, in row order, that have an image and a synopsis, one per title. */
export function slidesOf(rows) {
  const out = [];
  const seen = new Set();
  for (const row of rows) {
    for (const item of row.items) {
      if (out.length >= MAX_SLIDES) return out;
      const image = item.backdrop && HTTPS.test(item.backdrop) ? item.backdrop : item.poster;
      if (seen.has(item.id) || !image || !HTTPS.test(image)) continue;
      const text = typeof item.overview === "string" ? item.overview.trim() : "";
      if (text === "") continue;
      seen.add(item.id);
      out.push({ id: item.id, ref: item.ref, kind: item.kind, title: item.title, image, text: text.length <= MAX_SLIDE_TEXT ? text : `${text.slice(0, MAX_SLIDE_TEXT - 1).trimEnd()}…` });
    }
  }
  return out;
}

/** The tab's rails: its rows trimmed to what a screen draws. */
export function railsOf(rows) {
  return rows.filter((r) => !r.hidden && r.items && r.items.length > 0).slice(0, MAX_RAILS).map((r) => ({
    id: r.id, title: r.title, ...(r.titleEn ? { titleEn: r.titleEn } : {}), ...(r.ref ? { ref: r.ref } : {}), items: r.items.slice(0, MAX_RAIL_ITEMS).map(cardOf),
  }));
}

/** One tab as the screen draws it, from a page (`{ rows }`); null when it has no row. */
export function tabOf(page) {
  const rows = page && Array.isArray(page.rows) ? page.rows : [];
  const rails = railsOf(rows);
  if (rails.length === 0) return null;
  return { slides: slidesOf(rows), rails };
}

/** The titles played, newest first, found in [tabs] (the loaded tab data) by ref; a title not on screen is not shown. */
export function recentOf(keys, tabs) {
  if (keys.length === 0) return [];
  const byRef = new Map();
  for (const data of tabs) for (const rail of data.rails) for (const card of rail.items) if (!byRef.has(card.ref)) byRef.set(card.ref, card);
  const out = [];
  const used = new Set();
  for (const key of keys) {
    const card = byRef.get(key);
    if (card && !used.has(card.id)) { used.add(card.id); out.push(card); }
  }
  return out;
}
