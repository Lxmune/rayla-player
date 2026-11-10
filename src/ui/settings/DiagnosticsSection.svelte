<script lang="ts">
  import { diagnostics } from '../../lib/diagnostics.svelte';
  import { ipc } from '../../lib/ipc';
  import { CLIENT_VERSION } from '../../lib/jellyfin/client';
  import { errorMessage } from '../../lib/player/errors.svelte';
  import { getUi } from '../shell/router.svelte';
  import Section from './Section.svelte';

  const ui = getUi();
  let initError = $state<string | null>(null);
  let copyError = $state<string | null>(null);

  $effect(() => {
    ipc.engineInitError().then(
      (e) => (initError = e),
      (e) => (initError = errorMessage(e)),
    );
  });

  const recent = $derived(diagnostics.errors.slice(-8).reverse());
  const info = $derived([
    `Rayla ${CLIENT_VERSION}`,
    `Platform: ${navigator.platform || 'unknown'}`,
    `User agent: ${navigator.userAgent}`,
    `Engine init error: ${initError ?? 'none'}`,
    `Generated: ${new Date().toISOString()}`,
  ]);

  async function copy() {
    copyError = null;
    try {
      await navigator.clipboard.writeText(diagnostics.format(info));
      ui?.toast('Diagnostic log copied');
    } catch (e) {
      copyError = `Could not copy: ${errorMessage(e)}`;
    }
  }
</script>

<Section title="Diagnostics" id="diagnostics">
  <p class="note mono">Rayla {CLIENT_VERSION} · {navigator.platform || 'unknown platform'}</p>
  <p class="note">
    Audio engine: {#if initError}<span class="error">failed to start: {initError}</span>{:else}running{/if}
  </p>
  {#if recent.length === 0}
    <p class="note">No recent errors.</p>
  {:else}
    <ul class="errs">
      {#each recent as e (e.at + e.text)}
        <li class="mono"><span class="t">{new Date(e.at).toLocaleTimeString()}</span> [{e.source}] {e.text}</li>
      {/each}
    </ul>
  {/if}
  <div class="actions">
    <button type="button" class="btn" onclick={copy}>Copy log</button>
    <button type="button" class="btn" onclick={() => diagnostics.clear()}>Clear</button>
  </div>
  {#if copyError}<p class="error" role="alert">{copyError}</p>{/if}
</Section>

<style>
  .errs { list-style: none; margin: var(--space-2) 0; padding: 0; font-size: var(--text-xs); color: var(--text-muted); display: flex; flex-direction: column; gap: var(--space-1); overflow-wrap: anywhere; }
  .t { opacity: 0.7; }
  .actions { display: flex; gap: var(--space-2); margin-top: var(--space-2); }
</style>
