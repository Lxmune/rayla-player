<script lang="ts">
  import { getApp } from '../../lib/app.svelte';
  import type { ReplayGainMode } from '../../lib/ipc';
  import RangeRow from './RangeRow.svelte';
  import Section from './Section.svelte';
  import SelectRow from './SelectRow.svelte';
  import ToggleRow from './ToggleRow.svelte';
  import { REPLAY_GAIN_OPTIONS } from './options';

  const settings = getApp().core.settings;
  const dsp = $derived(settings.current.dsp);
  const db = (v: number) => `${v > 0 ? '+' : ''}${v.toFixed(1)} dB`;
</script>

<Section title="Volume & gain" id="gain">
  <RangeRow
    label="Volume"
    value={dsp.volume * 100}
    min={0}
    max={100}
    step={1}
    format={(v) => `${Math.round(v)}%`}
    oncommit={(v) => void settings.updateDsp({ volume: v / 100 })}
  />
  <SelectRow
    label="ReplayGain"
    value={dsp.replayGain}
    options={REPLAY_GAIN_OPTIONS}
    onchange={(v) => void settings.updateDsp({ replayGain: v as ReplayGainMode })}
  />
  <RangeRow
    label="Preamp"
    value={dsp.preampDb}
    min={-12}
    max={12}
    step={0.5}
    format={db}
    oncommit={(v) => void settings.updateDsp({ preampDb: v })}
  />
  <ToggleRow
    label="Clip guard"
    hint="Limit peaks instead of clipping when gain is applied"
    checked={dsp.clipGuard}
    onchange={(v) => void settings.updateDsp({ clipGuard: v })}
  />
</Section>
