<script lang="ts">
  import { getApp } from '../../lib/app.svelte';
  import { artistLine, type BaseItem } from '../../lib/jellyfin/models';
  import Artwork from './Artwork.svelte';
  import { nameGradient, plural } from './format';
  import { useActions } from './actions';
  import Icon from './Icon.svelte';
  import { useItemMenu } from './item-menu';
  import { getUi } from '../shell/router.svelte';
  import { longPress, reveal } from './touch';

  let { item, onclick }: { item: BaseItem; onclick: () => void } = $props();

  const app = getApp();
  const ui = getUi();
  const actions = useActions();
  const menuFor = useItemMenu();
  const round = $derived(item.type === 'MusicArtist');
  const genre = $derived(item.type === 'MusicGenre');
  const playable = $derived(!genre);
  /** This card's album / artist is what is playing right now. */
  const nowPlaying = $derived.by(() => {
    const cur = app.core.player.current;
    if (!cur) return false;
    if (item.type === 'MusicAlbum') return cur.albumId === item.id;
    if (item.type === 'MusicArtist') return cur.albumArtists.some((a) => a.id === item.id);
    return false;
  });
  const subtitle = $derived.by(() => {
    switch (item.type) {
      case 'MusicAlbum':
        return [artistLine(item), item.productionYear].filter(Boolean).join(' · ');
      case 'Playlist':
        return item.childCount !== null ? plural(item.childCount, 'track') : '';
      case 'MusicArtist':
        return 'Artist';
      default:
        return '';
    }
  });
</script>

<div
  class="card"
  class:round
  class:now-playing={nowPlaying}
  oncontextmenu={(e) => ui?.openMenu(e, menuFor(item))}
  role="presentation"
  use:longPress={{ onlongpress: (at) => ui?.openMenu(at, menuFor(item)) }}
  use:reveal
>
  <div class="cover">
    {#if genre}
      <div class="tile" style:background={nameGradient(item.name)} aria-hidden="true">
        <Icon name="tag" size={36} />
      </div>
    {:else}
      <div class="art" aria-hidden="true"><Artwork {item} size={180} {round} fill /></div>
    {/if}
    {#if playable}
      <button
        type="button"
        class="play"
        aria-label={`Play ${item.name}`}
        onclick={(e) => {
          e.stopPropagation();
          void actions.play(item);
        }}
      >
        <Icon name="play" size={20} />
      </button>
    {/if}
    <button
      type="button"
      class="more"
      aria-label={`More options for ${item.name}`}
      onclick={(e) => {
        e.stopPropagation();
        ui?.openMenu(e.currentTarget, menuFor(item));
      }}
    >
      <Icon name="more" size={18} />
    </button>
  </div>
  <div class="text">
    <button type="button" class="open" {onclick}>
      <span class="title">{item.name}</span>
      {#if subtitle}<span class="sub">{subtitle}</span>{/if}
    </button>
  </div>
</div>

<style>
  .card {
    position: relative;
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    min-width: 0;
    padding: var(--space-3);
    border-radius: var(--radius-lg);
    transition:
      background var(--transition),
      transform var(--duration) var(--ease-out);
  }
  .card {
    -webkit-tap-highlight-color: transparent;
  }
  .card:has(:focus-visible) {
    background: var(--surface);
  }
  @media (hover: hover) {
    .card:hover {
      background: var(--surface);
      transform: translateY(-2px);
    }
  }
  .cover {
    position: relative;
    border-radius: var(--radius-md);
    box-shadow: var(--shadow-1);
    transition: box-shadow var(--transition);
  }
  .round .cover {
    border-radius: 50%;
  }
  @media (hover: hover) {
    .card:hover .cover {
      box-shadow: var(--shadow-2);
    }
  }
  .card:has(:focus-visible) .cover {
    box-shadow: var(--shadow-2);
  }
  .art {
    display: block;
  }
  .tile {
    display: flex;
    align-items: center;
    justify-content: center;
    aspect-ratio: 1 / 1;
    border-radius: var(--radius-md);
    color: rgb(255 255 255 / 0.85);
  }
  /* Stretch the title button over the whole card so a click anywhere opens it. */
  .open::after {
    content: '';
    position: absolute;
    inset: 0;
    border-radius: var(--radius-lg);
  }
  .open {
    display: flex;
    flex-direction: column;
    gap: 2px;
    width: 100%;
    min-width: 0;
    padding: 0;
    border: 0;
    background: transparent;
    color: inherit;
    text-align: left;
    cursor: pointer;
  }
  .open:focus-visible {
    outline: none;
  }
  .open:focus-visible::after {
    outline: 2px solid var(--accent);
    outline-offset: -2px;
  }
  .round .open {
    text-align: center;
  }
  .title {
    font-size: var(--text-md);
    font-weight: var(--weight-semibold);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .now-playing .title {
    color: var(--accent);
  }
  .sub {
    font-size: var(--text-sm);
    color: var(--text-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .play,
  .more {
    position: absolute;
    z-index: 1;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border: 0;
    cursor: pointer;
    opacity: 0;
    transition:
      opacity var(--transition),
      transform var(--duration) var(--ease-out),
      background var(--transition);
  }
  .play {
    right: var(--space-2);
    bottom: var(--space-2);
    width: 44px;
    height: 44px;
    border-radius: 50%;
    background: var(--accent);
    color: var(--accent-contrast);
    box-shadow: 0 6px 18px rgb(0 0 0 / 0.4);
    transform: translateY(6px);
  }
  .more {
    top: var(--space-2);
    right: var(--space-2);
    width: 30px;
    height: 30px;
    border-radius: 50%;
    background: var(--glass);
    color: var(--text);
    backdrop-filter: blur(8px);
  }
  .more:hover {
    background: var(--surface-3);
  }
  .card:has(:focus-visible) .play,
  .card:has(:focus-visible) .more {
    opacity: 1;
    transform: none;
  }
  @media (hover: hover) {
    .card:hover .play,
    .card:hover .more {
      opacity: 1;
      transform: none;
    }
    .play:hover {
      transform: scale(1.07) !important;
      filter: brightness(1.08);
    }
  }
  @media (hover: none) {
    .card {
      -webkit-user-select: none;
      user-select: none;
      -webkit-touch-callout: none;
    }
    .play,
    .more {
      opacity: 1;
      transform: none;
    }
    /* Quick in, slower out: the whole card presses toward the finger. */
    .card:active {
      transform: scale(0.97);
      background: var(--surface);
      transition:
        background 100ms linear,
        transform 100ms var(--ease-out);
    }
    .play:active {
      transform: scale(0.92);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .card,
    .play {
      transition: none;
    }
    .card:hover,
    .card:active,
    .play:active {
      transform: none;
    }
  }
  :global(:root[data-motion='reduced']) .card,
  :global(:root[data-motion='reduced']) .play {
    transition: none;
  }
  :global(:root[data-motion='reduced']) .card:hover,
  :global(:root[data-motion='reduced']) .card:active,
  :global(:root[data-motion='reduced']) .play:active {
    transform: none;
  }
</style>
