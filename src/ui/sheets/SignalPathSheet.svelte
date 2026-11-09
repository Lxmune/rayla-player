<script lang="ts">
  import { getApp } from '../../lib/app.svelte';
  import { formatSampleRate, willTranscode } from '../../lib/jellyfin/models';

  const core = getApp().core;
  const path = $derived(core.player.signalPath);
  const current = $derived(core.player.current);
  const transcoded = $derived(
    current !== null &&
      !core.downloads.isDownloaded(current.id) &&
      willTranscode(current, core.settings.current.maxBitrate),
  );

  const fmt = (bits: number, rate: number) =>
    [bits > 0 ? `${bits}-bit` : '', rate > 0 ? formatSampleRate(rate) : ''].filter(Boolean).join(' / ');

  const nodes = $derived.by(() => {
    const p = path;
    if (!p) return [];
    return [
      {
        kind: 'Source',
        title: p.codec.toUpperCase(),
        detail: [fmt(p.sourceBitDepth, p.sourceSampleRate), `${p.channels} ch`].filter(Boolean).join(' · '),
      },
      ...p.stages.map((s) => ({ kind: 'Stage', title: s, detail: '' })),
      {
        kind: 'Output',
        title: p.deviceName,
        detail: [fmt(p.outputBitDepth, p.outputSampleRate), p.exclusive ? 'Exclusive' : 'Shared']
          .filter(Boolean)
          .join(' · '),
      },
    ];
  });
</script>

<div class="sp">
  {#if path === null}
    <p class="empty">Nothing is playing.</p>
  {:else}
    {#if path.bitPerfect}
      <p class="badge" data-testid="bit-perfect">Bit-perfect</p>
    {/if}
    {#if transcoded}
      <p class="transcode">
        Transcoded by the server (bitrate cap). The source below is the transcoded stream, not the
        original file.
      </p>
    {/if}
    <ol class="chain">
      {#each nodes as n, i (i)}
        <li class="node" class:last={i === nodes.length - 1}>
          <span class="kind">{n.kind}</span>
          <span class="title">{n.title}</span>
          {#if n.detail}<span class="detail">{n.detail}</span>{/if}
        </li>
      {/each}
    </ol>
  {/if}
</div>

<style>
  .sp { display: flex; flex-direction: column; gap: var(--space-3); }
  .empty { color: var(--text-muted); margin: 0; }
  .badge { align-self: flex-start; margin: 0; padding: var(--space-1) var(--space-3); border-radius: 999px; border: 1px solid var(--accent); background: var(--accent-soft); color: var(--accent); font-size: var(--text-sm); font-weight: 600; }
  .transcode { margin: 0; font-size: var(--text-sm); color: var(--danger); }
  .chain { list-style: none; margin: 0; padding: 0; }
  .node { position: relative; display: flex; flex-direction: column; gap: 2px; padding: 0 0 var(--space-4) var(--space-5); border-left: 2px solid var(--border); margin-left: 5px; }
  .node.last { border-left-color: transparent; padding-bottom: 0; }
  .node::before { content: ''; position: absolute; left: -6px; top: 4px; width: 10px; height: 10px; border-radius: 50%; background: var(--accent); }
  .kind { font-size: var(--text-xs); text-transform: uppercase; letter-spacing: 0.08em; color: var(--text-faint); }
  .title { font-weight: 600; }
  .detail { font-size: var(--text-sm); color: var(--text-muted); }
</style>
