<script lang="ts">
  import { getApp } from '../../lib/app.svelte';
  import type { EqBand, EqBandKind } from '../../lib/ipc';
  import { AutoEqFormatError, parseAutoEq } from '../../lib/integrations/autoeq';
  import { errorMessage } from '../../lib/player/errors.svelte';
  import RangeRow from './RangeRow.svelte';
  import Section from './Section.svelte';
  import ToggleRow from './ToggleRow.svelte';

  const settings = getApp().core.settings;
  const dsp = $derived(settings.current.dsp);

  let importError = $state<string | null>(null);
  let skipped = $state<string[]>([]);
  let imported = $state<string | null>(null);

  const kinds: { value: EqBandKind; label: string }[] = [
    { value: 'peak', label: 'Peak' },
    { value: 'lowShelf', label: 'Low shelf' },
    { value: 'highShelf', label: 'High shelf' },
  ];

  function setBands(f: (bands: EqBand[]) => EqBand[]) {
    void settings.updateDsp((d) => ({ ...d, eqBands: f(d.eqBands) }));
  }
  function patch(i: number, p: Partial<EqBand>) {
    setBands((bands) => bands.map((b, j) => (j === i ? { ...b, ...p } : b)));
  }
  /** Commits a numeric field; ignores unusable input (the field reverts on re-render). */
  function commitNumber(i: number, key: 'freqHz' | 'gainDb' | 'q', el: HTMLInputElement) {
    const v = el.valueAsNumber;
    const positive = key !== 'gainDb';
    if (!Number.isFinite(v) || (positive && v <= 0)) {
      el.value = String(dsp.eqBands[i]?.[key] ?? '');
      return;
    }
    patch(i, { [key]: v });
  }
  function addBand() {
    setBands((bands) => [...bands, { kind: 'peak', freqHz: 1000, gainDb: 0, q: 1 }]);
  }

  async function importFile(e: Event & { currentTarget: HTMLInputElement }) {
    const input = e.currentTarget;
    const file = input.files?.[0];
    if (!file) return;
    importError = null;
    skipped = [];
    imported = null;
    try {
      const profile = parseAutoEq(await file.text());
      await settings.updateDsp({
        eqBands: profile.bands,
        eqPreampDb: profile.preampDb,
        eqEnabled: true,
      });
      skipped = profile.skipped;
      imported = `Imported ${profile.bands.length} filters from ${file.name}`;
    } catch (err) {
      importError =
        err instanceof AutoEqFormatError ? err.message : `Could not read file: ${errorMessage(err)}`;
    }
    input.value = '';
  }
</script>

<Section title="Parametric EQ" id="eq">
  <ToggleRow
    label="Enable EQ"
    checked={dsp.eqEnabled}
    onchange={(v) => void settings.updateDsp({ eqEnabled: v })}
  />
  <RangeRow
    label="EQ preamp"
    hint="Negative values leave headroom for boosted bands"
    value={dsp.eqPreampDb}
    min={-24}
    max={12}
    step={0.1}
    format={(v) => `${v > 0 ? '+' : ''}${v.toFixed(1)} dB`}
    oncommit={(v) => void settings.updateDsp({ eqPreampDb: v })}
  />

  {#if dsp.eqBands.length === 0}
    <p class="note">No bands. Add one or import an AutoEQ profile.</p>
  {:else}
    <ul class="bands">
      {#each dsp.eqBands as band, i (i)}
        <li class="band">
          <select
            class="field"
            aria-label={`Band ${i + 1} type`}
            value={band.kind}
            onchange={(e) => patch(i, { kind: e.currentTarget.value as EqBandKind })}
          >
            {#each kinds as k (k.value)}
              <option value={k.value} selected={k.value === band.kind}>{k.label}</option>
            {/each}
          </select>
          <label class="num">
            <span class="unit">Hz</span>
            <input
              class="field"
              type="number"
              min="1"
              step="any"
              aria-label={`Band ${i + 1} frequency (Hz)`}
              value={band.freqHz}
              onchange={(e) => commitNumber(i, 'freqHz', e.currentTarget)}
            />
          </label>
          <label class="num">
            <span class="unit">dB</span>
            <input
              class="field"
              type="number"
              step="0.1"
              aria-label={`Band ${i + 1} gain (dB)`}
              value={band.gainDb}
              onchange={(e) => commitNumber(i, 'gainDb', e.currentTarget)}
            />
          </label>
          <label class="num">
            <span class="unit">Q</span>
            <input
              class="field"
              type="number"
              min="0.01"
              step="0.01"
              aria-label={`Band ${i + 1} Q`}
              value={band.q}
              onchange={(e) => commitNumber(i, 'q', e.currentTarget)}
            />
          </label>
          <button
            type="button"
            class="btn danger"
            aria-label={`Remove band ${i + 1}`}
            onclick={() => setBands((bands) => bands.filter((_, j) => j !== i))}>Remove</button
          >
        </li>
      {/each}
    </ul>
  {/if}

  <div class="actions">
    <button type="button" class="btn" onclick={addBand}>Add band</button>
    <label class="btn file">
      Import AutoEQ…
      <input type="file" accept=".txt" class="visually-hidden" onchange={importFile} />
    </label>
  </div>
  {#if imported}<p class="note" role="status">{imported}</p>{/if}
  {#if importError}<p class="error" role="alert">{importError}</p>{/if}
  {#if skipped.length > 0}
    <details>
      <summary class="note">{skipped.length} lines skipped</summary>
      <ul class="skipped">
        {#each skipped as s, i (i)}<li class="mono">{s}</li>{/each}
      </ul>
    </details>
  {/if}
</Section>

<style>
  .bands { list-style: none; margin: var(--space-2) 0; padding: 0; display: flex; flex-direction: column; gap: var(--space-2); }
  .band { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2); }
  .num { display: flex; align-items: center; gap: var(--space-1); }
  .num input { width: 88px; }
  .unit { font-size: var(--text-xs); color: var(--text-muted); }
  .actions { display: flex; gap: var(--space-2); margin-top: var(--space-2); }
  .file { position: relative; display: inline-block; }
  .file:focus-within { outline: 2px solid var(--accent); outline-offset: 2px; }
  .visually-hidden { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }
  .skipped { margin: var(--space-1) 0; padding-left: var(--space-4); font-size: var(--text-xs); color: var(--text-muted); }
</style>
