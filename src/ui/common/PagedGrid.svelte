<script lang="ts">
  import { untrack } from 'svelte';
  import type { BaseItem } from '../../lib/jellyfin/models';
  import type { Pager } from './resource.svelte';
  import Card from './Card.svelte';
  import Grid from './Grid.svelte';

  let {
    pager,
    onopen,
    empty = 'Nothing here yet.',
  }: { pager: Pager; onopen: (item: BaseItem) => void; empty?: string } = $props();

  let sentinel: HTMLElement | undefined = $state();

  // First page, and whenever a new pager (new sort / filter) is passed in.
  $effect(() => {
    const p = pager;
    untrack(() => void p.loadMore());
  });

  // Load the next page when the sentinel scrolls into view.
  $effect(() => {
    const el = sentinel;
    const p = pager;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) void p.loadMore();
    }, { rootMargin: '400px' });
    io.observe(el);
    return () => io.disconnect();
  });
</script>

{#if pager.items.length > 0}
  <Grid>
    {#each pager.items as item (item.id)}
      <Card {item} onclick={() => onopen(item)} />
    {/each}
  </Grid>
{:else if pager.done && !pager.error}
  <p class="status">{empty}</p>
{/if}

{#if pager.error}
  <p class="status error" role="alert">{pager.error}</p>
  <button type="button" class="link" onclick={() => void pager.loadMore()}>Retry</button>
{:else if pager.loading}
  <p class="status">Loading…</p>
{:else if !pager.done}
  <div bind:this={sentinel} class="sentinel">
    <button type="button" class="link" onclick={() => void pager.loadMore()}>Load more</button>
  </div>
{/if}

<style>
  .status {
    color: var(--text-muted);
    font-size: var(--text-sm);
    margin: var(--space-4) 0;
  }
  .status.error {
    color: var(--danger);
  }
  .sentinel {
    display: flex;
    justify-content: center;
    padding: var(--space-4);
  }
  .link {
    border: 0;
    background: transparent;
    color: var(--accent);
    cursor: pointer;
    font-size: var(--text-sm);
  }
</style>
