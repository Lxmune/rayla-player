<script lang="ts">
  import type { Snippet } from 'svelte';

  let { title, subtitle, children }: { title: string; subtitle?: string; children?: Snippet } = $props();
</script>

<header class="head">
  <div class="titles">
    <h1>{title}</h1>
    {#if subtitle}<p>{subtitle}</p>{/if}
  </div>
  {#if children}<div class="tools">{@render children()}</div>{/if}
</header>

<style>
  .head {
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    gap: var(--space-4);
    flex-wrap: wrap;
    margin-bottom: var(--space-5);
  }
  h1 {
    margin: 0;
    font-size: var(--text-2xl);
    font-weight: var(--weight-bold);
    letter-spacing: var(--tracking-tight);
    line-height: 1.1;
  }
  p {
    margin: var(--space-2) 0 0;
    color: var(--text-muted);
    font-size: var(--text-md);
  }
  .tools {
    display: flex;
    gap: var(--space-2);
    align-items: center;
    flex-wrap: wrap;
  }
  @media (max-width: 800px) {
    h1 {
      font-size: var(--text-xl);
    }
  }
</style>
