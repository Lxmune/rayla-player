// Desktop OS media controls (media keys, Windows SMTC, macOS Now Playing, Linux MPRIS)
// as a `MediaBridge` for `MediaSession`; the Rust side is src-tauri/src/media_controls.rs.

import { isAndroid } from './android';
import { ipc } from './ipc';
import type { MediaBridge } from './integrations/media-session';

/** True inside the Tauri desktop shell (not Android, not a plain browser/test run). */
export const isDesktop: boolean =
  typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window && !isAndroid;

export const desktopMediaBridge: MediaBridge = {
  updateNowPlaying: (info) => ipc.mediaUpdateNowPlaying(info),
  clearNowPlaying: () => ipc.mediaClearNowPlaying(),
  onMediaAction: (cb) => ipc.onMediaAction(cb),
};
