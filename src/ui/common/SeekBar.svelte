<script lang="ts">
  import { getApp } from '../../lib/app.svelte';
  import Slider from './Slider.svelte';
  import { formatTime } from './format';
  import { useActions } from './actions';

  const app = getApp();
  const actions = useActions();
  const player = app.core.player;
  let preview = $state<number | null>(null);
  const shown = $derived(preview ?? player.positionMs);
  const max = $derived(Math.max(player.durationMs, 1));
</script>

<div class="seek">
  <span class="time">{formatTime(shown)}</span>
  <Slider
    label="Seek"
    value={Math.min(player.positionMs, max)}
    min={0}
    {max}
    step={1000}
    disabled={!player.current}
    valueText={`${formatTime(shown)} of ${formatTime(player.durationMs)}`}
    onpreview={(v) => (preview = v)}
    oncommit={(v) => {
      preview = null;
      void actions.guard(() => player.seek(v));
    }}
  />
  <span class="time">{formatTime(player.durationMs)}</span>
</div>

<style>
  .seek {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    width: 100%;
  }
  .time {
    flex: none;
    min-width: 40px;
    text-align: center;
    font-size: var(--text-xs);
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
  }
</style>
