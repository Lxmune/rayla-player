<script lang="ts">
  import { getContext } from 'svelte';
  import { getApp } from '../../lib/app.svelte';
  import { techInfoRows, type BaseItem } from '../../lib/jellyfin/models';
  import Icon from '../common/Icon.svelte';
  import { UI_KEY, type UiState } from '../shell/router.svelte';

  let { item }: { item: BaseItem } = $props();

  const core = getApp().core;
  const ui = getContext<UiState | undefined>(UI_KEY);
  const isCurrent = $derived(core.player.current?.id === item.id);
  const path = $derived(isCurrent ? core.player.signalPath : null);
  const rows = $derived([
    ...techInfoRows(item, {
      path,
      maxBitrate: core.player.effectiveMaxBitrate,
      codec: core.settings.current.streaming.codec,
      downloaded: core.downloads.pathFor(item.id) !== null,
    }),
    ['Item ID', item.id] as [string, string],
  ]);
  const COPYABLE = new Set(['Path', 'Item ID']);
  let copied = $state<string | null>(null);

  async function copy(label: string, value: string) {
    try {
      await navigator.clipboard.writeText(value);
      copied = label;
      ui?.toast(`${label} copied`);
      setTimeout(() => (copied = null), 1500);
    } catch {
      ui?.toast('Could not copy to the clipboard');
    }
  }
</script>

<div class="ti">
  <p class="name">{item.name}</p>
  {#if path?.bitPerfect}<p class="badge">Bit-perfect</p>{/if}
  <table>
    <tbody>
      {#each rows as [label, value] (label)}
        <tr>
          <th scope="row">{label}</th>
          <td>
            {value}
            {#if COPYABLE.has(label)}
              <button type="button" class="copy" aria-label={`Copy ${label}`} title={`Copy ${label}`}
                onclick={() => void copy(label, value)}>
                <Icon name={copied === label ? 'check' : 'external'} size={14} />
              </button>
            {/if}
          </td>
        </tr>
      {/each}
    </tbody>
  </table>
</div>

<style>
  .ti {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }
  .name {
    margin: 0;
    font-family: var(--font-display);
    font-size: var(--text-lg);
    font-weight: 700;
  }
  .badge {
    align-self: flex-start;
    margin: 0;
    padding: 2px var(--space-3);
    border-radius: 999px;
    border: 1px solid var(--accent);
    background: var(--accent-soft);
    color: var(--accent);
    font-size: var(--text-xs);
    font-weight: 600;
  }
  table {
    border-collapse: collapse;
    width: 100%;
    border-radius: var(--radius-md);
    background: var(--surface-2);
  }
  th {
    text-align: left;
    font-weight: 500;
    color: var(--text-muted);
    padding: var(--space-2) var(--space-4);
    vertical-align: top;
    white-space: nowrap;
    font-size: var(--text-sm);
    width: 1%;
  }
  td {
    padding: var(--space-2) var(--space-4) var(--space-2) 0;
    font-size: var(--text-sm);
    overflow-wrap: anywhere;
  }
  tr + tr {
    border-top: 1px solid var(--border);
  }
  .copy {
    display: inline-flex;
    vertical-align: middle;
    margin-left: var(--space-1);
    padding: 2px;
    border: 0;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--text-muted);
    cursor: pointer;
  }
  .copy:hover {
    color: var(--accent);
  }
</style>
