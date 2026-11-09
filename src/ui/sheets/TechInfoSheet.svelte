<script lang="ts">
  import type { BaseItem } from '../../lib/jellyfin/models';
  let { item }: { item: BaseItem } = $props();
</script>

<!-- Placeholder; implemented by the settings/sheets UI agent. -->
<div>{item.name}</div>
