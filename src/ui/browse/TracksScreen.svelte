<script lang="ts">
  import { untrack } from 'svelte';
  import { getApp } from '../../lib/app.svelte';
  import type { JellyfinClient } from '../../lib/jellyfin/client';
  import { artistLine, audioStream, itemDurationMs, type BaseItem } from '../../lib/jellyfin/models';
  import Button from '../common/Button.svelte';
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

  /** Album or playlist: hero with actions plus its track list. */
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
  const router = getRouter();
  const ui = getUi();
  const act = useActions();
  const menuFor = useItemMenu();
  const tracksRes = new Resource<BaseItem[]>();
  const moreRes = new Resource<BaseItem[]>();
  const isAlbum = $derived(item.type === 'MusicAlbum');

  function reload() {
    const client = app.core.sessions.client;
    if (client) void tracksRes.load(() => load(client), `${app.core.sessions.activeId}:tracks:${item.id}`);
  }

  $effect(() => {
    void item;
    untrack(reload);
  });

  const artistId = $derived(item.albumArtists[0]?.id ?? null);
  $effect(() => {
    const client = app.core.sessions.client;
    const id = artistId;
    const self = item.id;
    if (!client || !id || !isAlbum) return;
    untrack(
      () =>
        void moreRes.load(
          async () => (await client.artistAlbums(id)).items.filter((a) => a.id !== self),
          `${app.core.sessions.activeId}:more:${self}`,
        ),
    );
  });

  const tracks = $derived(tracksRes.data ?? []);
  const totalMs = $derived(tracks.reduce((sum, t) => sum + itemDurationMs(t), 0));
  const allDownloaded = $derived(
    tracks.length > 0 && tracks.every((t) => app.core.downloads.isDownloaded(t.id)),
  );
  const keptOffline = $derived(app.core.kept.isKept(item.id));
  const favorite = $derived(app.core.favorites.isFavorite(item));

  const kind = $derived.by(() => {
    if (!isAlbum) return 'Playlist';
    const n = tracks.length || item.childCount || 0;
    if (n > 0 && n <= 3) return 'Single';
    if (n > 3 && n <= 6) return 'EP';
    return 'Album';
  });

  /** "1 hr 12 min" / "42 min". */
  function longDuration(ms: number): string {
    const mins = Math.max(1, Math.round(ms / 60000));
    const h = Math.floor(mins / 60);
    return h > 0 ? `${h} hr ${mins % 60} min` : `${mins} min`;
  }

  /** "FLAC · 24/96" from the first track's audio stream. */
  const format = $derived.by(() => {
    const first = tracks[0];
    const s = first ? audioStream(first) : null;
    if (!s) return null;
    const parts: string[] = [];
    const codec = s.codec ?? first?.mediaSources[0]?.container;
    if (codec) parts.push(codec.toUpperCase());
    if (s.sampleRate) {
      const khz = s.sampleRate / 1000;
      const rate = Number.isInteger(khz) ? String(khz) : khz.toFixed(1);
      parts.push(s.bitDepth ? `${s.bitDepth}/${rate}` : `${rate} kHz`);
    }
    return parts.length > 0 ? parts.join(' · ') : null;
  });

  async function openArtist(id: string) {
    const artist = await act.guard(() => app.core.sessions.client?.item(id) ?? null);
    if (artist) router.open(artist);
  }
</script>

<section class="screen">
  <DetailHero {item} {kind}>
    {#snippet meta()}
      {#if isAlbum}
        {#if item.albumArtists.length > 0}
          <span class="artists">
            {#each item.albumArtists as a, i (a.id)}
              {#if i > 0}<span class="sep">,</span>{/if}
              <button type="button" class="link" onclick={() => void openArtist(a.id)}>{a.name}</button>
            {/each}
          </span>
        {:else if artistLine(item)}
          <span>{artistLine(item)}</span>
        {/if}
        {#if item.productionYear}<span class="dot">·</span><span>{item.productionYear}</span>{/if}
      {/if}
      {#if tracks.length > 0}
        {#if isAlbum}<span class="dot">·</span>{/if}
        <span>{plural(tracks.length, 'track')}</span>
      {/if}
      {#if totalMs > 0}<span class="dot">·</span><span>{longDuration(totalMs)}</span>{/if}
      {#if format}<span class="badge" title="Audio format of the first track">{format}</span>{/if}
    {/snippet}
    {#snippet actions()}
      <IconButton
        primary
        size={22}
        icon="play"
        label="Play"
        disabled={tracks.length === 0}
        onclick={() => void act.playTracks(tracks, 0, false)}
      />
      <Button icon="shuffle" disabled={tracks.length === 0} onclick={() => void act.playTracks(tracks, 0, true)}>
        Shuffle
      </Button>
      {#if isAlbum}
        <IconButton
          icon={favorite ? 'heartFill' : 'heart'}
          label={favorite ? 'Remove album from favorites' : 'Add album to favorites'}
          active={favorite}
          onclick={() => void act.toggleFavorite(item)}
        />
      {/if}
      {#if allDownloaded}
        <Button icon="check" onclick={() => void act.removeDownloads(tracks)}>Remove downloads</Button>
      {:else}
        <Button icon="download" disabled={tracks.length === 0} onclick={() => act.download(tracks)}>Download</Button>
      {/if}
      <Button
        icon={keptOffline ? 'check' : undefined}
        disabled={!app.core.sessions.client}
        onclick={() => void app.core.kept.toggle(item)}
      >
        {keptOffline ? 'Kept offline' : 'Keep offline'}
      </Button>
      <Button icon="mix" onclick={() => void act.instantMix(item)}>Instant mix</Button>
      <IconButton icon="more" label="More options" onclick={(e) => ui?.openMenu(e, menuFor(item))} />
    {/snippet}
  </DetailHero>

  {#if tracksRes.error}
    <p class="error" role="alert">{tracksRes.error}</p>
  {:else if tracksRes.loading && tracks.length === 0}
    <div class="skeletons" aria-hidden="true">
      {#each { length: 8 } as _, i (i)}<Skeleton height="var(--row-height)" radius="var(--radius-sm)" />{/each}
    </div>
  {:else if tracks.length === 0}
    <p class="muted">No tracks.</p>
  {:else}
    <TrackList
      {tracks}
      {numbered}
      discs={isAlbum}
      showArtist={!isAlbum}
      showAlbum={!isAlbum}
      playlist={isAlbum ? undefined : item}
      onchanged={reload}
      onplay={(i) => void act.playTracks(tracks, i)}
    />
  {/if}

  {#if isAlbum && (moreRes.data ?? []).length > 0}
    <Shelf title="More by {item.albumArtists[0]?.name ?? 'this artist'}" items={moreRes.data ?? []} />
  {/if}
</section>

<style>
  .link {
    border: 0;
    padding: 0;
    background: none;
    color: var(--text);
    font: inherit;
    font-weight: var(--weight-semibold);
    cursor: pointer;
  }
  .link:hover {
    text-decoration: underline;
  }
  .link:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
    border-radius: 2px;
  }
  .sep {
    margin-right: var(--space-1);
  }
  .dot {
    color: var(--text-faint);
  }
  .badge {
    padding: 2px var(--space-2);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-full);
    font-size: var(--text-xs);
    letter-spacing: 0.04em;
    color: var(--text);
  }
  .skeletons {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }
  .muted {
    color: var(--text-muted);
  }
  .error {
    color: var(--danger);
  }
</style>
