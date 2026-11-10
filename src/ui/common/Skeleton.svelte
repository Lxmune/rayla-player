<script lang="ts">
  // Shimmering placeholder while content loads. Purely decorative.
  let {
    width = '100%',
    height = '1em',
    radius = 'var(--radius-sm)',
    round = false,
  }: { width?: string; height?: string; radius?: string; round?: boolean } = $props();
</script>

<span
  class="skeleton"
  aria-hidden="true"
  style:width
  style:height
  style:border-radius={round ? '50%' : radius}
></span>

<style>
  .skeleton {
    display: block;
    background: linear-gradient(90deg, var(--skeleton) 25%, var(--skeleton-shine) 50%, var(--skeleton) 75%);
    background-size: 200% 100%;
    animation: shimmer 1.6s linear infinite;
  }
</style>
