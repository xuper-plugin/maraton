// std 1.9.3 — the standard screen of the xuper-plugin site plugins (golden copy: C:\dev\xuper-plugin\_standard\src\std).
// Copy this folder as it is into a plugin's src/std/; a change goes to the golden copy first, then to every plugin.
//
// It paints at once from what is kept, then fills each tab as the source answers:
// - `open` reads no network: the active tab is drawn from its kept copy (skeletons if none) and the tabs that still need their
//   rows become `pending` in the state.
// - A timer (`every`, only while something is pending) loads ONE tab per tick. Each tab is kept (kino.storage) the moment it
//   arrives, so a slow source never holds the others back.
// - Only the tab on show loads; another loads when it is selected (no prefetch: every plugin call waits in line with the
//   screen's events, so a prefetch made a tap wait seconds).
// The bar's search hands the words to Kino's own search (this plugin as the source); a card or a slide opens Kino's own title
// page. Ajustes is a page with Kino's own form of the plugin's settings and the donation.
import { tabOf, recentOf, playedKey, slideText, MAX_SLIDES } from "./model.js";
import { browseView, settingsView, gateView, resultsView, searchClosedOps, RESOLVER_REPO } from "./view.js";
import { makeMetaCache } from "./metaCache.js";

const TAB_KEY = "browseTab";
const SNAP_PREFIX = "browse1:";
const SNAP_TTL_MS = 7 * 24 * 3600 * 1000;
// A tab's kept copy: at most 20 KB, and all of them together about 96 KB of the plugin's 256 KB shared storage.
const SNAP_MAX = 20 * 1024;
const SNAPS_TOTAL = 96 * 1024;
const RECENT_KEY = "recent1";
const RECENT_MAX = 12;
const Q_MAX = 200;
// One tick's TMDB lookups: short, because the screen's events wait in line behind it (the titles left are asked on a later opening).
const META_TICK_MS = 3_000;
// At most this many titles asked of TMDB per tick (a poster-only tab with many rails would otherwise ask a hundred).
const META_TICK_CARDS = 24;
// Kino stops a call at 20 s, and three of the timer's calls failing in a row switch the timer off for the rest of the opening,
// leaving the skeletons with no way out. Kino has no timers to cut a load short, so each load leaves a mark in kino.storage
// and clears it when done: a mark older than a call can live means Kino stopped that load, and the next tick answers at once
// with that tab failed (its Retry banner) instead of starting it again.
const INFLIGHT_KEY = "std:inflight";
const INFLIGHT_STALE_MS = 18_000;
// A tab with no slides of its own asks TMDB again on the next tick, until MAX_SLIDES are known, every title was asked or this
// many ticks passed.
const MAX_META_TICKS = 10;
const DEFAULT_TABS = [{ id: "inicio", label: "Inicio", labelEn: "Home" }];

/**
 * `kino`: the host. `name` / `nameEn`: the plugin's name in the bar. `logo`: a data: address of its logo, or null.
 * `needsResolver`: the plugin cannot play without kino-resolver installed (the screen is then its install gate while it is
 * missing). `hasSettings`: the manifest declares `settings`. `tabs`: `[{ id, label, labelEn }]`. `loadTab(tabId)` → `{ rows }`.
 * `homeKey`: the kino.storage key where the plugin's home() keeps `{ rows }`, to seed the first tab (optional).
 * `page` (std 1.7.0, Da-Video): `{ open: async (ev) => statePatch, view: (ctx) => nodes, events: { name: async (ev) => answer } }`
 * (std 1.9.0: `actions: (ctx) => nodes`, its own bar buttons, drawn before the settings gear):
 * the plugin's own body under the standard bar instead of tabs of title rails (no tab loading); `every?: (ctx) => { ms, event } | null`
 * runs a timer of its own while it answers one.
 * `searchHere` (std 1.7.0, Da-Video): `{ sources: async () => [{ repo, name }], searchIn: async (q, repos) => [{ repo, name, ok,
 * items }] }`: the bar's search opens a results page here (one rail per source, as each answers) instead of Kino's search.
 * `titleOf(card)` / `typeOf(card)`: the title and type TMDB is asked for (optional). `tmdbPictures`: TMDB's poster on the cards
 * and its backdrop on the slides, for a site whose own pictures do not load. `imageHeaders`: `{ Referer, "User-Agent" }` sent
 * with the hero's and the rails' pictures (Kino 0.9.83+), for a site whose images need them.
 */
// ---- Home snapshot (std 1.8.0, owner 2026-11-23) ----
// Each plugin repository keeps a ready copy of its screen's tabs in home/<tab>.json, written every 6 hours by a GitHub Action
// (scripts/home-snapshot.mjs) that runs the plugin's own loadTab. The screen reads that file first (one small request instead of
// scraping the site on the device) and scrapes the site only when the file is missing, broken or older than SNAPSHOT_MAX_AGE_MS.

export const SNAPSHOT_VERSION = 1;
export const SNAPSHOT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const SNAPSHOT_TIMEOUT_MS = 8000;

/** Where a tab's snapshot lives: the repository's main branch on raw.githubusercontent.com. */
export const snapshotUrl = (repo, tab) => "https://raw.githubusercontent.com/" + repo + "/main/home/" + encodeURIComponent(tab) + ".json";

/** The rows of a snapshot file for [tab], or null when it is not one, is for another tab, is empty or is too old. Pure. */
export function snapshotRows(text, tab, now = Date.now()) {
  let o;
  try { o = JSON.parse(String(text)); } catch (_) { return null; }
  if (!o || o.v !== SNAPSHOT_VERSION || o.tab !== tab || !Array.isArray(o.rows) || o.rows.length === 0) return null;
  const at = Number(o.at);
  if (!Number.isFinite(at) || now - at > SNAPSHOT_MAX_AGE_MS || at - now > 60 * 60 * 1000) return null;
  return o.rows;
}

/** The tabs and the live loadTab of the last standard screen made (the snapshot script runs them). */
let lastSource = null;
export const snapshotSource = () => lastSource;

export function makeStandardScreen({ kino, name, nameEn, logo = null, logoAspect = "1:1", needsResolver, hasSettings, tabs, loadTab, homeKey = null, titleOf, typeOf, tmdbPictures = false, imageHeaders = null, searchHere = null, page = null, barSearch = true, backArrow = true, snapshot = null }) {
  const cfg = { name, nameEn, logo, logoAspect, imageHeaders, hasSettings: !!hasSettings, barSearch: barSearch !== false, backArrow: backArrow !== false, tabs: Array.isArray(tabs) && tabs.length > 0 ? tabs : DEFAULT_TABS };
  const TAB_IDS = cfg.tabs.map((t) => t.id);
  lastSource = { tabs: cfg.tabs, loadTab, titleOf, typeOf };
  /** [tab]'s rows from the repository's snapshot (`snapshot`: "owner/repo"), or null to scrape the site as before. */
  async function fromSnapshot(tab) {
    if (typeof snapshot !== "string" || !/^[\w.-]+\/[\w.-]+$/.test(snapshot)) return null;
    try {
      const r = await kino.fetch(snapshotUrl(snapshot, tab), { timeoutMs: SNAPSHOT_TIMEOUT_MS });
      if (!r || !r.ok) return null;
      const rows = snapshotRows(await r.text(), tab);
      return rows ? { rows } : null;
    } catch (_) { return null; }
  }
  const meta = makeMetaCache({ kino, titleOf, typeOf, tmdbPictures });
  /** A source with no backdrops: slides from the first titles TMDB knows a backdrop for (with its synopsis and logo). */
  function slidesFromMeta(rails) {
    const out = [];
    for (const r of rails) {
      for (const c of r.items) {
        if (out.length >= MAX_SLIDES) return out;
        const k = meta.known(c.id);
        if (!k.backdrop || c.adult === true || out.some((x) => x.id === c.id)) continue;
        out.push({ id: c.id, ref: c.ref, kind: c.kind, title: c.title, image: k.backdrop, text: slideText(k.overview, c), ...(k.logo ? { logo: k.logo } : {}) });
      }
    }
    return out;
  }
  const enrich = (data) => {
    if (!data) return data;
    const own = data.slides.map((s) => {
      const k = meta.known(s.id);
      const image = tmdbPictures && k.backdrop ? k.backdrop : null;
      return k.logo || image ? { ...s, ...(k.logo ? { logo: k.logo } : {}), ...(image ? { image } : {}) } : s;
    });
    const learned = own.length > 0 ? [] : slidesFromMeta(data.rails);
    return {
      // The site's own backdrops, else TMDB's, else the posters: every plugin has a hero.
      slides: own.length > 0 ? own : learned.length > 0 ? learned : data.posterSlides || [],
      rails: data.rails.map((r) => ({ ...r, items: meta.dress(r.items) })),
    };
  };
  const metaTicks = new Map(); // tab -> TMDB ticks run in this sandbox
  // searchHere: what each source answered for the search on show (repo -> { ok, items }), kept in memory, never in the state.
  const found = new Map();
  /** Up to this many sources asked per tick of the results page (Kino opens at most 2 plugin runtimes at a time). */
  const SOURCES_PER_TICK = 3;
  /** A source's answer as the results page draws it: each item tagged with its origin, its id kept apart from other sources'. */
  const asFound = (a, index) => ({
    ok: !!(a && a.ok),
    items: a && a.ok && Array.isArray(a.items) ? a.items.filter((x) => x && x.id && x.ref && x.title).slice(0, 40)
      .map((x) => ({ ...x, id: ("p" + index + "~" + x.id).slice(0, 128), origin: a.repo })) : [],
  });
  const memo = new Map(); // tab -> { data, whole: loaded in this sandbox }
  const log = (...a) => { try { kino.log("[std]", ...a); } catch (_) { /* no log */ } };
  const get = (k) => { try { return kino.storage.get(k); } catch (_) { return null; } };
  const set = (k, v, opts) => { try { kino.storage.set(k, v, opts); } catch (_) { /* full storage: no copy */ } };

  function readSnap(tab) {
    try {
      const o = JSON.parse(get(SNAP_PREFIX + tab) || "null");
      return o && Date.now() - o.at < SNAP_TTL_MS && o.data && Array.isArray(o.data.rails) ? o.data : null;
    } catch (_) { return null; }
  }
  const snapMax = Math.min(SNAP_MAX, Math.floor(SNAPS_TOTAL / TAB_IDS.length));
  function writeSnap(tab, data) {
    for (let per = 10; per >= 3; per -= 2) {
      const slim = { slides: data.slides, posterSlides: data.posterSlides || [], rails: data.rails.map((r) => ({ ...r, items: r.items.slice(0, per) })) };
      const text = JSON.stringify({ at: Date.now(), data: slim });
      if (text.length <= snapMax) { set(SNAP_PREFIX + tab, text, { ttlMs: SNAP_TTL_MS }); return; }
    }
  }
  /** The first tab may be drawn from the rows the plugin's home() keeps, then refreshed. */
  function homeSeed(tab) {
    if (!homeKey || tab !== TAB_IDS[0]) return null;
    try {
      const o = JSON.parse(get(homeKey) || "null");
      return o && Array.isArray(o.rows) && o.rows.length ? tabOf({ rows: o.rows }) : null;
    } catch (_) { return null; }
  }

  const stored = () => { const t = get(TAB_KEY); return TAB_IDS.includes(t) ? t : null; };
  function dataOf(tab) {
    if (memo.has(tab)) return memo.get(tab).data;
    const snap = readSnap(tab) || homeSeed(tab);
    if (snap) { memo.set(tab, { data: snap, whole: false }); return snap; }
    return null;
  }

  const readKeys = () => { try { const a = JSON.parse(get(RECENT_KEY) || "[]"); return Array.isArray(a) ? a.filter((k) => typeof k === "string") : []; } catch (_) { return []; } };
  /** Notes that [ref] was played now, for the "Continuar viendo" row. Never throws. */
  function notePlayed(ref) {
    try {
      const key = playedKey(ref);
      if (key === "" || key.startsWith("x|")) return;
      const keys = readKeys();
      if (keys[0] === key) return;
      set(RECENT_KEY, JSON.stringify([key, ...keys.filter((k) => k !== key)].slice(0, RECENT_MAX)));
    } catch (_) { /* the row just misses a title */ }
  }

  const tabFromArgs = (route) => {
    const a = route && route.args && typeof route.args === "object" ? route.args : {};
    return TAB_IDS.includes(a.tab) ? a.tab : null;
  };
  // Only the active tab loads: a tab is fetched when it is selected. Every plugin call waits in line with the screen's events,
  // so prefetching the other tabs made a tap (Ajustes, the search) wait seconds behind their network loads.
  function needed(tab) {
    return memo.get(tab) && memo.get(tab).whole ? [] : [tab];
  }

  function screen(ctx) {
    const c = ctx || {};
    const device = c.device || "phone";
    if (needsResolver && !(c.installed && c.installed[RESOLVER_REPO])) return gateView(cfg, device);
    if (c.route && c.route.name === "settings") return settingsView(cfg, device);
    if (searchHere && c.route && c.route.name === "results") {
      const st0 = c.state && typeof c.state === "object" ? c.state : {};
      return resultsView(cfg, { q: String(st0.rq || ""), order: Array.isArray(st0.rorder) ? st0.rorder : [], names: st0.rnames || {},
        pending: Array.isArray(st0.rpending) ? st0.rpending : [], found, device });
    }
    const st = c.state && typeof c.state === "object" ? c.state : {};
    const tab = TAB_IDS.includes(st.tab) ? st.tab : (tabFromArgs(c.route) ?? stored() ?? TAB_IDS[0]);
    const data = enrich(dataOf(tab));
    const loaded = TAB_IDS.map((t) => memo.get(t)).filter(Boolean).map((m) => m.data);
    const pending = Array.isArray(st.pending) && st.pending.length > 0;
    const searching = st.searching === true;
    if (page) {
      const tree = browseView(cfg, { tab: TAB_IDS[0], data: null, recent: [], pending: false, failed: false, searching, device, own: page.view({ ...c, state: st }) || [],
        ownActions: page.actions ? page.actions({ ...c, state: st }) || [] : [] });
      // The page may run its own timer (e.g. while a long job of its own runs): { ms, event }, one of its own events.
      const every = page.every ? page.every({ ...c, state: st }) : null;
      return every ? { ...tree, every } : tree;
    }
    return browseView(cfg, { tab, data, recent: meta.dress(recentOf(readKeys(), loaded)), pending, failed: !!(st.failed && st.failed[tab]), searching, device });
  }

  /** The tab whose load Kino cut short last time (its mark outlived any call), cleared once read; else null. */
  function cutShort() {
    try {
      const o = JSON.parse(get(INFLIGHT_KEY) || "null");
      if (!o || typeof o.tab !== "string") return null;
      if (Date.now() - Number(o.at) < INFLIGHT_STALE_MS) return null;
      kino.storage.remove(INFLIGHT_KEY);
      return o.tab;
    } catch (_) { return null; }
  }

  async function load(tab) {
    set(INFLIGHT_KEY, JSON.stringify({ tab, at: Date.now() }));
    let page;
    try { page = (await fromSnapshot(tab)) || (await loadTab(tab)); } finally { try { kino.storage.remove(INFLIGHT_KEY); } catch (_) { /* no storage */ } }
    const data = tabOf(page);
    if (data) { memo.set(tab, { data, whole: true }); writeSnap(tab, data); }
    return data !== null;
  }

  const events = {
    async open(ev) {
      if (page) {
        let patch = {};
        try { patch = (page.open ? await page.open(ev) : {}) || {}; } catch (e) { log("page open", (e && e.code) || "error"); }
        return { state: { ...patch, tab: TAB_IDS[0], pending: [], failed: null } };
      }
      return events.openTabs(ev);
    },
    openTabs({ route, state, device }) {
      const tab = tabFromArgs(route) ?? (TAB_IDS.includes(state.tab) ? state.tab : stored() ?? TAB_IDS[0]);
      for (const t of TAB_IDS) dataOf(t); // the kept copies, so a played title is found whichever tab it was on
      return { state: { tab, pending: needed(tab), failed: null } };
    },
    tab({ value, arg, state }) {
      const tab = TAB_IDS.includes(value) ? value : TAB_IDS.includes(arg) ? arg : null;
      if (!tab) return null;
      set(TAB_KEY, tab);
      dataOf(tab);
      const failed = { ...(state.failed || {}) };
      delete failed[tab];
      const pending = [tab, ...(Array.isArray(state.pending) ? state.pending.filter((t) => t !== tab) : [])];
      return { state: { tab, pending: memo.get(tab) && memo.get(tab).whole ? pending.slice(1) : pending, failed } };
    },
    retry({ state }) {
      const tab = TAB_IDS.includes(state.tab) ? state.tab : TAB_IDS[0];
      // The failed tab first; what was already queued (another tab's TMDB tick) stays.
      const queued = Array.isArray(state.pending) ? state.pending.filter((t) => t !== tab) : [];
      return { state: { failed: null, pending: [tab, ...queued] } };
    },
    async tick({ state, route }) {
      if (searchHere && route && route.name === "results") {
        const rp = Array.isArray(state.rpending) ? state.rpending : [];
        if (rp.length === 0) return null;
        const batch = rp.slice(0, SOURCES_PER_TICK);
        const order = Array.isArray(state.rorder) ? state.rorder : [];
        let answers = [];
        try { answers = await searchHere.searchIn(String(state.rq || ""), batch); } catch (e) { log("results", ((e && e.code) || "error") + " " + String((e && e.message) || "").slice(0, 200)); }
        for (const repo of batch) {
          const a = (Array.isArray(answers) ? answers : []).find((x) => x && x.repo === repo);
          found.set(repo, asFound(a, order.indexOf(repo)));
        }
        return { state: { rpending: rp.slice(SOURCES_PER_TICK) } };
      }
      const pending = Array.isArray(state.pending) ? state.pending : [];
      if (pending.length === 0) return null;
      const [next, ...rest] = pending;
      const failed = { ...(state.failed || {}) };
      // The TMDB ids and title logos of a tab's first titles (slides first), a few lookups per tick.
      if (next.startsWith("meta:")) {
        const tab = next.slice(5);
        const m = memo.get(tab);
        if (!m) return { state: { pending: rest } };
        const ask = (x) => ({ id: x.id, title: x.title, kind: x.kind, ...(x.year !== undefined ? { year: x.year } : {}) });
        const noOwnSlides = m.data.slides.length === 0;
        // Without slides of its own a tab needs TMDB backdrops: more of its titles are asked, in row order.
        const cards = [...m.data.slides.map(ask), ...m.data.rails.flatMap((r) => r.items.slice(0, noOwnSlides ? MAX_SLIDES * 3 : 6).map(ask))]
          .filter((c) => !meta.asked(c.id)).slice(0, META_TICK_CARDS);
        const count = await meta.fill(cards, META_TICK_MS);
        const ticks = (metaTicks.get(tab) || 0) + 1;
        metaTicks.set(tab, ticks);
        const again = noOwnSlides && count > 0 && ticks < MAX_META_TICKS && slidesFromMeta(m.data.rails).length < MAX_SLIDES && cards.some((c) => !meta.asked(c.id));
        return { state: { pending: again ? [next, ...rest] : rest } };
      }
      if (cutShort() === next) {
        log("tab", next, "cut short by Kino last time");
        failed[next] = true;
        return { state: { pending: rest, failed } };
      }
      try {
        const ok = await load(next);
        if (!ok) failed[next] = true; else delete failed[next];
        if (ok && meta.usable()) rest.unshift("meta:" + next);
      } catch (e) {
        log("tab", (e && e.code) || "error");
        failed[next] = true;
      }
      return { state: { pending: rest, failed } };
    },
    // The words go to Kino's own search, with this plugin as the source; the bar is put back as it was, locally.
    // The search button's own event (after its local ops): while searching, the tree declares onBack, so Back closes the box.
    searchOpened() { return { state: { searching: true } }; },
    // The box was closed (its arrow, or Back through onBack, already ran the local ops): the flag and the ops go, so the next
    // tree declares no onBack and draws the bar's defaults.
    searchClosed() { return { state: { searching: false, ui: null } }; },
    async search({ value, state, device }) {
      const typed = value && typeof value === "object" ? value.q : value;
      const raw = typed != null && String(typed).trim() !== "" ? typed : state.inputs && state.inputs.q;
      const q = String(raw == null ? "" : raw).trim().slice(0, Q_MAX);
      if (!q) return null;
      const closed = searchClosedOps(device === "tv" && TAB_IDS.length > 1);
      if (searchHere) {
        let sources = [];
        try { sources = (await searchHere.sources()) || []; } catch (e) { log("sources", (e && e.code) || "error"); }
        const order = sources.map((x) => x.repo).filter((r) => typeof r === "string");
        found.clear();
        return { route: { push: "results" }, ui: closed, state: { searching: false, ui: null, rq: q, rorder: order,
          rnames: Object.fromEntries(sources.map((x) => [x.repo, String(x.name || x.repo)])), rpending: order } };
      }
      return { go: { search: { q } }, ui: closed, state: { searching: false, ui: null } };
    },
    openSettings() { return { route: { push: "settings" }, state: { fromBrowse: true } }; },
    back({ state, route }) {
      // The settings page opened on its own (Kino's settings button) closes; pushed from the bar, it pops.
      if (route && route.name === "settings" && !state.fromBrowse) return { close: true };
      return { route: { pop: true }, state: { fromBrowse: false } };
    },
  };

  async function screenEvent(ev) {
    const e = ev || {};
    const name = e.name != null ? e.name : e.event;
    // The page's own events first (never one of std's names), then std's.
    const own = page && page.events && typeof name === "string" && Object.hasOwn(page.events, name) && !Object.hasOwn(events, name) ? page.events[name] : null;
    if (own) return (await own({ ...e, state: e.state || {} })) ?? null;
    const handler = typeof name === "string" && name !== "openTabs" && Object.hasOwn(events, name) ? events[name] : null;
    return handler ? (await handler({ ...e, state: e.state || {} })) ?? null : null;
  }

  return { screen, screenEvent, notePlayed };
}
