<script lang="ts">
  import { getContext, onMount } from 'svelte';
  import { getApp } from '../../lib/app.svelte';
  import { formatBytes } from '../../lib/jellyfin/models';
  import { errorMessage } from '../../lib/player/errors.svelte';
  import { UI_KEY, type UiState } from '../shell/router.svelte';
  import { CACHE_LIMIT_OPTIONS } from './options';
  import Section from './Section.svelte';
  import SelectRow from './SelectRow.svelte';

  const settings = getApp().core.settings;
  const ui = getContext<UiState | undefined>(UI_KEY);

  let stats = $state<{ usedBytes: number; limitBytes: number; entries: number } | null>(null);
  let failed = $state<string | null>(null);
  let confirming = $state(false);
  let busy = $state(false);

  async function refresh() {
    try {
      stats = await settings.cacheStats();
      failed = null;
    } catch (e) {
      failed = errorMessage(e);
    }
  }

  async function clear() {
    if (!confirming) {
      confirming = true;
      return;
    }
    confirming = false;
    busy = true;
    try {
      await settings.clearCache();
      ui?.toast('Stream cache cleared');
    } catch (e) {
      failed = errorMessage(e);
    }
    busy = false;
    await refresh();
  }

  onMount(() => void refresh());

  // The limit changes what the engine keeps; show the new total afterwards.
  const limitMb = $derived(settings.current.streaming.cacheLimitMb);
  let seenLimit: number | null = null;
  $effect(() => {
    const mb = limitMb;
    if (seenLimit !== null && mb !== seenLimit) void refresh();
    seenLimit = mb;
  });

  const summary = $derived(
    stats === null
      ? 'Stream cache'
      : `Stream cache: ${formatBytes(stats.usedBytes)} of ${formatBytes(stats.limitBytes)} · ${stats.entries} track${stats.entries === 1 ? '' : 's'}`,
  );
</script>

<Section title="Cache" id="cache">
  <div class="row">
    <span class="label">
      <span>{summary}</span>
      <span class="hint">
        {failed ?? 'Offline downloads are not affected.'}
      </span>
    </span>
    <button type="button" class="btn danger" disabled={busy || stats?.entries === 0} onclick={clear} onblur={() => (confirming = false)}>
      {confirming ? 'Click again to confirm' : 'Clear cache'}
    </button>
  </div>
  <SelectRow
    label="Cache size limit"
    hint="Least recently played tracks are removed first"
    value={String(limitMb)}
    options={CACHE_LIMIT_OPTIONS}
    onchange={(v) => void settings.updateStreaming({ cacheLimitMb: Number(v) })}
  />
</Section>
