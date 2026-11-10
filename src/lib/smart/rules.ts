// Smart playlist rules: pure predicates, sorting, summaries and built-in suggestions.

import { audioStream, firstMediaSource, itemDurationMs, type BaseItem } from '../jellyfin/models';

export type CompareOp = 'gte' | 'lte';
export type NameOp = 'is' | 'isNot';

export type Rule =
  | { field: 'genre'; op: NameOp; value: string }
  | { field: 'artist'; value: string }
  | { field: 'albumArtist'; value: string }
  | { field: 'year'; min: number | null; max: number | null }
  | { field: 'decade'; value: number }
  | { field: 'favourite'; value: boolean }
  | { field: 'playCount'; op: CompareOp; value: number }
  /** `within`: played in the last N days. `older`: not played for N days (never played counts). */
  | { field: 'lastPlayed'; op: 'within' | 'older'; days: number }
  | { field: 'neverPlayed' }
  | { field: 'added'; days: number }
  | { field: 'codec'; value: string }
  | { field: 'hiRes'; value: boolean }
  | { field: 'duration'; op: CompareOp; seconds: number };

export type RuleField = Rule['field'];
export type SortKey = 'random' | 'mostPlayed' | 'recentlyAdded' | 'recentlyPlayed' | 'title' | 'year';

export interface SmartPlaylist {
  id: string;
  name: string;
  mode: 'all' | 'any';
  rules: Rule[];
  sort: SortKey;
  /** null = no limit. */
  limit: number | null;
  createdAt: number;
}

export const SORT_OPTIONS: readonly { id: SortKey; label: string }[] = [
  { id: 'random', label: 'Random' },
  { id: 'mostPlayed', label: 'Most played' },
  { id: 'recentlyAdded', label: 'Recently added' },
  { id: 'recentlyPlayed', label: 'Recently played' },
  { id: 'title', label: 'Title' },
  { id: 'year', label: 'Year' },
];

export const LIMIT_OPTIONS: readonly { id: string; label: string; value: number | null }[] = [
  { id: '25', label: '25 tracks', value: 25 },
  { id: '50', label: '50 tracks', value: 50 },
  { id: '100', label: '100 tracks', value: 100 },
  { id: '250', label: '250 tracks', value: 250 },
  { id: 'all', label: 'All matching', value: null },
];

export const FIELD_OPTIONS: readonly { id: RuleField; label: string }[] = [
  { id: 'genre', label: 'Genre' },
  { id: 'artist', label: 'Artist' },
  { id: 'albumArtist', label: 'Album artist' },
  { id: 'year', label: 'Year between' },
  { id: 'decade', label: 'Decade' },
  { id: 'favourite', label: 'Favourite' },
  { id: 'playCount', label: 'Play count' },
  { id: 'lastPlayed', label: 'Last played' },
  { id: 'neverPlayed', label: 'Never played' },
  { id: 'added', label: 'Added within' },
  { id: 'codec', label: 'Format' },
  { id: 'hiRes', label: 'Hi-res' },
  { id: 'duration', label: 'Duration' },
];

const DAY = 86_400_000;

const LOSSLESS = new Set(['flac', 'alac', 'wav', 'wave', 'aiff', 'aif', 'ape', 'wv', 'wavpack', 'tta', 'dsf', 'dff', 'dsd']);

/** Default rule for a field (what the editor inserts when the field is picked). */
export function defaultRule(field: RuleField): Rule {
  switch (field) {
    case 'genre':
      return { field, op: 'is', value: '' };
    case 'artist':
    case 'albumArtist':
      return { field, value: '' };
    case 'year':
      return { field, min: 2000, max: null };
    case 'decade':
      return { field, value: 2010 };
    case 'favourite':
      return { field, value: true };
    case 'playCount':
      return { field, op: 'gte', value: 5 };
    case 'lastPlayed':
      return { field, op: 'older', days: 90 };
    case 'neverPlayed':
      return { field };
    case 'added':
      return { field, days: 30 };
    case 'codec':
      return { field, value: 'flac' };
    case 'hiRes':
      return { field, value: true };
    case 'duration':
      return { field, op: 'gte', seconds: 300 };
  }
}

/** Sample rate > 48 kHz or bit depth > 16, from the first audio stream. */
export function isHiRes(item: BaseItem): boolean {
  const s = audioStream(item);
  if (!s) return false;
  return (s.sampleRate ?? 0) > 48000 || (s.bitDepth ?? 0) > 16;
}

/** Lossless by codec / container name. */
export function isLossless(item: BaseItem): boolean {
  const codec = audioStream(item)?.codec?.toLowerCase() ?? '';
  const container = firstMediaSource(item)?.container?.toLowerCase() ?? '';
  return LOSSLESS.has(codec) || codec.startsWith('pcm') || (codec === '' && LOSSLESS.has(container));
}

const lc = (s: string) => s.trim().toLowerCase();

function matchesFormat(item: BaseItem, value: string): boolean {
  const v = lc(value);
  if (v === '') return true;
  const codec = audioStream(item)?.codec?.toLowerCase() ?? '';
  const container = firstMediaSource(item)?.container?.toLowerCase() ?? '';
  if (v === 'lossless') return isLossless(item);
  return codec === v || container === v;
}

/** Whether `item` satisfies one rule. `now` is epoch ms. */
export function matchesRule(item: BaseItem, rule: Rule, now: number): boolean {
  switch (rule.field) {
    case 'genre': {
      const v = lc(rule.value);
      // Track queries request Genres, so an empty list means the track has none.
      if (v === '') return true;
      const has = item.genres.some((g) => lc(g.name) === v);
      return rule.op === 'is' ? has : !has;
    }
    case 'artist': {
      const v = lc(rule.value);
      if (v === '') return true;
      return (
        item.artists.some((a) => lc(a) === v) ||
        item.artistItems.some((a) => lc(a.name) === v) ||
        lc(item.albumArtist ?? '') === v
      );
    }
    case 'albumArtist': {
      const v = lc(rule.value);
      if (v === '') return true;
      return lc(item.albumArtist ?? '') === v || item.albumArtists.some((a) => lc(a.name) === v);
    }
    case 'year': {
      const y = item.productionYear;
      if (y === null) return false;
      return (rule.min === null || y >= rule.min) && (rule.max === null || y <= rule.max);
    }
    case 'decade': {
      const y = item.productionYear;
      return y !== null && y >= rule.value && y < rule.value + 10;
    }
    case 'favourite':
      return item.isFavorite === rule.value;
    case 'playCount':
      return rule.op === 'gte' ? item.playCount >= rule.value : item.playCount <= rule.value;
    case 'lastPlayed': {
      const t = item.lastPlayed === null ? NaN : Date.parse(item.lastPlayed);
      const played = !Number.isNaN(t);
      const age = played ? now - t : Infinity;
      return rule.op === 'within' ? played && age <= rule.days * DAY : age > rule.days * DAY;
    }
    case 'neverPlayed':
      return item.playCount === 0 && item.lastPlayed === null;
    case 'added': {
      const t = item.dateCreated === null ? NaN : Date.parse(item.dateCreated);
      return !Number.isNaN(t) && now - t <= rule.days * DAY;
    }
    case 'codec':
      return matchesFormat(item, rule.value);
    case 'hiRes':
      return isHiRes(item) === rule.value;
    case 'duration': {
      const s = itemDurationMs(item) / 1000;
      return rule.op === 'gte' ? s >= rule.seconds : s <= rule.seconds;
    }
  }
}

/** All / any match; an empty rule list matches everything. */
export function matchesAll(item: BaseItem, rules: readonly Rule[], mode: 'all' | 'any', now: number): boolean {
  if (rules.length === 0) return true;
  return mode === 'all'
    ? rules.every((r) => matchesRule(item, r, now))
    : rules.some((r) => matchesRule(item, r, now));
}

const ts = (s: string | null): number => {
  const t = s === null ? NaN : Date.parse(s);
  return Number.isNaN(t) ? 0 : t;
};

/** Fisher-Yates on a copy. */
export function shuffled<T>(list: readonly T[], random: () => number = Math.random): T[] {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

/** Sorted copy; ties fall back to the title. */
export function sortItems(items: readonly BaseItem[], sort: SortKey, random: () => number = Math.random): BaseItem[] {
  if (sort === 'random') return shuffled(items, random);
  const byTitle = (a: BaseItem, b: BaseItem) => a.name.localeCompare(b.name);
  const cmp: Record<Exclude<SortKey, 'random'>, (a: BaseItem, b: BaseItem) => number> = {
    mostPlayed: (a, b) => b.playCount - a.playCount || byTitle(a, b),
    recentlyAdded: (a, b) => ts(b.dateCreated) - ts(a.dateCreated) || byTitle(a, b),
    recentlyPlayed: (a, b) => ts(b.lastPlayed) - ts(a.lastPlayed) || byTitle(a, b),
    title: byTitle,
    year: (a, b) => (b.productionYear ?? 0) - (a.productionYear ?? 0) || byTitle(a, b),
  };
  return [...items].sort(cmp[sort]);
}

/** Filter, sort and limit already-loaded tracks. */
export function applyPlaylist(
  items: readonly BaseItem[],
  p: Pick<SmartPlaylist, 'rules' | 'mode' | 'sort' | 'limit'>,
  now: number,
  random: () => number = Math.random,
): BaseItem[] {
  const hits = items.filter((i) => matchesAll(i, p.rules, p.mode, now));
  const sorted = sortItems(hits, p.sort, random);
  return p.limit === null ? sorted : sorted.slice(0, p.limit);
}

const days = (n: number) => (n % 365 === 0 && n >= 365 ? `${n / 365} y` : n % 30 === 0 && n >= 90 ? `${n / 30} months` : `${n} days`);
const dur = (s: number) => (s % 60 === 0 ? `${s / 60} min` : `${s} s`);

export function describeRule(r: Rule): string {
  switch (r.field) {
    case 'genre':
      return `Genre ${r.op === 'is' ? 'is' : 'is not'} ${r.value || '…'}`;
    case 'artist':
      return `Artist is ${r.value || '…'}`;
    case 'albumArtist':
      return `Album artist is ${r.value || '…'}`;
    case 'year':
      return r.min !== null && r.max !== null
        ? `Year ${r.min}–${r.max}`
        : r.min !== null
          ? `Year from ${r.min}`
          : r.max !== null
            ? `Year up to ${r.max}`
            : 'Any year';
    case 'decade':
      return `${r.value}s`;
    case 'favourite':
      return r.value ? 'Favourite' : 'Not a favourite';
    case 'playCount':
      return `Play count ${r.op === 'gte' ? '≥' : '≤'} ${r.value}`;
    case 'lastPlayed':
      return r.op === 'within' ? `Played in the last ${days(r.days)}` : `Not played in ${days(r.days)}`;
    case 'neverPlayed':
      return 'Never played';
    case 'added':
      return `Added in the last ${days(r.days)}`;
    case 'codec':
      return `Format ${r.value.toUpperCase() || '…'}`;
    case 'hiRes':
      return r.value ? 'Hi-res' : 'Not hi-res';
    case 'duration':
      return `Duration ${r.op === 'gte' ? '≥' : '≤'} ${dur(r.seconds)}`;
  }
}

export function describePlaylist(p: Pick<SmartPlaylist, 'rules' | 'mode' | 'sort' | 'limit'>): string {
  const rules = p.rules.length === 0 ? 'All tracks' : p.rules.map(describeRule).join(p.mode === 'all' ? ' · ' : ' or ');
  const sort = SORT_OPTIONS.find((s) => s.id === p.sort)?.label.toLowerCase() ?? p.sort;
  return `${rules} — ${sort}${p.limit === null ? '' : `, up to ${p.limit}`}`;
}

export interface Suggestion {
  id: string;
  name: string;
  playlist: Omit<SmartPlaylist, 'id' | 'createdAt'>;
}

export const SUGGESTIONS: readonly Suggestion[] = [
  {
    id: 'fav-stale',
    name: 'Favourites not played in 3 months',
    playlist: {
      name: 'Favourites not played in 3 months',
      mode: 'all',
      rules: [
        { field: 'favourite', value: true },
        { field: 'lastPlayed', op: 'older', days: 90 },
      ],
      sort: 'random',
      limit: 100,
    },
  },
  {
    id: 'hires',
    name: 'Hi-res only',
    playlist: { name: 'Hi-res only', mode: 'all', rules: [{ field: 'hiRes', value: true }], sort: 'random', limit: 100 },
  },
  {
    id: 'never',
    name: 'Never played',
    playlist: { name: 'Never played', mode: 'all', rules: [{ field: 'neverPlayed' }], sort: 'random', limit: 100 },
  },
  {
    id: 'most-this-year',
    name: 'Most played this year',
    playlist: {
      name: 'Most played this year',
      mode: 'all',
      rules: [
        { field: 'playCount', op: 'gte', value: 5 },
        { field: 'lastPlayed', op: 'within', days: 365 },
      ],
      sort: 'mostPlayed',
      limit: 100,
    },
  },
  {
    id: 'recent',
    name: 'Recently added',
    playlist: {
      name: 'Recently added',
      mode: 'all',
      rules: [{ field: 'added', days: 30 }],
      sort: 'recentlyAdded',
      limit: 100,
    },
  },
];
