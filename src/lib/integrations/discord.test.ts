import { beforeEach, describe, expect, it } from 'vitest';
import type { DiscordActivity, PlaybackState, SignalPath } from '../ipc';
import { DEFAULT_DISCORD, type DiscordSettings } from '../settings/types';
import { DiscordPresence, type PresenceObservation } from './discord-presence';
import {
  coverUrl,
  discordVars,
  formatClock,
  formatSignal,
  renderPresence,
  renderTemplate,
} from './discord-template';
import { meta } from './test-helpers';

const sp = (codec: string, rate: number, depth: number): SignalPath => ({
  codec,
  sourceSampleRate: rate,
  sourceBitDepth: depth,
  channels: 2,
  stages: [],
  deviceName: '',
  outputSampleRate: rate,
  outputBitDepth: depth,
  exclusive: false,
  bitPerfect: true,
});

const m = meta({
  artists: ['Massive Attack', 'Elizabeth Fraser'],
  codec: 'mp3',
  sampleRate: 48000,
  bitDepth: 0,
});

describe('templates', () => {
  const vars = (signal: SignalPath | null = sp('flac', 96000, 24), url = '') =>
    discordVars({ meta: m, signal, positionMs: 65_000, durationMs: 329_000, publicUrl: url });

  it('renders all placeholders, preferring the signal path', () => {
    expect(
      renderTemplate(
        '{title}|{artist}|{album}|{albumArtist}|{year}|{format}|{codec}|{rate}|{bitDepth}|{position}|{duration}',
        vars(),
      ),
    ).toBe(
      'Teardrop|Massive Attack, Elizabeth Fraser|Mezzanine|Massive Attack|1998|FLAC 24/96|FLAC|96 kHz|24-bit|1:05|5:29',
    );
  });

  it('falls back to track meta without a signal path', () => {
    const v = vars(null);
    expect(v.format).toBe('MP3 48 kHz');
    expect(v.codec).toBe('MP3');
    expect(v.rate).toBe('48 kHz');
    expect(v.bitDepth).toBe('');
    const none = discordVars({
      meta: meta({ codec: null, sampleRate: null, bitDepth: null }),
      positionMs: 0,
      durationMs: 0,
    });
    expect([none.format, none.codec, none.rate, none.bitDepth]).toEqual(['', '', '', '']);
  });

  it('format variants', () => {
    expect(formatSignal(sp('flac', 44100, 16))).toBe('FLAC 16/44.1');
    expect(formatSignal(sp('mp3', 44100, 0))).toBe('MP3 44.1 kHz');
    expect(formatSignal(null)).toBe('');
  });

  it('unknown placeholders stay, null/missing values render empty', () => {
    expect(renderTemplate('{nope} {x} {constructor}', { x: null })).toBe('{nope}  {constructor}');
    expect(renderTemplate('plain', {})).toBe('plain');
  });

  it('clock and cover url', () => {
    expect(formatClock(3_723_000)).toBe('1:02:03');
    expect(formatClock(-5)).toBe('0:00');
    expect(coverUrl(m, 'https://jf.example/')).toBe('https://jf.example/Items/t1/Images/Primary');
    expect(coverUrl(m, '')).toBeNull();
    expect(coverUrl(meta({ imageItemId: 'a9' }), 'https://h')).toBe('https://h/Items/a9/Images/Primary');
    expect(coverUrl(meta({ imageItemId: null }), 'https://h')).toBeNull();
  });

  it('buttons: rendered, invalid dropped', () => {
    const s: DiscordSettings = {
      ...DEFAULT_DISCORD,
      buttons: [
        { label: 'Open in Jellyfin', url: '{publicUrl}/web/#/details?id={id}' },
        { label: 'Bad', url: 'javascript:alert(1)' },
      ],
    };
    const r = renderPresence(s, vars(null, 'https://jf.example/'));
    expect(r.buttons).toEqual([
      { label: 'Open in Jellyfin', url: 'https://jf.example/web/#/details?id=t1' },
    ]);
    expect(renderPresence(s, vars(null)).buttons).toEqual([]);
    const noLabel: DiscordSettings = {
      ...s,
      buttons: [
        { label: '', url: 'https://a.b' },
        { label: 'x', url: '' },
      ],
    };
    expect(renderPresence(noLabel, vars()).buttons).toEqual([]);
  });

  it('clips text to 128 characters', () => {
    expect(renderPresence({ ...DEFAULT_DISCORD, details: 'x'.repeat(300) }, vars()).details).toHaveLength(
      128,
    );
  });
});

describe('DiscordPresence', () => {
  let clock = 1_700_000_000_000;
  let sets: [string, DiscordActivity | null][];
  let p: DiscordPresence;
  const on: DiscordSettings = { ...DEFAULT_DISCORD, enabled: true, applicationId: '123456789' };

  beforeEach(() => {
    clock = 1_700_000_000_000;
    sets = [];
    p = new DiscordPresence(async (id, a) => void sets.push([id, a]), () => clock);
  });

  const obs = (
    state: PlaybackState,
    positionMs = 0,
    over: Partial<PresenceObservation> = {},
  ): PresenceObservation => ({
    meta: meta(),
    entryId: 'e1',
    state,
    positionMs,
    durationMs: 300_000,
    signalPath: null,
    ...over,
  });

  it('pushes on start with timestamps and play icon', async () => {
    await p.observe(on, obs('playing', 10_000));
    expect(sets).toHaveLength(1);
    const [id, a] = sets[0]!;
    expect(id).toBe('123456789');
    expect(a).toMatchObject({
      details: 'Teardrop',
      state: 'Massive Attack - Mezzanine',
      smallImage: 'play',
      largeImage: 'rayla',
      startTimestampMs: 1_700_000_000_000 - 10_000,
      endTimestampMs: null,
    });
  });

  it('position ticks do not push; seeks and pause do', async () => {
    await p.observe(on, obs('playing', 0));
    for (let s = 1; s <= 20; s++) {
      clock += 1000;
      await p.observe(on, obs('playing', s * 1000));
    }
    expect(sets).toHaveLength(1);
    clock += 1000;
    await p.observe(on, obs('playing', 120_000));
    expect(sets).toHaveLength(2);
    await p.observe(on, obs('paused', 120_000));
    expect(sets).toHaveLength(3);
    expect(sets[2]![1]).toMatchObject({ smallImage: 'pause', startTimestampMs: null });
  });

  it('identical observations are deduped; a signal path change pushes', async () => {
    await p.observe(on, obs('playing'));
    await p.observe(on, obs('playing'));
    expect(sets).toHaveLength(1);
    await p.observe(on, obs('playing', 0, { signalPath: sp('flac', 44100, 16) }));
    expect(sets).toHaveLength(2);
    expect(sets[1]![1]?.smallText).toBe('FLAC 16/44.1');
  });

  it('pause clears when showWhenPaused is off; stop clears', async () => {
    const s = { ...on, showWhenPaused: false };
    await p.observe(s, obs('playing'));
    await p.observe(s, obs('paused'));
    expect(sets.at(-1)![1]).toBeNull();
    await p.observe(s, obs('playing'));
    await p.observe(s, obs('stopped', 0, { meta: null, entryId: null }));
    expect(sets.at(-1)![1]).toBeNull();
  });

  it('placeholder app id and disabled push nothing; disabling clears', async () => {
    await p.observe({ ...DEFAULT_DISCORD, enabled: true }, obs('playing'));
    await p.observe(DEFAULT_DISCORD, obs('playing'));
    expect(sets).toEqual([]);
    await p.observe(on, obs('playing'));
    await p.observe({ ...on, enabled: false }, obs('playing'));
    expect(sets.at(-1)![1]).toBeNull();
  });

  it('cover needs showCover and a public url; buttons render', async () => {
    const s: DiscordSettings = {
      ...on,
      showCover: true,
      publicUrl: 'https://jf.example',
      showElapsed: false,
      buttons: [
        { label: 'Open', url: '{publicUrl}/web/#/details?id={id}' },
        { label: '', url: '' },
      ],
    };
    await p.observe(s, obs('playing'));
    const a = sets[0]![1]!;
    expect(a.largeImage).toBe('https://jf.example/Items/t1/Images/Primary');
    expect(a.startTimestampMs).toBeNull();
    expect(a.buttons).toEqual([{ label: 'Open', url: 'https://jf.example/web/#/details?id=t1' }]);
  });

  it('changing application id clears the old one first', async () => {
    await p.observe(on, obs('playing'));
    await p.observe({ ...on, applicationId: '987654321' }, obs('playing'));
    expect(sets[1]).toEqual(['123456789', null]);
    expect(sets[2]![0]).toBe('987654321');
  });

  it('setActivity failures are swallowed; clear() removes presence', async () => {
    p = new DiscordPresence(async () => {
      throw new Error('no discord');
    }, () => clock);
    await expect(p.observe(on, obs('playing'))).resolves.toBeUndefined();
    p = new DiscordPresence(async (id, a) => void sets.push([id, a]), () => clock);
    await p.observe(on, obs('playing'));
    await p.clear();
    expect(sets.at(-1)).toEqual(['123456789', null]);
  });
});
