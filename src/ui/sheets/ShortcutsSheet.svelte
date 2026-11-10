<script lang="ts">
  import { SHORTCUTS } from '../shell/shortcuts';

  const mac = typeof navigator !== 'undefined' && /mac/i.test(navigator.platform);
  const cap = (k: string) => (k === 'Mod' ? (mac ? '⌘' : 'Ctrl') : k === 'Alt' && mac ? '⌥' : k);
</script>

<table class="keys">
  <caption class="sr-only">Keyboard shortcuts</caption>
  <tbody>
    {#each SHORTCUTS as s (s.action)}
      <tr>
        <th scope="row">{s.label}</th>
        <td>
          {#each s.keys as combo, i (i)}
            {#if i > 0}<span class="or">or</span>{/if}
            <span class="combo">
              {#each combo as k (k)}<kbd>{cap(k)}</kbd>{/each}
            </span>
          {/each}
        </td>
      </tr>
    {/each}
  </tbody>
</table>

<style>
  .keys {
    width: 100%;
    border-collapse: collapse;
  }
  tr + tr > * {
    border-top: 1px solid var(--border);
  }
  th {
    padding: var(--space-2) 0;
    font-weight: var(--weight-medium);
    text-align: left;
    font-size: var(--text-md);
  }
  td {
    padding: var(--space-2) 0;
    text-align: right;
    white-space: nowrap;
  }
  .combo {
    display: inline-flex;
    gap: var(--space-1);
  }
  .or {
    margin: 0 var(--space-2);
    color: var(--text-faint);
    font-size: var(--text-xs);
  }
  kbd {
    min-width: 24px;
    padding: 2px 7px;
    border: 1px solid var(--border-strong);
    border-bottom-width: 2px;
    border-radius: var(--radius-sm);
    background: var(--surface-2);
    color: var(--text);
    font: var(--text-xs) / 1.4 var(--font-mono);
    text-align: center;
  }
</style>
