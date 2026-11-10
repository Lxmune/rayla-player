<script lang="ts">
  // Placeholder: filled in by the detail-screens workstream.
  import type { BaseItem } from '../../lib/jellyfin/models';

  let { tracks, onclose }: { tracks: BaseItem[]; onclose: () => void } = $props();
</script>

<p>{tracks.length} tracks</p>
<button type="button" onclick={onclose}>Close</button>
