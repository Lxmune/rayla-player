// Shared live device list for the output picker, the settings section and Now Playing.

import { listOutputDevices, onOutputDevicesChanged } from '../../lib/outputs';
import type { OutputDevice } from '../../lib/ipc';
import { errorMessage } from '../../lib/player/errors.svelte';
import type { IconName } from '../common/icons';
import { formatSampleRate } from '../../lib/jellyfin/models';

export class OutputDevices {
  devices = $state.raw<OutputDevice[]>([]);
  loading = $state(true);
  error = $state<string | null>(null);
  private unsub: (() => void) | null = null;
  private disposed = false;

  /** Loads the list and subscribes to changes. Call `dispose()` when done. */
  async start(): Promise<void> {
    void onOutputDevicesChanged(() => void this.refresh())
      .then((u) => {
        if (this.disposed) u();
        else this.unsub = u;
      })
      .catch(() => {});
    await this.refresh();
  }

  async refresh(): Promise<void> {
    try {
      const list = await listOutputDevices();
      if (this.disposed) return;
      this.devices = list;
      this.error = null;
    } catch (e) {
      if (this.disposed) return;
      this.error = errorMessage(e);
    }
    this.loading = false;
  }

  dispose(): void {
    this.disposed = true;
    this.unsub?.();
    this.unsub = null;
  }

  get defaultDevice(): OutputDevice | null {
    return this.devices.find((d) => d.isDefault) ?? null;
  }

  /** The device selected by `id` (null = system default); null when it is gone. */
  find(id: string | null): OutputDevice | null {
    return id === null ? this.defaultDevice : (this.devices.find((d) => d.id === id) ?? null);
  }
}

export function deviceIcon(name: string): IconName {
  const n = name.toLowerCase();
  if (/bluetooth|buds|airpods|\bbt\b|a2dp/.test(n)) return 'bluetooth';
  if (/hdmi|displayport|\btv\b|monitor/.test(n)) return 'hdmi';
  if (/usb|dac|\bamp\b/.test(n)) return 'usb';
  if (/head(phone|set)|earphone|earbud|wired|\bbuds\b|\bin-ear/.test(n)) return 'headphones';
  return 'speaker';
}

export function describeDevice(d: OutputDevice): string {
  const parts: string[] = [];
  if (d.sampleRates.length > 0) {
    const hi = Math.max(...d.sampleRates);
    parts.push(`up to ${formatSampleRate(hi)}`);
  }
  if (d.maxBitDepth > 0) parts.push(`${d.maxBitDepth}-bit`);
  if (d.supportsExclusive) parts.push('exclusive capable');
  return parts.join(' · ');
}
