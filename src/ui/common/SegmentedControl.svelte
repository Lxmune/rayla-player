<script lang="ts">
  import Icon from './Icon.svelte';
  import type { IconName } from './icons';

  let {
    options,
    value,
    onchange,
    label,
  }: {
    options: readonly { id: string; label: string; icon?: IconName }[];
    value: string;
    onchange: (id: string) => void;
    /** Accessible name of the group. */
    label: string;
  } = $props();
</script>

<div class="seg" role="group" aria-label={label}>
  {#each options as o (o.id)}
    <button
      type="button"
      class:on={o.id === value}
      aria-pressed={o.id === value}
      aria-label={o.icon ? o.label : undefined}
      title={o.icon ? o.label : undefined}
      onclick={() => onchange(o.id)}
    >
      {#if o.icon}<Icon name={o.icon} size={16} />{:else}{o.label}{/if}
    </button>
  {/each}
</div>

<style>
  .seg {
    display: inline-flex;
    padding: 3px;
    gap: 2px;
    border-radius: var(--radius-full);
    background: var(--surface-2);
  }
  button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 34px;
    height: 28px;
    padding: 0 var(--space-3);
    border: 0;
    border-radius: var(--radius-full);
    background: transparent;
    color: var(--text-muted);
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
    cursor: pointer;
    transition:
      background var(--transition),
      color var(--transition);
  }
  button:hover {
    color: var(--text);
  }
  button.on {
    background: var(--surface-3);
    color: var(--text);
    box-shadow: var(--shadow-1);
  }
</style>
