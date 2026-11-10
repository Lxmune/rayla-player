<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { BaseItem } from '../../lib/jellyfin/models';
  import { getRouter } from '../shell/router.svelte';
  import Card from './Card.svelte';
  import IconButton from './IconButton.svelte';
  import Skeleton from './Skeleton.svelte';

  /** A titled, horizontally scrolling row of cards (or any children). */
  let {
    title,
    subtitle,
    items,
    children,
    onseeall,
    onopen,
    loading = false,
  }: {
    title: string;
    subtitle?: string;
    /** Rendered as Cards; opens with the router unless `onopen` is given. */
    items?: BaseItem[];
    /** Custom content, used instead of `items`. */
    children?: Snippet;
    onseeall?: () => void;
    onopen?: (item: BaseItem) => void;
    /** Show skeleton cards. */
    loading?: boolean;
  } = $props();

  const router = getRouter();
  const headingId = `shelf-${Math.random().toString(36).slice(2, 8)}`;
  let scroller: HTMLDivElement | undefined = $state();
  let overflowing = $state(false);
  let atStart = $state(true);
  let atEnd = $state(false);

  function measure() {
    if (!scroller) return;
    overflowing = scroller.scrollWidth > scroller.clientWidth + 1;
    atStart = scroller.scrollLeft <= 1;
    atEnd = scroller.scrollLeft + scroller.clientWidth >= scroller.scrollWidth - 1;
  }

  $effect(() => {
    void items;
    void loading;
    if (!scroller) return;
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(scroller);
    return () => ro.disconnect();
  });

  function page(dir: -1 | 1) {
    scroller?.scrollBy({ left: dir * scroller.clientWidth * 0.85, behavior: 'smooth' });
  }
</script>

<section class="shelf" aria-labelledby={headingId}>
  <header>
    <div class="titles">
      <h2 id={headingId}>{title}</h2>
      {#if subtitle}<p>{subtitle}</p>{/if}
    </div>
    <div class="tools">
      {#if onseeall}<button type="button" class="see-all" onclick={onseeall}>See all</button>{/if}
      {#if overflowing}
        <IconButton icon="back" label="Scroll {title} left" size={18} disabled={atStart} onclick={() => page(-1)} />
        <IconButton icon="forward" label="Scroll {title} right" size={18} disabled={atEnd} onclick={() => page(1)} />
      {/if}
    </div>
  </header>
  <div class="row" class:at-start={atStart} class:at-end={atEnd} bind:this={scroller} onscroll={measure}>
    {#if loading}
      {#each { length: 6 } as _, i (i)}
        <div class="cell skeleton-card" aria-hidden="true">
          <Skeleton height="auto" radius="var(--radius-md)" />
          <Skeleton width="70%" height="14px" />
          <Skeleton width="45%" height="12px" />
        </div>
      {/each}
    {:else if children}
      {@render children()}
    {:else}
      {#each items ?? [] as item (item.id)}
        <div class="cell">
          <Card {item} onclick={() => (onopen ? onopen(item) : router.open(item))} />
        </div>
      {/each}
    {/if}
  </div>
</section>

<style>
  .shelf {
    margin-top: var(--space-6);
  }
  header {
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    gap: var(--space-3);
    margin-bottom: var(--space-2);
  }
  h2 {
    margin: 0;
    font-size: var(--text-lg);
    font-weight: var(--weight-semibold);
    letter-spacing: var(--tracking-tight);
  }
  p {
    margin: 2px 0 0;
    color: var(--text-muted);
    font-size: var(--text-sm);
  }
  .tools {
    display: flex;
    align-items: center;
    gap: var(--space-1);
  }
  .see-all {
    border: 0;
    background: transparent;
    color: var(--text-muted);
    font-size: var(--text-sm);
    padding: var(--space-1) var(--space-2);
    border-radius: var(--radius-full);
    cursor: pointer;
    transition: color var(--transition), background var(--transition);
  }
  @media (hover: hover) {
    .see-all:hover {
      color: var(--text);
      background: var(--hover);
    }
  }
  .see-all {
    -webkit-tap-highlight-color: transparent;
  }
  .see-all:active {
    color: var(--text);
    background: var(--active);
  }
  .see-all:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
  .row {
    display: flex;
    gap: var(--space-2);
    overflow-x: auto;
    scroll-snap-type: x proximity;
    scrollbar-width: none;
    margin-inline: calc(var(--space-2) * -1);
    padding-inline: var(--space-2);
    padding-bottom: var(--space-2);
  }
  /* Soft edge fade where more cards are hidden. */
  .row {
    --fade-l: 0px;
    --fade-r: 0px;
    mask-image: linear-gradient(
      to right,
      transparent 0,
      #000 var(--fade-l),
      #000 calc(100% - var(--fade-r)),
      transparent 100%
    );
    -webkit-mask-image: linear-gradient(
      to right,
      transparent 0,
      #000 var(--fade-l),
      #000 calc(100% - var(--fade-r)),
      transparent 100%
    );
  }
  .row:not(.at-start) {
    --fade-l: 20px;
  }
  .row:not(.at-end) {
    --fade-r: 20px;
  }
  @media (hover: none), (max-width: 640px) {
    .row {
      scroll-snap-type: x mandatory;
      scroll-padding-inline: var(--space-2);
      -webkit-overflow-scrolling: touch;
      overscroll-behavior-x: contain;
    }
    .cell {
      scroll-snap-stop: normal;
    }
  }
  .row::-webkit-scrollbar {
    display: none;
  }
  .cell {
    flex: 0 0 var(--card-min);
    width: var(--card-min);
    min-width: 0;
    scroll-snap-align: start;
  }
  .skeleton-card {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding: var(--space-2);
  }
  .skeleton-card :global(.skeleton:first-child) {
    aspect-ratio: 1;
  }
</style>
