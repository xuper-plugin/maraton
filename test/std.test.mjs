// The standard screen (src/std): the bar, the inline search, the settings page, the hero, the native title pages and the gate.
import test from "node:test";
import assert from "node:assert/strict";
import { makeStandardScreen } from "../src/std/index.js";

const RESOLVER = "xuper-plugin/kino-plugin-kino-resolver";
const KOFI = "https://ko-fi.com/xuperplugins";
const LOGO = "data:image/png;base64,AAAA";

function fakeKino() {
  const m = new Map();
  return { storage: { get: (k) => (m.has(k) ? m.get(k) : null), set: (k, v) => m.set(k, v), remove: (k) => m.delete(k) }, log() {} };
}

const item = (n, extra = {}) => ({
  id: "i" + n, ref: "m:" + n, title: "Title " + n, kind: "movie", poster: "https://img/p" + n + ".jpg",
  backdrop: "https://img/b" + n + ".jpg", overview: "Overview " + n, ...extra,
});

function make(over = {}) {
  return makeStandardScreen({
    kino: fakeKino(), name: "SeriesKao", logo: LOGO, logoAspect: "1:1", needsResolver: true, hasSettings: true,
    loadTab: async () => ({ rows: [{ id: "r1", title: "Estrenos", ref: "browse:new", items: [item(1), item(2), item(3)] }] }),
    ...over,
  });
}

const installed = { [RESOLVER]: {} };

/** Every node of a tree, depth first. */
function nodes(tree, out = []) {
  if (Array.isArray(tree)) { for (const t of tree) nodes(t, out); return out; }
  if (!tree || typeof tree !== "object") return out;
  if (typeof tree.type === "string") out.push(tree);
  for (const v of Object.values(tree)) if (v && typeof v === "object") nodes(v, out);
  return out;
}

/** open, then ticks until nothing is pending: the screen state with the tab loaded. */
async function loaded(s, device = "phone") {
  let state = { ...(await s.screenEvent({ name: "open", state: {}, device, route: { name: "main" } })).state };
  for (let i = 0; i < 10 && state.pending && state.pending.length; i++) {
    const r = await s.screenEvent({ name: "tick", state, device });
    state = { ...state, ...(r ? r.state : {}) };
  }
  return state;
}

test("bar has logo, name, search and settings", async () => {
  const s = make();
  const tree = await s.screen({ state: {}, device: "phone", installed });
  assert.equal(tree.appBar.mergeWithKinoBar, true);
  const kids = nodes(tree.appBar.title);
  assert.ok(kids.some((n) => n.type === "Image" && n.url === LOGO));
  assert.ok(kids.some((n) => n.type === "Text" && n.text === "SeriesKao"));
  assert.deepEqual(tree.appBar.actions.map((a) => a.icon), ["search", "settings"]);
  // The search box and its back arrow are in the bar from the start, hidden.
  assert.equal(kids.find((n) => n.key === "q").hidden, true);
  assert.equal(kids.find((n) => n.key === "closeSearch").hidden, true);
  assert.equal(tree.floatingActionButton, undefined);
});

test("bar without a logo still has the name", async () => {
  const tree = await make({ logo: null }).screen({ state: {}, device: "phone", installed });
  const kids = nodes(tree.appBar.title);
  assert.ok(!kids.some((n) => n.type === "Image"));
  assert.ok(kids.some((n) => n.type === "Text" && n.text === "SeriesKao"));
});

/** The ui operations of an action, as "op:key" strings. */
const ops = (action) => (action && action.ui ? action.ui.map((o) => Object.entries(o).map(([k, v]) => k + ":" + v)[0]) : []);

test("search opens and closes in the bar at once (local ui), and tells the plugin so Back can close it", async () => {
  const tree = await make().screen({ state: {}, device: "phone", installed });
  const all = nodes(tree.appBar);
  const open = all.find((n) => n.key === "searchButton").onPressed;
  assert.equal(open.event, "searchOpened", "then the plugin notes it, so the tree declares onBack");
  assert.deepEqual(ops(open).sort(), ["focus:q", "hide:close", "hide:brand", "hide:searchButton", "hide:settingsButton", "show:closeSearch", "show:q"].sort());
  const close = all.find((n) => n.key === "closeSearch");
  assert.equal(close.icon, "arrow_back");
  assert.equal(close.onPressed.event, "searchClosed");
  assert.deepEqual(ops(close.onPressed).sort(), ["clear:q", "hide:closeSearch", "hide:q", "show:close", "show:brand", "show:searchButton", "show:settingsButton"].sort());
  const q = all.find((n) => n.key === "q");
  assert.equal(q.type, "TextField");
  assert.equal(q.kind, "search");
  assert.equal(q.onSubmitted, "search");
  assert.ok(ops(open).length <= 8 && ops(close.onPressed).length <= 8);
});

test("TV with tabs: the search hides and brings back the tabs in the bar too", async () => {
  const s = make({ tabs: [{ id: "a", label: "A", labelEn: "A" }, { id: "b", label: "B", labelEn: "B" }] });
  const all = nodes((await s.screen({ state: {}, device: "tv", installed })).appBar);
  assert.ok(ops(all.find((n) => n.key === "searchButton").onPressed).includes("hide:tabs"));
  assert.ok(ops(all.find((n) => n.key === "closeSearch").onPressed).includes("show:tabs"));
});

test("search goes to Kino's search and puts the bar back", async () => {
  const s = make();
  const done = await s.screenEvent({ name: "search", value: "  dune ", state: {} });
  assert.deepEqual(done.go, { search: { q: "dune" } });
  assert.deepEqual(ops(done).sort(), ["clear:q", "hide:closeSearch", "hide:q", "show:close", "show:brand", "show:searchButton", "show:settingsButton"].sort());
  const empty = await s.screenEvent({ name: "search", value: "   ", state: {} });
  assert.equal(empty, null, "nothing typed: nothing happens");
  assert.deepEqual((await s.screenEvent({ name: "search", value: null, state: { inputs: { q: "alien" } } })).go, { search: { q: "alien" } });
  const long = await s.screenEvent({ name: "search", value: "x".repeat(300), state: {} });
  assert.equal(long.go.search.q.length, 200);
});

test("open loads only the active tab: no prefetch holding the event queue", async () => {
  const s = make({ tabs: [{ id: "a", label: "A", labelEn: "A" }, { id: "b", label: "B", labelEn: "B" }] });
  const r = await s.screenEvent({ name: "open", state: {}, device: "phone", route: { name: "main" } });
  assert.deepEqual(r.state.pending, ["a"]);
});

test("settings page: Kino's form when the plugin has settings, donate always", async () => {
  const s = make();
  assert.deepEqual(await s.screenEvent({ name: "openSettings", state: {} }), { route: { push: "settings" }, state: { fromBrowse: true } });
  const page = await s.screen({ state: {}, route: { name: "settings" }, device: "phone", installed });
  const all = nodes(page);
  assert.ok(all.some((n) => n.type === "settings"));
  assert.ok(all.some((n) => n.onPressed && n.onPressed.go && n.onPressed.go.url && n.onPressed.go.url.href === KOFI));

  const bare = nodes(await make({ hasSettings: false }).screen({ state: {}, route: { name: "settings" }, device: "phone", installed }));
  assert.ok(!bare.some((n) => n.type === "settings"));
  assert.ok(bare.some((n) => n.onPressed && n.onPressed.go && n.onPressed.go.url && n.onPressed.go.url.href === KOFI));

  const tv = nodes(await s.screen({ state: {}, route: { name: "settings" }, device: "tv", installed }));
  assert.ok(tv.some((n) => n.type === "QrImage" && n.value === KOFI));
});

test("settings page back: pops when pushed from the bar, closes when opened on its own", async () => {
  const s = make();
  const popped = await s.screenEvent({ name: "back", state: { fromBrowse: true }, route: { name: "settings" } });
  assert.deepEqual(popped.route, { pop: true });
  assert.deepEqual(await s.screenEvent({ name: "back", state: {}, route: { name: "settings" } }), { close: true });
});

test("cards and slides open Kino's own title page", async () => {
  const s = make();
  const state = await loaded(s);
  const tree = await s.screen({ state, device: "phone", installed });
  const all = nodes(tree);
  const rail = all.find((n) => n.type === "titleRail");
  assert.ok(rail, "a titleRail");
  assert.equal(rail.items.length, 3);
  assert.equal(rail.ref, "browse:new");
  assert.equal(rail.onTap, undefined);
  assert.ok(!all.some((n) => n.onPressed && n.onPressed.go && n.onPressed.go.screen), "no go.screen anywhere");
  const slide = all.find((n) => n.type === "heroCard");
  const [watch, info] = slide.buttons;
  assert.deepEqual(watch.onPressed.go.play, { ref: "m:1", kind: "movie", id: "i1", title: "Title 1" });
  assert.deepEqual(info.onPressed.go.title, { ref: "m:1", kind: "movie", id: "i1", title: "Title 1" });
});

test("hero key carries the number of slides; one slide is a lone heroCard", async () => {
  const s = make();
  const tree = await s.screen({ state: await loaded(s), device: "phone", installed });
  assert.ok(nodes(tree).some((n) => n.type === "PageView" && n.key === "hero3"));

  const one = make({ loadTab: async () => ({ rows: [{ id: "r1", title: "Uno", items: [item(1)] }] }) });
  const t1 = await one.screen({ state: await loaded(one), device: "phone", installed });
  assert.ok(!nodes(t1).some((n) => n.type === "PageView"));
  assert.ok(nodes(t1).some((n) => n.type === "heroCard"));
});

test("gate only when the plugin needs the resolver and it is missing", async () => {
  const gate = nodes(await make().screen({ state: {}, device: "phone", installed: {} }));
  assert.ok(gate.some((n) => n.onPressed && n.onPressed.go && n.onPressed.go.installPlugin && n.onPressed.go.installPlugin.repo === RESOLVER));
  assert.ok(gate.some((n) => n.onPressed && n.onPressed.go && n.onPressed.go.url && n.onPressed.go.url.href === KOFI));

  const free = await make({ needsResolver: false }).screen({ state: {}, device: "phone", installed: {} });
  assert.deepEqual(free.appBar.actions.map((a) => a.icon), ["search", "settings"]);
});

test("tabs: a TabBar with every tab; none for a single tab", async () => {
  const two = make({ tabs: [{ id: "peliculas", label: "Películas", labelEn: "Movies" }, { id: "series", label: "Series", labelEn: "Series" }] });
  const bar = nodes(await two.screen({ state: {}, device: "phone", installed })).find((n) => n.type === "TabBar");
  assert.deepEqual(bar.tabs.map((t) => t.value), ["peliculas", "series"]);
  assert.ok(!nodes(await make().screen({ state: {}, device: "phone", installed })).some((n) => n.type === "TabBar"));
});

test("TV: search and settings in the bar, no floating button", async () => {
  const tree = await make().screen({ state: {}, device: "tv", installed });
  assert.deepEqual(tree.appBar.actions.map((a) => a.icon), ["search", "settings"]);
  assert.equal(tree.floatingActionButton, undefined);
});

test("every user text has its English twin", async () => {
  const s = make();
  const trees = [
    await s.screen({ state: await loaded(s), device: "phone", installed }),
    await s.screen({ state: {}, route: { name: "settings" }, device: "tv", installed }),
    await s.screen({ state: {}, device: "phone", installed: {} }),
  ];
  for (const n of trees.flatMap((t) => nodes(t))) {
    for (const f of ["labelText", "hintText", "tooltip"]) if (typeof n[f] === "string") assert.equal(typeof n[f + "En"], "string", `${n.type}.${f}En`);
    if (n.type === "Text" && n.key !== "name") assert.equal(typeof n.textEn, "string", `Text "${n.text}" has textEn`);
  }
});

/** A kino whose `meta` (by title) answers TMDB data for every title and records what it was asked. */
function metaKino(asked) {
  const k = fakeKino();
  k.meta = async (q) => { asked.push(q); return { ids: { tmdb: 100 + asked.length }, logo: "https://tmdb/l.png", poster: "https://tmdb/p.jpg", backdrop: "https://tmdb/b.jpg" }; };
  k.meta.byTitle = true;
  return k;
}

test("TMDB lookups run inside the short tick and give the cards their TMDB id", async () => {
  const asked = [];
  const s = make({ kino: metaKino(asked) });
  const tree = await s.screen({ state: await loaded(s), device: "phone", installed });
  assert.ok(asked.length > 0, "kino.meta was asked");
  const rail = nodes(tree).find((n) => n.type === "titleRail");
  assert.ok(rail.items.every((c) => c.ids && Number.isInteger(c.ids.tmdb)), "every card has its TMDB id");
  assert.equal(rail.items[0].poster, "https://img/p1.jpg", "the site's poster is kept without tmdbPictures");
  const slide = nodes(tree).find((n) => n.type === "heroCard");
  assert.equal(slide.logo, "https://tmdb/l.png");
  assert.equal(slide.image, "https://img/b1.jpg");
});

test("titleOf / typeOf shape what TMDB is asked", async () => {
  const asked = [];
  const s = make({ kino: metaKino(asked), titleOf: (c) => c.title.replace(/^Title /, "T"), typeOf: () => "series" });
  await loaded(s);
  assert.equal(asked[0].title, "T1");
  assert.equal(asked[0].type, "series");
});

test("tmdbPictures: TMDB's poster on the cards and its backdrop on the slides", async () => {
  const asked = [];
  const s = make({ kino: metaKino(asked), tmdbPictures: true });
  const tree = await s.screen({ state: await loaded(s), device: "phone", installed });
  assert.equal(nodes(tree).find((n) => n.type === "titleRail").items[0].poster, "https://tmdb/p.jpg");
  assert.equal(nodes(tree).find((n) => n.type === "heroCard").image, "https://tmdb/b.jpg");
});

test("imageHeaders go on every hero card and rail (a site whose pictures need its Referer); none without the option", async () => {
  const H = { Referer: "https://site.example/", "User-Agent": "Mozilla/5.0 test" };
  const s = make({ imageHeaders: H });
  const all = nodes(await s.screen({ state: await loaded(s), device: "phone", installed }));
  const pictured = all.filter((n) => n.type === "heroCard" || n.type === "titleRail");
  assert.ok(pictured.length >= 2);
  for (const n of pictured) assert.deepEqual(n.headers, H, n.type);
  const plain = make();
  const none = nodes(await plain.screen({ state: await loaded(plain), device: "phone", installed }));
  assert.ok(none.filter((n) => n.type === "heroCard" || n.type === "titleRail").every((n) => n.headers === undefined));
});

const posterOnly = (n) => ({ id: "p" + n, ref: "s:" + n, title: "Show " + n, kind: "series", poster: "https://img/pp" + n + ".jpg" });

test("a poster-only source: the slides come from TMDB's backdrops and synopses once known", async () => {
  const k = fakeKino();
  k.meta = async (q) => ({ ids: { tmdb: 7 }, backdrop: "https://tmdb/b-" + q.title + ".jpg", overview: "Synopsis of " + q.title, logo: "https://tmdb/l.png" });
  k.meta.byTitle = true;
  const s = make({ kino: k, loadTab: async () => ({ rows: [{ id: "r", title: "R", items: [posterOnly(1), posterOnly(2), posterOnly(3)] }] }) });
  const tree = await s.screen({ state: await loaded(s), device: "phone", installed });
  const slide = nodes(tree).find((n) => n.type === "heroCard");
  assert.equal(slide.image, "https://tmdb/b-Show 1.jpg");
  assert.equal(slide.text, "Synopsis of Show 1");
});

test("a poster-only source with no TMDB: still a hero, from the posters", async () => {
  const s = make({ loadTab: async () => ({ rows: [{ id: "r", title: "R", items: [posterOnly(1), posterOnly(2)] }] }) });
  const tree = await s.screen({ state: await loaded(s), device: "phone", installed });
  assert.equal(nodes(tree).find((n) => n.type === "heroCard").image, "https://img/pp1.jpg");
});

test("TMDB lookups run three at a time", async () => {
  const k = fakeKino();
  let live = 0, peak = 0;
  k.meta = async () => { live++; peak = Math.max(peak, live); await new Promise((r) => setTimeout(r, 5)); live--; return { ids: { tmdb: 1 } }; };
  k.meta.byTitle = true;
  const items = Array.from({ length: 9 }, (_, i) => item(i + 1));
  const s = make({ kino: k, loadTab: async () => ({ rows: [{ id: "r", title: "R", items }] }) });
  await loaded(s);
  assert.equal(peak, 3);
});

test("a rail where only some cards have a backdrop draws them all as posters (one card shape per rail)", async () => {
  const s = make({ loadTab: async () => ({ rows: [{ id: "r", title: "R", items: [item(1), posterOnly(2)] }] }) });
  const rail = nodes(await s.screen({ state: await loaded(s), device: "phone", installed })).find((n) => n.type === "titleRail");
  assert.ok(rail.items.every((c) => c.backdrop === undefined));
});

// The kit's own checks (the same rules Kino applies): a plugin's copy uses its sdk/, the golden copy the app's kit.
import fs from "node:fs";
const kitUrl = fs.existsSync(new URL("../sdk/screen.mjs", import.meta.url)) ? new URL("../sdk/screen.mjs", import.meta.url).href
  : "file:///C:/dev/kino-app/plugins/sdk/screen.mjs";
const kit = await import(kitUrl);
const SETTINGS = [{ key: "site", type: "text", label: "Sitio", labelEn: "Site", default: "https://x.example" }];
const fold = (v) => JSON.parse(JSON.stringify(v));

test("Kino drops nothing of any tree or answer: phone and TV, Spanish and English, gate, browse and settings", async () => {
  for (const device of ["phone", "tv"]) {
    for (const lang of ["es", "en"]) {
      const s = make({ tabs: [{ id: "a", label: "A", labelEn: "A" }, { id: "b", label: "B", labelEn: "B" }], imageHeaders: { Referer: "https://x.example/" } });
      const state = await loaded(s, device);
      const trees = {
        browse: await s.screen({ state, device, installed }),
        settings: await s.screen({ state, route: { name: "settings" }, device, installed }),
        gate: await s.screen({ state: {}, device, installed: {} }),
        searching: await s.screen({ state: { ...state, searching: true }, device, installed }),
      };
      for (const [name, tree] of Object.entries(trees)) {
        const r = kit.checkScreenTree(fold(tree), lang, undefined, { apiVersion: 30, settings: SETTINGS });
        assert.deepEqual(r.dropped, [], `${device}/${lang}/${name}`);
      }
      for (const [name, ev] of [["search", { name: "search", value: "dune", state: {}, device }], ["openSettings", { name: "openSettings", state: {} }], ["tab", { name: "tab", value: "b", state }], ["searchOpened", { name: "searchOpened", state }], ["searchClosed", { name: "searchClosed", state: { ...state, searching: true } }]]) {
        const r = kit.checkScreenAnswer(fold(await s.screenEvent(ev)), lang, {});
        assert.deepEqual(r.dropped, [], `${device}/${lang}/answer ${name}`);
      }
    }
  }
});

test("a row marked hidden feeds the slides only: it is not drawn as a rail", async () => {
  const s = make({ loadTab: async () => ({ rows: [
    { id: "carousel", title: "", hidden: true, items: [item(7), item(8)] },
    { id: "r", title: "Estrenos", items: [posterOnly(1), posterOnly(2)] },
  ] }) });
  const all = nodes(await s.screen({ state: await loaded(s), device: "phone", installed }));
  const rails = all.filter((n) => n.type === "titleRail");
  assert.deepEqual(rails.map((r) => r.title), ["Estrenos"]);
  assert.equal(all.find((n) => n.type === "heroCard").title, "Title 7");
});

test("a row's English title reaches its rail", async () => {
  const s = make({ loadTab: async () => ({ rows: [{ id: "r", title: "Recién agregadas", titleEn: "Recently added", items: [item(1)] }] }) });
  const rail = nodes(await s.screen({ state: await loaded(s), device: "phone", installed })).find((n) => n.type === "titleRail");
  assert.equal(rail.title, "Recién agregadas");
  assert.equal(rail.titleEn, "Recently added");
});

test("while searching, Back closes the search (Scaffold onBack), then the next Back leaves the screen", async () => {
  const s = make();
  assert.deepEqual(await s.screenEvent({ name: "searchOpened", state: {} }), { state: { searching: true } });
  const open = await s.screen({ state: { searching: true }, device: "phone", installed });
  assert.equal(open.onBack.event, "searchClosed");
  assert.deepEqual(ops(open.onBack).sort(), ["clear:q", "hide:closeSearch", "hide:q", "show:close", "show:brand", "show:searchButton", "show:settingsButton"].sort());
  assert.equal((await s.screen({ state: {}, device: "phone", installed })).onBack, undefined, "not searching: Back leaves");
  // The answer drops the flag and the local ops: the next tree declares no onBack and draws the bar's defaults.
  assert.deepEqual(await s.screenEvent({ name: "searchClosed", state: { searching: true } }), { state: { searching: false, ui: null } });
  const done = await s.screenEvent({ name: "search", value: "dune", state: { searching: true } });
  assert.deepEqual(done.go, { search: { q: "dune" } });
  assert.deepEqual(done.state, { searching: false, ui: null });
});

test("a tab load Kino cut short (its call never answered) is failed with Retry on the next tick, so the timer goes on", async () => {
  const k = fakeKino();
  const s = make({ kino: k });
  // What a load that Kino stopped at 20 s leaves behind: its mark, older than a call can live.
  k.storage.set("std:inflight", JSON.stringify({ tab: "inicio", at: Date.now() - 30_000 }));
  const r = await s.screenEvent({ name: "tick", state: { tab: "inicio", pending: ["inicio"] }, device: "phone" });
  assert.deepEqual(r.state.failed, { inicio: true });
  assert.deepEqual(r.state.pending, []);
  assert.equal(k.storage.get("std:inflight"), null, "the mark is cleared");
  const tree = await s.screen({ state: { tab: "inicio", failed: { inicio: true } }, device: "phone", installed });
  assert.ok(nodes(tree).some((n) => n.type === "MaterialBanner" && n.action && n.action.onTap === "retry"));
  // A load that finishes leaves no mark.
  const ok = await s.screenEvent({ name: "tick", state: { tab: "inicio", pending: ["inicio"] }, device: "phone" });
  assert.deepEqual(ok.state.failed, {});
  assert.equal(k.storage.get("std:inflight"), null);
});

test("std uses no timers: Kino has no setTimeout / setInterval / clearTimeout", () => {
  const dir = new URL("../src/std/", import.meta.url);
  for (const f of fs.readdirSync(dir)) {
    const src = fs.readFileSync(new URL(f, dir), "utf8").replace(/\/\/.*$/gm, "");
    assert.ok(!/\b(setTimeout|setInterval|clearTimeout|clearInterval)\s*\(/.test(src), f);
  }
});

test("a poster-only tab with many rails asks TMDB at most 24 titles per tick", async () => {
  const asked = [];
  const k = fakeKino();
  k.meta = async (q) => { asked.push(q); return null; };
  k.meta.byTitle = true;
  const rows = Array.from({ length: 8 }, (_, r) => ({ id: "r" + r, title: "R" + r, items: Array.from({ length: 15 }, (_, i) => posterOnly(r * 100 + i)) }));
  const s = make({ kino: k, loadTab: async () => ({ rows }) });
  const state = { tab: "inicio", pending: ["inicio"] };
  const r1 = await s.screenEvent({ name: "tick", state, device: "phone" });
  await s.screenEvent({ name: "tick", state: { ...state, ...r1.state }, device: "phone" });
  assert.ok(asked.length > 0 && asked.length <= 24, "asked " + asked.length);
});

test("with many tabs the kept copies share the room: each one stays small", async () => {
  const k = fakeKino();
  const tabs = Array.from({ length: 8 }, (_, i) => ({ id: "t" + i, label: "T" + i, labelEn: "T" + i }));
  const rows = Array.from({ length: 8 }, (_, r) => ({ id: "r" + r, title: "R" + r, items: Array.from({ length: 20 }, (_, i) => item(r * 100 + i)) }));
  const s = make({ kino: k, tabs, loadTab: async () => ({ rows }) });
  await s.screenEvent({ name: "tick", state: { tab: "t0", pending: ["t0"] }, device: "phone" });
  const kept = k.storage.get("browse1:t0");
  assert.ok(kept && kept.length <= 12 * 1024, "kept " + (kept && kept.length));
});

test("Retry loads the failed tab first and keeps the work already queued (other tabs' TMDB ticks)", async () => {
  const s = make({ tabs: [{ id: "a", label: "A", labelEn: "A" }, { id: "b", label: "B", labelEn: "B" }] });
  const r = await s.screenEvent({ name: "retry", state: { tab: "a", failed: { a: true }, pending: ["meta:b", "a"] } });
  assert.deepEqual(r.state.pending, ["a", "meta:b"]);
  assert.equal(r.state.failed, null);
});

// ---- std 1.7.0: the catalog door every plugin offers, and the search shown here (Da-Video) ----
import { catalogItems, CATALOG_PROVIDES } from "../src/std/catalog.js";

test("catalogItems: a plugin's search results as the catalog door's Item, at most 40", () => {
  const found = Array.from({ length: 45 }, (_, i) => item(i + 1, { year: 2001, ids: { tmdb: 77 } }));
  const out = catalogItems(found);
  assert.equal(out.length, 40);
  assert.deepEqual(out[0], { id: "i1", ref: "m:1", title: "Title 1", kind: "movie", poster: "https://img/p1.jpg", backdrop: "https://img/b1.jpg", year: "2001", overview: "Overview 1", tmdb: 77 });
  assert.deepEqual(catalogItems([{ id: "x", ref: "r", title: "T", kind: "series" }]), [{ id: "x", ref: "r", title: "T", kind: "series" }]);
  assert.deepEqual(catalogItems([{ id: "", ref: "r", title: "T", kind: "movie" }, null, { id: "y" }]), []);
  assert.deepEqual(Object.keys(CATALOG_PROVIDES.catalog.calls), ["search"]);
});

/** A Da-Video-like screen: its search is shown here, from several plugins answering one after another. */
function hereScreen(answers) {
  const asked = [];
  const s = make({
    needsResolver: false,
    searchHere: {
      sources: async () => [{ repo: "x/a", name: "A" }, { repo: "x/b", name: "B" }, { repo: "x/c", name: "C" }, { repo: "x/d", name: "D" }],
      searchIn: async (q, repos) => { asked.push([q, repos]); return repos.map((repo) => answers[repo]); },
    },
  });
  return { s, asked };
}

test("searchHere: the words open the results page here, not Kino's search", async () => {
  const { s } = hereScreen({});
  const r = await s.screenEvent({ name: "search", value: "dune", state: { searching: true } });
  assert.equal(r.go, undefined);
  assert.deepEqual(r.route, { push: "results" });
  assert.equal(r.state.rq, "dune");
  assert.deepEqual(r.state.rpending, ["x/a", "x/b", "x/c", "x/d"]);
  assert.equal(r.state.searching, false);
});

test("searchHere: plugins answer a few per tick; each answer is a rail whose cards open in that plugin", async () => {
  const { s, asked } = hereScreen({
    "x/a": { repo: "x/a", name: "A", ok: true, items: [{ id: "1", ref: "a:1", title: "Dune", kind: "movie", poster: "https://p/1.jpg" }] },
    "x/b": { repo: "x/b", name: "B", ok: false },
    "x/c": { repo: "x/c", name: "C", ok: true, items: [{ id: "1", ref: "c:1", title: "Dune", kind: "movie" }] },
    "x/d": { repo: "x/d", name: "D", ok: true, items: [] },
  });
  let state = { ...(await s.screenEvent({ name: "search", value: "dune", state: {} })).state };
  const route = { name: "results" };
  const first = await s.screenEvent({ name: "tick", state, route });
  state = { ...state, ...first.state };
  assert.deepEqual(asked[0], ["dune", ["x/a", "x/b", "x/c"]]);
  assert.deepEqual(state.rpending, ["x/d"]);
  let tree = await s.screen({ state, route, device: "phone", installed });
  let all = nodes(tree);
  const rails = all.filter((n) => n.type === "titleRail");
  assert.deepEqual(rails.map((r) => r.titleEn), ["In A", "In C"]);
  assert.equal(rails[0].items[0].origin, "x/a");
  assert.notEqual(rails[0].items[0].id, rails[1].items[0].id, "ids kept apart between plugins");
  assert.ok(all.some((n) => n.type === "Text" && /B/.test(n.textEn || "")), "a quiet line for the plugin that did not answer");
  assert.ok(all.some((n) => n.type === "Skeleton"), "skeletons while D still asks");
  assert.ok(tree.every, "the timer runs while plugins are pending");
  state = { ...state, ...(await s.screenEvent({ name: "tick", state, route })).state };
  tree = await s.screen({ state, route, device: "phone", installed });
  assert.equal(tree.every, undefined, "no timer once every plugin answered");
  assert.ok(!nodes(tree).some((n) => n.type === "Skeleton"));
});

test("searchHere: nothing found anywhere says so", async () => {
  const { s } = hereScreen({ "x/a": { repo: "x/a", name: "A", ok: true, items: [] }, "x/b": { repo: "x/b", name: "B", ok: true, items: [] },
    "x/c": { repo: "x/c", name: "C", ok: true, items: [] }, "x/d": { repo: "x/d", name: "D", ok: true, items: [] } });
  let state = { ...(await s.screenEvent({ name: "search", value: "zzz", state: {} })).state };
  const route = { name: "results" };
  for (let i = 0; i < 3 && state.rpending.length; i++) state = { ...state, ...(await s.screenEvent({ name: "tick", state, route })).state };
  const all = nodes(await s.screen({ state, route, device: "phone", installed }));
  assert.ok(all.some((n) => n.key === "noResults"));
});

test("page: a plugin's own body under the standard bar (Da-Video's list of plugins), its own events, no tab loading", async () => {
  let opened = 0;
  const s = make({
    needsResolver: false,
    page: {
      open: async () => { opened++; return { list: ["a", "b"] }; },
      view: ({ state }) => (state.list || []).map((x) => ({ type: "Text", key: "row-" + x, text: x, textEn: x })),
      events: { pick: async ({ arg }) => ({ go: { plugin: { repo: "x/" + arg } } }) },
    },
  });
  const o = await s.screenEvent({ name: "open", state: {}, device: "phone", route: { name: "main" } });
  assert.equal(opened, 1);
  assert.deepEqual(o.state.list, ["a", "b"]);
  assert.deepEqual(o.state.pending, []);
  const tree = await s.screen({ state: o.state, device: "phone", installed });
  const all = nodes(tree);
  assert.ok(all.some((n) => n.key === "row-a") && all.some((n) => n.key === "row-b"));
  assert.ok(!all.some((n) => n.type === "TabBar" || n.type === "Skeleton"));
  assert.deepEqual(tree.appBar.actions.map((a) => a.icon), ["search", "settings"]);
  assert.equal(tree.every, undefined);
  assert.deepEqual(await s.screenEvent({ name: "pick", arg: "hdfull", state: o.state }), { go: { plugin: { repo: "x/hdfull" } } });
  assert.equal(await s.screenEvent({ name: "unknownThing", state: {} }), null);
});

test("page.every: the page's own timer, only while it asks for one", async () => {
  const s = make({ needsResolver: false, page: { view: () => [], every: ({ state }) => (state.busy ? { ms: 3000, event: "refresh" } : null), events: { refresh: async () => ({ state: { busy: false } }) } } });
  assert.deepEqual((await s.screen({ state: { busy: true }, device: "phone", installed })).every, { ms: 3000, event: "refresh" });
  assert.equal((await s.screen({ state: {}, device: "phone", installed })).every, undefined);
});

test("catalogDoor: the plugin's own search with Kino's query shape, its answer cut to the door's Item", async () => {
  const { catalogDoor } = await import("../src/std/catalog.js");
  const asked = [];
  const door = catalogDoor(async (q) => { asked.push(q); return { items: [item(1)], cursor: "next" }; });
  assert.deepEqual(await door({ q: "  dune ", type: "series" }), [{ id: "i1", ref: "m:1", title: "Title 1", kind: "movie", poster: "https://img/p1.jpg", backdrop: "https://img/b1.jpg", overview: "Overview 1" }]);
  assert.equal(asked[0].q, "dune");
  assert.equal(asked[0].type, "series");
  assert.deepEqual(await door({ q: "" }), []);
  assert.equal(asked.length, 1);
});

test("std 1.7.1: the screen leaves with a back arrow by default (the X only with backArrow: false), and the gate too", async () => {
  const tree = await make().screen({ state: {}, device: "phone", installed });
  assert.equal(tree.appBar.leading.icon, "arrow_back");
  assert.deepEqual(tree.appBar.leading.onPressed, { go: { close: true } });
  const x = await make({ backArrow: false }).screen({ state: {}, device: "phone", installed });
  assert.equal(x.appBar.leading.icon, "close");
});

test("std 1.7.1: the search ops stay within Kino's 8 on a TV, the leading arrow hidden while the box is open", async () => {
  const tree = await make().screen({ state: {}, device: "tv", installed });
  const all = nodes(tree.appBar);
  const open = ops(all.find((n) => n.key === "searchButton").onPressed);
  const close = ops(all.find((n) => n.key === "closeSearch").onPressed);
  assert.ok(open.length <= 8 && close.length <= 8, `open ${open.length}, close ${close.length}`);
  assert.ok(open.includes("hide:close") && close.includes("show:close"));
});

// ---- Home snapshot (std 1.8.0) ----
import { snapshotRows, snapshotUrl, snapshotSource, SNAPSHOT_MAX_AGE_MS } from "../src/std/index.js";

const snapRow = { id: "s1", title: "Desde GitHub", items: [item(9)] };
const snapFile = (over = {}) => JSON.stringify({ v: 1, tab: "inicio", at: Date.now(), rows: [snapRow], ...over });

/** A kino whose fetch answers the snapshot url with [answer] (a string body, a status number, or a thrown error). */
function snapKino(answer, seen = []) {
  const k = fakeKino();
  k.fetch = async (url) => {
    seen.push(url);
    if (answer instanceof Error) throw answer;
    if (typeof answer === "number") return { ok: false, status: answer, text: async () => "" };
    return { ok: true, status: 200, text: async () => answer };
  };
  return k;
}

test("snapshot: the file's rows, only for its own tab, fresh and non-empty", () => {
  const now = Date.now();
  assert.deepEqual(snapshotRows(snapFile(), "inicio", now), [snapRow]);
  assert.equal(snapshotRows(snapFile(), "series", now), null, "another tab's file");
  assert.equal(snapshotRows(snapFile({ at: now - SNAPSHOT_MAX_AGE_MS - 1 }), "inicio", now), null, "older than 24 h");
  assert.equal(snapshotRows(snapFile({ rows: [] }), "inicio", now), null, "empty");
  assert.equal(snapshotRows(snapFile({ v: 2 }), "inicio", now), null, "unknown version");
  assert.equal(snapshotRows("<html>", "inicio", now), null, "not JSON");
  assert.equal(snapshotUrl("xuper-plugin/kino-plugin-serieskao", "inicio"), "https://raw.githubusercontent.com/xuper-plugin/kino-plugin-serieskao/main/home/inicio.json");
});

test("snapshot: the screen opens from the repository's file and never scrapes the site", async () => {
  let live = 0;
  const seen = [];
  const s = make({ kino: snapKino(snapFile(), seen), snapshot: "xuper-plugin/kino-plugin-serieskao", loadTab: async () => { live++; return { rows: [] }; } });
  await loaded(s);
  const tree = JSON.stringify(await s.screen({ state: await loaded(s), device: "phone", installed }));
  assert.equal(live, 0);
  assert.ok(seen[0].endsWith("/home/inicio.json"));
  assert.ok(tree.includes("Desde GitHub"));
});

test("snapshot: a missing, failed or stale file falls back to the live site", async () => {
  for (const answer of [404, new Error("offline"), snapFile({ at: Date.now() - SNAPSHOT_MAX_AGE_MS - 1 })]) {
    let live = 0;
    const s = make({ kino: snapKino(answer), snapshot: "xuper-plugin/kino-plugin-serieskao", loadTab: async () => { live++; return { rows: [{ id: "r1", title: "Estrenos", items: [item(1)] }] }; } });
    await loaded(s);
    assert.ok(live >= 1, `live after ${answer instanceof Error ? answer.message : typeof answer === "number" ? answer : "stale"}`);
  }
});

test("snapshot: without the option nothing is fetched, and the script finds the live tabs", async () => {
  const seen = [];
  const s = make({ kino: snapKino(snapFile(), seen) });
  await loaded(s);
  assert.equal(seen.length, 0);
  const src = snapshotSource();
  assert.ok(Array.isArray(src.tabs) && typeof src.loadTab === "function");
});

// ---- server order from the resolver (std 1.9.2) ----
import { rankServers, scoresFromResolver } from "../src/std/rank.js";

test("rankServers: by group (the person's language), then the resolver's score, then as they came; no scores = own order", async () => {
  const servers = [{ u: "voe", lang: 0 }, { u: "vidhide", lang: 0 }, { u: "uqload", lang: 1 }, { u: "mixdrop", lang: 0 }];
  const score = { voe: 72, vidhide: 95, uqload: 35, mixdrop: 85 };
  const kino = { plugins: { call: async (_a, call, arg) => (call === "rank" ? { scores: arg.urls.map((u) => score[u]) } : null) } };
  assert.deepEqual((await rankServers(kino, servers, (s) => s.u, (s) => s.lang)).map((s) => s.u), ["vidhide", "mixdrop", "voe", "uqload"]);
  const old = { plugins: { call: async () => { const e = new Error("x"); e.code = "not_declared"; throw e; } } };
  assert.deepEqual((await rankServers(old, servers, (s) => s.u, (s) => s.lang)).map((s) => s.u), ["voe", "vidhide", "mixdrop", "uqload"]);
  assert.equal(await scoresFromResolver(kino, []), null);
});

test("rankServers: netu/Waaw never offered (even without a resolver), and a server the resolver scores below 0 leaves too", async () => {
  const servers = [{ u: "https://waaw.to/f/x" }, { u: "netu" }, { u: "voe" }, { u: "gone" }];
  const kino = { plugins: { call: async (_a, call, arg) => ({ scores: arg.urls.map((u) => (u === "gone" ? -1 : 50)) }) } };
  assert.deepEqual((await rankServers(kino, servers, (s) => s.u)).map((s) => s.u), ["voe"]);
  const old = { plugins: { call: async () => { throw new Error("not_declared"); } } };
  assert.deepEqual((await rankServers(old, servers, (s) => s.u)).map((s) => s.u), ["voe", "gone"]);
});
