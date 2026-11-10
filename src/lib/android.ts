// Bridge to the `rayla-android` Tauri plugin (src-tauri/plugins/rayla-android):
// a foreground media service with MediaSession + notification, media-button /
// "becoming noisy" actions, and Android audio output enumeration.
// FROZEN CONTRACT: command names, argument names and event payloads must match
// the plugin's Rust commands and Kotlin code. Off Android every call is a no-op.

import { addPluginListener, invoke, type PluginListener } from '@tauri-apps/api/core';
import type { OutputDevice } from './ipc';

const PLUGIN = 'rayla-android';

/** True inside the Android app (WebView user agent). */
export const isAndroid: boolean = typeof navigator !== 'undefined' && /\bAndroid\b/.test(navigator.userAgent);

export interface NowPlayingInfo {
  title: string;
  artist: string;
  album: string;
  /** Cover image URL (fetched natively for the notification); null for none. */
  artUrl: string | null;
  durationMs: number;
  positionMs: number;
  playing: boolean;
  canPrevious: boolean;
  canNext: boolean;
  /** Current track is a favourite (shows the like action filled). Optional for older callers. */
  liked?: boolean;
}

/** Sent by the notification, lock screen, headset buttons or the OS. */
export type MediaAction =
  | { type: 'play' }
  | { type: 'pause' }
  | { type: 'next' }
  | { type: 'previous' }
  | { type: 'stop' }
  | { type: 'seek'; positionMs: number }
  /** Headphones unplugged / Bluetooth dropped: pause, per Android guidelines. */
  | { type: 'noisy' }
  /** Notification / lock-screen custom actions: toggle favourite, or "not for me" (skip + learn). */
  | { type: 'like' }
  | { type: 'dislike' };

/** Starts (or updates) the foreground media service and its notification. */
export async function updateNowPlaying(info: NowPlayingInfo): Promise<void> {
  if (!isAndroid) return;
  await invoke(`plugin:${PLUGIN}|update_now_playing`, { info });
}

/** Removes the notification and stops the foreground service. */
export async function clearNowPlaying(): Promise<void> {
  if (!isAndroid) return;
  await invoke(`plugin:${PLUGIN}|clear_now_playing`);
}

/** Current outputs (AudioManager.getDevices). `id` is the AudioDeviceInfo id as a string. */
export async function listAudioOutputs(): Promise<OutputDevice[]> {
  if (!isAndroid) return [];
  return invoke<OutputDevice[]>(`plugin:${PLUGIN}|list_audio_outputs`);
}

const noop = () => {};

async function listen<T>(event: string, cb: (payload: T) => void): Promise<() => void> {
  if (!isAndroid) return noop;
  const l: PluginListener = await addPluginListener<T>(PLUGIN, event, cb);
  return () => void l.unregister();
}

/** Event `media-action`, payload `MediaAction`. */
export const onMediaAction = (cb: (a: MediaAction) => void) => listen<MediaAction>('media-action', cb);

/** Event `outputs-changed` (device plugged / unplugged), empty payload. */
export const onAudioOutputsChanged = (cb: () => void) => listen<unknown>('outputs-changed', () => cb());

// ------------------------------------------------------------ system bars

/** System bar sizes in CSS px. The app draws under the status bar; navigation bar and keyboard are padded natively. */
export interface SystemInsets {
  top: number;
}

export async function getSystemInsets(): Promise<SystemInsets> {
  if (!isAndroid) return { top: 0 };
  return invoke<SystemInsets>(`plugin:${PLUGIN}|get_system_insets`);
}

/** Event `insets-changed` (rotation, cutout, multi-window), payload `SystemInsets`. */
export const onSystemInsetsChanged = (cb: (i: SystemInsets) => void) => listen<SystemInsets>('insets-changed', cb);

/**
 * Status / navigation bar look: dark icons over a light app (`lightBackground`), light icons
 * otherwise; `background` (#rrggbb) fills the window behind the bars (e.g. the gesture bar).
 */
export async function setSystemBars(style: { lightBackground: boolean; background: string }): Promise<void> {
  if (!isAndroid) return;
  await invoke(`plugin:${PLUGIN}|set_system_bars`, style);
}

// ---------------------------------------------------------------- network

/** `other` also covers desktop/unknown; only `cellular` counts as metered. */
export type NetworkType = 'wifi' | 'ethernet' | 'cellular' | 'none' | 'other';

export async function getNetworkType(): Promise<NetworkType> {
  if (!isAndroid) return 'other';
  return (await invoke<{ type: NetworkType }>(`plugin:${PLUGIN}|get_network_type`)).type;
}

/** Event `network-changed`, payload `{ type: NetworkType }`. */
export const onNetworkChanged = (cb: (type: NetworkType) => void) =>
  listen<{ type: NetworkType }>('network-changed', (p) => cb(p.type));

// --------------------------------------------------- background playback

/** Whether Android exempts the app from battery optimisation (true off Android). */
export async function isIgnoringBatteryOptimizations(): Promise<boolean> {
  if (!isAndroid) return true;
  return (await invoke<{ value: boolean }>(`plugin:${PLUGIN}|is_ignoring_battery_optimizations`)).value;
}

/** Opens the system prompt to exempt the app from battery optimisation. */
export async function requestIgnoreBatteryOptimizations(): Promise<void> {
  if (!isAndroid) return;
  await invoke(`plugin:${PLUGIN}|request_ignore_battery_optimizations`);
}

// ---------------------------------------------------------------- storage

/** A place offline downloads can go: app-specific folders on internal storage and SD cards. */
export interface StorageVolume {
  /** Absolute directory path (writable by the app without permissions). */
  path: string;
  label: string;
  removable: boolean;
  freeBytes: number;
  totalBytes: number;
}

export async function listStorageVolumes(): Promise<StorageVolume[]> {
  if (!isAndroid) return [];
  return (await invoke<{ volumes: StorageVolume[] }>(`plugin:${PLUGIN}|list_storage_volumes`)).volumes;
}
