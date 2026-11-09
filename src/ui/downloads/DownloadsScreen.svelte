<script lang="ts">
  import { getApp } from '../../lib/app.svelte';
  import { formatBytes, progressFraction } from '../../lib/downloads/store.svelte';
  import type { BaseItem } from '../../lib/jellyfin/models';

  const core = getApp().core;
  const dl = core.downloads;
  let confirming = $state(false);

  const failures = $derived([...dl.failed.values()]);
  const subtitle = (i: BaseItem) => [i.artists[0] ?? i.albumArtist, i.album].filter(Boolean).join(' · ');
  const isEmpty = $derived(dl.activeList.length === 0 && failures.length === 0 && dl.sortedEntries.length === 0);
</script>

<div class="dl">
  <header>
    <h1>Downloads</h1>
    {#if dl.sortedEntries.length > 0}
      <p class="total">{dl.sortedEntries.length} tracks · {formatBytes(dl.totalBytes)}</p>
    {/if}
  </header>

  {#if isEmpty}
    <p class="empty">{dl.loaded ? 'No downloads yet.' : 'Loading…'}</p>
  {/if}

  {#if dl.activeList.length > 0}
    <section>
      <div class="head">
        <h2>In progress</h2>
        <button type="button" class="btn" onclick={() => dl.cancelAll()}>Cancel all</button>
      </div>
      <ul>
        {#each dl.activeList as a (a.id)}
          {@const frac = a.started ? progressFraction(a) : 0}
          <li class="item">
            <div class="info">
              <span class="name">{a.item.name}</span>
              <span class="sub">
                {#if !a.started}Waiting…{:else if frac === null}{formatBytes(a.receivedBytes)}{:else}{Math.round(frac * 100)}% · {formatBytes(a.receivedBytes)} of {formatBytes(a.totalBytes)}{/if}
              </span>
              {#if frac === null}
                <progress aria-label={`Downloading ${a.item.name}`}></progress>
              {:else}
                <progress aria-label={`Downloading ${a.item.name}`} value={frac} max="1"></progress>
              {/if}
            </div>
            <button type="button" class="btn" aria-label={`Cancel ${a.item.name}`} onclick={() => dl.cancel(a.id)}>Cancel</button>
          </li>
        {/each}
      </ul>
    </section>
  {/if}

  {#if failures.length > 0}
    <section>
      <h2>Failed</h2>
      <ul>
        {#each failures as f (f.item.id)}
          <li class="item">
            <div class="info">
              <span class="name">{f.item.name}</span>
              <span class="sub error">{f.reason}</span>
            </div>
          </li>
        {/each}
      </ul>
    </section>
  {/if}

  {#if dl.sortedEntries.length > 0}
    <section>
      <div class="head">
        <h2>Downloaded</h2>
        {#if confirming}
          <span class="confirm">
            <span>Delete all {dl.sortedEntries.length} downloads?</span>
            <button
              type="button"
              class="btn danger"
              onclick={() => {
                confirming = false;
                void dl.deleteAll();
              }}>Delete</button
            >
            <button type="button" class="btn" onclick={() => (confirming = false)}>Keep</button>
          </span>
        {:else}
          <button type="button" class="btn danger" onclick={() => (confirming = true)}>Delete all</button>
        {/if}
      </div>
      <ul>
        {#each dl.sortedEntries as e (e.id)}
          <li class="item">
            <div class="info">
              <span class="name">{e.item.name}</span>
              <span class="sub">{[subtitle(e.item), formatBytes(e.bytes)].filter(Boolean).join(' · ')}</span>
            </div>
            <button type="button" class="btn" aria-label={`Play ${e.item.name}`} onclick={() => void core.player.playQueue([e.item])}>Play</button>
            <button type="button" class="btn danger" aria-label={`Delete ${e.item.name}`} onclick={() => void dl.delete(e.id)}>Delete</button>
          </li>
        {/each}
      </ul>
    </section>
  {/if}
</div>

<style>
  .dl { height: 100%; overflow-y: auto; padding: var(--space-5); max-width: 720px; margin: 0 auto; }
  header { display: flex; align-items: baseline; justify-content: space-between; gap: var(--space-4); margin-bottom: var(--space-4); }
  h1 { font-size: var(--text-xl); margin: 0; font-weight: 600; }
  h2 { font-size: var(--text-sm); text-transform: uppercase; letter-spacing: 0.08em; color: var(--text-muted); margin: 0; font-weight: 600; }
  .total, .empty { color: var(--text-muted); margin: 0; font-size: var(--text-sm); }
  section { margin-bottom: var(--space-5); }
  .head { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); margin-bottom: var(--space-2); }
  ul { list-style: none; margin: 0; padding: 0; }
  .item { display: flex; align-items: center; gap: var(--space-2); padding: var(--space-2) 0; border-bottom: 1px solid var(--border); }
  .info { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
  .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .sub { font-size: var(--text-xs); color: var(--text-muted); }
  .sub.error { color: var(--danger); }
  progress { width: 100%; height: 4px; accent-color: var(--accent); }
  .confirm { display: flex; align-items: center; gap: var(--space-2); font-size: var(--text-sm); }
  .btn { background: var(--surface-2); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: var(--space-1) var(--space-3); cursor: pointer; flex: none; }
  .btn:hover { border-color: var(--accent); }
  .btn.danger { color: var(--danger); }
</style>
