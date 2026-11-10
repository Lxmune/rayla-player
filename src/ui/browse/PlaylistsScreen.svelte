<script lang="ts">
  import { getApp } from '../../lib/app.svelte';
  import Button from '../common/Button.svelte';
  import PagedGrid from '../common/PagedGrid.svelte';
  import ScreenHeader from '../common/ScreenHeader.svelte';
  import { useActions } from '../common/actions';
  import { plural } from '../common/format';
  import { Pager } from '../common/resource.svelte';
  import { getRouter } from '../shell/router.svelte';

  const app = getApp();
  const router = getRouter();
  const actions = useActions();
  let reloads = $state(0);
  let creating = $state(false);
  let name = $state('');
  let busy = $state(false);

  const pager = $derived.by(() => {
    void reloads;
    return new Pager(async (startIndex) => {
      const client = app.core.sessions.client;
      if (!client) throw new Error('Not signed in');
      return client.playlists({ startIndex, limit: 60 });
    });
  });

  function focus(node: HTMLElement) {
    node.focus();
  }

  async function create() {
    const trimmed = name.trim();
    if (!trimmed || busy) return;
    busy = true;
    const id = await actions.createPlaylist(trimmed);
    busy = false;
    if (id !== undefined) {
      name = '';
      creating = false;
      reloads++;
    }
  }
</script>

<section class="screen">
  <ScreenHeader title="Playlists" subtitle={pager.total > 0 ? plural(pager.total, 'playlist') : undefined}>
    <Button icon="filter" onclick={() => router.go('smart')}>Smart playlists</Button>
    <Button icon="plus" primary onclick={() => (creating = !creating)}>New playlist</Button>
  </ScreenHeader>
  {#if creating}
    <form
      class="create"
      onsubmit={(e) => {
        e.preventDefault();
        void create();
      }}
    >
      <input
        type="text"
        aria-label="Playlist name"
        placeholder="Playlist name"
        bind:value={name}
        autocomplete="off"
        use:focus
      />
      <Button primary disabled={name.trim() === '' || busy} onclick={() => void create()}>Create</Button>
      <Button onclick={() => (creating = false)}>Cancel</Button>
    </form>
  {/if}
  <PagedGrid {pager} onopen={(i) => router.open(i)} empty="No playlists." />
</section>

<style>
  .create {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    margin-bottom: var(--space-5);
    max-width: 520px;
    animation: rise-in var(--duration) var(--ease-out);
  }
  input {
    flex: 1;
    min-width: 0;
    height: 36px;
    padding: 0 var(--space-4);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-full);
    background: var(--surface-2);
    color: var(--text);
    font: inherit;
  }
  input:focus-visible {
    border-color: var(--accent);
  }
</style>
