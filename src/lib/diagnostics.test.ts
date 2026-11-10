import { describe, expect, it, vi } from 'vitest';
import { Diagnostics, redact, summarizeEngineEvent } from './diagnostics.svelte';
import type { EngineEvent } from './ipc';

function ev(p: Partial<EngineEvent>): EngineEvent {
  return {
    kind: 'position', state: 'playing', trackId: 't1', entryId: null, positionMs: 0, durationMs: 0,
    signalPath: null, message: null, throughputBps: 0, cachedBytes: 0, totalBytes: 0, ...p,
  } as EngineEvent;
}

describe('redact', () => {
  it('hides api keys, tokens, passwords and url credentials', () => {
    expect(redact('GET http://h/Audio/1/stream?static=true&api_key=abc123&x=1')).toBe(
      'GET http://h/Audio/1/stream?static=true&api_key=***&x=1',
    );
    expect(redact('X-Emby-Token: sekret')).toBe('X-Emby-Token: ***');
    expect(redact('{"AccessToken":"abc","Name":"bob"}')).toContain('"AccessToken":"***');
    expect(redact('password=hunter2')).toBe('password=***');
    expect(redact('http://user:pw@host/x')).toBe('http://***@host/x');
    expect(redact('plain text')).toBe('plain text');
  });
});

describe('engine event compression', () => {
  it('drops position ticks and repeated states', () => {
    const d = new Diagnostics({ clock: () => 0 });
    for (let i = 0; i < 100; i++) d.engineEvent(ev({ kind: 'position', positionMs: i }));
    d.engineEvent(ev({ kind: 'stateChanged', state: 'playing' }));
    d.engineEvent(ev({ kind: 'stateChanged', state: 'playing' }));
    d.engineEvent(ev({ kind: 'stateChanged', state: 'paused' }));
    d.engineEvent(ev({ kind: 'fetchProgress', cachedBytes: 10, totalBytes: 100 }));
    d.engineEvent(ev({ kind: 'fetchProgress', cachedBytes: 100, totalBytes: 100 }));
    d.engineEvent(ev({ kind: 'error', message: 'boom' }));
    expect(d.entries.map((e) => e.text)).toEqual([
      'state -> playing',
      'state -> paused',
      expect.stringContaining('fetch complete'),
      'ENGINE ERROR (track t1): boom',
    ]);
    expect(d.errors).toHaveLength(1);
    expect(summarizeEngineEvent(ev({ kind: 'throughput', throughputBps: 2e6 }), { state: null })).toContain('2.00 Mbit/s');
  });
});

describe('Diagnostics buffer', () => {
  it('is a ring buffer, redacts, formats and clears', () => {
    const d = new Diagnostics({ capacity: 3, clock: () => 0 });
    for (let i = 0; i < 5; i++) d.log('info', 't', `line ${i}`);
    expect(d.entries.map((e) => e.text)).toEqual(['line 2', 'line 3', 'line 4']);
    d.log('warn', 't', 'url?api_key=zzz');
    const out = d.format(['Rayla 1', 'token=abc']);
    expect(out).toContain('api_key=***');
    expect(out.split('\n')[1]).toBe('token=***');
    expect(out.startsWith('Rayla 1\ntoken=***\n\n1970-01-01T00:00:00.000Z')).toBe(true);
    d.clear();
    expect(d.entries).toEqual([]);
  });

  it('hooks console and window errors and restores them', () => {
    const d = new Diagnostics({ clock: () => 0 });
    const orig = vi.fn();
    const con = { error: orig, warn: vi.fn() };
    const stop = d.installGlobalHooks(window, con);
    con.error('bad', new Error('x'));
    con.warn('careful');
    expect(orig).toHaveBeenCalledWith('bad', expect.any(Error));
    window.dispatchEvent(new ErrorEvent('error', { message: 'oops' }));
    expect(d.entries.map((e) => `${e.level}:${e.source}`)).toEqual(['error:console', 'warn:console', 'error:window']);
    stop();
    expect(con.error).toBe(orig);
  });
});
