<script lang="ts">
  import { availabilityLabel, type TrackAvailability } from '../../lib/track-states.svelte';
  import Icon from './Icon.svelte';

  let { state, detailed = false }: { state: TrackAvailability; /** Also show stream-cache states. */ detailed?: boolean } = $props();

  const label = $derived(availabilityLabel(state));
  const shown = $derived(
    state.kind === 'downloaded' || state.kind === 'downloading' || (detailed && label !== null),
  );
  const fraction = $derived(state.kind === 'downloading' || state.kind === 'caching' ? state.fraction : null);
  const R = 6;
  const C = 2 * Math.PI * R;
</script>

{#if shown && label}
  <span class="ts {state.kind}" title={label} role="img" aria-label={label}>
    {#if state.kind === 'downloaded'}
      <Icon name="download" size={12} />
    {:else if state.kind === 'cached'}
      <i class="dot"></i>
    {:else}
      <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" class:spin={fraction === null}>
        <circle cx="8" cy="8" r={R} class="track" />
        <circle
          cx="8"
          cy="8"
          r={R}
          class="arc"
          stroke-dasharray={C}
          stroke-dashoffset={C * (1 - (fraction ?? 0.25))}
          transform="rotate(-90 8 8)"
        />
      </svg>
    {/if}
  </span>
{/if}

<style>
  .ts {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 18px;
    height: 18px;
    flex: none;
    color: var(--text-faint);
  }
  .downloaded {
    color: var(--success);
  }
  .downloading {
    color: var(--accent);
  }
  .caching {
    color: var(--text-muted);
  }
  .dot {
    width: 4px;
    height: 4px;
    border-radius: 50%;
    background: currentColor;
    opacity: 0.6;
  }
  circle {
    fill: none;
    stroke-width: 1.5;
  }
  .track {
    stroke: currentColor;
    opacity: 0.2;
  }
  .arc {
    stroke: currentColor;
    stroke-linecap: round;
  }
  .spin {
    animation: ts-spin 1.2s linear infinite;
  }
  @keyframes ts-spin {
    to {
      transform: rotate(360deg);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .spin {
      animation: none;
    }
  }
</style>
