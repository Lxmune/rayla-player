<script lang="ts">
  import { getApp } from '../../lib/app.svelte';
  import { artistLine } from '../../lib/jellyfin/models';
  import Artwork from '../common/Artwork.svelte';
  import BitPerfectBadge from '../common/BitPerfectBadge.svelte';
  import IconButton from '../common/IconButton.svelte';
  import SeekBar from '../common/SeekBar.svelte';
  import Transport from '../common/Transport.svelte';
  import VolumeControl from '../common/VolumeControl.svelte';
  import { getUi } from './router.svelte';

  const app = getApp();
  const ui = getUi();
  const item = $derived(app.core.player.current);
</script>

<footer class="bar" aria-label="Player">
  <div class="now">
    {#if item}
      <button type="button" class="open" aria-label="Open now playing" onclick={() => (ui.nowPlayingOpen = true)}>
        <Artwork {item} size={52} />
        <span class="text">
          <span class="title">{item.name}</span>
          <span class="artist">{artistLine(item)}</span>
        </span>
      </button>
    {:else}
      <span class="idle">Nothing playing</span>
    {/if}
  </div>
  <div class="center">
    <Transport />
    <SeekBar />
  </div>
  <div class="right">
    <BitPerfectBadge />
    <VolumeControl />
    <IconButton icon="queue" label="Queue and lyrics" disabled={!item} onclick={() => (ui.nowPlayingOpen = true)} />
  </div>
</footer>

<style>
  .bar {
    display: grid;
    grid-template-columns: minmax(160px, 1fr) minmax(260px, 2fr) minmax(160px, 1fr);
    align-items: center;
    gap: var(--space-4);
    padding: var(--space-2) var(--space-4);
    background: var(--surface);
    border-top: 1px solid var(--border);
  }
  .now {
    min-width: 0;
  }
  .open {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    max-width: 100%;
    padding: 0;
    border: 0;
    background: transparent;
    text-align: left;
    cursor: pointer;
  }
  .text {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .title,
  .artist {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .artist {
    color: var(--text-muted);
    font-size: var(--text-sm);
  }
  .idle {
    color: var(--text-faint);
    font-size: var(--text-sm);
  }
  .center {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    min-width: 0;
  }
  .right {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: var(--space-2);
  }
  @media (max-width: 720px) {
    .bar {
      grid-template-columns: 1fr;
    }
    .right {
      display: none;
    }
  }
</style>
