<script lang="ts">
  import { getApp } from '../../lib/app.svelte';
  import { artistLine, itemDurationMs, type BaseItem } from '../../lib/jellyfin/models';
  import Artwork from './Artwork.svelte';
  import Icon from './Icon.svelte';
  import IconButton from './IconButton.svelte';
  import { formatTime } from './format';
  import { useActions } from './actions';
  import { useItemMenu } from './item-menu';
  import { getRouter, getUi } from '../shell/router.svelte';
  import { longPress, swipeActions } from './touch';

  let {
    track,
    number,
    showArtist = true,
    showAlbum = false,
    showArt = false,
    playlist,
    onchanged,
    onplay,
  }: {
    track: BaseItem;
    /** Shown in the leading cell until hover turns it into a play glyph. */
    number?: number | null;
    showArtist?: boolean;
    showAlbum?: boolean;
    /** Small cover thumbnail before the title (library-wide lists). */
    showArt?: boolean;
    /** The playlist this row is shown in (menu offers removal). */
    playlist?: BaseItem;
    onchanged?: () => void;
    onplay: () => void;
  } = $props();

  const app = getApp();
  const actions = useActions();
  const player = app.core.player;
  const isCurrent = $derived(player.current?.id === track.id);
  const playing = $derived(isCurrent && player.isPlaying);
  const favorite = $derived(app.core.favorites.isFavorite(track));
  const downloaded = $derived(app.core.downloads.isDownloaded(track.id));
  const ui = getUi();
  const router = getRouter();
  const menuFor = useItemMenu();
  const menu = () => menuFor(track, { playlist, onremoved: onchanged });

  function oncontextmenu(e: MouseEvent) {
    ui?.openMenu(e, menu());
  }
  // Double-click anywhere that is not a control plays too (e.g. on the album text gap).
  function ondblclick(e: MouseEvent) {
    if (!(e.target as HTMLElement).closest('button')) onplay();
  }
  async function openAlbum() {
    const album = await actions.albumOf(track);
    if (album) router?.open(album);
  }
</script>

<div
  class="swipe"
  use:longPress={{ onlongpress: (at) => ui?.openMenu(at, menu()) }}
  use:swipeActions={{
    onright: () => void actions.playNext([track]),
    onleft: () => void actions.addToQueue([track]),
  }}
>
  <div class="reveal right" aria-hidden="true"><Icon name="playNext" size={22} /><span>Play next</span></div>
  <div class="reveal left" aria-hidden="true"><span>Add to queue</span><Icon name="queue" size={22} /></div>
<div
  class="row"
  class:current={isCurrent}
  role="group"
  aria-label={track.name}
  aria-current={isCurrent ? 'true' : undefined}
  {oncontextmenu}
  {ondblclick}
>
  <button type="button" class="main" onclick={onplay} aria-label={`Play ${track.name}`}>
    {#snippet indicator(onArt: boolean)}
      <span class="num" class:on-art={onArt} class:active={playing}>
        {#if playing}
          <span class="eq" aria-hidden="true"><i></i><i></i><i></i></span>
        {:else}
          <span class="n">{number ?? ''}</span>
        {/if}
        <span class="p"><Icon name="play" size={14} /></span>
      </span>
    {/snippet}
    {#if showArt && number == null}
      <!-- No number to show: the play / now-playing glyph sits on the cover instead of an empty cell. -->
      <span class="thumb" aria-hidden="true"><Artwork item={track} size={40} />{@render indicator(true)}</span>
    {:else}
      {@render indicator(false)}
      {#if showArt}<span class="thumb" aria-hidden="true"><Artwork item={track} size={40} /></span>{/if}
    {/if}
    <span class="text">
      <span class="title">{track.name}</span>
      {#if showArtist}<span class="artist">{artistLine(track)}</span>{/if}
    </span>
  </button>
  {#if showAlbum}
    <span class="album">
      {#if track.albumId && track.album}
        <button type="button" class="album-link" onclick={() => void openAlbum()}>{track.album}</button>
      {/if}
    </span>
  {/if}
  <span class="extras">
    <IconButton icon="plus" label={`Add ${track.name} to queue`} size={16} onclick={() => void actions.addToQueue([track])} />
    {#if downloaded}
      <span class="dl" title="Downloaded" role="img" aria-label="Downloaded"><Icon name="check" size={16} /></span>
    {:else}
      <IconButton icon="download" label={`Download ${track.name}`} size={16} onclick={() => actions.download([track])} />
    {/if}
  </span>
  <span class="fav" class:on={favorite}>
    <IconButton
      icon={favorite ? 'heartFill' : 'heart'}
      label={favorite ? `Remove ${track.name} from favorites` : `Add ${track.name} to favorites`}
      size={16}
      active={favorite}
      onclick={() => void actions.toggleFavorite(track)}
    />
  </span>
  <span class="time">{formatTime(itemDurationMs(track))}</span>
  <span class="more">
    <IconButton
      icon="more"
      label={`More options for ${track.name}`}
      size={18}
      onclick={(e) => ui?.openMenu(e.currentTarget as HTMLElement, menu())}
    />
  </span>
</div>
</div>

<style>
  .swipe {
    position: relative;
    touch-action: pan-y;
    -webkit-tap-highlight-color: transparent;
    border-radius: var(--radius-sm);
  }
  .reveal {
    position: absolute;
    inset: 0;
    display: none;
    align-items: center;
    gap: var(--space-2);
    padding: 0 var(--space-5);
    border-radius: var(--radius-sm);
    background: var(--accent-soft);
    color: var(--accent);
    font-size: var(--text-sm);
    font-weight: var(--weight-semibold);
    transition: background 120ms linear, color 120ms linear;
  }
  .reveal.left {
    justify-content: flex-end;
  }
  .swipe:global([data-swipe='right']) .reveal.right,
  .swipe:global([data-swipe='left']) .reveal.left {
    display: flex;
  }
  .swipe:global([data-armed]) .reveal {
    background: var(--accent);
    color: var(--accent-contrast);
  }
  .swipe:global([data-swiping]) .row {
    background: var(--bg);
    transform: translateX(var(--swipe-x, 0px));
    transition: none;
  }
  .swipe:global([data-swiping][data-settling]) .row {
    transition: transform 320ms var(--ease-spring);
  }
  .row {
    position: relative;
    display: flex;
    align-items: center;
    gap: var(--space-2);
    min-height: var(--row-height);
    padding: 0 var(--space-3);
    border-radius: var(--radius-sm);
    transition: background var(--duration-fast);
  }
  .row:has(:focus-visible) {
    background: var(--hover);
  }
  @media (hover: hover) {
    .row:hover {
      background: var(--hover);
    }
  }
  .main {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: var(--space-3);
    align-self: stretch;
    padding: 0;
    border: 0;
    background: transparent;
    color: inherit;
    text-align: left;
    cursor: pointer;
  }
  .num {
    position: relative;
    flex: none;
    display: flex;
    align-items: center;
    justify-content: center;
    width: var(--tl-num, 32px);
    color: var(--text-faint);
    font-variant-numeric: tabular-nums;
    font-size: var(--text-sm);
  }
  .p {
    position: absolute;
    display: none;
    color: var(--text);
  }
  .main:focus-visible .p {
    display: inline-flex;
  }
  .main:focus-visible .n,
  .main:focus-visible .eq {
    visibility: hidden;
  }
  @media (hover: hover) {
    .row:hover .p {
      display: inline-flex;
    }
    .row:hover .n,
    .row:hover .eq {
      visibility: hidden;
    }
  }
  .eq {
    display: inline-flex;
    align-items: flex-end;
    gap: 2px;
    height: 14px;
  }
  .eq i {
    width: 3px;
    height: 100%;
    border-radius: 1px;
    background: var(--accent);
    transform-origin: bottom;
    animation: eq-bar 900ms var(--ease-in-out) infinite;
  }
  .eq i:nth-child(2) {
    animation-delay: -300ms;
    animation-duration: 750ms;
  }
  .eq i:nth-child(3) {
    animation-delay: -600ms;
    animation-duration: 1050ms;
  }
  .thumb {
    position: relative;
    flex: none;
    display: inline-flex;
  }
  .num.on-art {
    position: absolute;
    inset: 0;
    width: auto;
    border-radius: var(--radius-md);
    color: var(--text);
    transition: background var(--duration-fast);
  }
  .num.on-art.active,
  .main:focus-visible .num.on-art {
    background: rgb(0 0 0 / 0.5);
  }
  @media (hover: hover) {
    .row:hover .num.on-art {
      background: rgb(0 0 0 / 0.5);
    }
  }
  .text {
    display: flex;
    flex-direction: column;
    min-width: 0;
    gap: 1px;
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
  .current .n {
    color: var(--accent);
  }
  .album {
    flex: 0 0 var(--tl-album, 26%);
    min-width: 0;
  }
  .album-link {
    max-width: 100%;
    padding: 0;
    border: 0;
    background: transparent;
    color: var(--text-muted);
    font-size: var(--text-sm);
    cursor: pointer;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .album-link:hover {
    color: var(--text);
    text-decoration: underline;
  }
  .extras {
    display: inline-flex;
    flex: none;
    width: 72px;
    opacity: 0;
    transition: opacity var(--transition);
  }
  .row:has(:focus-visible) .extras {
    opacity: 1;
  }
  @media (hover: hover) {
    .row:hover .extras {
      opacity: 1;
    }
  }
  .dl {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 36px;
    color: var(--success);
  }
  .fav {
    flex: none;
    opacity: 0;
    transition: opacity var(--transition);
  }
  .fav.on,
  .row:has(:focus-visible) .fav {
    opacity: 1;
  }
  @media (hover: hover) {
    .row:hover .fav {
      opacity: 1;
    }
  }
  .time {
    flex: none;
    width: 52px;
    text-align: right;
    color: var(--text-faint);
    font-variant-numeric: tabular-nums;
    font-size: var(--text-sm);
  }
  .more {
    flex: none;
    opacity: 0;
    transition: opacity var(--transition);
  }
  .row:has(:focus-visible) .more {
    opacity: 1;
  }
  @media (hover: hover) {
    .row:hover .more {
      opacity: 1;
    }
  }
  @media (hover: none) {
    .more,
    .fav {
      opacity: 1;
    }
    .row {
      -webkit-user-select: none;
      user-select: none;
      -webkit-touch-callout: none;
    }
    .row:active {
      background: var(--active);
      transition: background 100ms linear;
    }
  }
  @media (max-width: 900px) {
    .extras {
      display: none;
    }
  }
  @media (max-width: 720px) {
    .album {
      display: none;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .eq i {
      animation: none;
      transform: scaleY(0.7);
    }
    .swipe:global([data-swiping][data-settling]) .row,
    .reveal {
      transition: none;
    }
  }
  :global(:root[data-motion='reduced']) .swipe:global([data-swiping][data-settling]) .row,
  :global(:root[data-motion='reduced']) .reveal {
    transition: none;
  }
</style>
