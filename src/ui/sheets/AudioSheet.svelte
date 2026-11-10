<script lang="ts">
  /** Quick sound & quality controls, opened from Now Playing; the full set lives in Settings. */
  import { getApp } from '../../lib/app.svelte';
  import type { CrossfeedLevel, ReplayGainMode } from '../../lib/ipc';
  import { getRouter, getUi } from '../shell/router.svelte';
  import { bitPerfectBlockers } from '../settings/bitperfect';
  import CompressorRows from '../settings/CompressorRows.svelte';
  import { CROSSFEED_OPTIONS, REPLAY_GAIN_OPTIONS } from '../settings/options';
  import StreamingRows from '../settings/StreamingRows.svelte';
  import SelectRow from '../settings/SelectRow.svelte';
  import ToggleRow from '../settings/ToggleRow.svelte';
  import '../settings/settings.css';

  let { onclose }: { onclose: () => void } = $props();

  const settings = getApp().core.settings;
  const ui = getUi();
  const router = getRouter();
  const dsp = $derived(settings.current.dsp);
  const bands = $derived(dsp.eqBands.length);
  const blockers = $derived(bitPerfectBlockers(dsp, getApp().core.player.effectiveMaxBitrate));

  function allSettings() {
    onclose();
    ui.nowPlayingOpen = false;
    router.go('settings');
  }
</script>

<div class="settings audio">
  <h3>Quality</h3>
  <StreamingRows qualityLabel="Streaming quality" qualityHint="Takes effect from the next track" />

  <h3>Effects</h3>
  <SelectRow
    label="ReplayGain"
    value={dsp.replayGain}
    options={REPLAY_GAIN_OPTIONS}
    onchange={(v) => void settings.updateDsp({ replayGain: v as ReplayGainMode })}
  />
  <ToggleRow
    label="Equalizer"
    hint={bands === 0 ? 'No bands yet: set them up in Settings' : `${bands} band${bands === 1 ? '' : 's'}`}
    checked={dsp.eqEnabled}
    onchange={(eqEnabled) => void settings.updateDsp({ eqEnabled })}
  />
  <SelectRow
    label="Crossfeed"
    hint="For headphones"
    value={dsp.crossfeed}
    options={CROSSFEED_OPTIONS}
    onchange={(v) => void settings.updateDsp({ crossfeed: v as CrossfeedLevel })}
  />
  <CompressorRows />

  <p class="note" data-bit-perfect={blockers.length === 0}>
    {blockers.length === 0 ? 'Bit-perfect: nothing alters the signal.' : `Not bit-perfect: ${blockers.join(', ').toLowerCase()}.`}
  </p>
  <button type="button" class="btn all" onclick={allSettings}>All audio settings</button>
</div>

<style>
  .audio {
    display: flex;
    flex-direction: column;
    min-width: min(420px, 100%);
  }
  h3 {
    margin: var(--space-3) 0 0;
    font-size: var(--text-xs);
    font-weight: var(--weight-semibold);
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--text-faint);
  }
  h3:first-child {
    margin-top: 0;
  }
  .note[data-bit-perfect='true'] {
    color: var(--success);
  }
  .all {
    align-self: flex-start;
    margin-top: var(--space-2);
  }
</style>
