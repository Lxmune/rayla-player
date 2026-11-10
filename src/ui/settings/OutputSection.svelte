<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { getApp } from '../../lib/app.svelte';
  import type { OutputDevice } from '../../lib/ipc';
  import { formatSampleRate } from '../../lib/jellyfin/models';
  import { OutputDevices } from '../sheets/output-devices.svelte';
  import Section from './Section.svelte';
  import ToggleRow from './ToggleRow.svelte';

  const settings = getApp().core.settings;
  const list = new OutputDevices();
  const devices = $derived(list.devices);
  const loadError = $derived(list.error);
  const loading = $derived(list.loading);

  onMount(() => void list.start());
  onDestroy(() => list.dispose());

  const selectedId = $derived(settings.current.outputDeviceId);
  /** The device actually used: the chosen one, else the system default. */
  const effective = $derived(
    devices.find((d) => (selectedId === null ? d.isDefault : d.id === selectedId)) ?? null,
  );
  const canExclusive = $derived(effective?.supportsExclusive ?? false);

  function describe(d: OutputDevice): string {
    const parts: string[] = [];
    if (d.sampleRates.length > 0) {
      const lo = Math.min(...d.sampleRates);
      const hi = Math.max(...d.sampleRates);
      parts.push(lo === hi ? formatSampleRate(lo) : `${formatSampleRate(lo)} – ${formatSampleRate(hi)}`);
    }
    if (d.maxBitDepth > 0) parts.push(`up to ${d.maxBitDepth}-bit`);
    if (d.supportsExclusive) parts.push('exclusive capable');
    return parts.join(' · ');
  }

  function choose(id: string | null) {
    const dev = devices.find((d) => (id === null ? d.isDefault : d.id === id));
    const exclusive = settings.current.exclusive && (dev?.supportsExclusive ?? false);
    void settings.setOutput(id, exclusive);
  }
</script>

<Section title="Output" id="output">
  {#if loading}
    <p class="note">Looking for audio devices…</p>
  {:else if loadError}
    <p class="error" role="alert">Could not list devices: {loadError}</p>
  {/if}
  <fieldset class="devices">
    <legend class="visually-hidden">Output device</legend>
    <label class="device">
      <input
        type="radio"
        name="output-device"
        checked={selectedId === null}
        onchange={() => choose(null)}
      />
      <span class="label">
        <span>System default</span>
        {#if devices.find((d) => d.isDefault)}
          <span class="hint">{devices.find((d) => d.isDefault)?.name}</span>
        {/if}
      </span>
    </label>
    {#each devices as d (d.id)}
      <label class="device">
        <input
          type="radio"
          name="output-device"
          checked={selectedId === d.id}
          onchange={() => choose(d.id)}
        />
        <span class="label">
          <span>{d.name}</span>
          <span class="hint">{describe(d)}</span>
        </span>
      </label>
    {/each}
  </fieldset>
  <ToggleRow
    label="Exclusive mode"
    hint={canExclusive
      ? 'Take the device for bit-perfect output and automatic sample-rate switching'
      : 'Not supported by the selected device'}
    checked={settings.current.exclusive && canExclusive}
    disabled={!canExclusive}
    onchange={(v) => void settings.setOutput(selectedId, v)}
  />
  <ToggleRow
    label="Separate sound settings for each output"
    hint="Equalizer, gain and processing are remembered per device, so headphones and speakers keep their own"
    checked={settings.current.perDeviceDsp}
    onchange={(v) => void settings.setPerDeviceDsp(v)}
  />
</Section>

<style>
  .devices { border: 0; margin: 0; padding: 0; display: flex; flex-direction: column; }
  .device { display: flex; align-items: center; gap: var(--space-3); padding: var(--space-2) var(--space-3); margin: 0 calc(var(--space-3) * -1); border-radius: var(--radius-md); cursor: pointer; transition: background var(--transition); }
  .device:hover { background: var(--hover); }
  .device input { accent-color: var(--accent); flex: none; }
  .label { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .hint { font-size: var(--text-xs); color: var(--text-muted); }
  .note { color: var(--text-muted); font-size: var(--text-sm); margin: 0; }
  .error { color: var(--danger); font-size: var(--text-sm); margin: 0; }
  .visually-hidden { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
</style>
