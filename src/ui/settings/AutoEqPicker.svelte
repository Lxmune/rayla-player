<script lang="ts">
  import {
    fetchAutoEqProfile,
    loadAutoEqIndex,
    searchAutoEq,
    type AutoEqEntry,
    type AutoEqProfile,
  } from '../../lib/integrations/autoeq';
  import { errorMessage } from '../../lib/player/errors.svelte';
  import { httpFetch, localKv } from '../../lib/platform';

  let { onapply }: { onapply: (profile: AutoEqProfile, entry: AutoEqEntry) => void | Promise<void> } =
    $props();

  let open = $state(false);
  let query = $state('');
  let entries = $state.raw<AutoEqEntry[] | null>(null);
  let loading = $state(false);
  let busy = $state<string | null>(null);
  let error = $state<string | null>(null);

  const results = $derived(entries ? searchAutoEq(entries, query) : []);

  async function toggle() {
    open = !open;
    if (!open || entries || loading) return;
    loading = true;
    error = null;
    try {
      entries = await loadAutoEqIndex((u) => httpFetch(u), localKv);
    } catch (e) {
      error = `Could not load the AutoEQ list (${errorMessage(e)}). Check your connection, or import a ParametricEQ.txt file instead.`;
    } finally {
      loading = false;
    }
  }

  async function pick(entry: AutoEqEntry) {
    busy = entry.path;
    error = null;
    try {
      await onapply(await fetchAutoEqProfile((u) => httpFetch(u), entry), entry);
    } catch (e) {
      error = `Could not download the profile for ${entry.name} (${errorMessage(e)}). You can still import a file.`;
    } finally {
      busy = null;
    }
  }
</script>

<button type="button" class="btn" aria-expanded={open} onclick={toggle}>Find headphone…</button>

{#if open}
  <div class="picker">
    <input
      class="field search"
      type="search"
      placeholder="Search headphones (e.g. HD 600)"
      aria-label="Search AutoEQ headphones"
      bind:value={query}
    />
    {#if loading}<p class="note" role="status">Loading list…</p>{/if}
    {#if error}<p class="error" role="alert">{error}</p>{/if}
    {#if entries}
      {#if results.length === 0}
        <p class="note">No matches.</p>
      {:else}
        <ul class="list">
          {#each results as r (r.path)}
            <li>
              <button type="button" class="row" disabled={busy !== null} onclick={() => void pick(r)}>
                <span class="name">{r.name}</span>
                <span class="meta">{r.source}{r.rig ? ` · ${r.rig}` : ''}{busy === r.path ? ' · loading…' : ''}</span>
              </button>
            </li>
          {/each}
        </ul>
      {/if}
    {/if}
  </div>
{/if}

<style>
  .picker { flex-basis: 100%; display: flex; flex-direction: column; gap: var(--space-2); margin-top: var(--space-2); }
  .search { width: 100%; }
  .list { list-style: none; margin: 0; padding: 0; max-height: 280px; overflow-y: auto; border: 1px solid var(--border); border-radius: var(--radius-md); }
  .row { display: flex; justify-content: space-between; gap: var(--space-3); width: 100%; text-align: left; padding: var(--space-2) var(--space-3); background: none; border: 0; color: inherit; cursor: pointer; }
  .row:hover:not(:disabled) { background: var(--surface-2); }
  .meta { color: var(--text-muted); font-size: var(--text-xs); text-align: right; }
</style>
