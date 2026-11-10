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
    transition:
      color var(--transition),
      background var(--transition),
      transform var(--duration-fast) var(--ease-out),
      box-shadow var(--transition);
  }
  .icon-btn {
    -webkit-tap-highlight-color: transparent;
  }
  @media (hover: hover) {
    .icon-btn:hover:not(:disabled) {
      color: var(--text);
      background: var(--hover);
    }
  }
  .icon-btn:active:not(:disabled) {
    transform: scale(var(--press-scale-small));
    transition-duration: 0ms;
  }
  @media (hover: none) {
    .icon-btn:not(.primary) {
      width: 40px;
      height: 40px;
    }
    .icon-btn:active:not(:disabled) {
      color: var(--text);
      background: var(--active);
    }
  }
  .icon-btn.active {
    color: var(--accent);
  }
  .icon-btn.primary {
    width: 48px;
    height: 48px;
    background: var(--accent);
    color: var(--accent-contrast);
    transition:
      background var(--accent-transition),
      color var(--accent-transition),
      transform var(--duration-fast) var(--ease-out);
  }
  @media (hover: hover) {
    .icon-btn.primary:hover:not(:disabled) {
      background: var(--accent);
      color: var(--accent-contrast);
      filter: brightness(1.08);
      transform: scale(1.05);
    }
  }
  .icon-btn.primary:active:not(:disabled) {
    background: var(--accent);
    color: var(--accent-contrast);
    transform: scale(0.92);
  }
  .icon-btn:disabled {
    opacity: 0.35;
    cursor: default;
  }
</style>
