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
      <div class="boot" aria-busy="true"><span class="word">Rayla</span></div>
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
    height: 100%;
    display: grid;
    place-items: center;
  }
  .word {
    font-family: var(--font-display);
    font-size: var(--text-xl);
    font-weight: var(--weight-bold);
    letter-spacing: var(--tracking-tight);
    color: var(--text-muted);
    animation: boot-pulse 1.6s var(--ease-in-out) infinite;
  }
  @keyframes boot-pulse {
    0%,
    100% {
      opacity: 0.35;
    }
    50% {
      opacity: 1;
    }
  }
</style>
