<script lang="ts">
  import { getApp } from '../../lib/app.svelte';
  import { imageItemId } from '../../lib/jellyfin/models';
  import { httpFetch } from '../../lib/platform';
  import { loadAccent, type AccentMode } from './accent';

  // Renders nothing: applies theme mode and the cover accent to <html>.
  const app = getApp();
  const root = document.documentElement;

  const FALLBACK = { accent: '', contrast: '' };

  // --- theme mode ---------------------------------------------------------
  let systemDark = $state(true);
  $effect(() => {
    const mq = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null;
    if (!mq) return;
    systemDark = mq.matches;
    const on = () => (systemDark = mq.matches);
    mq.addEventListener?.('change', on);
    return () => mq.removeEventListener?.('change', on);
  });

  const mode = $derived(app.core.settings.current.themeMode);
  const resolved = $derived<AccentMode>(mode === 'system' ? (systemDark ? 'dark' : 'light') : mode);

  $effect(() => {
    root.setAttribute('data-theme', resolved);
  });

  // --- accent -------------------------------------------------------------
  const coverUrl = $derived.by(() => {
    const client = app.core.sessions.client;
    const item = app.core.player.current;
    if (!client || !item) return null;
    return client.imageUrl(imageItemId(item), {
      maxWidth: 96,
      tag: item.primaryImageTag ?? item.albumPrimaryImageTag,
    });
  });

  let seq = 0;
  $effect(() => {
    const url = coverUrl;
    const m = resolved;
    const id = ++seq;
    if (url === null) {
      // Nothing playing: default accent. (While a track loads, the previous one stays.)
      root.style.removeProperty('--accent');
      root.style.removeProperty('--accent-contrast');
      return;
    }
    void loadAccent(url, (u) => httpFetch(u), m).then((a) => {
      if (id !== seq) return; // stale
      const next = a ?? FALLBACK;
      if (next.accent === '') {
        root.style.removeProperty('--accent');
        root.style.removeProperty('--accent-contrast');
      } else {
        root.style.setProperty('--accent', next.accent);
        root.style.setProperty('--accent-contrast', next.contrast);
      }
    });
  });
</script>
