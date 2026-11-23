// The browse screen's trees: a pure view of what index.js holds. A tab that is not in yet draws skeletons shaped like what
// will replace them, so nothing jumps when the rows arrive. Every text is in both languages.
import { both } from "../i18n.js";

const POLL_MS = 1_500;
const SEARCH_CAP = 60;

/** `key` in both languages as a node's twin texts: `{ [field]: Spanish, [field + "En"]: English }`. */
export const twin = (key, field = "text", vars) => {
  const w = both(key, vars);
  return { [field]: w.es, [field + "En"]: w.en };
};

/** A tab's label, from the config's own pair `{ es, en }`. */
const tabLabel = (tab) => ({ label: tab.es, labelEn: tab.en });

const railSkeleton = (n) => ({
  type: "Column", key: "skel" + n, gap: 8, children: [
    { type: "Skeleton", shape: "line", width: 120 },
    { type: "Row", gap: 12, sizes: ["compact"], children: [1, 2, 3].map((i) => ({ type: "Skeleton", shape: "card", key: `sk${n}c${i}`, flex: 1 })) },
    { type: "Row", gap: 12, sizes: ["medium", "expanded"], children: [1, 2, 3, 4, 5, 6].map((i) => ({ type: "Skeleton", shape: "card", key: `sk${n}w${i}`, flex: 1 })) },
  ],
});

const gridSkeleton = () => ({
  type: "Column", key: "gridSkeleton", gap: 12, children: [
    ...[1, 2].map((r) => ({ type: "Row", gap: 12, sizes: ["compact"], key: `gc${r}`, children: [1, 2, 3].map((i) => ({ type: "Skeleton", shape: "card", key: `gc${r}-${i}`, flex: 1 })) })),
    ...[1, 2].map((r) => ({ type: "Row", gap: 12, sizes: ["medium", "expanded"], key: `gw${r}`, children: [1, 2, 3, 4, 5, 6].map((i) => ({ type: "Skeleton", shape: "card", key: `gw${r}-${i}`, flex: 1 })) })),
  ],
});

const heroSkeleton = () => ({ type: "Skeleton", key: "heroSkeleton", shape: "block", height: { compact: 200, expanded: 320 } });

const slideNode = (s, canPlay) => ({
  type: "heroCard", key: "slide-" + s.id, h: { compact: 200, expanded: 240 }, ...(s.logo ? { logo: s.logo } : {}), title: s.title, text: s.text, image: s.image,
  buttons: canPlay
    ? [
      { type: "ElevatedButton", key: "watch-" + s.id, ...twin("brWatch", "labelText"), icon: "play", onPressed: { go: { play: { ref: s.ref, kind: s.kind, id: s.id, title: s.title } } } },
      { type: "TextButton", key: "info-" + s.id, ...twin("brInfo", "labelText"), onPressed: { go: { title: { ref: s.ref, kind: s.kind, id: s.id, title: s.title } } } },
    ]
    : [
      { type: "ElevatedButton", key: "watch-" + s.id, ...twin("brWatch", "labelText"), icon: "play", onPressed: { go: { title: { ref: s.ref, kind: s.kind, id: s.id, title: s.title } } } },
    ],
});

// The key carries the number of slides: Kino's pager (0.9.81) keeps the count of its first drawing, and a slider that goes from 4
// slides (the kept copy) to 6 (the fresh page) closed the app with "Index 4 out of bounds for length 4". A new key is a new pager.
const hero = (slides, canPlay) => (slides.length === 1 ? slideNode(slides[0], canPlay) : { type: "PageView", key: "hero" + slides.length, autoPlayMs: 6_000, children: slides.map((x) => slideNode(x, canPlay)) });

const rail = (r, key, titleOverride) => ({
  type: "titleRail", key, ...(titleOverride || { title: r.title, ...(r.titleEn ? { titleEn: r.titleEn } : {}) }), ...(r.ref ? { ref: r.ref } : {}), items: r.items, size: "medium",
});

/** The plugin's logo as the bar's title; the name itself where the logo cannot be drawn (an older Kino, a refused picture). */
const brandNode = (brand) => ({ type: "Text", key: "logo", text: brand, textEn: brand, style: "h4" });

const tabBar = (tabs, active) => ({ type: "TabBar", key: "tabs", divider: false, value: active, onChanged: "tab", tabs: tabs.map((t) => ({ value: t.id, ...tabLabel(t) })) });

/**
 * `data`: `{ slides, rails }` of the active tab, or null while it is not in. `recent`: the cards of the played titles.
 * `pending`: some tab is still being fetched (the timer polls only then). `failed`: the active tab could not load.
 */
export function browseView({ brand, tabs, tab, data, recent, pending, failed, canPlay = false, device = "phone" }) {
  const tv = device === "tv";
  const active = tabs.some((t) => t.id === tab) ? tab : tabs[0].id;
  const body = [];
  if (data) {
    if (data.slides.length > 0) body.push(hero(data.slides, canPlay));
    if (recent.length > 0) body.push(rail({ items: recent }, "recent", twin("brRecent", "title")));
    for (const r of data.rails) body.push(rail(r, "rail-" + String(r.id).replace(/[^A-Za-z0-9_-]/g, "_")));
    if (data.rails.length === 0) body.push({ type: "Text", ...twin("brEmpty", "text"), color: "muted" });
  } else if (failed) {
    body.push({ type: "MaterialBanner", key: "loadFailed", role: "error", ...twin("brFailed"), action: { ...twin("brRetry", "label"), onTap: "retry" } });
  } else {
    body.push(heroSkeleton(), railSkeleton(1), railSkeleton(2), railSkeleton(3));
  }
  const gear = { type: "IconButton", key: "settingsButton", icon: "settings", ...twin("brSettings", "labelText"), ...twin("brSettings", "tooltip"), onPressed: { event: "go", arg: "settings" } };
  return {
    type: "Scaffold",
    appBar: {
      type: "AppBar", mergeWithKinoBar: true, dense: true, divider: false,
      leading: { type: "IconButton", key: "close", icon: "close", ...twin("brClose", "labelText"), ...twin("brClose", "tooltip"), onPressed: { go: { close: true } } },
      // On a TV the search is a button of the bar (a floating one is hard to reach with a remote); elsewhere it floats.
      actions: tv ? [{ type: "IconButton", key: "searchButton", icon: "search", ...twin("brSearch", "labelText"), ...twin("brSearch", "tooltip"), onPressed: "openSearch" }, gear] : [gear],
      // On a TV the tabs sit in the bar beside the name (one row, one D-pad strip); elsewhere they are pinned under it.
      title: tv ? { type: "Row", key: "titleRow", gap: 24, crossAxisAlignment: "center", children: [brandNode(brand), tabBar(tabs, active)] } : brandNode(brand),
    },
    ...(tv ? {} : { floatingActionButton: { type: "FloatingActionButton", key: "searchFab", icon: "search", ...twin("brSearch", "tooltip"), onPressed: "openSearch" } }),
    body: { type: "Column", key: "page", children: [
      ...(tv ? [] : [{ type: "Column", key: "tabsRow", padding: { compact: 0, expanded: 24 }, children: [tabBar(tabs, active)] }]),
      { type: "SingleChildScrollView", key: "browse-" + active, flex: 1, children: [{ type: "Column", padding: { compact: 12, expanded: 24 }, gap: 16, children: body }] },
    ] },
    ...(pending ? { every: { ms: POLL_MS, event: "tick" } } : {}),
  };
}

/** The search page (route "search"). `status`: "idle", "loading", "done" or "fail". */
export function searchView({ query, status, items, history = [], device = "phone" }) {
  const tv = device === "tv";
  const searchForm = () => ({
    type: "Form", key: "searchForm", onSubmitted: "search", gap: 8, children: tv
      ? [{ type: "Row", key: "searchRow", gap: 16, crossAxisAlignment: "center", children: [
        { type: "TextField", key: "q", kind: "text", value: query, ...twin("brSearchHint", "labelText"), maxLength: 100, autofocus: true, weight: 1 },
        { type: "ElevatedButton", key: "searchGo", ...twin("brSearch", "labelText"), icon: "search", submit: true },
      ] }]
      : [
        { type: "TextField", key: "q", kind: "text", value: query, ...twin("brSearchHint", "labelText"), maxLength: 100, autofocus: true },
        { type: "ElevatedButton", key: "searchGo", ...twin("brSearch", "labelText"), icon: "search", submit: true },
      ],
  });
  const body = tv ? [] : [searchForm()];
  if (status === "fail") {
    body.push({ type: "MaterialBanner", key: "searchFailed", role: "error", ...twin("brSearchFailed"), action: { ...twin("brRetry", "label"), onTap: "sretry" } });
  } else if (status === "done" && items) {
    if (items.length === 0) body.push({ type: "Text", ...twin("brNoResults", "text"), color: "muted" });
    else body.push({ type: "titleGrid", key: "results", columns: { compact: 3, expanded: 6 }, items: items.slice(0, SEARCH_CAP) });
  } else if (status !== "idle") {
    body.push(gridSkeleton());
  } else if (history.length > 0) {
    body.push({ type: "Text", ...twin("brSearchedBefore", "text"), style: "h4" });
    body.push({ type: "titleGrid", key: "history", columns: { compact: 3, expanded: 6 }, items: history.slice(0, SEARCH_CAP) });
  }
  return {
    type: "Scaffold",
    appBar: {
      type: "AppBar", mergeWithKinoBar: true, dense: true, divider: false,
      leading: { type: "IconButton", key: "back", icon: "arrow_back", ...twin("brBack", "labelText"), ...twin("brBack", "tooltip"), onPressed: "back" },
      ...(tv ? { title: searchForm() } : twin("brSearchTitle", "title")),
    },
    body: { type: "SingleChildScrollView", key: "search-page", children: [{ type: "Column", padding: { compact: 12, expanded: 24 }, gap: 16, children: body }] },
    ...(status === "loading" ? { every: { ms: 1_000, event: "stick" } } : {}),
  };
}

/** The settings page (route "settings"): the same one bar, then Kino's own form of the plugin's settings. */
export function settingsView({ brand }) {
  return {
    type: "Scaffold",
    appBar: {
      type: "AppBar", mergeWithKinoBar: true, dense: true, divider: false,
      leading: { type: "IconButton", key: "back", icon: "arrow_back", ...twin("brBack", "labelText"), ...twin("brBack", "tooltip"), onPressed: "back" },
      title: brandNode(brand),
    },
    body: { type: "SingleChildScrollView", key: "settings-page", children: [{ type: "Column", padding: { compact: 12, expanded: 24 }, gap: 16, children: [{ type: "settings", key: "form" }] }] },
  };
}
