import type { DspConfig } from '../../lib/ipc';

/** Things in `dsp` (and the bitrate cap) that stop the output being bit-perfect. */
export function bitPerfectBlockers(dsp: DspConfig, maxBitrate: number | null): string[] {
  const out: string[] = [];
  if (dsp.volume < 1) out.push('Volume is below 100%');
  if (dsp.replayGain !== 'off') out.push('ReplayGain is on');
  if (dsp.preampDb !== 0) out.push('Preamp is not 0 dB');
  if (dsp.eqEnabled) out.push('Parametric EQ is on');
  if (dsp.convolutionPath !== null) out.push('Convolution is on');
  if (dsp.crossfeed !== 'off') out.push('Crossfeed is on');
  if (dsp.compressor.enabled) out.push('Compressor is on');
  if (dsp.resampleTo !== null) out.push('Resampling is forced');
  if (dsp.dither !== 'off') out.push('Dither is on');
  if (dsp.crossfadeMs > 0) out.push('Crossfade is on');
  if (maxBitrate !== null) out.push('Bitrate cap is set');
  return out;
}
