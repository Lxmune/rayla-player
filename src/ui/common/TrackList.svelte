<script lang="ts">
  import type { BaseItem } from '../../lib/jellyfin/models';
  import TrackRow from './TrackRow.svelte';

  let {
    tracks,
    onplay,
    numbered = true,
    showArtist = true,
  }: {
    tracks: BaseItem[];
    /** Called with the index of the clicked track. */
    onplay: (index: number) => void;
    /** Show track numbers (album) or queue positions. */
    numbered?: boolean;
    showArtist?: boolean;
  } = $props();
</script>

<ul class="list">
  {#each tracks as track, i (`${track.id}:${i}`)}
    <li>
      <TrackRow
        {track}
        number={numbered ? (track.indexNumber ?? i + 1) : null}
        {showArtist}
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
