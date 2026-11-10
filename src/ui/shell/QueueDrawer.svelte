<script lang="ts">
  import IconButton from '../common/IconButton.svelte';
  import QueuePanel from '../now-playing/QueuePanel.svelte';
  import { getUi } from './router.svelte';

  const ui = getUi();
</script>

<aside class="drawer" aria-label="Queue">
  <header>
    <h2>Queue</h2>
    <IconButton icon="close" label="Close queue" onclick={() => (ui.queueOpen = false)} />
  </header>
  <div class="body"><QueuePanel /></div>
</aside>

<style>
  .drawer {
    display: flex;
    flex-direction: column;
    flex: none;
    width: 360px;
    background: var(--bg-elevated);
    border-left: 1px solid var(--border);
    animation: slide-in-right var(--duration) var(--ease-out);
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    height: var(--topbar-height);
    padding: 0 var(--space-3) 0 var(--space-4);
    border-bottom: 1px solid var(--border);
  }
  h2 {
    margin: 0;
    font-size: var(--text-md);
    font-weight: var(--weight-semibold);
  }
  .body {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: var(--space-2);
  }
  @media (max-width: 900px) {
    .drawer {
      position: absolute;
      top: 0;
      right: 0;
      bottom: 0;
      z-index: var(--z-drawer);
      box-shadow: var(--shadow-3);
    }
  }
</style>
