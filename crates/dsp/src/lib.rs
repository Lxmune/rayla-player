#![warn(missing_docs)]
//! DSP building blocks for the Rayla player.
//!
//! Everything operates on interleaved `f64` samples. The engine normally only
//! needs [`Chain`] (built from a [`DspConfig`]), [`Quantizer`] for the final
//! float → integer conversion and [`crossfade()`] for track transitions.
//!
//! All streaming stages keep output frame `n` aligned with input frame `n`
//! (scaled by the resampling ratio): they buffer internally but never insert
//! leading silence, and `flush` hands back whatever is still buffered.

pub mod chain;
pub mod convolve;
pub mod crossfade;
pub mod crossfeed;
pub mod dither;
pub mod eq;
pub mod gain;
pub mod resample;

pub use chain::Chain;
pub use convolve::{load_wav_ir, parse_wav_ir, Convolver, ImpulseResponse};
pub use crossfade::crossfade;
pub use crossfeed::Crossfeed;
pub use dither::Quantizer;
pub use eq::{parse_autoeq, AutoEqProfile, Equalizer};
pub use gain::{resolve_gain, GainSource, Limiter, ResolvedGain};
pub use resample::Resampler;

use std::fmt;

/// Which ReplayGain value to apply.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ReplayGainMode {
    /// No ReplayGain.
    Off,
    /// Prefer the track gain.
    Track,
    /// Prefer the album gain.
    Album,
}

/// Filter type of one parametric EQ band.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum EqBandKind {
    /// Bell filter.
    Peak,
    /// Low shelf.
    LowShelf,
    /// High shelf.
    HighShelf,
}

/// One parametric EQ band.
#[derive(Clone, Debug, PartialEq)]
pub struct EqBand {
    /// Filter type.
    pub kind: EqBandKind,
    /// Centre (peak) or corner (shelf) frequency.
    pub freq_hz: f64,
    /// Boost or cut in dB.
    pub gain_db: f64,
    /// Quality factor.
    pub q: f64,
}

/// Headphone crossfeed strength.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum CrossfeedLevel {
    /// Disabled.
    Off,
    /// Weak crossfeed.
    Low,
    /// Default strength.
    Medium,
    /// Strong crossfeed.
    High,
}

/// Dither applied when quantizing to the device's integer format.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum DitherMode {
    /// Plain rounding.
    Off,
    /// Triangular dither, ±1 LSB.
    Tpdf,
    /// TPDF dither with second-order noise shaping.
    Shaped,
}

/// Whole DSP configuration; mirrors the engine API's `DspConfig` field for
/// field. `dither` is consumed by [`Quantizer`] and `crossfade_ms` by the
/// engine (with [`crossfade()`]); [`Chain`] ignores both, as well as
/// `resample_to`, which the engine resolves into the chain's output rate.
#[derive(Clone, Debug, PartialEq)]
pub struct DspConfig {
    /// Linear volume, `1.0` = unity.
    pub volume: f64,
    /// Which ReplayGain value to use.
    pub replay_gain: ReplayGainMode,
    /// Added to the ReplayGain value (only when a gain is actually applied).
    pub preamp_db: f64,
    /// Peak-based gain reduction plus a limiter at the end of the chain.
    pub clip_guard: bool,
    /// Parametric EQ on/off.
    pub eq_enabled: bool,
    /// EQ preamp in dB (usually negative to leave headroom).
    pub eq_preamp_db: f64,
    /// EQ bands.
    pub eq_bands: Vec<EqBand>,
    /// WAV impulse response for convolution; `None` disables the stage.
    pub convolution_path: Option<String>,
    /// Headphone crossfeed strength.
    pub crossfeed: CrossfeedLevel,
    /// Requested output rate; see the struct docs.
    pub resample_to: Option<u32>,
    /// Dither for the final integer conversion.
    pub dither: DitherMode,
    /// Crossfade length in ms (0 = off).
    pub crossfade_ms: u32,
}

impl Default for DspConfig {
    /// Everything off: a chain built from this is neutral.
    fn default() -> Self {
        Self {
            volume: 1.0,
            replay_gain: ReplayGainMode::Off,
            preamp_db: 0.0,
            clip_guard: false,
            eq_enabled: false,
            eq_preamp_db: 0.0,
            eq_bands: Vec::new(),
            convolution_path: None,
            crossfeed: CrossfeedLevel::Off,
            resample_to: None,
            dither: DitherMode::Off,
            crossfade_ms: 0,
        }
    }
}

/// Loudness information known about the current track. Gains are in dB,
/// peaks are linear sample peaks (1.0 = full scale).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct GainTags {
    /// Track ReplayGain in dB.
    pub track_gain_db: Option<f64>,
    /// Track sample peak (linear).
    pub track_peak: Option<f64>,
    /// Album ReplayGain in dB.
    pub album_gain_db: Option<f64>,
    /// Album sample peak (linear).
    pub album_peak: Option<f64>,
    /// Server-provided gain, used only when the file has no ReplayGain tags.
    pub fallback_gain_db: Option<f64>,
}

/// Errors from building DSP stages.
#[derive(Debug)]
pub enum Error {
    /// Reading a file failed.
    Io(std::io::Error),
    /// The impulse response file is not a WAV this crate can read.
    InvalidWav(String),
    /// An AutoEQ / EqualizerAPO text file could not be parsed.
    InvalidEq(String),
    /// The impulse response does not fit the stream (channel layout, empty).
    Convolution(String),
    /// The resampler could not be built for the requested rates.
    Resampler(String),
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::Io(e) => write!(f, "I/O error: {e}"),
            Error::InvalidWav(m) => write!(f, "invalid WAV: {m}"),
            Error::InvalidEq(m) => write!(f, "invalid EQ file: {m}"),
            Error::Convolution(m) => write!(f, "convolution: {m}"),
            Error::Resampler(m) => write!(f, "resampler: {m}"),
        }
    }
}

impl std::error::Error for Error {}

impl From<std::io::Error> for Error {
    fn from(e: std::io::Error) -> Self {
        Error::Io(e)
    }
}

#[cfg(test)]
pub(crate) mod test_util {
    use std::f64::consts::PI;

    /// Interleaved sine, same signal on every channel.
    pub fn sine(freq: f64, rate: u32, channels: usize, frames: usize, amp: f64) -> Vec<f64> {
        let mut v = Vec::with_capacity(frames * channels);
        for n in 0..frames {
            let s = amp * (2.0 * PI * freq * n as f64 / rate as f64).sin();
            v.extend(std::iter::repeat_n(s, channels));
        }
        v
    }

    pub fn rms(x: &[f64]) -> f64 {
        (x.iter().map(|s| s * s).sum::<f64>() / x.len() as f64).sqrt()
    }

    pub fn channel(x: &[f64], channels: usize, ch: usize) -> Vec<f64> {
        x.iter().skip(ch).step_by(channels).copied().collect()
    }

    /// Deterministic noise in [-1, 1).
    pub fn noise(len: usize, seed: u64) -> Vec<f64> {
        let mut s = seed | 1;
        (0..len)
            .map(|_| {
                s ^= s << 13;
                s ^= s >> 7;
                s ^= s << 17;
                (s >> 11) as f64 / (1u64 << 52) as f64 - 1.0
            })
            .collect()
    }

    /// Build a WAV file (`fmt` 1 = PCM, 3 = float) from interleaved samples.
    pub fn wav_bytes(fmt: u16, bits: u16, rate: u32, channels: u16, samples: &[f64]) -> Vec<u8> {
        let mut data = Vec::new();
        for s in samples {
            match (fmt, bits) {
                (1, 8) => data.push(((s * 127.0) as i8) as u8),
                (1, 16) => data.extend(((s * 32768.0) as i16).to_le_bytes()),
                (1, 24) => data.extend(&((s * 8_388_608.0) as i32).to_le_bytes()[..3]),
                (1, 32) => data.extend(((s * 2_147_483_648.0) as i32).to_le_bytes()),
                _ => data.extend((*s as f32).to_le_bytes()),
            }
        }
        let width = bits / 8 * channels;
        let mut v = b"RIFF".to_vec();
        v.extend((36 + data.len() as u32).to_le_bytes());
        v.extend(b"WAVEfmt ");
        v.extend(16u32.to_le_bytes());
        v.extend(fmt.to_le_bytes());
        v.extend(channels.to_le_bytes());
        v.extend(rate.to_le_bytes());
        v.extend((rate * width as u32).to_le_bytes());
        v.extend(width.to_le_bytes());
        v.extend(bits.to_le_bytes());
        v.extend(b"data");
        v.extend((data.len() as u32).to_le_bytes());
        v.extend(data);
        v
    }

    /// Feed `input` through `f` in chunks of irregular size (whole frames).
    pub fn chunked(input: &[f64], channels: usize, mut f: impl FnMut(&[f64])) {
        let sizes = [1usize, 7, 64, 1000, 3, 511, 2048, 129];
        let (mut pos, mut i) = (0, 0);
        while pos < input.len() {
            let n = (sizes[i % sizes.len()] * channels).min(input.len() - pos);
            f(&input[pos..pos + n]);
            pos += n;
            i += 1;
        }
    }
}
