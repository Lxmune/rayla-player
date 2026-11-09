<script lang="ts">
  import { getApp } from '../../lib/app.svelte';
  import PagedGrid from '../common/PagedGrid.svelte';
  import ScreenHeader from '../common/ScreenHeader.svelte';
  import { Pager } from '../common/resource.svelte';
  import { getRouter } from '../shell/router.svelte';

  const SORTS = [
    { id: 'name', label: 'Name', sortBy: 'SortName', descending: false },
    { id: 'added', label: 'Recently added', sortBy: 'DateCreated,SortName', descending: true },
    { id: 'year-desc', label: 'Year (newest)', sortBy: 'ProductionYear,SortName', descending: true },
    { id: 'year-asc', label: 'Year (oldest)', sortBy: 'ProductionYear,SortName', descending: false },
  ] as const;

  const app = getApp();
  const router = getRouter();
  let sortId = $state<string>('name');
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
        favoritesOnly: favs,
        startIndex,
        limit: 60,
      });
    });
  });
</script>

<section class="screen">
  <ScreenHeader title="Albums">
    <label class="field">
      <span>Sort</span>
      <select bind:value={sortId}>
        {#each SORTS as s (s.id)}<option value={s.id}>{s.label}</option>{/each}
      </select>
    </label>
    <label class="field">
      <input type="checkbox" bind:checked={favoritesOnly} />
      <span>Favorites</span>
    </label>
  </ScreenHeader>
  <PagedGrid {pager} onopen={(i) => router.open(i)} empty="No albums found." />
</section>

<style>
  .field {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    font-size: var(--text-sm);
    color: var(--text-muted);
  }
  select {
    padding: var(--space-1) var(--space-2);
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
  }
</style>
