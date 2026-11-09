<script lang="ts">
  import { getApp } from '../../lib/app.svelte';
  import IconButton from './IconButton.svelte';
  import { useActions } from './actions';

  let { secondary = false }: { secondary?: boolean } = $props();

  const app = getApp();
  const actions = useActions();
  const player = app.core.player;
  const none = $derived(player.current === null);
  const repeatLabel = $derived(
    player.repeat === 'off' ? 'Repeat: off' : player.repeat === 'all' ? 'Repeat: all' : 'Repeat: one',
  );
</script>

<div class="transport">
  {#if secondary}
    <IconButton icon="shuffle" label="Shuffle" pressed={player.shuffle} active={player.shuffle}
      onclick={() => void actions.guard(() => player.toggleShuffle())} />
  {/if}
  <IconButton icon="prev" label="Previous" disabled={none} onclick={() => void actions.guard(() => player.previous())} />
  <IconButton
    primary
    icon={player.isPlaying || player.playback === 'buffering' ? 'pause' : 'play'}
    label={player.isPlaying || player.playback === 'buffering' ? 'Pause' : 'Play'}
    disabled={none}
    onclick={() => void actions.guard(() => player.togglePlay())}
  />
  <IconButton icon="next" label="Next" disabled={none} onclick={() => void actions.guard(() => player.next())} />
  {#if secondary}
    <IconButton icon="repeat" label={repeatLabel} active={player.repeat !== 'off'}
      onclick={() => void actions.guard(() => player.cycleRepeat())} />
  {/if}
</div>

<style>
  .transport {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: var(--space-2);
  }
</style>
