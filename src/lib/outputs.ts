// The output-device list for the UI. Desktop asks the engine; Android asks the
// OS (AudioManager) through the rayla-android plugin, since AAudio can't
// enumerate. Ids from either source go straight to `settings.setOutput`.

import { isAndroid, listAudioOutputs, onAudioOutputsChanged } from './android';
import { ipc, type OutputDevice } from './ipc';

export function listOutputDevices(): Promise<OutputDevice[]> {
  return isAndroid ? listAudioOutputs() : ipc.listDevices();
}

/** Calls `cb` when devices appear or disappear (Android only today). */
export function onOutputDevicesChanged(cb: () => void): Promise<() => void> {
  return onAudioOutputsChanged(cb);
}
