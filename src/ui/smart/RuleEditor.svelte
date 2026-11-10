<script lang="ts">
  import { defaultRule, FIELD_OPTIONS, type Rule, type RuleField } from '../../lib/smart/rules';
  import IconButton from '../common/IconButton.svelte';

  let {
    rule,
    genres = [],
    onchange,
    onremove,
  }: {
    rule: Rule;
    /** Genre names offered as suggestions. */
    genres?: readonly string[];
    onchange: (r: Rule) => void;
    onremove: () => void;
  } = $props();

  const listId = `genres-${Math.random().toString(36).slice(2, 7)}`;
  const num = (v: string): number | null => (v.trim() === '' || Number.isNaN(Number(v)) ? null : Number(v));
  const int = (v: string, fallback: number): number => Math.max(0, Math.floor(num(v) ?? fallback));
  const FORMATS = ['flac', 'alac', 'mp3', 'aac', 'opus', 'ogg', 'wav', 'dsf', 'lossless'];
  const DECADE_LIST = [2020, 2010, 2000, 1990, 1980, 1970, 1960, 1950];

  function setField(id: string) {
    if (id !== rule.field) onchange(defaultRule(id as RuleField));
  }
</script>

<div class="row">
  <select class="field" aria-label="Rule field" value={rule.field} onchange={(e) => setField(e.currentTarget.value)}>
    {#each FIELD_OPTIONS as f (f.id)}<option value={f.id}>{f.label}</option>{/each}
  </select>

  <div class="value">
    {#if rule.field === 'genre'}
      <select aria-label="Genre operator" value={rule.op} onchange={(e) => onchange({ ...rule, op: e.currentTarget.value as 'is' | 'isNot' })}>
        <option value="is">is</option>
        <option value="isNot">is not</option>
      </select>
      <input type="text" list={listId} placeholder="Genre" aria-label="Genre" value={rule.value} oninput={(e) => onchange({ ...rule, value: e.currentTarget.value })} />
      <datalist id={listId}>{#each genres as g (g)}<option value={g}></option>{/each}</datalist>
    {:else if rule.field === 'artist' || rule.field === 'albumArtist'}
      <input type="text" placeholder="Artist name" aria-label="Artist name" value={rule.value} oninput={(e) => onchange({ ...rule, value: e.currentTarget.value })} />
    {:else if rule.field === 'year'}
      <input type="number" inputmode="numeric" placeholder="From" aria-label="From year" value={rule.min ?? ''} oninput={(e) => onchange({ ...rule, min: num(e.currentTarget.value) })} />
      <span class="sep">to</span>
      <input type="number" inputmode="numeric" placeholder="To" aria-label="To year" value={rule.max ?? ''} oninput={(e) => onchange({ ...rule, max: num(e.currentTarget.value) })} />
    {:else if rule.field === 'decade'}
      <select aria-label="Decade" value={String(rule.value)} onchange={(e) => onchange({ ...rule, value: Number(e.currentTarget.value) })}>
        {#each DECADE_LIST as d (d)}<option value={String(d)}>{d}s</option>{/each}
      </select>
    {:else if rule.field === 'favourite' || rule.field === 'hiRes'}
      <select aria-label="Value" value={rule.value ? 'yes' : 'no'} onchange={(e) => onchange({ ...rule, value: e.currentTarget.value === 'yes' })}>
        <option value="yes">Yes</option>
        <option value="no">No</option>
      </select>
    {:else if rule.field === 'playCount'}
      <select aria-label="Operator" value={rule.op} onchange={(e) => onchange({ ...rule, op: e.currentTarget.value as 'gte' | 'lte' })}>
        <option value="gte">at least</option>
        <option value="lte">at most</option>
      </select>
      <input type="number" inputmode="numeric" min="0" aria-label="Plays" value={rule.value} oninput={(e) => onchange({ ...rule, value: int(e.currentTarget.value, 0) })} />
      <span class="sep">plays</span>
    {:else if rule.field === 'lastPlayed'}
      <select aria-label="Operator" value={rule.op} onchange={(e) => onchange({ ...rule, op: e.currentTarget.value as 'within' | 'older' })}>
        <option value="within">within</option>
        <option value="older">not in</option>
      </select>
      <input type="number" inputmode="numeric" min="1" aria-label="Days" value={rule.days} oninput={(e) => onchange({ ...rule, days: int(e.currentTarget.value, 1) })} />
      <span class="sep">days</span>
    {:else if rule.field === 'added'}
      <input type="number" inputmode="numeric" min="1" aria-label="Days" value={rule.days} oninput={(e) => onchange({ ...rule, days: int(e.currentTarget.value, 1) })} />
      <span class="sep">days</span>
    {:else if rule.field === 'codec'}
      <input type="text" list="{listId}-f" placeholder="flac" aria-label="Format" value={rule.value} oninput={(e) => onchange({ ...rule, value: e.currentTarget.value })} />
      <datalist id="{listId}-f">{#each FORMATS as f (f)}<option value={f}></option>{/each}</datalist>
    {:else if rule.field === 'duration'}
      <select aria-label="Operator" value={rule.op} onchange={(e) => onchange({ ...rule, op: e.currentTarget.value as 'gte' | 'lte' })}>
        <option value="gte">at least</option>
        <option value="lte">at most</option>
      </select>
      <input type="number" inputmode="numeric" min="0" aria-label="Minutes" value={Math.round(rule.seconds / 6) / 10} oninput={(e) => onchange({ ...rule, seconds: Math.round((num(e.currentTarget.value) ?? 0) * 60) })} />
      <span class="sep">min</span>
    {:else}
      <span class="sep">Tracks with no plays</span>
    {/if}
  </div>
  <IconButton icon="close" label="Remove rule" size={16} onclick={onremove} />
</div>

<style>
  .row {
    display: grid;
    grid-template-columns: minmax(0, 150px) minmax(0, 1fr) auto;
    align-items: center;
    gap: var(--space-2);
  }
  .value {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    min-width: 0;
  }
  select,
  input {
    min-width: 0;
    height: 36px;
    padding: 0 var(--space-3);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-md);
    background: var(--surface-2);
    color: var(--text);
    font: inherit;
    font-size: var(--text-sm);
  }
  .value input {
    flex: 1;
    width: 0;
  }
  select:focus-visible,
  input:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }
  .sep {
    color: var(--text-muted);
    font-size: var(--text-sm);
    white-space: nowrap;
  }
  /* Phone: field on its own line above the value. */
  @media (max-width: 640px) {
    .row {
      grid-template-columns: minmax(0, 1fr) auto;
    }
    .value {
      grid-column: 1 / -1;
      grid-row: 2;
    }
    .field {
      grid-column: 1;
    }
    .row > :global(button) {
      grid-column: 2;
      grid-row: 1;
    }
  }
</style>
