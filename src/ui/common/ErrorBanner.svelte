<script lang="ts">
  import Icon from './Icon.svelte';

  let { message, ondismiss }: { message: string; ondismiss: () => void } = $props();
</script>

<div class="banner" role="alert">
  <span class="mark"><Icon name="info" size={16} /></span>
  <span class="msg">{message}</span>
  <button type="button" class="dismiss" aria-label="Dismiss error" onclick={ondismiss}>
    <Icon name="close" size={16} />
  </button>
</div>

<style>
  .banner {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    margin: var(--space-2) var(--space-3) 0;
    padding: var(--space-2) var(--space-3);
    background: color-mix(in srgb, var(--danger) 14%, var(--surface));
    border: 1px solid color-mix(in srgb, var(--danger) 45%, transparent);
    border-radius: var(--radius-md);
    box-shadow: var(--shadow-1);
    color: var(--text);
    font-size: var(--text-sm);
    animation: rise-in var(--duration) var(--ease-out);
  }
  .mark {
    display: inline-flex;
    color: var(--danger);
  }
  .msg {
    flex: 1;
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .dismiss {
    display: inline-flex;
    border: 0;
    border-radius: 50%;
    background: transparent;
    color: var(--text-muted);
    cursor: pointer;
    padding: var(--space-1);
  }
  .dismiss:hover {
    background: var(--hover);
    color: var(--text);
  }
</style>
