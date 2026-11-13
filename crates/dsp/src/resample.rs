//! Streaming sinc resampler on interleaved samples (wraps `rubato`).

use crate::Error;
use rubato::{
    Resampler as _, SincFixedIn, SincInterpolationParameters, SincInterpolationType, WindowFunction,
};

/// Input frames handed to rubato per call.
const CHUNK: usize = 1024;

/// Asynchronous sinc resampler accepting arbitrary chunk sizes.
///
/// Input is buffered internally (up to `1023` frames) and the filter delay is
/// compensated, so output frame `n` corresponds to input time
/// `n * in_rate / out_rate` (to within about one output frame) without leading silence (rubato already
/// delivers its output delay-compensated). After `flush` the total
/// output is exactly `round(total_in * out_rate / in_rate)` frames, however
/// the input was chunked.
pub struct Resampler {
    inner: SincFixedIn<f64>,
    channels: usize,
    ratio: f64,
    /// Pending input, per channel.
    pending: Vec<Vec<f64>>,
    total_in: u64,
    total_out: u64,
}

impl Resampler {
    /// Resample `channels` interleaved channels from `in_rate` to `out_rate`.
    pub fn new(in_rate: u32, out_rate: u32, channels: usize) -> Result<Self, Error> {
        let params = SincInterpolationParameters {
            sinc_len: 256,
            f_cutoff: 0.95,
            oversampling_factor: 256,
            interpolation: SincInterpolationType::Cubic,
            window: WindowFunction::BlackmanHarris2,
        };
        let ratio = out_rate as f64 / in_rate as f64;
        let inner = SincFixedIn::new(ratio, 1.0, params, CHUNK, channels)
            .map_err(|e| Error::Resampler(e.to_string()))?;
        Ok(Resampler {
            inner,
            channels,
            ratio,
            pending: vec![Vec::new(); channels],
            total_in: 0,
            total_out: 0,
        })
    }

    fn emit(&mut self, chunk: &[Vec<f64>], out: &mut Vec<f64>, limit: Option<u64>) {
        let mut n = chunk[0].len();
        if let Some(limit) = limit {
            n = n.min(limit.saturating_sub(self.total_out) as usize);
        }
        for i in 0..n {
            out.extend(chunk.iter().map(|c| c[i]));
        }
        self.total_out += n as u64;
    }

    /// Resample interleaved `input`, appending ready frames to `out`.
    pub fn process(&mut self, input: &[f64], out: &mut Vec<f64>) {
        for frame in input.chunks_exact(self.channels) {
            for (p, s) in self.pending.iter_mut().zip(frame) {
                p.push(*s);
            }
        }
        self.total_in += (input.len() / self.channels) as u64;
        while self.pending[0].len() >= CHUNK {
            let chunk = self
                .inner
                .process(
                    &self.pending.iter().map(|p| &p[..CHUNK]).collect::<Vec<_>>(),
                    None,
                )
                .expect("resampler input has the configured shape");
            self.emit(&chunk, out, None);
            self.pending.iter_mut().for_each(|p| {
                p.drain(..CHUNK);
            });
        }
    }

    /// Output the remaining frames, then reset for a new stream.
    pub fn flush(&mut self, out: &mut Vec<f64>) {
        let expected = (self.total_in as f64 * self.ratio).round() as u64;
        let mut first = true;
        while self.total_out < expected {
            let chunk = if first && !self.pending[0].is_empty() {
                let rest: Vec<&[f64]> = self.pending.iter().map(|p| p.as_slice()).collect();
                self.inner.process_partial(Some(rest.as_slice()), None)
            } else {
                self.inner.process_partial(None::<&[Vec<f64>]>, None)
            }
            .expect("resampler input has the configured shape");
            first = false;
            self.emit(&chunk, out, Some(expected));
        }
        self.inner.reset();
        self.pending.iter_mut().for_each(Vec::clear);
        self.total_in = 0;
        self.total_out = 0;
    }

    /// Resample a complete interleaved buffer in one go.
    pub fn resample_all(
        in_rate: u32,
        out_rate: u32,
        channels: usize,
        input: &[f64],
    ) -> Result<Vec<f64>, Error> {
        let mut r = Resampler::new(in_rate, out_rate, channels)?;
        let mut out = Vec::new();
        r.process(input, &mut out);
        r.flush(&mut out);
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_util::*;

    fn run(in_rate: u32, out_rate: u32, x: &[f64], channels: usize, chunked_in: bool) -> Vec<f64> {
        let mut r = Resampler::new(in_rate, out_rate, channels).unwrap();
        let mut out = Vec::new();
        if chunked_in {
            chunked(x, channels, |c| r.process(c, &mut out));
        } else {
            r.process(x, &mut out);
        }
        r.flush(&mut out);
        out
    }

    #[test]
    fn frame_count_matches_ratio_for_any_chunking() {
        for (a, b) in [
            (44_100, 96_000),
            (48_000, 44_100),
            (44_100, 48_000),
            (96_000, 44_100),
        ] {
            for frames in [1usize, 700, 1024, 5000, 30_001] {
                let x = noise(frames * 2, 3);
                let expected = (frames as f64 * b as f64 / a as f64).round() as usize;
                let one = run(a, b, &x, 2, false);
                let many = run(a, b, &x, 2, true);
                assert_eq!(one.len(), expected * 2, "{a}->{b} {frames}");
                assert_eq!(many, one);
            }
        }
    }

    #[test]
    fn sine_keeps_frequency_and_level() {
        let x = sine(1000.0, 44_100, 1, 44_100, 0.5);
        let y = run(44_100, 96_000, &x, 1, true);
        assert_eq!(y.len(), 96_000);
        let mid = &y[4000..92_000];
        let level = rms(mid) / (0.5 / 2f64.sqrt());
        assert!((level - 1.0).abs() < 0.002, "level {level}");
        // Frequency from rising zero crossings over the middle section.
        let crossings = mid.windows(2).filter(|w| w[0] < 0.0 && w[1] >= 0.0).count();
        let freq = crossings as f64 / (mid.len() as f64 / 96_000.0);
        assert!((freq - 1000.0).abs() < 15.0, "freq {freq}");
        // Alignment: the sine is within about one output frame of the ideal one.
        let ideal = sine(1000.0, 96_000, 1, 96_000, 0.5);
        let err = mid
            .iter()
            .zip(&ideal[4000..92_000])
            .fold(0.0f64, |m, (a, b)| m.max((a - b).abs()));
        assert!(err < 0.045, "max err {err}");
    }

    #[test]
    fn downsample_removes_content_above_new_nyquist() {
        let x = sine(30_000.0, 96_000, 1, 48_000, 0.5);
        let y = run(96_000, 44_100, &x, 1, false);
        assert!(rms(&y[2000..y.len() - 2000]) < 1e-3);
    }
}
