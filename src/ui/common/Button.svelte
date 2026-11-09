<script lang="ts">
  import type { Snippet } from 'svelte';
  import Icon from './Icon.svelte';
  import type { IconName } from './icons';

  let {
    onclick,
    icon,
    primary = false,
    disabled = false,
    children,
  }: {
    onclick: () => void;
    icon?: IconName;
    primary?: boolean;
    disabled?: boolean;
    children: Snippet;
  } = $props();
</script>

<button type="button" class="btn" class:primary {disabled} {onclick}>
  {#if icon}<Icon name={icon} size={16} />{/if}
  {@render children()}
</button>

<style>
  .btn {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-2) var(--space-4);
    border: 1px solid var(--border);
    border-radius: 999px;
    background: transparent;
    cursor: pointer;
    font-size: var(--text-sm);
    transition: background var(--transition), border-color var(--transition);
  }
  .btn:hover:not(:disabled) {
    background: var(--surface-2);
  }
  .btn.primary {
    background: var(--accent);
    border-color: var(--accent);
    color: var(--accent-contrast);
    transition: background var(--accent-transition), color var(--accent-transition);
  }
  .btn.primary:hover:not(:disabled) {
    background: var(--accent);
    filter: brightness(1.08);
  }
  .btn:disabled {
    opacity: 0.4;
    cursor: default;
  }
</style>
