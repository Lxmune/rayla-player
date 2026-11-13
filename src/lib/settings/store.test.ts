import { describe, expect, it } from 'vitest';
import { memoryKv } from '../platform';
import { EngineErrors } from '../player/errors.svelte';
import { FakeEngine } from '../test-support';
import { DEFAULT_APPEARANCE, DEFAULT_BEHAVIOR, DEFAULT_DISCORD, DEFAULT_DSP, DEFAULT_SETTINGS } from './types';
import { SETTINGS_KEY, SettingsStore, loadSettings, parseSettings } from './store.svelte';

function make(kv = memoryKv()) {
  const engine = new FakeEngine();
  const errors = new EngineErrors();
  const store = new SettingsStore({ kv, engine, errors });
  return { kv, engine, errors, store };
}

describe('settings parsing', () => {
  it('missing, corrupt or non-object storage yields defaults', () => {
    expect(loadSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(loadSettings('{nope')).toEqual(DEFAULT_SETTINGS);
    expect(loadSettings('[1,2]')).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings(42)).toEqual(DEFAULT_SETTINGS);
  });

  it('unknown enum values and wrong types fall back to defaults', () => {
    const s = parseSettings({
      themeMode: 'neon',
      exclusive: 'yes',
      maxBitrate: '192000',
      outputDeviceId: 7,
      dsp: {
        replayGain: 'bogus',
        crossfeed: 'extreme',
        dither: 'x',
        dsd: 'y',
        volume: 'loud',
        eqBands: [
          { kind: 'nope', freqHz: 100, gainDb: 1, q: 1 },
          { kind: 'peak', freqHz: 'x', gainDb: 1, q: 1 },
          'junk',
        ],
      },
      discord: { enabled: 1, buttons: 'x' },
    });
    expect(s.themeMode).toBe('dark');
    expect(s.exclusive).toBe(false);
    expect(s.maxBitrate).toBeNull();
    expect(s.outputDeviceId).toBeNull();
    expect(s.dsp.replayGain).toBe('off');
    expect(s.dsp.crossfeed).toBe('off');
    expect(s.dsp.dither).toBe('off');
    expect(s.dsp.dsd).toBe('dop');
    expect(s.dsp.volume).toBe(1);
    expect(s.dsp.eqBands).toEqual([{ kind: 'peak', freqHz: 100, gainDb: 1, q: 1 }]);
    expect(s.discord).toEqual(DEFAULT_DISCORD);
  });

  it('compressor: missing in old settings means off, out-of-range values are clamped', () => {
    expect(parseSettings({ dsp: {} }).dsp.compressor).toEqual(DEFAULT_DSP.compressor);
    const c = parseSettings({
      dsp: { compressor: { enabled: true, thresholdDb: -99, ratio: 0.5, attackMs: 'x', releaseMs: 5000, makeupDb: 3 } },
    }).dsp.compressor;
    expect(c).toEqual({ enabled: true, thresholdDb: -60, ratio: 1, attackMs: 10, releaseMs: 2000, makeupDb: 3 });
  });

  it('parsed defaults do not share mutable arrays with the constants', () => {
    const s = parseSettings({});
    expect(s.dsp.eqBands).not.toBe(DEFAULT_DSP.eqBands);
    expect(s.discord.buttons).not.toBe(DEFAULT_DISCORD.buttons);
  });
});

describe('SettingsStore', () => {
  it('settings round trip through the key/value store', async () => {
    const { store, kv } = make();
    await store.setOutput('dac', true);
    await store.setMaxBitrate(192000);
    await store.setThemeMode('light');
    await store.updateDsp((d) => ({
      ...d,
      replayGain: 'album',
      preampDb: -2.5,
      eqEnabled: true,
      eqBands: [{ kind: 'lowShelf', freqHz: 80, gainDb: 3, q: 0.7 }],
      convolutionPath: '/tmp/ir.wav',
      crossfeed: 'medium',
      resampleTo: 96000,
      dither: 'tpdf',
      crossfadeMs: 4000,
      dsd: 'pcm',
    }));
    await store.setScrobbleListenBrainz(true);
    await store.setScrobbleLastFm(true);
    await store.updateDiscord({
      enabled: true,
      applicationId: '42',
      details: '{title} / {format}',
      showCover: true,
      publicUrl: 'https://jf.example',
      buttons: [{ label: 'Go', url: 'https://x' }, { label: '', url: '' }],
    });
    const before = store.current;
    const restored = loadSettings(kv.get(SETTINGS_KEY));
    expect(restored).toEqual(before);
    expect(restored.outputDeviceId).toBe('dac');
    expect(restored.maxBitrate).toBe(192000);
    expect(restored.dsp.dsd).toBe('pcm');
    expect(restored.dsp.convolutionPath).toBe('/tmp/ir.wav');
    expect(restored.scrobbleListenBrainz && restored.scrobbleLastFm).toBe(true);
    expect(restored.discord.details).toBe('{title} / {format}');
    expect(restored.discord.buttons).toHaveLength(2);
    expect(restored.discord.buttons[0]?.label).toBe('Go');

    // A fresh store over the same storage starts from what was saved.
    expect(make(kv).store.current).toEqual(before);
  });

  it('a short saved button list is padded to two slots', () => {
    expect(parseSettings({ discord: { showElapsed: false } }).discord.time).toBe('off');
    expect(parseSettings({ discord: { showElapsed: true } }).discord.time).toBe('bar');
    const s = parseSettings({ discord: { buttons: [{ label: 'Go', url: 'u' }] } });
    expect(s.discord.buttons).toEqual([{ label: 'Go', url: 'u' }, { label: '', url: '' }]);
  });

  it('changes are pushed to the engine; startup pushes everything', async () => {
    const { store, engine } = make();
    await store.pushToEngine();
    expect(engine.calls).toEqual(['setOutput(null,false)', 'setDsp']);
    await store.updateDsp({ volume: 0.5 });
    expect(engine.lastDsp?.volume).toBe(0.5);
    await store.setOutput('dac', true);
    expect(engine.calls[engine.calls.length - 1]).toBe('setOutput(dac,true)');
  });

  it('updateDsp accepts a partial or a function and never mutates the old value', async () => {
    const { store } = make();
    const before = store.current;
    await store.updateDsp({ volume: 0.3 });
    await store.updateDsp((d) => ({ ...d, preampDb: d.volume }));
    expect(store.current.dsp.preampDb).toBe(0.3);
    expect(before.dsp.volume).toBe(1);
    expect(DEFAULT_SETTINGS.dsp.volume).toBe(1);
  });

  it('is persisted even when the engine rejects; the failure is reported', async () => {
    const { store, engine, errors, kv } = make();
    engine.rejectSettings = 'device busy';
    await store.setOutput('dac', true);
    expect(errors.message).toBe('device busy');
    expect(loadSettings(kv.get(SETTINGS_KEY)).outputDeviceId).toBe('dac');
    errors.clear();
    await store.updateDsp({ volume: 0.2 });
    expect(errors.message).toBe('device busy');
    expect(loadSettings(kv.get(SETTINGS_KEY)).dsp.volume).toBe(0.2);
  });

  it('pushToEngine failure is reported, not thrown', async () => {
    const { store, engine, errors } = make();
    engine.rejectSettings = 'no device';
    await store.pushToEngine();
    expect(errors.message).toBe('no device');
  });

  it('onChange fires with the new and previous settings until unsubscribed', async () => {
    const { store } = make();
    const seen: [number | null, number | null][] = [];
    const off = store.onChange((s, prev) => seen.push([s.maxBitrate, prev.maxBitrate]));
    await store.setMaxBitrate(128000);
    off();
    await store.setMaxBitrate(null);
    expect(seen).toEqual([[128000, null]]);
  });
  it('parses appearance and behavior defensively and persists updates', async () => {
    const parsed = loadSettings(
      JSON.stringify({
        appearance: { accentColor: 'red', density: 'tiny', accentFromCover: false },
        behavior: { startScreen: 'nowhere', resumePlayback: false },
      }),
    );
    expect(parsed.appearance).toEqual({ ...DEFAULT_APPEARANCE, accentFromCover: false });
    expect(parsed.behavior).toEqual({ ...DEFAULT_BEHAVIOR, resumePlayback: false });

    const { store, kv } = make();
    await store.updateAppearance({ accentColor: '#ABCDEF', density: 'compact' });
    await store.updateBehavior({ startScreen: 'albums' });
    const saved = loadSettings(kv.get(SETTINGS_KEY));
    expect(saved.appearance.accentColor).toBe('#abcdef');
    expect(saved.appearance.density).toBe('compact');
    expect(saved.behavior.startScreen).toBe('albums');
  });

  it('parses streaming settings, clamps prefetch and persists updates', async () => {
    expect(loadSettings(JSON.stringify({ maxBitrate: 128000 })).streaming).toEqual({
      codec: 'aac', adaptive: false, prefetchTracks: 2, cacheLimitMb: 3072,
      mobileCapEnabled: false, mobileMaxBitrate: 320000,
    });
    const odd = loadSettings(JSON.stringify({ streaming: { codec: 'ogg', adaptive: true, prefetchTracks: 99.7 } }));
    expect(odd.streaming).toEqual({ codec: 'aac', adaptive: true, prefetchTracks: 5, cacheLimitMb: 3072, mobileCapEnabled: false, mobileMaxBitrate: 320000 });
    expect(parseSettings({ streaming: { prefetchTracks: -3 } }).streaming.prefetchTracks).toBe(0);
    const { store, kv } = make();
    await store.updateStreaming({ codec: 'mp3', prefetchTracks: 4 });
    expect(loadSettings(kv.get(SETTINGS_KEY)).streaming).toEqual({ codec: 'mp3', adaptive: false, prefetchTracks: 4, cacheLimitMb: 3072, mobileCapEnabled: false, mobileMaxBitrate: 320000 });
  });

  it('pushes the cache limit to the engine at startup and on change', async () => {
    const { store, engine } = make();
    await store.pushToEngine();
    expect(engine.cacheLimitBytes).toBe(3072 * 1024 * 1024);
    await store.updateStreaming({ cacheLimitMb: 512 });
    expect(engine.cacheLimitBytes).toBe(512 * 1024 * 1024);
    engine.cacheLimitBytes = null;
    await store.updateStreaming({ prefetchTracks: 1 });
    expect(engine.cacheLimitBytes).toBeNull();
  });
});

describe('settings: playback, mobile cap, per-device DSP, transient DSP', () => {
  it('validates mobile cap and playback fields', () => {
    const st = parseSettings({
      streaming: { mobileCapEnabled: true, mobileMaxBitrate: null },
      playback: { crossfadeMode: 'bogus', resumeLongTracksMin: 9999.5, sleepFadeOut: 'x' },
    });
    expect(st.streaming.mobileCapEnabled).toBe(true);
    expect(st.streaming.mobileMaxBitrate).toBeNull();
    expect(parseSettings({ streaming: { mobileMaxBitrate: -5 } }).streaming.mobileMaxBitrate).toBe(320000);
    expect(parseSettings({ streaming: { mobileMaxBitrate: 128000.9 } }).streaming.mobileMaxBitrate).toBe(128000);
    expect(st.playback).toEqual({ crossfadeMode: 'always', resumeLongTracksMin: 600, sleepFadeOut: true });
    expect(parseSettings({ playback: { resumeLongTracksMin: -3 } }).playback.resumeLongTracksMin).toBe(0);
  });

  it('updatePlayback persists', async () => {
    const { store, kv } = make();
    await store.updatePlayback({ crossfadeMode: 'shuffle', resumeLongTracksMin: 30 });
    const saved = loadSettings(kv.get(SETTINGS_KEY)).playback;
    expect(saved).toEqual({ crossfadeMode: 'shuffle', resumeLongTracksMin: 30, sleepFadeOut: true });
  });

  it('shuffle crossfade mode zeroes crossfade unless allowed, and re-pushes on change', async () => {
    const { store, engine } = make();
    let allowed = false;
    store.setCrossfadeGate(() => allowed);
    await store.updateDsp({ crossfadeMs: 4000 });
    expect(engine.lastDsp?.crossfadeMs).toBe(4000); // mode 'always'
    await store.updatePlayback({ crossfadeMode: 'shuffle' });
    await store.pushToEngine();
    expect(engine.lastDsp?.crossfadeMs).toBe(0);
    expect(store.current.dsp.crossfadeMs).toBe(4000); // saved value untouched
    allowed = true;
    await store.refreshDsp();
    expect(engine.lastDsp?.crossfadeMs).toBe(4000);
    const n = engine.calls.length;
    await store.refreshDsp(); // nothing changed: no push
    expect(engine.calls.length).toBe(n);
  });

  it('refreshDsp does nothing before the first push', async () => {
    const { store, engine } = make();
    await store.refreshDsp();
    expect(engine.calls).toEqual([]);
  });

  it('volume scale is transient', async () => {
    const { store, engine, kv } = make();
    await store.pushToEngine();
    await store.updateDsp({ volume: 0.8 });
    await store.setVolumeScale(0.5);
    expect(engine.lastDsp?.volume).toBeCloseTo(0.4);
    expect(store.current.dsp.volume).toBe(0.8);
    expect(loadSettings(kv.get(SETTINGS_KEY)).dsp.volume).toBe(0.8);
    await store.updateDsp({ preampDb: 1 }); // an edit keeps the scale
    expect(engine.lastDsp?.volume).toBeCloseTo(0.4);
    await store.setVolumeScale(1);
    expect(engine.lastDsp?.volume).toBe(0.8);
  });

  it('per-device DSP: seeds, swaps on output change and edits the active device', async () => {
    const { store, engine, kv } = make();
    await store.updateDsp({ preampDb: -2 });
    await store.setPerDeviceDsp(true);
    expect(store.current.deviceDsp['']?.preampDb).toBe(-2);
    await store.setOutput('hp', false); // first use: seeded from the current chain
    expect(store.current.dsp.preampDb).toBe(-2);
    await store.updateDsp({ preampDb: -6 });
    expect(store.current.deviceDsp['hp']?.preampDb).toBe(-6);
    expect(store.current.deviceDsp['']?.preampDb).toBe(-2);
    await store.setOutput(null, false); // back: the default chain returns and is pushed
    expect(store.current.dsp.preampDb).toBe(-2);
    expect(engine.lastDsp?.preampDb).toBe(-2);
    await store.setOutput('hp', true);
    expect(engine.lastDsp?.preampDb).toBe(-6);
    // survives a restart
    const again = new SettingsStore({ kv, engine, errors: new EngineErrors() });
    expect(again.current.outputDeviceId).toBe('hp');
    expect(again.current.dsp.preampDb).toBe(-6);
  });

  it('per-device off keeps one shared chain', async () => {
    const { store } = make();
    await store.updateDsp({ preampDb: -2 });
    await store.setOutput('hp', false);
    await store.updateDsp({ preampDb: -4 });
    await store.setOutput(null, false);
    expect(store.current.dsp.preampDb).toBe(-4);
    expect(store.current.deviceDsp).toEqual({});
  });
});
