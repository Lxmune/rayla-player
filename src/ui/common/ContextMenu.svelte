<script lang="ts">
  import { tick } from 'svelte';
  import { getUi } from '../shell/router.svelte';
  import Icon from './Icon.svelte';

  // Renders `ui.menu` (opened with ui.openMenu). Placed once by the shell.
  const ui = getUi();
  const menu = $derived(ui.menu);

  let el: HTMLDivElement | undefined = $state();
  let pos = $state({ x: 0, y: 0 });

  // Clamp inside the viewport once the size is known, then focus the first item.
  $effect(() => {
    const m = menu;
    if (!m) return;
    pos = { x: m.x, y: m.y };
    void tick().then(() => {
      if (!el) return;
      const r = el.getBoundingClientRect();
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      pos = {
        x: Math.max(8, Math.min(m.x, vw - r.width - 8)),
        y: m.y + r.height > vh - 8 ? Math.max(8, m.y - r.height) : m.y,
      };
      items()[0]?.focus();
    });
  });

  const items = () => [...(el?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? [])];

  function close() {
    ui.closeMenu();
  }

  function onkeydown(e: KeyboardEvent) {
    if (!menu) return;
    const list = items();
    const i = list.indexOf(document.activeElement as HTMLButtonElement);
    switch (e.key) {
      case 'Escape':
        e.preventDefault();
        e.stopPropagation();
        close();
        break;
      case 'ArrowDown':
        e.preventDefault();
        list[(i + 1) % list.length]?.focus();
        break;
      case 'ArrowUp':
        e.preventDefault();
        list[(i - 1 + list.length) % list.length]?.focus();
        break;
      case 'Home':
        e.preventDefault();
        list[0]?.focus();
        break;
      case 'End':
        e.preventDefault();
        list[list.length - 1]?.focus();
        break;
      case 'Tab':
        e.preventDefault();
        close();
        break;
    }
  }

  function onpointerdown(e: PointerEvent) {
    if (menu && el && !el.contains(e.target as Node)) close();
  }
</script>

<svelte:window {onpointerdown} onblur={close} onresize={close} />

{#if menu}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="menu"
    role="menu"
    tabindex="-1"
    aria-label="Actions"
    bind:this={el}
    style:left={`${pos.x}px`}
    style:top={`${pos.y}px`}
    {onkeydown}
    oncontextmenu={(e) => e.preventDefault()}
  >
    {#each menu.entries as entry, i (i)}
      {#if entry === 'separator'}
        <div class="sep" role="separator"></div>
      {:else}
        <button
          type="button"
          role="menuitem"
          class:danger={entry.danger}
          disabled={entry.disabled}
          onclick={() => {
            close();
            entry.onselect();
          }}
        >
          <span class="icon">{#if entry.icon}<Icon name={entry.icon} size={16} />{/if}</span>
          <span>{entry.label}</span>
        </button>
      {/if}
    {/each}
  </div>
{/if}

<style>
  .menu {
    position: fixed;
    z-index: var(--z-menu);
    min-width: 220px;
    max-width: 320px;
    max-height: calc(100vh - 16px);
    overflow-y: auto;
    padding: var(--space-1);
    background: var(--glass);
    backdrop-filter: blur(24px) saturate(1.6);
    -webkit-backdrop-filter: blur(24px) saturate(1.6);
    border: 1px solid var(--glass-border);
    border-radius: var(--radius-md);
    box-shadow: var(--shadow-3);
    animation: scale-in var(--duration-fast) var(--ease-out);
    transform-origin: top left;
  }
  button {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    width: 100%;
    padding: 7px var(--space-3);
    border: 0;
    border-radius: var(--radius-sm);
    background: transparent;
    text-align: left;
    font-size: var(--text-sm);
    cursor: pointer;
  }
  button:hover:not(:disabled),
  button:focus-visible {
    background: var(--active);
    outline: none;
  }
  button:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .icon {
    display: inline-flex;
    width: 16px;
    color: var(--text-muted);
  }
  .danger,
  .danger .icon {
    color: var(--danger);
  }
  .sep {
    height: 1px;
    margin: var(--space-1) var(--space-2);
    background: var(--border);
  }
</style>
