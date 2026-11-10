<script lang="ts">
  import Icon from './Icon.svelte';

  let {
    options,
    value,
    onchange,
    label,
  }: {
    options: readonly { id: string; label: string }[];
    value: string;
    onchange: (id: string) => void;
    /** Accessible name; also shown as a small prefix. */
    label: string;
  } = $props();
</script>

<label class="select">
  <span class="lbl">{label}</span>
  <select {value} onchange={(e) => onchange(e.currentTarget.value)}>
    {#each options as o (o.id)}<option value={o.id}>{o.label}</option>{/each}
  </select>
  <span class="chev" aria-hidden="true"><Icon name="chevronDown" size={14} /></span>
</label>

<style>
  .select {
    position: relative;
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    font-size: var(--text-sm);
    color: var(--text-faint);
  }
  select {
    appearance: none;
    height: 32px;
    padding: 0 var(--space-6) 0 var(--space-3);
    border: 1px solid var(--border);
    border-radius: var(--radius-full);
    background: var(--surface-2);
    color: var(--text);
    font: inherit;
    font-weight: var(--weight-medium);
    cursor: pointer;
    transition: border-color var(--transition);
  }
  select:hover {
    border-color: var(--border-strong);
  }
  .chev {
    position: absolute;
    right: var(--space-3);
    display: inline-flex;
    pointer-events: none;
    color: var(--text-muted);
  }
</style>
