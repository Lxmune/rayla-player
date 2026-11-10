<script lang="ts">
  import { getApp } from '../../lib/app.svelte';
  import { profileHost } from '../../lib/jellyfin/session.svelte';
  import { useActions } from '../common/actions';
  import IconButton from '../common/IconButton.svelte';
  import Avatar from './Avatar.svelte';

  let { onchange }: { onchange?: () => void } = $props();

  const app = getApp();
  const actions = useActions();
  const sessions = app.core.sessions;
</script>

{#if sessions.profiles.length > 0}
  <ul class="profiles" aria-label="Saved servers">
    {#each sessions.profiles as p (p.id)}
      {@const active = p.id === sessions.activeId && p.token !== null}
      {@const usable = p.token !== null}
      <li class:active>
        {#if usable && !active}
          <button
            type="button"
            class="card"
            aria-label={`Switch to ${p.userName} on ${profileHost(p)}`}
            onclick={() => void actions.guard(() => sessions.switchTo(p.id)).then(() => onchange?.())}
          >
            <Avatar name={p.userName} />
            <span class="who">
              <strong>{p.userName}</strong>
              <span class="host">{profileHost(p)}</span>
            </span>
            <span class="action">Switch</span>
          </button>
        {:else}
          <div class="card static">
            <Avatar name={p.userName} />
            <span class="who">
              <strong>{p.userName}</strong>
              <span class="host">{profileHost(p)}{usable ? '' : ' (signed out)'}</span>
            </span>
            {#if active}<span class="badge">Active</span>{/if}
          </div>
        {/if}
        <IconButton
          icon="trash"
          size={16}
          label={`Remove ${p.userName} on ${profileHost(p)}`}
          onclick={() => void actions.guard(() => sessions.remove(p.id))}
        />
      </li>
    {/each}
  </ul>
{/if}

<style>
  .profiles { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--space-2); }
  li {
    display: flex;
    align-items: center;
    gap: var(--space-1);
    padding-right: var(--space-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    background: var(--surface);
    transition: border-color var(--transition), background var(--transition);
  }
  li:hover { background: var(--surface-2); }
  li.active { border-color: var(--accent); background: var(--accent-soft); }
  .card {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-3);
    border: 0;
    border-radius: var(--radius-lg);
    background: none;
    text-align: left;
    cursor: pointer;
  }
  .card.static { cursor: default; }
  .who { flex: 1; min-width: 0; display: flex; flex-direction: column; }
  .host { color: var(--text-muted); font-size: var(--text-sm); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .action { font-size: var(--text-xs); color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.06em; }
  .card:hover .action { color: var(--accent); }
  .badge { color: var(--accent); font-size: var(--text-xs); text-transform: uppercase; letter-spacing: 0.06em; font-weight: var(--weight-semibold); }
</style>
