// FROZEN: thin seams over Tauri plugins and browser storage. Logic modules
// take these as injectable parameters so Vitest can substitute fakes.

import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import TauriWebSocket from '@tauri-apps/plugin-websocket';
import { open } from '@tauri-apps/plugin-dialog';

/** fetch() routed through Rust: no CORS limits (Jellyfin, Last.fm, ListenBrainz, cover bytes). */
export type HttpFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
export const httpFetch: HttpFetch = (input, init) => tauriFetch(input, init);

export interface Socket {
  send(text: string): Promise<void>;
  close(): Promise<void>;
}

/** Opens a text websocket. `onClose` fires once when the remote side closes or errors. */
export type SocketFactory = (
  url: string,
  onMessage: (text: string) => void,
  onClose: () => void,
) => Promise<Socket>;

export const openSocket: SocketFactory = async (url, onMessage, onClose) => {
  const ws = await TauriWebSocket.connect(url);
  let closed = false;
  const fireClose = () => {
    if (!closed) {
      closed = true;
      onClose();
    }
  };
  ws.addListener((msg) => {
    if (msg.type === 'Text') onMessage(msg.data);
    else if (msg.type === 'Close') fireClose();
  });
  return {
    send: (text) => ws.send(text),
    close: async () => {
      closed = true;
      await ws.disconnect();
    },
  };
};

/** Synchronous persisted key/value store (non-secret settings, queues). */
export interface KeyValueStore {
  get(key: string): string | null;
  set(key: string, value: string | null): void;
}

export const localKv: KeyValueStore = {
  get: (key) => {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set: (key, value) => {
    try {
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    } catch {
      /* storage unavailable: setting is not persisted */
    }
  },
};

export function memoryKv(): KeyValueStore {
  const m = new Map<string, string>();
  return {
    get: (k) => m.get(k) ?? null,
    set: (k, v) => (v === null ? m.delete(k) : m.set(k, v)),
  };
}

/** Native file picker. Returns an absolute path or null when cancelled. */
export async function pickFile(name: string, extensions: string[]): Promise<string | null> {
  const r = await open({ multiple: false, directory: false, filters: [{ name, extensions }] });
  return typeof r === 'string' ? r : null;
}
