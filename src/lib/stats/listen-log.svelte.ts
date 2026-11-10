// Records what the user listens to, per profile, from player events: how long each track
// really played (seeks are ignored), persisted compactly in kv.

import type { BaseItem } from '../jellyfin/models';
import type { PlayerEvent } from '../player/controller.svelte';
import type { KeyValueStore } from '../platform';
import { toListenEntry, type ListenEntry } from './aggregate';

export const MAX_LISTENS = 20_000;
/** Listens shorter than this are accidental taps and not recorded. */
export const MIN_LISTEN_MS = 10_000;
/** Position jumps larger than this between two events are seeks, not playback (events come at ~5 Hz). */
export const MAX_STEP_MS = 3_000;
const SAVE_DELAY_MS = 5_000;

export const listensKey = (profileId: string) => `stats.listens.${profileId}`;

export interface ListenLogDeps {
  kv: KeyValueStore;
  profileId: () => string | null;
  clock?: () => number;
}

const valid = (e: unknown): e is ListenEntry =>
  typeof e === 'object' && e !== null && typeof (e as ListenEntry).id === 'string' &&
  typeof (e as ListenEntry).at === 'number' && typeof (e as ListenEntry).ms === 'number' &&
  Array.isArray((e as ListenEntry).ar) && Array.isArray((e as ListenEntry).g);

export class ListenLog {
  private cur: { uid: number; item: BaseItem; lastPos: number; playedMs: number } | null = null;
  private entries: ListenEntry[] = [];
  private loadedFor: string | null = null;
  private dirty = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** Bumped on every recorded listen so reactive readers can depend on it. */
  version = $state(0);

  constructor(private readonly deps: ListenLogDeps) {}

  private now = () => (this.deps.clock ?? Date.now)();

  private load(): void {
    const id = this.deps.profileId();
    if (id === this.loadedFor) return;
    this.flush(); // pending writes belong to the previous profile
    this.loadedFor = id;
    this.entries = [];
    this.cur = null;
    if (id === null) return;
    try {
      const raw = this.deps.kv.get(listensKey(id));
      const parsed: unknown = raw === null ? [] : JSON.parse(raw);
      if (Array.isArray(parsed)) this.entries = parsed.filter(valid);
    } catch {
      this.entries = [];
    }
  }

  /** Writes pending entries now (also called on dispose). */
  flush(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    if (!this.dirty || this.loadedFor === null) return;
    this.dirty = false;
    try {
      this.deps.kv.set(listensKey(this.loadedFor), JSON.stringify(this.entries));
    } catch {
      /* storage full or unavailable: keep in memory */
    }
  }

  /** Feed every player event. */
  observe(e: PlayerEvent): void {
    this.load();
    if (e.kind === 'position') {
      const c = this.cur;
      if (c && e.entry?.uid === c.uid) {
        const step = e.positionMs - c.lastPos;
        if (step > 0 && step <= MAX_STEP_MS) c.playedMs += step; // a seek is a jump, not listening
        c.lastPos = e.positionMs;
      }
      return;
    }
    if (e.kind === 'trackEnded') {
      if (this.cur && e.entry?.uid === this.cur.uid) this.commit();
      return;
    }
    if (e.kind === 'stateChanged' && e.state === 'stopped') {
      this.commit();
      return;
    }
    if (e.kind !== 'trackStarted' || !e.entry || !e.item) return;
    if (this.cur && this.cur.uid === e.entry.uid) return; // duplicate event for the same entry
    this.commit();
    this.cur = { uid: e.entry.uid, item: e.item, lastPos: e.positionMs, playedMs: 0 };
  }

  private commit(): void {
    const c = this.cur;
    this.cur = null;
    if (!c || c.item.id === '' || this.loadedFor === null || c.playedMs < MIN_LISTEN_MS) return;
    this.entries.push(toListenEntry(c.item, c.playedMs, this.now()));
    if (this.entries.length > MAX_LISTENS) this.entries.splice(0, this.entries.length - MAX_LISTENS);
    this.dirty = true;
    this.version++;
    if (this.timer === null) this.timer = setTimeout(() => this.flush(), SAVE_DELAY_MS);
  }

  /** All recorded listens of the active profile, oldest first. */
  all(): readonly ListenEntry[] {
    void this.version;
    this.load();
    return this.entries;
  }

  get size(): number {
    return this.all().length;
  }
}
