//! Float → integer quantization with optional dither.

use crate::DitherMode;

/// Converts interleaved `f64` samples in [-1, 1] to signed integers of 16, 24
/// or 32 bits (24-bit values are right-aligned in an `i32`).
///
/// Output is clamped to the integer range. The noise source is a small seeded
/// generator, so the same seed and input always give the same output.
pub struct Quantizer {
    scale: f64,
    min: f64,
    max: f64,
    mode: DitherMode,
    channels: usize,
    rng: u64,
    /// Last two quantization errors per channel (noise shaping).
    err: Vec<[f64; 2]>,
}

impl Quantizer {
    /// `bits` is 16, 24 or 32 (other values are clamped to 8..=32).
    pub fn new(bits: u32, mode: DitherMode, channels: usize, seed: u64) -> Self {
        let bits = bits.clamp(8, 32);
        let scale = (1u64 << (bits - 1)) as f64;
        Quantizer {
            scale,
            min: -scale,
            max: scale - 1.0,
            mode,
            channels,
            rng: seed ^ 0x9E37_79B9_7F4A_7C15,
            err: vec![[0.0; 2]; channels],
        }
    }

    /// Uniform in [0, 1) (SplitMix64).
    fn uniform(&mut self) -> f64 {
        self.rng = self.rng.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.rng;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^= z >> 31;
        (z >> 11) as f64 / (1u64 << 53) as f64
    }

    /// Quantize interleaved `input`, appending to `out`.
    pub fn quantize(&mut self, input: &[f64], out: &mut Vec<i32>) {
        out.reserve(input.len());
        for (i, &x) in input.iter().enumerate() {
            let v = x * self.scale;
            let q = match self.mode {
                DitherMode::Off => v.round(),
                DitherMode::Tpdf => {
                    let d = self.uniform() - self.uniform();
                    (v + d).round()
                }
                DitherMode::Shaped => {
                    let ch = i % self.channels;
                    let [e1, e2] = self.err[ch];
                    // Noise transfer function (1 - z^-1)^2: pushes the noise
                    // towards high frequencies.
                    let target = v - (2.0 * e1 - e2);
                    let d = self.uniform() - self.uniform();
                    let q = (target + d).round();
                    self.err[ch] = [(q - target).clamp(-2.0, 2.0), e1];
                    q
                }
            };
            out.push(q.clamp(self.min, self.max) as i32);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_util::*;

    fn run(bits: u32, mode: DitherMode, seed: u64, x: &[f64]) -> Vec<i32> {
        let mut q = Quantizer::new(bits, mode, 2, seed);
        let mut out = Vec::new();
        q.quantize(x, &mut out);
        out
    }

    #[test]
    fn off_rounds_exactly() {
        let x = [0.0, 1.0 / 32768.0, -1.0 / 32768.0, 0.4 / 32768.0, 0.6 / 32768.0, 0.5, -0.5];
        assert_eq!(run(16, DitherMode::Off, 1, &x), [0, 1, -1, 0, 1, 16384, -16384]);
        assert_eq!(run(24, DitherMode::Off, 1, &[0.5, -1.0]), [4_194_304, -8_388_608]);
        assert_eq!(run(32, DitherMode::Off, 1, &[1.0, -1.0]), [i32::MAX, i32::MIN]);
    }

    #[test]
    fn clamps_to_range() {
        for mode in [DitherMode::Off, DitherMode::Tpdf, DitherMode::Shaped] {
            let out = run(16, mode, 3, &[2.0, -2.0, 1.0, -1.0]);
            assert!(out.iter().all(|s| (-32768..=32767).contains(s)));
            assert_eq!(out[0], 32767);
            assert_eq!(out[1], -32768);
        }
    }

    #[test]
    fn tpdf_error_is_bounded_and_zero_mean() {
        let x: Vec<f64> = noise(400_000, 7).iter().map(|s| s * 0.5).collect();
        let out = run(16, DitherMode::Tpdf, 42, &x);
        let errs: Vec<f64> = out.iter().zip(&x).map(|(q, s)| *q as f64 - s * 32768.0).collect();
        assert!(errs.iter().all(|e| e.abs() <= 1.5 + 1e-9));
        let mean = errs.iter().sum::<f64>() / errs.len() as f64;
        assert!(mean.abs() < 0.01, "mean {mean}");
    }

    #[test]
    fn shaped_error_is_bounded_and_zero_mean() {
        let x: Vec<f64> = noise(400_000, 9).iter().map(|s| s * 0.5).collect();
        let out = run(16, DitherMode::Shaped, 42, &x);
        let errs: Vec<f64> = out.iter().zip(&x).map(|(q, s)| *q as f64 - s * 32768.0).collect();
        assert!(errs.iter().all(|e| e.abs() <= 8.0));
        let mean = errs.iter().sum::<f64>() / errs.len() as f64;
        assert!(mean.abs() < 0.05, "mean {mean}");
    }

    #[test]
    fn same_seed_same_output() {
        let x = noise(10_000, 5);
        for mode in [DitherMode::Tpdf, DitherMode::Shaped] {
            assert_eq!(run(16, mode, 11, &x), run(16, mode, 11, &x));
            assert_ne!(run(16, mode, 11, &x), run(16, mode, 12, &x));
        }
    }
}
