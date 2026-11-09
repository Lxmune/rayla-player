<script lang="ts">
  import { getApp } from '../../lib/app.svelte';
  import { artistLine } from '../../lib/jellyfin/models';
  import IconButton from '../common/IconButton.svelte';
  import { useActions } from '../common/actions';

  const app = getApp();
  const actions = useActions();
  const player = app.core.player;
</script>

{#if player.queue.length === 0}
  <p class="muted">The queue is empty.</p>
{:else}
  <ol class="queue" aria-label="Queue">
    {#each player.queue as entry, i (entry.uid)}
      <li class:current={i === player.index}>
        <button
          type="button"
          class="jump"
          aria-label={`Play ${entry.item.name}`}
          aria-current={i === player.index ? 'true' : undefined}
          onclick={() => void actions.guard(() => player.jumpTo(i))}
        >
          <span class="title">{entry.item.name}</span>
          <span class="artist">{artistLine(entry.item)}</span>
        </button>
        <IconButton icon="up" label={`Move ${entry.item.name} up`} size={16} disabled={i === 0}
          onclick={() => void actions.guard(() => player.reorder(i, i - 1))} />
        <IconButton icon="down" label={`Move ${entry.item.name} down`} size={16} disabled={i === player.queue.length - 1}
          onclick={() => void actions.guard(() => player.reorder(i, i + 1))} />
        <IconButton icon="trash" label={`Remove ${entry.item.name} from queue`} size={16}
          onclick={() => void actions.guard(() => player.removeAt(i))} />
      </li>
    {/each}
  </ol>
{/if}

<style>
  .queue {
    list-style: none;
    margin: 0;
    padding: var(--space-2);
  }
  li {
    display: flex;
    align-items: center;
    border-radius: var(--radius-sm);
  }
  li:hover,
  li:focus-within {
    background: var(--surface);
  }
  .jump {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    padding: var(--space-2) var(--space-3);
    border: 0;
    background: transparent;
    text-align: left;
    cursor: pointer;
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
  .current .title {
    color: var(--accent);
  }
  .muted {
    color: var(--text-muted);
    padding: var(--space-4);
  }
</style>
