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
  input {
    appearance: none;
    flex: none;
    position: relative;
    width: 40px;
    height: 24px;
    margin: 0;
    border-radius: var(--radius-full);
    background: var(--surface-3);
    border: 1px solid var(--border-strong);
    cursor: pointer;
    transition: background var(--transition), border-color var(--transition);
  }
  input::after {
    content: '';
    position: absolute;
    top: 2px;
    left: 2px;
    width: 18px;
    height: 18px;
    border-radius: 50%;
    background: var(--text);
    box-shadow: var(--shadow-1);
    transition: transform var(--transition);
  }
  input:checked { background: var(--accent); border-color: var(--accent); }
  input:checked::after { transform: translateX(16px); background: var(--accent-contrast); }
  input:disabled { opacity: 0.4; cursor: default; }
</style>
