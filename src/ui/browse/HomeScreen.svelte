<script lang="ts">
  import { untrack } from 'svelte';
  import { getApp } from '../../lib/app.svelte';
  import type { JellyfinClient } from '../../lib/jellyfin/client';
  import type { BaseItem } from '../../lib/jellyfin/models';
  import Artwork from '../common/Artwork.svelte';
  import Icon from '../common/Icon.svelte';
  import IconButton from '../common/IconButton.svelte';
  import Shelf from '../common/Shelf.svelte';
  import TrackList from '../common/TrackList.svelte';
  import { useActions } from '../common/actions';
  import { Resource } from '../common/resource.svelte';
  import { getRouter } from '../shell/router.svelte';
  import { forYou, type ForYou } from '../../lib/recommend/recommender';

  const app = getApp();
  const router = getRouter();
  const act = useActions();

  const played = new Resource<BaseItem[]>();
  const added = new Resource<BaseItem[]>();
  const mostPlayed = new Resource<BaseItem[]>();
  const rediscover = new Resource<BaseItem[]>();
  const favorites = new Resource<BaseItem[]>();
  const playlists = new Resource<BaseItem[]>();
  const recs = new Resource<ForYou>();

  const hour = new Date().getHours();
  const greeting = hour < 5 ? 'Good night' : hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';

  function loadAll(client: JellyfinClient, fresh = false) {
    void recs.load(() => forYou(client, Date.now(), fresh));
    void played.load(
      async () =>
        (await client.albums({ playedOnly: true, sortBy: 'DatePlayed', descending: true, limit: 20 })).items,
    );
    void added.load(async () => (await client.recentlyAddedAlbums({ limit: 24 })).items);
    void mostPlayed.load(
      async () =>
        (await client.tracks({ playedOnly: true, sortBy: 'PlayCount', descending: true, limit: 10 })).items,
    );
    void rediscover.load(async () => (await client.albums({ sortBy: 'Random', limit: 20 })).items);
    void favorites.load(async () => (await client.albums({ favoritesOnly: true, limit: 20 })).items);
    void playlists.load(async () => (await client.playlists({ limit: 20 })).items);
  }

  $effect(() => {
    const client = app.core.sessions.client;
    if (client) untrack(() => loadAll(client));
  });

  function refresh() {
    const client = app.core.sessions.client;
    if (client) loadAll(client, true);
  }

  const hasData = (r: Resource<BaseItem[]>) => (r.data ?? []).length > 0;
  /** A shelf shows while loading its first data, and when it has items. */
  const visible = (r: Resource<BaseItem[]>) => (r.loading && !r.data) || hasData(r);

  const quick = $derived((hasData(played) ? played.data : added.data)?.slice(0, 6) ?? []);
  const topTracks = $derived(mostPlayed.data ?? []);
  const fy = $derived(recs.data);
  const mixLine = $derived(
    fy ? `${fy.mix.length} tracks you haven't played${fy.topGenres.length ? ` · ${fy.topGenres.slice(0, 2).join(', ')}` : ''}` : '',
  );
  const half = $derived(Math.ceil(topTracks.length / 2));
  const allEmpty = $derived(
    [played, added, mostPlayed, rediscover, favorites, playlists].every((r) => !r.loading && !hasData(r)),
  );
  const firstError = $derived(
    [added, played, rediscover].map((r) => r.error).find((e): e is string => e !== null) ?? null,
  );
</script>

<section class="screen">
  <header class="head">
    <h1>{greeting}</h1>
    <IconButton icon="refresh" label="Refresh home" onclick={refresh} />
  </header>

  {#if firstError}
    <p class="error" role="alert">{firstError}</p>
  {/if}

  {#if quick.length > 0}
    <div class="quick" role="list">
      {#each quick as album (album.id)}
        <div class="tile" role="listitem">
          <button type="button" class="open" onclick={() => router.open(album)}>
            <Artwork item={album} size={64} />
            <span class="name">{album.name}</span>
          </button>
          <button type="button" class="play" aria-label="Play {album.name}" onclick={() => void act.play(album)}>
            <Icon name="play" size={18} />
          </button>
        </div>
      {/each}
    </div>
  {/if}

  {#if fy && fy.mix.length > 0}
    <button type="button" class="mix" onclick={() => void act.playTracks(fy.mix, 0)}>
      <span class="mix-icon" aria-hidden="true"><Icon name="sparkle" size={22} /></span>
      <span class="mix-text">
        <span class="mix-title">Discover mix</span>
        <span class="mix-sub">{mixLine}</span>
      </span>
      <span class="mix-play" aria-hidden="true"><Icon name="play" size={18} /></span>
    </button>
  {/if}

  {#if fy && fy.albums.length > 0}
    <Shelf title="Recommended for you" subtitle="Based on what you listen to" items={fy.albums.map((s) => s.item)} />
  {/if}

  {#if visible(played)}
    <Shelf title="Recently played" items={played.data ?? []} loading={played.loading && !played.data} />
  {/if}

  {#if visible(added)}
    <Shelf
      title="Recently added"
      items={added.data ?? []}
      loading={added.loading && !added.data}
      onseeall={() => router.go('albums')}
    />
  {/if}

  {#if topTracks.length > 0}
    <section class="top" aria-labelledby="most-played">
      <h2 id="most-played">Most played</h2>
      <div class="two-col">
        <TrackList
          tracks={topTracks.slice(0, half)}
          numbered={false}
          onplay={(i) => void act.playTracks(topTracks, i)}
        />
        <TrackList
          tracks={topTracks.slice(half)}
          numbered={false}
          onplay={(i) => void act.playTracks(topTracks, half + i)}
        />
      </div>
    </section>
  {/if}

  {#each fy?.byGenre ?? [] as shelf (shelf.genre)}
    <Shelf title="Because you like {shelf.genre}" items={shelf.albums.map((s) => s.item)} />
  {/each}

  {#if visible(rediscover)}
    <Shelf
      title="Rediscover"
      subtitle="Random picks from your library"
      items={rediscover.data ?? []}
      loading={rediscover.loading && !rediscover.data}
    />
  {/if}

  {#if hasData(favorites)}
    <Shelf title="Favorite albums" items={favorites.data ?? []} onseeall={() => router.go('favorites')} />
  {/if}

  {#if hasData(playlists)}
    <Shelf title="Your playlists" items={playlists.data ?? []} onseeall={() => router.go('playlists')} />
  {/if}

  {#if allEmpty && !firstError}
    <p class="muted">Your library looks empty. Add some music to your Jellyfin server.</p>
  {/if}
</section>

<style>
  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    margin-bottom: var(--space-4);
  }
  h1 {
    margin: 0;
    font-family: var(--font-display);
    font-size: var(--text-2xl);
    font-weight: var(--weight-bold);
    letter-spacing: var(--tracking-tight);
  }
  @media (max-width: 640px) {
    /* The phone top bar shows the greeting. */
    h1 {
      display: none;
    }
    .head {
      justify-content: flex-end;
      margin-bottom: var(--space-2);
    }
  }
  h2 {
    margin: 0 0 var(--space-2);
    font-size: var(--text-lg);
    font-weight: var(--weight-semibold);
  }
  .quick {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
    gap: var(--space-3);
  }
  .tile {
    position: relative;
    border-radius: var(--radius-md);
    background: var(--surface);
    overflow: hidden;
    transition: background var(--transition);
  }
  .tile:hover {
    background: var(--surface-2);
  }
  .open {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    width: 100%;
    padding: 0;
    padding-right: 56px;
    border: 0;
    background: transparent;
    color: inherit;
    text-align: left;
    cursor: pointer;
  }
  .open:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: -2px;
  }
  .name {
    min-width: 0;
    font-weight: var(--weight-semibold);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .play {
    position: absolute;
    right: var(--space-3);
    top: 50%;
    display: grid;
    place-items: center;
    width: 36px;
    height: 36px;
    border: 0;
    border-radius: 50%;
    background: var(--accent);
    color: var(--accent-contrast);
    box-shadow: var(--shadow-2);
    cursor: pointer;
    opacity: 0;
    transform: translateY(-40%);
    transition: opacity var(--transition), transform var(--transition);
  }
  .tile:hover .play,
  .play:focus-visible {
    opacity: 1;
    transform: translateY(-50%);
  }
  .play:focus-visible {
    outline: 2px solid var(--text);
    outline-offset: 2px;
  }
  .top {
    margin-top: var(--space-6);
  }
  .mix {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    width: 100%;
    margin-top: var(--space-4);
    padding: var(--space-3) var(--space-4);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    background: linear-gradient(120deg, var(--accent-soft), var(--surface) 70%);
    color: inherit;
    text-align: left;
    cursor: pointer;
    transition: background var(--transition), transform var(--duration-fast) var(--ease-out);
  }
  .mix:active {
    transform: scale(0.98);
  }
  .mix-icon {
    display: grid;
    place-items: center;
    flex: none;
    width: 44px;
    height: 44px;
    border-radius: var(--radius-md);
    background: var(--accent-soft);
    color: var(--accent);
  }
  .mix-text {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-width: 0;
  }
  .mix-title {
    font-weight: var(--weight-semibold);
  }
  .mix-sub {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: var(--text-sm);
    color: var(--text-muted);
  }
  .mix-play {
    display: grid;
    place-items: center;
    flex: none;
    width: 40px;
    height: 40px;
    border-radius: 50%;
    background: var(--accent);
    color: var(--accent-contrast);
  }
  .two-col {
    display: grid;
    /* minmax(0, …): long titles ellipsize instead of widening the page. */
    grid-template-columns: minmax(0, 1fr);
    column-gap: var(--space-5);
  }
  @media (min-width: 1100px) {
    .two-col {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
  }
  .muted {
    margin-top: var(--space-6);
    color: var(--text-muted);
  }
  .error {
    color: var(--danger);
  }
</style>
