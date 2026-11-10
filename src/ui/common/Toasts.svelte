<script lang="ts">
  import { getUi } from '../shell/router.svelte';
  import IconButton from './IconButton.svelte';

  // Renders `ui.toasts` (added with ui.toast). Placed once by the shell.
  const ui = getUi();
</script>

<div class="toasts" role="status" aria-live="polite">
  {#each ui.toasts as t (t.id)}
    <div class="toast">
      <span class="msg">{t.message}</span>
      {#if t.action}
        {@const action = t.action}
        <button
          type="button"
          class="action"
          onclick={() => {
            ui.dismissToast(t.id);
            action.run();
          }}>{action.label}</button
        >
      {/if}
      <IconButton icon="close" label="Dismiss" size={14} onclick={() => ui.dismissToast(t.id)} />
    </div>
  {/each}
</div>

<style>
  .toasts {
    position: fixed;
    left: 50%;
    bottom: calc(var(--playerbar-height) + var(--space-4));
    transform: translateX(-50%);
    z-index: var(--z-toast);
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--space-2);
    pointer-events: none;
  }
  .toast {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    max-width: min(520px, 90vw);
    padding: var(--space-1) var(--space-1) var(--space-1) var(--space-4);
    background: var(--surface-3);
    border: 1px solid var(--border);
    border-radius: var(--radius-full);
    box-shadow: var(--shadow-2);
    font-size: var(--text-sm);
    pointer-events: auto;
    animation: rise-in var(--duration) var(--ease-out);
  }
  .msg {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .action {
    border: 0;
    background: transparent;
    color: var(--accent);
    font-weight: var(--weight-semibold);
    cursor: pointer;
  }
</style>
