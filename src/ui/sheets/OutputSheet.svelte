<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { getApp } from '../../lib/app.svelte';
  import { formatSampleRate } from '../../lib/jellyfin/models';
  import { errorMessage } from '../../lib/player/errors.svelte';
  import BitPerfectBadge from '../common/BitPerfectBadge.svelte';
  import Icon from '../common/Icon.svelte';
  import { getUi } from '../shell/router.svelte';
  import ToggleRow from '../settings/ToggleRow.svelte';
  import { describeDevice, deviceIcon, OutputDevices } from './output-devices.svelte';

  const app = getApp();
  const ui = getUi();
  const settings = app.core.settings;
  const list = new OutputDevices();
  let actionError = $state<string | null>(null);

  onMount(() => void list.start());
  onDestroy(() => list.dispose());

  const selectedId = $derived(settings.current.outputDeviceId);
  const exclusive = $derived(settings.current.exclusive);
  const selected = $derived(list.find(selectedId));
  const disconnected = $derived(
    !list.loading && !list.error && selectedId !== null && selected === null,
  );
  const canExclusive = $derived(selected?.supportsExclusive ?? false);
  const path = $derived(app.core.player.signalPath);

  async function apply(id: string | null, excl: boolean) {
    actionError = null;
    try {
      await settings.setOutput(id, excl);
    } catch (e) {
      actionError = errorMessage(e);
    }
  }

  function choose(id: string | null) {
    const dev = list.find(id);
    void apply(id, exclusive && (dev?.supportsExclusive ?? false));
  }

  const fmt = (bits: number, rate: number) =>
    [bits > 0 ? `${bits}-bit` : '', rate > 0 ? formatSampleRate(rate) : ''].filter(Boolean).join(' / ');
</script>

<div class="out">
  <div class="now" data-testid="output-now">
    {#if path}
      <div class="now-text">
        <span class="now-label">Now</span>
        <span class="now-dev">{path.deviceName}</span>
        <span class="now-fmt">
          {[fmt(path.outputBitDepth, path.outputSampleRate), path.exclusive ? 'Exclusive' : 'Shared']
            .filter(Boolean)
            .join(' · ')}
        </span>
      </div>
      <BitPerfectBadge />
    {:else}
      <span class="now-fmt">Nothing is playing.</span>
    {/if}
    <button type="button" class="link" onclick={() => (ui.sheet = { kind: 'signal' })}>Signal path</button>
  </div>

  {#if list.loading}
    <p class="note">Looking for audio devices…</p>
  {:else if list.error}
    <p class="error" role="alert">Could not list devices: {list.error}</p>
    <button type="button" class="link" onclick={() => void list.refresh()}>Try again</button>
  {/if}
  {#if actionError}
    <p class="error" role="alert">Could not switch output: {actionError}</p>
  {/if}

  <ul class="devices" aria-label="Output device">
    <li>
      <button type="button" class="row" class:on={selectedId === null} aria-pressed={selectedId === null}
        onclick={() => choose(null)}>
        <span class="ico"><Icon name={deviceIcon(list.defaultDevice?.name ?? '')} size={22} /></span>
        <span class="text">
          <span class="name">System default</span>
          {#if list.defaultDevice}<span class="hint">{list.defaultDevice.name}</span>{/if}
        </span>
        {#if selectedId === null}<span class="check"><Icon name="check" size={20} /></span>{/if}
      </button>
    </li>
    {#if disconnected}
      <li>
        <button type="button" class="row on missing" aria-pressed="true" disabled>
          <span class="ico"><Icon name="offline" size={22} /></span>
          <span class="text">
            <span class="name">Disconnected</span>
            <span class="hint">The selected device is not available</span>
          </span>
        </button>
      </li>
    {/if}
    {#each list.devices as d (d.id)}
      <li>
        <button type="button" class="row" class:on={selectedId === d.id} aria-pressed={selectedId === d.id}
          onclick={() => choose(d.id)}>
          <span class="ico"><Icon name={deviceIcon(d.name)} size={22} /></span>
          <span class="text">
            <span class="name">{d.name}</span>
            {#if describeDevice(d)}<span class="hint">{describeDevice(d)}</span>{/if}
          </span>
          {#if selectedId === d.id}<span class="check"><Icon name="check" size={20} /></span>{/if}
        </button>
      </li>
    {/each}
  </ul>
  {#if !list.loading && !list.error && list.devices.length === 0}
    <p class="note">No audio devices found.</p>
  {/if}

  <ToggleRow
    label="Exclusive mode"
    hint={canExclusive
      ? 'Take the device for bit-perfect output and automatic sample-rate switching'
      : 'Not supported by the selected device'}
    checked={exclusive && canExclusive}
    disabled={!canExclusive}
    onchange={(v) => void apply(selectedId, v)}
  />
</div>

<style>
  .out { display: flex; flex-direction: column; gap: var(--space-3); }
  .now { display: flex; align-items: center; gap: var(--space-3); padding: var(--space-3); border-radius: var(--radius-md); background: var(--surface-2); flex-wrap: wrap; }
  .now-text { display: flex; flex-direction: column; min-width: 0; flex: 1; }
  .now-label { font-size: var(--text-xs); letter-spacing: 0.08em; text-transform: uppercase; color: var(--text-faint); }
  .now-dev { font-weight: var(--weight-semibold); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .now-fmt { font-size: var(--text-xs); color: var(--text-muted); }
  .link { border: 0; background: transparent; color: var(--accent); cursor: pointer; font: inherit; font-size: var(--text-sm); padding: var(--space-2); min-height: 40px; }
  .devices { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--space-1); }
  .row { display: flex; align-items: center; gap: var(--space-3); width: 100%; min-height: 52px; padding: var(--space-2) var(--space-3); border: 0; border-radius: var(--radius-md); background: transparent; color: inherit; text-align: left; cursor: pointer; font: inherit; transition: background var(--transition); }
  .row:hover { background: var(--hover); }
  .row.on { background: var(--accent-soft); }
  .row:disabled { cursor: default; }
  .row.missing { color: var(--text-muted); }
  .ico { flex: none; display: inline-flex; color: var(--text-muted); }
  .row.on .ico, .check { color: var(--accent); }
  .check { display: inline-flex; flex: none; }
  .text { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1; }
  .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .hint { font-size: var(--text-xs); color: var(--text-muted); }
  .note { color: var(--text-muted); font-size: var(--text-sm); margin: 0; }
  .error { color: var(--danger); font-size: var(--text-sm); margin: 0; }
</style>
