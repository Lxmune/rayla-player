import { describe, expect, it } from 'vitest';
import { AutoEqFormatError, parseAutoEq } from './autoeq';

describe('parseAutoEq', () => {
  it('parses preamp and filters', () => {
    const p = parseAutoEq(`Preamp: -6.2 dB
Filter 1: ON LSC Fc 105 Hz Gain 6.5 dB Q 0.70
Filter 2: ON PK Fc 1500 Hz Gain -3.1 dB Q 2.00
Filter 3: ON HSC Fc 10000 Hz Gain -4.0 dB Q 0.71
`);
    expect(p.preampDb).toBe(-6.2);
    expect(p.bands).toEqual([
      { kind: 'lowShelf', freqHz: 105, gainDb: 6.5, q: 0.7 },
      { kind: 'peak', freqHz: 1500, gainDb: -3.1, q: 2 },
      { kind: 'highShelf', freqHz: 10000, gainDb: -4, q: 0.71 },
    ]);
    expect(p.skipped).toEqual([]);
  });

  it('skips OFF filters and handles CRLF', () => {
    const p = parseAutoEq(
      'Preamp: 0 dB\r\nFilter 1: OFF PK Fc 100 Hz Gain 1 dB Q 1\r\nFilter 2: ON PK Fc 200 Hz Gain 2 dB Q 1\r\n',
    );
    expect(p.bands.map((b) => b.freqHz)).toEqual([200]);
    expect(p.skipped).toEqual([]);
  });

  it('reports malformed and unsupported lines without failing', () => {
    const p = parseAutoEq(`garbage line
Filter 1: ON PK Fc abc Hz Gain 1 dB Q 1
Filter 2: ON LP Fc 5000 Hz
Filter 3: ON PK Fc 300 Hz Gain -1.5 dB Q 1.4
`);
    expect(p.bands).toHaveLength(1);
    expect(p.bands[0]!.freqHz).toBe(300);
    expect(p.skipped).toHaveLength(3);
    expect(p.preampDb).toBe(0);
  });

  it('rejects non-positive and non-numeric values', () => {
    const p = parseAutoEq(`Filter 1: ON PK Fc 0 Hz Gain 1 dB Q 1
Filter 2: ON PK Fc 1.2.3 Hz Gain 1 dB Q 1
Filter 3: ON PK Fc 100 Hz Gain 1 dB Q 1`);
    expect(p.bands).toHaveLength(1);
    expect(p.skipped).toHaveLength(2);
  });

  it('defaults Q and gain', () => {
    expect(parseAutoEq('Filter 1: ON HSC Fc 8000 Hz Gain 2 dB').bands[0]!.q).toBeCloseTo(0.707, 9);
    expect(parseAutoEq('Filter 1: ON PK Fc 100 Hz').bands[0]).toEqual({
      kind: 'peak',
      freqHz: 100,
      gainDb: 0,
      q: 1,
    });
  });

  it('throws when no usable filters', () => {
    expect(() => parseAutoEq('')).toThrow(AutoEqFormatError);
    expect(() => parseAutoEq('Preamp: -3 dB')).toThrow(AutoEqFormatError);
    expect(() => parseAutoEq('Filter 1: OFF PK Fc 100 Hz Gain 1 dB Q 1')).toThrow(AutoEqFormatError);
  });
});

import {
  autoEqProfileUrl,
  fetchAutoEqProfile,
  loadAutoEqIndex,
  parseAutoEqIndex,
  searchAutoEq,
} from './autoeq';
import { memoryKv } from '../platform';

const INDEX_FIXTURE = `# Index
This is a list of all equalization profiles.

- [1Custom SA02](./crinacle/711%20in-ear/1Custom%20SA02) by crinacle on 711
- [1MORE Aero (ANC Off)](./HypetheSonics/GRAS%20RA0045%20in-ear/1MORE%20Aero%20(ANC%20Off)) by HypetheSonics on GRAS RA0045
- [1MORE ComfoBuds Mini](./DHRME/in-ear/1MORE%20ComfoBuds%20Mini) by DHRME
- [Sennheiser HD 600](./oratory1990/over-ear/Sennheiser%20HD%20600) by oratory1990
- [Sennheiser HD 650](./Rtings/over-ear/Sennheiser%20HD%20650) by Rtings
- [Sennheiser HD 600 Sundara](./crinacle/over-ear/Sennheiser%20HD%20600%20Sundara) by crinacle on GRAS 43AG-7
garbage line
`;

describe('AutoEq index', () => {
  it('parses entries, decoding paths and optional rig', () => {
    const e = parseAutoEqIndex(INDEX_FIXTURE);
    expect(e).toHaveLength(6);
    expect(e[0]).toEqual({
      name: '1Custom SA02',
      path: 'crinacle/711 in-ear/1Custom SA02',
      source: 'crinacle',
      rig: '711',
    });
    expect(e[1]!.name).toBe('1MORE Aero (ANC Off)');
    expect(e[1]!.path).toBe('HypetheSonics/GRAS RA0045 in-ear/1MORE Aero (ANC Off)');
    expect(e[2]!.rig).toBe('');
  });

  it('builds the ParametricEQ.txt url', () => {
    const e = parseAutoEqIndex(INDEX_FIXTURE);
    expect(autoEqProfileUrl(e[3]!)).toBe(
      'https://raw.githubusercontent.com/jaakkopasanen/AutoEq/master/results/oratory1990/over-ear/Sennheiser%20HD%20600/Sennheiser%20HD%20600%20ParametricEQ.txt',
    );
  });

  it('ranks exact and prefix matches first, requires all terms', () => {
    const e = parseAutoEqIndex(INDEX_FIXTURE);
    expect(searchAutoEq(e, 'hd 600').map((x) => x.name)).toEqual([
      'Sennheiser HD 600',
      'Sennheiser HD 600 Sundara',
    ]);
    expect(searchAutoEq(e, 'sennheiser hd 600')[0]!.name).toBe('Sennheiser HD 600');
    expect(searchAutoEq(e, 'rtings').map((x) => x.name)).toEqual(['Sennheiser HD 650']);
    expect(searchAutoEq(e, 'zzz')).toEqual([]);
    expect(searchAutoEq(e, '', 2)).toHaveLength(2);
  });

  it('caches the index for 7 days and falls back to stale cache', async () => {
    const kv = memoryKv();
    let calls = 0;
    let ok = true;
    const f = async () => {
      calls++;
      return ok ? new Response(INDEX_FIXTURE) : new Response('no', { status: 500 });
    };
    let t = 1000;
    expect(await loadAutoEqIndex(f, kv, () => t)).toHaveLength(6);
    t += 6 * 86400_000;
    await loadAutoEqIndex(f, kv, () => t);
    expect(calls).toBe(1);
    t += 2 * 86400_000;
    ok = false;
    expect(await loadAutoEqIndex(f, kv, () => t)).toHaveLength(6);
    expect(calls).toBe(2);
    await expect(loadAutoEqIndex(f, memoryKv(), () => t)).rejects.toThrow();
  });

  it('fetches and parses a profile', async () => {
    const e = parseAutoEqIndex(INDEX_FIXTURE)[3]!;
    const p = await fetchAutoEqProfile(
      async () => new Response('Preamp: -3.0 dB\nFilter 1: ON PK Fc 100 Hz Gain 2 dB Q 1'),
      e,
    );
    expect(p.preampDb).toBe(-3);
    expect(p.bands).toHaveLength(1);
  });
});
