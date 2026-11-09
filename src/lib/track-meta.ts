// FROZEN: the narrow view of a track that integrations (scrobbling, Discord)
// consume. src/lib/jellyfin/models.ts provides `toTrackMeta(item)`.

export interface TrackMeta {
  /** Jellyfin item id. */
  id: string;
  albumId: string | null;
  /** Item whose Primary image is the cover (track or album), or null. */
  imageItemId: string | null;
  title: string;
  artists: string[];
  album: string | null;
  albumArtist: string | null;
  year: number | null;
  trackNumber: number | null;
  durationMs: number;
  /** From Jellyfin media info; the engine SignalPath is preferred when known. */
  container: string | null;
  codec: string | null;
  sampleRate: number | null;
  bitDepth: number | null;
  /** bits per second */
  bitrate: number | null;
}
