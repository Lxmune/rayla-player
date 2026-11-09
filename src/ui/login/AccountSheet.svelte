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
    <LoginForm onsuccess={onclose} />
  {:else}
    <div class="row">
      <Button icon="plus" onclick={() => (adding = true)}>Add another server</Button>
      <Button
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
  .stack {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
  }
  .row {
    display: flex;
    gap: var(--space-2);
    flex-wrap: wrap;
  }
</style>
