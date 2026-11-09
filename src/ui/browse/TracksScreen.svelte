<script lang="ts">
  import { untrack } from 'svelte';
  import { getApp } from '../../lib/app.svelte';
  import type { JellyfinClient } from '../../lib/jellyfin/client';
  import { artistLine, itemDurationMs, type BaseItem } from '../../lib/jellyfin/models';
  import Artwork from '../common/Artwork.svelte';
  import Button from '../common/Button.svelte';
  import IconButton from '../common/IconButton.svelte';
  import TrackList from '../common/TrackList.svelte';
  import { formatTime, plural } from '../common/format';
  import { useActions } from '../common/actions';
  import { Resource } from '../common/resource.svelte';

  /** Album or playlist: header with actions plus its track list. */
  let {
    item,
    load,
    numbered = true,
  }: {
    item: BaseItem;
    load: (client: JellyfinClient) => Promise<BaseItem[]>;
    numbered?: boolean;
  } = $props();

  const app = getApp();
  const actions = useActions();
  const tracksRes = new Resource<BaseItem[]>();

  $effect(() => {
    const client = app.core.sessions.client;
    const it = item;
    if (!client) return;
    untrack(() => void tracksRes.load(() => load(client)));
    void it;
  });

  const tracks = $derived(tracksRes.data ?? []);
  const totalMs = $derived(tracks.reduce((sum, t) => sum + itemDurationMs(t), 0));
  const allDownloaded = $derived(
    tracks.length > 0 && tracks.every((t) => app.core.downloads.isDownloaded(t.id)),
  );
  const favorite = $derived(app.core.favorites.isFavorite(item));
  const subtitle = $derived(
    [
      item.type === 'MusicAlbum' ? artistLine(item) : null,
      item.productionYear,
      tracks.length > 0 ? plural(tracks.length, 'track') : null,
      totalMs > 0 ? formatTime(totalMs) : null,
    ]
      .filter(Boolean)
      .join(' · '),
  );
</script>

<section class="screen">
  <div class="hero">
    <Artwork {item} size={200} />
    <div class="info">
      <h1>{item.name}</h1>
      <p class="sub">{subtitle}</p>
      <div class="actions">
        <Button primary icon="play" disabled={tracks.length === 0} onclick={() => void actions.playTracks(tracks, 0, false)}>
          Play
        </Button>
        <Button icon="shuffle" disabled={tracks.length === 0} onclick={() => void actions.playTracks(tracks, 0, true)}>
          Shuffle
        </Button>
        <Button icon="mix" onclick={() => void actions.instantMix(item)}>Instant mix</Button>
        {#if allDownloaded}
          <Button icon="check" onclick={() => void actions.removeDownloads(tracks)}>Remove downloads</Button>
        {:else}
          <Button icon="download" disabled={tracks.length === 0} onclick={() => actions.download(tracks)}>Download</Button>
        {/if}
        {#if item.type === 'MusicAlbum'}
          <IconButton
            icon={favorite ? 'heartFill' : 'heart'}
            label={favorite ? 'Remove album from favorites' : 'Add album to favorites'}
            active={favorite}
            onclick={() => void actions.toggleFavorite(item)}
          />
        {/if}
      </div>
    </div>
  </div>

  {#if tracksRes.error}
    <p class="error" role="alert">{tracksRes.error}</p>
  {:else if tracksRes.loading && tracks.length === 0}
    <p class="muted">Loading…</p>
  {:else if tracks.length === 0}
    <p class="muted">No tracks.</p>
  {:else}
    <TrackList {tracks} {numbered} showArtist={item.type !== 'MusicAlbum'} onplay={(i) => void actions.playTracks(tracks, i)} />
  {/if}
</section>

<style>
  .hero {
    display: flex;
    gap: var(--space-5);
    align-items: flex-end;
    flex-wrap: wrap;
    margin-bottom: var(--space-5);
  }
  .info {
    flex: 1;
    min-width: 240px;
  }
  h1 {
    margin: 0;
    font-size: var(--text-xl);
  }
  .sub {
    margin: var(--space-1) 0 var(--space-4);
    color: var(--text-muted);
    font-size: var(--text-sm);
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    align-items: center;
  }
  .muted {
    color: var(--text-muted);
  }
  .error {
    color: var(--danger);
  }
</style>
