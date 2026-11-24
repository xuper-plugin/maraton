// Server order from the resolver (std 1.9.3): kino-resolver's `rank` call scores each hoster by how well it plays (its own
// table, from the playback audit), so every plugin orders its servers alike and one resolver update re-orders them all. A
// resolver without the call (older than 0.0.35) or missing answers null: the plugin keeps its own order.
// A score below 0 means "never offer it": that server leaves the list (kino-resolver 0.0.38+). Waaw/netu leaves it always,
// even with an older resolver (owner, 2026-11-23: "quitemos siempre netu de todo lado").
// The plugin's manifest must list "rank" in its resolver consumes entry's calls.

/** Hosters no plugin offers, whatever the resolver says: Waaw/netu (a click-on-image check no one got past). */
export const NEVER_OFFER = /waaw|netu|hqq\./i;

/** Whether the server at [url] (an address or a bare name) may be offered, given its resolver [score] (or none). */
export function offered(url, score) {
  if (NEVER_OFFER.test(String(url || ""))) return false;
  return !(typeof score === "number" && score < 0);
}

/** The resolver's score for each of [urls] (same order), or null when it cannot say. */
export async function scoresFromResolver(kino, urls) {
  if (!Array.isArray(urls) || urls.length === 0) return null;
  try {
    const r = await kino.plugins.call("resolver", "rank", { urls: urls.slice(0, 64).map(String) });
    const s = r && Array.isArray(r.scores) ? r.scores : null;
    return s && s.length === Math.min(urls.length, 64) ? s : null;
  } catch (_) { return null; }
}

/**
 * [list] without the servers never offered ([offered]), ordered by [groupOf] first (lower first: the person's language,
 * say), then by the resolver's score (higher first), then as it came. Without scores: by group, then as it came. [urlOf]
 * gives an item's embed address (or its server name).
 */
export async function rankServers(kino, list, urlOf, groupOf = () => 0) {
  const scores = await scoresFromResolver(kino, list.map(urlOf));
  return list
    .map((x, i) => ({ x, i, g: groupOf(x), s: scores && i < scores.length ? scores[i] : 0 }))
    .filter((o) => offered(urlOf(o.x), scores && o.i < scores.length ? scores[o.i] : null))
    .sort((a, b) => a.g - b.g || b.s - a.s || a.i - b.i)
    .map((o) => o.x);
}
