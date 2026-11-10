<script lang="ts">
  import { getApp } from '../../lib/app.svelte';
  import Button from '../common/Button.svelte';
  import PagedGrid from '../common/PagedGrid.svelte';
  import PagedTrackList from '../common/PagedTrackList.svelte';
  import ScreenHeader from '../common/ScreenHeader.svelte';
  import SegmentedControl from '../common/SegmentedControl.svelte';
  import { useActions } from '../common/actions';
  import { plural } from '../common/format';
  import { Pager } from '../common/resource.svelte';
  import { getRouter } from '../shell/router.svelte';

  const app = getApp();
  const router = getRouter();
  const actions = useActions();
  let tab = $state<'tracks' | 'albums'>('tracks');

  const trackPager = $derived(
    new Pager(async (startIndex) => {
      const client = app.core.sessions.client;
      if (!client) throw new Error('Not signed in');
      return client.tracks({ favoritesOnly: true, startIndex, limit: 60 });
    }),
  );
  const albumPager = $derived(
    new Pager(async (startIndex) => {
      const client = app.core.sessions.client;
      if (!client) throw new Error('Not signed in');
      return client.albums({ favoritesOnly: true, startIndex, limit: 60 });
    }),
  );
  const active = $derived(tab === 'tracks' ? trackPager : albumPager);

  function playAll(shuffle: boolean) {
    void actions.playTracks(trackPager.items, 0, shuffle);
  }
</script>

<section class="screen">
  <ScreenHeader
    title="Favorites"
    subtitle={active.total > 0 ? plural(active.total, tab === 'tracks' ? 'track' : 'album') : undefined}
  >
    {#if tab === 'tracks'}
      <Button icon="play" primary disabled={trackPager.items.length === 0} onclick={() => playAll(false)}>Play all</Button>
      <Button icon="shuffle" disabled={trackPager.items.length === 0} onclick={() => playAll(true)}>Shuffle</Button>
    {/if}
    <SegmentedControl
      label="Favorites type"
      options={[
        { id: 'tracks', label: 'Tracks' },
        { id: 'albums', label: 'Albums' },
      ]}
      value={tab}
      onchange={(id) => (tab = id === 'albums' ? 'albums' : 'tracks')}
    />
  </ScreenHeader>
  {#if tab === 'tracks'}
    <PagedTrackList
      pager={trackPager}
      onplay={(i) => void actions.playTracks(trackPager.items, i)}
      empty="No favorite tracks yet. Tap the heart on a song to add it."
    />
  {:else}
    <PagedGrid pager={albumPager} onopen={(i) => router.open(i)} empty="No favorite albums yet." />
  {/if}
</section>
