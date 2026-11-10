<script lang="ts">
  import { defaultRule, LIMIT_OPTIONS, SORT_OPTIONS, type Rule, type SmartPlaylist, type SortKey } from '../../lib/smart/rules';
  import Button from '../common/Button.svelte';
  import Select from '../common/Select.svelte';
  import SegmentedControl from '../common/SegmentedControl.svelte';
  import Sheet from '../common/Sheet.svelte';
  import RuleEditor from './RuleEditor.svelte';

  let {
    playlist,
    genres = [],
    onsave,
    onclose,
  }: {
    playlist: SmartPlaylist;
    genres?: readonly string[];
    onsave: (p: SmartPlaylist) => void;
    onclose: () => void;
  } = $props();

  // The sheet edits a private copy (initial props are intentionally captured once).
  // svelte-ignore state_referenced_locally
  const start = playlist;
  let name = $state(start.name);
  let mode = $state<'all' | 'any'>(start.mode);
  let rules = $state<Rule[]>(start.rules.map((r) => ({ ...r })));
  let sort = $state<SortKey>(start.sort);
  let limit = $state(start.limit === null ? 'all' : String(start.limit));

  const limitOptions = $derived(
    LIMIT_OPTIONS.some((o) => o.id === limit) || limit === 'all'
      ? LIMIT_OPTIONS
      : [...LIMIT_OPTIONS, { id: limit, label: `${limit} tracks`, value: Number(limit) }],
  );

  function save() {
    const trimmed = name.trim();
    if (trimmed === '') return;
    onsave({
      ...start,
      name: trimmed,
      mode,
      rules: rules.map((r) => ({ ...r })),
      sort,
      limit: limit === 'all' ? null : Number(limit),
    });
  }
</script>

<Sheet title={start.name === '' ? 'New smart playlist' : 'Edit smart playlist'} {onclose}>
  <form
    class="form"
    onsubmit={(e) => {
      e.preventDefault();
      save();
    }}
  >
    <input class="name" type="text" placeholder="Name" aria-label="Playlist name" bind:value={name} autocomplete="off" />

    <div class="line">
      <span class="lbl">Match</span>
      <SegmentedControl
        label="Match mode"
        value={mode}
        onchange={(id) => (mode = id as 'all' | 'any')}
        options={[{ id: 'all', label: 'All rules' }, { id: 'any', label: 'Any rule' }]}
      />
    </div>

    <div class="rules">
      {#each rules as rule, i (i)}
        <RuleEditor
          {rule}
          {genres}
          onchange={(r) => (rules[i] = r)}
          onremove={() => rules.splice(i, 1)}
        />
      {/each}
      {#if rules.length === 0}<p class="muted">No rules: every track matches.</p>{/if}
      <div><Button icon="plus" onclick={() => rules.push(defaultRule('genre'))}>Add rule</Button></div>
    </div>

    <div class="line">
      <Select label="Sort" value={sort} onchange={(id) => (sort = id as SortKey)} options={SORT_OPTIONS} />
      <Select label="Limit" value={limit} onchange={(id) => (limit = id)} options={limitOptions} />
    </div>

    <div class="actions">
      <Button onclick={onclose}>Cancel</Button>
      <Button primary disabled={name.trim() === ''} onclick={save}>Save</Button>
    </div>
  </form>
</Sheet>

<style>
  .form {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
  }
  .name {
    height: 40px;
    padding: 0 var(--space-4);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-full);
    background: var(--surface-2);
    color: var(--text);
    font: inherit;
  }
  .name:focus-visible {
    outline: 2px solid var(--accent);
  }
  .rules {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }
  .line {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-3);
  }
  .lbl,
  .muted {
    color: var(--text-muted);
    font-size: var(--text-sm);
    margin: 0;
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    gap: var(--space-2);
  }
</style>
