<script lang="ts">
  import { getApp } from '../../lib/app.svelte';
  import type { Density, ThemeMode } from '../../lib/settings/types';
  import ColorRow from './ColorRow.svelte';
  import SegmentRow from './SegmentRow.svelte';
  import Section from './Section.svelte';
  import ToggleRow from './ToggleRow.svelte';

  const settings = getApp().core.settings;
  const a = $derived(settings.current.appearance);

  const SWATCHES = [
    { name: 'Lavender', value: '#c9a7ff' },
    { name: 'Sky', value: '#7cc4ff' },
    { name: 'Mint', value: '#6bd6a8' },
    { name: 'Lime', value: '#b9e36b' },
    { name: 'Amber', value: '#ffc15e' },
    { name: 'Coral', value: '#ff8a6b' },
    { name: 'Rose', value: '#ff7aa8' },
    { name: 'Silver', value: '#b4bcc8' },
  ];
</script>

<Section title="Appearance" id="appearance">
  <SegmentRow
    label="Theme"
    value={settings.current.themeMode}
    options={[
      { value: 'system', label: 'System' },
      { value: 'dark', label: 'Dark' },
      { value: 'light', label: 'Light' },
    ]}
    onchange={(v) => void settings.setThemeMode(v as ThemeMode)}
  />
  <ToggleRow
    label="Accent colour from cover art"
    hint="Tint the interface with a colour taken from the playing track"
    checked={a.accentFromCover}
    onchange={(v) => void settings.updateAppearance({ accentFromCover: v })}
  />
  <ColorRow
    label="Accent colour"
    hint={a.accentFromCover ? 'Used when nothing is playing or the cover has no colour' : 'Used everywhere'}
    value={a.accentColor}
    swatches={SWATCHES}
    onchange={(v) => void settings.updateAppearance({ accentColor: v })}
  />
  <SegmentRow
    label="Density"
    hint="Compact fits more rows and smaller covers on screen"
    value={a.density}
    options={[
      { value: 'comfortable', label: 'Comfortable' },
      { value: 'compact', label: 'Compact' },
    ]}
    onchange={(v) => void settings.updateAppearance({ density: v as Density })}
  />
  <ToggleRow
    label="Art backdrops"
    hint="Blurred cover art behind now playing and headers"
    checked={a.artBackdrop}
    onchange={(v) => void settings.updateAppearance({ artBackdrop: v })}
  />
  <ToggleRow
    label="Reduce motion"
    hint="Turns animations off (also follows the system setting)"
    checked={a.reduceMotion}
    onchange={(v) => void settings.updateAppearance({ reduceMotion: v })}
  />
</Section>
