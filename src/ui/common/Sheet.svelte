<script lang="ts">
  import type { Snippet } from 'svelte';
  import IconButton from './IconButton.svelte';
  import { isPhone, sheetDrag } from './touch';

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
    <div class="drag" use:sheetDrag={{ target: () => dialog, onclose, enabled: isPhone }}>
      <div class="grab" aria-hidden="true"><span></span></div>
      <header>
        <h2 id={titleId}>{title}</h2>
        <IconButton icon="close" label="Close dialog" onclick={onclose} />
      </header>
    </div>
    <div class="body">{@render children()}</div>
  </div>
</div>

<style>
  .overlay {
    position: fixed;
    inset: 0;
    z-index: var(--z-sheet);
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
    backdrop-filter: blur(4px);
    cursor: default;
    animation: fade-in var(--duration) var(--ease-out);
  }
  .sheet {
    position: relative;
    display: flex;
    flex-direction: column;
    width: min(560px, 100%);
    max-height: min(720px, 100%);
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-xl);
    box-shadow: var(--shadow-3);
    overflow: hidden;
    animation: scale-in var(--duration) var(--ease-out);
  }
  .grab {
    display: none;
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: var(--space-3) var(--space-4) var(--space-3) var(--space-5);
    background: var(--glass);
    backdrop-filter: blur(16px);
    border-bottom: 1px solid var(--glass-border);
  }
  h2 {
    margin: 0;
    font-size: var(--text-lg);
    font-weight: var(--weight-semibold);
    letter-spacing: var(--tracking-tight);
  }
  .body {
    padding: var(--space-4) var(--space-5) var(--space-5);
    overflow-y: auto;
    overscroll-behavior: contain;
  }
  /* Phone: bottom sheet. Only the handle / header drags, so the body keeps scrolling. */
  @media (max-width: 640px) {
    .overlay {
      align-items: flex-end;
      padding: 0;
    }
    .sheet {
      width: 100%;
      max-height: 90vh;
      max-height: 90dvh;
      border-radius: var(--radius-xl) var(--radius-xl) 0 0;
      border-bottom: 0;
      animation: tsheet-up 300ms var(--ease-out);
    }
    .scrim {
      animation: tsheet-fade 240ms ease-out;
    }
    .drag {
      touch-action: none;
    }
    .grab {
      display: flex;
      justify-content: center;
      padding: var(--space-2) 0 0;
      background: var(--glass);
    }
    .grab span {
      width: 36px;
      height: 4px;
      border-radius: 2px;
      background: var(--text-faint);
      opacity: 0.6;
    }
    header {
      border-bottom: 0;
    }
    .body {
      padding-bottom: calc(var(--space-5) + env(safe-area-inset-bottom, 0px));
    }
  }
  @keyframes tsheet-up {
    from {
      transform: translateY(100%);
    }
  }
  @keyframes tsheet-fade {
    from {
      opacity: 0;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .sheet,
    .scrim {
      animation: none;
    }
  }
  :global(:root[data-motion='reduced']) .sheet,
  :global(:root[data-motion='reduced']) .scrim {
    animation: none;
  }
</style>
