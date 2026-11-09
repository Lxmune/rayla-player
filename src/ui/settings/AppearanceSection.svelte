<script lang="ts">
  import { getApp } from '../../lib/app.svelte';
  import type { ThemeMode } from '../../lib/settings/types';
  import Section from './Section.svelte';
  import SelectRow from './SelectRow.svelte';

  const settings = getApp().core.settings;
</script>

<Section title="Appearance">
  <SelectRow
    label="Theme"
    value={settings.current.themeMode}
    options={[
      { value: 'dark', label: 'Dark' },
      { value: 'light', label: 'Light' },
      { value: 'system', label: 'System' },
    ]}
    onchange={(v) => void settings.setThemeMode(v as ThemeMode)}
  />
</Section>
