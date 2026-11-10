<script lang="ts">
  import { untrack } from 'svelte';
  import { getApp } from '../../lib/app.svelte';
  import type { BaseItem } from '../../lib/jellyfin/models';
  import Icon from './Icon.svelte';
  import { nameGradient } from './format';
  import { artworkSource, isDecoded, preloadImage, type ImageSource } from './image-cache';

  let {
    item,
    size = 160,
    round = false,
    fill = false,
  }: {
    item: BaseItem;
    /** Requested image width in px (also the CSS size unless `fill`). */
    size?: number;
    round?: boolean;
    /** Stretch to the container (aspect ratio 1:1) instead of `size`. */
    fill?: boolean;
  } = $props();

  /** A slow new cover replaces the old one after this long anyway (then fades in). */
  const SWAP_TIMEOUT_MS = 800;

  const app = getApp();
  // Requested at 2x so high-density screens stay sharp; the 1x candidate is for plain ones.
  const source = $derived(artworkSource(app.core.sessions.client, item, size));

  // What the <img> shows. When the item changes (next track, recycled row) the old
  // cover stays until the new one is decoded, so nothing flashes in between.
  let shown = $state.raw<ImageSource | null>(null);
  let failedSrc = $state<string | null>(null);
  let loadedSrc = $state<string | null>(null);

  $effect(() => {
    const next = source;
    const cur = untrack(() => shown);
    if (next === null || cur === null || cur.src === next.src || isDecoded(next)) {
      // First image (normal fade-in), same image, or already decoded: swap now.
      shown = next;
      if (next && isDecoded(next)) loadedSrc = next.src;
      return;
    }
    let live = true;
    const swap = (decoded: boolean) => {
      if (!live) return;
      shown = next;
      if (decoded) loadedSrc = next.src;
    };
    void preloadImage(next).then(swap);
    const timer = setTimeout(() => swap(false), SWAP_TIMEOUT_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  });

  const broken = $derived(shown === null || failedSrc === shown.src);
  const gradient = $derived(nameGradient(item.name));
</script>

<div
  class="art"
  class:round
  style={fill ? 'width:100%' : `width:${size}px;height:${size}px`}
  style:aspect-ratio="1 / 1"
  style:--placeholder={gradient}
>
  {#if !broken && shown}
    {@const s = shown}
    <img
      src={s.src}
      srcset={s.srcset}
      alt={item.name}
      class:loaded={loadedSrc === s.src}
      loading="lazy"
      decoding="async"
      onload={() => (loadedSrc = s.src)}
      onerror={() => (failedSrc = s.src)}
    />
  {:else}
    <div class="placeholder" role="img" aria-label={item.name}>
      <Icon name={item.type === 'MusicArtist' ? 'artist' : 'music'} size={Math.max(16, size / 3)} />
    </div>
  {/if}
</div>

<style>
  .art {
    position: relative;
    flex: none;
    overflow: hidden;
    border-radius: var(--radius-md);
    background: var(--placeholder, var(--surface-2));
  }
  .art.round {
    border-radius: 50%;
  }
  img,
  .placeholder {
    display: block;
    width: 100%;
    height: 100%;
  }
  img {
    object-fit: cover;
    opacity: 0;
    transition: opacity var(--duration-slow) var(--ease-out);
  }
  img.loaded {
    opacity: 1;
  }
  .placeholder {
    display: flex;
    align-items: center;
    justify-content: center;
    color: rgb(255 255 255 / 0.7);
  }
  @media (prefers-reduced-motion: reduce) {
    img {
      transition: none;
    }
  }
</style>
