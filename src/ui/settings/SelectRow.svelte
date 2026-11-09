<script lang="ts">
  let {
    label,
    hint = '',
    value,
    options,
    onchange,
  }: {
    label: string;
    hint?: string;
    value: string;
    options: { value: string; label: string }[];
    onchange: (value: string) => void;
  } = $props();
</script>

<label class="row">
  <span class="label">
    <span>{label}</span>
    {#if hint}<span class="hint">{hint}</span>{/if}
  </span>
  <select class="field" {value} onchange={(e) => onchange(e.currentTarget.value)}>
    {#each options as o (o.value)}
      <option value={o.value} selected={o.value === value}>{o.label}</option>
    {/each}
  </select>
</label>
