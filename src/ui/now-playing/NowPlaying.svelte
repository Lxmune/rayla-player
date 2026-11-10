<script lang="ts">
  import { getApp } from '../../lib/app.svelte';
  import { artistLine } from '../../lib/jellyfin/models';
  import Artwork from '../common/Artwork.svelte';
  import Backdrop from '../common/Backdrop.svelte';
  import BitPerfectBadge from '../common/BitPerfectBadge.svelte';
  import Icon from '../common/Icon.svelte';
  import IconButton from '../common/IconButton.svelte';
  import SeekBar from '../common/SeekBar.svelte';
  import Transport from '../common/Transport.svelte';
  import VolumeControl from '../common/VolumeControl.svelte';
  import { useActions } from '../common/actions';
  import { useItemMenu } from '../common/item-menu';
  import { getRouter, getUi } from '../shell/router.svelte';
  import { deviceIcon, OutputDevices } from '../sheets/output-devices.svelte';
  import { onDestroy, onMount } from 'svelte';
  import { haptic } from '../common/haptics';
  import {
    VelocityTracker, WheelSwipe, coverDragOffset, decideCoverDrag, decideRelease, decideSkip, pastThreshold,
    sheetDragStyle,
  } from '../shell/gestures';
  import { prefersReducedMotion } from '../common/touch';
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

  const outputs = new OutputDevices();
  onMount(() => void outputs.start());
  onDestroy(() => outputs.dispose());
  const outputId = $derived(app.core.settings.current.outputDeviceId);
  const outputDevice = $derived(outputs.find(outputId));
  const outputName = $derived(
    outputId === null
      ? (outputs.defaultDevice?.name ?? 'System default')
      : (outputDevice?.name ?? 'Disconnected'),
  );

  // Swipe down on the top bar or the cover: the sheet follows the finger, then closes or springs back.
  let root: HTMLElement | undefined = $state();
  let swipe: { x: number; y: number; id: number; el: HTMLElement } | null = null;
  let dragging = false;
  let crossed = false;
  let dragY = $state(0);
  let settling = $state(false);
  const vel = new VelocityTracker();
  const dragStyle = $derived(sheetDragStyle(dragY, root?.clientHeight ?? 0));

  function swipeStart(e: PointerEvent) {
    if (e.pointerType === 'mouse') return;
    swipe = { x: e.clientX, y: e.clientY, id: e.pointerId, el: e.currentTarget as HTMLElement };
    dragging = false;
    crossed = false;
    settling = false;
    vel.reset();
  }
  function swipeMove(e: PointerEvent) {
    const s = swipe;
    if (!s) return;
    const dx = e.clientX - s.x;
    const dy = e.clientY - s.y;
    if (!dragging) {
      if (dy > 8 && dy > Math.abs(dx) * 1.2) {
        dragging = true;
        try {
          s.el.setPointerCapture(s.id);
        } catch {
          // best effort
        }
      } else if (Math.abs(dx) > 12 || dy < -8) {
        swipe = null;
        return;
      } else return;
    }
    dragY = dy;
    vel.add(e.timeStamp, dy);
    const c = pastThreshold(dy, root?.clientHeight ?? 0);
    if (c !== crossed) haptic('tick');
    crossed = c;
  }
  function swipeEnd(e: PointerEvent) {
    const s = swipe;
    swipe = null;
    if (!s || !dragging) return;
    dragging = false;
    settling = true;
    const h = root?.clientHeight ?? 0;
    if (decideRelease(e.clientY - s.y, vel.get(), h) === 'commit') {
      dragY = h;
      setTimeout(close, 180);
    } else dragY = 0;
  }
  function swipeCancel() {
    swipe = null;
    if (dragging) {
      dragging = false;
      settling = true;
      dragY = 0;
    }
  }

  // Cover: drag sideways (touch, pen or mouse) to skip; down (touch/pen) still closes the sheet.
  let cover: { x: number; y: number; id: number; mode: 'h' | 'v' | null } | null = null;
  let coverSwiped = false;
  let coverCrossed = false;
  let coverX = $state(0);
  let coverSettling = $state(false);
  let coverEnter = $state<'' | 'left' | 'right'>('');
  const coverVel = new VelocityTracker();
  const wheel = new WheelSwipe();

  function skip(dir: 'next' | 'previous') {
    haptic('tick');
    if (!prefersReducedMotion()) {
      coverEnter = dir === 'next' ? 'left' : 'right';
      setTimeout(() => (coverEnter = ''), 260);
    }
    void actions.guard(() => (dir === 'next' ? player.next() : player.previous()));
  }
  function coverDown(e: PointerEvent) {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    swipeStart(e);
    cover = { x: e.clientX, y: e.clientY, id: e.pointerId, mode: null };
    coverSwiped = false;
    coverCrossed = false;
    coverSettling = false;
    coverVel.reset();
  }
  function coverMove(e: PointerEvent) {
    const c = cover;
    if (!c) return;
    const dx = e.clientX - c.x;
    if (!c.mode) {
      const d = decideCoverDrag(dx, e.clientY - c.y, e.pointerType);
      if (d === 'cancel') {
        cover = null;
        swipeCancel();
        return;
      }
      if (d !== 'h') {
        if (d === 'v') c.mode = 'v';
        swipeMove(e);
        return;
      }
      c.mode = 'h';
      swipe = null;
      try {
        (e.currentTarget as HTMLElement).setPointerCapture(c.id);
      } catch {
        // best effort
      }
    }
    if (c.mode === 'v') return swipeMove(e);
    const w = (e.currentTarget as HTMLElement).clientWidth || 300;
    coverX = coverDragOffset(dx, w);
    coverVel.add(e.timeStamp, dx);
    const past = pastThreshold(Math.abs(dx), w);
    if (past !== coverCrossed) haptic('tick');
    coverCrossed = past;
  }
  function coverUp(e: PointerEvent) {
    const c = cover;
    cover = null;
    if (c?.mode !== 'h') return swipeEnd(e);
    coverSwiped = true;
    coverSettling = true;
    coverX = 0;
    const w = (e.currentTarget as HTMLElement).clientWidth || 300;
    const verdict = decideSkip(e.clientX - c.x, Math.abs(coverVel.get()), w);
    if (verdict !== 'cancel') skip(verdict);
  }
  function coverCancel() {
    if (cover?.mode === 'h') {
      coverSettling = true;
      coverX = 0;
    }
    cover = null;
    swipeCancel();
  }
  function coverClick(e: MouseEvent) {
    if (!coverSwiped) return;
    coverSwiped = false;
    e.stopPropagation();
    e.preventDefault();
  }
  function coverWheel(e: WheelEvent) {
    const dir = wheel.add(e.deltaX, e.deltaY, e.timeStamp);
    if (dir) skip(dir);
  }

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

<section
  class="np"
  class:settling
  aria-label="Now playing"
  bind:this={root}
  style:transform={dragY > 0 ? `translateY(${dragStyle.y}px) scale(${dragStyle.scale})` : undefined}
  style:opacity={dragY > 0 ? dragStyle.opacity : undefined}
>
  <Backdrop {item} />

  <div class="top" role="presentation" onpointerdown={swipeStart} onpointermove={swipeMove}
    onpointerup={swipeEnd} onpointercancel={swipeCancel}>
    <IconButton icon="chevronDown" label="Close now playing" onclick={close} />
    <div class="top-right">
      <BitPerfectBadge />
      <SleepTimerButton />
      <IconButton icon="sliders" label="Sound & quality" onclick={() => (ui.sheet = { kind: 'audio' })} />
      <IconButton icon="signal" label="Signal path" onclick={() => (ui.sheet = { kind: 'signal' })} />
      {#if item}
        <IconButton icon="info" label="Track info" onclick={() => (ui.sheet = { kind: 'tech', item })} />
      {/if}
    </div>
  </div>

  <div class="layout">
    <div class="left">
      {#if item}
        <div class="cover" class:paused class:settling={coverSettling} class:enter-left={coverEnter === 'left'}
          class:enter-right={coverEnter === 'right'} role="presentation" onpointerdown={coverDown}
          onpointermove={coverMove} onpointerup={coverUp} onpointercancel={coverCancel}
          onclickcapture={coverClick} onwheel={coverWheel} ondragstart={(e) => e.preventDefault()}
          style:translate={coverX !== 0 ? `${coverX}px 0` : undefined}
          style:opacity={coverX !== 0 ? 1 - Math.min(0.6, Math.abs(coverX) / 400) : undefined}>
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
        <div class="volume">
          <VolumeControl />
          <button type="button" class="output" aria-label="Output: {outputName}"
            onclick={() => (ui.sheet = { kind: 'output' })}>
            <Icon name={deviceIcon(outputName)} size={20} />
            <span class="output-name">{outputName}</span>
          </button>
        </div>
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
    animation: np-open 300ms var(--ease-out);
    transform-origin: 50% 100%;
    will-change: transform;
    /* Fixed over everything, so it pads itself; on Android its gradient shows behind the status bar. */
    padding: var(--sai-top, env(safe-area-inset-top, 0px)) env(safe-area-inset-right, 0px)
      env(safe-area-inset-bottom, 0px) env(safe-area-inset-left, 0px);
  }
  .np.settling {
    transition:
      transform 220ms var(--ease-out),
      opacity 220ms var(--ease-out);
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
    align-items: center;
    justify-content: center;
    gap: var(--space-3);
    flex-wrap: wrap;
  }
  .output {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    min-height: 40px;
    max-width: 14em;
    padding: 0 var(--space-3);
    border: 1px solid var(--glass-border);
    border-radius: 999px;
    background: transparent;
    color: var(--text-muted);
    font: inherit;
    font-size: var(--text-xs);
    cursor: pointer;
    transition: background var(--transition), color var(--transition);
  }
  .output:hover {
    background: var(--hover);
    color: var(--text);
  }
  .output-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .cover,
  .top {
    touch-action: pan-x;
    user-select: none;
  }
  .cover {
    touch-action: none;
    cursor: grab;
  }
  .cover.settling {
    transition:
      translate var(--duration) var(--ease-out),
      opacity var(--duration) var(--ease-out),
      transform var(--duration-slow) var(--ease-out);
  }
  .cover.enter-left {
    animation: cover-in-left 240ms var(--ease-out);
  }
  .cover.enter-right {
    animation: cover-in-right 240ms var(--ease-out);
  }
  @keyframes cover-in-left {
    from { translate: 48px 0; opacity: 0; }
  }
  @keyframes cover-in-right {
    from { translate: -48px 0; opacity: 0; }
  }
  @media (prefers-reduced-motion: reduce) {
    .cover.enter-left, .cover.enter-right { animation: none; }
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
    /* One scrolling column: player first, lyrics/queue panel below it. Children never
       shrink (flex: none), so the panel can't draw over the controls. */
    .layout {
      display: flex;
      flex-direction: column;
      overflow-y: auto;
      overscroll-behavior: contain;
      gap: var(--space-4);
      padding: 0 var(--space-4) var(--space-4);
    }
    /* The player fills the first screen; lyrics / queue start below the fold. */
    .left {
      flex: none;
      justify-content: space-evenly;
      width: min(100%, 520px);
      min-height: 100%;
    }
    .cover {
      width: min(100%, 50vh);
      width: min(100%, 50dvh);
    }
    .right {
      flex: none;
      height: 70vh;
      height: 70dvh;
      min-height: 320px;
      width: 100%;
    }
    .panel {
      overflow-y: auto;
    }
    .controls :global(.transport) {
      gap: var(--space-3);
    }
    .controls :global(.transport .main .icon-btn.primary) {
      width: 64px;
      height: 64px;
    }
    .controls :global(.transport .main svg) {
      width: 28px;
      height: 28px;
    }
  }
  @media (max-width: 480px) {
    .top {
      padding: var(--space-2) var(--space-3);
    }
    .top-right {
      gap: 0;
    }
    .top-right :global(.badge) {
      display: none;
    }
    .layout {
      padding: 0 var(--space-4) var(--space-4);
    }
    .left {
      gap: var(--space-5);
    }
    .tabs button {
      min-height: 40px;
      padding: var(--space-2) var(--space-4);
    }
  }
  @media (hover: none) {
    .output:active,
    .next:active {
      transform: scale(0.96);
      opacity: 0.8;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .np,
    .np.settling {
      animation: none;
      transition: none;
    }
    .cover {
      transition: none;
    }
  }
</style>
