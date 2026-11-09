<script lang="ts">
  import { getApp } from '../../lib/app.svelte';
  import { describeError } from '../../lib/jellyfin/client';
  import type { SearchResults } from '../../lib/jellyfin/models';
  import Card from '../common/Card.svelte';
  import Grid from '../common/Grid.svelte';
  import ScreenHeader from '../common/ScreenHeader.svelte';
  import TrackList from '../common/TrackList.svelte';
  import { useActions } from '../common/actions';
  import { getRouter } from '../shell/router.svelte';

  const app = getApp();
  const router = getRouter();
  const actions = useActions();

  let term = $state('');
  let results = $state.raw<SearchResults | null>(null);
  let searching = $state(false);
  let error = $state<string | null>(null);
  let seq = 0;

  // Debounced search; an older response never overwrites a newer one.
  $effect(() => {
    const q = term.trim();
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

  const empty = $derived(
    results !== null && results.artists.length + results.albums.length + results.tracks.length === 0,
  );
</script>

<section class="screen">
  <ScreenHeader title="Search" />
  <input
    class="input"
    type="search"
    placeholder="Artists, albums, tracks"
    aria-label="Search the library"
    bind:value={term}
  />

  {#if error}
    <p class="error" role="alert">{error}</p>
  {:else if searching && results === null}
    <p class="muted">Searching…</p>
  {:else if empty}
    <p class="muted">No results.</p>
  {/if}

  {#if results}
    {#if results.artists.length > 0}
      <h2>Artists</h2>
      <Grid>
        {#each results.artists as a (a.id)}<Card item={a} onclick={() => router.open(a)} />{/each}
      </Grid>
    {/if}
    {#if results.albums.length > 0}
      <h2>Albums</h2>
      <Grid>
        {#each results.albums as a (a.id)}<Card item={a} onclick={() => router.open(a)} />{/each}
      </Grid>
    {/if}
    {#if results.tracks.length > 0}
      <h2>Tracks</h2>
      <TrackList
        tracks={results.tracks}
        numbered={false}
        onplay={(i) => results && void actions.playTracks(results.tracks, i)}
      />
    {/if}
  {/if}
</section>

<style>
  .input {
    width: 100%;
    max-width: 480px;
    padding: var(--space-3) var(--space-4);
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 999px;
    outline-offset: 2px;
  }
  h2 {
    font-size: var(--text-lg);
    margin: var(--space-5) 0 var(--space-3);
  }
  .muted {
    color: var(--text-muted);
  }
  .error {
    color: var(--danger);
  }
</style>
