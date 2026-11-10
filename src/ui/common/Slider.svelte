<script lang="ts">
  import { haptic } from './haptics';

  let {
    value,
    min = 0,
    max = 1,
    step = 0.01,
    label,
    valueText,
    disabled = false,
    oncommit,
    onpreview,
    bubble,
  }: {
    value: number;
    min?: number;
    max?: number;
    step?: number;
    label: string;
    valueText?: string;
    disabled?: boolean;
    /** Fired when the user releases / confirms a value. */
    oncommit: (v: number) => void;
    /** Fired continuously while dragging. */
    onpreview?: (v: number) => void;
    /** Text for a bubble above the thumb while scrubbing by touch. */
    bubble?: (v: number) => string;
  } = $props();

  let dragging = $state<number | null>(null);
  let touching = $state(false);
  let hit = $state<HTMLElement | null>(null);
  let pointerId = -1;
  let startX = 0;
  const shown = $derived(dragging ?? value);
  const pct = $derived(max > min ? Math.min(100, Math.max(0, ((shown - min) / (max - min)) * 100)) : 0);

  function snap(v: number): number {
    const rounded = Math.round((v - min) / step) * step + min;
    return Math.min(max, Math.max(min, Number(rounded.toFixed(6))));
  }

  function valueAt(clientX: number): number {
    const r = hit?.getBoundingClientRect();
    if (!r || r.width === 0) return shown;
    const f = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
    return snap(min + f * (max - min));
  }

  function down(e: PointerEvent) {
    if (disabled || (e.pointerType === 'mouse' && e.button !== 0)) return;
    pointerId = e.pointerId;
    startX = e.clientX;
    touching = e.pointerType !== 'mouse';
    try {
      hit?.setPointerCapture(e.pointerId);
    } catch {
      // capture is best effort
    }
    haptic('tick');
    dragging = valueAt(e.clientX);
    onpreview?.(dragging);
  }

  function move(e: PointerEvent) {
    if (e.pointerId !== pointerId || dragging === null) return;
    const v = valueAt(e.clientX);
    if (v === dragging) return;
    dragging = v;
    onpreview?.(v);
  }

  function up(e: PointerEvent) {
    if (e.pointerId !== pointerId || dragging === null) return;
    const v = valueAt(e.clientX);
    pointerId = -1;
    dragging = null;
    touching = false;
    haptic('tick');
    oncommit(v);
  }

  /** The browser took the gesture (vertical scroll): drop it without committing. */
  function cancel(e: PointerEvent) {
    if (e.pointerId !== pointerId) return;
    pointerId = -1;
    if (dragging !== null) onpreview?.(value);
    dragging = null;
    touching = false;
  }

  /** Mouse wheel nudges the value (5 steps on fine-grained ranges). */
  function wheel(node: HTMLElement) {
    const onwheel = (e: WheelEvent) => {
      if (disabled || e.deltaY === 0) return;
      e.preventDefault();
      const jump = (max - min) / step > 50 ? step * 5 : step;
      const v = snap((dragging ?? value) + (e.deltaY < 0 ? jump : -jump));
      onpreview?.(v);
      oncommit(v);
    };
    node.addEventListener('wheel', onwheel, { passive: false });
    return { destroy: () => node.removeEventListener('wheel', onwheel) };
  }
</script>

<div
  class="hit"
  class:disabled
  class:active={dragging !== null}
  role="presentation"
  bind:this={hit}
  style:--fill="{pct}%"
  onpointerdown={down}
  onpointermove={move}
  onpointerup={up}
  onpointercancel={cancel}
  use:wheel
>
  <div class="track"><div class="fill"></div></div>
  <div class="thumb"></div>
  {#if bubble && touching && dragging !== null}
    <span class="bubble" aria-hidden="true">{bubble(dragging)}</span>
  {/if}
  <input
    type="range"
    class="native"
    aria-label={label}
    aria-valuetext={valueText}
    {min}
    {max}
    {step}
    {disabled}
    value={shown}
    oninput={(e) => {
      dragging = e.currentTarget.valueAsNumber;
      onpreview?.(dragging);
    }}
    onchange={(e) => {
      const v = e.currentTarget.valueAsNumber;
      dragging = null;
      oncommit(v);
    }}
  />
</div>

<style>
  .hit {
    --track: 4px;
    --thumb: 14px;
    position: relative;
    width: 100%;
    height: 44px;
    margin: -12px 0; /* 44px target inside a ~20px layout slot */
    display: flex;
    align-items: center;
    cursor: pointer;
    touch-action: pan-y; /* horizontal drags are ours, vertical scroll stays native */
    user-select: none;
    -webkit-tap-highlight-color: transparent;
    --bar: var(--text);
  }
  .hit.disabled {
    opacity: 0.35;
    cursor: default;
  }
  .hit:hover:not(.disabled),
  .hit:has(.native:focus-visible),
  .hit.active {
    --track: 6px;
    --bar: var(--accent);
  }
  .track {
    flex: 1;
    height: var(--track);
    border-radius: 999px;
    background: var(--border);
    overflow: hidden;
    transition: height var(--duration-fast) var(--ease-out);
  }
  .fill {
    width: var(--fill);
    height: 100%;
    background: var(--bar);
  }
  .thumb {
    position: absolute;
    top: 50%;
    left: var(--fill);
    width: var(--thumb);
    height: var(--thumb);
    margin: calc(var(--thumb) / -2) 0 0 calc(var(--thumb) / -2);
    border-radius: 50%;
    background: var(--text);
    box-shadow: 0 1px 4px rgb(0 0 0 / 0.4);
    transform: scale(0);
    transition: transform var(--duration-fast) var(--ease-out);
    pointer-events: none;
  }
  .hit:hover:not(.disabled) .thumb,
  .hit:has(.native:focus-visible) .thumb {
    transform: scale(1);
  }
  .hit.active .thumb {
    transform: scale(1.5);
  }
  @media (pointer: coarse) {
    .thumb {
      transform: scale(0.85); /* always visible on touch */
    }
    .hit.active .thumb {
      transform: scale(1.6);
    }
  }
  .hit:has(.native:focus-visible) {
    outline: 2px solid var(--accent);
    outline-offset: -8px;
    border-radius: 8px;
  }
  .native {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    margin: 0;
    opacity: 0;
    pointer-events: none;
  }
  .bubble {
    position: absolute;
    left: var(--fill);
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
  @media (prefers-reduced-motion: reduce) {
    .track,
    .thumb {
      transition: none;
    }
  }
</style>
