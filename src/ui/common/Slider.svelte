<script lang="ts">
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
  } = $props();

  let dragging = $state<number | null>(null);
  const shown = $derived(dragging ?? value);
  const pct = $derived(max > min ? Math.min(100, Math.max(0, ((shown - min) / (max - min)) * 100)) : 0);

  /** Mouse wheel nudges the value (5 steps on fine-grained ranges). */
  function wheel(node: HTMLInputElement) {
    const onwheel = (e: WheelEvent) => {
      if (disabled || e.deltaY === 0) return;
      e.preventDefault();
      const jump = (max - min) / step > 50 ? step * 5 : step;
      const base = dragging ?? value;
      const next = Math.min(max, Math.max(min, base + (e.deltaY < 0 ? jump : -jump)));
      const rounded = Math.round(next / step) * step;
      const v = Math.min(max, Math.max(min, Number(rounded.toFixed(6))));
      onpreview?.(v);
      oncommit(v);
    };
    node.addEventListener('wheel', onwheel, { passive: false });
    return { destroy: () => node.removeEventListener('wheel', onwheel) };
  }
</script>

<input
  type="range"
  class="slider"
  aria-label={label}
  aria-valuetext={valueText}
  {min}
  {max}
  {step}
  {disabled}
  value={shown}
  style:--fill="{pct}%"
  use:wheel
  oninput={(e) => {
    dragging = e.currentTarget.valueAsNumber;
    onpreview?.(dragging);
  }}
  onchange={(e) => {
    dragging = null;
    oncommit(e.currentTarget.valueAsNumber);
  }}
/>

<style>
  .slider {
    --track: 4px;
    --thumb: 12px;
    -webkit-appearance: none;
    appearance: none;
    width: 100%;
    height: 20px;
    margin: 0;
    background: transparent;
    cursor: pointer;
    --bar: var(--text);
  }
  .slider:disabled {
    opacity: 0.35;
    cursor: default;
  }
  .slider:hover:not(:disabled),
  .slider:focus-visible {
    --track: 6px;
    --bar: var(--accent);
  }
  .slider:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
    border-radius: 4px;
  }
  .slider::-webkit-slider-runnable-track {
    height: var(--track);
    border-radius: 999px;
    background: linear-gradient(to right, var(--bar) var(--fill), var(--border) var(--fill));
    transition: height var(--duration-fast) var(--ease-out);
  }
  .slider::-moz-range-track {
    height: var(--track);
    border-radius: 999px;
    background: var(--border);
  }
  .slider::-moz-range-progress {
    height: var(--track);
    border-radius: 999px;
    background: var(--bar);
  }
  .slider::-webkit-slider-thumb {
    -webkit-appearance: none;
    width: var(--thumb);
    height: var(--thumb);
    margin-top: calc((var(--track) - var(--thumb)) / 2);
    border-radius: 50%;
    background: var(--text);
    border: 0;
    box-shadow: 0 1px 4px rgb(0 0 0 / 0.4);
    transform: scale(0);
    transition: transform var(--duration-fast) var(--ease-out);
  }
  .slider::-moz-range-thumb {
    width: var(--thumb);
    height: var(--thumb);
    border-radius: 50%;
    background: var(--text);
    border: 0;
    transform: scale(0);
    transition: transform var(--duration-fast) var(--ease-out);
  }
  .slider:hover::-webkit-slider-thumb,
  .slider:focus-visible::-webkit-slider-thumb,
  .slider:active::-webkit-slider-thumb {
    transform: scale(1);
  }
  .slider:hover::-moz-range-thumb,
  .slider:focus-visible::-moz-range-thumb,
  .slider:active::-moz-range-thumb {
    transform: scale(1);
  }
</style>
