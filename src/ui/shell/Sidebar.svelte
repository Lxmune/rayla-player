<script lang="ts">
  import { getApp } from '../../lib/app.svelte';
  import { profileHost } from '../../lib/jellyfin/session.svelte';
  import Icon from '../common/Icon.svelte';
  import type { IconName } from '../common/icons';
  import { getRouter, getUi, type RootRoute } from './router.svelte';

  const app = getApp();
  const router = getRouter();
  const ui = getUi();

  const NAV: { id: RootRoute; label: string; icon: IconName }[] = [
    { id: 'home', label: 'Home', icon: 'home' },
    { id: 'search', label: 'Search', icon: 'search' },
    { id: 'artists', label: 'Artists', icon: 'artist' },
    { id: 'albums', label: 'Albums', icon: 'album' },
    { id: 'playlists', label: 'Playlists', icon: 'playlist' },
    { id: 'downloads', label: 'Downloads', icon: 'download' },
    { id: 'settings', label: 'Settings', icon: 'settings' },
  ];
  const active = $derived(app.core.sessions.active);
</script>

<nav class="side" aria-label="Main">
  <div class="brand">Rayla</div>
  <ul>
    {#each NAV as n (n.id)}
      <li>
        <button
          type="button"
          class:on={router.section === n.id}
          aria-current={router.section === n.id ? 'page' : undefined}
          onclick={() => router.go(n.id)}
        >
          <Icon name={n.icon} size={18} />
          <span>{n.label}</span>
        </button>
      </li>
    {/each}
  </ul>
  {#if active}
    <button type="button" class="account" aria-label="Accounts and servers" onclick={() => (ui.sheet = { kind: 'accounts' })}>
      <Icon name="user" size={18} />
      <span class="who">
        <span>{active.userName}</span>
        <span class="host">{profileHost(active)}</span>
      </span>
    </button>
  {/if}
</nav>

<style>
  .side {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    width: 220px;
    padding: var(--space-4) var(--space-3);
    background: var(--surface);
    border-right: 1px solid var(--border);
    overflow-y: auto;
  }
  .brand {
    padding: 0 var(--space-3);
    font-size: var(--text-lg);
    font-weight: 700;
    letter-spacing: -0.01em;
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
    flex: 1;
  }
  button {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    width: 100%;
    padding: var(--space-2) var(--space-3);
    border: 0;
    border-radius: var(--radius-md);
    background: transparent;
    color: var(--text-muted);
    text-align: left;
    cursor: pointer;
    transition: background var(--transition), color var(--transition);
  }
  button:hover {
    background: var(--surface-2);
    color: var(--text);
  }
  button.on {
    background: var(--accent-soft);
    color: var(--accent);
  }
  .account {
    border: 1px solid var(--border);
  }
  .who {
    display: flex;
    flex-direction: column;
    min-width: 0;
    font-size: var(--text-sm);
    color: var(--text);
  }
  .host {
    color: var(--text-muted);
    font-size: var(--text-xs);
    overflow: hidden;
    text-overflow: ellipsis;
  }
  @media (max-width: 720px) {
    .side {
      width: 64px;
    }
    .brand,
    button span {
      display: none;
    }
  }
</style>
