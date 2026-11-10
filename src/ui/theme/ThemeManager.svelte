<script lang="ts">
  import { getApp } from '../../lib/app.svelte';
  import { imageItemId } from '../../lib/jellyfin/models';
  import { httpFetch } from '../../lib/platform';
  import { accentFromHex, loadAccent, type Accent, type AccentMode } from './accent';

  // Renders nothing: applies theme mode, density, motion and the accent to <html>.
  const app = getApp();
  const root = document.documentElement;

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
  const appearance = $derived(app.core.settings.current.appearance);

  $effect(() => {
    root.setAttribute('data-theme', resolved);
  });
  $effect(() => {
    root.setAttribute('data-density', appearance.density);
    root.setAttribute('data-motion', appearance.reduceMotion ? 'reduced' : 'full');
  });

  // --- accent -------------------------------------------------------------
  const coverUrl = $derived.by(() => {
    if (!appearance.accentFromCover) return null;
    const client = app.core.sessions.client;
    const item = app.core.player.current;
    if (!client || !item) return null;
    return client.imageUrl(imageItemId(item), {
      maxWidth: 96,
      tag: item.primaryImageTag ?? item.albumPrimaryImageTag,
    });
  });

  function apply(a: Accent | null) {
    if (a === null) {
      root.style.removeProperty('--accent');
      root.style.removeProperty('--accent-contrast');
    } else {
      root.style.setProperty('--accent', a.accent);
      root.style.setProperty('--accent-contrast', a.contrast);
    }
  }

  let seq = 0;
  $effect(() => {
    const url = coverUrl;
    const m = resolved;
    const chosen = accentFromHex(appearance.accentColor, m);
    const id = ++seq; // invalidates any extraction still in flight
    if (url === null) {
      // Cover tinting off or nothing playing: the chosen accent.
      apply(chosen);
      return;
    }
    // While a track loads, the previous accent stays.
    void loadAccent(url, (u) => httpFetch(u), m).then((a) => {
      if (id !== seq) return; // stale
      apply(a ?? chosen);
    });
  });
</script>
