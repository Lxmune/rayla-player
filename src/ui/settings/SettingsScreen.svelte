<script lang="ts">
  import './settings.css';
  import { getApp } from '../../lib/app.svelte';
  import Icon from '../common/Icon.svelte';
  import AboutSection from './AboutSection.svelte';
  import AppearanceSection from './AppearanceSection.svelte';
  import BehaviorSection from './BehaviorSection.svelte';
  import CacheSection from './CacheSection.svelte';
  import DiscordSection from './DiscordSection.svelte';
  import EqSection from './EqSection.svelte';
  import GainSection from './GainSection.svelte';
  import OutputSection from './OutputSection.svelte';
  import ProcessingSection from './ProcessingSection.svelte';
  import ScrobbleSection from './ScrobbleSection.svelte';
  import { matchSections } from './sections';
  import StreamingSection from './StreamingSection.svelte';

  const settings = getApp().core.settings;
  let query = $state('');
  let active = $state('appearance');
  let pane = $state<HTMLElement | null>(null);

  const visible = $derived(matchSections(query));
  const shown = (id: string) => visible.some((s) => s.id === id);

  /** Scroll spy: the last section whose top has passed the top of the pane. */
  function spy() {
    if (!pane) return;
    const top = pane.getBoundingClientRect().top + 48;
    let current = visible[0]?.id ?? active;
    for (const s of visible) {
      const el = pane.querySelector(`#settings-${s.id}`);
      if (el && el.getBoundingClientRect().top <= top) current = s.id;
    }
    active = current;
  }

  function jump(id: string) {
    active = id;
    const el = pane?.querySelector(`#settings-${id}`);
    const smooth = settings.current.appearance.reduceMotion ? 'auto' : 'smooth';
    el?.scrollIntoView?.({ behavior: smooth, block: 'start' });
  }
</script>

<div class="settings">
  <header class="top">
    <h1>Settings</h1>
    <label class="search">
      <Icon name="search" size={16} />
      <input type="search" bind:value={query} placeholder="Search settings" aria-label="Search settings" autocomplete="off" spellcheck="false" />
    </label>
  </header>

  <div class="layout">
    <nav class="cats" aria-label="Settings categories">
      {#each visible as s (s.id)}
        <button type="button" class:on={s.id === active} aria-current={s.id === active ? 'true' : undefined} onclick={() => jump(s.id)}>
          {s.label}
        </button>
      {/each}
    </nav>

    <div class="pane" bind:this={pane} onscroll={spy}>
      {#if visible.length === 0}
        <div class="none">
          <Icon name="search" size={28} />
          <p>No settings match “{query}”.</p>
          <button type="button" class="clear" onclick={() => (query = '')}>Clear search</button>
        </div>
      {/if}
      {#if shown('appearance')}<AppearanceSection />{/if}
      {#if shown('behavior')}<BehaviorSection />{/if}
      {#if shown('output')}<OutputSection />{/if}
      {#if shown('gain')}<GainSection />{/if}
      {#if shown('eq')}<EqSection />{/if}
      {#if shown('processing')}<ProcessingSection />{/if}
      {#if shown('streaming')}<StreamingSection />{/if}
      {#if shown('cache')}<CacheSection />{/if}
      {#if shown('scrobbling')}<ScrobbleSection />{/if}
      {#if shown('discord')}<DiscordSection />{/if}
      {#if shown('about')}<AboutSection />{/if}
    </div>
  </div>
</div>

<style>
  .settings { height: 100%; display: flex; flex-direction: column; max-width: 1040px; margin: 0 auto; padding: var(--space-5) var(--gutter) 0; animation: fade-in var(--duration) var(--ease-out); }
  .top { display: flex; align-items: center; justify-content: space-between; gap: var(--space-4); margin-bottom: var(--space-4); flex-wrap: wrap; }
  h1 { font-size: var(--text-xl); margin: 0; font-weight: var(--weight-semibold); }
  .search { display: flex; align-items: center; gap: var(--space-2); padding: 0 var(--space-3); width: min(280px, 100%); background: var(--surface-2); border: 1px solid var(--border); border-radius: var(--radius-full); color: var(--text-muted); transition: border-color var(--transition); }
  .search:focus-within { border-color: var(--accent); }
  .search input { flex: 1; min-width: 0; padding: var(--space-2) 0; background: none; border: 0; outline: none; color: var(--text); }
  .layout { flex: 1; min-height: 0; display: grid; grid-template-columns: 188px minmax(0, 1fr); gap: var(--space-5); }
  .cats { display: flex; flex-direction: column; gap: 2px; align-self: start; position: sticky; top: 0; }
  .cats button { text-align: left; padding: var(--space-2) var(--space-3); border: 0; border-radius: var(--radius-md); background: none; color: var(--text-muted); cursor: pointer; font-size: var(--text-md); transition: background var(--transition), color var(--transition); }
  .cats button:hover { background: var(--hover); color: var(--text); }
  .cats button.on { background: var(--accent-soft); color: var(--text); font-weight: var(--weight-medium); }
  .pane { overflow-y: auto; min-height: 0; padding: 0 var(--space-2) var(--space-7) 0; }
  .none { display: flex; flex-direction: column; align-items: center; gap: var(--space-2); padding: var(--space-7) 0; color: var(--text-muted); }
  .none p { margin: 0; }
  .clear { padding: var(--space-2) var(--space-4); border: 1px solid var(--border); border-radius: var(--radius-full); background: var(--surface-2); cursor: pointer; }

  @media (max-width: 900px) {
    .layout { grid-template-columns: minmax(0, 1fr); grid-template-rows: auto minmax(0, 1fr); gap: var(--space-3); }
    .cats { flex-direction: row; overflow-x: auto; position: static; padding-bottom: var(--space-1); }
    .cats button { flex: none; white-space: nowrap; border: 1px solid var(--border); border-radius: var(--radius-full); }
    .cats button.on { border-color: var(--accent); }
  }
</style>
