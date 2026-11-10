// Offline download quality presets (settings.downloads.quality).

import type { DownloadQuality, TranscodeCodec } from '../settings/types';

export interface DownloadPreset {
  label: string;
  /** null = the original file. */
  transcode: { codec: TranscodeCodec; maxBitrate: number } | null;
}

export const DOWNLOAD_PRESETS: Record<DownloadQuality, DownloadPreset> = {
  original: { label: 'Original file', transcode: null },
  'flac-cd': { label: 'FLAC 16/48 (lossless, CD quality)', transcode: { codec: 'flac', maxBitrate: 1_411_000 } },
  'mp3-320': { label: 'MP3 320 kbps', transcode: { codec: 'mp3', maxBitrate: 320_000 } },
  'aac-320': { label: 'AAC 320 kbps', transcode: { codec: 'aac', maxBitrate: 320_000 } },
  'aac-256': { label: 'AAC 256 kbps', transcode: { codec: 'aac', maxBitrate: 256_000 } },
  'aac-192': { label: 'AAC 192 kbps', transcode: { codec: 'aac', maxBitrate: 192_000 } },
  'mp3-192': { label: 'MP3 192 kbps', transcode: { codec: 'mp3', maxBitrate: 192_000 } },
  'aac-128': { label: 'AAC 128 kbps', transcode: { codec: 'aac', maxBitrate: 128_000 } },
  'aac-96': { label: 'AAC 96 kbps', transcode: { codec: 'aac', maxBitrate: 96_000 } },
  'aac-64': { label: 'AAC 64 kbps (smallest)', transcode: { codec: 'aac', maxBitrate: 64_000 } },
};
