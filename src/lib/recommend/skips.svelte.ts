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

export const MAX_DISLIKES = 2000;

export const skipsKey = (profileId: string) => `recommend.skips.${profileId}`;
export const dislikesKey = (profileId: string) => `recommend.dislikes.${profileId}`;

const validRecord = (r: unknown): r is SkipRecord =>
  typeof r === 'object' && r !== null && typeof (r as SkipRecord).id === 'string' &&
  typeof (r as SkipRecord).at === 'number' && Array.isArray((r as SkipRecord).artists) &&
  Array.isArray((r as SkipRecord).genres);

export interface SkipTrackerDeps {
  kv: KeyValueStore;
  profileId: () => string | null;
  /** Current queue order, to tell a forward skip from a jump. */
  queue: () => readonly QueueEntry[];
  clock?: () => number;
}

const key = (s: string) => s.trim().toLowerCase();

export function toSkipRecord(item: BaseItem, at: number): SkipRecord {
  // An artist item is its own artist (it has no credited artists).
  const artists = item.type === 'MusicArtist' ? [{ id: item.id, name: item.name }] : artistsOf(item);
  return {
    id: item.id,
    artists: artists.map((a) => key(a.name)).filter((k) => k !== ''),
    genres: item.genres.map((g) => key(g.name)).filter((k) => k !== ''),
    at,
    ...(item.type !== 'Audio' ? { kind: item.type } : {}),
  };
}

export class SkipTracker {
  private cur: { uid: number; item: BaseItem; posMs: number; durMs: number; ended: boolean } | null = null;
  private records: SkipRecord[] = [];
  private dislikes: SkipRecord[] = [];
  private loadedFor: string | null = null;
  /** Bumped on every change so reactive readers can depend on it. */
  version = $state(0);

  constructor(private readonly deps: SkipTrackerDeps) {}

  private now = () => (this.deps.clock ?? Date.now)();

  private load(): void {
    const id = this.deps.profileId();
    if (id === this.loadedFor) return;
    this.loadedFor = id;
    this.records = this.read(skipsKey, id);
    this.dislikes = this.read(dislikesKey, id);
  }

  private read(keyFn: (id: string) => string, id: string | null): SkipRecord[] {
    if (id === null) return [];
    try {
      const raw = this.deps.kv.get(keyFn(id));
      const parsed: unknown = raw === null ? [] : JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter(validRecord) : [];
    } catch {
      return [];
    }
  }

  private save(): void {
    if (this.loadedFor === null) return;
    try {
      this.deps.kv.set(skipsKey(this.loadedFor), JSON.stringify(this.records));
      this.deps.kv.set(dislikesKey(this.loadedFor), JSON.stringify(this.dislikes));
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

  /**
   * "Not interested": the item is never recommended again and its artists / genres count
   * for much less than after a skip. Works for tracks, albums and artists.
   */
  dislike(item: BaseItem): void {
    if (item.id === '') return;
    this.load();
    if (this.loadedFor === null) return;
    this.dislikes = this.dislikes.filter((r) => r.id !== item.id);
    this.dislikes.push(toSkipRecord(item, this.now()));
    if (this.dislikes.length > MAX_DISLIKES) this.dislikes.splice(0, this.dislikes.length - MAX_DISLIKES);
    this.save();
    this.version++;
  }

  /** Takes a dislike back (the "Undo" of the toast). */
  undislike(id: string): void {
    this.load();
    if (this.loadedFor === null || !this.dislikes.some((r) => r.id === id)) return;
    this.dislikes = this.dislikes.filter((r) => r.id !== id);
    this.save();
    this.version++;
  }

  isDisliked(id: string): boolean {
    void this.version;
    this.load();
    return this.dislikes.some((r) => r.id === id);
  }

  /** The skip profile of the active server profile (decayed at `now`). */
  profile(now = this.now()): SkipProfile {
    void this.version;
    this.load();
    return this.records.length === 0 && this.dislikes.length === 0
      ? NO_SKIPS
      : buildSkipProfile(this.records, now, this.dislikes);
  }
}
