<script lang="ts">
  import { untrack } from 'svelte';
  import { getApp } from '../../lib/app.svelte';
  import type { BaseItem } from '../../lib/jellyfin/models';
  import { entriesFromServer, PERIODS, summarize, type Period, type Ranked, type Summary } from '../../lib/stats/aggregate';
  import { formatHour, formatListening, WEEKDAYS } from '../../lib/stats/format';
  import Artwork from '../common/Artwork.svelte';
  import { plural } from '../common/format';
  import { Resource } from '../common/resource.svelte';
  import ScreenHeader from '../common/ScreenHeader.svelte';
  import SegmentedControl from '../common/SegmentedControl.svelte';
  import { getRouter } from '../shell/router.svelte';

  const app = getApp();
  const router = getRouter();
  let period = $state<Period>('4w');

  const hasLog = $derived(app.listens.size > 0);
  // Server play counts are only needed (and fetched) while the local log is empty.
  const server = new Resource<BaseItem[]>();
  $effect(() => {
    const client = app.core.sessions.client;
    if (client && !hasLog) {
      untrack(() =>
        void server.load(
          async () => (await client.listeningHistory({ sortBy: 'PlayCount', limit: 200 })).items,
          `${app.core.sessions.activeId}:stats-server`,
        ),
      );
    }
  });

  const summary = $derived.by((): Summary | null => {
    const now = Date.now();
    if (hasLog) return summarize(app.listens.all(), { period, now });
    if (server.data) return summarize(entriesFromServer(server.data), { period: 'all', now });
    return null;
  });
  const fromServer = $derived(!hasLog);
  const empty = $derived(summary !== null && summary.plays === 0);

  const sections = $derived(
    summary
      ? ([
          { id: 'artists', title: 'Top artists', rows: summary.artists, round: true },
          { id: 'albums', title: 'Top albums', rows: summary.albums, round: false },
          { id: 'tracks', title: 'Top tracks', rows: summary.tracks, round: false },
          { id: 'genres', title: 'Top genres', rows: summary.genres, round: false },
        ] as const)
      : [],
  );

  const open = (r: Ranked) => {
    if (r.item && r.item.type !== 'Audio') router.open(r.item);
  };
  const share = (r: Ranked, rows: Ranked[]) => `${Math.max(2, ((rows[0]?.ms ? r.ms / rows[0].ms : 0) * 100))}%`;
</script>

<section class="screen">
  <ScreenHeader title="Your stats" subtitle={fromServer ? 'Based on server play counts' : undefined}>
    {#if !fromServer}
      <SegmentedControl
        label="Period"
        options={PERIODS}
        value={period}
        onchange={(id) => (period = id as Period)}
      />
    {/if}
  </ScreenHeader>

  {#if server.error && fromServer}
    <p class="error" role="alert">{server.error}</p>
  {:else if summary === null}
    <p class="muted">Loading…</p>
  {:else if empty}
    <p class="muted">Nothing listened to in this period yet. Play some music and come back.</p>
  {:else}
    <dl class="totals">
      <div><dt>Listening time</dt><dd>{formatListening(summary.totalMs)}</dd></div>
      <div><dt>Plays</dt><dd>{summary.plays.toLocaleString()}</dd></div>
      {#if !fromServer}
        <div><dt>Active days</dt><dd>{summary.activeDays}</dd></div>
        <div>
          <dt>Streak</dt>
          <dd>{plural(summary.streak, 'day')}<small>best {summary.longestStreak}</small></dd>
        </div>
        {#if summary.busiestHour !== null}
          <div><dt>Busiest hour</dt><dd>{formatHour(summary.busiestHour)}</dd></div>
        {/if}
        {#if summary.busiestDay !== null}
          <div><dt>Busiest day</dt><dd>{WEEKDAYS[summary.busiestDay]}</dd></div>
        {/if}
      {/if}
    </dl>

    {#each sections as sec (sec.id)}
      {#if sec.rows.length > 0}
        <section class="block" aria-labelledby="stats-{sec.id}">
          <h2 id="stats-{sec.id}">{sec.title}</h2>
          <ol>
            {#each sec.rows as r, i (r.key)}
              <li>
                <span class="rank" aria-hidden="true">{i + 1}</span>
                {#if r.item}
                  <span class="art" class:round={sec.round} aria-hidden="true"><Artwork item={r.item} size={44} round={sec.round} fill /></span>
                {/if}
                <span class="text">
                  {#if r.item && r.item.type !== 'Audio'}
                    <button type="button" class="name link" onclick={() => open(r)}>{r.name}</button>
                  {:else}
                    <span class="name">{r.name}</span>
                  {/if}
                  {#if r.subtitle}<span class="sub">{r.subtitle}</span>{/if}
                  <span class="bar" aria-hidden="true"><span style:width={share(r, sec.rows)}></span></span>
                </span>
                <span class="value">{formatListening(r.ms)}</span>
              </li>
            {/each}
          </ol>
        </section>
      {/if}
    {/each}
  {/if}
</section>

<style>
  .totals {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
    gap: var(--space-4);
    margin: 0 0 var(--space-6);
  }
  .totals dt {
    font-size: var(--text-sm);
    color: var(--text-muted);
  }
  .totals dd {
    margin: 2px 0 0;
    font-size: var(--text-xl);
    font-weight: var(--weight-semibold);
    letter-spacing: var(--tracking-tight);
  }
  .totals small {
    margin-left: var(--space-2);
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
    color: var(--text-muted);
  }
  .block {
    margin-top: var(--space-6);
  }
  h2 {
    margin: 0 0 var(--space-2);
    font-size: var(--text-lg);
    font-weight: var(--weight-semibold);
  }
  ol {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    margin: 0;
    padding: 0;
    list-style: none;
  }
  li {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    min-width: 0;
  }
  .rank {
    flex: none;
    width: 1.5em;
    text-align: right;
    font-variant-numeric: tabular-nums;
    color: var(--text-muted);
  }
  .art {
    display: block;
    flex: none;
    width: 44px;
    height: 44px;
    overflow: hidden;
    border-radius: var(--radius-sm);
  }
  .art.round {
    border-radius: 50%;
  }
  .text {
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }
  .name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-weight: var(--weight-medium);
  }
  .link {
    padding: 0;
    border: 0;
    background: transparent;
    color: inherit;
    font: inherit;
    font-weight: var(--weight-medium);
    text-align: left;
    cursor: pointer;
  }
  .link:hover {
    color: var(--accent);
  }
  .sub {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: var(--text-sm);
    color: var(--text-muted);
  }
  .bar {
    display: block;
    height: 3px;
    margin-top: 2px;
    border-radius: var(--radius-full);
    background: var(--hover);
  }
  .bar span {
    display: block;
    height: 100%;
    border-radius: inherit;
    background: var(--accent);
  }
  .value {
    flex: none;
    font-size: var(--text-sm);
    font-variant-numeric: tabular-nums;
    color: var(--text-muted);
  }
  .muted {
    color: var(--text-muted);
  }
  .error {
    color: var(--danger);
  }
</style>
