<script lang="ts">
  import { getApp } from '../../lib/app.svelte';
  import type { BaseItem } from '../../lib/jellyfin/models';
  import { backdropSource, preloadImage } from './image-cache';

  // Blurred cover art filling its positioned parent, fading into --bg at the
  // bottom. Renders nothing when Appearance › "Art backdrop" is off.
  // A new cover is decoded first, then cross-fades over the old one (never a
  // blank frame in between).
  let { item, intensity = 0.55 }: { item: BaseItem | null; intensity?: number } = $props();

  /** Matches the fade-in animation (--duration-slow) plus a margin. */
  const CROSSFADE_MS = 600;

  const app = getApp();
  const enabled = $derived(app.core.settings.current.appearance.artBackdrop);
  const src = $derived(enabled && item ? (backdropSource(app.core.sessions.client, item)?.src ?? null) : null);

  /** Bottom to top; the last one is current, an older one stays only while the new fades in. */
  let layers = $state<string[]>([]);
  let failed = $state<string | null>(null);

  $effect(() => {
    const next = src;
    if (next === null) {
      layers = [];
      return;
    }
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    void preloadImage({ src: next }).then(() => {
      if (!live) return;
      const top = layers[layers.length - 1];
      if (top === next) return;
      layers = top === undefined ? [next] : [top, next];
      timer = setTimeout(() => {
        if (layers[layers.length - 1] === next) layers = [next];
      }, CROSSFADE_MS);
    });
    return () => {
      live = false;
      clearTimeout(timer);
    };
  });
</script>

<div class="backdrop" aria-hidden="true">
  {#each layers as layer (layer)}
    {#if failed !== layer}
      <img src={layer} alt="" style:opacity={intensity} onerror={() => (failed = layer)} />
    {/if}
  {/each}
  <div class="fade"></div>
</div>

<style>
  .backdrop {
    position: absolute;
    inset: 0;
    overflow: hidden;
    pointer-events: none;
    z-index: 0;
  }
  img {
    position: absolute;
    inset: -15%;
    width: 130%;
    height: 130%;
    object-fit: cover;
    filter: blur(64px) saturate(1.4);
    transform: translateZ(0);
    animation: fade-in var(--duration-slow) var(--ease-out);
  }
  .fade {
    position: absolute;
    inset: 0;
    background: linear-gradient(to bottom, color-mix(in srgb, var(--bg) 25%, transparent), var(--bg) 92%);
  }
</style>
