<script lang="ts">
  import { getApp } from '../../lib/app.svelte';
  import Slider from './Slider.svelte';
  import { formatTime } from './format';
  import { useActions } from './actions';
  import { createPlaybackClock } from './playback-clock.svelte';

  const app = getApp();
  const actions = useActions();
  const player = app.core.player;
  const clock = createPlaybackClock(player);
  const STORAGE_KEY = 'rayla.showRemaining';

  function loadRemaining(): boolean {
    try {
      return localStorage.getItem(STORAGE_KEY) === '1';
    } catch {
      return false;
    }
  }
  let showRemaining = $state(loadRemaining());
  function toggleRemaining() {
    showRemaining = !showRemaining;
    try {
      localStorage.setItem(STORAGE_KEY, showRemaining ? '1' : '0');
    } catch {
      // storage unavailable: the choice just is not remembered
    }
  }

  let preview = $state<number | null>(null);
  let hover = $state<{ x: number; ms: number } | null>(null);
  const shownSec = $derived(preview === null ? clock.seconds * 1000 : Math.floor(preview / 1000) * 1000);
  const max = $derived(Math.max(player.durationMs, 1));
  const endText = $derived(
    showRemaining ? `-${formatTime(Math.max(0, player.durationMs - shownSec))}` : formatTime(player.durationMs),
  );

  function onmove(e: PointerEvent) {
    if (e.pointerType !== 'mouse' || !player.current || player.durationMs <= 0) return;
    const r = e.currentTarget instanceof HTMLElement ? e.currentTarget.getBoundingClientRect() : null;
    if (!r || r.width === 0) return;
    const f = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    hover = { x: f * r.width, ms: f * player.durationMs };
  }
</script>

<div class="seek">
  <span class="time">{formatTime(shownSec)}</span>
  <div
    class="bar"
    class:buffering={player.playback === 'buffering'}
    role="presentation"
    onpointermove={onmove}
    onpointerleave={() => (hover = null)}
  >
    {#if hover}
      <span class="tip" style:left="{hover.x}px" aria-hidden="true">{formatTime(hover.ms)}</span>
    {/if}
    <Slider
      label="Seek"
      value={Math.min(clock.ms, max)}
      bubble={formatTime}
      min={0}
      {max}
      step={1000}
      disabled={!player.current}
      valueText={`${formatTime(shownSec)} of ${formatTime(player.durationMs)}`}
      onpreview={(v) => (preview = v)}
      oncommit={(v) => {
        preview = null;
        void actions.guard(() => player.seek(v));
      }}
    />
  </div>
  <button
    type="button"
    class="time end"
    aria-pressed={showRemaining}
    title={showRemaining ? 'Show total duration' : 'Show remaining time'}
    onclick={toggleRemaining}>{endText}</button
  >
</div>

<style>
  .seek {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    width: 100%;
  }
  .bar {
    position: relative;
    flex: 1;
    min-width: 0;
  }
  .bar.buffering {
    animation: pulse 1.2s var(--ease-in-out) infinite;
  }
  @keyframes pulse {
    50% {
      opacity: 0.55;
    }
  }
  .tip {
    position: absolute;
    bottom: 100%;
    transform: translateX(-50%);
    padding: 2px var(--space-2);
    border-radius: var(--radius-sm);
    background: var(--glass);
    border: 1px solid var(--glass-border);
    font-size: var(--text-xs);
    font-variant-numeric: tabular-nums;
    pointer-events: none;
    white-space: nowrap;
  }
  .time {
    flex: none;
    min-width: 40px;
    text-align: center;
    font-size: var(--text-xs);
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
  }
  .end {
    border: 0;
    background: transparent;
    padding: 2px 0;
    cursor: pointer;
    border-radius: var(--radius-sm);
  }
  .end:hover {
    color: var(--text);
  }
  @media (prefers-reduced-motion: reduce) {
    .bar.buffering {
      animation: none;
    }
  }
</style>
