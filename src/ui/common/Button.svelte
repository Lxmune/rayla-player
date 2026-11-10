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
    justify-content: center;
    gap: var(--space-2);
    padding: var(--space-2) var(--space-4);
    min-height: 34px;
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-full);
    background: transparent;
    color: var(--text);
    cursor: pointer;
    font-size: var(--text-sm);
    font-weight: var(--weight-semibold);
    white-space: nowrap;
    transition:
      background var(--transition),
      border-color var(--transition),
      transform var(--duration-fast) var(--ease-out);
  }
  .btn {
    -webkit-tap-highlight-color: transparent;
  }
  @media (hover: hover) {
    .btn:hover:not(:disabled) {
      background: var(--hover);
      border-color: var(--text-faint);
    }
  }
  .btn:active:not(:disabled) {
    transform: scale(0.97);
  }
  .btn.primary {
    background: var(--accent);
    border-color: var(--accent);
    color: var(--accent-contrast);
    transition:
      background var(--accent-transition),
      color var(--accent-transition),
      transform var(--duration-fast) var(--ease-out);
  }
  @media (hover: hover) {
    .btn.primary:hover:not(:disabled) {
      background: var(--accent);
      border-color: var(--accent);
      filter: brightness(1.08);
    }
  }
  @media (hover: none) {
    .btn:active:not(:disabled) {
      background: var(--active);
    }
    .btn.primary:active:not(:disabled) {
      background: var(--accent);
      filter: brightness(1.1);
    }
  }
  .btn:disabled {
    opacity: 0.4;
    cursor: default;
  }
</style>
