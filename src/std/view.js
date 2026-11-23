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

/** The bar as the search box: the brand, its buttons (and the TV's tabs) hidden, the box shown and focused. At most 8 ops. */
export const searchOpenOps = (tabsInBar) => [
  { hide: "brand" }, { hide: "searchButton" }, { hide: "settingsButton" }, ...(tabsInBar ? [{ hide: "tabs" }] : []),
  { show: "closeSearch" }, { show: "q" }, { focus: "q" },
];

/** The bar back as it was: the box hidden and emptied. At most 8 ops. */
export const searchClosedOps = (tabsInBar) => [
  { hide: "closeSearch" }, { hide: "q" }, { clear: "q" },
  { show: "brand" }, { show: "searchButton" }, { show: "settingsButton" }, ...(tabsInBar ? [{ show: "tabs" }] : []),
];

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
 */
export function browseView(cfg, { tab, data, recent, pending, failed, device = "phone" }) {
  const tv = device === "tv";
  const tabs = cfg.tabs;
  const active = tabs.some((t) => t.id === tab) ? tab : tabs[0].id;
  const withTabs = tabs.length > 1;
  const body = [];
  if (data) {
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
  // with no plugin call (a plugin call waits in line behind the tab loads, which made the bar slow to react).
  const tabsInBar = tv && withTabs; // on a TV the tabs sit in the bar beside the brand (one D-pad strip); elsewhere under it
  const appBar = bar({
    leading: iconButton("close", "close", "close", { go: { close: true } }),
    title: { type: "Row", key: "titleRow", gap: tabsInBar ? 24 : 8, crossAxisAlignment: "center", children: [
      { ...iconButton("closeSearch", "arrow_back", "back", { ui: searchClosedOps(tabsInBar) }), hidden: true },
      brand(cfg),
      ...(tabsInBar ? [tabBar(tabs, active)] : []),
      { type: "TextField", key: "q", hidden: true, flex: 1, kind: "search", maxLength: 200, ...twin("searchHint", "hintText", { name: [cfg.name, cfg.nameEn || cfg.name] }),
        onSubmitted: "search", trailingIcon: "search", ...twin("search", "trailingLabel"), onTrailingTap: "search" },
    ] },
    actions: [
      iconButton("searchButton", "search", "search", { ui: searchOpenOps(tabsInBar) }),
      iconButton("settingsButton", "settings", "settings", "openSettings"),
    ],
  });
  return {
    type: "Scaffold",
    appBar,
    body: { type: "Column", key: "page", children: [
      ...(withTabs && !tv ? [{ type: "Column", key: "tabsRow", padding: { compact: 0, expanded: 24 }, children: [tabBar(tabs, active)] }] : []),
      { type: "SingleChildScrollView", key: "browse-" + active, flex: 1, children: [...(banner ? [banner] : []), { type: "Column", padding: { compact: 12, expanded: 24 }, gap: 16, children: body }] },
    ] },
    ...(pending ? { every: { ms: POLL_MS, event: "tick" } } : {}),
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
    appBar: bar({ leading: iconButton("close", "close", "close", { go: { close: true } }), title: brand(cfg) }),
    body: { type: "Column", key: "gate", mainAxisAlignment: "center", crossAxisAlignment: "center", padding: 24, gap: 16, children: [
      { type: "Text", key: "gateTitle", style: "h3", ...twin("gateTitle") },
      { type: "Text", key: "gateText", style: "p", ...twin("gateText", "text", { name }) },
      { type: "ElevatedButton", key: "installResolver", ...twin("gateInstall", "labelText"), onPressed: { go: { installPlugin: { repo: RESOLVER_REPO } } } },
      supportNode(device),
    ] },
  };
}
