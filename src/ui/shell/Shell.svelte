<script lang="ts">
  import { getApp } from '../../lib/app.svelte';
  import SettingsScreen from '../settings/SettingsScreen.svelte';
  import DownloadsScreen from '../downloads/DownloadsScreen.svelte';
  import SignalPathSheet from '../sheets/SignalPathSheet.svelte';
  import TechInfoSheet from '../sheets/TechInfoSheet.svelte';
  import AlbumScreen from '../browse/AlbumScreen.svelte';
  import AlbumsScreen from '../browse/AlbumsScreen.svelte';
  import ArtistScreen from '../browse/ArtistScreen.svelte';
  import ArtistsScreen from '../browse/ArtistsScreen.svelte';
  import HomeScreen from '../browse/HomeScreen.svelte';
  import PlaylistScreen from '../browse/PlaylistScreen.svelte';
  import PlaylistsScreen from '../browse/PlaylistsScreen.svelte';
  import SearchScreen from '../browse/SearchScreen.svelte';
  import FavoritesScreen from '../browse/FavoritesScreen.svelte';
  import GenreScreen from '../browse/GenreScreen.svelte';
  import GenresScreen from '../browse/GenresScreen.svelte';
  import SongsScreen from '../browse/SongsScreen.svelte';
  import AddToPlaylistSheet from '../sheets/AddToPlaylistSheet.svelte';
  import ShortcutsSheet from '../sheets/ShortcutsSheet.svelte';
  import ContextMenu from '../common/ContextMenu.svelte';
  import Toasts from '../common/Toasts.svelte';
  import AccountSheet from '../login/AccountSheet.svelte';
  import Sheet from '../common/Sheet.svelte';
  import { useActions } from '../common/actions';
  import NowPlaying from '../now-playing/NowPlaying.svelte';
  import PlayerBar from './PlayerBar.svelte';
  import QueueDrawer from './QueueDrawer.svelte';
  import Sidebar from './Sidebar.svelte';
  import TopBar from './TopBar.svelte';
  import { shortcutFor, type ShortcutAction } from './shortcuts';
  import {
    Router,
    UiState,
    provideRouter,
    provideUi,
  } from './router.svelte';

  const app = getApp();
  const router = provideRouter(new Router(app.core.settings.current.behavior.startScreen));
  const ui = provideUi(new UiState());

  const actions = useActions();
  const route = $derived(router.current);
  const sheetTitle = $derived(
    ({ signal: 'Signal path', tech: 'Track info', accounts: 'Servers', shortcuts: 'Keyboard shortcuts', addToPlaylist: 'Add to playlist' } as const)[
      ui.sheet?.kind ?? 'signal'
    ],
  );

  // A new profile starts on Home with a clean overlay state.
  $effect(() => {
    return app.core.sessions.onActiveChange(() => {
      router.go(app.core.settings.current.behavior.startScreen);
      ui.nowPlayingOpen = false;
      ui.sheet = null;
    });
  });

  let scroller: HTMLElement | undefined = $state();
  let topbar: { focusSearch: () => void } | undefined = $state();
  let scrolled = $state(false);
  let lastVolume = 1;

  // Every navigation starts at the top of the page.
  $effect(() => {
    void route;
    if (scroller) scroller.scrollTop = 0;
    scrolled = false;
  });

  const isTyping = (t: EventTarget | null) =>
    t instanceof HTMLElement &&
    (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName));

  /** Controls that use Space (and the arrow keys) themselves. */
  const isControl = (t: EventTarget | null) =>
    t instanceof HTMLElement &&
    (['BUTTON', 'A'].includes(t.tagName) || ['tab', 'slider'].includes(t.getAttribute('role') ?? ''));

  function run(action: ShortcutAction) {
    const player = app.core.player;
    const guard = actions.guard;
    switch (action) {
      case 'playPause':
        return void guard(() => player.togglePlay());
      case 'next':
        return void guard(() => player.next());
      case 'previous':
        return void guard(() => player.previous());
      case 'seekForward':
      case 'seekBack': {
        if (!player.current) return;
        const to = player.positionMs + (action === 'seekForward' ? 10_000 : -10_000);
        const max = player.durationMs > 0 ? player.durationMs : Number.MAX_SAFE_INTEGER;
        return void guard(() => player.seek(Math.min(max, Math.max(0, to))));
      }
      case 'volumeUp':
      case 'volumeDown': {
        const v = app.core.settings.current.dsp.volume + (action === 'volumeUp' ? 0.05 : -0.05);
        return void actions.setVolume(Math.round(Math.min(1, Math.max(0, v)) * 100) / 100);
      }
      case 'mute': {
        const v = app.core.settings.current.dsp.volume;
        if (v > 0) lastVolume = v;
        return void actions.setVolume(v > 0 ? 0 : lastVolume);
      }
      case 'shuffle':
        return void guard(() => player.toggleShuffle());
      case 'repeat':
        return void guard(() => player.cycleRepeat());
      case 'favorite':
        if (player.current) void actions.toggleFavorite(player.current);
        return;
      case 'search':
        return topbar?.focusSearch();
      case 'back':
        return router.back();
      case 'forward':
        return router.forward();
      case 'queue':
        ui.queueOpen = !ui.queueOpen;
        return;
      case 'nowPlaying':
        ui.nowPlayingOpen = !ui.nowPlayingOpen;
        return;
      case 'help':
        ui.sheet = { kind: 'shortcuts' };
        return;
    }
  }

  function onkeydown(e: KeyboardEvent) {
    if (e.defaultPrevented || ui.sheet !== null || ui.menu !== null) return;
    const action = shortcutFor(e);
    if (!action) return;
    const t = e.target;
    if (isTyping(t)) {
      if (action !== 'search' || !(e.ctrlKey || e.metaKey)) return;
    } else if (isControl(t)) {
      if (action === 'playPause') return;
      if (t instanceof HTMLElement && t.getAttribute('role') === 'slider' && e.key.startsWith('Arrow')) return;
    }
    e.preventDefault();
    run(action);
  }

  /** Mouse back / forward buttons. */
  function onmouseup(e: MouseEvent) {
    if (e.button !== 3 && e.button !== 4) return;
    e.preventDefault();
    if (e.button === 3) router.back();
    else router.forward();
  }
</script>

<svelte:window {onkeydown} {onmouseup} />

<div class="shell">
  <div class="main-row">
    <Sidebar />
    <div class="column">
      <div
        class="scroller"
        bind:this={scroller}
        onscroll={() => (scrolled = (scroller?.scrollTop ?? 0) > 4)}
      >
        <TopBar bind:this={topbar} {scrolled} />
        <main class="content">
          {#key route}
            <div class="page">
        {#if route.name === 'home'}
          <HomeScreen />
        {:else if route.name === 'artists'}
          <ArtistsScreen />
        {:else if route.name === 'albums'}
          <AlbumsScreen />
        {:else if route.name === 'playlists'}
          <PlaylistsScreen />
        {:else if route.name === 'search'}
          <SearchScreen />
        {:else if route.name === 'downloads'}
          <DownloadsScreen />
        {:else if route.name === 'settings'}
          <SettingsScreen />
        {:else if route.name === 'artist'}
          <ArtistScreen item={route.item} />
        {:else if route.name === 'album'}
          <AlbumScreen item={route.item} />
        {:else if route.name === 'playlist'}
          <PlaylistScreen item={route.item} />
        {:else if route.name === 'favorites'}
          <FavoritesScreen />
        {:else if route.name === 'songs'}
          <SongsScreen />
        {:else if route.name === 'genres'}
          <GenresScreen />
        {:else if route.name === 'genre'}
          <GenreScreen item={route.item} />
        {/if}
            </div>
          {/key}
        </main>
      </div>
    </div>
    {#if ui.queueOpen}
      <QueueDrawer />
    {/if}
  </div>
  <PlayerBar />

  {#if ui.nowPlayingOpen}
    <NowPlaying />
  {/if}

  {#if ui.sheet}
    <Sheet title={sheetTitle} onclose={() => (ui.sheet = null)}>
      {#if ui.sheet.kind === 'signal'}
        <SignalPathSheet />
      {:else if ui.sheet.kind === 'tech'}
        <TechInfoSheet item={ui.sheet.item} />
      {:else if ui.sheet.kind === 'shortcuts'}
        <ShortcutsSheet />
      {:else if ui.sheet.kind === 'addToPlaylist'}
        <AddToPlaylistSheet tracks={ui.sheet.tracks} onclose={() => (ui.sheet = null)} />
      {:else}
        <AccountSheet onclose={() => (ui.sheet = null)} />
      {/if}
    </Sheet>
  {/if}

  <ContextMenu />
  <Toasts />
</div>

<style>
  .shell {
    display: flex;
    flex-direction: column;
    height: 100vh;
    background: var(--bg);
  }
  .main-row {
    position: relative;
    flex: 1;
    min-height: 0;
    display: flex;
  }
  .column {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
  }
  .scroller {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
  }
  .content {
    max-width: var(--content-max);
    margin: 0 auto;
    padding: var(--space-4) var(--gutter) var(--space-6);
  }
  .page {
    animation: rise-in var(--duration-slow) var(--ease-out);
  }
</style>
