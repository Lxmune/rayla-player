<script lang="ts">
  import { onDestroy, untrack } from 'svelte';
  import { getApp } from '../../lib/app.svelte';
  import { activeLyricIndex, type BaseItem, type Lyrics } from '../../lib/jellyfin/models';
  import Icon from '../common/Icon.svelte';
  import Skeleton from '../common/Skeleton.svelte';
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

  const FOLLOW_PAUSE_MS = 4000;

  const app = getApp();
  const res = new Resource<Lyrics | null>();
  let list: HTMLElement | undefined = $state();
  /** True while the user scrolled by hand and auto-follow is paused. */
  let manual = $state(false);
  let resumeTimer: ReturnType<typeof setTimeout> | null = null;

  $effect(() => {
    const client = app.core.sessions.client;
    const id = item.id;
    if (!client) return;
    untrack(() => void res.load(() => client.lyrics(id)));
  });

  const lyrics = $derived(res.data);
  const synced = $derived(lyrics !== null && lyrics !== undefined && lyrics.isSynced);
  const active = $derived(synced && lyrics ? activeLyricIndex(lyrics.lines, positionMs) : -1);

  function centre(i: number, smooth = true) {
    const el = list?.querySelector<HTMLElement>(`[data-line="${i}"]`);
    if (!list || !el) return;
    const top = el.offsetTop - list.clientHeight / 2 + el.clientHeight / 2;
    try {
      list.scrollTo?.({ top: Math.max(0, top), behavior: smooth ? 'smooth' : 'auto' });
    } catch {
      // scrolling unsupported (tests)
    }
  }

  // Keep the active line centred as playback advances, unless the user is browsing.
  $effect(() => {
    const i = active;
    if (i < 0 || manual) return;
    untrack(() => centre(i));
  });

  /** A wheel / touch / key scroll by the user pauses auto-follow for a moment. */
  function userScrolled() {
    if (!synced) return;
    manual = true;
    if (resumeTimer) clearTimeout(resumeTimer);
    resumeTimer = setTimeout(follow, FOLLOW_PAUSE_MS);
  }

  function follow() {
    if (resumeTimer) clearTimeout(resumeTimer);
    resumeTimer = null;
    manual = false;
  }

  onDestroy(() => {
    if (resumeTimer) clearTimeout(resumeTimer);
  });
</script>

<div class="wrap">
  <div
    class="lyrics"
    bind:this={list}
    role="presentation"
    onwheel={userScrolled}
    ontouchmove={userScrolled}
    onkeydown={(e) => {
      if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown'].includes(e.key)) userScrolled();
    }}
  >
    {#if res.loading && !lyrics}
      <div class="skeletons" aria-label="Loading lyrics" role="status">
        {#each [80, 60, 90, 70, 50] as w, i (i)}
          <Skeleton width="{w}%" height="28px" radius="var(--radius-md)" />
        {/each}
      </div>
    {:else if res.error}
      <p class="empty" role="alert">{res.error}</p>
    {:else if !lyrics}
      <div class="empty">
        <Icon name="lyrics" size={36} />
        <p>No lyrics for this track.</p>
      </div>
    {:else if synced}
      <ol>
        {#each lyrics.lines as line, i (i)}
          <li>
            <button
              type="button"
              class="line"
              class:active={i === active}
              class:past={i < active}
              class:far={active >= 0 && Math.abs(i - active) > 2}
              data-line={i}
              aria-current={i === active ? 'true' : undefined}
              disabled={line.startMs === null || !onseek}
              onclick={() => {
                follow();
                if (line.startMs !== null) onseek?.(line.startMs);
              }}
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
  {#if manual && active >= 0}
    <button
      type="button"
      class="back"
      onclick={() => {
        follow();
        centre(active);
      }}>Back to current line</button
    >
  {/if}
</div>

<style>
  .wrap {
    position: relative;
    height: 100%;
    min-height: 0;
  }
  .lyrics {
    position: relative;
    height: 100%;
    overflow-y: auto;
    padding: var(--space-5) var(--space-5);
    scrollbar-width: none;
    mask-image: linear-gradient(to bottom, transparent 0, #000 12%, #000 88%, transparent 100%);
  }
  .lyrics::-webkit-scrollbar {
    display: none;
  }
  ol {
    list-style: none;
    margin: 0;
    padding: 20vh 0 40vh;
  }
  .line {
    display: block;
    width: 100%;
    padding: var(--space-2) 0;
    border: 0;
    background: transparent;
    text-align: left;
    font-family: var(--font-display);
    font-size: clamp(var(--text-xl), 3vw, var(--text-2xl));
    font-weight: 750;
    letter-spacing: -0.01em;
    line-height: 1.25;
    color: var(--text);
    opacity: 0.35;
    transform-origin: left center;
    transition:
      opacity var(--duration-slow) var(--ease-out),
      transform var(--duration-slow) var(--ease-out),
      filter var(--duration-slow) var(--ease-out);
    cursor: pointer;
  }
  .line.far {
    filter: blur(1px);
  }
  .line:hover:not(:disabled) {
    opacity: 0.7;
    filter: none;
  }
  .line:disabled {
    cursor: default;
  }
  .line.active {
    opacity: 1;
    transform: scale(1.04);
    filter: none;
  }
  .plain {
    white-space: pre-wrap;
    font-size: var(--text-lg);
    line-height: 1.7;
    color: var(--text-muted);
    margin: 0;
  }
  .skeletons {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
    padding-top: var(--space-4);
  }
  .empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-6) var(--space-4);
    color: var(--text-muted);
    text-align: center;
  }
  .empty p {
    margin: 0;
  }
  .back {
    position: absolute;
    left: 50%;
    bottom: var(--space-4);
    transform: translateX(-50%);
    padding: var(--space-2) var(--space-4);
    border: 1px solid var(--glass-border);
    border-radius: 999px;
    background: var(--glass);
    backdrop-filter: blur(12px);
    color: var(--text);
    font-size: var(--text-sm);
    font-weight: 600;
    cursor: pointer;
    animation: rise-in var(--duration) var(--ease-out);
  }
  @media (prefers-reduced-motion: reduce) {
    .line {
      transition: none;
    }
  }
</style>
