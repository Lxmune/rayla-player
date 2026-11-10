<script lang="ts">
  /** Accent picker: curated swatches plus the native colour input. */
  let {
    label,
    hint = '',
    value,
    swatches,
    onchange,
  }: {
    label: string;
    hint?: string;
    value: string;
    swatches: { name: string; value: string }[];
    onchange: (value: string) => void;
  } = $props();

  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
</script>

<div class="row">
  <span class="label">
    <span>{label}</span>
    {#if hint}<span class="hint">{hint}</span>{/if}
  </span>
  <div class="colors">
    <div class="swatches" role="group" aria-label={label}>
      {#each swatches as s (s.value)}
        <button
          type="button"
          class="swatch"
          style:background={s.value}
          aria-label={s.name}
          aria-pressed={same(s.value, value)}
          title={s.name}
          onclick={() => onchange(s.value)}
        ></button>
      {/each}
    </div>
    <input
      class="picker"
      type="color"
      aria-label="Custom accent colour"
      {value}
      onchange={(e) => onchange(e.currentTarget.value)}
    />
    <code class="hex">{value}</code>
  </div>
</div>

<style>
  .colors { display: flex; align-items: center; gap: var(--space-3); flex-wrap: wrap; justify-content: flex-end; }
  .swatches { display: flex; gap: var(--space-2); flex-wrap: wrap; }
  .swatch { width: 24px; height: 24px; border-radius: 50%; border: 2px solid transparent; padding: 0; cursor: pointer; box-shadow: inset 0 0 0 1px rgb(0 0 0 / 0.25); transition: transform var(--transition); }
  .swatch:hover { transform: scale(1.12); }
  .swatch[aria-pressed='true'] { border-color: var(--text); outline: 2px solid var(--bg); outline-offset: -4px; }
  .picker { width: 32px; height: 28px; padding: 0; border: 1px solid var(--border-strong); border-radius: var(--radius-sm); background: none; cursor: pointer; }
  .hex { font-family: var(--font-mono); font-size: var(--text-xs); color: var(--text-muted); min-width: 60px; }
  @media (max-width: 640px) {
    .colors { flex: 1 1 100%; justify-content: flex-start; }
    .swatch { width: 32px; height: 32px; }
  }
</style>
