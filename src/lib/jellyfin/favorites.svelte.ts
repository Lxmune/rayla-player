// Favorite flags changed in this session, layered over what the server sent.

import type { JellyfinClient } from './client';
import type { BaseItem } from './models';

export class FavoritesStore {
  /** Item id -> flag, for items toggled this session. */
  overrides = $state.raw<Readonly<Record<string, boolean>>>({});

  constructor(private readonly client: () => JellyfinClient | null) {}

  isFavorite(item: BaseItem): boolean {
    return this.overrides[item.id] ?? item.isFavorite;
  }

  /** Flips the flag on the server, then locally. Throws when signed out or the request fails. */
  async toggle(item: BaseItem): Promise<boolean> {
    const client = this.client();
    if (!client) throw new Error('Not signed in');
    const value = !this.isFavorite(item);
    await client.setFavorite(item.id, value);
    this.overrides = { ...this.overrides, [item.id]: value };
    return value;
  }
}
