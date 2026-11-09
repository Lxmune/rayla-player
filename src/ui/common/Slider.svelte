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
    -webkit-appearance: none;
    appearance: none;
    width: 100%;
    height: 16px;
    margin: 0;
    background: transparent;
    cursor: pointer;
  }
  .slider:disabled {
    opacity: 0.35;
    cursor: default;
  }
  .slider::-webkit-slider-runnable-track {
    height: 4px;
    border-radius: 2px;
    background: linear-gradient(to right, var(--accent) var(--fill), var(--border) var(--fill));
  }
  .slider::-moz-range-track {
    height: 4px;
    border-radius: 2px;
    background: var(--border);
  }
  .slider::-moz-range-progress {
    height: 4px;
    border-radius: 2px;
    background: var(--accent);
  }
  .slider::-webkit-slider-thumb {
    -webkit-appearance: none;
    width: 12px;
    height: 12px;
    margin-top: -4px;
    border-radius: 50%;
    background: var(--text);
    border: 0;
  }
  .slider::-moz-range-thumb {
    width: 12px;
    height: 12px;
    border-radius: 50%;
    background: var(--text);
    border: 0;
  }
</style>
