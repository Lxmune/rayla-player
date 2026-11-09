<script lang="ts">
  import { getApp } from '../../lib/app.svelte';
  import { errorMessage } from '../../lib/player/errors.svelte';
  import Section from './Section.svelte';
  import TextRow from './TextRow.svelte';
  import ToggleRow from './ToggleRow.svelte';

  const app = getApp();
  const settings = app.core.settings;
  const creds = app.credentials;

  let user = $state('');
  let password = $state('');
  let busy = $state(false);
  let loginError = $state<string | null>(null);
  let credError = $state<string | null>(null);

  async function guard(fn: () => Promise<void>) {
    credError = null;
    try {
      await fn();
    } catch (e) {
      credError = errorMessage(e);
    }
  }

  async function login(e: SubmitEvent) {
    e.preventDefault();
    busy = true;
    loginError = null;
    try {
      await creds.lastFmLogin(user, password);
      user = '';
    } catch (err) {
      loginError = errorMessage(err);
    } finally {
      password = '';
      busy = false;
    }
  }
</script>

<Section title="Scrobbling">
  <p class="note">Jellyfin playback reporting is always on.</p>

  <ToggleRow
    label="ListenBrainz"
    checked={settings.current.scrobbleListenBrainz}
    onchange={(v) => void settings.setScrobbleListenBrainz(v)}
  />
  <TextRow
    label="ListenBrainz user token"
    type="password"
    value={creds.listenBrainzToken ?? ''}
    oncommit={(v) => guard(() => creds.setListenBrainzToken(v))}
  />

  <ToggleRow
    label="Last.fm"
    checked={settings.current.scrobbleLastFm}
    onchange={(v) => void settings.setScrobbleLastFm(v)}
  />
  <TextRow
    label="Last.fm API key"
    value={creds.lastFmApiKey ?? ''}
    hint="Create your own API account at last.fm/api"
    oncommit={(v) => guard(() => creds.setLastFmApp(v, creds.lastFmSecret))}
  />
  <TextRow
    label="Last.fm API secret"
    type="password"
    value={creds.lastFmSecret ?? ''}
    oncommit={(v) => guard(() => creds.setLastFmApp(creds.lastFmApiKey, v))}
  />
  {#if creds.hasLastFmSession}
    <div class="row">
      <span class="label">Signed in as {creds.lastFmUser ?? 'Last.fm user'}</span>
      <button type="button" class="btn" onclick={() => guard(() => creds.lastFmLogout())}>Log out</button>
    </div>
  {:else}
    <form class="login" onsubmit={login}>
      <div class="stack">
        <label for="lfm-user">Last.fm username</label>
        <input id="lfm-user" class="field" bind:value={user} autocomplete="off" spellcheck="false" />
      </div>
      <div class="stack">
        <label for="lfm-pass">Last.fm password</label>
        <input id="lfm-pass" class="field" type="password" bind:value={password} autocomplete="off" aria-describedby="lfm-pass-hint" />
        <span class="hint" id="lfm-pass-hint">Only used to obtain a session; never stored.</span>
      </div>
      <button
        type="submit"
        class="btn primary"
        disabled={busy || !creds.hasLastFmApp || user.trim() === '' || password === ''}>Log in</button
      >
      {#if !creds.hasLastFmApp}<p class="note">Enter the API key and secret first.</p>{/if}
    </form>
  {/if}
  {#if loginError}<p class="error" role="alert">{loginError}</p>{/if}
  {#if credError}<p class="error" role="alert">{credError}</p>{/if}
</Section>

<style>
  .login { display: flex; flex-direction: column; gap: var(--space-1); align-items: flex-start; }
  .login :global(.stack) { align-self: stretch; }
</style>
