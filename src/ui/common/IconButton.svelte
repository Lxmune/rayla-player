<script lang="ts">
  import Icon from './Icon.svelte';
  import type { IconName } from './icons';

  let {
    icon,
    label,
    onclick,
    size = 20,
    active = false,
    pressed,
    disabled = false,
    primary = false,
  }: {
    icon: IconName;
    /** Accessible name (icon-only buttons need one). */
    label: string;
    onclick?: (e: MouseEvent) => void;
    size?: number;
    /** Tinted with the accent. */
    active?: boolean;
    /** Sets aria-pressed for toggle buttons. */
    pressed?: boolean;
    disabled?: boolean;
    /** Filled accent button. */
    primary?: boolean;
  } = $props();
</script>

<button
  type="button"
  class="icon-btn"
  class:active
  class:primary
  aria-label={label}
  title={label}
  aria-pressed={pressed}
  {disabled}
  {onclick}
>
  <Icon name={icon} {size} />
</button>

<style>
  .icon-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 36px;
    height: 36px;
    flex: none;
    border: 0;
    border-radius: 50%;
    background: transparent;
    color: var(--text-muted);
    cursor: pointer;
    transition: color var(--transition), background var(--transition);
  }
  .icon-btn:hover:not(:disabled) {
    color: var(--text);
    background: var(--surface-2);
  }
  .icon-btn.active {
    color: var(--accent);
  }
  .icon-btn.primary {
    width: 44px;
    height: 44px;
    background: var(--accent);
    color: var(--accent-contrast);
    transition: background var(--accent-transition), color var(--accent-transition);
  }
  .icon-btn.primary:hover:not(:disabled) {
    background: var(--accent);
    color: var(--accent-contrast);
    filter: brightness(1.08);
  }
  .icon-btn:disabled {
    opacity: 0.35;
    cursor: default;
  }
</style>
