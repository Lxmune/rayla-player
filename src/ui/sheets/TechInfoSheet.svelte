<script lang="ts">
  import { getApp } from '../../lib/app.svelte';
  import { techInfoRows, type BaseItem } from '../../lib/jellyfin/models';

  let { item }: { item: BaseItem } = $props();

  const core = getApp().core;
  const isCurrent = $derived(core.player.current?.id === item.id);
  const path = $derived(isCurrent ? core.player.signalPath : null);
  const rows = $derived(
    techInfoRows(item, {
      path,
      maxBitrate: core.settings.current.maxBitrate,
      downloaded: core.downloads.pathFor(item.id) !== null,
    }),
  );
</script>

<div class="ti">
  <p class="name">{item.name}</p>
  {#if path?.bitPerfect}<p class="badge">Bit-perfect</p>{/if}
  {#if rows.length === 0}
    <p class="empty">No technical information available.</p>
  {:else}
    <table>
      <tbody>
        {#each rows as [label, value] (label)}
          <tr>
            <th scope="row">{label}</th>
            <td>{value}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}
</div>

<style>
  .ti { display: flex; flex-direction: column; gap: var(--space-2); }
  .name { margin: 0; font-weight: 600; }
  .empty { color: var(--text-muted); margin: 0; }
  .badge { align-self: flex-start; margin: 0; padding: 2px var(--space-3); border-radius: 999px; border: 1px solid var(--accent); color: var(--accent); font-size: var(--text-xs); font-weight: 600; }
  table { border-collapse: collapse; width: 100%; }
  th { text-align: left; font-weight: 400; color: var(--text-muted); padding: var(--space-1) var(--space-4) var(--space-1) 0; vertical-align: top; white-space: nowrap; font-size: var(--text-sm); }
  td { padding: var(--space-1) 0; font-size: var(--text-sm); word-break: break-word; }
  tr + tr { border-top: 1px solid var(--border); }
</style>
