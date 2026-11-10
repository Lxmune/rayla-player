<script lang="ts">
  import { untrack } from 'svelte';
  import { getApp } from '../../lib/app.svelte';
  import type { BaseItem } from '../../lib/jellyfin/models';
  import { evaluatePlaylist } from '../../lib/smart/evaluate';
  import { describePlaylist, SUGGESTIONS, type Suggestion, type SmartPlaylist } from '../../lib/smart/rules';
  import { loadPlaylists, newPlaylistId, savePlaylists, upsertPlaylist } from '../../lib/smart/store';
  import Artwork from '../common/Artwork.svelte';
  import Button from '../common/Button.svelte';
  import Icon from '../common/Icon.svelte';
  import IconButton from '../common/IconButton.svelte';
  import ScreenHeader from '../common/ScreenHeader.svelte';
  import TrackList from '../common/TrackList.svelte';
  import { useActions } from '../common/actions';
  import { plural } from '../common/format';
  import SmartEditor from '../smart/SmartEditor.svelte';

  const app = getApp();
  const act = useActions();
  const CACHE_MS = 5 * 60_000;

  const profileId = $derived(app.core.sessions.active?.id ?? null);
  let list = $state<SmartPlaylist[]>([]);
  let editing = $state<SmartPlaylist | null>(null);
  let openId = $state<string | null>(null);
  let genreNames = $state<string[]>([]);
  let loading = $state<Record<string, boolean>>({});
  let errors = $state<Record<string, string>>({});
  let results = $state.raw<Record<string, { at: number; sig: string; tracks: BaseItem[] }>>({});
  let saving = $state(false);

  const sig = (p: SmartPlaylist) => JSON.stringify([p.rules, p.mode, p.sort, p.limit]);
  const open = $derived(list.find((p) => p.id === openId) ?? null);
  const openTracks = $derived(open ? (results[open.id]?.tracks ?? []) : []);
  const unusedSuggestions = $derived(SUGGESTIONS.filter((s) => !list.some((p) => p.name === s.name)));

  $effect(() => {
    const id = profileId;
    untrack(() => {
      list = id ? loadPlaylists(app.kv, id) : [];
      results = {};
      openId = null;
    });
  });

  function persist(next: SmartPlaylist[]) {
    list = next;
    if (profileId) savePlaylists(app.kv, profileId, next);
  }

  async function ensureGenres() {
    const client = app.core.sessions.client;
    if (!client || genreNames.length > 0) return;
    try {
      genreNames = (await client.genres({ limit: 500 })).items.map((g) => g.name);
    } catch {
      // suggestions are optional
    }
  }

  async function evaluate(p: SmartPlaylist, force = false): Promise<BaseItem[]> {
    const cached = results[p.id];
    if (!force && cached && cached.sig === sig(p) && Date.now() - cached.at < CACHE_MS) return cached.tracks;
    const client = app.core.sessions.client;
    if (!client) return [];
    loading = { ...loading, [p.id]: true };
    const { [p.id]: _drop, ...rest } = errors;
    errors = rest;
    try {
      const tracks = await evaluatePlaylist(p, { client });
      results = { ...results, [p.id]: { at: Date.now(), sig: sig(p), tracks } };
      return tracks;
    } catch (e) {
      errors = { ...errors, [p.id]: e instanceof Error ? e.message : 'Could not evaluate' };
      return [];
    } finally {
      loading = { ...loading, [p.id]: false };
    }
  }

  async function play(p: SmartPlaylist, shuffle: boolean) {
    const tracks = await evaluate(p);
    if (tracks.length > 0) await act.playTracks(tracks, 0, shuffle);
  }

  async function show(p: SmartPlaylist) {
    openId = p.id;
    await evaluate(p);
  }

  async function snapshot(p: SmartPlaylist) {
    if (saving) return;
    saving = true;
    const tracks = await evaluate(p);
    if (tracks.length > 0) await act.createPlaylist(p.name, tracks);
    saving = false;
  }

  function addSuggestion(s: Suggestion) {
    persist([...list, { ...s.playlist, rules: s.playlist.rules.map((r) => ({ ...r })), id: newPlaylistId(), createdAt: Date.now() }]);
  }

  function create() {
    void ensureGenres();
    editing = { id: newPlaylistId(), name: '', mode: 'all', rules: [], sort: 'random', limit: 50, createdAt: Date.now() };
  }

  function edit(p: SmartPlaylist) {
    void ensureGenres();
    editing = p;
  }

  function save(p: SmartPlaylist) {
    persist(upsertPlaylist(list, p));
    editing = null;
    if (openId === p.id) void evaluate(p);
  }

  function remove(p: SmartPlaylist) {
    persist(list.filter((x) => x.id !== p.id));
    const { [p.id]: _drop, ...rest } = results;
    results = rest;
    if (openId === p.id) openId = null;
  }
</script>

<section class="screen">
  {#if open}
    <ScreenHeader
      title={open.name}
      subtitle={loading[open.id] ? 'Evaluating…' : plural(openTracks.length, 'track')}
    >
      <IconButton icon="close" label="Back to smart playlists" onclick={() => (openId = null)} />
    </ScreenHeader>
    <p class="rules">{describePlaylist(open)}</p>
    <div class="toolbar">
      <Button icon="play" primary disabled={openTracks.length === 0} onclick={() => void play(open, false)}>Play</Button>
      <Button icon="shuffle" disabled={openTracks.length === 0} onclick={() => void play(open, true)}>Shuffle</Button>
      <IconButton icon="refresh" label="Refresh" disabled={loading[open.id]} onclick={() => void evaluate(open, true)} />
      <Button icon="playlistAdd" disabled={openTracks.length === 0 || saving} onclick={() => void snapshot(open)}>
        Save as Jellyfin playlist
      </Button>
      <IconButton icon="edit" label="Edit rules" onclick={() => edit(open)} />
    </div>
    {#if errors[open.id]}
      <p class="error" role="alert">{errors[open.id]}</p>
    {:else if openTracks.length === 0 && !loading[open.id]}
      <p class="muted">No tracks match these rules.</p>
    {:else}
      <TrackList tracks={openTracks} numbered={false} showAlbum onplay={(i) => void act.playTracks(openTracks, i)} />
    {/if}
  {:else}
    <ScreenHeader title="Smart playlists" subtitle={list.length > 0 ? plural(list.length, 'playlist') : undefined}>
      <Button icon="plus" primary onclick={create}>New smart playlist</Button>
    </ScreenHeader>

    {#if list.length === 0}
      <p class="muted">Rule-based playlists that refill themselves. Start from a suggestion or create your own.</p>
    {/if}

    <ul class="cards">
      {#each list as p (p.id)}
        {@const res = results[p.id]}
        <li class="card">
          <button type="button" class="main" onclick={() => void show(p)}>
            <span class="art" aria-hidden="true">
              {#if res && res.tracks.length > 0}
                <span class="mosaic">
                  {#each res.tracks.slice(0, 4) as t (t.id)}<Artwork item={t} size={64} fill />{/each}
                </span>
              {:else}
                <Icon name="filter" size={28} />
              {/if}
            </span>
            <span class="text">
              <span class="name">{p.name}</span>
              <span class="sum">{describePlaylist(p)}</span>
              <span class="count">
                {#if loading[p.id]}Evaluating…{:else if errors[p.id]}{errors[p.id]}{:else if res}{plural(res.tracks.length, 'track')}{:else}Not evaluated yet{/if}
              </span>
            </span>
          </button>
          <div class="acts">
            <IconButton icon="play" label="Play {p.name}" onclick={() => void play(p, false)} />
            <IconButton icon="shuffle" label="Shuffle {p.name}" onclick={() => void play(p, true)} />
            <IconButton icon="edit" label="Edit {p.name}" onclick={() => edit(p)} />
            <IconButton icon="trash" label="Delete {p.name}" onclick={() => remove(p)} />
          </div>
        </li>
      {/each}
    </ul>

    {#if unusedSuggestions.length > 0}
      <h2>Suggestions</h2>
      <ul class="chips">
        {#each unusedSuggestions as s (s.id)}
          <li><button type="button" class="chip" onclick={() => addSuggestion(s)}>+ {s.name}</button></li>
        {/each}
      </ul>
    {/if}
  {/if}
</section>

{#if editing}
  <SmartEditor playlist={editing} genres={genreNames} onsave={save} onclose={() => (editing = null)} />
{/if}

<style>
  h2 {
    margin: var(--space-6) 0 var(--space-3);
    font-size: var(--text-lg);
    font-weight: var(--weight-semibold);
  }
  .muted,
  .rules {
    color: var(--text-muted);
  }
  .rules {
    margin: 0 0 var(--space-3);
    font-size: var(--text-sm);
  }
  .error {
    color: var(--danger);
  }
  .toolbar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-2);
    margin-bottom: var(--space-4);
  }
  .cards {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
    gap: var(--space-3);
    list-style: none;
    margin: 0;
    padding: 0;
  }
  @media (max-width: 640px) {
    .cards {
      grid-template-columns: 1fr;
    }
  }
  .card {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding: var(--space-3);
    border-radius: var(--radius-lg);
    background: var(--surface);
  }
  .main {
    display: flex;
    gap: var(--space-3);
    align-items: center;
    padding: 0;
    border: 0;
    background: none;
    color: inherit;
    text-align: left;
    cursor: pointer;
    min-width: 0;
  }
  .main:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
  .art {
    flex: none;
    display: grid;
    place-items: center;
    width: 72px;
    height: 72px;
    border-radius: var(--radius-md);
    background: var(--surface-2);
    color: var(--text-muted);
    overflow: hidden;
  }
  .mosaic {
    display: grid;
    grid-template-columns: 1fr 1fr;
    width: 100%;
    height: 100%;
  }
  .text {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }
  .name {
    font-weight: var(--weight-semibold);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .sum,
  .count {
    color: var(--text-muted);
    font-size: var(--text-sm);
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .count {
    -webkit-line-clamp: 1;
    line-clamp: 1;
  }
  .acts {
    display: flex;
    gap: var(--space-1);
    justify-content: flex-end;
  }
  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .chip {
    padding: var(--space-2) var(--space-3);
    border: 1px solid var(--border);
    border-radius: var(--radius-full);
    background: transparent;
    color: var(--text-muted);
    font-size: var(--text-sm);
    cursor: pointer;
  }
  .chip:hover {
    background: var(--hover);
    color: var(--text);
  }
</style>
