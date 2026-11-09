<script lang="ts">
  import './settings.css';
  import AppearanceSection from './AppearanceSection.svelte';
  import DiscordSection from './DiscordSection.svelte';
  import EqSection from './EqSection.svelte';
  import GainSection from './GainSection.svelte';
  import OutputSection from './OutputSection.svelte';
  import ProcessingSection from './ProcessingSection.svelte';
  import ScrobbleSection from './ScrobbleSection.svelte';
  import StreamingSection from './StreamingSection.svelte';
</script>

<div class="settings">
  <h1>Settings</h1>
  <OutputSection />
  <StreamingSection />
  <GainSection />
  <EqSection />
  <ProcessingSection />
  <AppearanceSection />
  <ScrobbleSection />
  <DiscordSection />
</div>

<style>
  .settings { height: 100%; overflow-y: auto; padding: var(--space-5); max-width: 720px; margin: 0 auto; }
  h1 { font-size: var(--text-xl); margin: 0 0 var(--space-4); font-weight: 600; }
</style>
