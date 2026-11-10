<script lang="ts">
  import { getApp } from '../../lib/app.svelte';
  import IconButton from './IconButton.svelte';
  import { useActions } from './actions';

  let { secondary = false }: { secondary?: boolean } = $props();

  const app = getApp();
  const actions = useActions();
  const player = app.core.player;
  const none = $derived(player.current === null);
  const busy = $derived(player.isPlaying || player.playback === 'buffering');
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
  <span class="main" class:glow={busy && !none}>
    <IconButton
      primary
      icon={busy ? 'pause' : 'play'}
      label={busy ? 'Pause' : 'Play'}
      disabled={none}
      onclick={() => void actions.guard(() => player.togglePlay())}
    />
  </span>
  <IconButton icon="next" label="Next" disabled={none} onclick={() => void actions.guard(() => player.next())} />
  {#if secondary}
    <IconButton icon={player.repeat === 'one' ? 'repeatOne' : 'repeat'} label={repeatLabel}
      active={player.repeat !== 'off'}
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
  .main {
    display: inline-flex;
    border-radius: 50%;
    transition:
      box-shadow var(--duration-slow) var(--ease-out),
      transform var(--duration) var(--ease-out);
  }
  .main.glow {
    box-shadow: 0 0 22px color-mix(in srgb, var(--accent) 55%, transparent);
  }
  .main:active {
    transform: scale(0.94);
  }
  .main :global(.icon-btn.primary) {
    width: 52px;
    height: 52px;
  }
  .main :global(svg) {
    animation: scale-in var(--duration) var(--ease-out);
  }
  @media (prefers-reduced-motion: reduce) {
    .main :global(svg) {
      animation: none;
    }
  }
</style>
