<script lang="ts">
  import { getApp } from '../../lib/app.svelte';
  import { profileHost } from '../../lib/jellyfin/session.svelte';
  import Button from '../common/Button.svelte';
  import { useActions } from '../common/actions';

  let { onchange }: { onchange?: () => void } = $props();

  const app = getApp();
  const actions = useActions();
  const sessions = app.core.sessions;
</script>

{#if sessions.profiles.length > 0}
  <ul class="profiles" aria-label="Saved servers">
    {#each sessions.profiles as p (p.id)}
      <li class:active={p.id === sessions.activeId}>
        <span class="who">
          <strong>{p.userName}</strong>
          <span class="host">{profileHost(p)}{p.token === null ? ' (signed out)' : ''}</span>
        </span>
        {#if p.id === sessions.activeId && p.token !== null}
          <span class="badge">Active</span>
        {:else if p.token !== null}
          <Button onclick={() => void actions.guard(() => sessions.switchTo(p.id)).then(() => onchange?.())}>
            Switch
          </Button>
        {/if}
        <Button onclick={() => void actions.guard(() => sessions.remove(p.id))}>Remove</Button>
      </li>
    {/each}
  </ul>
{/if}

<style>
  .profiles {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }
  li {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-2) var(--space-3);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
  }
  li.active {
    border-color: var(--accent);
  }
  .who {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
  }
  .host {
    color: var(--text-muted);
    font-size: var(--text-sm);
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .badge {
    color: var(--accent);
    font-size: var(--text-xs);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
</style>
