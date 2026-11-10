<script lang="ts">
  import { getApp } from '../../lib/app.svelte';
  import Icon from './Icon.svelte';

  const app = getApp();
  const path = $derived(app.core.player.signalPath);
</script>

{#if path?.bitPerfect}
  <span class="badge" title="Bit-perfect output: no processing between the file and the DAC">
    <Icon name="check" size={12} />Bit-perfect
  </span>
{/if}

<style>
  .badge {
    display: inline-flex;
    align-items: center;
    gap: var(--space-1);
    padding: 3px var(--space-3) 3px var(--space-2);
    border: 1px solid color-mix(in srgb, var(--accent) 55%, transparent);
    border-radius: 999px;
    background: var(--accent-soft);
    color: var(--accent);
    font-size: var(--text-xs);
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    white-space: nowrap;
  }
</style>
