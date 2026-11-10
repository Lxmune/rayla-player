<script lang="ts">
  import { getApp } from '../../lib/app.svelte';
  import IconButton from './IconButton.svelte';
  import Slider from './Slider.svelte';
  import { useActions } from './actions';

  const app = getApp();
  const actions = useActions();
  const volume = $derived(app.core.settings.current.dsp.volume);
  const icon = $derived(volume <= 0 ? 'mute' : volume < 0.5 ? 'volumeLow' : 'volume');
  let lastNonZero = 1;
  $effect(() => {
    if (volume > 0) lastNonZero = volume;
  });

  /** Wheel over the icon changes the volume too. */
  function wheel(node: HTMLElement) {
    const onwheel = (e: WheelEvent) => {
      if (e.deltaY === 0) return;
      e.preventDefault();
      const next = Math.min(1, Math.max(0, Math.round((volume + (e.deltaY < 0 ? 0.05 : -0.05)) * 100) / 100));
      void actions.setVolume(next);
    };
    node.addEventListener('wheel', onwheel, { passive: false });
    return { destroy: () => node.removeEventListener('wheel', onwheel) };
  }
</script>

<div class="volume" use:wheel>
  <IconButton
    {icon}
    label={volume <= 0 ? 'Unmute' : 'Mute'}
    onclick={() => void actions.setVolume(volume <= 0 ? lastNonZero : 0)}
  />
  <div class="slider" title="{Math.round(volume * 100)}%">
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
