<script lang="ts">
  import { getApp } from '../../lib/app.svelte';
  import Button from '../common/Button.svelte';
  import PagedTrackList from '../common/PagedTrackList.svelte';
  import ScreenHeader from '../common/ScreenHeader.svelte';
  import Select from '../common/Select.svelte';
  import { useActions } from '../common/actions';
  import { plural } from '../common/format';
  import { Pager } from '../common/resource.svelte';
  import { loadViewPrefs, saveViewPrefs } from '../common/viewPrefs';

  const SORTS = [
    { id: 'name', label: 'Name', sortBy: 'SortName', descending: false, playedOnly: false },
    { id: 'artist', label: 'Artist', sortBy: 'Artist,Album,SortName', descending: false, playedOnly: false },
    { id: 'album', label: 'Album', sortBy: 'Album,ParentIndexNumber,IndexNumber,SortName', descending: false, playedOnly: false },
    { id: 'added', label: 'Recently added', sortBy: 'DateCreated,SortName', descending: true, playedOnly: false },
    { id: 'played', label: 'Most played', sortBy: 'PlayCount,SortName', descending: true, playedOnly: true },
    { id: 'random', label: 'Random', sortBy: 'Random', descending: false, playedOnly: false },
  ] as const;
  /** How many tracks "Play all" / "Shuffle" queue. */
  const QUEUE_LIMIT = 500;

  const app = getApp();
  const actions = useActions();
  let sortId = $state<string>(loadViewPrefs('songs', SORTS.map((s) => s.id)).sort ?? 'name');
  const sort = $derived(SORTS.find((s) => s.id === sortId) ?? SORTS[0]);

  const pager = $derived.by(() => {
    const s = sort;
    return new Pager(async (startIndex) => {
      const client = app.core.sessions.client;
      if (!client) throw new Error('Not signed in');
      return client.tracks({
        sortBy: s.sortBy,
        descending: s.descending,
        playedOnly: s.playedOnly,
        startIndex,
        limit: 60,
      });
    });
  });

  async function playAll(shuffle: boolean) {
    await actions.guard(async () => {
      const client = app.core.sessions.client;
      if (!client) throw new Error('Not signed in');
      const page = await client.tracks({
        sortBy: shuffle ? 'Random' : sort.sortBy,
        descending: shuffle ? false : sort.descending,
        playedOnly: shuffle ? false : sort.playedOnly,
        limit: QUEUE_LIMIT,
      });
      if (page.items.length > 0) await app.core.player.playQueue(page.items, { startIndex: 0 });
    });
  }
</script>

<section class="screen">
  <ScreenHeader title="Songs" subtitle={pager.total > 0 ? plural(pager.total, 'song') : undefined}>
    <Select
      label="Sort"
      options={SORTS}
      value={sortId}
      onchange={(id) => {
        sortId = id;
        saveViewPrefs('songs', { sort: id });
      }}
    />
    <Button icon="play" primary onclick={() => void playAll(false)}>Play all</Button>
    <Button icon="shuffle" onclick={() => void playAll(true)}>Shuffle</Button>
  </ScreenHeader>
  <PagedTrackList {pager} onplay={(i) => void actions.playTracks(pager.items, i)} empty="No songs found." />
</section>
