// Recent search terms, kept in localStorage (per device, most recent first).

const KEY = 'rayla.recentSearches';
const MAX = 8;

export function loadRecentSearches(): string[] {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((s): s is string => typeof s === 'string').slice(0, MAX);
  } catch {
    return [];
  }
}

function save(list: string[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    // Storage unavailable: recents are a convenience only.
  }
}

/** Records a term (trimmed, case-insensitive dedupe, newest first, max 8); returns the new list. */
export function recordSearch(term: string): string[] {
  const t = term.trim();
  if (t === '') return loadRecentSearches();
  const lower = t.toLowerCase();
  const list = [t, ...loadRecentSearches().filter((s) => s.toLowerCase() !== lower)].slice(0, MAX);
  save(list);
  return list;
}

export function clearRecentSearches(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // ignore
  }
}
