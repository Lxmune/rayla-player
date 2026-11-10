<script lang="ts">
  import { untrack } from 'svelte';
  import { getApp } from '../../lib/app.svelte';
  import type { JellyfinClient } from '../../lib/jellyfin/client';
  import { dailyMixes, dayKey, type DailyMix } from '../../lib/recommend/daily-mixes';
  import { discoverPage, type DiscoverPage } from '../../lib/recommend/recommender';
  import { getUi } from '../shell/router.svelte';
  import Artwork from '../common/Artwork.svelte';
  import { buildRadio } from '../../lib/recommend/radio';
  import Button from '../common/Button.svelte';
  import Icon from '../common/Icon.svelte';
  import IconButton from '../common/IconButton.svelte';
  import ScreenHeader from '../common/ScreenHeader.svelte';
  import Shelf from '../common/Shelf.svelte';
  import Skeleton from '../common/Skeleton.svelte';
  import TrackList from '../common/TrackList.svelte';
  import { useActions } from '../common/actions';
  import { Resource } from '../common/resource.svelte';

  const app = getApp();
  const act = useActions();
  const ui = getUi();
  const page = new Resource<DiscoverPage>();
  const mixes = new Resource<DailyMix[]>();

  function loadMixes(client: JellyfinClient) {
    const profileId = app.core.sessions.activeId ?? '';
    void mixes.load(
      () => dailyMixes(client, { kv: app.kv, profileId, skips: app.skips.profile() }),
      `${profileId}:daily-mixes:${dayKey(Date.now())}`,
    );
  }

  function load(client: JellyfinClient, fresh = false) {
    if (!fresh) loadMixes(client);
    void page.load(
      () => discoverPage(client, Date.now(), fresh, app.skips.profile()),
      `${app.core.sessions.activeId}:discover`,
    );
  }

  $effect(() => {
    const client = app.core.sessions.client;
    if (client) untrack(() => load(client));
  });

  function refresh() {
    const client = app.core.sessions.client;
    if (client) load(client, true);
  }

  const mixList = $derived.by(() => {
    void app.skips.version; // a "Not interested" hides items at once
    const skips = app.skips.profile();
    return (mixes.data ?? [])
      .map((m) => ({ ...m, tracks: m.tracks.filter((t) => !skips.isSkipped(t.id)) }))
      .filter((m) => m.tracks.length > 0);
  });

  function mixMenu(el: HTMLElement | MouseEvent, m: DailyMix) {
    ui.openMenu(el, [
      { label: 'Play', icon: 'play', onselect: () => void act.playTracks(m.tracks, 0) },
      { label: 'Shuffle', icon: 'shuffle', onselect: () => void act.playTracks(m.tracks, 0, true) },
      'separator',
      { label: 'Save as playlist', icon: 'playlistAdd', onselect: () => void act.createPlaylist(m.name, m.tracks) },
    ]);
  }

  let startingRadio = $state(false);
  async function startRadio() {
    const client = app.core.sessions.client;
    if (!client || startingRadio) return;
    startingRadio = true;
    try {
      const radio = await buildRadio(client, { kind: 'discover', skips: app.skips.profile() });
      if (!radio) app.core.errors.report('Not enough listening history to start a radio yet.');
      else await app.core.player.playRadio(radio.seed, radio.more, radio.label);
    } catch (e) {
      app.core.errors.report(e);
    } finally {
      startingRadio = false;
    }
  }

  const d = $derived(page.data);
  const mixLine = $derived(
    d ? `${d.mix.length} tracks you haven't played${d.topGenres.length ? ` · ${d.topGenres.slice(0, 2).join(', ')}` : ''}` : '',
  );
  const albums = $derived(d?.albums.map((s) => s.item) ?? []);
  const newAlbums = $derived(d?.newInGenres.map((s) => s.item) ?? []);
  const artists = $derived(d?.artists.map((s) => s.artist) ?? []);
  const artistHint = $derived.by(() => {
    const names = [...new Set(d?.artists.map((s) => s.because) ?? [])].slice(0, 2);
    return names.length > 0 ? `Similar to ${names.join(' and ')}` : undefined;
  });
</script>

<section class="screen">
  <ScreenHeader title="Discover" subtitle="New music picked from what you listen to">
    {#if d?.ready}
      <Button primary icon="play" disabled={startingRadio} onclick={() => void startRadio()}>Start radio</Button>
    {/if}
    <IconButton icon="refresh" label="Refresh recommendations" onclick={refresh} />
  </ScreenHeader>

  {#if page.error}
    <p class="error" role="alert">{page.error}</p>
  {/if}

  {#if page.loading && !d}
    <div class="loading" aria-hidden="true">
      <Skeleton height="72px" radius="var(--radius-lg)" />
    </div>
    <Shelf title="Recommended albums" loading />
  {:else if d && !d.ready}
    <div class="empty">
      <Icon name="sparkle" size={28} />
      <p>Play more music to get recommendations.</p>
      <p class="hint">Discover learns your taste from what you play and favourite.</p>
    </div>
  {:else if d}
    {#if mixList.length > 0}
      <Shelf title="Daily mixes" subtitle="Refreshed every day from what you listen to">
        {#each mixList as m (m.id)}
          <div class="mix-cell" oncontextmenu={(e) => mixMenu(e, m)} role="presentation">
            <div class="mix-cover" class:mosaic={m.covers.length >= 4}>
              {#each m.covers.length >= 4 ? m.covers.slice(0, 4) : m.covers.slice(0, 1) as c (c.id)}
                <span aria-hidden="true"><Artwork item={c} size={m.covers.length >= 4 ? 90 : 180} fill /></span>
              {/each}
              <button type="button" class="mix-play" aria-label={`Play ${m.name}`} onclick={() => void act.playTracks(m.tracks, 0)}>
                <Icon name="play" size={20} />
              </button>
              <button
                type="button"
                class="mix-more"
                aria-label={`More options for ${m.name}`}
                onclick={(e) => mixMenu(e.currentTarget, m)}
              >
                <Icon name="more" size={18} />
              </button>
            </div>
            <span class="mix-name">{m.name}</span>
            <span class="mix-meta">{m.tracks.length} tracks</span>
          </div>
        {/each}
      </Shelf>
    {/if}

    {#if d.mix.length > 0}
      <div class="mix">
        <span class="mix-icon" aria-hidden="true"><Icon name="sparkle" size={22} /></span>
        <span class="mix-text">
          <span class="mix-title">Discover mix</span>
          <span class="mix-sub">{mixLine}</span>
        </span>
        <Button primary icon="play" onclick={() => void act.playTracks(d.mix, 0)}>Play</Button>
        <Button icon="shuffle" onclick={() => void act.playTracks(d.mix, 0, true)}>Shuffle</Button>
      </div>
    {/if}

    {#if albums.length > 0}
      <Shelf title="Recommended albums" subtitle="Based on what you listen to" items={albums} />
    {/if}

    {#if artists.length > 0}
      <Shelf title="Artists you might like" subtitle={artistHint} items={artists} />
    {/if}

    {#each d.becauseArtist as shelf (shelf.artist)}
      <Shelf title="Because you listened to {shelf.artist}" items={shelf.albums.map((s) => s.item)} />
    {/each}

    {#each d.byGenre as shelf (shelf.genre)}
      <Shelf title="Because you like {shelf.genre}" items={shelf.albums.map((s) => s.item)} />
    {/each}

    {#if newAlbums.length > 0}
      <Shelf title="New in your genres" subtitle="Recently added, not played yet" items={newAlbums} />
    {/if}

    {#if d.rediscover.length > 0}
      <section class="tracks" aria-labelledby="rediscover">
        <h2 id="rediscover">Rediscover</h2>
        <p class="sub">Tracks you used to play a lot</p>
        <TrackList tracks={d.rediscover.slice(0, 10)} numbered={false} onplay={(i) => void act.playTracks(d.rediscover, i)} />
      </section>
    {/if}

    {#if d.deepCuts.length > 0}
      <section class="tracks" aria-labelledby="deep-cuts">
        <h2 id="deep-cuts">Deep cuts</h2>
        <p class="sub">Never played tracks by your favourite artists</p>
        <TrackList tracks={d.deepCuts.slice(0, 10)} numbered={false} onplay={(i) => void act.playTracks(d.deepCuts, i)} />
      </section>
    {/if}

    {#if d.favourites.length > 0}
      <section class="tracks" aria-labelledby="stale-favs">
        <h2 id="stale-favs">Favourites you haven't played lately</h2>
        <TrackList tracks={d.favourites.slice(0, 10)} numbered={false} onplay={(i) => void act.playTracks(d.favourites, i)} />
      </section>
    {/if}

    {#if !d.mix.length && !albums.length && !artists.length && !d.becauseArtist.length && !d.byGenre.length && !newAlbums.length && !d.rediscover.length && !d.deepCuts.length && !d.favourites.length}
      <p class="muted">Nothing new to suggest right now. Check back after listening to more.</p>
    {/if}
  {/if}
</section>

<style>
  .mix {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-3) var(--space-4);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    background: linear-gradient(120deg, var(--accent-soft), var(--surface) 70%);
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
  .mix-cell {
    display: flex;
    flex: 0 0 var(--card-min);
    flex-direction: column;
    gap: 2px;
    width: var(--card-min);
    min-width: 0;
    padding: var(--space-3);
    scroll-snap-align: start;
  }
  .mix-cover {
    position: relative;
    display: grid;
    aspect-ratio: 1;
    margin-bottom: var(--space-2);
    overflow: hidden;
    border-radius: var(--radius-md);
    box-shadow: var(--shadow-1);
    background: var(--surface);
  }
  .mix-cover.mosaic {
    grid-template: 1fr 1fr / 1fr 1fr;
  }
  .mix-cover span {
    display: block;
    min-width: 0;
    min-height: 0;
  }
  .mix-play,
  .mix-more {
    position: absolute;
    display: grid;
    place-items: center;
    border: 0;
    cursor: pointer;
    color: #fff;
    background: rgb(0 0 0 / 0.55);
  }
  .mix-play {
    right: var(--space-2);
    bottom: var(--space-2);
    width: 40px;
    height: 40px;
    border-radius: 50%;
    background: var(--accent);
  }
  .mix-more {
    top: var(--space-2);
    right: var(--space-2);
    width: 30px;
    height: 30px;
    border-radius: 50%;
  }
  .mix-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-weight: var(--weight-semibold);
  }
  .mix-meta {
    font-size: var(--text-sm);
    color: var(--text-muted);
  }
  .tracks {
    margin-top: var(--space-6);
  }
  h2 {
    margin: 0;
    font-size: var(--text-lg);
    font-weight: var(--weight-semibold);
  }
  .sub {
    margin: var(--space-1) 0 var(--space-2);
    font-size: var(--text-sm);
    color: var(--text-muted);
  }
  .empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-8) var(--space-4);
    color: var(--text-muted);
    text-align: center;
  }
  .empty p {
    margin: 0;
    color: var(--text);
  }
  .empty .hint {
    font-size: var(--text-sm);
    color: var(--text-muted);
  }
  .loading {
    margin-bottom: var(--space-2);
  }
  .muted {
    margin-top: var(--space-6);
    color: var(--text-muted);
  }
  .error {
    color: var(--danger);
  }
  @media (max-width: 640px) {
    .mix {
      flex-wrap: wrap;
    }
    .mix-text {
      flex-basis: calc(100% - 60px);
    }
  }
</style>
