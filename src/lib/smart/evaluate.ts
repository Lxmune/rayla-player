// Evaluates a smart playlist: pushes down what Jellyfin can filter, pages the candidates
// (capped), then applies every predicate locally.

import type { JellyfinClient, TracksQuery } from '../jellyfin/client';
import type { BaseItem } from '../jellyfin/models';
import { applyPlaylist, type Rule, type SmartPlaylist, type SortKey } from './rules';

export const CANDIDATE_CAP = 5000;
const PAGE = 500;

type ServerSort = { sortBy: string; descending: boolean };

const SERVER_SORT: Record<SortKey, ServerSort> = {
  random: { sortBy: 'Random', descending: false },
  mostPlayed: { sortBy: 'PlayCount,SortName', descending: true },
  recentlyAdded: { sortBy: 'DateCreated,SortName', descending: true },
  recentlyPlayed: { sortBy: 'DatePlayed,SortName', descending: true },
  title: { sortBy: 'SortName', descending: false },
  year: { sortBy: 'ProductionYear,SortName', descending: true },
};

export type PlaylistQuery = Pick<SmartPlaylist, 'rules' | 'mode' | 'sort'>;

/**
 * The server-side queries that cover every possible match. "All" mode pushes down one
 * genre and the favourites rule; "any" mode runs one query per genre rule (plus an open
 * query when there are non-genre rules) and unions them.
 */
export function planQueries(
  p: PlaylistQuery,
  genreId: (name: string) => string | null,
): Omit<TracksQuery, 'startIndex' | 'limit'>[] {
  const s = SERVER_SORT[p.sort];
  const base = { sortBy: s.sortBy, descending: s.descending };
  const positiveGenres = p.rules.filter(
    (r): r is Extract<Rule, { field: 'genre' }> => r.field === 'genre' && r.op === 'is' && r.value.trim() !== '',
  );
  if (p.mode === 'all') {
    const q: Omit<TracksQuery, 'startIndex' | 'limit'> = { ...base };
    const gid = positiveGenres.map((g) => genreId(g.value)).find((id) => id !== null);
    if (gid) q.genreId = gid;
    if (p.rules.some((r) => r.field === 'favourite' && r.value)) q.favoritesOnly = true;
    return [q];
  }
  const others = p.rules.some((r) => !(r.field === 'genre' && r.op === 'is' && genreId(r.value) !== null));
  const queries: Omit<TracksQuery, 'startIndex' | 'limit'>[] = [];
  for (const g of positiveGenres) {
    const id = genreId(g.value);
    if (id) queries.push({ ...base, genreId: id });
  }
  if (others || queries.length === 0) queries.push({ ...base });
  return queries;
}

export interface EvaluateOptions {
  client: Pick<JellyfinClient, 'tracks' | 'genres'>;
  genreIds?: ReadonlyMap<string, string>;
  now?: number;
  random?: () => number;
  cap?: number;
}

/** Looks up genre ids by lower-case name (loaded once per evaluation when missing). */
export async function loadGenreIds(client: Pick<JellyfinClient, 'genres'>): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  try {
    const page = await client.genres({ limit: 1000 });
    for (const g of page.items) out.set(g.name.trim().toLowerCase(), g.id);
  } catch {
    // genre push-down is an optimisation only
  }
  return out;
}

export async function evaluatePlaylist(p: SmartPlaylist, opts: EvaluateOptions): Promise<BaseItem[]> {
  const cap = opts.cap ?? CANDIDATE_CAP;
  const needsGenres = p.rules.some((r) => r.field === 'genre');
  const ids = opts.genreIds ?? (needsGenres ? await loadGenreIds(opts.client) : new Map<string, string>());
  const queries = planQueries(p, (n) => ids.get(n.trim().toLowerCase()) ?? null);
  const seen = new Map<string, BaseItem>();
  for (const q of queries) {
    let start = 0;
    while (seen.size < cap) {
      const page = await opts.client.tracks({ ...q, startIndex: start, limit: Math.min(PAGE, cap - start) });
      for (const it of page.items) if (!seen.has(it.id)) seen.set(it.id, it);
      start += page.items.length;
      if (page.items.length === 0 || start >= page.totalRecordCount || start >= cap) break;
    }
  }
  return applyPlaylist([...seen.values()], p, opts.now ?? Date.now(), opts.random);
}
