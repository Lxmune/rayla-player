<script lang="ts">
  /** Slider that shows the live value while dragging and commits on release. */
  let {
    label,
    hint = '',
    value,
    min,
    max,
    step,
    format,
    oncommit,
  }: {
    label: string;
    hint?: string;
    value: number;
    min: number;
    max: number;
    step: number;
    format: (v: number) => string;
    oncommit: (value: number) => void;
  } = $props();

  let draft = $state<number | null>(null);
  const shown = $derived(draft ?? value);
</script>

<label class="row">
  <span class="label">
    <span>{label}</span>
    {#if hint}<span class="hint">{hint}</span>{/if}
  </span>
  <span class="control">
    <input
      type="range"
      {min}
      {max}
      {step}
      value={shown}
      oninput={(e) => (draft = e.currentTarget.valueAsNumber)}
      onchange={(e) => {
        draft = null;
        oncommit(e.currentTarget.valueAsNumber);
      }}
    />
    <output class="mono">{format(shown)}</output>
  </span>
</label>

<style>
  .control { display: flex; align-items: center; gap: var(--space-3); }
  input { width: 160px; accent-color: var(--accent); }
  output { min-width: 64px; text-align: right; font-size: var(--text-sm); color: var(--text-muted); }
  @media (max-width: 640px) {
    .control { flex: 1 1 100%; }
    input { flex: 1; width: auto; min-width: 0; height: 32px; }
  }
</style>
