<script lang="ts">
  import { getApp } from '../../lib/app.svelte';
  import { artistLine, itemDurationMs, type BaseItem } from '../../lib/jellyfin/models';
  import Icon from './Icon.svelte';
  import IconButton from './IconButton.svelte';
  import { formatTime } from './format';
  import { useActions } from './actions';

  let {
    track,
    number,
    showArtist = true,
    onplay,
  }: {
    track: BaseItem;
    /** Shown instead of the play glyph (track number / position). */
    number?: number | null;
    showArtist?: boolean;
    onplay: () => void;
  } = $props();

  const app = getApp();
  const actions = useActions();
  const player = app.core.player;
  const isCurrent = $derived(player.current?.id === track.id);
  const favorite = $derived(app.core.favorites.isFavorite(track));
  const downloaded = $derived(app.core.downloads.isDownloaded(track.id));
</script>

<div class="row" class:current={isCurrent}>
  <button type="button" class="main" onclick={onplay} aria-label={`Play ${track.name}`}>
    <span class="num">
      {#if isCurrent && player.isPlaying}
        <Icon name="play" size={14} />
      {:else}
        {number ?? ''}
      {/if}
    </span>
    <span class="text">
      <span class="title">{track.name}</span>
      {#if showArtist}<span class="artist">{artistLine(track)}</span>{/if}
    </span>
  </button>
  <span class="extras">
    <IconButton icon="plus" label={`Add ${track.name} to queue`} size={16} onclick={() => void actions.addToQueue([track])} />
    {#if downloaded}
      <span class="dl" title="Downloaded" role="img" aria-label="Downloaded"><Icon name="check" size={16} /></span>
    {:else}
      <IconButton icon="download" label={`Download ${track.name}`} size={16} onclick={() => actions.download([track])} />
    {/if}
  </span>
  <IconButton
    icon={favorite ? 'heartFill' : 'heart'}
    label={favorite ? `Remove ${track.name} from favorites` : `Add ${track.name} to favorites`}
    size={16}
    active={favorite}
    onclick={() => void actions.toggleFavorite(track)}
  />
  <span class="time">{formatTime(itemDurationMs(track))}</span>
</div>

<style>
  .row {
    display: flex;
    align-items: center;
    gap: var(--space-1);
    padding: 0 var(--space-2);
    border-radius: var(--radius-sm);
  }
  .row:hover,
  .row:focus-within {
    background: var(--surface);
  }
  .main {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-2) 0;
    border: 0;
    background: transparent;
    text-align: left;
    cursor: pointer;
  }
  .num {
    flex: none;
    width: 28px;
    text-align: right;
    color: var(--text-faint);
    font-variant-numeric: tabular-nums;
    font-size: var(--text-sm);
  }
  .text {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .title,
  .artist {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .artist {
    font-size: var(--text-sm);
    color: var(--text-muted);
  }
  .current .title,
  .current .num {
    color: var(--accent);
  }
  .extras {
    display: inline-flex;
    opacity: 0;
    transition: opacity var(--transition);
  }
  .row:hover .extras,
  .row:focus-within .extras {
    opacity: 1;
  }
  .dl {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 36px;
    color: var(--success);
  }
  .time {
    flex: none;
    width: 48px;
    text-align: right;
    color: var(--text-faint);
    font-variant-numeric: tabular-nums;
    font-size: var(--text-sm);
  }
</style>
