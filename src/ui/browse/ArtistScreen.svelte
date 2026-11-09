<script lang="ts">
  import { untrack } from 'svelte';
  import { getApp } from '../../lib/app.svelte';
  import type { BaseItem } from '../../lib/jellyfin/models';
  import Artwork from '../common/Artwork.svelte';
  import Button from '../common/Button.svelte';
  import Card from '../common/Card.svelte';
  import Grid from '../common/Grid.svelte';
  import { useActions } from '../common/actions';
  import { Resource } from '../common/resource.svelte';
  import { getRouter } from '../shell/router.svelte';

  let { item }: { item: BaseItem } = $props();

  const app = getApp();
  const router = getRouter();
  const actions = useActions();
  const albums = new Resource<BaseItem[]>();

  $effect(() => {
    const client = app.core.sessions.client;
    const id = item.id;
    if (!client) return;
    untrack(() => void albums.load(async () => (await client.artistAlbums(id)).items));
  });
</script>

<section class="screen">
  <div class="hero">
    <Artwork {item} size={160} round />
    <div class="info">
      <h1>{item.name}</h1>
      <div class="actions">
        <Button primary icon="shuffle" onclick={() => void actions.play(item, { shuffle: true })}>Shuffle all</Button>
        <Button icon="mix" onclick={() => void actions.instantMix(item)}>Instant mix</Button>
      </div>
    </div>
  </div>

  <h2>Albums</h2>
  {#if albums.error}
    <p class="error" role="alert">{albums.error}</p>
  {:else if albums.loading && !albums.data}
    <p class="muted">Loading…</p>
  {:else if (albums.data ?? []).length === 0}
    <p class="muted">No albums.</p>
  {:else}
    <Grid>
      {#each albums.data ?? [] as album (album.id)}
        <Card item={album} onclick={() => router.open(album)} />
      {/each}
    </Grid>
  {/if}
</section>

<style>
  .hero {
    display: flex;
    gap: var(--space-5);
    align-items: center;
    margin-bottom: var(--space-5);
  }
  h1 {
    margin: 0 0 var(--space-3);
    font-size: var(--text-xl);
  }
  h2 {
    font-size: var(--text-lg);
    margin: 0 0 var(--space-3);
  }
  .actions {
    display: flex;
    gap: var(--space-2);
    flex-wrap: wrap;
  }
  .muted {
    color: var(--text-muted);
  }
  .error {
    color: var(--danger);
  }
</style>
