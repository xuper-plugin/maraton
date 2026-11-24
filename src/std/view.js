// The standard screen's trees: a pure view of what index.js holds. A tab that is not in yet draws skeletons shaped like what
// will replace them, so nothing jumps when the rows arrive. Every text is in both languages.
// Cards are Kino's own titleRail items and slides open Kino's own title page: no plugin page for a title, no own search.
import { twin } from "./strings.js";

export const SUPPORT_URL = "https://ko-fi.com/xuperplugins";
export const RESOLVER_REPO = "xuper-plugin/kino-plugin-kino-resolver";
const POLL_MS = 1_500;

/** The bar's title: the plugin's logo (when it has one) and its name. */
function brand(cfg) {
  return {
    type: "Row", key: "brand", gap: 12, crossAxisAlignment: "center", children: [
      ...(cfg.logo ? [{ type: "Image", key: "logo", url: cfg.logo, aspect: cfg.logoAspect || "1:1", fit: "contain", h: 32, alt: cfg.name, altEn: cfg.nameEn || cfg.name }] : []),
      { type: "Text", key: "name", style: "h4", text: cfg.name, textEn: cfg.nameEn || cfg.name },
    ],
  };
}

const tabBar = (tabs, active) => ({
  type: "TabBar", key: "tabs", divider: false, value: active, onChanged: "tab",
  tabs: tabs.map((t) => ({ value: t.id, label: t.label, labelEn: t.labelEn || t.label })),
});

const iconButton = (key, icon, word, onPressed) => ({ type: "IconButton", key, icon, ...twin(word, "labelText"), ...twin(word, "tooltip"), onPressed });

/**
 * The bar as the search box: the brand, its buttons, the leading back arrow (std 1.7.1: the box has its own) and the TV's tabs
 * hidden, the box shown and focused. At most 8 ops (Kino's cap): 8 on a TV.
 */
export const searchOpenOps = (tabsInBar) => [
  { hide: "close" }, { hide: "brand" }, { hide: "searchButton" }, { hide: "settingsButton" }, ...(tabsInBar ? [{ hide: "tabs" }] : []),
  { show: "closeSearch" }, { show: "q" }, { focus: "q" },
];

/** The bar back as it was: the box hidden and emptied, the leading arrow back. At most 8 ops: 8 on a TV. */
export const searchClosedOps = (tabsInBar) => [
  { hide: "closeSearch" }, { hide: "q" }, { clear: "q" },
  { show: "close" }, { show: "brand" }, { show: "searchButton" }, { show: "settingsButton" }, ...(tabsInBar ? [{ show: "tabs" }] : []),
];

/**
 * How the screen is left: the back arrow (std 1.7.1 default, owner 2026-11-23: every plugin, opened from Da-Video or from Kino, goes
 * back to where it came from), or the X with `backArrow: false`. Key "close" either way (the search ops hide and show it).
 */
const leaveButton = (cfg) => cfg.backArrow
  ? iconButton("close", "arrow_back", "back", { go: { close: true } })
  : iconButton("close", "close", "close", { go: { close: true } });

/** The donation affordance: a QR on a TV (a TV cannot open a link well), a heart button elsewhere. */
export function supportNode(device) {
  if (device === "tv") return { type: "QrImage", key: "donate", value: SUPPORT_URL, size: "large", ...twin("supportTv", "labelText") };
  return { type: "ElevatedButton", key: "donate", icon: "heart", ...twin("support", "labelText"), onPressed: { go: { url: { href: SUPPORT_URL } } } };
}

/** The bar every page of the screen shares: one bar merged into Kino's (Kino 0.9.81+). */
const bar = ({ leading, title, actions = [] }) => ({ type: "AppBar", mergeWithKinoBar: true, dense: true, divider: false, leading, title, actions });

const railSkeleton = (n) => ({
  type: "Column", key: "skel" + n, gap: 8, children: [
    { type: "Skeleton", shape: "line", width: 120 },
    { type: "Row", gap: 12, sizes: ["compact"], children: [1, 2, 3].map((i) => ({ type: "Skeleton", shape: "card", key: `sk${n}c${i}`, flex: 1 })) },
    { type: "Row", gap: 12, sizes: ["medium", "expanded"], children: [1, 2, 3, 4, 5, 6].map((i) => ({ type: "Skeleton", shape: "card", key: `sk${n}w${i}`, flex: 1 })) },
  ],
});

const heroSkeleton = () => ({ type: "Skeleton", key: "heroSkeleton", shape: "block", height: { compact: 200, expanded: 320 } });

const titleOf = (s) => ({ ref: s.ref, kind: s.kind, id: s.id, title: s.title });

// `headers`: what the pictures are asked with (Kino 0.9.83+, only to the manifest's hosts), for a site whose images need its Referer.
const withHeaders = (headers) => (headers ? { headers } : {});

const slideNode = (s, headers) => ({
  type: "heroCard", key: "slide-" + s.id, h: { compact: 200, expanded: 240 }, ...(s.logo ? { logo: s.logo } : {}), title: s.title, text: s.text, image: s.image, ...withHeaders(headers),
  buttons: [
    { type: "ElevatedButton", key: "watch-" + s.id, ...twin("watch", "labelText"), icon: "play", onPressed: { go: { play: titleOf(s) } } },
    { type: "TextButton", key: "info-" + s.id, ...twin("info", "labelText"), onPressed: { go: { title: titleOf(s) } } },
  ],
});

// The key carries the number of slides: Kino's pager (0.9.81) keeps the count of its first drawing, and a slider that goes from one
// number of slides to another closed the app with "Index 4 out of bounds for length 4". A new key is a new pager.
const hero = (slides, headers) => (slides.length === 1 ? slideNode(slides[0], headers) : {
  type: "PageView", key: "hero" + slides.length, autoPlayMs: 6_000, children: slides.map((s) => slideNode(s, headers)),
});

/** A row of cards: Kino's own rail (a tap opens Kino's title page; `ref` gives its "Ver más"). */
const rail = (r, key, words, headers) => ({
  type: "titleRail", key, ...(words || { title: r.title, titleEn: r.titleEn || r.title }), ...(r.ref ? { ref: r.ref } : {}), items: r.items, ...withHeaders(headers),
});

/**
 * The browse page. `data`: `{ slides, rails }` of the active tab, or null while it is not in. `recent`: the cards of the played
 * titles. `pending`: some tab is still being fetched (the timer polls only then). `failed`: the active tab could not load.
 * `searching`: the search box is open (Back then closes it: the Scaffold declares `onBack`).
 */
export function browseView(cfg, { tab, data, recent, pending, failed, searching = false, device = "phone", own = null, ownActions = [] }) {
  const tv = device === "tv";
  // `own` (std's `page`): the plugin's own body nodes in place of the tabs and their rails.
  const tabs = own ? [cfg.tabs[0]] : cfg.tabs;
  const active = tabs.some((t) => t.id === tab) ? tab : tabs[0].id;
  const withTabs = tabs.length > 1;
  const body = [];
  // std 1.9.1: the page may hand blocks, `{ blocks: [{ edge, nodes }] }`: an `edge` block runs edge to edge (a slider), the others
  // sit in the padded column, in order. A plain array is one padded block, as before.
  const ownBlocks = own && !Array.isArray(own) && Array.isArray(own.blocks) ? own.blocks : null;
  if (ownBlocks) {
    /* drawn below, block by block */
  } else if (own) {
    body.push(...own);
  } else if (data) {
    const h = cfg.imageHeaders;
    if (data.slides.length > 0) body.push(hero(data.slides, h));
    if (recent.length > 0) body.push(rail({ items: recent }, "recent", twin("recent", "title"), h));
    for (const r of data.rails) body.push(rail(r, "rail-" + String(r.id).replace(/[^A-Za-z0-9_-]/g, "_"), null, h));
    if (data.rails.length === 0) body.push({ type: "Text", key: "empty", ...twin("empty"), color: "muted" });
  } else if (failed) {
    body.push({ type: "MaterialBanner", key: "loadFailed", role: "error", ...twin("failed"), action: { ...twin("retry", "label"), onTap: "retry" } });
  } else {
    body.push(heroSkeleton(), railSkeleton(1), railSkeleton(2), railSkeleton(3));
  }
  const isBanner = (n) => !!n && (n.type === "heroCard" || n.key === "heroSkeleton" || (n.type === "PageView" && String(n.key).startsWith("hero")));
  const banner = body.length > 0 && isBanner(body[0]) ? body.shift() : null; // the main picture goes edge to edge, right under the bar

  // The search box lives in the bar from the start, hidden: opening and closing it are local `ui` operations, drawn at once
  // with no wait (a plugin call waits in line behind the tab loads, which made the bar slow to react). The same press also
  // tells the plugin (`searching`), and while it is open the Scaffold declares `onBack`: the system Back closes the box (its
  // ops at once) instead of the screen, and the next Back, with no `onBack` declared, leaves.
  const tabsInBar = tv && withTabs; // on a TV the tabs sit in the bar beside the brand (one D-pad strip); elsewhere under it
  const appBar = bar({
    leading: leaveButton(cfg),
    title: { type: "Row", key: "titleRow", gap: tabsInBar ? 24 : 8, crossAxisAlignment: "center", children: [
      { ...iconButton("closeSearch", "arrow_back", "back", { ui: searchClosedOps(tabsInBar), event: "searchClosed" }), hidden: true },
      brand(cfg),
      ...(tabsInBar ? [tabBar(tabs, active)] : []),
      { type: "TextField", key: "q", hidden: true, flex: 1, kind: "search", maxLength: 200,
        ...twin("searchHint", "hintText", { name: [cfg.name, cfg.nameEn || cfg.name] }),
        onSubmitted: "search", trailingIcon: "search", ...twin("search", "trailingLabel"), onTrailingTap: "search" },
    ] },
    actions: [
      // barSearch: false (std 1.7.0): the plugin draws its own search field in its page instead of the bar's icon.
      ...(cfg.barSearch ? [iconButton("searchButton", "search", "search", { ui: searchOpenOps(tabsInBar), event: "searchOpened" })] : []),
      // std 1.9.0: the page's own bar buttons (page.actions), before the settings gear.
      ...(Array.isArray(ownActions) ? ownActions : []),
      iconButton("settingsButton", "settings", "settings", "openSettings"),
    ],
  });
  return {
    type: "Scaffold",
    ...(searching ? { onBack: { ui: searchClosedOps(tabsInBar), event: "searchClosed" } } : {}),
    appBar,
    body: { type: "Column", key: "page", children: [
      ...(withTabs && !tv ? [{ type: "Column", key: "tabsRow", padding: { compact: 0, expanded: 24 }, children: [tabBar(tabs, active)] }] : []),
      { type: "SingleChildScrollView", key: "browse-" + active, flex: 1, children: ownBlocks
        ? ownBlocks.filter((b) => b && Array.isArray(b.nodes) && b.nodes.length).flatMap((b, i) => (b.edge ? b.nodes
          : [{ type: "Column", key: "block-" + i, padding: { compact: 12, expanded: 24 }, gap: 16, crossAxisAlignment: "stretch", children: b.nodes }]))
        : [...(banner ? [banner] : []), { type: "Column", padding: { compact: 12, expanded: 24 }, gap: 16, children: body }] },
    ] },
    ...(pending ? { every: { ms: POLL_MS, event: "tick" } } : {}),
  };
}

/**
 * The results page of a search shown here (route "results", std's `searchHere`: Da-Video): one rail per plugin, in the
 * plugins' order, as each answers — its cards carry `origin` (Kino opens and plays them in that plugin) —, skeletons for the
 * plugins still asking, a quiet line for one that did not answer. The timer runs while some plugin is still pending.
 */
export function resultsView(cfg, { q, order, names, pending, found, device = "phone" }) {
  const body = [];
  let shown = 0;
  order.forEach((repo, i) => {
    const name = [names[repo] || repo, names[repo] || repo];
    if (pending.includes(repo)) { body.push({ type: "Column", key: "wait-" + i, gap: 8, children: [{ type: "Text", key: "waitText-" + i, color: "muted", ...twin("resultsSearching", "text", { name }) }, railSkeleton(i)] }); return; }
    const r = found.get(repo);
    if (!r || !r.ok) { body.push({ type: "Text", key: "failed-" + i, color: "muted", ...twin("resultsFailed", "text", { name }) }); return; }
    if (!r.items.length) return;
    shown++;
    body.push(rail({ items: r.items }, "found-" + i, twin("resultsIn", "title", { name }), cfg.imageHeaders));
  });
  if (!pending.length && shown === 0 && order.some((r) => { const x = found.get(r); return x && x.ok; })) body.unshift({ type: "Text", key: "noResults", ...twin("noResults") });
  return {
    type: "Scaffold",
    appBar: bar({ leading: iconButton("back", "arrow_back", "back", "back"), title: { type: "Text", key: "resultsTitle", style: "h4", ...twin("resultsTitle", "text", { q }) } }),
    body: { type: "SingleChildScrollView", key: "results-page", children: [{ type: "Column", padding: { compact: 12, expanded: 24 }, gap: 16, children: body }] },
    ...(pending.length ? { every: { ms: 1_500, event: "tick" } } : {}),
  };
}

/** The settings page (route "settings"): Kino's own form of the plugin's settings when it has any, then the donation. */
export function settingsView(cfg, device = "phone") {
  return {
    type: "Scaffold",
    appBar: bar({ leading: iconButton("back", "arrow_back", "back", "back"), title: brand(cfg) }),
    body: { type: "SingleChildScrollView", key: "settings-page", children: [{ type: "Column", padding: { compact: 12, expanded: 24 }, gap: 16, children: [
      ...(cfg.hasSettings ? [{ type: "settings", key: "form" }, { type: "Divider", key: "supportDivider" }] : []),
      supportNode(device),
    ] }] },
  };
}

/** The resolver install gate: the first screen while kino-resolver is missing, for a plugin that cannot play without it. */
export function gateView(cfg, device = "phone") {
  const name = [cfg.name, cfg.nameEn || cfg.name];
  return {
    type: "Scaffold",
    appBar: bar({ leading: leaveButton(cfg), title: brand(cfg) }),
    body: { type: "Column", key: "gate", mainAxisAlignment: "center", crossAxisAlignment: "center", padding: 24, gap: 16, children: [
      { type: "Text", key: "gateTitle", style: "h3", ...twin("gateTitle") },
      { type: "Text", key: "gateText", style: "p", ...twin("gateText", "text", { name }) },
      { type: "ElevatedButton", key: "installResolver", ...twin("gateInstall", "labelText"), onPressed: { go: { installPlugin: { repo: RESOLVER_REPO } } } },
      supportNode(device),
    ] },
  };
}
