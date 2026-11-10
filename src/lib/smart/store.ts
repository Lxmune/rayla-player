// Smart playlists persisted in kv, per profile.

import type { KeyValueStore } from '../platform';
import { defaultRule, FIELD_OPTIONS, SORT_OPTIONS, type Rule, type SmartPlaylist, type SortKey } from './rules';

export const smartKey = (profileId: string): string => `smart.playlists.${profileId}`;

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Repairs a stored rule against the field's default shape; null when unusable. */
export function parseRule(v: unknown): Rule | null {
  if (!isObj(v) || !FIELD_OPTIONS.some((f) => f.id === v.field)) return null;
  const base = defaultRule(v.field as Rule['field']);
  const out: Record<string, unknown> = { ...base };
  for (const k of Object.keys(base)) {
    const incoming = v[k];
    const expected = (base as Record<string, unknown>)[k];
    if (typeof incoming === typeof expected) out[k] = incoming;
    else if (expected === null || incoming === null) out[k] = isNum(incoming) ? incoming : null;
  }
  return out as unknown as Rule;
}

export function parsePlaylists(raw: string | null): SmartPlaylist[] {
  if (!raw) return [];
  try {
    const j: unknown = JSON.parse(raw);
    if (!Array.isArray(j)) return [];
    const out: SmartPlaylist[] = [];
    for (const e of j) {
      if (!isObj(e) || typeof e.id !== 'string' || typeof e.name !== 'string') continue;
      const sort = SORT_OPTIONS.some((s) => s.id === e.sort) ? (e.sort as SortKey) : 'random';
      out.push({
        id: e.id,
        name: e.name,
        mode: e.mode === 'any' ? 'any' : 'all',
        rules: Array.isArray(e.rules) ? e.rules.map(parseRule).filter((r): r is Rule => r !== null) : [],
        sort,
        limit: isNum(e.limit) && e.limit > 0 ? Math.floor(e.limit) : null,
        createdAt: isNum(e.createdAt) ? e.createdAt : 0,
      });
    }
    return out;
  } catch {
    return [];
  }
}

export function loadPlaylists(kv: KeyValueStore, profileId: string): SmartPlaylist[] {
  try {
    return parsePlaylists(kv.get(smartKey(profileId)));
  } catch {
    return [];
  }
}

export function savePlaylists(kv: KeyValueStore, profileId: string, list: readonly SmartPlaylist[]): void {
  try {
    kv.set(smartKey(profileId), list.length === 0 ? null : JSON.stringify(list));
  } catch {
    // storage unavailable: smart playlists are session-only then
  }
}

/** Insert or replace by id; returns the new list. */
export function upsertPlaylist(list: readonly SmartPlaylist[], p: SmartPlaylist): SmartPlaylist[] {
  return list.some((x) => x.id === p.id) ? list.map((x) => (x.id === p.id ? p : x)) : [...list, p];
}

export const newPlaylistId = (now = Date.now()): string => `sp-${now.toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
