<script lang="ts">
  import type { Snippet } from 'svelte';
  import IconButton from './IconButton.svelte';

  let {
    title,
    onclose,
    children,
  }: { title: string; onclose: () => void; children: Snippet } = $props();

  let dialog: HTMLDivElement | undefined = $state();
  const titleId = `sheet-title-${Math.random().toString(36).slice(2, 8)}`;

  // Focus moves into the sheet and returns to where it was on close.
  $effect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog?.querySelector<HTMLElement>('button')?.focus();
    return () => previous?.focus?.();
  });

  function onkeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault();
      onclose();
      return;
    }
    if (e.key !== 'Tab' || !dialog) return;
    const focusable = [
      ...dialog.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])',
      ),
    ];
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (!first || !last) return;
    const active = document.activeElement;
    if (e.shiftKey && active === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (active === last || !dialog.contains(active))) {
      e.preventDefault();
      first.focus();
    }
  }
</script>

<svelte:window {onkeydown} />

<div class="overlay">
  <button type="button" class="scrim" aria-label="Close" tabindex="-1" onclick={onclose}></button>
  <div class="sheet" role="dialog" aria-modal="true" aria-labelledby={titleId} bind:this={dialog}>
    <header>
      <h2 id={titleId}>{title}</h2>
      <IconButton icon="close" label="Close dialog" onclick={onclose} />
    </header>
    <div class="body">{@render children()}</div>
  </div>
</div>

<style>
  .overlay {
    position: fixed;
    inset: 0;
    z-index: 100;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: var(--space-4);
  }
  .scrim {
    position: absolute;
    inset: 0;
    border: 0;
    background: var(--scrim);
    cursor: default;
  }
  .sheet {
    position: relative;
    display: flex;
    flex-direction: column;
    width: min(560px, 100%);
    max-height: min(720px, 100%);
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    overflow: hidden;
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: var(--space-3) var(--space-4);
    border-bottom: 1px solid var(--border);
  }
  h2 {
    margin: 0;
    font-size: var(--text-lg);
    font-weight: 600;
  }
  .body {
    padding: var(--space-4);
    overflow-y: auto;
  }
</style>
