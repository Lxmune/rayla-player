<script lang="ts">
  /** Quality, codec, adaptive and download-ahead rows shared by Settings and the Audio sheet. */
  import { getApp } from '../../lib/app.svelte';
  import { MAX_PREFETCH_TRACKS, TRANSCODE_CODECS } from '../../lib/settings/types';
  import {
    BITRATE_OPTIONS,
    CODEC_OPTIONS,
    PREFETCH_OPTIONS,
    bitrateValue,
    parseBitrate,
  } from './options';
  import SelectRow from './SelectRow.svelte';
  import ToggleRow from './ToggleRow.svelte';

  let { qualityLabel = 'Bitrate cap', qualityHint }: { qualityLabel?: string; qualityHint: string } =
    $props();

  const settings = getApp().core.settings;
  const streaming = $derived(settings.current.streaming);
</script>

<SelectRow
  label={qualityLabel}
  hint={qualityHint}
  value={bitrateValue(settings.current.maxBitrate)}
  options={BITRATE_OPTIONS}
  onchange={(v) => void settings.setMaxBitrate(parseBitrate(v))}
/>
<SelectRow
  label="Transcode format"
  hint="Used when quality is capped or adapts"
  value={streaming.codec}
  options={CODEC_OPTIONS}
  onchange={(v) => {
    const codec = TRANSCODE_CODECS.find((c) => c === v);
    if (codec) void settings.updateStreaming({ codec: codec });
  }}
/>
<ToggleRow
  label="Adapt to slow connections"
  hint="Lowers quality for upcoming tracks when the measured download speed can't keep up; original otherwise"
  checked={streaming.adaptive}
  onchange={(adaptive) => void settings.updateStreaming({ adaptive })}
/>
<SelectRow
  label="Download ahead"
  hint="Upcoming queue tracks are fully downloaded ahead for gap-free playback on bad connections"
  value={String(streaming.prefetchTracks)}
  options={PREFETCH_OPTIONS}
  onchange={(v) =>
    void settings.updateStreaming({ prefetchTracks: Math.min(MAX_PREFETCH_TRACKS, Number(v)) })}
/>
