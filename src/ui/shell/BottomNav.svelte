<script lang="ts">
  import { onMount } from 'svelte';
  import Icon from '../common/Icon.svelte';
  import type { IconName } from '../common/icons';
  import { getRouter, getUi, type MenuEntry, type RootRoute } from './router.svelte';

  // Phone navigation (≤ 640px, where the sidebar is hidden): four main tabs
  // plus "More", which lists the remaining sections in the shared menu.
  const router = getRouter();
  const ui = getUi();

  interface Tab {
    id: RootRoute;
    label: string;
    icon: IconName;
  }
  const TABS: Tab[] = [
    { id: 'home', label: 'Home', icon: 'home' },
    { id: 'search', label: 'Search', icon: 'search' },
    { id: 'albums', label: 'Albums', icon: 'album' },
    { id: 'artists', label: 'Artists', icon: 'artist' },
  ];
  const MORE: Tab[] = [
    { id: 'songs', label: 'Songs', icon: 'song' },
    { id: 'genres', label: 'Genres', icon: 'tag' },
    { id: 'playlists', label: 'Playlists', icon: 'playlist' },
    { id: 'favorites', label: 'Favorites', icon: 'heart' },
    { id: 'downloads', label: 'Downloads', icon: 'download' },
    { id: 'settings', label: 'Settings', icon: 'settings' },
  ];

  const current = $derived(router.current);
  const here = $derived<RootRoute>('item' in current ? router.section : current.name);
  const inMore = $derived(MORE.some((t) => t.id === here));

  // Rendered only at phone width so the desktop accessibility tree has a
  // single "Main" navigation.
  let phone = $state(false);
  onMount(() => {
    if (typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia('(max-width: 640px)');
    phone = mq.matches;
    const on = (e: MediaQueryListEvent) => (phone = e.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  });

  function openMore(e: MouseEvent) {
    const entries: MenuEntry[] = MORE.map((t) => ({
      label: t.label,
      icon: t.icon,
      onselect: () => router.go(t.id),
    }));
    ui.openMenu(e.currentTarget as HTMLElement, entries);
  }
</script>

{#if phone}
<nav class="tabs" aria-label="Main">
  {#each TABS as t (t.id)}
    <button
      type="button"
      class="tab"
      class:on={here === t.id}
      aria-current={here === t.id ? 'page' : undefined}
      onclick={() => router.go(t.id)}
    >
      <Icon name={t.icon} size={22} />
      <span>{t.label}</span>
    </button>
  {/each}
  <button type="button" class="tab" class:on={inMore} aria-haspopup="menu" onclick={openMore}>
    <Icon name="more" size={22} />
    <span>More</span>
  </button>
</nav>
{/if}

<style>
  .tabs {
    display: grid;
    grid-template-columns: repeat(5, 1fr);
    padding: var(--space-1) var(--space-1) calc(var(--space-1) + env(safe-area-inset-bottom, 0px));
    background: var(--glass);
    backdrop-filter: blur(24px) saturate(1.4);
    border-top: 1px solid var(--glass-border);
  }
  .tab {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 2px;
    min-height: 52px;
    padding: var(--space-1) 0;
    border: 0;
    background: transparent;
    color: var(--text-muted);
    font: inherit;
    font-size: var(--text-xs);
    cursor: pointer;
    -webkit-tap-highlight-color: transparent;
  }
  .tab.on {
    color: var(--accent);
  }
</style>
