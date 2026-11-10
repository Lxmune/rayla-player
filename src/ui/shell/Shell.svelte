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
  import OutputSheet from '../sheets/OutputSheet.svelte';
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
  import { HistorySync } from './history-sync';
  import { watchPhone } from './phone';
  import { ScrollMemory, nextChipsHidden, pullState, shouldStartPull, PULL_TRIGGER_PX } from './gestures';
  import { haptic } from '../common/haptics';
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
    ({ signal: 'Signal path', tech: 'Track info', accounts: 'Servers', shortcuts: 'Keyboard shortcuts', addToPlaylist: 'Add to playlist', output: 'Output' } as const)[
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

  let phone = $state(false);
  $effect(() => watchPhone((p) => (phone = p)));
  const miniVisible = $derived(phone && app.core.player.current !== null);

  // System Back (Android gesture) walks overlays, then routes, then exits.
  const layers = $derived(
    router.depth +
      (ui.menu ? 1 : 0) +
      (ui.sheet ? 1 : 0) +
      (ui.nowPlayingOpen ? 1 : 0) +
      (ui.queueOpen ? 1 : 0),
  );
  const sync = new HistorySync({
    layers: () => layers,
    closeTop() {
      if (ui.menu) ui.closeMenu();
      else if (ui.sheet) ui.sheet = null;
      else if (ui.nowPlayingOpen) ui.nowPlayingOpen = false;
      else if (ui.queueOpen) ui.queueOpen = false;
      else router.up();
    },
  });
  $effect(() => sync.attach());
  $effect(() => sync.update(layers));

  let scroller: HTMLElement | undefined = $state();
  let topbar: { focusSearch: () => void } | undefined = $state();
  let scrolled = $state(false);
  let lastVolume = 1;

  // Scroll offsets per stack depth: pushes start at the top, back restores the page's offset.
  const memory = new ScrollMemory();
  let lastDepth = 0;
  let chipsHidden = $state(false);
  let refreshKey = $state(0);
  $effect.pre(() => {
    void route;
    // Runs before the DOM swaps: remember where the departing page was scrolled to.
    if (scroller) memory.save(lastDepth, scroller.scrollTop);
  });
  $effect(() => {
    void route;
    const depth = router.stack.length - 1;
    const nav = router.lastNav;
    if (nav === 'root') memory.clear();
    else if (nav === 'push') memory.clearFrom(depth);
    const top = nav === 'back' || nav === 'forward' ? memory.take(depth) : 0;
    lastDepth = depth;
    if (scroller) {
      scroller.scrollTop = top;
      if (top > 0) requestAnimationFrame(() => scroller && (scroller.scrollTop = top));
    }
    scrolled = top > 4;
    chipsHidden = false;
    pull = 0;
  });

  let prevTop = 0;
  function onscroll() {
    const top = scroller?.scrollTop ?? 0;
    scrolled = top > 4;
    if (phone) chipsHidden = nextChipsHidden(prevTop, top, chipsHidden);
    prevTop = top;
  }

  // Pull to refresh (phone root screens): remounts the page so it refetches.
  const PULL_ROUTES = ['home', 'albums', 'artists', 'songs', 'playlists', 'genres', 'favorites', 'downloads'];
  const canPull = $derived(phone && PULL_ROUTES.includes(route.name));
  let pull = $state(0);
  let pulling = $state(false);
  let pullArmed = false;
  $effect(() => {
    const el = scroller;
    if (!el || !canPull) return;
    let sx = 0;
    let sy = 0;
    let active = false;
    let tracking = false;
    const start = (e: TouchEvent) => {
      const t = e.touches[0];
      if (!t || e.touches.length > 1) return;
      sx = t.clientX;
      sy = t.clientY;
      tracking = el.scrollTop <= 0;
      active = false;
    };
    const move = (e: TouchEvent) => {
      const t = e.touches[0];
      if (!t || !tracking) return;
      const dx = t.clientX - sx;
      const dy = t.clientY - sy;
      if (!active) {
        if (dy < -6 || Math.abs(dx) > 12) tracking = false;
        else if (shouldStartPull(el.scrollTop, dx, dy)) active = true;
        else return;
        if (!active) return;
        pulling = true;
      }
      if (e.cancelable) e.preventDefault();
      const st = pullState(dy);
      pull = st.offset;
      if (st.armed && !pullArmed) haptic('tick');
      pullArmed = st.armed;
    };
    const end = () => {
      if (active && pullArmed) {
        haptic('confirm');
        refreshKey++;
      }
      active = tracking = pullArmed = false;
      pulling = false;
      pull = 0;
    };
    el.addEventListener('touchstart', start, { passive: true });
    el.addEventListener('touchmove', move, { passive: false });
    el.addEventListener('touchend', end);
    el.addEventListener('touchcancel', end);
    return () => {
      el.removeEventListener('touchstart', start);
      el.removeEventListener('touchmove', move);
      el.removeEventListener('touchend', end);
      el.removeEventListener('touchcancel', end);
    };
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

<div class="shell" class:phone class:has-mini={miniVisible}>
  <div class="main-row">
    <Sidebar />
    <div class="column">
      <div
        class="scroller"
        bind:this={scroller}
        {onscroll}
      >
        <TopBar bind:this={topbar} {scrolled} {phone} {chipsHidden} />
        {#if canPull}
          <div class="pull" class:released={!pulling} aria-hidden="true"
            style:transform="translateY({pull - 44}px)" style:opacity={Math.min(1, pull / PULL_TRIGGER_PX)}>
            <svg viewBox="0 0 24 24" width="22" height="22" style:transform="rotate({Math.min(1, pull / PULL_TRIGGER_PX) * 180}deg)">
              <path d="M12 5v14M6 13l6 6 6-6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
          </div>
        {/if}
        <main class="content">
          {#key route}{#key refreshKey}
            <div class="page nav-{router.lastNav}" style:transform={pull > 0 ? `translateY(${pull * 0.5}px)` : undefined}
              class:released={!pulling}>
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
          {/key}{/key}
        </main>
      </div>
    </div>
    {#if ui.queueOpen}
      <QueueDrawer />
    {/if}
  </div>
  <PlayerBar {phone} />

  {#if ui.nowPlayingOpen}
    <NowPlaying />
  {/if}

  {#if ui.sheet}
    <Sheet title={sheetTitle} onclose={() => (ui.sheet = null)}>
      {#if ui.sheet.kind === 'signal'}
        <SignalPathSheet />
      {:else if ui.sheet.kind === 'tech'}
        <TechInfoSheet item={ui.sheet.item} />
      {:else if ui.sheet.kind === 'output'}
        <OutputSheet />
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
    height: 100dvh;
    /* Edge-to-edge on Android/iOS: keep clear of the status bar / notch. */
    padding: env(safe-area-inset-top, 0px) env(safe-area-inset-right, 0px) 0 env(safe-area-inset-left, 0px);
    background: var(--bg);
    --dock-h: 0px;
    -webkit-tap-highlight-color: transparent;
  }
  /* Room for the floating mini player (64px card + its inset above and below). */
  .shell.has-mini {
    --dock-h: calc(64px + var(--space-2) * 2);
  }
  .shell.has-mini .content {
    padding-bottom: calc(var(--dock-h) + var(--space-4));
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
  .page.released {
    transition: transform var(--duration) var(--ease-out);
  }
  .page.nav-push {
    animation: page-in-right 240ms var(--ease-out);
  }
  .page.nav-forward {
    animation: page-in-right 240ms var(--ease-out);
  }
  .page.nav-back {
    animation: page-in-left 240ms var(--ease-out);
  }
  .page.nav-root {
    animation: rise-in 220ms var(--ease-out);
  }
  .phone .page.nav-push,
  .phone .page.nav-forward {
    animation: page-in-right-lg 280ms var(--ease-out);
  }
  .phone .page.nav-back {
    animation: page-in-left-lg 280ms var(--ease-out);
  }
  .pull {
    position: absolute;
    top: 0;
    left: 50%;
    z-index: calc(var(--z-sticky) - 1);
    margin-left: -18px;
    width: 36px;
    height: 36px;
    display: grid;
    place-items: center;
    border-radius: 50%;
    background: var(--surface-2);
    color: var(--accent);
    box-shadow: var(--shadow-2);
    pointer-events: none;
    will-change: transform;
  }
  .pull.released {
    transition: transform var(--duration) var(--ease-out), opacity var(--duration) var(--ease-out);
  }
  .pull svg {
    will-change: transform;
  }
  .scroller {
    position: relative;
  }
  @media (prefers-reduced-motion: reduce) {
    .page,
    .page.released,
    .pull.released {
      animation: none !important;
      transition: none !important;
    }
  }
  :global(:root[data-motion='reduced']) .page {
    animation: none !important;
  }
</style>
