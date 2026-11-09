<script lang="ts">
  import type { BaseItem } from '../../lib/jellyfin/models';
  import TracksScreen from './TracksScreen.svelte';

  let { item }: { item: BaseItem } = $props();
</script>

<TracksScreen {item} numbered={false} load={async (c) => (await c.playlistItems(item.id)).items} />
