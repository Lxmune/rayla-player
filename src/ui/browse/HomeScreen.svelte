<script lang="ts">
  import { untrack } from 'svelte';
  import { getApp } from '../../lib/app.svelte';
  import type { BaseItem } from '../../lib/jellyfin/models';
  import Card from '../common/Card.svelte';
  import Grid from '../common/Grid.svelte';
  import ScreenHeader from '../common/ScreenHeader.svelte';
  import { Resource } from '../common/resource.svelte';
  import { getRouter } from '../shell/router.svelte';

  const app = getApp();
  const router = getRouter();
  const recent = new Resource<BaseItem[]>();
  const playlists = new Resource<BaseItem[]>();

  $effect(() => {
    const client = app.core.sessions.client;
    if (!client) return;
    untrack(() => {
      void recent.load(async () => (await client.recentlyAddedAlbums({ limit: 24 })).items);
      void playlists.load(async () => (await client.playlists({ limit: 12 })).items);
    });
  });
</script>

<section class="screen">
  <ScreenHeader title="Home" />

  <h2>Recently added</h2>
  {#if recent.error}
    <p class="error" role="alert">{recent.error}</p>
  {:else if recent.loading && !recent.data}
    <p class="muted">Loading…</p>
  {:else if (recent.data ?? []).length === 0}
    <p class="muted">No albums yet.</p>
  {:else}
    <Grid>
      {#each recent.data ?? [] as album (album.id)}
        <Card item={album} onclick={() => router.open(album)} />
      {/each}
    </Grid>
  {/if}

  {#if (playlists.data ?? []).length > 0}
    <h2>Playlists</h2>
    <Grid>
      {#each playlists.data ?? [] as pl (pl.id)}
        <Card item={pl} onclick={() => router.open(pl)} />
      {/each}
    </Grid>
  {/if}
</section>

<style>
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
