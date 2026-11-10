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
  import { onDestroy, onMount, tick } from 'svelte';
  import { haptic } from '../common/haptics';
  import {
    CAROUSEL_GAP, SETTLE_EASING, VelocityTracker, WheelSwipe, carouselOffset, carouselProgress, decideCarousel,
    decideCoverDrag, decideRelease, neighbourIndices, pastThreshold, peekDirection, settleDuration, settleTarget,
    sheetDragStyle, type SkipDir,
  } from '../shell/gestures';
  import { preloadNeighbours } from '../shell/swipe';
  import type { BaseItem } from '../../lib/jellyfin/models';
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

  // Cover carousel: the neighbour cover peeks in beside the current one and follows the finger
  // (1:1, rubber band where there is no neighbour). On commit the strip settles with the neighbour
  // centred, THEN the player switches; the strip is only reset once the new current cover painted.
  // Per-move work is imperative transform/opacity writes (no reactive layout).
  let cover: { x: number; y: number; id: number; mode: 'h' | 'v' | null; hasPrev: boolean; hasNext: boolean } | null =
    null;
  let coverSwiped = false;
  let coverCrossed = false;
  let coverEl: HTMLElement | undefined = $state();
  let strip: HTMLElement | undefined = $state();
  let titlesEl: HTMLElement | undefined = $state();
  let tslider: HTMLElement | undefined = $state();
  let tcur: HTMLElement | undefined = $state();
  let tpeek: HTMLElement | undefined = $state();
  let peek = $state.raw<{ dir: SkipDir; item: BaseItem } | null>(null);
  let dragLive = $state(false);
  let busy = false;
  let dist = 0;
  let tdist = 0;
  let curOffset = 0;
  let anims: Animation[] = [];
  const coverVel = new VelocityTracker();
  const wheel = new WheelSwipe();
  const nb = $derived(neighbourIndices(player.index, player.queue.length, player.repeat));

  function neighbourItem(dir: SkipDir): BaseItem | null {
    // previous() restarts the track after 3 s instead of going back: no neighbour to show then.
    if (dir === 'previous' && player.positionMs > 3000) return null;
    const i = dir === 'next' ? nb.next : nb.previous;
    return i === null ? null : (player.queue[i]?.item ?? null);
  }

  // Decode the neighbours' covers (exact sizes rendered here) and backdrops ahead of any skip.
  $effect(() => {
    const q = player.queue;
    const items = [nb.previous, nb.next, player.nextIndex].map((i) => (i === null ? null : (q[i]?.item ?? null)));
    preloadNeighbours(app.core.sessions.client, items, [640, 40]);
  });

  function measure() {
    dist = (coverEl?.clientWidth ?? 300) + CAROUSEL_GAP;
    tdist = titlesEl?.clientWidth ?? 0;
  }
  const tx = (px: number) => (px === 0 ? 'translate3d(0,0,0)' : `translate3d(${px}px,0,0)`);

  function applyOffset(px: number) {
    curOffset = px;
    const p = carouselProgress(px, dist);
    const tpx = dist > 0 ? (px / dist) * tdist : 0;
    if (strip) strip.style.transform = tx(px);
    if (tslider) tslider.style.transform = tx(tpx);
    if (tcur) tcur.style.opacity = String(1 - p);
    if (tpeek) tpeek.style.opacity = String(p);
  }
  function resetStrip() {
    for (const a of anims) a.cancel();
    anims = [];
    for (const el of [strip, tslider, tcur, tpeek]) {
      if (el) {
        el.style.transform = '';
        el.style.opacity = '';
      }
    }
    curOffset = 0;
    peek = null;
    dragLive = false;
  }
  /** Animates the strip (and the titles with it) from `from` to `to`; resolves when finished. */
  async function slideTo(from: number, to: number, ms: number): Promise<void> {
    for (const a of anims) a.cancel();
    anims = [];
    const ratio = dist > 0 ? tdist / dist : 0;
    const p0 = carouselProgress(from, dist);
    const p1 = carouselProgress(to, dist);
    curOffset = to;
    const run = (el: HTMLElement | undefined, kf: Keyframe[]) => {
      if (!el || typeof el.animate !== 'function' || ms <= 0) return null;
      const a = el.animate(kf, { duration: ms, easing: SETTLE_EASING, fill: 'forwards' });
      anims.push(a);
      return a.finished.catch(() => undefined);
    };
    const done = [
      run(strip, [{ transform: tx(from) }, { transform: tx(to) }]),
      run(tslider, [{ transform: tx(from * ratio) }, { transform: tx(to * ratio) }]),
      run(tcur, [{ opacity: 1 - p0 }, { opacity: 1 - p1 }]),
      run(tpeek, [{ opacity: p0 }, { opacity: p1 }]),
    ].filter((x) => x !== null);
    if (done.length === 0) {
      applyOffset(to);
      return;
    }
    await Promise.all(done);
  }
  const frame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));

  /** Slide to the neighbour, then switch the player; resets once the new cover is on screen. */
  async function commitSkip(dir: SkipDir, from: number, velocity: number) {
    if (busy) return;
    const it = neighbourItem(dir);
    if (!it || prefersReducedMotion()) {
      haptic('tick');
      resetStrip();
      void actions.guard(() => (dir === 'next' ? player.next() : player.previous()));
      return;
    }
    busy = true;
    haptic('tick');
    measure();
    dragLive = true;
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
    resetStrip();
    busy = false;
  }
  function skip(dir: SkipDir) {
    if (busy) return;
    if (!neighbourItem(dir)) {
      // Wheel at the queue's end does nothing; before 3 s / at the start `previous` restarts the track.
      if (dir === 'previous') void actions.guard(() => player.previous());
      return;
    }
    void commitSkip(dir, 0, 0);
  }
  async function springBack(velocity: number) {
    busy = true;
    measure();
    await slideTo(curOffset, 0, settleDuration(curOffset, 0, velocity));
    resetStrip();
    busy = false;
  }

  function coverDown(e: PointerEvent) {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    tapStart = { x: e.clientX, y: e.clientY };
    if (busy || lyricsOpen) return;
    swipeStart(e);
    cover = {
      x: e.clientX, y: e.clientY, id: e.pointerId, mode: null,
      hasPrev: neighbourItem('previous') !== null, hasNext: neighbourItem('next') !== null,
    };
    coverSwiped = false;
    coverCrossed = false;
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
      measure(); // widths are read once per drag
      dragLive = true;
      try {
        (e.currentTarget as HTMLElement).setPointerCapture(c.id);
      } catch {
        // best effort
      }
    }
    if (c.mode === 'v') return swipeMove(e);
    const dir = peekDirection(dx);
    const wanted = dir && (dir === 'next' ? c.hasNext : c.hasPrev) ? dir : null;
    if (wanted && peek?.dir !== wanted) {
      const it = neighbourItem(wanted);
      if (it) peek = { dir: wanted, item: it };
    } else if (!wanted && peek) peek = null;
    applyOffset(carouselOffset(dx, dist, c.hasPrev, c.hasNext));
    coverVel.add(e.timeStamp, dx);
    const past = pastThreshold(Math.abs(dx), dist);
    if (past !== coverCrossed) haptic('tick');
    coverCrossed = past;
  }
  function coverUp(e: PointerEvent) {
    const c = cover;
    cover = null;
    if (c?.mode !== 'h') return swipeEnd(e);
    coverSwiped = true;
    const dx = e.clientX - c.x;
    const v = coverVel.get();
    const verdict = decideCarousel(dx, v, dist, c.hasPrev, c.hasNext);
    if (verdict !== 'cancel') return void commitSkip(verdict, curOffset, v);
    // Past 3 s a right swipe restarts the track (previous()): spring back and do that.
    if (!c.hasPrev && dx > 0 && player.index >= 0 && player.positionMs > 3000
      && decideCarousel(dx, v, dist, true, true) === 'previous') {
      haptic('tick');
      void actions.guard(() => player.previous());
    }
    void springBack(v);
  }
  function coverCancel() {
    if (cover?.mode === 'h') void springBack(0);
    cover = null;
    swipeCancel();
  }
  function coverClick(e: MouseEvent) {
    if (!coverSwiped) return;
    coverSwiped = false;
    e.stopPropagation();
    e.preventDefault();
  }

  // Tap on the cover flips it to large lyrics and back. Lines / buttons inside keep their own click.
  let tapStart: { x: number; y: number } | null = null;
  let lyricsOpen = $state(false);
  let lyricsReady = $state(false);
  function coverTap(e: MouseEvent) {
    if ((e.target as HTMLElement).closest('button')) return;
    const t = tapStart;
    if (t && Math.hypot(e.clientX - t.x, e.clientY - t.y) > 10) return;
    toggleLyrics();
  }
  function toggleLyrics() {
    lyricsOpen = !lyricsOpen;
    if (!lyricsOpen) lyricsReady = false;
  }
  function lyricsLoaded(has: boolean) {
    if (!lyricsOpen) return;
    if (has) lyricsReady = true;
    else {
      lyricsOpen = false;
      lyricsReady = false;
      ui.toast('No lyrics');
    }
  }
  function seekLine(ms: number) {
    haptic('tick');
    void actions.guard(() => player.seek(ms));
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
        <IconButton icon="lyrics" label={lyricsOpen ? 'Show cover' : 'Show lyrics'} onclick={toggleLyrics} />
        <IconButton icon="info" label="Track info" onclick={() => (ui.sheet = { kind: 'tech', item })} />
      {/if}
    </div>
  </div>

  <div class="layout">
    <div class="left">
      {#if item}
        <div class="cover" class:paused class:live={dragLive} class:lyrics={lyricsOpen} role="presentation" bind:this={coverEl}
          onpointerdown={coverDown} onpointermove={coverMove} onpointerup={coverUp} onpointercancel={coverCancel}
          onclickcapture={coverClick} onclick={coverTap} onwheel={coverWheel} ondragstart={(e) => e.preventDefault()}>
          {#if lyricsOpen}
            <div class="cover-lyrics" class:ready={lyricsReady}>
              {#key item.id}
                <Lyrics {item} large positionMs={player.positionMs} onseek={seekLine} onloaded={lyricsLoaded} />
              {/key}
            </div>
          {/if}
          <div class="strip" class:hidden={lyricsReady} bind:this={strip}>
            <div class="slide"><Artwork {item} size={640} fill /></div>
            {#if peek}
              <div class="slide peek" class:before={peek.dir === 'previous'} aria-hidden="true">
                <Artwork item={peek.item} size={640} fill />
              </div>
            {/if}
          </div>
        </div>
        <div class="meta">
          <div class="titles" class:live={dragLive} bind:this={titlesEl}>
            <div class="tslider" bind:this={tslider}>
              <div class="tcur" bind:this={tcur}>
                <h1>{item.name}</h1>
                <p class="sub">
                  <button type="button" class="link" onclick={() => void openArtist()}>{artistLine(item)}</button>
                  {#if item.album}
                    <span aria-hidden="true">·</span>
                    <button type="button" class="link" onclick={() => void openAlbum()}>{item.album}</button>
                  {/if}
                </p>
              </div>
              {#if peek}
                <div class="tpeek" class:before={peek.dir === 'previous'} bind:this={tpeek} aria-hidden="true">
                  <h1>{peek.item.name}</h1>
                  <p class="sub">{artistLine(peek.item)}{peek.item.album ? ` · ${peek.item.album}` : ''}</p>
                </div>
              {/if}
            </div>
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
    overflow: hidden;
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
    position: relative;
    width: min(100%, 48vh);
    margin: 0 auto;
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
    flex: 1;
    overflow: hidden;
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
  .strip {
    position: relative;
    transition: opacity var(--duration) var(--ease-out);
  }
  .strip.hidden {
    opacity: 0;
  }
  .cover.lyrics {
    touch-action: pan-y;
    cursor: pointer;
  }
  .cover-lyrics {
    position: absolute;
    inset: 0;
    z-index: 1;
    border-radius: var(--radius-lg);
    overflow: hidden;
    background: var(--surface-2);
    opacity: 0;
    pointer-events: none;
    transition: opacity var(--duration) var(--ease-out);
  }
  .cover-lyrics.ready {
    opacity: 1;
    pointer-events: auto;
  }
  :global(:root[data-motion='reduced']) .strip,
  :global(:root[data-motion='reduced']) .cover-lyrics {
    transition: none;
  }
  .cover.live .strip {
    will-change: transform;
  }
  .slide {
    border-radius: var(--radius-lg);
    overflow: hidden;
    box-shadow: var(--art-shadow);
  }
  .slide.peek {
    position: absolute;
    top: 0;
    width: 100%;
    left: calc(100% + 16px);
    pointer-events: none;
  }
  .slide.peek.before {
    left: auto;
    right: calc(100% + 16px);
  }
  .tslider {
    position: relative;
  }
  .titles.live .tslider {
    will-change: transform;
  }
  .tpeek {
    position: absolute;
    top: 0;
    width: 100%;
    left: 100%;
    opacity: 0;
    pointer-events: none;
  }
  .tpeek.before {
    left: auto;
    right: 100%;
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
