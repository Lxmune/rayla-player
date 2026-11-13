//! Headphone crossfeed after Bauer's bs2b.

use crate::CrossfeedLevel;
use std::f64::consts::PI;

/// Bauer-style stereo-to-binaural crossfeed.
///
/// Each ear receives its own channel through a gentle high-frequency boost
/// plus the opposite channel low-passed and attenuated. Levels (cut-off,
/// feed = how far the crossfed signal sits below the direct one): Low
/// 650 Hz / 9.5 dB (Meier), Medium 700 Hz / 4.5 dB (bs2b default), High
/// 700 Hz / 3 dB. Low frequencies of a centred signal keep unity gain.
/// Only stereo is processed; other layouts pass through untouched.
pub struct Crossfeed {
    active: bool,
    a0_lo: f64,
    b1_lo: f64,
    a0_hi: f64,
    a1_hi: f64,
    b1_hi: f64,
    gain: f64,
    lo: [f64; 2],
    hi: [f64; 2],
    prev: [f64; 2],
}

impl Crossfeed {
    /// Build for the given level, stream rate and channel count.
    pub fn new(level: CrossfeedLevel, sample_rate: u32, channels: usize) -> Self {
        let (fcut, feed_db) = match level {
            CrossfeedLevel::Off => (700.0, 0.0),
            CrossfeedLevel::Low => (650.0, 9.5),
            CrossfeedLevel::Medium => (700.0, 4.5),
            CrossfeedLevel::High => (700.0, 3.0),
        };
        let rate = sample_rate as f64;
        let gb_lo = feed_db * -5.0 / 6.0 - 3.0;
        let gb_hi = feed_db / 6.0 - 3.0;
        let g_lo = 10f64.powf(gb_lo / 20.0);
        let g_hi = 1.0 - 10f64.powf(gb_hi / 20.0);
        let fc_hi = fcut * 2f64.powf((gb_lo - 20.0 * g_hi.log10()) / 12.0);
        let x_lo = (-2.0 * PI * fcut / rate).exp();
        let x_hi = (-2.0 * PI * fc_hi / rate).exp();
        Crossfeed {
            active: level != CrossfeedLevel::Off && channels == 2,
            a0_lo: g_lo * (1.0 - x_lo),
            b1_lo: x_lo,
            a0_hi: 1.0 - g_hi * (1.0 - x_hi),
            a1_hi: -x_hi,
            b1_hi: x_hi,
            gain: 1.0 / (1.0 - g_hi + g_lo),
            lo: [0.0; 2],
            hi: [0.0; 2],
            prev: [0.0; 2],
        }
    }

    /// True when the stage changes the signal (stereo and level not Off).
    pub fn is_active(&self) -> bool {
        self.active
    }

    /// Process interleaved stereo `buf` in place.
    pub fn process(&mut self, buf: &mut [f64]) {
        if !self.active {
            return;
        }
        for f in buf.as_chunks_mut::<2>().0 {
            let (l, r) = (f[0], f[1]);
            self.lo[0] = self.a0_lo * l + self.b1_lo * self.lo[0];
            self.lo[1] = self.a0_lo * r + self.b1_lo * self.lo[1];
            self.hi[0] = self.a0_hi * l + self.a1_hi * self.prev[0] + self.b1_hi * self.hi[0];
            self.hi[1] = self.a0_hi * r + self.a1_hi * self.prev[1] + self.b1_hi * self.hi[1];
            self.prev = [l, r];
            f[0] = (self.hi[0] + self.lo[1]) * self.gain;
            f[1] = (self.hi[1] + self.lo[0]) * self.gain;
        }
    }

    /// Clear the filter memory.
    pub fn reset(&mut self) {
        self.lo = [0.0; 2];
        self.hi = [0.0; 2];
        self.prev = [0.0; 2];
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_util::*;

    const RATE: u32 = 48_000;

    fn run(level: CrossfeedLevel, x: &[f64]) -> Vec<f64> {
        let mut cf = Crossfeed::new(level, RATE, 2);
        let mut y = x.to_vec();
        cf.process(&mut y);
        y
    }

    #[test]
    fn centred_signal_keeps_level_at_low_frequencies() {
        let x = sine(100.0, RATE, 2, 48_000, 0.5);
        for level in [
            CrossfeedLevel::Low,
            CrossfeedLevel::Medium,
            CrossfeedLevel::High,
        ] {
            let y = run(level, &x);
            let db = 20.0 * (rms(&y[48_000..]) / rms(&x[48_000..])).log10();
            assert!(db.abs() < 0.3, "{level:?}: {db} dB");
        }
    }

    #[test]
    fn hard_pan_leaks_at_feed_level() {
        let mono = sine(100.0, RATE, 1, 48_000, 0.5);
        let x: Vec<f64> = mono.iter().flat_map(|s| [*s, 0.0]).collect();
        let y = run(CrossfeedLevel::Medium, &x);
        let l = rms(&channel(&y, 2, 0)[24_000..]);
        let r = rms(&channel(&y, 2, 1)[24_000..]);
        let db = 20.0 * (r / l).log10();
        assert!((db + 4.5).abs() < 0.7, "leak {db} dB");
        // Stronger level leaks more.
        let y = run(CrossfeedLevel::High, &x);
        let db_high =
            20.0 * (rms(&channel(&y, 2, 1)[24_000..]) / rms(&channel(&y, 2, 0)[24_000..])).log10();
        assert!(db_high > db + 1.0, "{db_high} vs {db}");
        // High frequencies leak far less.
        let hf: Vec<f64> = sine(8000.0, RATE, 1, 48_000, 0.5)
            .iter()
            .flat_map(|s| [*s, 0.0])
            .collect();
        let y = run(CrossfeedLevel::Medium, &hf);
        assert!(rms(&channel(&y, 2, 1)[24_000..]) < 0.1 * rms(&channel(&y, 2, 0)[24_000..]));
    }

    #[test]
    fn non_stereo_and_off_are_untouched() {
        let x = noise(3000, 1);
        let mut cf = Crossfeed::new(CrossfeedLevel::High, RATE, 3);
        let mut y = x.clone();
        cf.process(&mut y);
        assert_eq!(x, y);
        assert!(!cf.is_active());
        assert_eq!(run(CrossfeedLevel::Off, &x), x);
    }
}
