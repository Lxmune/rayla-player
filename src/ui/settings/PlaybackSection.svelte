<script lang="ts">
  import { getApp } from '../../lib/app.svelte';
  import { CROSSFADE_MODES, type CrossfadeMode } from '../../lib/settings/types';
  import { CROSSFADE_MODE_OPTIONS, RESUME_LONG_OPTIONS } from './options';
  import Section from './Section.svelte';
  import SelectRow from './SelectRow.svelte';
  import ToggleRow from './ToggleRow.svelte';

  const settings = getApp().core.settings;
  const p = $derived(settings.current.playback);
</script>

<Section title="Playback" id="playback">
  <SelectRow
    label="Crossfade"
    hint="Applies when crossfade is set in Processing"
    value={p.crossfadeMode}
    options={CROSSFADE_MODE_OPTIONS}
    onchange={(v) => {
      const crossfadeMode: CrossfadeMode | undefined = CROSSFADE_MODES.find((m) => m === v);
      if (crossfadeMode) void settings.updatePlayback({ crossfadeMode });
    }}
  />
  <SelectRow
    label="Remember position of long tracks"
    hint="Audiobooks, mixes and the like continue where you stopped"
    value={String(p.resumeLongTracksMin)}
    options={RESUME_LONG_OPTIONS}
    onchange={(v) => void settings.updatePlayback({ resumeLongTracksMin: Number(v) })}
  />
  <ToggleRow
    label="Fade out with the sleep timer"
    hint="Lowers the volume over the last minute before playback pauses"
    checked={p.sleepFadeOut}
    onchange={(sleepFadeOut) => void settings.updatePlayback({ sleepFadeOut })}
  />
</Section>
