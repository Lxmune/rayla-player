<script lang="ts">
  import { getApp } from '../../lib/app.svelte';
  import LoginForm from './LoginForm.svelte';
  import ProfileList from './ProfileList.svelte';

  const app = getApp();
  const hasProfiles = $derived(app.core.sessions.profiles.length > 0);
</script>

<main class="login">
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
    min-height: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: var(--space-5);
  }
  .card {
    width: min(400px, 100%);
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }
  h1 {
    margin: 0;
    font-size: 40px;
    font-weight: 700;
    letter-spacing: -0.02em;
  }
  h2 {
    margin: var(--space-3) 0 0;
    font-size: var(--text-md);
    font-weight: 600;
  }
  .tag {
    margin: 0 0 var(--space-3);
    color: var(--text-muted);
  }
</style>
