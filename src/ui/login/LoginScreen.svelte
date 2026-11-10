<script lang="ts">
  import { getApp } from '../../lib/app.svelte';
  import LoginForm from './LoginForm.svelte';
  import ProfileList from './ProfileList.svelte';

  const app = getApp();
  const hasProfiles = $derived(app.core.sessions.profiles.length > 0);
</script>

<main class="login">
  <div class="aurora" aria-hidden="true">
    <span class="blob a"></span>
    <span class="blob b"></span>
    <span class="blob c"></span>
  </div>
  <div class="card">
    <h1>Rayla</h1>
    <p class="tag">Sign in to your Jellyfin server</p>
    {#if hasProfiles}
      <h2>Saved servers</h2>
      <ProfileList />
      <h2>Add a server</h2>
    {/if}
    <LoginForm />
  </div>
</main>

<style>
  .login {
    position: relative;
    min-height: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: var(--space-5) var(--space-4);
    overflow: hidden;
  }
  .aurora { position: absolute; inset: 0; overflow: hidden; pointer-events: none; }
  .blob { position: absolute; width: 60vmax; height: 60vmax; border-radius: 50%; filter: blur(80px); opacity: 0.35; }
  .a { top: -25vmax; left: -15vmax; background: radial-gradient(circle, var(--accent), transparent 65%); animation: drift-a 24s ease-in-out infinite alternate; }
  .b { bottom: -30vmax; right: -20vmax; background: radial-gradient(circle, color-mix(in srgb, var(--accent) 60%, #4a6cff), transparent 65%); animation: drift-b 30s ease-in-out infinite alternate; }
  .c { top: 30%; left: 45%; width: 40vmax; height: 40vmax; opacity: 0.18; background: radial-gradient(circle, var(--accent-strong), transparent 65%); animation: drift-a 36s ease-in-out infinite alternate-reverse; }
  @keyframes drift-a { to { transform: translate(12vmax, 8vmax) scale(1.15); } }
  @keyframes drift-b { to { transform: translate(-10vmax, -6vmax) scale(1.1); } }

  .card {
    position: relative;
    width: min(420px, 100%);
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    padding: var(--space-6) var(--space-5);
    background: var(--glass);
    border: 1px solid var(--glass-border);
    border-radius: var(--radius-xl);
    box-shadow: var(--shadow-3);
    backdrop-filter: blur(24px) saturate(1.3);
    -webkit-backdrop-filter: blur(24px) saturate(1.3);
    animation: rise-in var(--duration-slow) var(--ease-out);
  }
  h1 {
    margin: 0;
    font-size: var(--text-2xl);
    font-weight: var(--weight-bold);
    letter-spacing: var(--tracking-tight);
    text-align: center;
    background: linear-gradient(120deg, var(--text), var(--accent));
    -webkit-background-clip: text;
    background-clip: text;
    color: transparent;
  }
  h2 { margin: var(--space-2) 0 0; font-size: var(--text-sm); font-weight: var(--weight-semibold); color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.08em; }
  .tag { margin: 0 0 var(--space-3); color: var(--text-muted); text-align: center; }
</style>
