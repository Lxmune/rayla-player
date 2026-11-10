<script lang="ts">
  /** Enum picker as a segmented control (native radios: arrow keys work). */
  let {
    label,
    hint = '',
    value,
    options,
    onchange,
  }: {
    label: string;
    hint?: string;
    value: string;
    options: { value: string; label: string }[];
    onchange: (value: string) => void;
  } = $props();

  const uid = $props.id();
</script>

<div class="row">
  <span class="label" id={`${uid}-l`}>
    <span>{label}</span>
    {#if hint}<span class="hint">{hint}</span>{/if}
  </span>
  <div class="seg" role="radiogroup" aria-labelledby={`${uid}-l`}>
    {#each options as o (o.value)}
      <label class:on={o.value === value}>
        <input
          type="radio"
          name={uid}
          value={o.value}
          checked={o.value === value}
          onchange={() => onchange(o.value)}
        />
        <span>{o.label}</span>
      </label>
    {/each}
  </div>
</div>

<style>
  .seg { display: inline-flex; padding: 3px; gap: 2px; background: var(--surface-2); border: 1px solid var(--border); border-radius: var(--radius-full); flex: none; }
  label { position: relative; display: block; cursor: pointer; border-radius: var(--radius-full); }
  input { position: absolute; inset: 0; opacity: 0; margin: 0; cursor: pointer; }
  span { display: block; padding: var(--space-1) var(--space-4); font-size: var(--text-sm); color: var(--text-muted); border-radius: var(--radius-full); transition: background var(--transition), color var(--transition); }
  label:hover span { color: var(--text); }
  label.on span { background: var(--accent); color: var(--accent-contrast); font-weight: var(--weight-medium); }
  label:has(input:focus-visible) { outline: 2px solid var(--accent); outline-offset: 2px; }
  @media (max-width: 640px) {
    .seg { flex: 1 1 100%; max-width: 100%; overflow-x: auto; scrollbar-width: none; }
    label { flex: 1; text-align: center; }
    span { padding: var(--space-2) var(--space-3); }
  }
</style>
