<script lang="ts">
  import { getContext, onMount } from 'svelte';
  import { getApp } from '../../lib/app.svelte';
  import {
    isAndroid,
    isIgnoringBatteryOptimizations,
    listStorageVolumes,
    requestIgnoreBatteryOptimizations,
    type StorageVolume,
  } from '../../lib/android';
  import { formatBytes } from '../../lib/jellyfin/models';
  import { errorMessage } from '../../lib/player/errors.svelte';
  import { UI_KEY, type UiState } from '../shell/router.svelte';
  import Section from './Section.svelte';
  import SelectRow from './SelectRow.svelte';
  import ToggleRow from './ToggleRow.svelte';

  const core = getApp().core;
  const settings = core.settings;
  const dl = core.downloads;
  const ui = getContext<UiState | undefined>(UI_KEY);

  let volumes = $state<StorageVolume[]>([]);
  let exempt = $state<boolean | null>(null);
  let confirming = $state(false);

  const dir = $derived(settings.current.downloads.dir);
  const options = $derived.by(() => {
    const list = [{ value: '', label: 'App default' }];
    for (const v of volumes) {
      list.push({ value: v.path, label: `${v.label} · ${formatBytes(v.freeBytes)} free` });
    }
    if (dir !== null && !volumes.some((v) => v.path === dir)) list.push({ value: dir, label: dir });
    return list;
  });

  async function refreshBattery() {
    try {
      exempt = await isIgnoringBatteryOptimizations();
    } catch {
      exempt = null;
    }
  }

  onMount(() => {
    if (!isAndroid) return;
    void listStorageVolumes().then((v) => (volumes = v)).catch(() => {});
    void refreshBattery();
    const onVisible = () => {
      if (document.visibilityState === 'visible') void refreshBattery();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  });

  async function chooseDir(value: string) {
    const next = value === '' ? null : value;
    const prev = dir;
    await settings.updateDownloads({ dir: next });
    try {
      await dl.setDir(next);
    } catch (e) {
      await settings.updateDownloads({ dir: prev });
      ui?.toast(`Could not use that folder: ${errorMessage(e)}`);
    }
  }

  async function requestExemption() {
    try {
      await requestIgnoreBatteryOptimizations();
    } catch (e) {
      ui?.toast(errorMessage(e));
    }
    await refreshBattery();
  }

  function removeAll() {
    if (!confirming) {
      confirming = true;
      return;
    }
    confirming = false;
    dl.cancelAll();
    void dl.deleteAll();
  }
</script>

<Section title="Downloads" id="downloads">
  <ToggleRow
    label="Download on Wi-Fi only"
    hint="Downloads wait while on mobile data and continue on Wi-Fi"
    checked={settings.current.downloads.wifiOnly}
    onchange={(v) => void settings.updateDownloads({ wifiOnly: v })}
  />
  {#if isAndroid}
    <SelectRow
      label="Save downloads to"
      hint="New downloads only; existing ones stay where they are"
      value={dir ?? ''}
      {options}
      onchange={(v) => void chooseDir(v)}
    />
    <div class="row">
      <span class="label">
        <span>Battery optimisation</span>
        <span class="hint">
          {exempt ? 'Rayla is exempt.' : 'Exempting Rayla keeps playback and downloads running with the screen off.'}
        </span>
      </span>
      {#if exempt !== true}
        <button type="button" class="btn" onclick={() => void requestExemption()}>Allow</button>
      {/if}
    </div>
  {/if}
  <div class="row">
    <span class="label">
      <span>{dl.sortedEntries.length} download{dl.sortedEntries.length === 1 ? '' : 's'} · {formatBytes(dl.totalBytes)}</span>
      <span class="hint">Removes the offline copies, not the music on your server.</span>
    </span>
    <button type="button" class="btn danger" disabled={dl.sortedEntries.length === 0} onclick={removeAll} onblur={() => (confirming = false)}>
      {confirming ? 'Click again to confirm' : 'Remove all downloads'}
    </button>
  </div>
</Section>
