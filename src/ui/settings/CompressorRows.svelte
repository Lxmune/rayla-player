<script lang="ts">
  /** Compressor controls, shared by the Processing section and the quick Audio sheet. */
  import { getApp } from '../../lib/app.svelte';
  import type { CompressorConfig } from '../../lib/ipc';
  import RangeRow from './RangeRow.svelte';
  import ToggleRow from './ToggleRow.svelte';

  /** `full` adds attack and release; the quick sheet keeps the essentials. */
  let { full = false }: { full?: boolean } = $props();

  const settings = getApp().core.settings;
  const comp = $derived(settings.current.dsp.compressor);
  const db = (v: number) => `${v > 0 ? '+' : ''}${v.toFixed(1)} dB`;
  const update = (change: Partial<CompressorConfig>) =>
    void settings.updateDsp((d) => ({ ...d, compressor: { ...d.compressor, ...change } }));
</script>

<ToggleRow
  label="Compressor"
  hint="Evens out loud and quiet passages"
  checked={comp.enabled}
  onchange={(enabled) => update({ enabled })}
/>
{#if comp.enabled}
  <RangeRow label="Threshold" value={comp.thresholdDb} min={-48} max={0} step={1} format={db}
    oncommit={(thresholdDb) => update({ thresholdDb })} />
  <RangeRow label="Ratio" value={comp.ratio} min={1} max={10} step={0.5} format={(v) => `${v}:1`}
    oncommit={(ratio) => update({ ratio })} />
  <RangeRow label="Makeup gain" value={comp.makeupDb} min={0} max={12} step={0.5} format={db}
    oncommit={(makeupDb) => update({ makeupDb })} />
  {#if full}
    <RangeRow label="Attack" value={comp.attackMs} min={1} max={100} step={1} format={(v) => `${v} ms`}
      oncommit={(attackMs) => update({ attackMs })} />
    <RangeRow label="Release" value={comp.releaseMs} min={20} max={1000} step={10} format={(v) => `${v} ms`}
      oncommit={(releaseMs) => update({ releaseMs })} />
  {/if}
{/if}
