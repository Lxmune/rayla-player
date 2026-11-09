//! Equal-power crossfade between two buffers.

use std::f64::consts::FRAC_PI_2;

/// Mix the end of one track into the start of the next.
///
/// `tail` (the last frames of the outgoing track) fades out with a cosine
/// curve while `head` (the first frames of the incoming track) fades in with
/// a sine curve, so the summed power stays constant for uncorrelated signals.
/// Both are interleaved with `channels` channels; the result has
/// `min(tail, head)` frames.
pub fn crossfade(tail: &[f64], head: &[f64], channels: usize) -> Vec<f64> {
    let frames = tail.len().min(head.len()) / channels.max(1);
    let mut out = Vec::with_capacity(frames * channels);
    for n in 0..frames {
        let (s, c) = (FRAC_PI_2 * (n as f64 + 0.5) / frames as f64).sin_cos();
        for ch in 0..channels {
            out.push(tail[n * channels + ch] * c + head[n * channels + ch] * s);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn equal_power_and_endpoints() {
        let n = 1000;
        let out = crossfade(&vec![1.0; n * 2], &vec![1.0; n * 2], 2);
        assert_eq!(out.len(), n * 2);
        // Correlated unity signals sum to between 1 and sqrt(2).
        assert!(out.iter().all(|s| (1.0..=2f64.sqrt() + 1e-9).contains(s)));
        let out = crossfade(&vec![1.0; n], &vec![0.0; n], 1);
        assert!(out[0] > 0.999 && out[n - 1] < 0.002);
        // Power of two orthogonal signals is constant.
        let a: Vec<f64> = (0..n).flat_map(|_| [1.0, 0.0]).collect();
        let b: Vec<f64> = (0..n).flat_map(|_| [0.0, 1.0]).collect();
        let out = crossfade(&a, &b, 2);
        for f in out.chunks(2) {
            assert!((f[0] * f[0] + f[1] * f[1] - 1.0).abs() < 1e-12);
        }
    }

    #[test]
    fn uses_shorter_length() {
        assert_eq!(crossfade(&[1.0; 10], &[1.0; 6], 2).len(), 6);
    }
}
