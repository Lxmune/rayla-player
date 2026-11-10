<script lang="ts">
  import { getApp } from '../../lib/app.svelte';
  import IconButton from '../common/IconButton.svelte';
  import { formatTime } from '../common/format';
  import { getUi, type MenuEntry } from '../shell/router.svelte';

  const sleep = getApp().core.sleep;
  const ui = getUi();

  const label = $derived(
    sleep.mode === 'timer'
      ? `Sleep timer: ${formatTime(sleep.remainingMs)} left`
      : sleep.mode === 'track'
        ? 'Sleep timer: end of track'
        : 'Sleep timer',
  );

  function open(e: MouseEvent) {
    const at = e.currentTarget instanceof HTMLElement ? e.currentTarget : e;
    const entries: MenuEntry[] = [15, 30, 45, 60, 90].map((m) => ({
      label: `${m} minutes`,
      onselect: () => {
        sleep.start(m);
        ui.toast(`Playback will pause in ${m} minutes`);
      },
    }));
    entries.push(
      'separator',
      {
        label: 'End of track',
        onselect: () => {
          sleep.endOfTrack();
          ui.toast('Playback will pause after this track');
        },
      },
      { label: 'Cancel timer', danger: true, disabled: sleep.mode === 'off', onselect: () => sleep.cancel() },
    );
    ui.openMenu(at, entries);
  }
</script>

<span class="sleep">
  <IconButton icon="moon" {label} active={sleep.mode !== 'off'} onclick={open} />
  {#if sleep.mode === 'timer'}
    <span class="left" aria-hidden="true">{formatTime(sleep.remainingMs)}</span>
  {/if}
</span>

<style>
  .sleep {
    display: inline-flex;
    align-items: center;
    gap: var(--space-1);
  }
  .left {
    font-size: var(--text-xs);
    color: var(--accent);
    font-variant-numeric: tabular-nums;
  }
</style>
