<script lang="ts">
  import { untrack } from 'svelte';
  import { getApp } from '../../lib/app.svelte';
  import { activeLyricIndex, type BaseItem, type Lyrics } from '../../lib/jellyfin/models';
  import { Resource } from '../common/resource.svelte';

  let {
    item,
    positionMs,
    onseek,
  }: {
    item: BaseItem;
    positionMs: number;
    /** Called with a line's start when a synced line is clicked. */
    onseek?: (ms: number) => void;
  } = $props();

  const app = getApp();
  const res = new Resource<Lyrics | null>();
  let list: HTMLElement | undefined = $state();

  $effect(() => {
    const client = app.core.sessions.client;
    const id = item.id;
    if (!client) return;
    untrack(() => void res.load(() => client.lyrics(id)));
  });

  const lyrics = $derived(res.data);
  const synced = $derived(lyrics !== null && lyrics !== undefined && lyrics.isSynced);
  const active = $derived(synced && lyrics ? activeLyricIndex(lyrics.lines, positionMs) : -1);

  // Keep the active line centred as playback advances.
  $effect(() => {
    const i = active;
    if (i < 0 || !list) return;
    const el = list.querySelector<HTMLElement>(`[data-line="${i}"]`);
    el?.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
  });
</script>

<div class="lyrics" bind:this={list}>
  {#if res.loading && !lyrics}
    <p class="muted">Loading lyrics…</p>
  {:else if res.error}
    <p class="muted" role="alert">{res.error}</p>
  {:else if !lyrics}
    <p class="muted">No lyrics for this track.</p>
  {:else if synced}
    <ol>
      {#each lyrics.lines as line, i (i)}
        <li>
          <button
            type="button"
            class="line"
            class:active={i === active}
            class:past={i < active}
            data-line={i}
            aria-current={i === active ? 'true' : undefined}
            disabled={line.startMs === null || !onseek}
            onclick={() => line.startMs !== null && onseek?.(line.startMs)}
          >
            {line.text === '' ? '♪' : line.text}
          </button>
        </li>
      {/each}
    </ol>
  {:else}
    <p class="plain">{lyrics.lines.map((l) => l.text).join('\n')}</p>
  {/if}
</div>

<style>
  .lyrics {
    height: 100%;
    overflow-y: auto;
    padding: var(--space-5) var(--space-4);
  }
  ol {
    list-style: none;
    margin: 0;
    padding: 0 0 40vh;
  }
  .line {
    display: block;
    width: 100%;
    padding: var(--space-2) 0;
    border: 0;
    background: transparent;
    text-align: left;
    font-size: var(--text-xl);
    font-weight: 650;
    line-height: 1.25;
    color: var(--text-faint);
    cursor: pointer;
    transition: color var(--transition);
  }
  .line:disabled {
    cursor: default;
  }
  .line.past {
    color: var(--text-muted);
  }
  .line.active {
    color: var(--text);
  }
  .plain {
    white-space: pre-wrap;
    font-size: var(--text-lg);
    line-height: 1.6;
    color: var(--text-muted);
    margin: 0;
  }
  .muted {
    color: var(--text-muted);
  }
</style>
