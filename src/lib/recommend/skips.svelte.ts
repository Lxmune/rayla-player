// Learns from skips: listens to player events, stores forward skips per profile.

import type { BaseItem } from '../jellyfin/models';
import type { PlayerEvent, QueueEntry } from '../player/controller.svelte';
import type { KeyValueStore } from '../platform';
import { artistsOf } from './taste';
import { buildSkipProfile, NO_SKIPS, type SkipProfile, type SkipRecord } from './skip-profile';

export const MAX_SKIPS = 500;
/** A skip is leaving before this much play: min(30 s, 40 % of the duration). */
export const SKIP_MAX_MS = 30_000;
export const SKIP_MAX_SHARE = 0.4;

export const skipsKey = (profileId: string) => `recommend.skips.${profileId}`;

export interface SkipTrackerDeps {
  kv: KeyValueStore;
  profileId: () => string | null;
  /** Current queue order, to tell a forward skip from a jump. */
  queue: () => readonly QueueEntry[];
  clock?: () => number;
}

const key = (s: string) => s.trim().toLowerCase();

export function toSkipRecord(item: BaseItem, at: number): SkipRecord {
  return {
    id: item.id,
    artists: artistsOf(item).map((a) => key(a.name)).filter((k) => k !== ''),
    genres: item.genres.map((g) => key(g.name)).filter((k) => k !== ''),
    at,
  };
}

export class SkipTracker {
  private cur: { uid: number; item: BaseItem; posMs: number; durMs: number; ended: boolean } | null = null;
  private records: SkipRecord[] = [];
  private loadedFor: string | null = null;
  /** Bumped on every change so reactive readers can depend on it. */
  version = $state(0);

  constructor(private readonly deps: SkipTrackerDeps) {}

  private now = () => (this.deps.clock ?? Date.now)();

  private load(): void {
    const id = this.deps.profileId();
    if (id === this.loadedFor) return;
    this.loadedFor = id;
    this.records = [];
    if (id === null) return;
    try {
      const raw = this.deps.kv.get(skipsKey(id));
      const parsed: unknown = raw === null ? [] : JSON.parse(raw);
      if (Array.isArray(parsed)) {
        this.records = parsed.filter(
          (r): r is SkipRecord =>
            typeof r === 'object' && r !== null && typeof r.id === 'string' && typeof r.at === 'number' &&
            Array.isArray(r.artists) && Array.isArray(r.genres),
        );
      }
    } catch {
      this.records = [];
    }
  }

  private save(): void {
    if (this.loadedFor === null) return;
    try {
      this.deps.kv.set(skipsKey(this.loadedFor), JSON.stringify(this.records));
    } catch {
      /* storage unavailable: keep in memory */
    }
  }

  /** Feed every player event. */
  observe(e: PlayerEvent): void {
    if (e.kind === 'position') {
      if (this.cur && e.entry?.uid === this.cur.uid) {
        this.cur.posMs = e.positionMs;
        if (e.durationMs > 0) this.cur.durMs = e.durationMs;
      }
      return;
    }
    if (e.kind === 'trackEnded') {
      if (this.cur && e.entry?.uid === this.cur.uid) this.cur.ended = true;
      return;
    }
    if (e.kind === 'stateChanged' && e.state === 'stopped') {
      this.cur = null; // stop / clear: never a skip
      return;
    }
    if (e.kind !== 'trackStarted' || !e.entry || !e.item) return;
    const prev = this.cur;
    if (prev && prev.uid !== e.entry.uid && !prev.ended && this.isForwardSkip(prev, e.entry)) {
      this.record(prev.item);
    }
    if (!prev || prev.uid !== e.entry.uid) {
      this.cur = { uid: e.entry.uid, item: e.item, posMs: 0, durMs: e.durationMs, ended: false };
    }
  }

  private isForwardSkip(prev: NonNullable<SkipTracker['cur']>, next: QueueEntry): boolean {
    const limit = prev.durMs > 0 ? Math.min(SKIP_MAX_MS, SKIP_MAX_SHARE * prev.durMs) : SKIP_MAX_MS;
    if (prev.posMs >= limit) return false; // listened enough (or sought to the end)
    const q = this.deps.queue();
    const i = q.findIndex((x) => x.uid === prev.uid);
    return i >= 0 && q[i + 1]?.uid === next.uid;
  }

  private record(item: BaseItem): void {
    if (item.id === '') return;
    this.load();
    if (this.loadedFor === null) return;
    this.records.push(toSkipRecord(item, this.now()));
    if (this.records.length > MAX_SKIPS) this.records.splice(0, this.records.length - MAX_SKIPS);
    this.save();
    this.version++;
  }

  /** The skip profile of the active server profile (decayed at `now`). */
  profile(now = this.now()): SkipProfile {
    void this.version;
    this.load();
    return this.records.length === 0 ? NO_SKIPS : buildSkipProfile(this.records, now);
  }
}
