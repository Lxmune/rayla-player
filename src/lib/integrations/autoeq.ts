import type { EqBand, EqBandKind } from '../ipc';

export interface AutoEqProfile {
  preampDb: number;
  bands: EqBand[];
  /** Human-readable notes for lines that were ignored. */
  skipped: string[];
}

export class AutoEqFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AutoEqFormatError';
  }
}

const PREAMP = /^Preamp\s*:\s*([-+]?\d+(?:\.\d+)?)\s*dB/i;
const FILTER =
  /^Filter\s*\d*\s*:\s*(ON|OFF)\s+([A-Za-z]+)\s+Fc\s+([\d.]+)\s*Hz(?:\s+Gain\s+([-+]?\d+(?:\.\d+)?)\s*dB)?(?:\s+Q\s+([\d.]+))?/i;

function kindOf(type: string): EqBandKind | null {
  switch (type.toUpperCase()) {
    case 'PK':
    case 'PEQ':
    case 'PEAK':
      return 'peak';
    case 'LSC':
    case 'LS':
      return 'lowShelf';
    case 'HSC':
    case 'HS':
      return 'highShelf';
    default:
      return null;
  }
}

/** Parses AutoEQ / Equalizer APO parametric text (`Preamp: -6.2 dB`,
 *  `Filter 1: ON PK Fc 105 Hz Gain -3.1 dB Q 0.70`). OFF filters are skipped silently;
 *  malformed lines and unsupported types go to `skipped`. Throws AutoEqFormatError when
 *  no usable filter was found. */
export function parseAutoEq(text: string): AutoEqProfile {
  let preampDb = 0;
  const bands: EqBand[] = [];
  const skipped: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const p = PREAMP.exec(line);
    if (p) {
      preampDb = Number(p[1]);
      continue;
    }
    const m = FILTER.exec(line);
    if (!m) {
      skipped.push(`Ignored: ${line}`);
      continue;
    }
    if (m[1]!.toUpperCase() === 'OFF') continue;
    const kind = kindOf(m[2]!);
    if (!kind) {
      skipped.push(`Unsupported filter type ${m[2]!}: ${line}`);
      continue;
    }
    const freqHz = Number(m[3]);
    const gainDb = Number(m[4] ?? '0');
    const q = Number(m[5] ?? (kind === 'peak' ? '1.0' : '0.707'));
    if (![freqHz, gainDb, q].every(Number.isFinite) || freqHz <= 0 || q <= 0) {
      skipped.push(`Invalid numbers: ${line}`);
      continue;
    }
    bands.push({ kind, freqHz, gainDb, q });
  }
  if (bands.length === 0) throw new AutoEqFormatError('No enabled filters found');
  return { preampDb, bands, skipped };
}
