<script lang="ts">
  import { getApp } from '../../lib/app.svelte';
  import { hasRealApplicationId } from '../../lib/integrations/discord-template';
  import {
    DISCORD_LINK_PLACEHOLDERS,
    DISCORD_PLACEHOLDERS,
    type DiscordSettings,
  } from '../../lib/settings/types';
  import Section from './Section.svelte';
  import TextRow from './TextRow.svelte';
  import ToggleRow from './ToggleRow.svelte';

  const settings = getApp().core.settings;
  const d = $derived(settings.current.discord);
  const patch = (p: Partial<DiscordSettings>) => void settings.updateDiscord(p);

  function setButton(i: 0 | 1, p: Partial<DiscordSettings['buttons'][0]>) {
    void settings.updateDiscord((cur) => {
      const buttons: DiscordSettings['buttons'] = [{ ...cur.buttons[0] }, { ...cur.buttons[1] }];
      buttons[i] = { ...buttons[i], ...p };
      return { ...cur, buttons };
    });
  }
</script>

<Section title="Discord Rich Presence" id="discord">
  <ToggleRow label="Show what I'm playing" checked={d.enabled} onchange={(v) => patch({ enabled: v })} />
  <TextRow
    label="Application ID"
    value={d.applicationId}
    hint="Create an application at discord.com/developers with image assets named rayla, play and pause"
    oncommit={(v) => patch({ applicationId: v.trim() })}
  />
  {#if !hasRealApplicationId(d)}
    <p class="warn" role="alert">
      This is the placeholder Application ID. Presence will not appear until you enter your own.
    </p>
  {/if}

  <p class="note">
    Placeholders:
    {#each DISCORD_PLACEHOLDERS as p (p)}<code>{`{${p}}`}</code>{' '}{/each}
    <br />
    In button labels and URLs also:
    {#each DISCORD_LINK_PLACEHOLDERS as p (p)}<code>{`{${p}}`}</code>{' '}{/each}
  </p>
  <TextRow label="Details (first line)" value={d.details} oncommit={(v) => patch({ details: v })} />
  <TextRow label="State (second line)" value={d.state} oncommit={(v) => patch({ state: v })} />
  <TextRow label="Large image text" value={d.largeText} oncommit={(v) => patch({ largeText: v })} />
  <TextRow label="Small image text" value={d.smallText} oncommit={(v) => patch({ smallText: v })} />

  <ToggleRow label="Show elapsed time" checked={d.showElapsed} onchange={(v) => patch({ showElapsed: v })} />
  <ToggleRow
    label="Show when paused"
    checked={d.showWhenPaused}
    onchange={(v) => patch({ showWhenPaused: v })}
  />
  <ToggleRow
    label="Show album cover"
    hint="Discord fetches the image itself, so it needs the public Jellyfin URL"
    checked={d.showCover}
    onchange={(v) => patch({ showCover: v })}
  />
  <TextRow
    label="Public Jellyfin URL"
    type="url"
    value={d.publicUrl}
    placeholder="https://jellyfin.example.com"
    oncommit={(v) => patch({ publicUrl: v.trim() })}
  />

  {#each [0, 1] as const as i (i)}
    <fieldset class="button">
      <legend>Button {i + 1}</legend>
      <TextRow label={`Button ${i + 1} label`} value={d.buttons[i].label} oncommit={(v) => setButton(i, { label: v })} />
      <TextRow label={`Button ${i + 1} URL`} type="url" value={d.buttons[i].url} oncommit={(v) => setButton(i, { url: v.trim() })} />
    </fieldset>
  {/each}
</Section>

<style>
  .button { border: 1px solid var(--border); border-radius: var(--radius-sm); margin: var(--space-2) 0 0; padding: 0 var(--space-3) var(--space-2); }
  legend { font-size: var(--text-xs); color: var(--text-muted); padding: 0 var(--space-1); }
  code { font-family: var(--font-mono); font-size: var(--text-xs); background: var(--surface-2); padding: 1px 4px; border-radius: 4px; }
  .note { color: var(--text-muted); font-size: var(--text-sm); }
  .warn { color: var(--danger); font-size: var(--text-sm); }
</style>
