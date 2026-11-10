<script lang="ts">
  import { untrack } from 'svelte';
  import { getApp } from '../../lib/app.svelte';
  import { artistLine, type BaseItem } from '../../lib/jellyfin/models';
  import type { Pager } from './resource.svelte';
  import Artwork from './Artwork.svelte';
  import Card from './Card.svelte';
  import Grid from './Grid.svelte';
  import Icon from './Icon.svelte';
  import IconButton from './IconButton.svelte';
  import Skeleton from './Skeleton.svelte';
  import Button from './Button.svelte';
  import { useActions } from './actions';
  import { useItemMenu } from './item-menu';
  import { getUi } from '../shell/router.svelte';

  let {
    pager,
    onopen,
    empty = 'Nothing here yet.',
    view = 'grid',
  }: {
    pager: Pager;
    onopen: (item: BaseItem) => void;
    empty?: string;
    /** 'list' = compact rows (small art, artist, year). */
    view?: 'grid' | 'list';
  } = $props();

  const app = getApp();
  const ui = getUi();
  const actions = useActions();
  const menuFor = useItemMenu();
  const SKELETONS = 12;

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

  const isCurrent = (item: BaseItem) => app.core.player.current?.albumId === item.id;
  const meta = (item: BaseItem) =>
    [item.type === 'MusicAlbum' ? artistLine(item) : '', item.productionYear].filter(Boolean).join(' · ');
</script>

{#if pager.items.length > 0}
  {#if view === 'list'}
    <ul class="rows">
      {#each pager.items as item (item.id)}
        <li
          class="row"
          class:now-playing={isCurrent(item)}
          oncontextmenu={(e) => ui?.openMenu(e, menuFor(item))}
        >
          <button type="button" class="open" onclick={() => onopen(item)}>
            <span class="thumb" aria-hidden="true"><Artwork {item} size={40} /></span>
            <span class="name">{item.name}</span>
            <span class="meta">{meta(item)}</span>
          </button>
          <span class="acts">
            <IconButton icon="play" label={`Play ${item.name}`} size={16} onclick={() => void actions.play(item)} />
            <IconButton
              icon="more"
              label={`More options for ${item.name}`}
              size={18}
              onclick={(e) => ui?.openMenu(e.currentTarget as HTMLElement, menuFor(item))}
            />
          </span>
        </li>
      {/each}
    </ul>
  {:else}
    <Grid>
      {#each pager.items as item (item.id)}
        <Card {item} onclick={() => onopen(item)} />
      {/each}
    </Grid>
  {/if}
{:else if pager.loading || (!pager.done && !pager.error)}
  <div class="skeletons" aria-hidden="true">
    <Grid>
      {#each Array(SKELETONS) as _, i (i)}
        <div class="sk">
          <Skeleton height="auto" radius="var(--radius-md)" />
          <Skeleton width="70%" height="14px" />
          <Skeleton width="45%" height="12px" />
        </div>
      {/each}
    </Grid>
  </div>
{:else if pager.done && !pager.error}
  <div class="empty">
    <Icon name="music" size={40} />
    <p>{empty}</p>
  </div>
{/if}

{#if pager.error}
  <div class="empty err">
    <p class="error" role="alert">{pager.error}</p>
    <Button icon="refresh" onclick={() => void pager.loadMore()}>Retry</Button>
  </div>
{:else if pager.items.length > 0 && pager.loading}
  <div class="sentinel"><span class="loading" role="status" aria-label="Loading more"></span></div>
{:else if pager.items.length > 0 && !pager.done}
  <!-- Remounted after every page, so the observer fires again if it is still in view. -->
  <div bind:this={sentinel} class="sentinel">
    <Button onclick={() => void pager.loadMore()}>Load more</Button>
  </div>
{/if}

<style>
  .sk {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding: var(--space-3);
  }
  .sk :global(.skeleton:first-child) {
    aspect-ratio: 1 / 1;
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
    font-size: var(--text-md);
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
  .rows {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .row {
    content-visibility: auto;
    contain-intrinsic-size: auto var(--row-height);
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: 0 var(--space-2);
    border-radius: var(--radius-sm);
    transition: background var(--duration-fast);
  }
  .row {
    -webkit-tap-highlight-color: transparent;
  }
  .row:has(:focus-visible) {
    background: var(--hover);
  }
  @media (hover: hover) {
    .row:hover {
      background: var(--hover);
    }
  }
  .row:active {
    background: var(--active);
    transition: background 0ms;
  }
  .open {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: var(--space-3);
    min-height: var(--row-height);
    padding: var(--space-1) 0;
    border: 0;
    background: transparent;
    color: inherit;
    text-align: left;
    cursor: pointer;
  }
  .thumb {
    display: inline-flex;
    flex: none;
  }
  .name {
    flex: 1 1 40%;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-weight: var(--weight-medium);
  }
  .now-playing .name {
    color: var(--accent);
  }
  .meta {
    flex: 1 1 40%;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--text-muted);
    font-size: var(--text-sm);
  }
  .acts {
    display: inline-flex;
    flex: none;
    opacity: 0;
    transition: opacity var(--transition);
  }
  .row:has(:focus-visible) .acts {
    opacity: 1;
  }
  @media (hover: hover) {
    .row:hover .acts {
      opacity: 1;
    }
  }
  @media (hover: none) {
    .acts {
      opacity: 1;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .loading {
      animation-duration: 2s;
    }
  }
</style>
