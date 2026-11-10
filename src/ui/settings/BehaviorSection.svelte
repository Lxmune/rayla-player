<script lang="ts">
  import { getApp } from '../../lib/app.svelte';
  import { START_SCREENS, type StartScreen } from '../../lib/settings/types';
  import Section from './Section.svelte';
  import SelectRow from './SelectRow.svelte';
  import ToggleRow from './ToggleRow.svelte';

  const settings = getApp().core.settings;
  const b = $derived(settings.current.behavior);

  const LABELS: Record<StartScreen, string> = {
    home: 'Home',
    albums: 'Albums',
    artists: 'Artists',
    playlists: 'Playlists',
    favorites: 'Favourites',
  };
</script>

<Section title="Playback & behavior" id="behavior">
  <ToggleRow
    label="Resume where I left off"
    hint="Restore the queue and position (paused) when Rayla starts"
    checked={b.resumePlayback}
    onchange={(v) => void settings.updateBehavior({ resumePlayback: v })}
  />
  <SelectRow
    label="Start screen"
    hint="What opens first after signing in"
    value={b.startScreen}
    options={START_SCREENS.map((s) => ({ value: s, label: LABELS[s] }))}
    onchange={(v) => void settings.updateBehavior({ startScreen: v as StartScreen })}
  />
</Section>
