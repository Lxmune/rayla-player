<script lang="ts">
  let {
    label,
    hint = '',
    checked,
    disabled = false,
    onchange,
  }: {
    label: string;
    hint?: string;
    checked: boolean;
    disabled?: boolean;
    onchange: (value: boolean) => void;
  } = $props();
</script>

<label class="row">
  <span class="label">
    <span>{label}</span>
    {#if hint}<span class="hint">{hint}</span>{/if}
  </span>
  <input
    type="checkbox"
    role="switch"
    {checked}
    {disabled}
    onchange={(e) => onchange(e.currentTarget.checked)}
  />
</label>

<style>
  input { width: 18px; height: 18px; accent-color: var(--accent); flex: none; }
</style>
