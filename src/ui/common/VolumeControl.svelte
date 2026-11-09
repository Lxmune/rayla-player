<script lang="ts">
  import { getApp } from '../../lib/app.svelte';
  import IconButton from './IconButton.svelte';
  import Slider from './Slider.svelte';
  import { useActions } from './actions';

  const app = getApp();
  const actions = useActions();
  const volume = $derived(app.core.settings.current.dsp.volume);
  let lastNonZero = 1;
  $effect(() => {
    if (volume > 0) lastNonZero = volume;
  });
</script>

<div class="volume">
  <IconButton
    icon={volume <= 0 ? 'mute' : 'volume'}
    label={volume <= 0 ? 'Unmute' : 'Mute'}
    onclick={() => void actions.setVolume(volume <= 0 ? lastNonZero : 0)}
  />
  <div class="slider">
    <Slider
      label="Volume"
      value={volume}
      valueText={`${Math.round(volume * 100)}%`}
      oncommit={(v) => void actions.setVolume(v)}
      onpreview={(v) => void actions.setVolume(v)}
    />
  </div>
</div>

<style>
  .volume {
    display: flex;
    align-items: center;
    gap: var(--space-1);
  }
  .slider {
    width: 100px;
  }
</style>
