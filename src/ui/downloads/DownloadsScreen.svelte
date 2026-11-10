<script lang="ts">
  import { getContext } from 'svelte';
  import { getApp } from '../../lib/app.svelte';
  import { formatBytes, progressFraction, type DownloadEntry } from '../../lib/downloads/store.svelte';
  import Artwork from '../common/Artwork.svelte';
  import Button from '../common/Button.svelte';
  import Icon from '../common/Icon.svelte';
  import IconButton from '../common/IconButton.svelte';
  import Skeleton from '../common/Skeleton.svelte';
  import { useActions } from '../common/actions';
  import { ROUTER_KEY, UI_KEY, type Router, type UiState } from '../shell/router.svelte';
  import { artistOf, filterEntries, groupEntries, sortEntries, trackCount, type DownloadSort } from './organize';

  const core = getApp().core;
  const dl = core.downloads;
  const actions = useActions();
  const router = getContext<Router | undefined>(ROUTER_KEY);
  const ui = getContext<UiState | undefined>(UI_KEY);
  const kept = core.kept;
  kept.ensureLoaded();
  const keptRows = $derived(kept.collections.map((c) => ({ c, ...kept.progress(c.item.id) })));

  let confirming = $state(false);
  let query = $state('');
  let sort = $state<DownloadSort>('recent');
  let grouped = $state(true);

  const failures = $derived([...dl.failed.values()]);
  const filtered = $derived(filterEntries(dl.sortedEntries, query));
  const groups = $derived(grouped ? groupEntries(filtered, sort) : []);
  /** Entries in the order they are shown (what Play uses as the queue). */
  const flat = $derived(grouped ? groups.flatMap((g) => g.entries) : sortEntries(filtered, sort));
  const isEmpty = $derived(
    dl.activeList.length === 0 && failures.length === 0 && dl.sortedEntries.length === 0 && keptRows.length === 0,
  );

  const subtitle = (e: DownloadEntry) => [artistOf(e), e.item.album].filter(Boolean).join(' · ');

  function play(list: DownloadEntry[], startIndex = 0) {
    void actions.guard(() => core.player.playQueue(list.map((e) => e.item), { startIndex }));
  }
</script>

{#snippet row(e: DownloadEntry, showAlbum: boolean)}
  <li class="item">
    <button type="button" class="main" aria-label={`Play ${e.item.name}`} onclick={() => play(flat, flat.indexOf(e))}>
      <span class="play" aria-hidden="true"><Icon name="play" size={14} /></span>
      <span class="info">
        <span class="name">{e.item.name}</span>
        <span class="sub">{showAlbum ? subtitle(e) : artistOf(e)}</span>
      </span>
      <span class="size">{formatBytes(e.bytes)}</span>
    </button>
    <IconButton icon="trash" size={16} label={`Remove ${e.item.name}`} onclick={() => void dl.delete(e.id)} />
  </li>
{/snippet}

<div class="dl">
  <header>
    <div>
      <h1>Downloads</h1>
      {#if dl.sortedEntries.length > 0}
        <p class="total">{trackCount(dl.sortedEntries.length)} · {formatBytes(dl.totalBytes)}</p>
      {/if}
    </div>
    <div class="hactions">
      {#if router}
        <button type="button" class="btn" onclick={() => router.go('settings')}>Download settings</button>
      {/if}
      {#if flat.length > 0}
        <Button icon="play" primary onclick={() => play(flat)}>Play all</Button>
      {/if}
    </div>
  </header>

  {#if !dl.loaded}
    <div class="loading" aria-busy="true">
      {#each [0, 1, 2, 3] as i (i)}
        <Skeleton height="52px" radius="var(--radius-md)" />
      {/each}
    </div>
  {:else if isEmpty}
    <div class="empty">
      <Icon name="download" size={36} />
      <p class="title">No downloads yet.</p>
      <p class="hint">Use the download buttons on albums, playlists and tracks to keep music for offline listening.</p>
    </div>
  {/if}

  {#if keptRows.length > 0}
    <section>
      <div class="head">
        <h2>Kept offline</h2>
        {#if kept.syncing}<span class="sub">Syncing…</span>{/if}
      </div>
      <ul>
        {#each keptRows as r (r.c.item.id)}
          <li class="item active">
            <Artwork item={r.c.item} size={40} />
            <div class="info">
              <span class="name">{r.c.item.name}</span>
              <span class="sub">
                {r.c.item.type === 'Playlist' ? 'Playlist' : 'Album'} · {r.total === 0 ? 'Not synced yet' : `${r.have}/${r.total} tracks`}
              </span>
              {#if r.total > 0 && r.have < r.total}
                <progress aria-label={`Syncing ${r.c.item.name}`} value={r.have} max={r.total}></progress>
              {/if}
            </div>
            <button
              type="button"
              class="btn"
              aria-label={`Stop keeping ${r.c.item.name} offline`}
              onclick={() => {
                void kept.setKept(r.c.item, false);
                ui?.toast(`${r.c.item.name} is no longer kept offline`);
              }}>Remove</button
            >
          </li>
        {/each}
      </ul>
    </section>
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
          <li class="item active">
            <Artwork item={a.item} size={40} />
            <div class="info">
              <span class="name">{a.item.name}</span>
              <span class="sub">
                {#if !a.started}{dl.waitingForWifi ? 'Waiting for Wi-Fi' : 'Waiting…'}{:else if frac === null}{formatBytes(a.receivedBytes)}{:else}{Math.round(frac * 100)}% · {formatBytes(a.receivedBytes)} of {formatBytes(a.totalBytes)}{/if}
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
      <div class="head">
        <h2>Failed</h2>
        <button type="button" class="btn" onclick={() => void dl.retryAll()}>Retry all</button>
      </div>
      <ul>
        {#each failures as f (f.item.id)}
          <li class="item">
            <div class="info">
              <span class="name">{f.item.name}</span>
              <span class="sub error">{f.reason}</span>
            </div>
            <button type="button" class="btn" aria-label={`Retry ${f.item.name}`} onclick={() => void dl.retry(f.item.id)}>Retry</button>
            <IconButton icon="close" size={16} label={`Dismiss ${f.item.name}`} onclick={() => dl.dismiss(f.item.id)} />
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
            <span>Remove all {dl.sortedEntries.length} downloads?</span>
            <button
              type="button"
              class="btn danger"
              onclick={() => {
                confirming = false;
                void dl.deleteAll();
              }}>Remove</button
            >
            <button type="button" class="btn" onclick={() => (confirming = false)}>Keep</button>
          </span>
        {:else}
          <button type="button" class="btn danger" onclick={() => (confirming = true)}>Remove all</button>
        {/if}
      </div>

      <div class="tools">
        <label class="search">
          <Icon name="search" size={16} />
          <input type="search" bind:value={query} placeholder="Filter downloads" aria-label="Filter downloads" autocomplete="off" />
        </label>
        <label class="sort">
          <span class="sr-only">Sort by</span>
          <select bind:value={sort} aria-label="Sort downloads">
            <option value="recent">Recently added</option>
            <option value="name">Name</option>
            <option value="artist">Artist</option>
          </select>
        </label>
        <label class="grp">
          <input type="checkbox" role="switch" bind:checked={grouped} />
          <span>Group by album</span>
        </label>
      </div>

      {#if flat.length === 0}
        <p class="none">Nothing matches “{query}”.</p>
      {:else if grouped}
        {#each groups as g (g.key)}
          <div class="group">
            <div class="ghead">
              <Artwork item={g.entries[0]!.item} size={56} />
              <div class="ginfo">
                <h3>{g.album}</h3>
                <span class="sub">{[g.artist, trackCount(g.entries.length), formatBytes(g.bytes)].filter(Boolean).join(' · ')}</span>
              </div>
              <IconButton icon="play" label={`Play ${g.album}`} onclick={() => play(g.entries)} />
              <IconButton icon="trash" label={`Remove ${g.album}`} onclick={() => g.entries.forEach((e) => void dl.delete(e.id))} />
            </div>
            <ul>
              {#each g.entries as e (e.id)}{@render row(e, false)}{/each}
            </ul>
          </div>
        {/each}
      {:else}
        <ul>
          {#each flat as e (e.id)}{@render row(e, true)}{/each}
        </ul>
      {/if}
    </section>
  {/if}
</div>

<style>
  .dl { height: 100%; overflow-y: auto; padding: var(--space-5) var(--gutter) var(--space-7); max-width: 900px; margin: 0 auto; animation: fade-in var(--duration) var(--ease-out); }
  header { display: flex; align-items: center; justify-content: space-between; gap: var(--space-4); margin-bottom: var(--space-5); }
  h1 { font-size: var(--text-xl); margin: 0; font-weight: var(--weight-semibold); }
  h2 { font-size: var(--text-sm); text-transform: uppercase; letter-spacing: 0.08em; color: var(--text-muted); margin: 0; font-weight: var(--weight-semibold); }
  h3 { margin: 0; font-size: var(--text-md); font-weight: var(--weight-semibold); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .hactions { display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap; justify-content: flex-end; }
  .total { color: var(--text-muted); margin: var(--space-1) 0 0; font-size: var(--text-sm); }
  .loading { display: flex; flex-direction: column; gap: var(--space-2); }
  .empty { display: flex; flex-direction: column; align-items: center; gap: var(--space-2); padding: var(--space-7) var(--space-4); color: var(--text-faint); text-align: center; }
  .empty .title { margin: var(--space-2) 0 0; font-size: var(--text-lg); color: var(--text); font-weight: var(--weight-medium); }
  .empty .hint { margin: 0; max-width: 340px; font-size: var(--text-sm); color: var(--text-muted); }
  section { margin-bottom: var(--space-6); }
  .head { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); margin-bottom: var(--space-3); min-height: 32px; }
  .tools { display: flex; align-items: center; gap: var(--space-3); flex-wrap: wrap; margin-bottom: var(--space-4); }
  .search { flex: 1; min-width: 180px; display: flex; align-items: center; gap: var(--space-2); padding: 0 var(--space-3); background: var(--surface-2); border: 1px solid var(--border); border-radius: var(--radius-full); color: var(--text-muted); }
  .search:focus-within { border-color: var(--accent); }
  .search input { flex: 1; min-width: 0; padding: var(--space-2) 0; background: none; border: 0; outline: none; color: var(--text); }
  select { padding: var(--space-2) var(--space-3); background: var(--surface-2); border: 1px solid var(--border); border-radius: var(--radius-full); cursor: pointer; }
  .grp { display: inline-flex; align-items: center; gap: var(--space-2); font-size: var(--text-sm); color: var(--text-muted); cursor: pointer; }
  .grp input { accent-color: var(--accent); }
  .none { color: var(--text-muted); font-size: var(--text-sm); text-align: center; padding: var(--space-5) 0; }
  ul { list-style: none; margin: 0; padding: 0; }
  .group { margin-bottom: var(--space-5); }
  .ghead { display: flex; align-items: center; gap: var(--space-3); margin-bottom: var(--space-2); }
  .ginfo { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
  .item { display: flex; align-items: center; gap: var(--space-2); min-height: var(--row-height); border-radius: var(--radius-md); }
  .item.active { padding: var(--space-2) var(--space-2); gap: var(--space-3); background: var(--surface); border: 1px solid var(--border); margin-bottom: var(--space-2); border-radius: var(--radius-lg); }
  .main { flex: 1; min-width: 0; display: flex; align-items: center; gap: var(--space-3); padding: var(--space-1) var(--space-3); border: 0; border-radius: var(--radius-md); background: none; text-align: left; cursor: pointer; min-height: var(--row-height); transition: background var(--duration-fast); }
  .main:hover { background: var(--hover); }
  .play { width: 24px; display: grid; place-items: center; color: var(--text-faint); }
  .main:hover .play, .main:focus-visible .play { color: var(--accent); }
  .info { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
  .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .sub { font-size: var(--text-xs); color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .sub.error { color: var(--danger); white-space: normal; }
  .size { font-size: var(--text-xs); color: var(--text-muted); font-variant-numeric: tabular-nums; flex: none; }
  progress { width: 100%; height: 4px; accent-color: var(--accent); margin-top: var(--space-1); }
  .confirm { display: flex; align-items: center; gap: var(--space-2); font-size: var(--text-sm); }
  .btn { background: var(--surface-2); border: 1px solid var(--border); border-radius: var(--radius-full); padding: var(--space-1) var(--space-4); cursor: pointer; flex: none; font-size: var(--text-sm); transition: background var(--transition), border-color var(--transition); }
  .btn:hover { background: var(--surface-3); border-color: var(--border-strong); }
  .btn.danger { color: var(--danger); }
</style>
