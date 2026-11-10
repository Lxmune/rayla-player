<script lang="ts">
  import { getApp } from '../../lib/app.svelte';
  import type { CrossfeedLevel, DitherMode } from '../../lib/ipc';
  import { pickFile } from '../../lib/platform';
  import { errorMessage } from '../../lib/player/errors.svelte';
  import { bitPerfectBlockers } from './bitperfect';
  import RangeRow from './RangeRow.svelte';
  import Section from './Section.svelte';
  import SelectRow from './SelectRow.svelte';
  import CompressorRows from './CompressorRows.svelte';
  import { CROSSFEED_OPTIONS } from './options';

  const settings = getApp().core.settings;
  const dsp = $derived(settings.current.dsp);
  let pickError = $state<string | null>(null);

  const rates = [44100, 48000, 88200, 96000, 176400, 192000];
  const rateOptions = [
    { value: 'auto', label: 'Auto (source rate)' },
    ...rates.map((r) => ({ value: String(r), label: `${r / 1000} kHz` })),
  ];

  async function chooseIr() {
    pickError = null;
    try {
      const path = await pickFile('Impulse response', ['wav']);
      if (path !== null) await settings.updateDsp({ convolutionPath: path });
    } catch (e) {
      pickError = errorMessage(e);
    }
  }

  const blockers = $derived(bitPerfectBlockers(dsp, getApp().core.player.effectiveMaxBitrate));
</script>

<Section title="Processing" id="processing">
  <div class="stack">
    <span>Convolution</span>
    <div class="ir">
      <span class="path mono" title={dsp.convolutionPath ?? ''}>
        {dsp.convolutionPath ?? 'No impulse response'}
      </span>
      <button type="button" class="btn" onclick={chooseIr}>Choose WAV…</button>
      <button
        type="button"
        class="btn"
        disabled={dsp.convolutionPath === null}
        onclick={() => void settings.updateDsp({ convolutionPath: null })}>Clear</button
      >
    </div>
    {#if pickError}<p class="error" role="alert">{pickError}</p>{/if}
  </div>
  <SelectRow
    label="Crossfeed"
    value={dsp.crossfeed}
    options={CROSSFEED_OPTIONS}
    onchange={(v) => void settings.updateDsp({ crossfeed: v as CrossfeedLevel })}
  />
  <CompressorRows full />
  <SelectRow
    label="Resample to"
    value={dsp.resampleTo === null ? 'auto' : String(dsp.resampleTo)}
    options={rateOptions}
    onchange={(v) => void settings.updateDsp({ resampleTo: v === 'auto' ? null : Number(v) })}
  />
  <SelectRow
    label="Dither"
    value={dsp.dither}
    options={[
      { value: 'off', label: 'Off' },
      { value: 'tpdf', label: 'TPDF' },
      { value: 'shaped', label: 'Noise-shaped' },
    ]}
    onchange={(v) => void settings.updateDsp({ dither: v as DitherMode })}
  />
  <RangeRow
    label="Crossfade"
    hint="Never applied between tracks of the same album"
    value={dsp.crossfadeMs / 1000}
    min={0}
    max={12}
    step={1}
    format={(v) => (v === 0 ? 'Off' : `${v} s`)}
    oncommit={(v) => void settings.updateDsp({ crossfadeMs: Math.round(v * 1000) })}
  />

  <div class="bp" data-bit-perfect={blockers.length === 0}>
    <strong>{blockers.length === 0 ? 'Current settings are bit-perfect' : 'Not bit-perfect'}</strong>
    <p class="note">
      With every stage above off, no bitrate cap and volume at 100%, samples reach the device
      untouched (use exclusive mode so the system mixer stays out of the way).
    </p>
    {#if blockers.length > 0}
      <ul>
        {#each blockers as b (b)}<li>{b}</li>{/each}
      </ul>
    {/if}
  </div>
</Section>

<style>
  .ir { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2); }
  .path { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--text-sm); color: var(--text-muted); }
  .bp { margin-top: var(--space-3); padding: var(--space-3); border-radius: var(--radius-sm); background: var(--surface-2); border-left: 3px solid var(--text-faint); }
  .bp[data-bit-perfect='true'] { border-left-color: var(--success); }
  .bp ul { margin: var(--space-1) 0 0; padding-left: var(--space-4); font-size: var(--text-sm); color: var(--text-muted); }
  .bp p { margin: var(--space-1) 0; }
</style>
