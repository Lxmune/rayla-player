<script lang="ts">
  import { getApp } from '../../lib/app.svelte';
  import { imageItemId, type BaseItem } from '../../lib/jellyfin/models';
  import Icon from './Icon.svelte';
  import { nameGradient } from './format';

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

  const app = getApp();
  const client = $derived(app.core.sessions.client);
  const tag = $derived(item.primaryImageTag ?? item.albumPrimaryImageTag);
  const url = (width: number) =>
    client ? client.imageUrl(imageItemId(item), { maxWidth: Math.round(width), tag }) : null;
  // Requested at 2x so high-density screens stay sharp; the 1x candidate is for plain ones.
  const src = $derived(url(size * 2));
  const srcset = $derived.by(() => {
    const one = url(size);
    return one && src ? `${one} 1x, ${src} 2x` : undefined;
  });
  let failedSrc = $state<string | null>(null);
  let loadedSrc = $state<string | null>(null);
  const broken = $derived(src === null || failedSrc === src);
  const gradient = $derived(nameGradient(item.name));
</script>

<div
  class="art"
  class:round
  style={fill ? 'width:100%' : `width:${size}px;height:${size}px`}
  style:aspect-ratio="1 / 1"
  style:--placeholder={gradient}
>
  {#if !broken && src}
    <img
      {src}
      {srcset}
      alt={item.name}
      class:loaded={loadedSrc === src}
      loading="lazy"
      decoding="async"
      onload={() => (loadedSrc = src)}
      onerror={() => (failedSrc = src)}
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
