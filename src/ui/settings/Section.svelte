<script lang="ts">
  import type { Snippet } from 'svelte';
  let { title, id = '', children }: { title: string; id?: string; children: Snippet } = $props();
</script>

<section class="section" id={id === '' ? undefined : `settings-${id}`} aria-labelledby={id === '' ? undefined : `settings-${id}-h`}>
  <h2 id={id === '' ? undefined : `settings-${id}-h`}>{title}</h2>
  <div class="body">{@render children()}</div>
</section>

<style>
  .section {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    padding: var(--space-4) var(--space-5) var(--space-3);
    margin-bottom: var(--space-4);
    scroll-margin-top: var(--space-4);
    box-shadow: var(--shadow-1);
  }
  h2 { margin: 0 0 var(--space-2); font-size: var(--text-lg); font-weight: var(--weight-semibold); }
</style>
