//! Uniformly partitioned FFT convolution and WAV impulse-response loading.

use crate::resample::Resampler;
use crate::Error;
use realfft::num_complex::Complex;
use realfft::{ComplexToReal, RealFftPlanner, RealToComplex};
use std::path::Path;
use std::sync::Arc;

/// Partition (block) length in frames.
const BLOCK: usize = 1024;

/// An impulse response: one `Vec` of samples per channel.
#[derive(Clone, Debug, PartialEq)]
pub struct ImpulseResponse {
    /// Sample rate of the file in Hz.
    pub sample_rate: u32,
    /// Samples per IR channel, all of equal length.
    pub channels: Vec<Vec<f64>>,
}

impl ImpulseResponse {
    /// Length in frames.
    pub fn len(&self) -> usize {
        self.channels.first().map_or(0, Vec::len)
    }

    /// True when the IR has no samples.
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// The IR resampled to `rate`, rescaled so that its DC gain is unchanged.
    pub fn resampled(&self, rate: u32) -> Result<ImpulseResponse, Error> {
        if rate == self.sample_rate {
            return Ok(self.clone());
        }
        let n = self.channels.len();
        let mut inter = Vec::with_capacity(self.len() * n);
        for i in 0..self.len() {
            inter.extend(self.channels.iter().map(|c| c[i]));
        }
        let out = Resampler::resample_all(self.sample_rate, rate, n, &inter)?;
        let scale = self.sample_rate as f64 / rate as f64;
        let channels = (0..n)
            .map(|c| out.iter().skip(c).step_by(n).map(|s| s * scale).collect())
            .collect();
        Ok(ImpulseResponse {
            sample_rate: rate,
            channels,
        })
    }
}

/// Read a WAV impulse response from `path`. See [`parse_wav_ir`].
pub fn load_wav_ir(path: impl AsRef<Path>) -> Result<ImpulseResponse, Error> {
    parse_wav_ir(&std::fs::read(path)?)
}

/// Parse a RIFF/WAVE file: integer PCM at 16, 24 or 32 bits, or IEEE float at
/// 32 or 64 bits (also inside `WAVE_FORMAT_EXTENSIBLE`). Integer samples are
/// scaled to [-1, 1).
pub fn parse_wav_ir(bytes: &[u8]) -> Result<ImpulseResponse, Error> {
    let bad = |m: &str| Error::InvalidWav(m.to_string());
    if bytes.len() < 12 || &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
        return Err(bad("not a RIFF/WAVE file"));
    }
    let u16_at = |o: usize| u16::from_le_bytes([bytes[o], bytes[o + 1]]);
    let u32_at =
        |o: usize| u32::from_le_bytes([bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3]]);
    let (mut fmt, mut data) = (None, None);
    let mut pos = 12;
    while pos + 8 <= bytes.len() {
        let id = &bytes[pos..pos + 4];
        let size = u32_at(pos + 4) as usize;
        let body = pos + 8;
        let end = body.saturating_add(size).min(bytes.len());
        match id {
            b"fmt " if end - body >= 16 => {
                let mut tag = u16_at(body);
                if tag == 0xFFFE && end - body >= 26 {
                    tag = u16_at(body + 24);
                }
                fmt = Some((
                    tag,
                    u16_at(body + 2) as usize,
                    u32_at(body + 4),
                    u16_at(body + 14) as usize,
                ));
            }
            b"data" => data = Some(&bytes[body..end]),
            _ => {}
        }
        pos = body.saturating_add(size).saturating_add(size & 1);
    }
    let (tag, channels, sample_rate, bits) = fmt.ok_or_else(|| bad("missing fmt chunk"))?;
    let data = data.ok_or_else(|| bad("missing data chunk"))?;
    if channels == 0 || sample_rate == 0 {
        return Err(bad("zero channels or sample rate"));
    }
    let width = bits / 8;
    let decode: fn(&[u8]) -> f64 = match (tag, bits) {
        (1, 16) => |b| i16::from_le_bytes([b[0], b[1]]) as f64 / 32768.0,
        (1, 24) => |b| (i32::from_le_bytes([0, b[0], b[1], b[2]]) >> 8) as f64 / 8_388_608.0,
        (1, 32) => |b| i32::from_le_bytes([b[0], b[1], b[2], b[3]]) as f64 / 2_147_483_648.0,
        (3, 32) => |b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]) as f64,
        (3, 64) => |b| f64::from_le_bytes([b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7]]),
        _ => {
            return Err(Error::InvalidWav(format!(
                "unsupported format tag {tag} / {bits} bits"
            )))
        }
    };
    let frames = data.len() / (width * channels);
    if frames == 0 {
        return Err(bad("no audio data"));
    }
    let mut out = vec![Vec::with_capacity(frames); channels];
    for frame in data.chunks_exact(width * channels).take(frames) {
        for (c, s) in out.iter_mut().zip(frame.chunks_exact(width)) {
            c.push(decode(s));
        }
    }
    Ok(ImpulseResponse {
        sample_rate,
        channels: out,
    })
}

struct ChannelState {
    /// Current block of input being collected.
    input: Vec<f64>,
    /// Previous block (overlap-save history).
    prev: Vec<f64>,
    /// Spectra of the most recent blocks, newest at `pos`.
    fdl: Vec<Vec<Complex<f64>>>,
}

/// Uniformly partitioned overlap-save FIR convolver.
///
/// Uses 1024-frame partitions, so cost is independent of how the stream is
/// chunked. Output is aligned with the input (the IR's own delay is kept) but
/// arrives in blocks: up to 1023 frames are held back until more input or
/// `flush`. `flush` appends the convolution tail, so the total output is
/// `input_frames + ir_len - 1`.
pub struct Convolver {
    channels: usize,
    ir_len: usize,
    n_part: usize,
    fwd: Arc<dyn RealToComplex<f64>>,
    inv: Arc<dyn ComplexToReal<f64>>,
    /// IR partition spectra, `[ir_channel][partition][bin]`, pre-scaled for the inverse FFT.
    ir_spec: Vec<Vec<Vec<Complex<f64>>>>,
    chans: Vec<ChannelState>,
    pos: usize,
    filled: usize,
    total_in: u64,
    total_out: u64,
    time: Vec<f64>,
    spec: Vec<Complex<f64>>,
    acc: Vec<Complex<f64>>,
    scratch_fwd: Vec<Complex<f64>>,
    scratch_inv: Vec<Complex<f64>>,
    block_out: Vec<f64>,
}

impl Convolver {
    /// Build a convolver for `channels` audio channels at `stream_rate`.
    /// The IR is resampled if its rate differs. A mono IR is applied to every
    /// channel; otherwise the IR must have one channel per audio channel.
    pub fn new(ir: &ImpulseResponse, stream_rate: u32, channels: usize) -> Result<Self, Error> {
        if ir.is_empty() || ir.channels.is_empty() {
            return Err(Error::Convolution("empty impulse response".into()));
        }
        if ir.channels.len() != 1 && ir.channels.len() != channels {
            return Err(Error::Convolution(format!(
                "impulse response has {} channels, stream has {channels}",
                ir.channels.len()
            )));
        }
        let ir = ir.resampled(stream_rate)?;
        let ir_len = ir.len();
        let n_part = ir_len.div_ceil(BLOCK);
        let mut planner = RealFftPlanner::<f64>::new();
        let fwd = planner.plan_fft_forward(2 * BLOCK);
        let inv = planner.plan_fft_inverse(2 * BLOCK);
        let mut scratch_fwd = fwd.make_scratch_vec();
        let scratch_inv = inv.make_scratch_vec();
        let norm = 1.0 / (2 * BLOCK) as f64;
        let mut time = fwd.make_input_vec();
        let mut ir_spec = Vec::new();
        for h in &ir.channels {
            let mut parts = Vec::with_capacity(n_part);
            for p in 0..n_part {
                time.fill(0.0);
                let seg = &h[p * BLOCK..((p + 1) * BLOCK).min(ir_len)];
                time[..seg.len()].copy_from_slice(seg);
                let mut s = fwd.make_output_vec();
                fwd.process_with_scratch(&mut time, &mut s, &mut scratch_fwd)
                    .map_err(|e| Error::Convolution(e.to_string()))?;
                s.iter_mut().for_each(|v| *v *= norm);
                parts.push(s);
            }
            ir_spec.push(parts);
        }
        let zero = vec![Complex::new(0.0, 0.0); BLOCK + 1];
        Ok(Convolver {
            channels,
            ir_len,
            n_part,
            fwd,
            inv,
            ir_spec,
            chans: (0..channels)
                .map(|_| ChannelState {
                    input: vec![0.0; BLOCK],
                    prev: vec![0.0; BLOCK],
                    fdl: vec![zero.clone(); n_part],
                })
                .collect(),
            pos: 0,
            filled: 0,
            total_in: 0,
            total_out: 0,
            time,
            spec: zero.clone(),
            acc: zero,
            scratch_fwd,
            scratch_inv,
            block_out: vec![0.0; BLOCK * channels],
        })
    }

    /// IR length in frames after any resampling.
    pub fn ir_len(&self) -> usize {
        self.ir_len
    }

    /// Convolve one full block of every channel and append it to `out`.
    fn run_block(&mut self, out: &mut Vec<f64>) {
        self.pos = (self.pos + self.n_part - 1) % self.n_part;
        for ch in 0..self.channels {
            let st = &mut self.chans[ch];
            self.time[..BLOCK].copy_from_slice(&st.prev);
            self.time[BLOCK..].copy_from_slice(&st.input);
            st.prev.copy_from_slice(&st.input);
            self.fwd
                .process_with_scratch(&mut self.time, &mut self.spec, &mut self.scratch_fwd)
                .expect("fft sizes are fixed");
            st.fdl[self.pos].copy_from_slice(&self.spec);
            self.acc.fill(Complex::new(0.0, 0.0));
            let h = &self.ir_spec[ch.min(self.ir_spec.len() - 1)];
            for (k, hk) in h.iter().enumerate() {
                let x = &st.fdl[(self.pos + k) % self.n_part];
                for ((a, x), h) in self.acc.iter_mut().zip(x).zip(hk) {
                    *a += x * h;
                }
            }
            self.acc[0].im = 0.0;
            self.acc[BLOCK].im = 0.0;
            self.inv
                .process_with_scratch(&mut self.acc, &mut self.time, &mut self.scratch_inv)
                .expect("fft sizes are fixed");
            for (i, s) in self.time[BLOCK..].iter().enumerate() {
                self.block_out[i * self.channels + ch] = *s;
            }
        }
        out.extend_from_slice(&self.block_out);
        self.total_out += BLOCK as u64;
        self.filled = 0;
    }

    /// Convolve interleaved `input`, appending the frames that are ready.
    pub fn process(&mut self, input: &[f64], out: &mut Vec<f64>) {
        for frame in input.chunks_exact(self.channels) {
            for (st, s) in self.chans.iter_mut().zip(frame) {
                st.input[self.filled] = *s;
            }
            self.filled += 1;
            self.total_in += 1;
            if self.filled == BLOCK {
                self.run_block(out);
            }
        }
    }

    /// Append the remaining output including the IR tail, then reset.
    pub fn flush(&mut self, out: &mut Vec<f64>) {
        if self.total_in > 0 {
            let target = self.total_in + self.ir_len as u64 - 1;
            while self.total_out < target {
                for st in &mut self.chans {
                    st.input[self.filled..].fill(0.0);
                }
                self.run_block(out);
            }
            let excess = (self.total_out - target) as usize * self.channels;
            out.truncate(out.len() - excess);
        }
        for st in &mut self.chans {
            st.input.fill(0.0);
            st.prev.fill(0.0);
            st.fdl
                .iter_mut()
                .for_each(|s| s.fill(Complex::new(0.0, 0.0)));
        }
        self.pos = 0;
        self.filled = 0;
        self.total_in = 0;
        self.total_out = 0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_util::*;

    fn ir(channels: Vec<Vec<f64>>) -> ImpulseResponse {
        ImpulseResponse {
            sample_rate: 48_000,
            channels,
        }
    }

    fn run(c: &mut Convolver, x: &[f64], ch: usize, chunked_in: bool) -> Vec<f64> {
        let mut out = Vec::new();
        if chunked_in {
            chunked(x, ch, |s| c.process(s, &mut out));
        } else {
            c.process(x, &mut out);
        }
        c.flush(&mut out);
        out
    }

    fn direct(x: &[f64], h: &[f64]) -> Vec<f64> {
        let mut y = vec![0.0; x.len() + h.len() - 1];
        for (i, xi) in x.iter().enumerate() {
            for (j, hj) in h.iter().enumerate() {
                y[i + j] += xi * hj;
            }
        }
        y
    }

    #[test]
    fn unit_impulse_is_identity_for_any_chunking() {
        let x = noise(2 * 5000, 1);
        let mut c = Convolver::new(&ir(vec![vec![1.0]]), 48_000, 2).unwrap();
        for chunks in [false, true] {
            let y = run(&mut c, &x, 2, chunks);
            assert_eq!(y.len(), x.len());
            assert!(x.iter().zip(&y).all(|(a, b)| (a - b).abs() < 1e-9));
        }
    }

    #[test]
    fn short_ir_matches_direct_convolution() {
        let h = [0.5, -0.25, 0.125, 0.0, 0.3];
        let x = noise(3000, 2);
        let mut c = Convolver::new(&ir(vec![h.to_vec()]), 48_000, 1).unwrap();
        let y = run(&mut c, &x, 1, true);
        let want = direct(&x, &h);
        assert_eq!(y.len(), want.len());
        assert!(y.iter().zip(&want).all(|(a, b)| (a - b).abs() < 1e-9));
    }

    #[test]
    fn multi_partition_ir_and_per_channel_irs() {
        let h0 = noise(3500, 3);
        let h1 = noise(3500, 4);
        let x = noise(2 * 4321, 5);
        let mut c = Convolver::new(&ir(vec![h0.clone(), h1.clone()]), 48_000, 2).unwrap();
        let y = run(&mut c, &x, 2, true);
        let (l, r) = (channel(&x, 2, 0), channel(&x, 2, 1));
        let (wl, wr) = (direct(&l, &h0), direct(&r, &h1));
        assert_eq!(y.len() / 2, l.len() + h0.len() - 1);
        let (yl, yr) = (channel(&y, 2, 0), channel(&y, 2, 1));
        assert!(yl.iter().zip(&wl).all(|(a, b)| (a - b).abs() < 1e-8));
        assert!(yr.iter().zip(&wr).all(|(a, b)| (a - b).abs() < 1e-8));
        // Mono IR on stereo applies to both channels; stream is reusable after flush.
        let mut m = Convolver::new(&ir(vec![h0.clone()]), 48_000, 2).unwrap();
        let ym = run(&mut m, &x, 2, false);
        assert!(channel(&ym, 2, 1)
            .iter()
            .zip(&direct(&r, &h0))
            .all(|(a, b)| (a - b).abs() < 1e-8));
        let ym2 = run(&mut m, &x, 2, true);
        assert!(ym.iter().zip(&ym2).all(|(a, b)| (a - b).abs() < 1e-12));
    }

    #[test]
    fn rejects_channel_mismatch() {
        assert!(Convolver::new(&ir(vec![vec![1.0], vec![1.0]]), 48_000, 3).is_err());
    }

    #[test]
    fn ir_is_resampled_to_stream_rate() {
        let mut h = vec![0.0; 100];
        h[10] = 1.0;
        let i = ImpulseResponse {
            sample_rate: 24_000,
            channels: vec![h],
        };
        let r = i.resampled(48_000).unwrap();
        assert_eq!(r.len(), 200);
        let peak = r.channels[0]
            .iter()
            .enumerate()
            .fold(
                (0, 0.0f64),
                |m, (i, s)| if s.abs() > m.1 { (i, s.abs()) } else { m },
            );
        assert!(peak.0.abs_diff(20) <= 1, "peak at {}", peak.0);
        // Sum (DC gain) is preserved.
        assert!((r.channels[0].iter().sum::<f64>() - 1.0).abs() < 0.02);
    }

    #[test]
    fn loads_wav_formats() {
        let s = [0.5, -0.25, 0.0, 0.75];
        for (fmt, bits, tol) in [
            (1u16, 16u16, 1e-4),
            (1, 24, 1e-6),
            (1, 32, 1e-9),
            (3, 32, 1e-9),
        ] {
            let wav = wav_bytes(fmt, bits, 44_100, 2, &s);
            let ir = parse_wav_ir(&wav).unwrap();
            assert_eq!(ir.sample_rate, 44_100);
            assert_eq!(ir.channels.len(), 2);
            assert_eq!(ir.len(), 2);
            for (i, v) in s.iter().enumerate() {
                assert!(
                    (ir.channels[i % 2][i / 2] - v).abs() < tol,
                    "fmt {fmt} bits {bits}"
                );
            }
        }
        assert!(parse_wav_ir(b"not a wav at all").is_err());
        assert!(parse_wav_ir(&wav_bytes(1, 8, 44_100, 1, &[0.0])).is_err());
    }
}
