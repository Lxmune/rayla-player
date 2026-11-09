<script lang="ts">
  import { ICONS, type IconName } from './icons';

  let { name, size = 20 }: { name: IconName; size?: number } = $props();
  const icon = $derived(ICONS[name]);
</script>

<svg
  width={size}
  height={size}
  viewBox="0 0 24 24"
  aria-hidden="true"
  focusable="false"
  fill={icon.fill ? 'currentColor' : 'none'}
  stroke={icon.fill ? 'none' : 'currentColor'}
  stroke-width="1.8"
  stroke-linecap="round"
  stroke-linejoin="round"
>
  <path d={icon.d} />
</svg>
