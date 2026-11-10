<script lang="ts">
  import { hueFor, initials } from './avatar';
  let { name, size = 40 }: { name: string; size?: number } = $props();
</script>

<span
  class="avatar"
  aria-hidden="true"
  style:width="{size}px"
  style:height="{size}px"
  style:font-size="{Math.round(size * 0.38)}px"
  style:--h={hueFor(name)}
>
  {initials(name)}
</span>

<style>
  .avatar {
    flex: none;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: 50%;
    font-weight: var(--weight-semibold);
    color: hsl(var(--h) 80% 92%);
    background: linear-gradient(135deg, hsl(var(--h) 55% 42%), hsl(calc(var(--h) + 40) 55% 28%));
    box-shadow: inset 0 0 0 1px rgb(255 255 255 / 0.12);
  }
</style>
