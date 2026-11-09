<script lang="ts">
  import { getApp } from '../../lib/app.svelte';
  import type { DsdMode } from '../../lib/ipc';
  import Section from './Section.svelte';
  import SelectRow from './SelectRow.svelte';

  const settings = getApp().core.settings;
  const bitrates = [null, 320000, 256000, 192000, 128000];
  const options = bitrates.map((b) => ({
    value: b === null ? 'original' : String(b),
    label: b === null ? 'Original (no transcoding)' : `${b / 1000} kbps`,
  }));
</script>

<Section title="Streaming">
  <SelectRow
    label="Bitrate cap"
    hint="Lower caps make the server transcode; Original is bit-exact"
    value={settings.current.maxBitrate === null ? 'original' : String(settings.current.maxBitrate)}
    {options}
    onchange={(v) => void settings.setMaxBitrate(v === 'original' ? null : Number(v))}
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
