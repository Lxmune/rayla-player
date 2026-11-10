<script lang="ts">
  import { untrack } from 'svelte';
  import type { BaseItem } from '../../lib/jellyfin/models';
  import type { Pager } from './resource.svelte';
  import Button from './Button.svelte';
  import Icon from './Icon.svelte';
  import Skeleton from './Skeleton.svelte';
  import TrackList from './TrackList.svelte';

  let {
    pager,
    onplay,
    empty = 'No tracks found.',
    showAlbum = true,
    showArt = true,
  }: {
    pager: Pager;
    /** Called with the clicked index into `pager.items` (the loaded tracks). */
    onplay: (index: number) => void;
    empty?: string;
    showAlbum?: boolean;
    showArt?: boolean;
  } = $props();

  let sentinel: HTMLElement | undefined = $state();

  $effect(() => {
    const p = pager;
    untrack(() => void p.loadMore());
  });

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
  <TrackList tracks={pager.items} {onplay} numbered={false} {showAlbum} {showArt} header />
{:else if pager.loading || (!pager.done && !pager.error)}
  <div class="skeletons" aria-hidden="true">
    {#each Array(10) as _, i (i)}
      <div class="sk">
        <Skeleton width="40px" height="40px" radius="var(--radius-sm)" />
        <div class="lines">
          <Skeleton width="40%" height="13px" />
          <Skeleton width="25%" height="11px" />
        </div>
      </div>
    {/each}
  </div>
{:else if pager.done && !pager.error}
  <div class="empty">
    <Icon name="music" size={40} />
    <p>{empty}</p>
  </div>
{/if}

{#if pager.error}
  <div class="empty">
    <p class="error" role="alert">{pager.error}</p>
    <Button icon="refresh" onclick={() => void pager.loadMore()}>Retry</Button>
  </div>
{:else if pager.items.length > 0 && pager.loading}
  <div class="sentinel"><span class="loading" role="status" aria-label="Loading more"></span></div>
{:else if pager.items.length > 0 && !pager.done}
  <div bind:this={sentinel} class="sentinel">
    <Button onclick={() => void pager.loadMore()}>Load more</Button>
  </div>
{/if}

<style>
  .sk {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    min-height: var(--row-height);
    padding: 0 var(--space-3);
  }
  .lines {
    display: flex;
    flex-direction: column;
    gap: 6px;
    flex: 1;
  }
  .empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-7) var(--space-4);
    color: var(--text-faint);
    text-align: center;
  }
  .empty p {
    margin: 0;
    color: var(--text-muted);
  }
  .empty .error {
    color: var(--danger);
  }
  .sentinel {
    display: flex;
    justify-content: center;
    padding: var(--space-5);
    min-height: 24px;
  }
  .loading {
    width: 22px;
    height: 22px;
    border: 2px solid var(--border-strong);
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: spin 700ms linear infinite;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
</style>
