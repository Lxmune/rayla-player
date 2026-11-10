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
  import { classifySwipe, preloadNeighbours } from './swipe';
  import {
    FLICK_PX_PER_MS, SETTLE_EASING, VelocityTracker, carouselOffset, decideCarousel, neighbourIndices,
    pastThreshold, peekDirection, settleDuration, settleTarget, type SkipDir,
  } from './gestures';
  import { prefersReducedMotion } from '../common/touch';
  import { tick } from 'svelte';
  import type { BaseItem } from '../../lib/jellyfin/models';

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

  // Mini player gestures. Sideways (track info strip): the neighbour's cover + title peek in beside the
  // current ones and follow the finger; on commit the strip settles, THEN the player switches and the
  // strip resets once the new cover painted. Up (phone) opens now playing. Imperative transforms only.
  let bar: HTMLElement | undefined = $state();
  let slider: HTMLElement | undefined = $state();
  let start: { x: number; y: number; id: number; hasPrev: boolean; hasNext: boolean } | null = null;
  let mode: 'h' | 'v' | null = null;
  let swiped = false;
  let crossed = false;
  let busy = false;
  let dist = 0;
  let curOffset = 0;
  let anim: Animation | null = null;
  const vel = new VelocityTracker();
  let dragY = $state(0);
  let settling = $state(false);
  let live = $state(false);
  let peek = $state.raw<{ dir: SkipDir; item: BaseItem } | null>(null);
  const nb = $derived(neighbourIndices(player.index, player.queue.length, player.repeat));

  function neighbourItem(dir: SkipDir): BaseItem | null {
    if (dir === 'previous' && player.positionMs > 3000) return null; // previous() restarts the track
    const i = dir === 'next' ? nb.next : nb.previous;
    return i === null ? null : (player.queue[i]?.item ?? null);
  }

  // Decode neighbour covers (56 px, what this bar renders) and backdrops ahead of time.
  $effect(() => {
    const q = player.queue;
    const items = [nb.previous, nb.next, player.nextIndex].map((i) => (i === null ? null : (q[i]?.item ?? null)));
    preloadNeighbours(app.core.sessions.client, items, [56]);
  });

  const tx = (px: number) => `translate3d(${px}px,0,0)`;
  function setOffset(px: number) {
    curOffset = px;
    if (slider) slider.style.transform = px === 0 ? '' : tx(px);
  }
  function resetSlider() {
    anim?.cancel();
    anim = null;
    if (slider) slider.style.transform = '';
    curOffset = 0;
    peek = null;
    live = false;
  }
  async function slideTo(from: number, to: number, ms: number): Promise<void> {
    anim?.cancel();
    anim = null;
    curOffset = to;
    if (!slider || typeof slider.animate !== 'function' || ms <= 0) {
      setOffset(to);
      return;
    }
    anim = slider.animate([{ transform: tx(from) }, { transform: tx(to) }], {
      duration: ms,
      easing: SETTLE_EASING,
      fill: 'forwards',
    });
    await anim.finished.catch(() => undefined);
  }
  const frame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));

  async function commitSkip(dir: SkipDir, from: number, velocity: number) {
    if (busy) return;
    const it = neighbourItem(dir);
    haptic('tick');
    if (!it || prefersReducedMotion()) {
      resetSlider();
      void actions.guard(() => (dir === 'next' ? player.next() : player.previous()));
      return;
    }
    busy = true;
    dist = slider?.clientWidth || bar?.clientWidth || 300;
    live = true;
    if (peek?.dir !== dir) {
      peek = { dir, item: it };
      await tick();
    }
    const target = settleTarget(dir, dist);
    await slideTo(from, target, settleDuration(from, target, velocity));
    const before = player.index;
    void actions.guard(() => (dir === 'next' ? player.next() : player.previous()));
    await tick();
    await frame();
    await frame();
    if (player.index === before) await slideTo(target, 0, 200);
    resetSlider();
    busy = false;
  }
  async function springBack(velocity: number) {
    busy = true;
    await slideTo(curOffset, 0, settleDuration(curOffset, 0, velocity));
    resetSlider();
    busy = false;
  }

  function onpointerdown(e: PointerEvent) {
    if (!item || e.pointerType === 'mouse' || busy) return;
    // Wide layouts (touch screens): only the track info area swipes, sideways only.
    if (!phone && !(e.target as Element | null)?.closest('.now')) return;
    start = {
      x: e.clientX, y: e.clientY, id: e.pointerId,
      hasPrev: neighbourItem('previous') !== null, hasNext: neighbourItem('next') !== null,
    };
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
      if (!phone && mode === 'v') {
        start = null;
        mode = null;
        return;
      }
      if (mode === 'h') {
        dist = slider?.clientWidth || bar?.clientWidth || 300; // read once per drag
        live = true;
      }
      try {
        bar?.setPointerCapture(start.id);
      } catch {
        // capture is best effort
      }
    }
    if (mode === 'h') {
      const dir = peekDirection(dx);
      const wanted = dir && (dir === 'next' ? start.hasNext : start.hasPrev) ? dir : null;
      if (wanted && peek?.dir !== wanted) {
        const it = neighbourItem(wanted);
        if (it) peek = { dir: wanted, item: it };
      } else if (!wanted && peek) peek = null;
      setOffset(carouselOffset(dx, dist, start.hasPrev, start.hasNext));
      vel.add(e.timeStamp, dx);
      const c = pastThreshold(Math.abs(dx), dist);
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
    if (m === 'v') {
      settling = true;
      const v = -vel.get();
      dragY = 0;
      if (-dy >= 48 || v >= FLICK_PX_PER_MS) {
        haptic('tick');
        openNowPlaying();
      }
      return;
    }
    if (m === 'h') {
      const v = vel.get();
      const verdict = decideCarousel(dx, v, dist, s.hasPrev, s.hasNext);
      if (verdict !== 'cancel') return void commitSkip(verdict, curOffset, v);
      if (!s.hasPrev && dx > 0 && player.positionMs > 3000
        && decideCarousel(dx, v, dist, true, true) === 'previous') {
        haptic('tick');
        void actions.guard(() => player.previous());
      }
      void springBack(v);
      return;
    }
    // No move events seen (synthetic or very quick flick): classify the whole drag.
    const r = classifySwipe(dx, dy);
    if (r === 'up') openNowPlaying();
    else if (r === 'left' || r === 'right') {
      swiped = true;
      void commitSkip(r === 'left' ? 'next' : 'previous', 0, 0);
    }
  }
  function oncancel() {
    const wasH = mode === 'h';
    start = null;
    mode = null;
    settling = true;
    dragY = 0;
    if (wasH) void springBack(0);
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
  <div class="now" {oncontextmenu} role="presentation">
    {#if item}
      <div class="slider" class:live bind:this={slider}>
        <button type="button" class="art" aria-label="Open now playing" onclick={openNowPlaying}>
          <Artwork {item} size={56} />
          <span class="expand"><Icon name="expand" size={20} /></span>
        </button>
        <span class="text">
          <button type="button" class="title" onclick={openNowPlaying}>{item.name}</button>
          <!-- On phones the whole middle opens the player (the artist is one tap away there). -->
          <button type="button" class="artist" onclick={phone ? openNowPlaying : openArtist}>{artistLine(item)}</button>
        </span>
        <IconButton
          icon={favorite ? 'heartFill' : 'heart'}
          label={favorite ? 'Remove from favorites' : 'Add to favorites'}
          size={18}
          active={favorite}
          onclick={() => void actions.toggleFavorite(item)}
        />
        {#if peek}
          <div class="peek" class:before={peek.dir === 'previous'} aria-hidden="true">
            <span class="art"><Artwork item={peek.item} size={56} /></span>
            <span class="text">
              <span class="title">{peek.item.name}</span>
              <span class="artist">{artistLine(peek.item)}</span>
            </span>
          </div>
        {/if}
      </div>
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
  /* Desktop: track info | transport + seek | extras. Hairline top border, no shadows. */
  .bar {
    position: relative;
    display: grid;
    grid-template-columns: minmax(180px, 1fr) minmax(280px, 2fr) minmax(180px, 1fr);
    align-items: center;
    gap: var(--space-5);
    height: var(--playerbar-height);
    padding: 0 var(--space-5);
    background: color-mix(in srgb, var(--accent) 4%, var(--bg));
    border-top: 1px solid var(--glass-border);
    transition: background var(--accent-transition);
  }
  .now {
    position: relative;
    overflow: hidden;
    touch-action: pan-y;
    min-width: 0;
  }
  .slider {
    position: relative;
    display: flex;
    align-items: center;
    gap: var(--space-3);
    min-width: 0;
  }
  .slider.live {
    will-change: transform;
  }
  .peek {
    position: absolute;
    top: 0;
    bottom: 0;
    left: 100%;
    width: 100%;
    display: flex;
    align-items: center;
    gap: var(--space-3);
    pointer-events: none;
  }
  .peek.before {
    left: auto;
    right: 100%;
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
  .bar.settling {
    transition:
      transform var(--duration) var(--ease-out),
      opacity var(--duration) var(--ease-out);
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
  /* Phone: a floating card, subtle cover-tinted surface, no shadow, thin progress line on its bottom edge. */
  @media (max-width: 640px) {
    .bar {
      position: fixed;
      left: var(--space-2);
      right: var(--space-2);
      bottom: var(--space-2);
      z-index: calc(var(--z-sticky) + 5);
      grid-template-columns: minmax(0, 1fr) auto;
      gap: var(--space-2);
      height: 60px;
      padding: 0 var(--space-1) 0 var(--space-2);
      border: 1px solid var(--glass-border);
      border-radius: 14px;
      background: color-mix(in srgb, var(--accent) 10%, var(--surface-2));
      box-shadow: none;
      overflow: hidden;
      touch-action: none;
      user-select: none;
      -webkit-tap-highlight-color: transparent;
    }
    .bar.empty {
      display: none;
    }
    .art {
      border-radius: 10px;
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
      left: 0;
      right: 0;
      bottom: 0;
      height: 2px;
      background: var(--accent);
      transform-origin: left;
    }
  }
</style>
