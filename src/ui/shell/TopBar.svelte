<script lang="ts">
  import { getApp } from '../../lib/app.svelte';
  import Avatar from '../login/Avatar.svelte';
  import Icon from '../common/Icon.svelte';
  import IconButton from '../common/IconButton.svelte';
  import { getRouter, getUi, type MenuEntry, type RootRoute } from './router.svelte';

  let {
    scrolled = false,
    phone = false,
    chipsHidden = false,
  }: { scrolled?: boolean; phone?: boolean; chipsHidden?: boolean } = $props();

  const app = getApp();
  const router = getRouter();
  const ui = getUi();
  let input: HTMLInputElement | undefined = $state();

  /** Section chips shown under the phone top bar. */
  const CHIPS: { id: RootRoute; label: string }[] = [
    { id: 'home', label: 'Home' },
    { id: 'albums', label: 'Albums' },
    { id: 'artists', label: 'Artists' },
    { id: 'songs', label: 'Songs' },
    { id: 'playlists', label: 'Playlists' },
    { id: 'genres', label: 'Genres' },
    { id: 'favorites', label: 'Favorites' },
    { id: 'downloads', label: 'Downloads' },
  ];
  const TITLES: Partial<Record<RootRoute, string>> = {
    settings: 'Settings',
    downloads: 'Downloads',
    albums: 'Albums',
    artists: 'Artists',
    songs: 'Songs',
    playlists: 'Playlists',
    genres: 'Genres',
    favorites: 'Favorites',
  };

  const current = $derived(router.current);
  const detail = $derived('item' in current);
  const searching = $derived(current.name === 'search');
  const here = $derived<RootRoute>(detail ? router.section : (current.name as RootRoute));
  const userName = $derived(app.core.sessions.active?.userName ?? '');
  const title = $derived.by(() => {
    if ('item' in current) return current.item.name;
    if (current.name === 'home') {
      const h = new Date().getHours();
      return h < 5 ? 'Good night' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
    }
    return TITLES[current.name as RootRoute] ?? '';
  });

  /** Focuses and selects the search field (Ctrl/Cmd+K, "/"). */
  export function focusSearch() {
    if (phone && !searching) router.push({ name: 'search' });
    input?.focus();
    input?.select();
  }

  // The phone search route opens with the keyboard ready.
  $effect(() => {
    if (phone && searching) input?.focus();
  });

  function oninput() {
    if (router.current.name !== 'search') router.push({ name: 'search' });
  }

  function onkeydown(e: KeyboardEvent) {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    if (ui.searchTerm !== '') ui.searchTerm = '';
    else input?.blur();
  }

  function openAccountMenu(e: MouseEvent) {
    const entries: MenuEntry[] = [
      { label: 'Settings', icon: 'settings', onselect: () => router.go('settings') },
      { label: 'Downloads', icon: 'download', onselect: () => router.go('downloads') },
      { label: 'Servers and accounts', icon: 'server', onselect: () => (ui.sheet = { kind: 'accounts' }) },
    ];
    ui.openMenu(e.currentTarget as HTMLElement, entries);
  }
</script>

{#if phone}
  <header class="top phone" class:scrolled class:detail>
    <div class="row">
      {#if detail || searching}
        <IconButton icon="back" label="Back" onclick={() => router.back()} />
      {/if}
      {#if searching}
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
        </label>
      {:else}
        <h1 class="title" class:compact={detail} class:shown={!detail || scrolled}>{title}</h1>
        <div class="end">
          <IconButton icon="search" label="Search" onclick={() => router.push({ name: 'search' })} />
          <button
            type="button"
            class="avatar"
            aria-label="Account menu"
            aria-haspopup="menu"
            onclick={openAccountMenu}
          >
            <Avatar name={userName === '' ? 'Rayla' : userName} size={32} />
          </button>
        </div>
      {/if}
    </div>
    {#if !detail && !searching}
      <nav class="chips" class:hidden={chipsHidden} inert={chipsHidden} aria-label="Sections">
        {#each CHIPS as c (c.id)}
          <button
            type="button"
            class="chip"
            class:on={here === c.id}
            aria-current={here === c.id ? 'page' : undefined}
            onclick={() => router.go(c.id)}>{c.label}</button
          >
        {/each}
      </nav>
    {/if}
  </header>
  {#if !detail && !searching}
    <div class="chips-spacer" aria-hidden="true"></div>
  {/if}
{:else}
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
{/if}

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
  /* Phone: app bar + section chips. */
  .top.phone {
    flex-direction: column;
    align-items: stretch;
    gap: 0;
    height: auto;
    padding: 0;
    -webkit-tap-highlight-color: transparent;
  }
  .row {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    min-height: var(--topbar-height);
    padding: 0 var(--space-2) 0 var(--gutter);
  }
  .row :global(.icon-btn) {
    min-width: 44px;
    min-height: 44px;
  }
  .phone:has(.row > :global(.icon-btn:first-child)) .row {
    padding-left: var(--space-2);
  }
  .title {
    flex: 1;
    min-width: 0;
    margin: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: var(--font-display);
    font-size: var(--text-xl);
    font-weight: var(--weight-bold);
    letter-spacing: var(--tracking-tight);
  }
  .title {
    transform-origin: left center;
    transition:
      transform var(--duration) var(--ease-out),
      opacity var(--duration) var(--ease-out);
  }
  .top.scrolled .title:not(.compact) {
    transform: scale(0.82);
  }
  .title.compact {
    font-size: var(--text-md);
    font-weight: var(--weight-semibold);
    opacity: 0;
    transition: opacity var(--transition);
  }
  .title.compact.shown {
    opacity: 1;
  }
  .phone .end {
    margin-left: auto;
    align-items: center;
  }
  .avatar {
    display: grid;
    place-items: center;
    width: 44px;
    height: 44px;
    padding: 0;
    border: 0;
    border-radius: 50%;
    background: transparent;
    cursor: pointer;
    -webkit-tap-highlight-color: transparent;
  }
  .phone .search {
    flex: 1;
    height: 40px;
  }
  /* The chip row hangs below the sticky bar so it can slide away with a transform. */
  .top.phone {
    position: sticky;
  }
  .chips-spacer {
    height: 44px;
  }
  .chips {
    position: absolute;
    top: 100%;
    left: 0;
    right: 0;
    height: 44px;
    padding-top: var(--space-1);
    background: var(--bg-elevated);
    z-index: -1;
    transition:
      transform var(--duration) var(--ease-out),
      opacity var(--duration) var(--ease-out);
    will-change: transform;
    display: flex;
    gap: var(--space-2);
    padding: 0 var(--gutter) var(--space-2);
    overflow-x: auto;
    scrollbar-width: none;
    overscroll-behavior-x: contain;
  }
  .chips.hidden {
    transform: translateY(-100%);
    opacity: 0;
    pointer-events: none;
  }
  .chips::-webkit-scrollbar {
    display: none;
  }
  .chip {
    flex: none;
    min-height: 36px;
    padding: 0 var(--space-4);
    border: 1px solid var(--border);
    border-radius: var(--radius-full);
    background: var(--surface-2);
    color: var(--text-muted);
    font: inherit;
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
    cursor: pointer;
    -webkit-tap-highlight-color: transparent;
    transition:
      background var(--transition),
      color var(--transition),
      border-color var(--transition);
  }
  @media (hover: none) {
    .chip:active,
    .avatar:active {
      transform: scale(0.96);
      opacity: 0.8;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .chips,
    .title {
      transition: none;
    }
  }
  :global(:root[data-motion='reduced']) .chips {
    transition: none;
  }
  .chip.on {
    border-color: transparent;
    background: var(--accent);
    color: var(--accent-contrast);
  }
</style>
