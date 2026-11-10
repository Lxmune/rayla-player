<script lang="ts">
  import { tick } from 'svelte';
  import { getUi } from '../shell/router.svelte';
  import Icon from './Icon.svelte';
  import { isPhone, sheetDrag } from './touch';

  // Renders `ui.menu` (opened with ui.openMenu). Placed once by the shell.
  const ui = getUi();
  const menu = $derived(ui.menu);

  let el: HTMLDivElement | undefined = $state();
  let pos = $state({ x: 0, y: 0 });
  /** Phone: render as a bottom sheet instead of a popover. Decided when the menu opens. */
  let phone = $state(false);

  // Clamp inside the viewport once the size is known, then focus the first item.
  $effect(() => {
    const m = menu;
    if (!m) return;
    pos = { x: m.x, y: m.y };
    phone = isPhone();
    void tick().then(() => {
      if (!el) return;
      if (phone) return;
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
  {#if phone}<div class="scrim" aria-hidden="true"></div>{/if}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="menu"
    class:sheet={phone}
    role="menu"
    tabindex="-1"
    aria-label="Actions"
    bind:this={el}
    style:left={phone ? undefined : `${pos.x}px`}
    style:top={phone ? undefined : `${pos.y}px`}
    {onkeydown}
    oncontextmenu={(e) => e.preventDefault()}
  >
    {#if phone}
      <div class="grab" use:sheetDrag={{ target: () => el, onclose: close }}><span></span></div>
    {/if}
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
  .scrim {
    position: fixed;
    inset: 0;
    z-index: var(--z-menu);
    background: var(--scrim);
    animation: tmenu-fade 200ms ease-out;
  }
  .menu.sheet {
    inset: auto 0 0 0;
    min-width: 0;
    max-width: none;
    max-height: 80dvh;
    padding: 0 var(--space-2) calc(var(--space-3) + env(safe-area-inset-bottom, 0px));
    border-radius: var(--radius-xl) var(--radius-xl) 0 0;
    border-bottom: 0;
    background: var(--surface);
    overscroll-behavior: contain;
    transform-origin: bottom center;
    animation: tmenu-up 280ms var(--ease-out);
  }
  .grab {
    position: sticky;
    top: 0;
    z-index: 1;
    display: flex;
    justify-content: center;
    padding: var(--space-3) 0 var(--space-2);
    margin: 0 calc(var(--space-2) * -1);
    background: var(--surface);
    touch-action: none;
    cursor: grab;
  }
  .grab span {
    width: 36px;
    height: 4px;
    border-radius: 2px;
    background: var(--text-faint);
    opacity: 0.6;
  }
  .sheet button {
    min-height: 52px;
    padding: 0 var(--space-4);
    gap: var(--space-4);
    font-size: var(--text-md);
    border-radius: var(--radius-md);
  }
  .sheet .icon {
    width: 22px;
  }
  .sheet .sep {
    margin: var(--space-1) var(--space-4);
  }
  @keyframes tmenu-up {
    from {
      transform: translateY(100%);
    }
  }
  @keyframes tmenu-fade {
    from {
      opacity: 0;
    }
  }
  button {
    -webkit-tap-highlight-color: transparent;
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
  button:focus-visible {
    background: var(--active);
    outline: none;
  }
  @media (hover: hover) {
    button:hover:not(:disabled) {
      background: var(--active);
    }
  }
  button:active:not(:disabled) {
    background: var(--active);
  }
  @media (prefers-reduced-motion: reduce) {
    .menu.sheet,
    .scrim {
      animation: none;
    }
  }
  :global(:root[data-motion='reduced']) .menu.sheet,
  :global(:root[data-motion='reduced']) .scrim {
    animation: none;
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
