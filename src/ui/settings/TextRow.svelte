<script lang="ts">
  /** Text input that commits on change (blur / Enter), never per keystroke. */
  let {
    label,
    hint = '',
    value,
    type = 'text',
    placeholder = '',
    oncommit,
  }: {
    label: string;
    hint?: string;
    value: string;
    type?: 'text' | 'password' | 'url';
    placeholder?: string;
    oncommit: (value: string) => void;
  } = $props();

  const uid = $props.id();
</script>

<div class="stack">
  <label for={`${uid}-in`}>{label}</label>
  <input
    id={`${uid}-in`}
    class="field"
    {type}
    {value}
    {placeholder}
    autocomplete="off"
    spellcheck="false"
    aria-describedby={hint ? `${uid}-hint` : undefined}
    onchange={(e) => oncommit(e.currentTarget.value)}
  />
  {#if hint}<span class="hint" id={`${uid}-hint`}>{hint}</span>{/if}
</div>
