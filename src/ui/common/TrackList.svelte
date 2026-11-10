<script lang="ts">
  import type { BaseItem } from '../../lib/jellyfin/models';
  import TrackRow from './TrackRow.svelte';

  let {
    tracks,
    onplay,
    numbered = true,
    showArtist = true,
    showAlbum = false,
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
    /** Group by disc with a "Disc n" heading when there is more than one disc. */
    discs?: boolean;
    /** The playlist these tracks belong to (enables "Remove from this playlist"). */
    playlist?: BaseItem;
    /** Called after the list content changed on the server (e.g. an entry was removed). */
    onchanged?: () => void;
  } = $props();
</script>

<ul class="list">
  {#each tracks as track, i (`${track.id}:${i}`)}
    <li>
      <TrackRow
        {track}
        number={numbered ? (track.indexNumber ?? i + 1) : null}
        {showArtist}
        {showAlbum}
        {playlist}
        {onchanged}
        onplay={() => onplay(i)}
      />
    </li>
  {/each}
</ul>

<style>
  .list {
    list-style: none;
    margin: 0;
    padding: 0;
  }
</style>
