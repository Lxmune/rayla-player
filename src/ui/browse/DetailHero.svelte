<script lang="ts">
  import { onMount, type Snippet } from 'svelte';
  import type { BaseItem } from '../../lib/jellyfin/models';
  import Artwork from '../common/Artwork.svelte';
  import Backdrop from '../common/Backdrop.svelte';

  /** Shared header of album / playlist / artist pages. */
  let {
    item,
    kind,
    meta,
    actions,
  }: {
    item: BaseItem;
    /** Small uppercase label above the title ("Album", "EP", "Playlist", "Artist"). */
    kind: string;
    meta?: Snippet;
    actions?: Snippet;
  } = $props();

  const round = $derived(item.type === 'MusicArtist');

  // Phones get a compact hero: smaller art beside the title. matchMedia is missing in jsdom.
  let compact = $state(false);
  onMount(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia('(max-width: 640px)');
    compact = mq.matches;
    const on = (e: MediaQueryListEvent) => (compact = e.matches);
    mq.addEventListener?.('change', on);
    return () => mq.removeEventListener?.('change', on);
  });
  const artSize = $derived(compact ? (round ? 112 : 128) : 232);
</script>

<header class="hero">
  <Backdrop {item} />
  <div class="art" class:round>
    <Artwork {item} size={artSize} {round} />
  </div>
  <div class="info">
    <span class="kind">{kind}</span>
    <h1 title={item.name}>{item.name}</h1>
    {#if meta}<div class="meta">{@render meta()}</div>{/if}
    {#if actions}<div class="actions">{@render actions()}</div>{/if}
  </div>
</header>

<style>
  .hero {
    position: relative;
    display: flex;
    align-items: flex-end;
    gap: var(--space-6);
    /* Bleed the backdrop into the shell's content padding (Shell.svelte .content). */
    margin: calc(var(--space-4) * -1) calc(var(--gutter) * -1) var(--space-5);
    padding: var(--space-7) var(--gutter) var(--space-5);
    animation: fade-in var(--duration-slow) var(--ease-out);
  }
  .art,
  .info {
    position: relative;
    z-index: 1;
  }
  .art {
    flex: none;
    border-radius: var(--radius-md);
    box-shadow: var(--art-shadow);
    line-height: 0;
  }
  .art.round {
    border-radius: 50%;
  }
  .info {
    flex: 1;
    min-width: 0;
  }
  .kind {
    font-size: var(--text-xs);
    font-weight: var(--weight-semibold);
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--text-muted);
  }
  h1 {
    margin: var(--space-1) 0 var(--space-3);
    font-family: var(--font-display);
    font-size: clamp(var(--text-xl), 4.5vw, var(--text-3xl));
    line-height: 1.05;
    font-weight: var(--weight-bold);
    letter-spacing: var(--tracking-tight);
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
    overflow-wrap: anywhere;
  }
  .meta {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: var(--space-1) var(--space-2);
    color: var(--text-muted);
    font-size: var(--text-sm);
    margin-bottom: var(--space-4);
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-2);
  }
  @media (max-width: 720px) {
    .hero {
      flex-direction: column;
      align-items: center;
      text-align: center;
      gap: var(--space-4);
      padding-top: var(--space-5);
    }
    .art :global(img),
    .art :global(.art) {
      max-width: 100%;
    }
    .meta,
    .actions {
      justify-content: center;
    }
  }
  @media (max-width: 640px) {
    .hero {
      display: grid;
      grid-template-columns: auto minmax(0, 1fr);
      column-gap: var(--space-4);
      row-gap: 0;
      align-items: end;
      text-align: left;
      padding-top: var(--space-4);
      padding-bottom: var(--space-4);
    }
    .info {
      display: contents;
    }
    .art {
      grid-column: 1;
      grid-row: 1 / span 2;
    }
    .kind {
      grid-column: 2;
      grid-row: 1;
      align-self: end;
    }
    h1 {
      grid-column: 2;
      grid-row: 2;
      align-self: start;
      font-size: clamp(var(--text-lg), 6vw, var(--text-xl));
      margin: var(--space-1) 0 0;
    }
    .meta {
      grid-column: 1 / -1;
      justify-content: flex-start;
      margin: var(--space-3) 0 var(--space-3);
    }
    .actions {
      grid-column: 1 / -1;
      justify-content: flex-start;
      gap: var(--space-2);
    }
    .meta:empty {
      display: none;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .hero {
      animation: none;
    }
  }
</style>
