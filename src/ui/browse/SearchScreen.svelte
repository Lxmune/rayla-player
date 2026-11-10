<script lang="ts">
  import { untrack } from 'svelte';
  import { getApp } from '../../lib/app.svelte';
  import { describeError } from '../../lib/jellyfin/client';
  import type { BaseItem, SearchResults } from '../../lib/jellyfin/models';
  import Artwork from '../common/Artwork.svelte';
  import Card from '../common/Card.svelte';
  import Grid from '../common/Grid.svelte';
  import Icon from '../common/Icon.svelte';
  import Shelf from '../common/Shelf.svelte';
  import Skeleton from '../common/Skeleton.svelte';
  import TrackList from '../common/TrackList.svelte';
  import { nameGradient } from '../common/format';
  import { useActions } from '../common/actions';
  import { useItemMenu } from '../common/item-menu';
  import { Resource } from '../common/resource.svelte';
  import { getRouter, getUi } from '../shell/router.svelte';
  import { clearRecentSearches, loadRecentSearches, recordSearch } from './recent-searches';

  const app = getApp();
  const router = getRouter();
  const ui = getUi();
  const act = useActions();
  const menuFor = useItemMenu();

  let results = $state.raw<SearchResults | null>(null);
  let searching = $state(false);
  let error = $state<string | null>(null);
  let seq = 0;
  let recents = $state(loadRecentSearches());
  let filter = $state<'all' | 'artists' | 'albums' | 'tracks'>('all');
  const genres = new Resource<BaseItem[]>();

  const term = $derived(ui.searchTerm.trim());

  // Debounced search; an older response never overwrites a newer one.
  $effect(() => {
    const q = term;
    const client = app.core.sessions.client;
    if (q === '' || !client) {
      results = null;
      error = null;
      searching = false;
      return;
    }
    const id = ++seq;
    searching = true;
    const timer = setTimeout(async () => {
      try {
        const r = await client.search(q);
        if (id === seq) {
          results = r;
          error = null;
        }
      } catch (e) {
        if (id === seq) error = describeError(e);
      } finally {
        if (id === seq) searching = false;
      }
    }, 300);
    return () => clearTimeout(timer);
  });

  $effect(() => {
    const client = app.core.sessions.client;
    if (client) untrack(() => void genres.load(async () => (await client.genres({ limit: 12 })).items));
  });

  const record = () => (recents = recordSearch(term));
  function open(item: BaseItem) {
    record();
    router.open(item);
  }
  function playTracks(list: BaseItem[], i: number) {
    record();
    void act.playTracks(list, i);
  }
  function clearRecents() {
    clearRecentSearches();
    recents = [];
  }

  const empty = $derived(
    results !== null && results.artists.length + results.albums.length + results.tracks.length === 0,
  );

  /** Best match: an exact / prefix name match, else the first artist, else the first album. */
  const top = $derived.by(() => {
    if (!results) return null;
    const q = term.toLowerCase();
    const named = [...results.artists, ...results.albums];
    return (
      named.find((i) => i.name.toLowerCase() === q) ??
      named.find((i) => i.name.toLowerCase().startsWith(q)) ??
      results.artists[0] ??
      results.albums[0] ??
      null
    );
  });
  const topTracks = $derived(results?.tracks.slice(0, 4) ?? []);
  const sub = (i: BaseItem) => (i.type === 'MusicArtist' ? 'Artist' : 'Album');
</script>

<section class="screen">
  <h1 class="sr-only">Search</h1>
  <div class="field">
    <Icon name="search" size={20} />
    <input
      class="input"
      type="search"
      placeholder="Artists, albums, tracks"
      aria-label="Search the library"
      bind:value={ui.searchTerm}
      onkeydown={(e) => e.key === 'Enter' && term !== '' && record()}
    />
  </div>

  {#if term === ''}
    {#if recents.length > 0}
      <div class="recent-head">
        <h2>Recent searches</h2>
        <button type="button" class="text-btn" onclick={clearRecents}>Clear</button>
      </div>
      <ul class="recents">
        {#each recents as r (r)}
          <li><button type="button" class="chip" onclick={() => (ui.searchTerm = r)}>{r}</button></li>
        {/each}
      </ul>
    {/if}
    {#if (genres.data ?? []).length > 0}
      <h2>Browse genres</h2>
      <div class="genres">
        {#each genres.data ?? [] as g (g.id)}
          <button
            type="button"
            class="genre"
            style:background={nameGradient(g.name)}
            onclick={() => router.open(g)}
            oncontextmenu={(e) => ui.openMenu(e, menuFor(g))}
          >
            {g.name}
          </button>
        {/each}
      </div>
    {/if}
  {:else if error}
    <p class="error" role="alert">{error}</p>
  {:else if searching && results === null}
    <div class="skeleton-grid" aria-hidden="true">
      <Skeleton height="200px" radius="var(--radius-lg)" />
      <Skeleton height="200px" radius="var(--radius-lg)" />
    </div>
  {:else if empty}
    <p class="muted">No results.</p>
  {:else if results}
    <div class="chips" role="group" aria-label="Filter results">
      {#each [['all', 'All'], ['artists', 'Artists'], ['albums', 'Albums'], ['tracks', 'Tracks']] as [id, label] (id)}
        <button
          type="button"
          class="chip"
          aria-pressed={filter === id}
          onclick={() => (filter = id as typeof filter)}
        >
          {label}
        </button>
      {/each}
    </div>

    {#if filter === 'all'}
      <div class="top-row">
        {#if top}
          <div class="top">
            <h2>Top result</h2>
            <button
              type="button"
              class="top-card"
              onclick={() => open(top)}
              oncontextmenu={(e) => ui.openMenu(e, menuFor(top))}
            >
              <Artwork item={top} size={112} round={top.type === 'MusicArtist'} />
              <span class="top-name">{top.name}</span>
              <span class="top-kind">{sub(top)}</span>
            </button>
          </div>
        {/if}
        {#if topTracks.length > 0}
          <div class="top-tracks">
            <h2>Tracks</h2>
            <TrackList
              tracks={topTracks}
              numbered={false}
              showAlbum
              onplay={(i) => results && playTracks(results.tracks, i)}
            />
          </div>
        {/if}
      </div>
      {#if results.artists.length > 0}
        <Shelf title="Artists" items={results.artists} onopen={open} />
      {/if}
      {#if results.albums.length > 0}
        <Shelf title="Albums" items={results.albums} onopen={open} />
      {/if}
      {#if results.tracks.length > 4}
        <h2 class="section">More tracks</h2>
        <TrackList
          tracks={results.tracks.slice(4)}
          numbered={false}
          onplay={(i) => results && playTracks(results.tracks, 4 + i)}
        />
      {/if}
    {:else if filter === 'artists'}
      {@render grid(results.artists)}
    {:else if filter === 'albums'}
      {@render grid(results.albums)}
    {:else if results.tracks.length > 0}
      <TrackList
        tracks={results.tracks}
        numbered={false}
        showAlbum
        onplay={(i) => results && playTracks(results.tracks, i)}
      />
    {:else}
      <p class="muted">No tracks.</p>
    {/if}
  {/if}
</section>

{#snippet grid(list: BaseItem[])}
  {#if list.length === 0}
    <p class="muted">No results.</p>
  {:else}
    <Grid>
      {#each list as item (item.id)}<Card {item} onclick={() => open(item)} />{/each}
    </Grid>
  {/if}
{/snippet}

<style>
  .field {
    position: relative;
    display: flex;
    align-items: center;
    max-width: 640px;
    color: var(--text-muted);
    margin-bottom: var(--space-4);
  }
  .field :global(svg) {
    position: absolute;
    left: var(--space-4);
    pointer-events: none;
  }
  .input {
    width: 100%;
    padding: var(--space-4) var(--space-4) var(--space-4) calc(var(--space-4) + 36px);
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-full);
    color: var(--text);
    font: inherit;
    font-size: var(--text-lg);
    transition: border-color var(--transition), background var(--transition);
  }
  .input:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
    border-color: transparent;
  }
  h2 {
    margin: var(--space-5) 0 var(--space-3);
    font-size: var(--text-lg);
    font-weight: var(--weight-semibold);
  }
  h2.section {
    margin-top: var(--space-6);
  }
  .recent-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    max-width: 640px;
  }
  .text-btn {
    border: 0;
    background: none;
    color: var(--text-muted);
    font-size: var(--text-sm);
    cursor: pointer;
  }
  .text-btn:hover {
    color: var(--text);
  }
  .recents,
  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .chip {
    padding: var(--space-1) var(--space-3);
    border: 1px solid var(--border);
    border-radius: var(--radius-full);
    background: transparent;
    color: var(--text-muted);
    font-size: var(--text-sm);
    cursor: pointer;
    transition: background var(--transition), color var(--transition);
  }
  .chip:hover {
    background: var(--hover);
    color: var(--text);
  }
  .chip[aria-pressed='true'] {
    background: var(--text);
    border-color: var(--text);
    color: var(--bg);
  }
  .chip:focus-visible,
  .genre:focus-visible,
  .top-card:focus-visible,
  .text-btn:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
  .genres {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
    gap: var(--space-3);
  }
  .genre {
    height: 88px;
    padding: var(--space-3) var(--space-4);
    border: 0;
    border-radius: var(--radius-md);
    color: #fff;
    font-size: var(--text-md);
    font-weight: var(--weight-bold);
    text-align: left;
    text-shadow: 0 1px 6px rgb(0 0 0 / 0.35);
    cursor: pointer;
    transition: transform var(--transition);
  }
  .genre:hover {
    transform: scale(1.03);
  }
  .top-row {
    display: grid;
    grid-template-columns: minmax(240px, 340px) 1fr;
    gap: var(--space-6);
    margin-top: var(--space-2);
  }
  @media (max-width: 900px) {
    .top-row {
      grid-template-columns: 1fr;
      gap: 0;
    }
  }
  .top h2,
  .top-tracks h2 {
    margin-top: var(--space-3);
  }
  .top-card {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    width: 100%;
    padding: var(--space-5);
    border: 0;
    border-radius: var(--radius-lg);
    background: var(--surface);
    color: inherit;
    text-align: left;
    cursor: pointer;
    transition: background var(--transition);
  }
  .top-card:hover {
    background: var(--surface-2);
  }
  .top-card :global(.art) {
    margin-bottom: var(--space-3);
    box-shadow: var(--shadow-2);
  }
  .top-name {
    font-size: var(--text-xl);
    font-weight: var(--weight-bold);
    letter-spacing: var(--tracking-tight);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .top-kind {
    color: var(--text-muted);
    font-size: var(--text-sm);
  }
  .skeleton-grid {
    display: grid;
    grid-template-columns: minmax(240px, 340px) 1fr;
    gap: var(--space-6);
  }
  .muted {
    color: var(--text-muted);
  }
  .error {
    color: var(--danger);
  }
</style>
