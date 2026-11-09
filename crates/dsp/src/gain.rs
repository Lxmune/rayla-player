//! ReplayGain selection and the clip-guard limiter.

use crate::{GainTags, ReplayGainMode};
use std::collections::VecDeque;

/// dB → linear amplitude factor.
pub fn db_to_linear(db: f64) -> f64 {
    10f64.powf(db / 20.0)
}

/// Linear amplitude factor → dB.
pub fn linear_to_db(linear: f64) -> f64 {
    20.0 * linear.log10()
}

/// Where the applied gain value came from.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum GainSource {
    /// Track ReplayGain tag.
    Track,
    /// Album ReplayGain tag.
    Album,
    /// Server-provided fallback gain.
    Fallback,
}

/// Gain to apply to a track, after preamp and peak-based clip prevention.
#[derive(Clone, Copy, PartialEq, Debug)]
pub struct ResolvedGain {
    /// Final gain in dB.
    pub gain_db: f64,
    /// Which tag the gain came from.
    pub source: GainSource,
    /// True when the gain was lowered so that `peak * gain <= 1.0`.
    pub clip_limited: bool,
}

impl ResolvedGain {
    /// The gain as a linear factor.
    pub fn linear(&self) -> f64 {
        db_to_linear(self.gain_db)
    }
}

/// Pick the gain for a track.
///
/// `Track` mode prefers the track gain, then album, then fallback; `Album`
/// prefers album, then track, then fallback. Returns `None` when the mode is
/// `Off` or no gain value is known (the preamp is then not applied either).
/// With `clip_guard`, the gain is reduced so the matching tagged peak does not
/// exceed full scale.
pub fn resolve_gain(
    mode: ReplayGainMode,
    preamp_db: f64,
    clip_guard: bool,
    tags: &GainTags,
) -> Option<ResolvedGain> {
    let track = tags.track_gain_db.map(|g| (g, GainSource::Track, tags.track_peak));
    let album = tags.album_gain_db.map(|g| (g, GainSource::Album, tags.album_peak));
    let fallback = tags.fallback_gain_db.map(|g| (g, GainSource::Fallback, tags.track_peak));
    let (gain, source, peak) = match mode {
        ReplayGainMode::Off => return None,
        ReplayGainMode::Track => track.or(album).or(fallback)?,
        ReplayGainMode::Album => album.or(track).or(fallback)?,
    };
    let mut gain_db = gain + preamp_db;
    let mut clip_limited = false;
    if let (true, Some(peak)) = (clip_guard, peak.filter(|p| *p > 0.0)) {
        let max_db = -linear_to_db(peak);
        if gain_db > max_db {
            gain_db = max_db;
            clip_limited = true;
        }
    }
    Some(ResolvedGain { gain_db, source, clip_limited })
}

const LOOKAHEAD_SECS: f64 = 0.005;
const RELEASE_SECS: f64 = 0.100;

/// Look-ahead peak limiter with a 1.0 ceiling.
///
/// Gain reduction is linked across channels, ramps in over the look-ahead
/// window before a peak arrives and recovers with a ~100 ms release. Signals
/// that never exceed full scale pass through bit-identical. Output frames are
/// held back by [`Limiter::lookahead_frames`] until more input or `flush`.
pub struct Limiter {
    rate: u32,
    channels: usize,
    lookahead: usize,
    release: f64,
    /// Gain envelope with instant attack and exponential release.
    env: f64,
    /// Monotonic queue for the sliding minimum of `env`.
    min_queue: VecDeque<(u64, f64)>,
    /// Ring of the last `lookahead + 1` window minima, averaged for smoothing.
    avg_ring: Vec<f64>,
    avg_pos: usize,
    avg_sum: f64,
    below_unity: usize,
    count: u64,
    delay: VecDeque<f64>,
}

impl Limiter {
    /// Limiter for `channels` interleaved channels at `sample_rate` Hz.
    pub fn new(sample_rate: u32, channels: usize) -> Self {
        let lookahead = ((sample_rate as f64 * LOOKAHEAD_SECS) as usize).max(1);
        Self {
            rate: sample_rate,
            channels,
            lookahead,
            release: 1.0 - (-1.0 / (RELEASE_SECS * sample_rate as f64)).exp(),
            env: 1.0,
            min_queue: VecDeque::new(),
            avg_ring: vec![1.0; lookahead + 1],
            avg_pos: 0,
            avg_sum: (lookahead + 1) as f64,
            below_unity: 0,
            count: 0,
            delay: VecDeque::with_capacity((lookahead + 1) * channels),
        }
    }

    /// Frames buffered inside the limiter.
    pub fn lookahead_frames(&self) -> usize {
        self.lookahead
    }

    /// Take the gain a new frame needs and return the smoothed gain for the
    /// frame `lookahead` frames earlier.
    ///
    /// Sliding minimum over `lookahead + 1` frames followed by a moving
    /// average of the same length: every value in the average is a minimum
    /// over a window containing the delayed frame, so the result never
    /// exceeds what that frame needs.
    fn gain_step(&mut self, needed: f64) -> f64 {
        self.env = needed.min(self.env + (1.0 - self.env) * self.release);
        let window = self.avg_ring.len();
        let n = self.count;
        self.count += 1;
        while self.min_queue.back().is_some_and(|&(_, v)| v >= self.env) {
            self.min_queue.pop_back();
        }
        self.min_queue.push_back((n, self.env));
        while self.min_queue.front().is_some_and(|&(i, _)| i + window as u64 <= n) {
            self.min_queue.pop_front();
        }
        let min = self.min_queue.front().map_or(1.0, |&(_, v)| v);

        let old = std::mem::replace(&mut self.avg_ring[self.avg_pos], min);
        self.avg_pos = (self.avg_pos + 1) % window;
        self.below_unity += (min < 1.0) as usize;
        self.below_unity -= (old < 1.0) as usize;
        if self.below_unity == 0 {
            // Resync so rounding drift cannot leak into untouched passages.
            self.avg_sum = window as f64;
            return 1.0;
        }
        self.avg_sum += min - old;
        (self.avg_sum / window as f64).min(1.0)
    }

    fn pop_frame(&mut self, gain: f64, out: &mut Vec<f64>) {
        for _ in 0..self.channels {
            let s = self.delay.pop_front().unwrap_or(0.0);
            // The clamp only catches last-bit rounding of the gain product.
            out.push(if gain == 1.0 { s } else { (s * gain).clamp(-1.0, 1.0) });
        }
    }

    /// Limit interleaved `input`, appending the frames that are ready to `out`.
    pub fn process(&mut self, input: &[f64], out: &mut Vec<f64>) {
        for frame in input.chunks_exact(self.channels) {
            let peak = frame.iter().fold(0.0f64, |m, s| m.max(s.abs()));
            let gain = self.gain_step(if peak > 1.0 { 1.0 / peak } else { 1.0 });
            self.delay.extend(frame);
            if self.delay.len() > self.lookahead * self.channels {
                self.pop_frame(gain, out);
            }
        }
    }

    /// Append the buffered tail to `out` and reset for a new stream.
    pub fn flush(&mut self, out: &mut Vec<f64>) {
        while !self.delay.is_empty() {
            let gain = self.gain_step(1.0);
            self.pop_frame(gain, out);
        }
        *self = Limiter::new(self.rate, self.channels);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_util::*;

    fn tags() -> GainTags {
        GainTags {
            track_gain_db: Some(-7.0),
            track_peak: Some(0.9),
            album_gain_db: Some(-5.0),
            album_peak: Some(1.0),
            fallback_gain_db: Some(-3.0),
        }
    }

    #[test]
    fn selects_track_album_fallback_off() {
        let t = tags();
        assert_eq!(resolve_gain(ReplayGainMode::Off, 3.0, true, &t), None);
        let r = resolve_gain(ReplayGainMode::Track, 0.0, false, &t).unwrap();
        assert_eq!((r.gain_db, r.source), (-7.0, GainSource::Track));
        let r = resolve_gain(ReplayGainMode::Album, 1.5, false, &t).unwrap();
        assert_eq!((r.gain_db, r.source), (-3.5, GainSource::Album));
        assert!((r.linear() - 10f64.powf(-3.5 / 20.0)).abs() < 1e-12);

        // Missing values fall through to the other tag, then the fallback.
        let no_album = GainTags { album_gain_db: None, ..t };
        let r = resolve_gain(ReplayGainMode::Album, 0.0, false, &no_album).unwrap();
        assert_eq!(r.source, GainSource::Track);
        let only_fallback = GainTags { fallback_gain_db: Some(-3.0), ..Default::default() };
        let r = resolve_gain(ReplayGainMode::Track, 0.0, false, &only_fallback).unwrap();
        assert_eq!((r.gain_db, r.source), (-3.0, GainSource::Fallback));
        assert_eq!(resolve_gain(ReplayGainMode::Track, 6.0, true, &GainTags::default()), None);
    }

    #[test]
    fn peak_prevents_clipping() {
        let t = GainTags { track_gain_db: Some(4.0), track_peak: Some(0.8), ..Default::default() };
        let r = resolve_gain(ReplayGainMode::Track, 2.0, true, &t).unwrap();
        assert!(r.clip_limited);
        assert!((r.linear() * 0.8 - 1.0).abs() < 1e-12);
        // Without clip guard the gain is applied as tagged.
        let r = resolve_gain(ReplayGainMode::Track, 2.0, false, &t).unwrap();
        assert!(!r.clip_limited);
        assert_eq!(r.gain_db, 6.0);
        // Gain that keeps the peak below full scale is left alone.
        let r = resolve_gain(ReplayGainMode::Track, -6.0, true, &t).unwrap();
        assert!(!r.clip_limited);
        assert_eq!(r.gain_db, -2.0);
    }

    fn run(input: &[f64], channels: usize) -> Vec<f64> {
        let mut lim = Limiter::new(48_000, channels);
        let mut out = Vec::new();
        chunked(input, channels, |c| lim.process(c, &mut out));
        lim.flush(&mut out);
        out
    }

    #[test]
    fn limiter_caps_loud_input() {
        let mut input = sine(997.0, 48_000, 2, 48_000, 2.5);
        // Quiet lead-in, sudden loud section, isolated spikes.
        for s in &mut input[..20_000] {
            *s *= 0.1;
        }
        input[70_001] = -9.0;
        input[90_000] = 30.0;
        let out = run(&input, 2);
        assert_eq!(out.len(), input.len());
        let max = out.iter().fold(0.0f64, |m, s| m.max(s.abs()));
        assert!(max <= 1.0, "max {max}");
        // It limits rather than mutes: the loud section stays near full scale.
        assert!(max > 0.95);
        assert!(rms(&out[40_000..60_000]) > 0.5);
    }

    #[test]
    fn limiter_leaves_quiet_input_unchanged() {
        let input = sine(440.0, 48_000, 2, 20_000, 0.99);
        assert_eq!(run(&input, 2), input);
        // Exactly full scale is still not touched.
        let input = vec![1.0, -1.0, 0.5, 1.0];
        assert_eq!(run(&input, 1), input);
    }

    #[test]
    fn limiter_recovers_and_is_reusable() {
        let mut lim = Limiter::new(48_000, 1);
        let mut input = vec![0.5; 48_000];
        input[100] = 4.0;
        let mut out = Vec::new();
        lim.process(&input, &mut out);
        lim.flush(&mut out);
        assert_eq!(out.len(), input.len());
        assert!((out[100] - 1.0).abs() < 1e-9);
        // Well after the release the gain is back to unity.
        assert!((out[47_000] - 0.5).abs() < 1e-3);
        let mut again = Vec::new();
        lim.process(&input, &mut again);
        lim.flush(&mut again);
        assert_eq!(out, again);
    }
}
