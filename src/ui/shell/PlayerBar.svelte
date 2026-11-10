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
  import { haptic } from '../common/haptics';
  import { classifySwipe } from './swipe';
  import { CLOSE_FRACTION, FLICK_PX_PER_MS, VelocityTracker, decideSkip } from './gestures';

  let { phone = false }: { phone?: boolean } = $props();

  const app = getApp();
  const router = getRouter();
  const ui = getUi();
  const actions = useActions();
  const menuFor = useItemMenu();
  const item = $derived(app.core.player.current);
  const favorite = $derived(item ? app.core.favorites.isFavorite(item) : false);
  const player = app.core.player;
  const progress = $derived(player.durationMs > 0 ? Math.min(1, player.positionMs / player.durationMs) : 0);

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

  // Phone mini player gestures: the card follows the finger. Up opens now playing,
  // sideways skips (track info slides out, the next one slides in), else it snaps back.
  let bar: HTMLElement | undefined = $state();
  let start: { x: number; y: number; id: number } | null = null;
  let mode: 'h' | 'v' | null = null;
  let swiped = false;
  let crossed = false;
  const vel = new VelocityTracker();
  let dragX = $state(0);
  let dragY = $state(0);
  let settling = $state(false);
  let enter = $state<'' | 'left' | 'right'>('');

  function onpointerdown(e: PointerEvent) {
    if (!phone || !item || e.pointerType === 'mouse') return;
    start = { x: e.clientX, y: e.clientY, id: e.pointerId };
    mode = null;
    swiped = false;
    crossed = false;
    settling = false;
    vel.reset();
  }
  function onpointermove(e: PointerEvent) {
    if (!start) return;
    const dx = e.clientX - start.x;
    const dy = e.clientY - start.y;
    if (!mode) {
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
      mode = Math.abs(dx) > Math.abs(dy) ? 'h' : 'v';
      try {
        bar?.setPointerCapture(start.id);
      } catch {
        // capture is best effort
      }
    }
    if (mode === 'h') {
      dragX = dx;
      vel.add(e.timeStamp, dx);
      const c = Math.abs(dx) >= (bar?.clientWidth ?? 360) * CLOSE_FRACTION;
      if (c !== crossed) haptic('tick');
      crossed = c;
    } else {
      dragY = Math.min(0, dy);
      vel.add(e.timeStamp, dy);
      const c = -dy >= 48;
      if (c !== crossed) haptic('tick');
      crossed = c;
    }
  }
  function onpointerup(e: PointerEvent) {
    const s = start;
    start = null;
    if (!s) return;
    const m = mode;
    mode = null;
    const dx = e.clientX - s.x;
    const dy = e.clientY - s.y;
    if (m) swiped = true;
    settling = true;
    if (m === 'v') {
      const v = -vel.get();
      dragY = 0;
      if (-dy >= 48 || v >= FLICK_PX_PER_MS) {
        haptic('tick');
        openNowPlaying();
      }
      return;
    }
    if (m === 'h') {
      const w = bar?.clientWidth ?? 360;
      const verdict = decideSkip(dx, Math.abs(vel.get()), w);
      if (verdict === 'cancel') {
        dragX = 0;
        return;
      }
      haptic('tick');
      dragX = 0;
      enter = verdict === 'next' ? 'left' : 'right';
      setTimeout(() => (enter = ''), 260);
      void actions.guard(() => (verdict === 'next' ? player.next() : player.previous()));
      return;
    }
    // No move events seen (synthetic or very quick flick): classify the whole drag.
    const r = classifySwipe(dx, dy);
    if (r === 'up') openNowPlaying();
    else if (r === 'left' || r === 'right') {
      swiped = true;
      enter = r === 'left' ? 'left' : 'right';
      setTimeout(() => (enter = ''), 260);
      void actions.guard(() => (r === 'left' ? player.next() : player.previous()));
    }
  }
  function oncancel() {
    start = null;
    mode = null;
    settling = true;
    dragX = 0;
    dragY = 0;
  }
  /** A swipe must not also trigger the click of the control it started on. */
  function onclickcapture(e: MouseEvent) {
    if (!swiped) return;
    swiped = false;
    e.stopPropagation();
    e.preventDefault();
  }
  function oncontextmenu(e: MouseEvent) {
    if (item) ui.openMenu(e, menuFor(item));
  }
</script>

<footer
  class="bar"
  class:empty={!item}
  class:phone
  aria-label="Player"
  bind:this={bar}
  {onpointerdown}
  {onpointermove}
  {onpointerup}
  onpointercancel={oncancel}
  {onclickcapture}
  style:transform={phone && dragY !== 0 ? `translateY(${dragY * 0.6}px)` : undefined}
  class:settling
>
  <span class="mini-progress" style:transform="scaleX({progress})" aria-hidden="true"></span>
  <div
    class="now"
    class:enter-left={enter === 'left'}
    class:enter-right={enter === 'right'}
    style:transform={phone && dragX !== 0 ? `translateX(${dragX}px)` : undefined}
    style:opacity={phone && dragX !== 0 ? 1 - Math.min(0.7, Math.abs(dragX) / 300) : undefined}
    {oncontextmenu}
    role="presentation"
  >
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
    <IconButton icon="sliders" label="Output" onclick={() => (ui.sheet = { kind: 'output' })} />
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
    will-change: auto;
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
  .mini-progress {
    display: none;
  }
  .settling .now,
  .bar.settling {
    transition:
      transform var(--duration) var(--ease-out),
      opacity var(--duration) var(--ease-out);
  }
  .now.enter-left {
    animation: track-in-left 240ms var(--ease-out);
  }
  .now.enter-right {
    animation: track-in-right 240ms var(--ease-out);
  }
  @media (hover: none) {
    .bar :global(.icon-btn:active),
    .art:active {
      transform: scale(0.96);
      opacity: 0.8;
    }
  }
  @media (max-width: 720px) and (min-width: 641px) {
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
  /* Phone: a floating rounded card above the content; tap or swipe up for now playing. */
  @media (max-width: 640px) {
    .bar {
      position: fixed;
      left: var(--space-2);
      right: var(--space-2);
      bottom: var(--space-2);
      z-index: calc(var(--z-sticky) + 5);
      grid-template-columns: minmax(0, 1fr) auto;
      gap: var(--space-2);
      height: 64px;
      padding: 0 var(--space-2) 0 var(--space-2);
      border: 1px solid var(--glass-border);
      border-radius: var(--radius-lg);
      background: color-mix(in srgb, var(--accent) 18%, var(--surface-2));
      backdrop-filter: none;
      box-shadow: var(--shadow-2);
      overflow: hidden;
      touch-action: none;
      user-select: none;
      -webkit-tap-highlight-color: transparent;
    }
    .bar.empty {
      display: none;
    }
    .art {
      border-radius: var(--radius-md);
    }
    .art :global(.art) {
      width: 44px !important;
      height: 44px !important;
    }
    .expand {
      display: none;
    }
    .now :global(.icon-btn),
    .right,
    .center :global(.seek),
    .center :global([aria-label='Previous']),
    .center :global([aria-label='Shuffle']),
    .center :global([aria-label^='Repeat']) {
      display: none;
    }
    .center {
      width: auto;
    }
    .center :global(.icon-btn) {
      min-width: 44px;
      min-height: 44px;
    }
    .title,
    .artist {
      min-height: 22px;
    }
    .title:hover,
    .artist:hover {
      text-decoration: none;
    }
    .mini-progress {
      display: block;
      position: absolute;
      left: var(--space-3);
      right: var(--space-3);
      bottom: 0;
      height: 2px;
      border-radius: 2px;
      background: var(--accent);
      transform-origin: left;
    }
  }
</style>
