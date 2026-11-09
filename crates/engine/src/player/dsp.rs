//! Sample-domain processing between decoder and device.
//!
//! One [`DspStream`] per track wraps a `rayla_dsp::Chain`, the pending
//! (processed, not yet written) audio and the final quantizer. When the chain
//! is neutral and no dither is needed, integer samples bypass `f64` entirely
//! and reach the device untouched.

use crate::api::engine as api;
use crate::api::engine::TrackRequest;
use crate::decode::TrackInfo;
use rayla_dsp as d;

const SCALE: f64 = 2147483648.0;

fn map_config(c: &api::DspConfig) -> d::DspConfig {
    d::DspConfig {
        volume: c.volume,
        replay_gain: match c.replay_gain {
            api::ReplayGainMode::Off => d::ReplayGainMode::Off,
            api::ReplayGainMode::Track => d::ReplayGainMode::Track,
            api::ReplayGainMode::Album => d::ReplayGainMode::Album,
        },
        preamp_db: c.preamp_db,
        clip_guard: c.clip_guard,
        eq_enabled: c.eq_enabled,
        eq_preamp_db: c.eq_preamp_db,
        eq_bands: c
            .eq_bands
            .iter()
            .map(|b| d::EqBand {
                kind: match b.kind {
                    api::EqBandKind::Peak => d::EqBandKind::Peak,
                    api::EqBandKind::LowShelf => d::EqBandKind::LowShelf,
                    api::EqBandKind::HighShelf => d::EqBandKind::HighShelf,
                },
                freq_hz: b.freq_hz,
                gain_db: b.gain_db,
                q: b.q,
            })
            .collect(),
        convolution_path: c.convolution_path.clone(),
        crossfeed: match c.crossfeed {
            api::CrossfeedLevel::Off => d::CrossfeedLevel::Off,
            api::CrossfeedLevel::Low => d::CrossfeedLevel::Low,
            api::CrossfeedLevel::Medium => d::CrossfeedLevel::Medium,
            api::CrossfeedLevel::High => d::CrossfeedLevel::High,
        },
        resample_to: c.resample_to,
        dither: dither_mode(c.dither),
        crossfade_ms: c.crossfade_ms,
    }
}

fn dither_mode(m: api::DitherMode) -> d::DitherMode {
    match m {
        api::DitherMode::Off => d::DitherMode::Off,
        api::DitherMode::Tpdf => d::DitherMode::Tpdf,
        api::DitherMode::Shaped => d::DitherMode::Shaped,
    }
}

/// Deterministic per-track dither seed.
fn seed_for(id: &str) -> u64 {
    id.bytes()
        .fold(0xcbf2_9ce4_8422_2325u64, |h, b| (h ^ b as u64).wrapping_mul(0x100_0000_01b3))
}

pub struct DspStream {
    chain: d::Chain,
    quant: d::Quantizer,
    bits: u32,
    channels: usize,
    in_rate: u32,
    out_rate: u32,
    dither: api::DitherMode,
    dither_active: bool,
    bypass: bool,
    flushed: bool,
    seed: u64,
    scratch: Vec<f64>,
    /// Processed audio (device rate, interleaved) not yet written.
    pub pending: Vec<f64>,
}

impl DspStream {
    pub fn new(
        cfg: &api::DspConfig,
        info: &TrackInfo,
        req: &TrackRequest,
        out_rate: u32,
    ) -> Result<DspStream, String> {
        let tags = d::GainTags {
            track_gain_db: info.replay_gain.track_gain_db,
            track_peak: info.replay_gain.track_peak,
            album_gain_db: info.replay_gain.album_gain_db,
            album_peak: info.replay_gain.album_peak,
            fallback_gain_db: req.fallback_gain_db,
        };
        let channels = info.channels as usize;
        let chain = d::Chain::new(&map_config(cfg), info.sample_rate, channels, out_rate, &tags)
            .map_err(|e| format!("cannot build DSP chain: {e}"))?;
        let seed = seed_for(&req.id);
        let bypass = chain.is_neutral() && cfg.dither == api::DitherMode::Off;
        Ok(DspStream {
            chain,
            quant: d::Quantizer::new(24, d::DitherMode::Off, channels, seed),
            bits: 24,
            channels,
            in_rate: info.sample_rate,
            out_rate,
            dither: cfg.dither,
            dither_active: false,
            bypass,
            flushed: false,
            seed,
            scratch: Vec::new(),
            pending: Vec::new(),
        })
    }

    /// Fix the device depth once the output is open. Dither is applied only
    /// where quantization actually loses information.
    pub fn bind_output(&mut self, dev_bits: u32, src_bits: u32) {
        let needed = !self.chain.is_neutral() || src_bits == 0 || src_bits > dev_bits;
        self.dither_active = self.dither != api::DitherMode::Off && needed;
        self.bypass = self.chain.is_neutral() && !self.dither_active;
        let mode = if self.dither_active {
            dither_mode(self.dither)
        } else {
            d::DitherMode::Off
        };
        self.bits = dev_bits.clamp(8, 32);
        self.quant = d::Quantizer::new(self.bits, mode, self.channels, self.seed);
    }

    pub fn out_rate(&self) -> u32 {
        self.out_rate
    }

    pub fn is_neutral(&self) -> bool {
        self.chain.is_neutral()
    }

    pub fn describe(&self) -> Vec<String> {
        let mut s = self.chain.describe();
        if self.dither_active {
            s.push(format!("Dither {:?}", self.dither));
        }
        s
    }

    pub fn pending_frames(&self) -> usize {
        self.pending.len() / self.channels
    }

    /// Pending audio expressed in source-rate frames.
    pub fn pending_src_frames(&self) -> u64 {
        self.pending_frames() as u64 * self.in_rate as u64 / self.out_rate as u64
    }

    /// Source frames that produce about `out_frames` output frames.
    pub fn src_for_out(&self, out_frames: usize) -> usize {
        ((out_frames as u64 * self.in_rate as u64).div_ceil(self.out_rate as u64) as usize).max(1)
    }

    pub fn can_bypass(&self) -> bool {
        self.bypass && self.pending.is_empty()
    }

    /// Run a source block through the chain into `pending`.
    pub fn feed(&mut self, block: &[i32]) {
        self.scratch.clear();
        self.scratch.extend(block.iter().map(|&s| s as f64 / SCALE));
        self.chain.process(&self.scratch, &mut self.pending);
    }

    /// Quantize and remove the first `frames` frames of `pending`; the result
    /// is left-justified in the 32-bit word.
    pub fn take(&mut self, frames: usize) -> Vec<i32> {
        let n = (frames * self.channels).min(self.pending.len());
        let mut out = Vec::with_capacity(n);
        self.quant.quantize(&self.pending[..n], &mut out);
        self.pending.drain(..n);
        if self.bits < 32 {
            let sh = 32 - self.bits;
            out.iter_mut().for_each(|s| *s <<= sh);
        }
        out
    }

    /// One source block in, the samples to write now out. `hold` frames of
    /// processed audio are kept back (crossfade tail).
    pub fn render(&mut self, block: Vec<i32>, hold: usize) -> Vec<i32> {
        if hold == 0 && self.can_bypass() {
            return block;
        }
        self.feed(&block);
        let n = self.pending_frames().saturating_sub(hold);
        self.take(n)
    }

    /// End of stream: move the chain's buffered tail into `pending`.
    pub fn flush(&mut self) {
        if !self.flushed {
            self.flushed = true;
            self.chain.flush(&mut self.pending);
        }
    }

    /// Forget buffered chain state (after a seek).
    pub fn reset_chain(&mut self) {
        let mut sink = Vec::new();
        self.chain.flush(&mut sink);
        self.flushed = false;
        self.pending.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seed_is_stable_per_id() {
        assert_eq!(seed_for("a"), seed_for("a"));
        assert_ne!(seed_for("a"), seed_for("b"));
    }
}
