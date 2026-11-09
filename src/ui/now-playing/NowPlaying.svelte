<script lang="ts">
  import { getApp } from '../../lib/app.svelte';
  import { artistLine } from '../../lib/jellyfin/models';
  import Artwork from '../common/Artwork.svelte';
  import BitPerfectBadge from '../common/BitPerfectBadge.svelte';
  import IconButton from '../common/IconButton.svelte';
  import SeekBar from '../common/SeekBar.svelte';
  import Transport from '../common/Transport.svelte';
  import VolumeControl from '../common/VolumeControl.svelte';
  import { useActions } from '../common/actions';
  import { getUi } from '../shell/router.svelte';
  import Lyrics from './Lyrics.svelte';
  import QueuePanel from './QueuePanel.svelte';

  const app = getApp();
  const ui = getUi();
  const actions = useActions();
  const player = app.core.player;
  const item = $derived(player.current);
  const favorite = $derived(item ? app.core.favorites.isFavorite(item) : false);
  let tab = $state<'lyrics' | 'queue'>('lyrics');

  function onkeydown(e: KeyboardEvent) {
    if (e.key === 'Escape' && !e.defaultPrevented && ui.sheet === null) ui.nowPlayingOpen = false;
  }
</script>

<svelte:window {onkeydown} />

<section class="np" aria-label="Now playing">
  <div class="top">
    <IconButton icon="chevronDown" label="Close now playing" onclick={() => (ui.nowPlayingOpen = false)} />
    <BitPerfectBadge />
  </div>

  <div class="layout">
    <div class="left">
      {#if item}
        <div class="cover"><Artwork {item} size={480} fill /></div>
        <div class="meta">
          <h1>{item.name}</h1>
          <p>{artistLine(item)}{item.album ? ` — ${item.album}` : ''}</p>
        </div>
      {:else}
        <p class="muted">Nothing is playing.</p>
      {/if}

      <SeekBar />
      <Transport secondary />

      <div class="tools">
        {#if item}
          <IconButton
            icon={favorite ? 'heartFill' : 'heart'}
            label={favorite ? 'Remove from favorites' : 'Add to favorites'}
            active={favorite}
            onclick={() => void actions.toggleFavorite(item)}
          />
        {/if}
        <VolumeControl />
        <IconButton icon="signal" label="Signal path" onclick={() => (ui.sheet = { kind: 'signal' })} />
        {#if item}
          <IconButton icon="info" label="Track info" onclick={() => (ui.sheet = { kind: 'tech', item })} />
        {/if}
      </div>
    </div>

    <div class="right">
      <div class="tabs" role="tablist" aria-label="Lyrics and queue">
        <button type="button" role="tab" aria-selected={tab === 'lyrics'} class:on={tab === 'lyrics'} onclick={() => (tab = 'lyrics')}>Lyrics</button>
        <button type="button" role="tab" aria-selected={tab === 'queue'} class:on={tab === 'queue'} onclick={() => (tab = 'queue')}>Queue</button>
      </div>
      <div class="panel" role="tabpanel" aria-label={tab === 'lyrics' ? 'Lyrics' : 'Queue'}>
        {#if tab === 'queue'}
          <QueuePanel />
        {:else if item}
          {#key item.id}
            <Lyrics {item} positionMs={player.positionMs} onseek={(ms) => void actions.guard(() => player.seek(ms))} />
          {/key}
        {/if}
      </div>
    </div>
  </div>
</section>

<style>
  .np {
    position: fixed;
    inset: 0;
    z-index: 50;
    display: flex;
    flex-direction: column;
    background: linear-gradient(160deg, color-mix(in srgb, var(--accent) 14%, var(--bg)), var(--bg) 60%);
    transition: background var(--accent-transition);
  }
  .top {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: var(--space-3) var(--space-4);
  }
  .layout {
    flex: 1;
    min-height: 0;
    display: grid;
    grid-template-columns: minmax(300px, 1fr) minmax(300px, 1fr);
    gap: var(--space-5);
    padding: 0 var(--space-5) var(--space-5);
  }
  .left {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
    align-items: stretch;
    justify-content: center;
    min-width: 0;
    min-height: 0;
  }
  .cover {
    width: min(100%, 46vh);
    margin: 0 auto;
  }
  .meta {
    text-align: center;
  }
  h1 {
    margin: 0;
    font-size: var(--text-xl);
  }
  .meta p {
    margin: var(--space-1) 0 0;
    color: var(--text-muted);
  }
  .tools {
    display: flex;
    justify-content: center;
    align-items: center;
    gap: var(--space-3);
    flex-wrap: wrap;
  }
  .right {
    display: flex;
    flex-direction: column;
    min-height: 0;
    min-width: 0;
    background: color-mix(in srgb, var(--surface) 70%, transparent);
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
  }
  .tabs button.on {
    background: var(--accent-soft);
    color: var(--accent);
  }
  .panel {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
  }
  .muted {
    color: var(--text-muted);
    text-align: center;
  }
  @media (max-width: 800px) {
    .layout {
      grid-template-columns: 1fr;
      overflow-y: auto;
    }
    .right {
      min-height: 50vh;
    }
  }
</style>
