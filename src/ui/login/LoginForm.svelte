<script lang="ts">
  import { getApp } from '../../lib/app.svelte';
  import { describeError } from '../../lib/jellyfin/client';

  let { onsuccess }: { onsuccess?: () => void } = $props();

  const app = getApp();
  let serverUrl = $state('');
  let username = $state('');
  let password = $state('');
  let busy = $state(false);
  let error = $state<string | null>(null);

  async function submit(e: SubmitEvent) {
    e.preventDefault();
    if (busy) return;
    if (serverUrl.trim() === '' || username.trim() === '') {
      error = 'Enter the server address and your user name.';
      return;
    }
    busy = true;
    error = null;
    try {
      await app.core.sessions.login(serverUrl, username.trim(), password);
      password = '';
      onsuccess?.();
    } catch (err) {
      error = describeError(err);
    } finally {
      busy = false;
    }
  }
</script>

<form class="form" onsubmit={submit}>
  <label>
    <span>Server address</span>
    <input type="url" bind:value={serverUrl} placeholder="https://jellyfin.example.com" autocomplete="url" />
  </label>
  <label>
    <span>User name</span>
    <input type="text" bind:value={username} autocomplete="username" />
  </label>
  <label>
    <span>Password</span>
    <input type="password" bind:value={password} autocomplete="current-password" />
  </label>
  {#if error}<p class="error" role="alert">{error}</p>{/if}
  <button type="submit" class="submit" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
</form>

<style>
  .form {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }
  label {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    font-size: var(--text-sm);
    color: var(--text-muted);
  }
  input {
    padding: var(--space-3);
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    color: var(--text);
  }
  .error {
    margin: 0;
    color: var(--danger);
    font-size: var(--text-sm);
  }
  .submit {
    padding: var(--space-3);
    border: 0;
    border-radius: 999px;
    background: var(--accent);
    color: var(--accent-contrast);
    font-weight: 600;
    cursor: pointer;
  }
  .submit:disabled {
    opacity: 0.5;
    cursor: default;
  }
</style>
