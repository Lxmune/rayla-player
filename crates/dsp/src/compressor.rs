//! Downward dynamic-range compressor.

use crate::gain::db_to_linear;
use crate::CompressorSettings;

/// Width of the soft knee around the threshold, in dB.
const KNEE_DB: f64 = 6.0;

/// Feed-forward, stereo-linked peak compressor with a soft knee.
///
/// The loudest channel of each frame drives one gain for all channels, so the
/// stereo image does not shift. Gain reduction follows the level with the
/// attack time and recovers with the release time (one-pole smoothing in the
/// dB domain); `makeup_db` is added after. No look-ahead: output frame `n` is
/// input frame `n`.
pub struct Compressor {
    channels: usize,
    threshold_db: f64,
    /// `1 / ratio - 1`: dB of gain change per dB over the threshold (≤ 0).
    slope: f64,
    attack: f64,
    release: f64,
    makeup_db: f64,
    /// Current gain reduction in dB (≤ 0).
    env_db: f64,
}

impl Compressor {
    /// Compressor for `channels` interleaved channels at `sample_rate` Hz.
    /// Ratio is clamped to at least 1:1, times to at least 0.1 ms.
    pub fn new(s: &CompressorSettings, sample_rate: u32, channels: usize) -> Self {
        let coeff = |ms: f64| (-1.0 / (ms.max(0.1) / 1000.0 * sample_rate as f64)).exp();
        Compressor {
            channels: channels.max(1),
            threshold_db: s.threshold_db,
            slope: 1.0 / s.ratio.max(1.0) - 1.0,
            attack: coeff(s.attack_ms),
            release: coeff(s.release_ms),
            makeup_db: s.makeup_db,
            env_db: 0.0,
        }
    }

    /// Static gain change in dB for a level in dBFS.
    fn curve(&self, level_db: f64) -> f64 {
        let over = level_db - self.threshold_db;
        if 2.0 * over < -KNEE_DB {
            0.0
        } else if 2.0 * over.abs() <= KNEE_DB {
            self.slope * (over + KNEE_DB / 2.0).powi(2) / (2.0 * KNEE_DB)
        } else {
            self.slope * over
        }
    }

    /// Process interleaved `buf` in place.
    pub fn process(&mut self, buf: &mut [f64]) {
        for frame in buf.chunks_exact_mut(self.channels) {
            let peak = frame.iter().fold(0.0f64, |m, s| m.max(s.abs()));
            let target = self.curve(20.0 * peak.max(1e-12).log10());
            let c = if target < self.env_db { self.attack } else { self.release };
            self.env_db = c * self.env_db + (1.0 - c) * target;
            let g = db_to_linear(self.env_db + self.makeup_db);
            frame.iter_mut().for_each(|s| *s *= g);
        }
    }

    /// Forget the gain envelope (start of a new stream).
    pub fn reset(&mut self) {
        self.env_db = 0.0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_util::*;

    fn settings(threshold_db: f64, ratio: f64, makeup_db: f64) -> CompressorSettings {
        CompressorSettings { enabled: true, threshold_db, ratio, attack_ms: 5.0, release_ms: 100.0, makeup_db }
    }

    fn peak_db(x: &[f64]) -> f64 {
        20.0 * x.iter().fold(0.0f64, |m, s| m.max(s.abs())).log10()
    }

    #[test]
    fn quiet_signal_is_untouched() {
        let mut c = Compressor::new(&settings(-12.0, 4.0, 0.0), 48000, 2);
        let x = sine(1000.0, 48000, 2, 48000, 0.05); // −26 dBFS, far below the knee
        let mut y = x.clone();
        c.process(&mut y);
        assert_eq!(x, y);
    }

    #[test]
    fn loud_signal_follows_the_ratio() {
        let mut c = Compressor::new(&settings(-20.0, 4.0, 0.0), 48000, 2);
        let mut y = sine(1000.0, 48000, 2, 96000, 1.0); // 0 dBFS peaks, 20 dB over
        c.process(&mut y);
        // Settled half: 20 dB over at 4:1 leaves 5 dB over → about −15 dBFS peaks.
        // The envelope ripples between waveform peaks, so allow a few dB.
        let settled = &y[y.len() / 2..];
        let p = peak_db(settled);
        assert!((-17.0..=-12.0).contains(&p), "peak {p:.2} dBFS");
    }

    #[test]
    fn makeup_gain_and_linked_channels() {
        let mut c = Compressor::new(&settings(-60.0, 1.0, 6.0), 48000, 2);
        let mut y = vec![0.25, -0.1, 0.25, -0.1];
        c.process(&mut y);
        let g = db_to_linear(6.0);
        for (a, b) in y.iter().zip([0.25 * g, -0.1 * g, 0.25 * g, -0.1 * g]) {
            assert!((a - b).abs() < 1e-12);
        }
    }

    #[test]
    fn soft_knee_is_continuous() {
        let c = Compressor::new(&settings(-20.0, 4.0, 0.0), 48000, 2);
        for edge in [-23.0, -17.0] {
            let d = (c.curve(edge - 1e-9) - c.curve(edge + 1e-9)).abs();
            assert!(d < 1e-6, "jump {d} at {edge}");
        }
        assert_eq!(c.curve(-40.0), 0.0);
        assert!((c.curve(0.0) - (-15.0)).abs() < 1e-9);
    }
}
