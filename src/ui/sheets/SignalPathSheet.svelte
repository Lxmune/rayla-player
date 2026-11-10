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
        bypassed: false,
      },
      ...p.stages.map((s) => ({ kind: 'Stage', title: s, detail: '', bypassed: /bypass/i.test(s) })),
      {
        kind: 'Output',
        title: p.deviceName,
        detail: [fmt(p.outputBitDepth, p.outputSampleRate), p.exclusive ? 'Exclusive' : 'Shared']
          .filter(Boolean)
          .join(' · '),
        bypassed: false,
      },
    ];
  });
</script>

<div class="sp">
  {#if path === null}
    <p class="empty">Nothing is playing.</p>
  {:else}
    {#if path.bitPerfect}
      <div class="banner perfect">
        <p class="badge" data-testid="bit-perfect">Bit-perfect</p>
        <p class="note">Nothing alters the samples between the file and the DAC.</p>
      </div>
    {:else}
      <div class="banner">
        <p class="note">The signal is processed on its way to the DAC.</p>
      </div>
    {/if}
    {#if transcoded}
      <p class="transcode">
        Transcoded by the server (bitrate cap). The source below is the transcoded stream, not the
        original file.
      </p>
    {/if}
    <ol class="chain">
      {#each nodes as n, i (i)}
        <li class="node" class:last={i === nodes.length - 1} class:bypassed={n.bypassed} class:end={n.kind !== 'Stage'}>
          <span class="dot" aria-hidden="true"></span>
          <div class="card">
            <span class="kind">{n.kind}</span>
            <span class="title">{n.title}</span>
            {#if n.detail}<span class="detail">{n.detail}</span>{/if}
          </div>
        </li>
      {/each}
    </ol>
  {/if}
</div>

<style>
  .sp {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
  }
  .empty {
    color: var(--text-muted);
    margin: 0;
  }
  .banner {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-3) var(--space-4);
    border-radius: var(--radius-md);
    background: var(--surface-2);
  }
  .banner.perfect {
    background: var(--accent-soft);
    border: 1px solid color-mix(in srgb, var(--accent) 45%, transparent);
  }
  .banner p {
    margin: 0;
  }
  .badge {
    flex: none;
    padding: 2px var(--space-3);
    border-radius: 999px;
    background: var(--accent);
    color: var(--accent-contrast);
    font-size: var(--text-sm);
    font-weight: 700;
  }
  .note {
    font-size: var(--text-sm);
    color: var(--text-muted);
  }
  .transcode {
    margin: 0;
    font-size: var(--text-sm);
    color: var(--danger);
  }
  .chain {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .node {
    position: relative;
    display: flex;
    gap: var(--space-3);
    padding-bottom: var(--space-3);
  }
  .node::before {
    content: '';
    position: absolute;
    left: 5px;
    top: 18px;
    bottom: -6px;
    width: 2px;
    background: color-mix(in srgb, var(--accent) 40%, var(--border));
  }
  .node.last::before {
    display: none;
  }
  .node.last {
    padding-bottom: 0;
  }
  .dot {
    flex: none;
    width: 12px;
    height: 12px;
    margin-top: 12px;
    border-radius: 50%;
    background: var(--accent);
    z-index: 1;
  }
  .node:not(.end) .dot {
    background: var(--bg);
    border: 2px solid var(--accent);
    width: 12px;
    height: 12px;
    box-sizing: border-box;
  }
  .card {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: var(--space-3) var(--space-4);
    border-radius: var(--radius-md);
    background: var(--surface-2);
    border: 1px solid var(--border);
  }
  .node.bypassed {
    opacity: 0.45;
  }
  .node.bypassed .title {
    text-decoration: line-through;
  }
  .kind {
    font-size: var(--text-xs);
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--text-faint);
  }
  .title {
    font-weight: 600;
    overflow-wrap: anywhere;
  }
  .detail {
    font-size: var(--text-sm);
    color: var(--text-muted);
  }
</style>
