<script lang="ts">
  import { artistLine, type BaseItem } from '../../lib/jellyfin/models';
  import Artwork from './Artwork.svelte';
  import { plural } from './format';
  import { useItemMenu } from './item-menu';
  import { getUi } from '../shell/router.svelte';

  let { item, onclick }: { item: BaseItem; onclick: () => void } = $props();

  const ui = getUi();
  const menuFor = useItemMenu();
  const round = $derived(item.type === 'MusicArtist');
  const subtitle = $derived.by(() => {
    switch (item.type) {
      case 'MusicAlbum':
        return [artistLine(item), item.productionYear].filter(Boolean).join(' · ');
      case 'Playlist':
        return item.childCount !== null ? plural(item.childCount, 'track') : '';
      default:
        return '';
    }
  });
</script>

<button type="button" class="card" class:round {onclick} oncontextmenu={(e) => ui?.openMenu(e, menuFor(item))}>
  <Artwork {item} size={180} {round} fill />
  <span class="title">{item.name}</span>
  {#if subtitle}<span class="sub">{subtitle}</span>{/if}
</button>

<style>
  .card {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    min-width: 0;
    padding: var(--space-2);
    border: 0;
    border-radius: var(--radius-md);
    background: transparent;
    text-align: left;
    cursor: pointer;
    transition: background var(--transition);
  }
  .card:hover {
    background: var(--surface);
  }
  .card.round {
    text-align: center;
    align-items: stretch;
  }
  .title {
    margin-top: var(--space-2);
    font-size: var(--text-md);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .sub {
    font-size: var(--text-sm);
    color: var(--text-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
