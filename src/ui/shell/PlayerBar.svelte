<script lang="ts">
  import { getApp } from '../../lib/app.svelte';
  import { artistLine } from '../../lib/jellyfin/models';
  import Artwork from '../common/Artwork.svelte';
  import BitPerfectBadge from '../common/BitPerfectBadge.svelte';
  import Icon from '../common/Icon.svelte';
  import IconButton from '../common/IconButton.svelte';
  import SeekBar from '../common/SeekBar.svelte';
  import Transport from '../common/Transport.svelte';
  import VolumeControl from '../common/VolumeControl.svelte';
  import { useActions } from '../common/actions';
  import { useItemMenu } from '../common/item-menu';
  import { getRouter, getUi } from './router.svelte';

  const app = getApp();
  const router = getRouter();
  const ui = getUi();
  const actions = useActions();
  const menuFor = useItemMenu();
  const item = $derived(app.core.player.current);
  const favorite = $derived(item ? app.core.favorites.isFavorite(item) : false);

  const openNowPlaying = () => (ui.nowPlayingOpen = true);
  function openLyrics() {
    ui.nowPlayingTab = 'lyrics';
    ui.nowPlayingOpen = true;
  }
  async function openArtist() {
    if (!item) return;
    const artist = await actions.artistOf(item);
    if (artist) router.open(artist);
  }
  function oncontextmenu(e: MouseEvent) {
    if (item) ui.openMenu(e, menuFor(item));
  }
</script>

<footer class="bar" aria-label="Player">
  <div class="now" {oncontextmenu} role="presentation">
    {#if item}
      <button type="button" class="art" aria-label="Open now playing" onclick={openNowPlaying}>
        <Artwork {item} size={56} />
        <span class="expand"><Icon name="expand" size={20} /></span>
      </button>
      <span class="text">
        <button type="button" class="title" onclick={openNowPlaying}>{item.name}</button>
        <button type="button" class="artist" onclick={openArtist}>{artistLine(item)}</button>
      </span>
      <IconButton
        icon={favorite ? 'heartFill' : 'heart'}
        label={favorite ? 'Remove from favorites' : 'Add to favorites'}
        size={18}
        active={favorite}
        onclick={() => void actions.toggleFavorite(item)}
      />
    {:else}
      <span class="idle">Nothing playing</span>
    {/if}
  </div>
  <div class="center">
    <Transport secondary />
    <SeekBar />
  </div>
  <div class="right">
    <BitPerfectBadge />
    <IconButton icon="lyrics" label="Lyrics" disabled={!item} onclick={openLyrics} />
    <IconButton
      icon="queue"
      label="Queue"
      pressed={ui.queueOpen}
      active={ui.queueOpen}
      onclick={() => (ui.queueOpen = !ui.queueOpen)}
    />
    <VolumeControl />
    <IconButton icon="expand" label="Expand now playing" disabled={!item} onclick={openNowPlaying} />
  </div>
</footer>

<style>
  .bar {
    position: relative;
    display: grid;
    grid-template-columns: minmax(180px, 1fr) minmax(280px, 2fr) minmax(180px, 1fr);
    align-items: center;
    gap: var(--space-5);
    height: var(--playerbar-height);
    padding: 0 var(--space-4);
    background:
      linear-gradient(color-mix(in srgb, var(--accent) 6%, transparent), color-mix(in srgb, var(--accent) 6%, transparent)),
      var(--glass);
    backdrop-filter: blur(24px) saturate(1.4);
    border-top: 1px solid var(--glass-border);
    transition: background var(--accent-transition);
  }
  .now {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    min-width: 0;
  }
  .art {
    position: relative;
    display: flex;
    flex: none;
    padding: 0;
    border: 0;
    border-radius: var(--radius-md);
    background: transparent;
    cursor: pointer;
    overflow: hidden;
  }
  .expand {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    background: rgb(0 0 0 / 0.5);
    color: white;
    opacity: 0;
    transition: opacity var(--transition);
  }
  .art:hover .expand,
  .art:focus-visible .expand {
    opacity: 1;
  }
  .text {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    min-width: 0;
  }
  .title,
  .artist {
    max-width: 100%;
    padding: 0;
    border: 0;
    background: transparent;
    font: inherit;
    text-align: left;
    cursor: pointer;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .title {
    color: var(--text);
    font-weight: var(--weight-medium);
  }
  .artist {
    color: var(--text-muted);
    font-size: var(--text-sm);
  }
  .title:hover,
  .artist:hover {
    text-decoration: underline;
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
    max-width: 640px;
    width: 100%;
    justify-self: center;
  }
  .right {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: var(--space-1);
    min-width: 0;
  }
  @media (max-width: 1100px) {
    .right :global(.volume .slider) {
      display: none;
    }
  }
  @media (max-width: 720px) {
    .bar {
      grid-template-columns: 1fr;
      gap: var(--space-1);
      height: auto;
      padding: var(--space-2) var(--space-3);
    }
    .right {
      display: none;
    }
  }
</style>
