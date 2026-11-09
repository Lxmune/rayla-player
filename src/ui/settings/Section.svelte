<script lang="ts">
  import type { Snippet } from 'svelte';
  let { title, children }: { title: string; children: Snippet } = $props();
</script>

<section class="section">
  <h2>{title}</h2>
  {@render children()}
</section>

<style>
  .section { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-md); padding: var(--space-4); margin-bottom: var(--space-4); }
  h2 { margin: 0 0 var(--space-2); font-size: var(--text-sm); text-transform: uppercase; letter-spacing: 0.08em; color: var(--text-muted); font-weight: 600; }
</style>
