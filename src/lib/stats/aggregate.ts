// Listening statistics: pure aggregation over listen-log entries (no I/O, `now` injected).

import { parseBaseItem, itemDurationMs, type BaseItem } from '../jellyfin/models';
import { artistsOf } from '../recommend/taste';

/** One listen, compact because up to ~20k are persisted. */
export interface ListenEntry {
  /** Track id. */
  id: string;
  /** Track name. */
  n: string;
  /** Epoch ms when the listen ended. */
  at: number;
  /** Milliseconds actually listened. */
  ms: number;
  /** Credited artists as [id, name]. */
  ar: [string, string][];
  /** Album name, id and primary image tag. */
  al: string | null;
  ali: string | null;
  ti: string | null;
  /** Genre names. */
  g: string[];
  /** How many plays this entry stands for (server play counts); 1 for a real listen. */
  p?: number;
}

export type Period = '4w' | '6m' | 'all';
export const PERIODS: readonly { id: Period; label: string }[] = [
  { id: '4w', label: '4 weeks' },
  { id: '6m', label: '6 months' },
  { id: 'all', label: 'All time' },
];

const DAY = 86_400_000;
const PERIOD_MS: Record<Period, number> = { '4w': 28 * DAY, '6m': 183 * DAY, all: Infinity };

export interface Ranked {
  key: string;
  id: string;
  name: string;
  /** Artist of an album / track, track count of an artist, ... */
  subtitle: string;
  ms: number;
  plays: number;
  /** Stand-in item for cover art (null for genres). */
  item: BaseItem | null;
}

export interface Summary {
  totalMs: number;
  plays: number;
  activeDays: number;
  artists: Ranked[];
  albums: Ranked[];
  tracks: Ranked[];
  genres: Ranked[];
  /** Consecutive days with a listen, ending today or yesterday (0 when none); across all history. */
  streak: number;
  longestStreak: number;
  /** Local hour 0..23 with the most listening, null when nothing was listened. */
  busiestHour: number | null;
  /** Weekday 0 (Sunday)..6 with the most listening. */
  busiestDay: number | null;
  /** Listening ms per local hour / weekday. */
  hours: number[];
  weekdays: number[];
}

export const EMPTY_SUMMARY: Summary = {
  totalMs: 0, plays: 0, activeDays: 0, artists: [], albums: [], tracks: [], genres: [],
  streak: 0, longestStreak: 0, busiestHour: null, busiestDay: null,
  hours: new Array<number>(24).fill(0), weekdays: new Array<number>(7).fill(0),
};

export interface SummarizeOptions {
  period: Period;
  now: number;
  /** Minutes east of UTC; defaults to the device's offset. */
  tzOffsetMin?: number;
  /** Rows per ranking (default 10). */
  limit?: number;
}

/** Turns a track + the milliseconds listened into a log entry. */
export function toListenEntry(item: BaseItem, ms: number, at: number): ListenEntry {
  return {
    id: item.id,
    n: item.name,
    at,
    ms: Math.round(ms),
    ar: artistsOf(item).filter((a) => a.name.trim() !== '').map((a) => [a.id, a.name]),
    al: item.album,
    ali: item.albumId,
    ti: item.albumPrimaryImageTag,
    g: item.genres.map((g) => g.name).filter((g) => g.trim() !== ''),
  };
}

/** Play counts of the user's most played tracks as stand-in entries (when no local log exists). */
export function entriesFromServer(items: BaseItem[]): ListenEntry[] {
  return items
    .filter((t) => t.type === 'Audio' && t.id !== '' && t.playCount > 0)
    .map((t) => {
      const e = toListenEntry(t, t.playCount * (itemDurationMs(t) || 210_000), t.lastPlayed ? Date.parse(t.lastPlayed) : 0);
      return { ...e, p: t.playCount };
    });
}

const key = (s: string) => s.trim().toLowerCase();

function stub(type: string, id: string, name: string, extra: Record<string, unknown> = {}): BaseItem {
  return parseBaseItem({ Id: id, Name: name, Type: type, ...extra });
}

interface Acc {
  r: Ranked;
}

/** Consecutive-day streaks over distinct local day numbers. */
export function streaks(days: number[], today: number): { current: number; longest: number } {
  const sorted = [...new Set(days)].sort((a, b) => a - b);
  let longest = 0;
  let run = 0;
  let prev = -Infinity;
  for (const d of sorted) {
    run = d === prev + 1 ? run + 1 : 1;
    prev = d;
    longest = Math.max(longest, run);
  }
  const last = sorted[sorted.length - 1];
  const current = last !== undefined && (last === today || last === today - 1) ? run : 0;
  return { current, longest };
}

export function summarize(entries: readonly ListenEntry[], o: SummarizeOptions): Summary {
  if (entries.length === 0) return EMPTY_SUMMARY;
  const offMs = (o.tzOffsetMin ?? -new Date(o.now).getTimezoneOffset()) * 60_000;
  const limit = o.limit ?? 10;
  const since = o.now - PERIOD_MS[o.period];
  const dayOf = (t: number) => Math.floor((t + offMs) / DAY);

  const artists = new Map<string, Acc>();
  const albums = new Map<string, Acc>();
  const tracks = new Map<string, Acc>();
  const genres = new Map<string, Acc>();
  const hours = new Array<number>(24).fill(0);
  const weekdays = new Array<number>(7).fill(0);
  const days = new Set<number>();
  const periodDays = new Set<number>();
  let totalMs = 0;
  let plays = 0;

  const bump = (m: Map<string, Acc>, k: string, make: () => Ranked, ms: number, p: number) => {
    const a = m.get(k) ?? { r: make() };
    a.r.ms += ms;
    a.r.plays += p;
    m.set(k, a);
  };

  for (const e of entries) {
    if (e.at > 0) days.add(dayOf(e.at));
    if (e.at < since && o.period !== 'all') continue;
    const p = e.p ?? 1;
    totalMs += e.ms;
    plays += p;
    if (e.at > 0) {
      periodDays.add(dayOf(e.at));
      if (e.p === undefined) {
        const local = e.at + offMs;
        const h = Math.floor((((local % DAY) + DAY) % DAY) / 3_600_000);
        hours[h] = (hours[h] ?? 0) + e.ms;
        const wd = (((Math.floor(local / DAY) + 4) % 7) + 7) % 7; // 1970-01-01 was a Thursday
        weekdays[wd] = (weekdays[wd] ?? 0) + e.ms;
      }
    }
    const artistLine = e.ar.map((a) => a[1]).join(', ');
    bump(tracks, e.id, () => ({
      key: e.id, id: e.id, name: e.n, subtitle: artistLine, ms: 0, plays: 0,
      item: stub('Audio', e.id, e.n, { AlbumId: e.ali, AlbumPrimaryImageTag: e.ti, Album: e.al }),
    }), e.ms, p);
    if (e.ali || e.al) {
      const k = e.ali ?? key(e.al ?? '');
      bump(albums, k, () => ({
        key: k, id: e.ali ?? '', name: e.al ?? '', subtitle: e.ar[0]?.[1] ?? '', ms: 0, plays: 0,
        item: e.ali ? stub('MusicAlbum', e.ali, e.al ?? '', { ImageTags: e.ti ? { Primary: e.ti } : undefined }) : null,
      }), e.ms, p);
    }
    // Time is split between the credited artists so a duet is not counted twice.
    const share = e.ar.length > 0 ? e.ms / e.ar.length : 0;
    for (const [id, name] of e.ar) {
      const k = key(name);
      if (k === '') continue;
      bump(artists, k, () => ({
        key: k, id, name, subtitle: '', ms: 0, plays: 0, item: id ? stub('MusicArtist', id, name) : null,
      }), share, p);
    }
    const gshare = e.g.length > 0 ? e.ms / e.g.length : 0;
    for (const g of e.g) {
      const k = key(g);
      if (k === '') continue;
      bump(genres, k, () => ({ key: k, id: '', name: g.trim(), subtitle: '', ms: 0, plays: 0, item: null }), gshare, p);
    }
  }

  const rank = (m: Map<string, Acc>) =>
    [...m.values()]
      .map((a) => a.r)
      .sort((a, b) => b.ms - a.ms || b.plays - a.plays || a.name.localeCompare(b.name))
      .slice(0, limit);
  const argmax = (xs: number[]) => {
    const max = Math.max(...xs);
    return max > 0 ? xs.indexOf(max) : null;
  };
  const s = streaks([...days], dayOf(o.now));
  return {
    totalMs, plays, activeDays: periodDays.size,
    artists: rank(artists), albums: rank(albums), tracks: rank(tracks), genres: rank(genres),
    streak: s.current, longestStreak: s.longest,
    busiestHour: argmax(hours), busiestDay: argmax(weekdays), hours, weekdays,
  };
}
