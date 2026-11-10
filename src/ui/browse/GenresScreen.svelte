<script lang="ts">
  import { untrack } from 'svelte';
  import { getApp } from '../../lib/app.svelte';
  import Button from '../common/Button.svelte';
  import Icon from '../common/Icon.svelte';
  import ScreenHeader from '../common/ScreenHeader.svelte';
  import Skeleton from '../common/Skeleton.svelte';
  import { nameGradient, plural } from '../common/format';
  import { Resource } from '../common/resource.svelte';
  import { getRouter } from '../shell/router.svelte';
  import type { BaseItem } from '../../lib/jellyfin/models';

  const app = getApp();
  const router = getRouter();
  const res = new Resource<BaseItem[]>();

  function load() {
    const client = app.core.sessions.client;
    if (!client) return;
    void res.load(async () => (await client.genres({ limit: 500 })).items, `${app.core.sessions.activeId}:genres`);
  }

  $effect(() => {
    void app.core.sessions.client;
    untrack(load);
  });

  const genres = $derived(res.data ?? []);
</script>

<section class="screen">
  <ScreenHeader title="Genres" subtitle={genres.length > 0 ? plural(genres.length, 'genre') : undefined} />
  {#if genres.length > 0}
    <div class="tiles">
      {#each genres as g (g.id)}
        <button type="button" class="tile" style:background={nameGradient(g.name)} onclick={() => router.open(g)}>
          <span class="name">{g.name}</span>
          <span class="mark" aria-hidden="true"><Icon name="tag" size={44} /></span>
        </button>
      {/each}
    </div>
  {:else if res.error}
    <div class="state">
      <p class="error" role="alert">{res.error}</p>
      <Button icon="refresh" onclick={load}>Retry</Button>
    </div>
  {:else if res.loading || res.data === null}
    <div class="tiles" aria-hidden="true">
      {#each Array(12) as _, i (i)}
        <Skeleton height="96px" radius="var(--radius-lg)" />
      {/each}
    </div>
  {:else}
    <div class="state">
      <Icon name="tag" size={40} />
      <p>No genres found.</p>
    </div>
  {/if}
</section>

<style>
  .tiles {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(calc(var(--card-min) + 40px), 1fr));
    gap: var(--grid-gap);
  }
  .tile {
    position: relative;
    overflow: hidden;
    height: 96px;
    padding: var(--space-4);
    border: 0;
    border-radius: var(--radius-lg);
    color: #fff;
    text-align: left;
    cursor: pointer;
    box-shadow: var(--shadow-1);
    transition:
      transform var(--duration) var(--ease-out),
      box-shadow var(--duration) var(--ease-out);
  }
  .tile:hover {
    transform: translateY(-2px) scale(1.01);
    box-shadow: var(--shadow-2);
  }
  .name {
    position: relative;
    display: block;
    max-width: 85%;
    font-size: var(--text-lg);
    font-weight: var(--weight-bold);
    letter-spacing: var(--tracking-tight);
    overflow-wrap: anywhere;
    text-shadow: 0 1px 6px rgb(0 0 0 / 0.35);
  }
  .mark {
    position: absolute;
    right: -6px;
    bottom: -8px;
    opacity: 0.25;
    transform: rotate(-14deg);
  }
  .state {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-7) var(--space-4);
    color: var(--text-faint);
  }
  .state p {
    margin: 0;
    color: var(--text-muted);
  }
  .state .error {
    color: var(--danger);
  }
  @media (prefers-reduced-motion: reduce) {
    .tile {
      transition: none;
    }
    .tile:hover {
      transform: none;
    }
  }
</style>
