<script lang="ts">
  import { tick } from 'svelte';
  import { getApp } from '../../lib/app.svelte';
  import { artistLine, itemDurationMs } from '../../lib/jellyfin/models';
  import Artwork from '../common/Artwork.svelte';
  import Icon from '../common/Icon.svelte';
  import IconButton from '../common/IconButton.svelte';
  import TrackState from '../common/TrackState.svelte';
  import { useActions } from '../common/actions';
  import { formatTime } from '../common/format';
  import { useItemMenu } from '../common/item-menu';
  import { getUi } from '../shell/router.svelte';

  const app = getApp();
  const ui = getUi();
  const actions = useActions();
  const menuFor = useItemMenu();
  const player = app.core.player;

  let historyOpen = $state(false);
  let saving = $state(false);
  let playlistName = $state('');
  let dragFrom = $state<number | null>(null);
  /** Slot the dragged row would be dropped into (0..queue.length). */
  let dropSlot = $state<number | null>(null);
  let list: HTMLElement | undefined = $state();

  const history = $derived(player.index > 0 ? player.queue.slice(0, player.index) : []);
  const upcoming = $derived(player.index >= 0 ? player.queue.slice(player.index + 1) : player.queue);
  const upcomingStart = $derived(player.index + 1);
  const remainingMs = $derived.by(() => {
    let ms = player.current ? Math.max(0, player.durationMs - player.positionMs) : 0;
    for (const e of upcoming) ms += itemDurationMs(e.item);
    return ms;
  });

  function move(from: number, to: number) {
    const uid = player.queue[from]?.uid;
    void actions.guard(() => player.reorder(from, to)).then(async () => {
      await tick();
      list?.querySelector<HTMLElement>(`[data-uid="${uid}"] .jump`)?.focus();
    });
  }

  function onrowkeydown(e: KeyboardEvent, i: number) {
    if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
    e.preventDefault();
    const to = i + (e.key === 'ArrowUp' ? -1 : 1);
    if (to >= 0 && to < player.queue.length) move(i, to);
  }

  function ondragover(e: DragEvent, i: number) {
    if (dragFrom === null) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    dropSlot = e.clientY < r.top + r.height / 2 ? i : i + 1;
  }

  function ondrop(e: DragEvent) {
    e.preventDefault();
    const from = dragFrom;
    const slot = dropSlot;
    dragFrom = dropSlot = null;
    if (from === null || slot === null) return;
    const to = from < slot ? slot - 1 : slot;
    if (to !== from) move(from, to);
  }

  async function savePlaylist(e: SubmitEvent) {
    e.preventDefault();
    const name = playlistName.trim();
    if (!name) return;
    await actions.createPlaylist(name, player.queue.map((q) => q.item));
    saving = false;
    playlistName = '';
  }

  const dur = (ms: number) => formatTime(ms);
  const total = $derived.by(() => {
    const m = Math.round(remainingMs / 60000);
    return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`;
  });
</script>

{#snippet row(i: number)}
  {@const entry = player.queue[i]}
  {#if entry}
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <li
      class="row"
      class:current={i === player.index}
      class:dragging={dragFrom === i}
      class:drop-before={dropSlot === i && dragFrom !== null}
      class:drop-after={dropSlot === i + 1 && i === player.queue.length - 1 && dragFrom !== null}
      data-uid={entry.uid}
      draggable="true"
      ondragstart={(e) => {
        dragFrom = i;
        if (e.dataTransfer) {
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', String(i));
        }
      }}
      ondragend={() => (dragFrom = dropSlot = null)}
      ondragover={(e) => ondragover(e, i)}
      ondrop={ondrop}
      oncontextmenu={(e) => ui.openMenu(e, menuFor(entry.item))}
      onkeydown={(e) => onrowkeydown(e, i)}
    >
      <span class="grip" aria-hidden="true" title="Drag to reorder">⋮⋮</span>
      <button
        type="button"
        class="jump"
        aria-label={`Play ${entry.item.name}`}
        aria-current={i === player.index ? 'true' : undefined}
        onclick={() => void actions.guard(() => player.jumpTo(i))}
      >
        <span class="art"><Artwork item={entry.item} size={44} fill /></span>
        <span class="text">
          <span class="title">{entry.item.name}</span>
          <span class="artist">{artistLine(entry.item)}</span>
        </span>
        <TrackState state={app.core.trackStates.get(entry.item.id)} detailed />
        <span class="dur">{dur(itemDurationMs(entry.item))}</span>
      </button>
      <span class="actions">
        <IconButton icon="up" label={`Move ${entry.item.name} up`} size={16} disabled={i === 0}
          onclick={() => move(i, i - 1)} />
        <IconButton icon="down" label={`Move ${entry.item.name} down`} size={16}
          disabled={i === player.queue.length - 1} onclick={() => move(i, i + 1)} />
        <IconButton icon="trash" label={`Remove ${entry.item.name} from queue`} size={16}
          onclick={() => void actions.guard(() => player.removeAt(i))} />
      </span>
    </li>
  {/if}
{/snippet}

{#if player.queue.length === 0}
  <div class="empty">
    <Icon name="queue" size={36} />
    <p>The queue is empty.</p>
  </div>
{:else}
  <div class="panel">
    <header>
      <p class="remaining">{total} remaining</p>
      <div class="head-actions">
        <button type="button" class="link" disabled={upcoming.length === 0}
          onclick={() => void actions.guard(() => player.removeUpcoming())}>Clear upcoming</button>
        <button type="button" class="link" onclick={() => (saving = !saving)}>Save as playlist</button>
      </div>
    </header>
    {#if player.radio}
      <p class="radio">
        <span>Radio · {player.radio.label}</span>
        <button type="button" class="link" onclick={() => player.stopRadio()}>Stop</button>
      </p>
    {/if}
    {#if saving}
      <form class="save" onsubmit={savePlaylist}>
        <input type="text" aria-label="Playlist name" placeholder="Playlist name" bind:value={playlistName} />
        <button type="submit" class="link strong" disabled={playlistName.trim() === ''}>Save</button>
        <button type="button" class="link" onclick={() => (saving = false)}>Cancel</button>
      </form>
    {/if}

    <ol class="queue" aria-label="Queue" bind:this={list}>
      {#if history.length > 0}
        <li class="heading" role="presentation">
          <button type="button" class="fold" aria-expanded={historyOpen} onclick={() => (historyOpen = !historyOpen)}>
            <Icon name={historyOpen ? 'chevronDown' : 'chevronRight'} size={14} />History ({history.length})
          </button>
        </li>
        {#if historyOpen}
          {#each history as entry, i (entry.uid)}
            {@render row(i)}
          {/each}
        {/if}
      {/if}
      {#if player.current}
        <li class="heading" role="presentation"><h3>Now playing</h3></li>
        {@render row(player.index)}
      {/if}
      {#if upcoming.length > 0}
        <li class="heading" role="presentation"><h3>Up next</h3></li>
        {#each upcoming as entry, k (entry.uid)}
          {@render row(upcomingStart + k)}
        {/each}
      {/if}
    </ol>
  </div>
{/if}

<style>
  .radio {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    margin: 0;
    padding: var(--space-2) var(--space-4);
    font-size: var(--text-sm);
    color: var(--text-muted);
  }
  .radio span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .panel {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  header {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-2);
    padding: var(--space-3) var(--space-4) var(--space-1);
  }
  .remaining {
    margin: 0;
    font-size: var(--text-sm);
    color: var(--text-muted);
  }
  .head-actions {
    display: flex;
    gap: var(--space-3);
  }
  .link {
    border: 0;
    background: transparent;
    padding: 2px 0;
    color: var(--text-muted);
    font-size: var(--text-sm);
    cursor: pointer;
  }
  .link:hover:not(:disabled) {
    color: var(--accent);
  }
  .link:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .link.strong {
    color: var(--accent);
    font-weight: 600;
  }
  .save {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-2) var(--space-4);
  }
  .save input {
    flex: 1;
    min-width: 0;
    padding: var(--space-1) var(--space-3);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface);
    color: var(--text);
  }
  .queue {
    list-style: none;
    margin: 0;
    padding: var(--space-1) var(--space-2) var(--space-4);
  }
  .heading {
    padding: var(--space-3) var(--space-2) var(--space-1);
  }
  h3 {
    margin: 0;
    font-size: var(--text-xs);
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--text-faint);
  }
  .fold {
    display: inline-flex;
    align-items: center;
    gap: var(--space-1);
    border: 0;
    background: transparent;
    padding: 0;
    color: var(--text-faint);
    font-size: var(--text-xs);
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    cursor: pointer;
  }
  .row {
    position: relative;
    display: flex;
    align-items: center;
    border-radius: var(--radius-md);
    transition: background var(--duration-fast) var(--ease-out);
  }
  .row:hover,
  .row:focus-within {
    background: var(--hover);
  }
  .row.dragging {
    opacity: 0.4;
  }
  .row.drop-before::before,
  .row.drop-after::after {
    content: '';
    position: absolute;
    left: var(--space-2);
    right: var(--space-2);
    height: 2px;
    border-radius: 1px;
    background: var(--accent);
  }
  .row.drop-before::before {
    top: -1px;
  }
  .row.drop-after::after {
    bottom: -1px;
  }
  .grip {
    flex: none;
    width: 14px;
    margin-left: var(--space-1);
    color: var(--text-faint);
    font-size: var(--text-xs);
    letter-spacing: -2px;
    cursor: grab;
    opacity: 0;
    user-select: none;
  }
  .row:hover .grip,
  .row:focus-within .grip {
    opacity: 1;
  }
  .jump {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-2) var(--space-2);
    border: 0;
    background: transparent;
    text-align: left;
    color: inherit;
    cursor: pointer;
    border-radius: var(--radius-md);
  }
  .art {
    flex: none;
    width: 44px;
    height: 44px;
    border-radius: var(--radius-sm);
    overflow: hidden;
  }
  .text {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
  }
  .title,
  .artist {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .artist {
    font-size: var(--text-sm);
    color: var(--text-muted);
  }
  .dur {
    flex: none;
    font-size: var(--text-xs);
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
  }
  .current .title {
    color: var(--accent);
    font-weight: 600;
  }
  .actions {
    flex: none;
    display: flex;
    max-width: 0;
    overflow: hidden;
    opacity: 0;
    transition: opacity var(--duration-fast) var(--ease-out);
  }
  .row:hover .actions,
  .row:focus-within .actions {
    max-width: 120px;
    opacity: 1;
    overflow: visible;
  }
  .actions :global(.icon-btn) {
    width: 28px;
    height: 28px;
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
</style>
