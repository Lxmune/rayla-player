<script lang="ts">
  import { onMount } from 'svelte';
  import { createProductionApp, provideApp, type RaylaApp } from './lib/app.svelte';
  import ErrorBanner from './ui/common/ErrorBanner.svelte';
  import LoginScreen from './ui/login/LoginScreen.svelte';
  import Shell from './ui/shell/Shell.svelte';
  import ThemeManager from './ui/theme/ThemeManager.svelte';

  // `app` is injectable so tests can pass a test app; production uses the default.
  let { app = createProductionApp() }: { app?: RaylaApp } = $props();
  // svelte-ignore state_referenced_locally
  provideApp(app);
  // svelte-ignore state_referenced_locally
  const core = app.core;

  onMount(() => {
    void app.start();
    return () => void app.dispose();
  });
</script>

<ThemeManager />

<div class="root">
  {#if core.errors.message}
    <ErrorBanner message={core.errors.message} ondismiss={() => core.errors.clear()} />
  {/if}
  <div class="body">
    {#if !core.sessions.loaded}
      <p class="boot" aria-busy="true">Rayla</p>
    {:else if core.sessions.client === null}
      <LoginScreen />
    {:else}
      <Shell />
    {/if}
  </div>
</div>

<style>
  .root {
    display: flex;
    flex-direction: column;
    height: 100vh;
  }
  .body {
    flex: 1;
    min-height: 0;
    overflow: auto;
  }
  .boot {
    padding: var(--space-5);
    color: var(--text-muted);
  }
</style>
