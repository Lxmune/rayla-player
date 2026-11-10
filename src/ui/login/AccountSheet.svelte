<script lang="ts">
  import { getApp } from '../../lib/app.svelte';
  import Button from '../common/Button.svelte';
  import { useActions } from '../common/actions';
  import LoginForm from './LoginForm.svelte';
  import ProfileList from './ProfileList.svelte';

  /** Sheet content: switch / remove servers, sign out, add another server. */
  let { onclose }: { onclose: () => void } = $props();

  const app = getApp();
  const actions = useActions();
  let adding = $state(false);
</script>

<div class="stack">
  <ProfileList onchange={onclose} />
  {#if adding}
    <div class="add">
      <h3>Add a server</h3>
      <LoginForm onsuccess={onclose} />
    </div>
  {:else}
    <div class="row">
      <Button icon="plus" onclick={() => (adding = true)}>Add another server</Button>
      <Button
        icon="logout"
        onclick={() => {
          onclose();
          void actions.guard(() => app.core.sessions.signOut());
        }}
      >
        Sign out
      </Button>
    </div>
  {/if}
</div>

<style>
  .stack { display: flex; flex-direction: column; gap: var(--space-4); }
  .row { display: flex; gap: var(--space-2); flex-wrap: wrap; }
  .add { padding: var(--space-4); border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--surface); }
  h3 { margin: 0 0 var(--space-3); font-size: var(--text-md); font-weight: var(--weight-semibold); }
</style>
