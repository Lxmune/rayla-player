<script lang="ts">
  import { getApp } from '../../lib/app.svelte';
  import { artistLine } from '../../lib/jellyfin/models';
  import Artwork from '../common/Artwork.svelte';
  import Backdrop from '../common/Backdrop.svelte';
  import BitPerfectBadge from '../common/BitPerfectBadge.svelte';
  import IconButton from '../common/IconButton.svelte';
  import SeekBar from '../common/SeekBar.svelte';
  import Transport from '../common/Transport.svelte';
  import VolumeControl from '../common/VolumeControl.svelte';
  import { useActions } from '../common/actions';
  import { useItemMenu } from '../common/item-menu';
  import { getRouter, getUi } from '../shell/router.svelte';
  import Lyrics from './Lyrics.svelte';
  import QueuePanel from './QueuePanel.svelte';
  import SleepTimerButton from './SleepTimerButton.svelte';

  const app = getApp();
  const ui = getUi();
  const router = getRouter();
  const actions = useActions();
  const menuFor = useItemMenu();
  const player = app.core.player;
  const item = $derived(player.current);
  const favorite = $derived(item ? app.core.favorites.isFavorite(item) : false);
  const paused = $derived(!player.isPlaying && player.playback !== 'buffering');
  const upNext = $derived(player.nextIndex === null ? null : (player.queue[player.nextIndex]?.item ?? null));
  const tab = $derived(ui.nowPlayingTab);

  function close() {
    ui.nowPlayingOpen = false;
  }

  function onkeydown(e: KeyboardEvent) {
    if (e.key === 'Escape' && !e.defaultPrevented && ui.sheet === null && ui.menu === null) close();
  }

  async function openArtist() {
    if (!item) return;
    const artist = await actions.artistOf(item);
    if (artist) {
      router.open(artist);
      close();
    }
  }

  async function openAlbum() {
    if (!item) return;
    const album = await actions.albumOf(item);
    if (album) {
      router.open(album);
      close();
    }
  }

  function tabKeys(e: KeyboardEvent) {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      ui.nowPlayingTab = tab === 'lyrics' ? 'queue' : 'lyrics';
      (e.currentTarget as HTMLElement).querySelector<HTMLElement>('[aria-selected="false"]')?.focus();
    }
  }
</script>

<svelte:window {onkeydown} />

<section class="np" aria-label="Now playing">
  <Backdrop {item} />

  <div class="top">
    <IconButton icon="chevronDown" label="Close now playing" onclick={close} />
    <div class="top-right">
      <BitPerfectBadge />
      <SleepTimerButton />
      <IconButton icon="signal" label="Signal path" onclick={() => (ui.sheet = { kind: 'signal' })} />
      {#if item}
        <IconButton icon="info" label="Track info" onclick={() => (ui.sheet = { kind: 'tech', item })} />
      {/if}
    </div>
  </div>

  <div class="layout">
    <div class="left">
      {#if item}
        <div class="cover" class:paused>
          <Artwork {item} size={640} fill />
        </div>
        <div class="meta">
          <div class="titles">
            <h1>{item.name}</h1>
            <p class="sub">
              <button type="button" class="link" onclick={() => void openArtist()}>{artistLine(item)}</button>
              {#if item.album}
                <span aria-hidden="true">·</span>
                <button type="button" class="link" onclick={() => void openAlbum()}>{item.album}</button>
              {/if}
            </p>
          </div>
          <div class="meta-actions">
            <IconButton
              icon={favorite ? 'heartFill' : 'heart'}
              label={favorite ? 'Remove from favorites' : 'Add to favorites'}
              active={favorite}
              onclick={() => void actions.toggleFavorite(item)}
            />
            <IconButton icon="more" label="More actions" onclick={(e) => {
              const at = e.currentTarget instanceof HTMLElement ? e.currentTarget : e;
              ui.openMenu(at, menuFor(item, { hideAlbum: true, hideArtist: true }));
            }} />
          </div>
        </div>
      {:else}
        <p class="muted">Nothing is playing.</p>
      {/if}

      <div class="controls">
        <SeekBar />
        <Transport secondary />
        <div class="volume"><VolumeControl /></div>
      </div>
    </div>

    <div class="right">
      <div class="tabs" role="tablist" aria-label="Lyrics and queue" tabindex="-1" onkeydown={tabKeys}>
        <button type="button" role="tab" aria-selected={tab === 'lyrics'} class:on={tab === 'lyrics'}
          onclick={() => (ui.nowPlayingTab = 'lyrics')}>Lyrics</button>
        <button type="button" role="tab" aria-selected={tab === 'queue'} class:on={tab === 'queue'}
          onclick={() => (ui.nowPlayingTab = 'queue')}>Queue</button>
      </div>
      <div class="panel" role="tabpanel" aria-label={tab === 'lyrics' ? 'Lyrics' : 'Queue'}>
        {#if tab === 'queue'}
          <div class="scroll"><QueuePanel /></div>
        {:else if item}
          {#key item.id}
            <Lyrics {item} positionMs={player.positionMs} onseek={(ms) => void actions.guard(() => player.seek(ms))} />
          {/key}
        {/if}
      </div>
      {#if tab === 'lyrics' && upNext}
        <button type="button" class="next" onclick={() => void actions.guard(() => player.next())}>
          <span class="next-art"><Artwork item={upNext} size={40} fill /></span>
          <span class="next-text">
            <span class="next-label">Up next</span>
            <span class="next-title">{upNext.name} · {artistLine(upNext)}</span>
          </span>
        </button>
      {/if}
    </div>
  </div>
</section>

<style>
  .np {
    position: fixed;
    inset: 0;
    z-index: var(--z-nowplaying);
    display: flex;
    flex-direction: column;
    background: linear-gradient(160deg, color-mix(in srgb, var(--accent) 14%, var(--bg)), var(--bg) 60%);
    transition: background var(--accent-transition);
    animation: slide-up var(--duration-slow) var(--ease-out);
  }
  .top,
  .layout {
    position: relative;
    z-index: 1;
  }
  .top {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    padding: var(--space-3) var(--space-4);
  }
  .top-right {
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }
  .layout {
    flex: 1;
    min-height: 0;
    display: grid;
    grid-template-columns: minmax(320px, 1fr) minmax(320px, 1fr);
    gap: var(--space-6);
    padding: 0 var(--space-6) var(--space-5);
  }
  .left {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
    justify-content: center;
    min-width: 0;
    min-height: 0;
    width: min(100%, 520px);
    margin: 0 auto;
  }
  .cover {
    width: min(100%, 48vh);
    margin: 0 auto;
    border-radius: var(--radius-lg);
    overflow: hidden;
    box-shadow: var(--art-shadow);
    transition: transform var(--duration-slow) var(--ease-out);
  }
  .cover.paused {
    transform: scale(0.92);
  }
  .meta {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
  }
  .titles {
    min-width: 0;
  }
  h1 {
    margin: 0;
    font-family: var(--font-display);
    font-size: var(--text-xl);
    font-weight: 750;
    letter-spacing: -0.01em;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .sub {
    margin: var(--space-1) 0 0;
    color: var(--text-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .link {
    border: 0;
    background: transparent;
    padding: 0;
    color: inherit;
    font: inherit;
    cursor: pointer;
  }
  .link:hover {
    color: var(--text);
    text-decoration: underline;
  }
  .meta-actions {
    display: flex;
    flex: none;
  }
  .controls {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    align-items: stretch;
  }
  .volume {
    display: flex;
    justify-content: center;
  }
  .right {
    display: flex;
    flex-direction: column;
    min-height: 0;
    min-width: 0;
    background: var(--glass);
    border: 1px solid var(--glass-border);
    backdrop-filter: blur(24px);
    border-radius: var(--radius-lg);
    overflow: hidden;
  }
  .tabs {
    display: flex;
    gap: var(--space-2);
    padding: var(--space-3) var(--space-4) 0;
  }
  .tabs button {
    padding: var(--space-1) var(--space-3);
    border: 0;
    border-radius: 999px;
    background: transparent;
    color: var(--text-muted);
    cursor: pointer;
    transition: background var(--transition), color var(--transition);
  }
  .tabs button:hover {
    color: var(--text);
  }
  .tabs button.on {
    background: var(--accent-soft);
    color: var(--accent);
  }
  .panel {
    flex: 1;
    min-height: 0;
  }
  .scroll {
    height: 100%;
    overflow-y: auto;
  }
  .next {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    margin: var(--space-2) var(--space-3) var(--space-3);
    padding: var(--space-2) var(--space-3);
    border: 1px solid var(--glass-border);
    border-radius: var(--radius-md);
    background: var(--hover);
    color: inherit;
    text-align: left;
    cursor: pointer;
  }
  .next:hover {
    background: var(--active);
  }
  .next-art {
    flex: none;
    width: 40px;
    height: 40px;
    border-radius: var(--radius-sm);
    overflow: hidden;
  }
  .next-text {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .next-label {
    font-size: var(--text-xs);
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--text-faint);
  }
  .next-title {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: var(--text-sm);
  }
  .muted {
    color: var(--text-muted);
    text-align: center;
  }
  @media (max-width: 900px) {
    .layout {
      grid-template-columns: 1fr;
      overflow-y: auto;
      gap: var(--space-4);
      padding: 0 var(--space-4) var(--space-4);
    }
    .left {
      justify-content: flex-start;
    }
    .cover {
      width: min(100%, 38vh);
    }
    .right {
      min-height: 60vh;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .np {
      animation: none;
    }
    .cover {
      transition: none;
    }
  }
</style>
