<script lang="ts">
  import { getApp } from '../../lib/app.svelte';
  import type { DsdMode } from '../../lib/ipc';
  import Section from './Section.svelte';
  import SelectRow from './SelectRow.svelte';
  import { BITRATE_OPTIONS, bitrateValue, parseBitrate } from './options';

  const settings = getApp().core.settings;
</script>

<Section title="Streaming" id="streaming">
  <SelectRow
    label="Bitrate cap"
    hint="Lower caps make the server transcode; Original is bit-exact"
    value={bitrateValue(settings.current.maxBitrate)}
    options={BITRATE_OPTIONS}
    onchange={(v) => void settings.setMaxBitrate(parseBitrate(v))}
  />
  <SelectRow
    label="DSD playback"
    hint="DoP needs exclusive mode, DSP bypassed and a device that supports the carrier rate"
    value={settings.current.dsp.dsd}
    options={[
      { value: 'dop', label: 'DoP (native, falls back to PCM)' },
      { value: 'pcm', label: 'PCM (352.8 kHz)' },
    ]}
    onchange={(v) => void settings.updateDsp({ dsd: v as DsdMode })}
  />
</Section>
