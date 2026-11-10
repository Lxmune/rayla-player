<script lang="ts">
  // Placeholder: filled in by the browse workstream.
  import type { BaseItem } from '../../lib/jellyfin/models';
  import ScreenHeader from '../common/ScreenHeader.svelte';

  let { item }: { item: BaseItem } = $props();
</script>

<section class="screen"><ScreenHeader title={item.name} /></section>
