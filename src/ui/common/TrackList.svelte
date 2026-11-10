<script lang="ts">
  import type { BaseItem } from '../../lib/jellyfin/models';
  import Icon from './Icon.svelte';
  import TrackRow from './TrackRow.svelte';

  let {
    tracks,
    onplay,
    numbered = true,
    showArtist = true,
    showAlbum = false,
    showArt,
    header = false,
    discs = false,
    playlist,
    onchanged,
  }: {
    tracks: BaseItem[];
    /** Called with the index of the clicked track. */
    onplay: (index: number) => void;
    /** Show track numbers (album) or queue positions. */
    numbered?: boolean;
    showArtist?: boolean;
    /** Album column (library-wide lists). */
    showAlbum?: boolean;
    /** Small cover thumbnail in every row. Defaults to on for unnumbered lists, whose
        leading cell would otherwise be empty. */
    showArt?: boolean;
    /** Sticky column header (#, Title, Album, duration). */
    header?: boolean;
    /** Group by disc with a "Disc n" heading when there is more than one disc. */
    discs?: boolean;
    /** The playlist these tracks belong to (enables "Remove from this playlist"). */
    playlist?: BaseItem;
    /** Called after the list content changed on the server (e.g. an entry was removed). */
    onchanged?: () => void;
  } = $props();

  const art = $derived(showArt ?? !numbered);

  interface Group {
    disc: number | null;
    entries: { track: BaseItem; i: number }[];
  }

  const groups = $derived.by<Group[]>(() => {
    const all = tracks.map((track, i) => ({ track, i }));
    if (!discs) return [{ disc: null, entries: all }];
    const byDisc = new Map<number, Group>();
    for (const e of all) {
      const disc = e.track.parentIndexNumber ?? 1;
      const g = byDisc.get(disc) ?? { disc, entries: [] };
      g.entries.push(e);
      byDisc.set(disc, g);
    }
    if (byDisc.size <= 1) return [{ disc: null, entries: all }];
    return [...byDisc.values()].sort((a, b) => (a.disc ?? 0) - (b.disc ?? 0));
  });

  // Arrow keys move focus between the rows' main buttons; Enter plays (native button).
  function onkeydown(e: KeyboardEvent) {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const target = e.target as HTMLElement;
    if (!target.classList.contains('main')) return;
    const mains = [...(e.currentTarget as HTMLElement).querySelectorAll<HTMLElement>('.main')];
    const next = mains[mains.indexOf(target) + (e.key === 'ArrowDown' ? 1 : -1)];
    if (next) {
      e.preventDefault();
      next.focus();
    }
  }
</script>

<div class="wrap">
  {#if header}
    <div class="head" role="presentation">
      <span class="h-main"><span class="h-num" class:art={art && !numbered}>{numbered ? '#' : ''}</span><span class="h-title">Title</span></span>
      {#if showAlbum}<span class="h-album">Album</span>{/if}
      <span class="h-extras"></span>
      <span class="h-fav"></span>
      <span class="h-time"><Icon name="clock" size={14} /><span class="sr-only">Duration</span></span>
      <span class="h-more"></span>
    </div>
  {/if}
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <ul class="list" {onkeydown}>
    {#each groups as group (group.disc ?? 'all')}
      {#if group.disc !== null}
        <li class="disc" role="presentation"><h3>Disc {group.disc}</h3></li>
      {/if}
      {#each group.entries as { track, i } (`${track.id}:${i}`)}
        <li>
          <TrackRow
            {track}
            number={numbered ? (track.indexNumber ?? i + 1) : null}
            {showArtist}
            {showAlbum}
            showArt={art}
            {playlist}
            {onchanged}
            onplay={() => onplay(i)}
          />
        </li>
      {/each}
    {/each}
  </ul>
</div>

<style>
  .list > :global(li:not(.disc)) {
    content-visibility: auto;
    contain-intrinsic-size: auto var(--row-height);
  }
  .list {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .head {
    position: sticky;
    top: 0;
    z-index: var(--z-sticky);
    display: flex;
    align-items: center;
    gap: var(--space-2);
    height: 36px;
    padding: 0 var(--space-3);
    margin-bottom: var(--space-1);
    background: var(--bg);
    border-bottom: 1px solid var(--border);
    color: var(--text-faint);
    font-size: var(--text-xs);
    font-weight: var(--weight-semibold);
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }
  .h-main {
    flex: 1;
    min-width: 0;
    display: flex;
    gap: var(--space-3);
  }
  .h-num {
    flex: none;
    width: var(--tl-num, 32px);
    text-align: center;
  }
  /* Unnumbered rows with covers carry their indicator on the 40px cover. */
  .h-num.art {
    width: 40px;
  }
  .h-album {
    flex: 0 0 var(--tl-album, 26%);
  }
  .h-extras {
    flex: none;
    width: 72px;
  }
  .h-fav,
  .h-more {
    flex: none;
    width: 36px;
  }
  .h-time {
    flex: none;
    width: 52px;
    display: flex;
    justify-content: flex-end;
  }
  .disc h3 {
    margin: var(--space-4) var(--space-3) var(--space-1);
    font-size: var(--text-sm);
    font-weight: var(--weight-semibold);
    color: var(--text-muted);
  }
  @media (max-width: 900px) {
    .h-extras {
      display: none;
    }
  }
  @media (max-width: 720px) {
    .h-album {
      display: none;
    }
  }
</style>
