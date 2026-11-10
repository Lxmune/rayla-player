<script lang="ts">
  import { getApp } from '../../lib/app.svelte';
  import type { BaseItem } from '../../lib/jellyfin/models';
  import Button from '../common/Button.svelte';
  import PagedGrid from '../common/PagedGrid.svelte';
  import { useActions } from '../common/actions';
  import { nameGradient, plural } from '../common/format';
  import { Pager } from '../common/resource.svelte';
  import { getRouter } from '../shell/router.svelte';

  let { item }: { item: BaseItem } = $props();

  /** How many random tracks Play / Shuffle queue. */
  const QUEUE_LIMIT = 200;

  const app = getApp();
  const router = getRouter();
  const actions = useActions();

  const pager = $derived.by(() => {
    const genreId = item.id;
    return new Pager(async (startIndex) => {
      const client = app.core.sessions.client;
      if (!client) throw new Error('Not signed in');
      return client.albums({ genreId, sortBy: 'SortName', startIndex, limit: 60 });
    });
  });

  async function playGenre(shuffle: boolean) {
    await actions.guard(async () => {
      const client = app.core.sessions.client;
      if (!client) throw new Error('Not signed in');
      const page = await client.tracks({ genreId: item.id, sortBy: 'Random', limit: QUEUE_LIMIT });
      if (page.items.length === 0) throw new Error(`No tracks in ${item.name}.`);
      await app.core.player.playQueue(page.items, { startIndex: 0, shuffle });
    });
  }
</script>

<section class="screen">
  <header class="hero" style:background={nameGradient(item.name)}>
    <div class="titles">
      <span class="kind">Genre</span>
      <h1>{item.name}</h1>
      {#if pager.total > 0}<p>{plural(pager.total, 'album')}</p>{/if}
    </div>
    <div class="tools">
      <Button icon="play" primary onclick={() => void playGenre(false)}>Play</Button>
      <Button icon="shuffle" onclick={() => void playGenre(true)}>Shuffle</Button>
    </div>
  </header>
  <h2>Albums</h2>
  <PagedGrid {pager} onopen={(a) => router.open(a)} empty="No albums in this genre." />
</section>

<style>
  .hero {
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: var(--space-4);
    min-height: 200px;
    padding: var(--space-6);
    margin-bottom: var(--space-6);
    border-radius: var(--radius-xl);
    color: #fff;
    box-shadow: var(--shadow-2);
  }
  .kind {
    font-size: var(--text-xs);
    font-weight: var(--weight-semibold);
    letter-spacing: 0.12em;
    text-transform: uppercase;
    opacity: 0.8;
  }
  h1 {
    margin: var(--space-1) 0;
    font-size: var(--text-2xl);
    font-weight: var(--weight-bold);
    letter-spacing: var(--tracking-tight);
    line-height: 1.1;
    text-shadow: 0 2px 12px rgb(0 0 0 / 0.3);
  }
  p {
    margin: 0;
    opacity: 0.85;
  }
  .tools {
    display: flex;
    gap: var(--space-2);
  }
  h2 {
    margin: 0 0 var(--space-3);
    font-size: var(--text-lg);
    letter-spacing: var(--tracking-tight);
  }
</style>
