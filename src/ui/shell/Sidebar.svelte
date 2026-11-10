<script lang="ts">
  import { onMount } from 'svelte';
  import { getApp } from '../../lib/app.svelte';
  import type { BaseItem } from '../../lib/jellyfin/models';
  import { profileHost } from '../../lib/jellyfin/session.svelte';
  import Icon from '../common/Icon.svelte';
  import type { IconName } from '../common/icons';
  import { getRouter, getUi, type RootRoute } from './router.svelte';

  const STORAGE_KEY = 'rayla.sidebarCollapsed';

  const app = getApp();
  const router = getRouter();
  const ui = getUi();

  interface NavItem {
    id: RootRoute;
    label: string;
    icon: IconName;
  }
  const LIBRARY: NavItem[] = [
    { id: 'home', label: 'Home', icon: 'home' },
    { id: 'discover', label: 'Discover', icon: 'sparkle' },
    { id: 'search', label: 'Search', icon: 'search' },
    { id: 'artists', label: 'Artists', icon: 'artist' },
    { id: 'albums', label: 'Albums', icon: 'album' },
    { id: 'songs', label: 'Songs', icon: 'song' },
    { id: 'genres', label: 'Genres', icon: 'tag' },
    { id: 'playlists', label: 'Playlists', icon: 'playlist' },
    { id: 'favorites', label: 'Favorites', icon: 'heart' },
    { id: 'smart', label: 'Smart playlists', icon: 'filter' },
    { id: 'stats', label: 'Stats', icon: 'clock' },
  ];
  const OFFLINE: NavItem[] = [{ id: 'downloads', label: 'Downloads', icon: 'download' }];

  const active = $derived(app.core.sessions.active);
  const client = $derived(app.core.sessions.client);
  const downloadCount = $derived(app.core.downloads.entries.size);
  const current = $derived(router.current);
  const here = $derived<RootRoute>('item' in current ? router.section : current.name);
  const openId = $derived('item' in current && current.name === 'playlist' ? current.item.id : null);

  function readCollapsed(): boolean {
    try {
      return localStorage.getItem(STORAGE_KEY) === '1';
    } catch {
      return false;
    }
  }
  let manual = $state(readCollapsed());
  let narrow = $state(false);
  const collapsed = $derived(manual || narrow);

  function toggle() {
    manual = !manual;
    try {
      localStorage.setItem(STORAGE_KEY, manual ? '1' : '0');
    } catch {
      // Storage unavailable: the choice just does not persist.
    }
  }

  onMount(() => {
    if (typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia('(max-width: 900px)');
    narrow = mq.matches;
    const on = (e: MediaQueryListEvent) => (narrow = e.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  });

  let playlists = $state.raw<BaseItem[]>([]);
  $effect(() => {
    const c = client;
    playlists = [];
    if (!c) return;
    let stale = false;
    c.playlists({ limit: 50 })
      .then((page) => {
        if (!stale) playlists = page.items;
      })
      .catch(() => {
        // The sidebar list is optional; the Playlists screen reports real failures.
      });
    return () => {
      stale = true;
    };
  });
</script>

{#snippet navButton(n: NavItem)}
  <li>
    <button
      type="button"
      class="item"
      class:on={here === n.id}
      aria-label={n.label}
      title={collapsed ? n.label : undefined}
      aria-current={here === n.id ? 'page' : undefined}
      onclick={() => router.go(n.id)}
    >
      <Icon name={n.icon} size={18} />
      <span class="label">{n.label}</span>
      {#if n.id === 'downloads' && downloadCount > 0}
        <span class="badge" aria-hidden="true">{downloadCount}</span>
      {/if}
    </button>
  </li>
{/snippet}

<nav class="side" class:collapsed aria-label="Main">
  <div class="head">
    <span class="brand">Rayla</span>
    <button
      type="button"
      class="collapse"
      aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
      title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
      onclick={toggle}
    >
      <Icon name="sidebar" size={18} />
    </button>
  </div>

  <div class="scroll">
    <h2 class="group">Library</h2>
    <ul>
      {#each LIBRARY as n (n.id)}{@render navButton(n)}{/each}
    </ul>

    <h2 class="group">Offline</h2>
    <ul>
      {#each OFFLINE as n (n.id)}{@render navButton(n)}{/each}
    </ul>

    {#if playlists.length > 0}
      <h2 class="group lists">Playlists</h2>
      <ul class="lists" aria-label="Your playlists">
        {#each playlists as p (p.id)}
          <li>
            <button type="button" class="item small" class:on={openId === p.id} onclick={() => router.open(p)}>
              <span class="bullet"><Icon name="music" size={14} /></span>
              <span class="label">{p.name}</span>
            </button>
          </li>
        {/each}
      </ul>
    {/if}
  </div>

  <div class="foot">
    <ul>{@render navButton({ id: 'settings', label: 'Settings', icon: 'settings' })}</ul>
    {#if active}
      <button
        type="button"
        class="item account"
        aria-label="Accounts and servers"
        title={collapsed ? `${active.userName} · ${profileHost(active)}` : undefined}
        onclick={() => (ui.sheet = { kind: 'accounts' })}
      >
        <Icon name="user" size={18} />
        <span class="who label">
          <span class="name">{active.userName}</span>
          <span class="host">{profileHost(active)}</span>
        </span>
      </button>
    {/if}
  </div>
</nav>

<style>
  .side {
    display: flex;
    flex-direction: column;
    flex: none;
    width: var(--sidebar-width);
    padding: var(--space-3) var(--space-2);
    background: var(--bg-elevated);
    border-right: 1px solid var(--border);
    transition: width var(--duration) var(--ease-out);
    overflow: hidden;
  }
  @media (max-width: 640px) {
    /* Phones use BottomNav instead. */
    .side {
      display: none;
    }
  }
  .side.collapsed {
    width: var(--sidebar-collapsed);
  }
  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    min-height: 40px;
    padding: 0 var(--space-2) 0 var(--space-3);
  }
  .brand {
    font-family: var(--font-display);
    font-size: var(--text-lg);
    font-weight: var(--weight-bold);
    letter-spacing: var(--tracking-tight);
  }
  .collapsed .head {
    justify-content: center;
    padding: 0;
  }
  .collapsed .brand {
    display: none;
  }
  .collapse {
    display: inline-flex;
    padding: var(--space-2);
    border: 0;
    border-radius: var(--radius-md);
    background: transparent;
    color: var(--text-muted);
    cursor: pointer;
  }
  .collapse:hover {
    background: var(--hover);
    color: var(--text);
  }
  .scroll {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    overflow-x: hidden;
    padding-bottom: var(--space-3);
  }
  .group {
    margin: var(--space-4) 0 var(--space-1);
    padding: 0 var(--space-3);
    color: var(--text-faint);
    font-size: var(--text-xs);
    font-weight: var(--weight-semibold);
    letter-spacing: 0.08em;
    text-transform: uppercase;
    white-space: nowrap;
  }
  .collapsed .group,
  .collapsed .lists {
    display: none;
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .item {
    position: relative;
    display: flex;
    align-items: center;
    gap: var(--space-3);
    width: 100%;
    padding: var(--space-2) var(--space-3);
    border: 0;
    border-radius: var(--radius-md);
    background: transparent;
    color: var(--text-muted);
    font-size: var(--text-md);
    text-align: left;
    cursor: pointer;
    transition:
      background var(--transition),
      color var(--transition);
  }
  .item:hover {
    background: var(--hover);
    color: var(--text);
  }
  .item.on {
    background: var(--accent-soft);
    color: var(--accent);
    font-weight: var(--weight-medium);
  }
  .item.small {
    padding: var(--space-1) var(--space-3);
    font-size: var(--text-sm);
  }
  .item :global(svg) {
    flex: none;
  }
  .label {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .bullet {
    display: inline-flex;
    color: var(--text-faint);
  }
  .badge {
    min-width: 18px;
    padding: 0 6px;
    border-radius: var(--radius-full);
    background: var(--accent-soft);
    color: var(--accent);
    font-size: var(--text-xs);
    line-height: 18px;
    text-align: center;
  }
  .collapsed .item {
    justify-content: center;
    padding: var(--space-3) 0;
  }
  .collapsed .label {
    display: none;
  }
  .collapsed .badge {
    position: absolute;
    top: 2px;
    right: 10px;
    min-width: 14px;
    padding: 0 4px;
    font-size: 9px;
    line-height: 14px;
  }
  .foot {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding-top: var(--space-2);
    border-top: 1px solid var(--border);
  }
  .account {
    margin-top: var(--space-1);
  }
  .who {
    display: flex;
    flex-direction: column;
  }
  .name {
    overflow: hidden;
    text-overflow: ellipsis;
    color: var(--text);
    font-size: var(--text-sm);
  }
  .host {
    overflow: hidden;
    text-overflow: ellipsis;
    color: var(--text-muted);
    font-size: var(--text-xs);
  }
</style>
