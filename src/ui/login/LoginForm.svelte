<script lang="ts">
  import Icon from '../common/Icon.svelte';
  import { getApp } from '../../lib/app.svelte';
  import { describeError } from '../../lib/jellyfin/client';
  import { previewServer } from './avatar';

  let { onsuccess }: { onsuccess?: () => void } = $props();

  const app = getApp();
  const uid = $props.id();
  let serverUrl = $state('');
  let username = $state('');
  let password = $state('');
  let showPassword = $state(false);
  let busy = $state(false);
  let error = $state<string | null>(null);

  const target = $derived(previewServer(serverUrl));
  const assumed = $derived(serverUrl.trim() !== '' && !serverUrl.includes('://'));

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
  <div class="field">
    <label for={`${uid}-server`}>Server address</label>
    <input
      id={`${uid}-server`}
      type="text"
      inputmode="url"
      bind:value={serverUrl}
      placeholder="https://jellyfin.example.com"
      autocomplete="url"
      autocapitalize="off"
      spellcheck="false"
      aria-describedby={`${uid}-server-help`}
    />
    <span class="help" id={`${uid}-server-help`}>
      {#if assumed}
        No scheme given, connecting to <code>{target}</code>. Type <code>https://</code> for a secure server.
      {:else}
        Start with <code>https://</code> for a secure server, or <code>http://</code> on your own network.
      {/if}
    </span>
  </div>
  <div class="field">
    <label for={`${uid}-user`}>User name</label>
    <input id={`${uid}-user`} type="text" bind:value={username} autocomplete="username" autocapitalize="off" spellcheck="false" />
  </div>
  <div class="field">
    <label for={`${uid}-pass`}>Password</label>
    <div class="pw">
      <input id={`${uid}-pass`} type={showPassword ? 'text' : 'password'} bind:value={password} autocomplete="current-password" />
      <button
        type="button"
        class="eye"
        aria-label={showPassword ? 'Hide password' : 'Show password'}
        aria-pressed={showPassword}
        onclick={() => (showPassword = !showPassword)}
      >
        <Icon name={showPassword ? 'eyeOff' : 'eye'} size={18} />
      </button>
    </div>
  </div>
  <div class="msg" aria-live="polite">
    {#if error}<p class="error" role="alert">{error}</p>{/if}
  </div>
  <button type="submit" class="submit" disabled={busy} aria-busy={busy}>
    {#if busy}<span class="spin" aria-hidden="true"></span>{/if}
    {busy ? 'Signing in…' : 'Sign in'}
  </button>
</form>

<style>
  .form { display: flex; flex-direction: column; gap: var(--space-3); }
  .field { display: flex; flex-direction: column; gap: var(--space-1); }
  label { font-size: var(--text-sm); color: var(--text-muted); font-weight: var(--weight-medium); }
  input {
    width: 100%;
    padding: var(--space-3) var(--space-4);
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    color: var(--text);
    transition: border-color var(--transition), background var(--transition);
  }
  input:hover { border-color: var(--border-strong); }
  input:focus-visible { border-color: var(--accent); outline: none; box-shadow: 0 0 0 3px var(--accent-soft); }
  .help { font-size: var(--text-xs); color: var(--text-faint); line-height: 1.4; }
  code { font-family: var(--font-mono); color: var(--text-muted); }
  .pw { position: relative; }
  .pw input { padding-right: 60px; }
  .eye {
    position: absolute;
    top: 50%;
    right: var(--space-2);
    transform: translateY(-50%);
    display: grid;
    place-items: center;
    min-width: 44px;
    height: 30px;
    padding: 0 var(--space-2);
    border: 0;
    border-radius: var(--radius-full);
    font-size: var(--text-xs);
    background: none;
    color: var(--text-muted);
    cursor: pointer;
  }
  .eye:hover { background: var(--hover); color: var(--text); }
  .eye[aria-pressed='true'] { color: var(--accent); }
  .msg { min-height: 0; }
  .error { margin: 0; padding: var(--space-2) var(--space-3); border-radius: var(--radius-md); background: color-mix(in srgb, var(--danger) 14%, transparent); color: var(--danger); font-size: var(--text-sm); animation: rise-in var(--duration) var(--ease-out); }
  .submit {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: var(--space-2);
    padding: var(--space-3) var(--space-4);
    border: 0;
    border-radius: var(--radius-full);
    background: var(--accent);
    color: var(--accent-contrast);
    font-weight: var(--weight-semibold);
    cursor: pointer;
    transition: filter var(--transition), transform var(--duration-fast) var(--ease-out);
  }
  .submit:hover:not(:disabled) { filter: brightness(1.08); }
  .submit:active:not(:disabled) { transform: scale(0.985); }
  .submit:disabled { opacity: 0.7; cursor: default; }
  .spin { width: 14px; height: 14px; border-radius: 50%; border: 2px solid currentColor; border-right-color: transparent; animation: spin 700ms linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
</style>
