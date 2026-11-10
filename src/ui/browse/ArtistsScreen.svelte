<script lang="ts">
  import { getApp } from '../../lib/app.svelte';
  import PagedGrid from '../common/PagedGrid.svelte';
  import ScreenHeader from '../common/ScreenHeader.svelte';
  import Select from '../common/Select.svelte';
  import { loadViewPrefs, saveViewPrefs } from '../common/viewPrefs';
  import { plural } from '../common/format';
  import { Pager } from '../common/resource.svelte';
  import { getRouter } from '../shell/router.svelte';

  const app = getApp();
  const router = getRouter();
  const SORTS = [
    { id: 'name', label: 'Name', sortBy: 'SortName', descending: false },
    { id: 'added', label: 'Recently added', sortBy: 'DateCreated,SortName', descending: true },
    { id: 'random', label: 'Random', sortBy: 'Random', descending: false },
  ] as const;
  let sortId = $state<string>(loadViewPrefs('artists', SORTS.map((s) => s.id)).sort ?? 'name');
  let favoritesOnly = $state(false);

  const pager = $derived.by(() => {
    const sort = SORTS.find((s) => s.id === sortId) ?? SORTS[0];
    const favs = favoritesOnly;
    return new Pager(async (startIndex) => {
      const client = app.core.sessions.client;
      if (!client) throw new Error('Not signed in');
      return client.albumArtists({ sortBy: sort.sortBy, descending: sort.descending, favoritesOnly: favs, startIndex, limit: 60 });
    });
  });
</script>

<section class="screen">
  <ScreenHeader title="Artists" subtitle={pager.total > 0 ? plural(pager.total, 'artist') : undefined}>
    <Select
      label="Sort"
      options={SORTS}
      value={sortId}
      onchange={(id) => {
        sortId = id;
        saveViewPrefs('artists', { sort: id });
      }}
    />
    <button type="button" class="chip" class:on={favoritesOnly} aria-pressed={favoritesOnly} onclick={() => (favoritesOnly = !favoritesOnly)}>
      Favorites
    </button>
  </ScreenHeader>
  <PagedGrid {pager} onopen={(i) => router.open(i)} empty="No artists yet." />
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
