<script lang="ts">
  import Icon from './Icon.svelte';

  let { message, ondismiss }: { message: string; ondismiss: () => void } = $props();
</script>

<div class="banner" role="alert">
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
    padding: var(--space-2) var(--space-4);
    background: color-mix(in srgb, var(--danger) 18%, var(--surface));
    border-bottom: 1px solid var(--danger);
    color: var(--text);
    font-size: var(--text-sm);
  }
  .msg {
    flex: 1;
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .dismiss {
    display: inline-flex;
    border: 0;
    background: transparent;
    color: inherit;
    cursor: pointer;
    padding: var(--space-1);
  }
</style>
