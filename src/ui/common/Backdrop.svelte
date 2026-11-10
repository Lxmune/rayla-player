<script lang="ts">
  import { getApp } from '../../lib/app.svelte';
  import { imageItemId, type BaseItem } from '../../lib/jellyfin/models';

  // Blurred cover art filling its positioned parent, fading into --bg at the
  // bottom. Renders nothing when Appearance › "Art backdrop" is off.
  let { item, intensity = 0.55 }: { item: BaseItem | null; intensity?: number } = $props();

  const app = getApp();
  const enabled = $derived(app.core.settings.current.appearance.artBackdrop);
  const src = $derived.by(() => {
    const client = app.core.sessions.client;
    if (!client || !item || !enabled) return null;
    return client.imageUrl(imageItemId(item), {
      maxWidth: 160,
      tag: item.primaryImageTag ?? item.albumPrimaryImageTag,
    });
  });
  let failed = $state<string | null>(null);
</script>

<div class="backdrop" aria-hidden="true">
  {#if src && failed !== src}
    {#key src}
      <img {src} alt="" style:opacity={intensity} onerror={() => (failed = src)} />
    {/key}
  {/if}
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
