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
