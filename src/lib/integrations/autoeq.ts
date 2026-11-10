import type { EqBand, EqBandKind } from '../ipc';

export interface AutoEqProfile {
  preampDb: number;
  bands: EqBand[];
  /** Human-readable notes for lines that were ignored. */
  skipped: string[];
}

export class AutoEqFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AutoEqFormatError';
  }
}

const PREAMP = /^Preamp\s*:\s*([-+]?\d+(?:\.\d+)?)\s*dB/i;
const FILTER =
  /^Filter\s*\d*\s*:\s*(ON|OFF)\s+([A-Za-z]+)\s+Fc\s+([\d.]+)\s*Hz(?:\s+Gain\s+([-+]?\d+(?:\.\d+)?)\s*dB)?(?:\s+Q\s+([\d.]+))?/i;

function kindOf(type: string): EqBandKind | null {
  switch (type.toUpperCase()) {
    case 'PK':
    case 'PEQ':
    case 'PEAK':
      return 'peak';
    case 'LSC':
    case 'LS':
      return 'lowShelf';
    case 'HSC':
    case 'HS':
      return 'highShelf';
    default:
      return null;
  }
}

/** Parses AutoEQ / Equalizer APO parametric text (`Preamp: -6.2 dB`,
 *  `Filter 1: ON PK Fc 105 Hz Gain -3.1 dB Q 0.70`). OFF filters are skipped silently;
 *  malformed lines and unsupported types go to `skipped`. Throws AutoEqFormatError when
 *  no usable filter was found. */
export function parseAutoEq(text: string): AutoEqProfile {
  let preampDb = 0;
  const bands: EqBand[] = [];
  const skipped: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const p = PREAMP.exec(line);
    if (p) {
      preampDb = Number(p[1]);
      continue;
    }
    const m = FILTER.exec(line);
    if (!m) {
      skipped.push(`Ignored: ${line}`);
      continue;
    }
    if (m[1]!.toUpperCase() === 'OFF') continue;
    const kind = kindOf(m[2]!);
    if (!kind) {
      skipped.push(`Unsupported filter type ${m[2]!}: ${line}`);
      continue;
    }
    const freqHz = Number(m[3]);
    const gainDb = Number(m[4] ?? '0');
    const q = Number(m[5] ?? (kind === 'peak' ? '1.0' : '0.707'));
    if (![freqHz, gainDb, q].every(Number.isFinite) || freqHz <= 0 || q <= 0) {
      skipped.push(`Invalid numbers: ${line}`);
      continue;
    }
    bands.push({ kind, freqHz, gainDb, q });
  }
  if (bands.length === 0) throw new AutoEqFormatError('No enabled filters found');
  return { preampDb, bands, skipped };
}

// ------------------------------------------------------------ headphone index (AutoEq repo)

export const AUTOEQ_RAW_BASE = 'https://raw.githubusercontent.com/jaakkopasanen/AutoEq/master/results';
export const AUTOEQ_INDEX_URL = `${AUTOEQ_RAW_BASE}/INDEX.md`;

export interface AutoEqEntry {
  /** Display name, e.g. "Sennheiser HD 600". */
  name: string;
  /** Measurement source, e.g. "oratory1990". */
  source: string;
  /** Rig / form factor, e.g. "GRAS 43AG-7 over-ear"; '' when the index has none. */
  rig: string;
  /** Path under results/, decoded, e.g. "oratory1990/over-ear/Sennheiser HD 600". */
  path: string;
}

const INDEX_LINE = /^-\s+\[(.+?)\]\(\.\/(.+)\)\s+by\s+(.+?)(?:\s+on\s+(.+))?\s*$/;

/** Parses results/INDEX.md; unparseable lines are skipped. */
export function parseAutoEqIndex(text: string): AutoEqEntry[] {
  const out: AutoEqEntry[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const m = INDEX_LINE.exec(raw.trim());
    if (!m) continue;
    let path: string;
    try {
      path = decodeURIComponent(m[2]!);
    } catch {
      continue;
    }
    out.push({ name: m[1]!, path, source: m[3]!, rig: m[4] ?? '' });
  }
  return out;
}

/** Raw URL of the entry's ParametricEQ.txt. */
export function autoEqProfileUrl(entry: AutoEqEntry): string {
  const last = entry.path.split('/').pop() ?? entry.name;
  const encoded = entry.path.split('/').map(encodeURIComponent).join('/');
  return `${AUTOEQ_RAW_BASE}/${encoded}/${encodeURIComponent(`${last} ParametricEQ.txt`)}`;
}

/**
 * Ranks entries against a query: every whitespace-separated term must appear in name/source/
 * rig (case-insensitive). Exact name > name prefix > name word-prefix > name substring >
 * source/rig match; shorter names win ties. Empty query returns the first `limit` entries.
 */
export function searchAutoEq(entries: AutoEqEntry[], query: string, limit = 60): AutoEqEntry[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return entries.slice(0, limit);
  const whole = terms.join(' ');
  const scored: { e: AutoEqEntry; score: number }[] = [];
  for (const e of entries) {
    const name = e.name.toLowerCase();
    const rest = `${e.source} ${e.rig}`.toLowerCase();
    let score = 0;
    let ok = true;
    for (const t of terms) {
      if (name.includes(t)) score += name.startsWith(t) ? 30 : name.includes(` ${t}`) ? 20 : 10;
      else if (rest.includes(t)) score += 2;
      else {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    if (name === whole) score += 100;
    else if (name.startsWith(whole)) score += 50;
    scored.push({ e, score: score - name.length / 100 });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((s) => s.e);
}

const INDEX_KEY = 'autoeq.index.v1';
const INDEX_TTL_MS = 7 * 24 * 3600 * 1000;

interface KvLike {
  get(key: string): string | null;
  set(key: string, value: string | null): void;
}

/** Index from kv when fresh (<7 days), else fetched and cached. A stale cache is used when
 *  the fetch fails. Throws when nothing is available. */
export async function loadAutoEqIndex(
  fetchFn: (url: string) => Promise<Response>,
  kv: KvLike,
  now: () => number = Date.now,
): Promise<AutoEqEntry[]> {
  let cached: { at: number; entries: AutoEqEntry[] } | null = null;
  try {
    const raw = kv.get(INDEX_KEY);
    if (raw) cached = JSON.parse(raw) as { at: number; entries: AutoEqEntry[] };
  } catch {
    cached = null;
  }
  if (cached && now() - cached.at < INDEX_TTL_MS && cached.entries.length > 0) return cached.entries;
  try {
    const res = await fetchFn(AUTOEQ_INDEX_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const entries = parseAutoEqIndex(await res.text());
    if (entries.length === 0) throw new Error('Index is empty');
    kv.set(INDEX_KEY, JSON.stringify({ at: now(), entries }));
    return entries;
  } catch (e) {
    if (cached && cached.entries.length > 0) return cached.entries;
    throw e;
  }
}

/** Downloads and parses one entry's ParametricEQ.txt. */
export async function fetchAutoEqProfile(
  fetchFn: (url: string) => Promise<Response>,
  entry: AutoEqEntry,
): Promise<AutoEqProfile> {
  const res = await fetchFn(autoEqProfileUrl(entry));
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return parseAutoEq(await res.text());
}
