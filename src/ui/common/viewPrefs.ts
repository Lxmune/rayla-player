// Tiny per-screen view preferences (sort order, grid / list), persisted in
// localStorage under 'rayla.view.<screen>'. Storage may be missing or full, and
// stored values may be stale, so everything is validated.

export type ViewMode = 'grid' | 'list';

export interface ViewPrefs {
  sort?: string;
  view?: ViewMode;
}

const key = (screen: string) => `rayla.view.${screen}`;

/** Reads the saved prefs; `sorts` lists the sort ids that are still valid. */
export function loadViewPrefs(screen: string, sorts?: readonly string[]): ViewPrefs {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(key(screen)) ?? 'null');
    if (typeof raw !== 'object' || raw === null) return {};
    const { sort, view } = raw as Record<string, unknown>;
    const out: ViewPrefs = {};
    if (typeof sort === 'string' && (!sorts || sorts.includes(sort))) out.sort = sort;
    if (view === 'grid' || view === 'list') out.view = view;
    return out;
  } catch {
    return {};
  }
}

/** Merges `patch` into the saved prefs. */
export function saveViewPrefs(screen: string, patch: ViewPrefs): void {
  try {
    localStorage.setItem(key(screen), JSON.stringify({ ...loadViewPrefs(screen), ...patch }));
  } catch {
    // Storage unavailable: the preference just lasts for this session.
  }
}
