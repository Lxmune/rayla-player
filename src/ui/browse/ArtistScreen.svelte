<script lang="ts">
  import { untrack } from 'svelte';
  import { getApp } from '../../lib/app.svelte';
  import type { BaseItem } from '../../lib/jellyfin/models';
  import Button from '../common/Button.svelte';
  import Card from '../common/Card.svelte';
  import Grid from '../common/Grid.svelte';
  import IconButton from '../common/IconButton.svelte';
  import Shelf from '../common/Shelf.svelte';
  import Skeleton from '../common/Skeleton.svelte';
  import TrackList from '../common/TrackList.svelte';
  import { plural } from '../common/format';
  import { useActions } from '../common/actions';
  import { useItemMenu } from '../common/item-menu';
  import { Resource } from '../common/resource.svelte';
  import { getRouter, getUi } from '../shell/router.svelte';
  import DetailHero from './DetailHero.svelte';

  let { item }: { item: BaseItem } = $props();

  const app = getApp();
  const router = getRouter();
  const ui = getUi();
  const act = useActions();
  const menuFor = useItemMenu();
  const albums = new Resource<BaseItem[]>();
  const popular = new Resource<BaseItem[]>();
  const similar = new Resource<BaseItem[]>();

  type Filter = 'all' | 'albums' | 'singles';
  let filter = $state<Filter>('all');
  let showAll = $state(false);

  $effect(() => {
    const client = app.core.sessions.client;
    const id = item.id;
    if (!client) return;
    untrack(() => {
      filter = 'all';
      showAll = false;
      void albums.load(async () => (await client.artistAlbums(id)).items);
      void popular.load(
        async () =>
          (await client.tracks({ artistId: id, sortBy: 'PlayCount', descending: true, limit: 10 })).items,
      );
      void similar.load(async () => (await client.similar(id, 12)).items);
    });
  });

  const isSingle = (a: BaseItem) => a.childCount !== null && a.childCount <= 6;
  /** Newest first. */
  const discography = $derived(
    [...(albums.data ?? [])].sort((a, b) => (b.productionYear ?? 0) - (a.productionYear ?? 0)),
  );
  const shownAlbums = $derived(
    discography.filter((a) => (filter === 'all' ? true : filter === 'singles' ? isSingle(a) : !isSingle(a))),
  );
  const hasSingles = $derived(discography.some(isSingle));
  const hasFullAlbums = $derived(discography.some((a) => !isSingle(a)));
  const popularTracks = $derived(popular.data ?? []);
  const favorite = $derived(app.core.favorites.isFavorite(item));
  const chips = $derived<{ id: Filter; label: string }[]>([
    { id: 'all', label: 'All' },
    ...(hasFullAlbums && hasSingles
      ? [
          { id: 'albums' as const, label: 'Albums' },
          { id: 'singles' as const, label: 'Singles & EPs' },
        ]
      : []),
  ]);
</script>

<section class="screen">
  <DetailHero {item} kind="Artist">
    {#snippet meta()}
      {#if albums.data}<span>{plural(albums.data.length, 'album')}</span>{/if}
    {/snippet}
    {#snippet actions()}
      <IconButton primary size={22} icon="play" label="Play" onclick={() => void act.play(item)} />
      <Button icon="shuffle" onclick={() => void act.play(item, { shuffle: true })}>Shuffle all</Button>
      <Button icon="mix" onclick={() => void act.instantMix(item)}>Instant mix</Button>
      <IconButton
        icon={favorite ? 'heartFill' : 'heart'}
        label={favorite ? 'Remove artist from favorites' : 'Add artist to favorites'}
        active={favorite}
        onclick={() => void act.toggleFavorite(item)}
      />
      <IconButton icon="more" label="More options" onclick={(e) => ui?.openMenu(e, menuFor(item))} />
    {/snippet}
  </DetailHero>

  {#if popularTracks.length > 0}
    <h2>Popular</h2>
    <TrackList
      tracks={showAll ? popularTracks : popularTracks.slice(0, 5)}
      numbered={false}
      showArtist={false}
      showAlbum
      onplay={(i) => void act.playTracks(popularTracks, i)}
    />
    {#if popularTracks.length > 5}
      <button type="button" class="more" onclick={() => (showAll = !showAll)}>
        {showAll ? 'Show less' : 'Show more'}
      </button>
    {/if}
  {/if}

  <div class="disco-head">
    <h2>Discography</h2>
    {#if chips.length > 1}
      <div class="chips" role="group" aria-label="Filter discography">
        {#each chips as c (c.id)}
          <button type="button" class="chip" aria-pressed={filter === c.id} onclick={() => (filter = c.id)}>
            {c.label}
          </button>
        {/each}
      </div>
    {/if}
  </div>
  {#if albums.error}
    <p class="error" role="alert">{albums.error}</p>
  {:else if albums.loading && !albums.data}
    <div class="skeleton-grid" aria-hidden="true">
      {#each { length: 6 } as _, i (i)}<Skeleton height="200px" radius="var(--radius-md)" />{/each}
    </div>
  {:else if shownAlbums.length === 0}
    <p class="muted">No albums.</p>
  {:else}
    <Grid>
      {#each shownAlbums as album (album.id)}
        <Card item={album} onclick={() => router.open(album)} />
      {/each}
    </Grid>
  {/if}

  {#if (similar.data ?? []).length > 0}
    <Shelf title="Similar artists" items={similar.data ?? []} />
  {/if}
</section>

<style>
  h2 {
    font-size: var(--text-lg);
    font-weight: var(--weight-semibold);
    margin: var(--space-6) 0 var(--space-3);
  }
  .disco-head {
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: var(--space-3);
  }
  .disco-head h2 {
    margin-bottom: var(--space-3);
  }
  .chips {
    display: flex;
    gap: var(--space-2);
    margin-bottom: var(--space-3);
  }
  .chip {
    padding: var(--space-1) var(--space-3);
    border: 1px solid var(--border);
    border-radius: var(--radius-full);
    background: transparent;
    color: var(--text-muted);
    font-size: var(--text-sm);
    cursor: pointer;
    transition: background var(--transition), color var(--transition);
  }
  .chip:hover {
    background: var(--hover);
  }
  .chip[aria-pressed='true'] {
    background: var(--text);
    border-color: var(--text);
    color: var(--bg);
  }
  .chip:focus-visible,
  .more:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
  .more {
    margin-top: var(--space-2);
    padding: var(--space-1) var(--space-3);
    border: 0;
    border-radius: var(--radius-full);
    background: transparent;
    color: var(--text-muted);
    font-size: var(--text-sm);
    cursor: pointer;
  }
  .more:hover {
    color: var(--text);
    background: var(--hover);
  }
  .skeleton-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(var(--card-min), 1fr));
    gap: var(--grid-gap);
  }
  .muted {
    color: var(--text-muted);
  }
  .error {
    color: var(--danger);
  }
</style>
