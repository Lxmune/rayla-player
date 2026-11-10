<script lang="ts">
  import Icon from '../common/Icon.svelte';
  import IconButton from '../common/IconButton.svelte';
  import { getRouter, getUi } from './router.svelte';

  let { scrolled = false }: { scrolled?: boolean } = $props();

  const router = getRouter();
  const ui = getUi();
  let input: HTMLInputElement | undefined = $state();

  /** Focuses and selects the search field (Ctrl/Cmd+K, "/"). */
  export function focusSearch() {
    input?.focus();
    input?.select();
  }

  function oninput() {
    if (router.current.name !== 'search') router.push({ name: 'search' });
  }

  function onkeydown(e: KeyboardEvent) {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    if (ui.searchTerm !== '') ui.searchTerm = '';
    else input?.blur();
  }
</script>

<header class="top" class:scrolled>
  <div class="nav">
    <IconButton icon="back" label="Back" disabled={!router.canBack} onclick={() => router.back()} />
    <IconButton icon="forward" label="Forward" disabled={!router.canForward} onclick={() => router.forward()} />
  </div>

  <label class="search">
    <Icon name="search" size={16} />
    <input
      bind:this={input}
      type="search"
      placeholder="Search your library"
      aria-label="Search"
      autocomplete="off"
      spellcheck="false"
      bind:value={ui.searchTerm}
      {oninput}
      {onkeydown}
    />
    <kbd aria-hidden="true">/</kbd>
  </label>

  <div class="end">
    <IconButton icon="keyboard" label="Keyboard shortcuts" onclick={() => (ui.sheet = { kind: 'shortcuts' })} />
  </div>
</header>

<style>
  .top {
    position: sticky;
    top: 0;
    z-index: var(--z-sticky);
    display: flex;
    align-items: center;
    gap: var(--space-3);
    height: var(--topbar-height);
    padding: 0 var(--gutter);
    background: var(--glass);
    backdrop-filter: blur(20px) saturate(1.4);
    border-bottom: 1px solid transparent;
    transition:
      background var(--transition),
      border-color var(--transition);
  }
  .top.scrolled {
    background: var(--bg-elevated);
    border-bottom-color: var(--border);
  }
  .nav,
  .end {
    display: flex;
    gap: var(--space-1);
  }
  .end {
    margin-left: auto;
  }
  .search {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    flex: 0 1 420px;
    min-width: 0;
    height: 36px;
    padding: 0 var(--space-3);
    border: 1px solid var(--border);
    border-radius: var(--radius-full);
    background: var(--surface-2);
    color: var(--text-muted);
    transition:
      border-color var(--transition),
      background var(--transition);
  }
  .search:focus-within {
    border-color: var(--accent);
    background: var(--surface);
    color: var(--text);
  }
  input {
    flex: 1;
    min-width: 0;
    border: 0;
    outline: 0;
    background: transparent;
    color: var(--text);
    font: inherit;
    font-size: var(--text-md);
  }
  input::placeholder {
    color: var(--text-faint);
  }
  input::-webkit-search-cancel-button {
    appearance: none;
  }
  kbd {
    padding: 0 6px;
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-sm);
    color: var(--text-faint);
    font: var(--text-xs) / 18px var(--font-mono);
  }
  .search:focus-within kbd {
    display: none;
  }
</style>
