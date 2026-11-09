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
  import AccountSheet from '../login/AccountSheet.svelte';
  import IconButton from '../common/IconButton.svelte';
  import Sheet from '../common/Sheet.svelte';
  import { useActions } from '../common/actions';
  import NowPlaying from '../now-playing/NowPlaying.svelte';
  import PlayerBar from './PlayerBar.svelte';
  import Sidebar from './Sidebar.svelte';
  import {
    Router,
    UiState,
    provideRouter,
    provideUi,
  } from './router.svelte';

  const router = provideRouter(new Router());
  const ui = provideUi(new UiState());

  const app = getApp();
  const actions = useActions();
  const route = $derived(router.current);
  const sheetTitle = $derived(
    ui.sheet?.kind === 'signal' ? 'Signal path' : ui.sheet?.kind === 'tech' ? 'Track info' : 'Servers',
  );

  // A new profile starts on Home with a clean overlay state.
  $effect(() => {
    return app.core.sessions.onActiveChange(() => {
      router.go('home');
      ui.nowPlayingOpen = false;
      ui.sheet = null;
    });
  });

  /** Space toggles playback unless the user is typing or on a control that uses Space itself. */
  function onkeydown(e: KeyboardEvent) {
    if (e.key !== ' ' && e.code !== 'Space') return;
    if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target;
    if (t instanceof HTMLElement) {
      if (t.isContentEditable) return;
      if (['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON', 'A'].includes(t.tagName)) return;
      if (t.getAttribute('role') === 'tab') return;
    }
    if (ui.sheet !== null) return;
    e.preventDefault();
    void actions.guard(() => app.core.player.togglePlay());
  }
</script>

<svelte:window {onkeydown} />

<div class="shell">
  <div class="main-row">
    <Sidebar />
    <main class="content">
      {#if router.canBack}
        <div class="back"><IconButton icon="back" label="Back" onclick={() => router.back()} /></div>
      {/if}
      {#key route}
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
        {/if}
      {/key}
    </main>
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
      {:else}
        <AccountSheet onclose={() => (ui.sheet = null)} />
      {/if}
    </Sheet>
  {/if}
</div>

<style>
  .shell {
    display: flex;
    flex-direction: column;
    height: 100vh;
  }
  .main-row {
    flex: 1;
    min-height: 0;
    display: flex;
  }
  .content {
    flex: 1;
    min-width: 0;
    overflow-y: auto;
    padding: var(--space-5);
  }
  .back {
    margin: calc(-1 * var(--space-2)) 0 var(--space-2) calc(-1 * var(--space-2));
  }
</style>
