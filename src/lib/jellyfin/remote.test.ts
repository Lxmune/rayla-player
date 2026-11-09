import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DownloadsStore } from '../downloads/store.svelte';
import { memoryKv } from '../platform';
import { PlayerController } from '../player/controller.svelte';
import { EngineErrors } from '../player/errors.svelte';
import { SettingsStore } from '../settings/store.svelte';
import {
  FakeDownloadsEngine,
  FakeEngine,
  FakeHttp,
  fakeClient,
  fakeSocketFactory,
  flush,
  track,
  trackJson,
} from '../test-support';
import { JellyfinRemote, RemoteController, remoteBackoff } from './remote';

describe('remoteBackoff', () => {
  it('doubles and caps at 60 s', () => {
    expect([0, 1, 2, 3, 4, 5, 6, 7, 8].map((i) => remoteBackoff(i) / 1000)).toEqual([
      1, 2, 4, 8, 16, 32, 60, 60, 60,
    ]);
  });
});

describe('JellyfinRemote', () => {
  let engine: FakeEngine;
  let http: FakeHttp;
  let player: PlayerController;
  let settings: SettingsStore;
  let sockets: ReturnType<typeof fakeSocketFactory>;
  let remote: JellyfinRemote;

  beforeEach(async () => {
    engine = new FakeEngine();
    http = new FakeHttp({
      'POST /Sessions/Capabilities/Full': {},
      'POST /Sessions/Playing': {},
      'POST /Sessions/Playing/Progress': {},
      'POST /Sessions/Playing/Stopped': {},
      'GET /Items': { Items: [trackJson('a', 'A'), trackJson('b', 'B'), trackJson('c', 'C')] },
    });
    const client = fakeClient(http);
    const errors = new EngineErrors();
    settings = new SettingsStore({ kv: memoryKv(), engine, errors });
    const downloads = new DownloadsStore({ engine: new FakeDownloadsEngine(), client: () => client });
    player = new PlayerController({ engine, client: () => client, settings, downloads, errors });
    await player.attach();
    sockets = fakeSocketFactory();
    remote = new JellyfinRemote({
      client,
      player,
      volume: () => settings.current.dsp.volume,
      shuffled: () => player.shuffle,
      setVolume: (v) => settings.updateDsp({ volume: v }),
      connect: sockets.factory,
      backoff: () => 0,
    });
    await remote.start();
  });
  afterEach(async () => {
    await remote.stop();
    vi.useRealTimers();
  });

  /** Sends a server frame and waits until the command has executed. */
  async function send(type: string, data?: unknown) {
    sockets.last?.push(type, data);
    await remote.idle;
    await flush();
  }

  it('registers capabilities and opens the socket with key and device', () => {
    expect(http.paths[0]).toBe('/Sessions/Capabilities/Full');
    expect(sockets.urls).toEqual(['wss://jf.test/socket?api_key=tok&deviceId=dev123']);
    expect(remote.running).toBe(true);
  });

  it('ForceKeepAlive is answered with KeepAlive', async () => {
    await send('ForceKeepAlive', 60);
    expect(sockets.last?.sent).toEqual([{ MessageType: 'KeepAlive' }]);
  });

  it('keeps sending KeepAlive at half the requested interval', async () => {
    vi.useFakeTimers();
    sockets.last?.push('ForceKeepAlive', 4);
    await vi.advanceTimersByTimeAsync(1);
    expect(sockets.last?.sent).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(sockets.last?.sent).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(2000);
    expect(sockets.last?.sent).toHaveLength(3);
  });

  it('malformed and unknown messages are ignored', async () => {
    sockets.last?.pushRaw('not json');
    sockets.last?.pushRaw('42');
    remote.onMessage(42);
    await send('SomethingElse', {});
    await send('Play', { ItemIds: [] });
    await send('Play', 'not an object');
    expect(player.queue).toEqual([]);
  });

  it('Play PlayNow loads the items in order from StartIndex', async () => {
    await send('Play', { ItemIds: ['a', 'b', 'c'], StartIndex: 1, PlayCommand: 'PlayNow' });
    expect(player.queue.map((e) => e.item.id)).toEqual(['a', 'b', 'c']);
    expect(player.current?.id).toBe('b');
    expect(http.requests.find((r) => r.path === '/Items')?.query['Ids']).toBe('a,b,c');
  });

  it('Play PlayNow honours StartPositionTicks', async () => {
    await send('Play', { ItemIds: ['a'], PlayCommand: 'PlayNow', StartPositionTicks: 30000000 });
    expect(engine.calls).toContain('seek(3000)');
  });

  it('PlayNext and PlayLast insert into the queue', async () => {
    await player.playQueue([track('x'), track('y')]);
    await send('Play', { ItemIds: ['a'], PlayCommand: 'PlayNext' });
    await send('Play', { ItemIds: ['c'], PlayCommand: 'PlayLast' });
    expect(player.queue.map((e) => e.item.id)).toEqual(['x', 'a', 'y', 'c']);
  });

  it('PlayShuffle starts a shuffled queue', async () => {
    await send('Play', { ItemIds: ['a', 'b', 'c'], PlayCommand: 'PlayShuffle' });
    expect(player.shuffle).toBe(true);
    expect(player.queue).toHaveLength(3);
  });

  it('PlayInstantMix plays the mix of the first item', async () => {
    http.routes['GET /Items/a/InstantMix'] = { Items: [trackJson('m1', 'M1'), trackJson('m2', 'M2')] };
    await send('Play', { ItemIds: ['a'], PlayCommand: 'PlayInstantMix' });
    expect(player.queue.map((e) => e.item.id)).toEqual(['m1', 'm2']);
  });

  it('Playstate commands drive the player', async () => {
    await player.playQueue([track('a'), track('b')]);
    engine.calls.length = 0;
    engine.state('playing');

    await send('Playstate', { Command: 'Pause' });
    await send('Playstate', { Command: 'Unpause' });
    await send('Playstate', { Command: 'Seek', SeekPositionTicks: 125000000 });
    expect(engine.calls).toEqual(['pause', 'play', 'seek(12500)']);

    await send('Playstate', { Command: 'NextTrack' });
    expect(player.current?.id).toBe('b');
    await send('Playstate', { Command: 'Stop' });
    expect(engine.calls[engine.calls.length - 1]).toBe('stop');
    expect(player.playback).toBe('stopped');
  });

  it('PlayPause toggles', async () => {
    await player.playQueue([track('a')]);
    engine.state('playing');
    await send('Playstate', { Command: 'PlayPause' });
    expect(engine.calls[engine.calls.length - 1]).toBe('pause');
  });

  it('pushes a progress report after handling a command', async () => {
    await player.playQueue([track('a')]);
    const before = http.paths.filter((p) => p === '/Sessions/Playing/Progress').length;
    await send('Playstate', { Command: 'Pause' });
    expect(http.paths.filter((p) => p === '/Sessions/Playing/Progress').length).toBe(before + 1);
  });

  it('SetVolume, mute toggling and repeat/shuffle commands', async () => {
    await send('GeneralCommand', { Name: 'SetVolume', Arguments: { Volume: '35' } });
    expect(settings.current.dsp.volume).toBeCloseTo(0.35, 9);
    expect(engine.lastDsp?.volume).toBeCloseTo(0.35, 6);

    await send('GeneralCommand', { Name: 'ToggleMute' });
    expect(settings.current.dsp.volume).toBe(0);
    await send('GeneralCommand', { Name: 'ToggleMute' });
    expect(settings.current.dsp.volume).toBeCloseTo(0.35, 9);

    await send('GeneralCommand', { Name: 'SetVolume', Arguments: { Volume: '250' } });
    expect(settings.current.dsp.volume).toBe(1);
    await send('GeneralCommand', { Name: 'VolumeDown' });
    expect(settings.current.dsp.volume).toBeCloseTo(0.95, 9);
    await send('GeneralCommand', { Name: 'Mute' });
    expect(settings.current.dsp.volume).toBe(0);
    await send('GeneralCommand', { Name: 'Unmute' });
    expect(settings.current.dsp.volume).toBeCloseTo(0.95, 9);
    await send('GeneralCommand', { Name: 'SetVolume', Arguments: { Volume: 'loud' } });
    expect(settings.current.dsp.volume).toBeCloseTo(0.95, 9);

    await send('GeneralCommand', { Name: 'SetRepeatMode', Arguments: { RepeatMode: 'RepeatOne' } });
    expect(player.repeat).toBe('one');

    await player.playQueue([track('a'), track('b')]);
    await send('GeneralCommand', { Name: 'SetShuffleQueue', Arguments: { ShuffleMode: 'Shuffle' } });
    expect(player.shuffle).toBe(true);
    await send('GeneralCommand', { Name: 'SetShuffleQueue', Arguments: { ShuffleMode: 'Sorted' } });
    expect(player.shuffle).toBe(false);
  });

  it('reconnects with backoff after the socket closes', async () => {
    const first = sockets.last;
    first?.drop();
    await flush(10);
    expect(sockets.sockets).toHaveLength(2);
    expect(sockets.urls[1]).toBe(sockets.urls[0]);
    // The old socket is dead; the new one serves commands.
    first?.push('Play', { ItemIds: ['a'] });
    await send('Play', { ItemIds: ['a'] });
    expect(player.current?.id).toBe('a');
  });

  it('retries with growing delays while the server is unreachable', async () => {
    await remote.stop();
    vi.useFakeTimers();
    http.routes = {}; // capabilities now 404 -> every open attempt fails
    const delays: number[] = [];
    const r = new JellyfinRemote({
      client: fakeClient(http),
      player,
      volume: () => 1,
      shuffled: () => false,
      setVolume: async () => {},
      connect: sockets.factory,
      backoff: (n) => {
        delays.push(remoteBackoff(n));
        return remoteBackoff(n);
      },
    });
    await r.start();
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(4000);
    expect(delays).toEqual([1000, 2000, 4000, 8000]);
    await r.stop();
    const attempts = http.requests.length;
    await vi.advanceTimersByTimeAsync(60000);
    expect(http.requests.length).toBe(attempts); // stopped: no more retries
  });

  it('stop closes the socket and ignores later frames', async () => {
    const sock = sockets.last;
    await remote.stop();
    expect(sock?.closed).toBe(true);
    expect(remote.running).toBe(false);
    sock?.push('Play', { ItemIds: ['a'] });
    await remote.idle;
    expect(player.queue).toEqual([]);
  });
});

describe('RemoteController', () => {
  it('starts a remote per client and stops the previous one', async () => {
    const created: JellyfinRemote[] = [];
    const sockets = fakeSocketFactory();
    const http = new FakeHttp({ 'POST /Sessions/Capabilities/Full': {} });
    const player = {} as PlayerController;
    const ctl = new RemoteController((client) => {
      const r = new JellyfinRemote({
        client,
        player,
        volume: () => 1,
        shuffled: () => false,
        setVolume: async () => {},
        connect: sockets.factory,
      });
      created.push(r);
      return r;
    });
    expect(ctl.running).toBe(false);
    await ctl.sync(fakeClient(http));
    expect(ctl.running).toBe(true);
    await ctl.sync(fakeClient(http));
    expect(created).toHaveLength(2);
    expect(created[0]?.running).toBe(false);
    expect(sockets.sockets[0]?.closed).toBe(true);
    await ctl.stop();
    expect(ctl.running).toBe(false);
    expect(ctl.current).toBeNull();
  });
});
