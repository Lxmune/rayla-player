<script lang="ts">
  import { getApp } from '../../lib/app.svelte';
  import PagedGrid from '../common/PagedGrid.svelte';
  import ScreenHeader from '../common/ScreenHeader.svelte';
  import { Pager } from '../common/resource.svelte';
  import { getRouter } from '../shell/router.svelte';

  const app = getApp();
  const router = getRouter();
  const pager = $derived(
    new Pager(async (startIndex) => {
      const client = app.core.sessions.client;
      if (!client) throw new Error('Not signed in');
      return client.albumArtists({ startIndex, limit: 60 });
    }),
  );
</script>

<section class="screen">
  <ScreenHeader title="Artists" />
  <PagedGrid {pager} onopen={(i) => router.open(i)} empty="No artists yet." />
</section>
