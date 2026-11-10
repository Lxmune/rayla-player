<script lang="ts">
  import { CLIENT_VERSION } from '../../lib/jellyfin/client';
  import Section from './Section.svelte';
</script>

<Section title="About" id="about">
  <div class="about">
    <strong class="name">Rayla</strong>
    <span class="ver mono">Version {CLIENT_VERSION}</span>
  </div>
  <p class="note">A minimal music player for Jellyfin with an audiophile signal chain.</p>
  <p class="note">Press <kbd>?</kbd> to see keyboard shortcuts.</p>
</Section>

<style>
  .about { display: flex; align-items: baseline; gap: var(--space-3); }
  .name { font-size: var(--text-xl); font-family: var(--font-display); letter-spacing: var(--tracking-tight); }
  .ver { color: var(--text-muted); font-size: var(--text-sm); }
  kbd { font-family: var(--font-mono); font-size: var(--text-xs); background: var(--surface-2); border: 1px solid var(--border-strong); border-radius: var(--radius-sm); padding: 1px 6px; }
</style>
