<script lang="ts">
  import { getApp } from '../../lib/app.svelte';
  import { imageItemId, type BaseItem } from '../../lib/jellyfin/models';
  import Icon from './Icon.svelte';

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
  const src = $derived(
    client
      ? client.imageUrl(imageItemId(item), {
          maxWidth: Math.round(size * 2),
          tag: item.primaryImageTag ?? item.albumPrimaryImageTag,
        })
      : null,
  );
  let failedSrc = $state<string | null>(null);
  const broken = $derived(src === null || failedSrc === src);
</script>

<div
  class="art"
  class:round
  style={fill ? 'width:100%' : `width:${size}px;height:${size}px`}
  style:aspect-ratio="1 / 1"
>
  {#if !broken && src}
    <img {src} alt={item.name} loading="lazy" decoding="async" onerror={() => (failedSrc = src)} />
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
    background: var(--surface-2);
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
  }
  .placeholder {
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--text-faint);
  }
</style>
