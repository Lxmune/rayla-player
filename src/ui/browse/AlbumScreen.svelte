<script lang="ts">
  import type { BaseItem } from '../../lib/jellyfin/models';
  import TracksScreen from './TracksScreen.svelte';

  let { item }: { item: BaseItem } = $props();
</script>

<TracksScreen {item} load={(c) => c.albumTracks(item.id)} />
