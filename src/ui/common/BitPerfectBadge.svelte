<script lang="ts">
  import { getApp } from '../../lib/app.svelte';

  const app = getApp();
  const path = $derived(app.core.player.signalPath);
</script>

{#if path?.bitPerfect}
  <span class="badge" title="Bit-perfect output: no processing between the file and the DAC">Bit-perfect</span>
{/if}

<style>
  .badge {
    padding: 2px var(--space-2);
    border: 1px solid var(--accent);
    border-radius: 999px;
    color: var(--accent);
    font-size: var(--text-xs);
    letter-spacing: 0.04em;
    text-transform: uppercase;
    white-space: nowrap;
  }
</style>
