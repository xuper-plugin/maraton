// The music queue (apiVersion 32, capability "queue", contract.kinoQueue): the kit's mirror of the app's MusicQueueState
// (playback/MusicQueue.kt) and PluginQueueBridge's rules (data/plugin/PluginQueue.kt). The rule table both run is
// test/queue-cases.json. Pure: no Node API, no clock, so the kit's shim, its tests and a plugin's own tests share it.
import { contract } from "./contract.mjs";

const Q = () => contract.kinoQueue;

/** A refusal the way the bridge makes one: a code from contract.kinoQueue.errorCodes and the app's message. */
export class QueueRefused extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

/**
 * A fresh queueId: "q" + a counter shared by every queue of the process (MusicQueue.nextQueueId), so an id of an earlier
 * queue never names an entry of a later one.
 */
let ids = 0;
const nextQueueId = () => `q${++ids}`;

/** One slot of the queue: its track, Kino's own `queueId` and whether it is an album's library row (the caps never count those). */
function entryOf(queueId, track, fromLibrary) { return { queueId, track, fromLibrary }; }

/** One entry as the plugin sees it (MusicQueueState.entryJson): `queueId`, `ref`, `title`, and the optional fields that are set. */
export function entryJson(e) {
  const t = e.track;
  const o = { queueId: e.queueId, ref: t.ref, title: t.title ?? "" };
  if (t.artist) o.artist = t.artist;
  if (t.still) o.still = t.still;
  if (t.runtimeMinutes > 0) o.runtimeMinutes = t.runtimeMinutes;
  if (t.ids) o.ids = t.ids;
  return o;
}

/** One plugin's queue: the current track, what plays upcoming and what played (history, oldest first). */
export class MusicQueueState {
  #cur;
  #up;
  #hist;
  #asking = false;
  #strikes = 0;
  /** True while a screen or the player has taken over the choice of what plays next: [wantsUpNext] is then false. */
  suppressed = false;

  constructor(current, upcoming, history) {
    this.#cur = current;
    this.#up = upcoming;
    this.#hist = history;
  }

  /**
   * An album playing: its tracks `before` the `playing` one are history, the ones `after` are upcoming, in order. Every entry gets
   * a fresh queueId (never reused, not even by a later queue). Library rows are all kept, whatever the album's length; entries that are not
   * are capped like the plugin's own tracks: the first maxUpcoming of `after`, the last maxHistory of `before`.
   * Each argument entry is `{ track, fromLibrary }`.
   */
  static seed(playing, before, after) {
    const id = (e) => entryOf(nextQueueId(), e.track, e.fromLibrary);
    const capped = (entries, max) => { let plugin = 0; return entries.filter((e) => e.fromLibrary || ++plugin <= max); };
    const h = capped([...before].reverse(), Q().maxHistory).reverse().map(id);
    const c = id(playing);
    const u = capped(after, Q().maxUpcoming).map(id);
    return new MusicQueueState(c, u, h);
  }

  get current() { return this.#cur; }
  get upcoming() { return [...this.#up]; }
  get history() { return [...this.#hist]; }

  #fresh() { return nextQueueId(); }
  #pluginUpcoming() { return this.#up.filter((e) => !e.fromLibrary).length; }

  #pushHistory(e) {
    this.#hist.push(e);
    let extra = this.#hist.filter((x) => !x.fromLibrary).length - Q().maxHistory;
    for (let i = 0; extra > 0 && i < this.#hist.length;) {
      if (!this.#hist[i].fromLibrary) { this.#hist.splice(i, 1); extra--; } else i++;
    }
  }

  /** The player moves on: the first upcoming becomes current. Null (nothing changes) at the end. */
  next() {
    if (!this.#up.length) return null;
    this.#pushHistory(this.#cur);
    this.#cur = this.#up.shift();
    return this.#cur;
  }

  /** The last played track becomes current again and the current one goes back to the front of upcoming. Null without history. */
  previous() {
    if (!this.#hist.length) return null;
    this.#up.unshift(this.#cur);
    this.#cur = this.#hist.pop();
    return this.#cur;
  }

  /** Adds tracks (already parsed: `{ ref, title, ... }`); throws too_many past the caps, adding nothing. Returns the new entries. */
  add(tracks, position) {
    if (tracks.length > Q().maxPerCall) throw new QueueRefused("too_many", `at most ${Q().maxPerCall} tracks in one call`);
    if (this.#pluginUpcoming() + tracks.length > Q().maxUpcoming) throw new QueueRefused("too_many", `the queue holds at most ${Q().maxUpcoming} upcoming tracks`);
    const entries = tracks.map((t) => entryOf(this.#fresh(), t, false));
    if (position === "next") this.#up.unshift(...entries); else this.#up.push(...entries);
    return entries;
  }

  remove(queueId) {
    if (this.#cur.queueId === queueId) throw new QueueRefused("invalid_request", "the track playing can't be removed");
    const i = this.#up.findIndex((e) => e.queueId === queueId);
    if (i >= 0) this.#up.splice(i, 1);
    else {
      const h = this.#hist.findIndex((e) => e.queueId === queueId);
      if (h < 0) throw new QueueRefused("not_found", "track not found in the queue");
      this.#hist.splice(h, 1);
    }
  }

  /** `toIndex` within upcoming (0 plays next), clamped. Only upcoming entries move. */
  move(queueId, toIndex) {
    const i = this.#up.findIndex((e) => e.queueId === queueId);
    if (i < 0) {
      if (this.#cur.queueId === queueId || this.#hist.some((e) => e.queueId === queueId)) throw new QueueRefused("invalid_request", "only an upcoming track can move");
      throw new QueueRefused("not_found", "track not found in the queue");
    }
    const [e] = this.#up.splice(i, 1);
    this.#up.splice(Math.min(Math.max(toIndex, 0), this.#up.length), 0, e);
  }

  /** Makes `queueId` the current track; the new current, or null when unknown. */
  playAt(queueId) {
    if (this.#cur.queueId === queueId) return this.#cur;
    const e = [...this.#up, ...this.#hist].find((x) => x.queueId === queueId);
    if (!e) return null;
    const ui = this.#up.indexOf(e);
    if (ui >= 0) {
      // Forward: what is before it is history as if skipped.
      this.#pushHistory(this.#cur);
      for (let i = 0; i < ui; i++) this.#pushHistory(this.#up.shift());
      this.#cur = this.#up.shift();
    } else {
      // Back: the history after it and the current return to the front of upcoming.
      const hi = this.#hist.indexOf(e);
      const after = this.#hist.slice(hi + 1);
      this.#hist.length = hi;
      this.#up.unshift(this.#cur);
      this.#up.unshift(...after);
      this.#cur = e;
    }
    return this.#cur;
  }

  clear() { this.#up.length = 0; }

  /** An ask for what plays after the queue is on its way: [wantsUpNext] stays false until [appendUpNext] or [upNextFailed]. */
  markAsking() { this.#asking = true; }

  /** The plugin's answer to that ask: at most maxPerCall of it, while upcoming has room. Empty is a strike; a non-empty answer resets them. */
  appendUpNext(tracks) {
    this.#asking = false;
    if (!tracks.length) { this.#strikes++; return []; }
    this.#strikes = 0;
    const room = Math.max(Q().maxUpcoming - this.#pluginUpcoming(), 0);
    const entries = tracks.slice(0, Math.min(room, Q().maxPerCall)).map((t) => entryOf(this.#fresh(), t, false));
    this.#up.push(...entries);
    return entries;
  }

  upNextFailed() { this.#asking = false; this.#strikes++; }

  wantsUpNext() { return !this.#up.length && !this.#asking && this.#strikes < Q().maxEmptyUpNext && !this.suppressed; }

  /**
   * What the plugin reads (list(), a write's answer, upNext's queue): a window around the current track, the next listUpcoming
   * and the last listHistory played (oldest first), with the totals (MusicQueueState.toJson).
   */
  toJson() {
    return {
      current: entryJson(this.#cur),
      upcoming: this.#up.slice(0, Q().listUpcoming).map(entryJson),
      history: this.#hist.slice(Math.max(0, this.#hist.length - Q().listHistory)).map(entryJson),
      upcomingTotal: this.#up.length,
      historyTotal: this.#hist.length,
    };
  }
}
