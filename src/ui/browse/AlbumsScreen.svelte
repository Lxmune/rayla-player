<script lang="ts">
  import { getApp } from '../../lib/app.svelte';
  import PagedGrid from '../common/PagedGrid.svelte';
  import ScreenHeader from '../common/ScreenHeader.svelte';
  import SegmentedControl from '../common/SegmentedControl.svelte';
  import Select from '../common/Select.svelte';
  import { plural } from '../common/format';
  import { Pager } from '../common/resource.svelte';
  import { loadViewPrefs, saveViewPrefs, type ViewMode } from '../common/viewPrefs';
  import { getRouter } from '../shell/router.svelte';

  const SORTS = [
    { id: 'name', label: 'Name', sortBy: 'SortName', descending: false, playedOnly: false },
    { id: 'artist', label: 'Artist', sortBy: 'AlbumArtist,SortName', descending: false, playedOnly: false },
    { id: 'added', label: 'Recently added', sortBy: 'DateCreated,SortName', descending: true, playedOnly: false },
    { id: 'year-desc', label: 'Year (newest)', sortBy: 'ProductionYear,SortName', descending: true, playedOnly: false },
    { id: 'year-asc', label: 'Year (oldest)', sortBy: 'ProductionYear,SortName', descending: false, playedOnly: false },
    { id: 'random', label: 'Random', sortBy: 'Random', descending: false, playedOnly: false },
    { id: 'played', label: 'Most played', sortBy: 'PlayCount,SortName', descending: true, playedOnly: true },
  ] as const;

  const app = getApp();
  const router = getRouter();
  const saved = loadViewPrefs('albums', SORTS.map((s) => s.id));
  let sortId = $state<string>(saved.sort ?? 'name');
  let view = $state<ViewMode>(saved.view ?? 'grid');
  let favoritesOnly = $state(false);

  const pager = $derived.by(() => {
    const sort = SORTS.find((s) => s.id === sortId) ?? SORTS[0];
    const favs = favoritesOnly;
    return new Pager(async (startIndex) => {
      const client = app.core.sessions.client;
      if (!client) throw new Error('Not signed in');
      return client.albums({
        sortBy: sort.sortBy,
        descending: sort.descending,
        playedOnly: sort.playedOnly,
        favoritesOnly: favs,
        startIndex,
        limit: 60,
      });
    });
  });
</script>

<section class="screen">
  <ScreenHeader title="Albums" subtitle={pager.total > 0 ? plural(pager.total, 'album') : undefined}>
    <Select
      label="Sort"
      options={SORTS}
      value={sortId}
      onchange={(id) => {
        sortId = id;
        saveViewPrefs('albums', { sort: id });
      }}
    />
    <button type="button" class="chip" class:on={favoritesOnly} aria-pressed={favoritesOnly} onclick={() => (favoritesOnly = !favoritesOnly)}>
      Favorites
    </button>
    <SegmentedControl
      label="View"
      options={[
        { id: 'grid', label: 'Grid view', icon: 'grid' },
        { id: 'list', label: 'List view', icon: 'list' },
      ]}
      value={view}
      onchange={(id) => {
        view = id === 'list' ? 'list' : 'grid';
        saveViewPrefs('albums', { view });
      }}
    />
  </ScreenHeader>
  <PagedGrid {pager} {view} onopen={(i) => router.open(i)} empty="No albums found." />
</section>

<style>
  .chip {
    height: 32px;
    padding: 0 var(--space-4);
    border: 1px solid var(--border);
    border-radius: var(--radius-full);
    background: var(--surface-2);
    color: var(--text-muted);
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
    cursor: pointer;
    transition:
      background var(--transition),
      color var(--transition),
      border-color var(--transition);
  }
  .chip:hover {
    border-color: var(--border-strong);
    color: var(--text);
  }
  .chip.on {
    background: var(--accent-soft);
    border-color: var(--accent);
    color: var(--accent);
  }
</style>
