//! The per-stream processing chain.

use crate::compressor::Compressor;
use crate::convolve::{load_wav_ir, Convolver};
use crate::crossfeed::Crossfeed;
use crate::eq::Equalizer;
use crate::gain::{linear_to_db, resolve_gain, GainSource, Limiter};
use crate::resample::Resampler;
use crate::{CrossfeedLevel, DspConfig, Error, GainTags};

/// ReplayGain/preamp → volume → EQ → convolution → crossfeed → compressor → resampler →
/// limiter, built for one stream (sample rate, channel count, track tags).
///
/// Stages that are off are not built. Build a new chain when the config or the
/// track changes; there is no parameter smoothing. The limiter is only added
/// with `clip_guard` when some stage can raise the level (gain above 0 dB,
/// volume above 1, EQ, convolution, crossfeed, compressor makeup or resampling).
pub struct Chain {
    channels: usize,
    out_rate: u32,
    /// ReplayGain × volume as one linear factor.
    gain: f64,
    eq: Option<Equalizer>,
    conv: Option<Convolver>,
    crossfeed: Option<Crossfeed>,
    compressor: Option<Compressor>,
    resampler: Option<Resampler>,
    limiter: Option<Limiter>,
    stages: Vec<String>,
    cur: Vec<f64>,
    next: Vec<f64>,
}

fn signed_db(db: f64) -> String {
    if db < 0.0 {
        format!("\u{2212}{:.1} dB", -db)
    } else {
        format!("+{db:.1} dB")
    }
}

fn khz(rate: u32) -> String {
    let s = format!("{:.3}", rate as f64 / 1000.0);
    s.trim_end_matches('0').trim_end_matches('.').to_string()
}

impl Chain {
    /// Build the chain for a stream of `channels` interleaved channels at
    /// `stream_rate` Hz, producing `output_rate` Hz. `tags` carry the track's
    /// ReplayGain data. Fails if the impulse response cannot be loaded or does
    /// not fit the stream, or the resampler cannot be built.
    pub fn new(
        config: &DspConfig,
        stream_rate: u32,
        channels: usize,
        output_rate: u32,
        tags: &GainTags,
    ) -> Result<Chain, Error> {
        let mut stages = Vec::new();
        let mut gain = 1.0;
        let mut boosts = false;
        if let Some(rg) = resolve_gain(config.replay_gain, config.preamp_db, config.clip_guard, tags) {
            if rg.gain_db != 0.0 {
                gain *= rg.linear();
                boosts |= rg.gain_db > 0.0;
            }
            let src = match rg.source {
                GainSource::Track => "track",
                GainSource::Album => "album",
                GainSource::Fallback => "server",
            };
            stages.push(format!("ReplayGain {} ({src})", signed_db(rg.gain_db)));
        }
        if config.volume != 1.0 {
            gain *= config.volume;
            boosts |= config.volume > 1.0;
            stages.push(if config.volume > 0.0 {
                format!("Volume {}", signed_db(linear_to_db(config.volume)))
            } else {
                "Volume muted".to_string()
            });
        }

        let mut eq = None;
        if config.eq_enabled && (!config.eq_bands.is_empty() || config.eq_preamp_db != 0.0) {
            eq = Some(Equalizer::new(stream_rate, channels, config.eq_preamp_db, &config.eq_bands));
            let n = config.eq_bands.len();
            stages.push(format!("Parametric EQ ({n} band{})", if n == 1 { "" } else { "s" }));
        }

        let mut conv = None;
        if let Some(path) = &config.convolution_path {
            let c = Convolver::new(&load_wav_ir(path)?, stream_rate, channels)?;
            stages.push(format!("Convolution ({} taps)", c.ir_len()));
            conv = Some(c);
        }

        let crossfeed = Crossfeed::new(config.crossfeed, stream_rate, channels);
        let crossfeed = crossfeed.is_active().then_some(crossfeed);
        if crossfeed.is_some() {
            stages.push(format!("Crossfeed ({:?})", config.crossfeed));
        }
        debug_assert!(crossfeed.is_some() || config.crossfeed == CrossfeedLevel::Off || channels != 2);

        let mut compressor = None;
        let c = &config.compressor;
        if c.enabled {
            compressor = Some(Compressor::new(c, stream_rate, channels));
            stages.push(format!(
                "Compressor {}, {}:1{}",
                signed_db(c.threshold_db),
                c.ratio,
                if c.makeup_db != 0.0 { format!(", makeup {}", signed_db(c.makeup_db)) } else { String::new() }
            ));
        }
        let comp_raises = compressor.is_some() && c.makeup_db > 0.0;

        let mut resampler = None;
        if output_rate != stream_rate {
            resampler = Some(Resampler::new(stream_rate, output_rate, channels)?);
            stages.push(format!("Resample {} \u{2192} {} kHz", khz(stream_rate), khz(output_rate)));
        }

        let can_raise = boosts || comp_raises || eq.is_some() || conv.is_some() || crossfeed.is_some() || resampler.is_some();
        let limiter = (config.clip_guard && can_raise).then(|| Limiter::new(output_rate, channels));
        if limiter.is_some() {
            stages.push("Limiter".to_string());
        }

        Ok(Chain {
            channels,
            out_rate: output_rate,
            gain,
            eq,
            conv,
            crossfeed,
            compressor,
            resampler,
            limiter,
            stages,
            cur: Vec::new(),
            next: Vec::new(),
        })
    }

    /// True when the chain would not alter any sample, so the engine can skip
    /// it and keep the stream bit-perfect.
    pub fn is_neutral(&self) -> bool {
        self.stages.is_empty()
    }

    /// Sample rate of the chain's output.
    pub fn output_sample_rate(&self) -> u32 {
        self.out_rate
    }

    /// Human-readable active stages in processing order.
    pub fn describe(&self) -> Vec<String> {
        self.stages.clone()
    }

    /// Process interleaved `input`, appending the result to `out`. Output may
    /// lag the input (convolution and resampler buffer in blocks, the limiter
    /// looks ahead) and have a different length; `flush` yields the rest.
    pub fn process(&mut self, input: &[f64], out: &mut Vec<f64>) {
        if self.is_neutral() {
            out.extend_from_slice(input);
            return;
        }
        let mut cur = std::mem::take(&mut self.cur);
        cur.clear();
        cur.extend_from_slice(input);
        if self.gain != 1.0 {
            cur.iter_mut().for_each(|s| *s *= self.gain);
        }
        if let Some(eq) = &mut self.eq {
            eq.process(&mut cur);
        }
        if let Some(conv) = &mut self.conv {
            let mut next = std::mem::take(&mut self.next);
            next.clear();
            conv.process(&cur, &mut next);
            std::mem::swap(&mut cur, &mut next);
            self.next = next;
        }
        self.finish(cur, out, false);
    }

    /// Output everything still buffered (convolution tail, resampler and
    /// limiter delay) and reset the chain for the next stream.
    pub fn flush(&mut self, out: &mut Vec<f64>) {
        if self.is_neutral() {
            return;
        }
        let mut cur = std::mem::take(&mut self.cur);
        cur.clear();
        if let Some(conv) = &mut self.conv {
            conv.flush(&mut cur);
        }
        if let Some(eq) = &mut self.eq {
            eq.reset();
        }
        self.finish(cur, out, true);
    }

    /// Crossfeed → compressor → resampler → limiter on `cur`, appending to `out`.
    fn finish(&mut self, mut cur: Vec<f64>, out: &mut Vec<f64>, flushing: bool) {
        if let Some(cf) = &mut self.crossfeed {
            cf.process(&mut cur);
            if flushing {
                cf.reset();
            }
        }
        if let Some(comp) = &mut self.compressor {
            comp.process(&mut cur);
            if flushing {
                comp.reset();
            }
        }
        if let Some(rs) = &mut self.resampler {
            let mut next = std::mem::take(&mut self.next);
            next.clear();
            rs.process(&cur, &mut next);
            if flushing {
                rs.flush(&mut next);
            }
            std::mem::swap(&mut cur, &mut next);
            self.next = next;
        }
        match &mut self.limiter {
            Some(lim) => {
                lim.process(&cur, out);
                if flushing {
                    lim.flush(out);
                }
            }
            None => out.extend_from_slice(&cur),
        }
        debug_assert_eq!(out.len() % self.channels, 0);
        self.cur = cur;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_util::*;
    use crate::{EqBand, EqBandKind, ReplayGainMode};

    fn run(chain: &mut Chain, x: &[f64], channels: usize, chunks: bool) -> Vec<f64> {
        let mut out = Vec::new();
        if chunks {
            chunked(x, channels, |c| chain.process(c, &mut out));
        } else {
            chain.process(x, &mut out);
        }
        chain.flush(&mut out);
        out
    }

    fn tags() -> GainTags {
        GainTags { album_gain_db: Some(-6.2), album_peak: Some(0.95), ..Default::default() }
    }

    #[test]
    fn default_config_is_neutral_and_passes_through() {
        let mut c = Chain::new(&DspConfig::default(), 44_100, 2, 44_100, &tags()).unwrap();
        assert!(c.is_neutral());
        assert!(c.describe().is_empty());
        let x = noise(2000, 1);
        assert_eq!(run(&mut c, &x, 2, true), x);
        // Features that are enabled but do nothing keep the chain neutral too.
        let cfg = DspConfig { eq_enabled: true, clip_guard: true, ..Default::default() };
        assert!(Chain::new(&cfg, 44_100, 2, 44_100, &tags()).unwrap().is_neutral());
        let cfg = DspConfig { crossfeed: CrossfeedLevel::High, ..Default::default() };
        assert!(Chain::new(&cfg, 44_100, 1, 44_100, &tags()).unwrap().is_neutral());
    }

    #[test]
    fn compressor_stage_is_described_and_makeup_adds_the_limiter() {
        use crate::CompressorSettings;
        let comp = CompressorSettings { enabled: true, ..Default::default() };
        let cfg = DspConfig { compressor: comp, clip_guard: true, ..Default::default() };
        let c = Chain::new(&cfg, 48_000, 2, 48_000, &tags()).unwrap();
        assert_eq!(c.describe(), vec!["Compressor \u{2212}18.0 dB, 3:1".to_string()]);
        let cfg = DspConfig { compressor: CompressorSettings { makeup_db: 4.0, ..comp }, clip_guard: true, ..Default::default() };
        let c = Chain::new(&cfg, 48_000, 2, 48_000, &tags()).unwrap();
        assert_eq!(c.describe(), vec!["Compressor \u{2212}18.0 dB, 3:1, makeup +4.0 dB".to_string(), "Limiter".to_string()]);
    }

    fn full_config(ir_path: &str) -> DspConfig {
        DspConfig {
            volume: 0.8,
            replay_gain: ReplayGainMode::Album,
            preamp_db: 1.0,
            clip_guard: true,
            eq_enabled: true,
            eq_preamp_db: -2.0,
            eq_bands: vec![
                EqBand { kind: EqBandKind::LowShelf, freq_hz: 100.0, gain_db: 4.0, q: 0.7 },
                EqBand { kind: EqBandKind::Peak, freq_hz: 3000.0, gain_db: -3.0, q: 2.0 },
            ],
            convolution_path: Some(ir_path.to_string()),
            crossfeed: CrossfeedLevel::Medium,
            ..Default::default()
        }
    }

    #[test]
    fn full_chain_is_chunking_independent_and_describes_stages() {
        let ir: Vec<f64> = (0..2500).map(|i| noise(2500, 8)[i] * 0.01 * (-(i as f64) / 600.0).exp()).collect();
        let path = std::env::temp_dir().join(format!("rayla_dsp_ir_{}.wav", std::process::id()));
        std::fs::write(&path, wav_bytes(3, 32, 44_100, 1, &ir)).unwrap();
        let cfg = full_config(path.to_str().unwrap());

        let x: Vec<f64> = noise(2 * 9000, 4).iter().map(|s| s * 0.9).collect();
        let build = || Chain::new(&cfg, 44_100, 2, 48_000, &tags()).unwrap();
        let mut c = build();
        assert_eq!(c.output_sample_rate(), 48_000);
        assert_eq!(
            c.describe(),
            [
                "ReplayGain \u{2212}5.2 dB (album)".to_string(),
                "Volume \u{2212}1.9 dB".into(),
                "Parametric EQ (2 bands)".into(),
                "Convolution (2500 taps)".into(),
                "Crossfeed (Medium)".into(),
                "Resample 44.1 \u{2192} 48 kHz".into(),
                "Limiter".into(),
            ]
        );
        assert!(!c.is_neutral());
        let one = run(&mut c, &x, 2, false);
        let many = run(&mut build(), &x, 2, true);
        assert_eq!(one.len(), many.len());
        // 9000 input frames + 2499 tail frames, resampled.
        let expected = ((9000 + 2499) as f64 * 48_000.0 / 44_100.0).round() as usize;
        assert_eq!(one.len(), expected * 2);
        assert!(one.iter().zip(&many).all(|(a, b)| (a - b).abs() < 1e-9));
        assert!(one.iter().all(|s| s.abs() <= 1.0));
        // Reusable after flush.
        let again = run(&mut c, &x, 2, true);
        assert!(one.iter().zip(&again).all(|(a, b)| (a - b).abs() < 1e-9));
        std::fs::remove_file(path).ok();
    }

    #[test]
    fn describe_lists_only_active_stages() {
        let cfg = DspConfig { replay_gain: ReplayGainMode::Track, ..Default::default() };
        let t = GainTags { track_gain_db: Some(2.0), ..Default::default() };
        let c = Chain::new(&cfg, 44_100, 2, 44_100, &t).unwrap();
        assert_eq!(c.describe(), ["ReplayGain +2.0 dB (track)"]);
        // No tags: nothing to apply, nothing listed.
        assert!(Chain::new(&cfg, 44_100, 2, 44_100, &GainTags::default()).unwrap().is_neutral());
        let cfg = DspConfig { eq_enabled: true, eq_bands: vec![EqBand { kind: EqBandKind::Peak, freq_hz: 1000.0, gain_db: 1.0, q: 1.0 }], ..Default::default() };
        assert_eq!(Chain::new(&cfg, 44_100, 2, 96_000, &tags()).unwrap().describe(), ["Parametric EQ (1 band)", "Resample 44.1 \u{2192} 96 kHz"]);
    }

    #[test]
    fn gain_and_limiter_guarantee_no_clipping() {
        let cfg = DspConfig { replay_gain: ReplayGainMode::Track, clip_guard: true, ..Default::default() };
        let t = GainTags { track_gain_db: Some(12.0), ..Default::default() };
        let mut c = Chain::new(&cfg, 44_100, 2, 44_100, &t).unwrap();
        assert!(c.describe().contains(&"Limiter".to_string()));
        let x = sine(440.0, 44_100, 2, 20_000, 0.9);
        let y = run(&mut c, &x, 2, true);
        assert_eq!(y.len(), x.len());
        assert!(y.iter().all(|s| s.abs() <= 1.0));
    }
}
