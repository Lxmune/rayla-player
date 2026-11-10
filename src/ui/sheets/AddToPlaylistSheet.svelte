<script lang="ts">
  import { onMount } from 'svelte';
  import { getApp } from '../../lib/app.svelte';
  import type { BaseItem } from '../../lib/jellyfin/models';
  import Artwork from '../common/Artwork.svelte';
  import Icon from '../common/Icon.svelte';
  import Skeleton from '../common/Skeleton.svelte';
  import { plural } from '../common/format';
  import { useActions } from '../common/actions';
  import { Resource } from '../common/resource.svelte';

  let { tracks, onclose }: { tracks: BaseItem[]; onclose: () => void } = $props();

  const app = getApp();
  const actions = useActions();
  const playlists = new Resource<BaseItem[]>();
  let filter = $state('');
  let newName = $state('');
  let busy = $state(false);

  onMount(() => {
    const client = app.core.sessions.client;
    if (client) void playlists.load(async () => (await client.playlists({ limit: 500 })).items);
  });

  const shown = $derived(
    (playlists.data ?? []).filter((p) => p.name.toLowerCase().includes(filter.trim().toLowerCase())),
  );

  async function add(playlist: BaseItem) {
    if (busy) return;
    busy = true;
    await actions.addToPlaylist(playlist, tracks);
    busy = false;
    onclose();
  }

  async function create(e: SubmitEvent) {
    e.preventDefault();
    const name = newName.trim();
    if (name === '' || busy) return;
    busy = true;
    await actions.createPlaylist(name, tracks);
    busy = false;
    onclose();
  }
</script>

<div class="sheet">
  <p class="count">{plural(tracks.length, 'track')} to add</p>

  <form class="new" onsubmit={create}>
    <span class="plus"><Icon name="plus" size={18} /></span>
    <input type="text" placeholder="New playlist" aria-label="New playlist name" bind:value={newName} />
    <button type="submit" class="create" disabled={newName.trim() === '' || busy}>Create</button>
  </form>

  <input
    class="filter"
    type="search"
    placeholder="Filter playlists"
    aria-label="Filter playlists"
    bind:value={filter}
  />

  {#if playlists.error}
    <p class="error" role="alert">{playlists.error}</p>
  {:else if playlists.loading && !playlists.data}
    <div class="skeletons" aria-hidden="true">
      {#each { length: 4 } as _, i (i)}
        <div class="row-skel">
          <Skeleton width="40px" height="40px" />
          <Skeleton width="50%" height="14px" />
        </div>
      {/each}
    </div>
  {:else if shown.length === 0}
    <p class="muted">{(playlists.data ?? []).length === 0 ? 'No playlists yet.' : 'No matching playlists.'}</p>
  {:else}
    <ul>
      {#each shown as pl (pl.id)}
        <li>
          <button type="button" class="row" disabled={busy} onclick={() => void add(pl)}>
            <Artwork item={pl} size={40} />
            <span class="name">{pl.name}</span>
            {#if pl.childCount !== null}<span class="sub">{plural(pl.childCount, 'track')}</span>{/if}
          </button>
        </li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  .sheet {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    min-width: min(420px, 100%);
  }
  .count,
  .muted {
    margin: 0;
    color: var(--text-muted);
    font-size: var(--text-sm);
  }
  .error {
    margin: 0;
    color: var(--danger);
  }
  input {
    min-width: 0;
    padding: var(--space-2) var(--space-3);
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-full);
    color: var(--text);
    font: inherit;
    font-size: var(--text-md);
  }
  input:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }
  .new {
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }
  .new input {
    flex: 1;
  }
  .plus {
    display: grid;
    place-items: center;
    width: 40px;
    height: 40px;
    border-radius: var(--radius-sm);
    background: var(--accent-soft);
    color: var(--accent);
    flex: none;
  }
  .create {
    padding: var(--space-2) var(--space-4);
    border: 0;
    border-radius: var(--radius-full);
    background: var(--accent);
    color: var(--accent-contrast);
    font-size: var(--text-sm);
    cursor: pointer;
  }
  .create:disabled {
    opacity: 0.4;
    cursor: default;
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
    max-height: 320px;
    overflow-y: auto;
  }
  .row {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    width: 100%;
    padding: var(--space-2);
    border: 0;
    border-radius: var(--radius-md);
    background: transparent;
    color: inherit;
    text-align: left;
    cursor: pointer;
    transition: background var(--transition);
  }
  .row:hover:not(:disabled) {
    background: var(--hover);
  }
  .row:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: -2px;
  }
  .name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .sub {
    color: var(--text-muted);
    font-size: var(--text-sm);
  }
  .skeletons {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }
  .row-skel {
    display: flex;
    align-items: center;
    gap: var(--space-3);
  }
</style>
