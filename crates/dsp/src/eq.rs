//! Parametric equalizer (RBJ biquads) and the AutoEQ text parser.

use crate::gain::db_to_linear;
use crate::{EqBand, EqBandKind, Error};
use std::f64::consts::PI;

#[derive(Clone, Copy, Debug)]
struct Coeffs {
    b0: f64,
    b1: f64,
    b2: f64,
    a1: f64,
    a2: f64,
}

impl Coeffs {
    /// RBJ cookbook coefficients, normalised so that `a0 == 1`.
    fn design(band: &EqBand, rate: f64) -> Coeffs {
        let f0 = band.freq_hz.clamp(10.0, rate * 0.49);
        let q = band.q.max(0.05);
        let a = 10f64.powf(band.gain_db / 40.0);
        let w0 = 2.0 * PI * f0 / rate;
        let (sin, cos) = w0.sin_cos();
        let alpha = sin / (2.0 * q);
        let (b0, b1, b2, a0, a1, a2) = match band.kind {
            EqBandKind::Peak => (
                1.0 + alpha * a,
                -2.0 * cos,
                1.0 - alpha * a,
                1.0 + alpha / a,
                -2.0 * cos,
                1.0 - alpha / a,
            ),
            EqBandKind::LowShelf => {
                let t = 2.0 * a.sqrt() * alpha;
                (
                    a * ((a + 1.0) - (a - 1.0) * cos + t),
                    2.0 * a * ((a - 1.0) - (a + 1.0) * cos),
                    a * ((a + 1.0) - (a - 1.0) * cos - t),
                    (a + 1.0) + (a - 1.0) * cos + t,
                    -2.0 * ((a - 1.0) + (a + 1.0) * cos),
                    (a + 1.0) + (a - 1.0) * cos - t,
                )
            }
            EqBandKind::HighShelf => {
                let t = 2.0 * a.sqrt() * alpha;
                (
                    a * ((a + 1.0) + (a - 1.0) * cos + t),
                    -2.0 * a * ((a - 1.0) + (a + 1.0) * cos),
                    a * ((a + 1.0) + (a - 1.0) * cos - t),
                    (a + 1.0) - (a - 1.0) * cos + t,
                    2.0 * ((a - 1.0) - (a + 1.0) * cos),
                    (a + 1.0) - (a - 1.0) * cos - t,
                )
            }
        };
        Coeffs {
            b0: b0 / a0,
            b1: b1 / a0,
            b2: b2 / a0,
            a1: a1 / a0,
            a2: a2 / a0,
        }
    }
}

/// Cascade of biquad filters with an overall preamp, one filter state per
/// channel. Processing is in place on interleaved samples and has no latency.
pub struct Equalizer {
    channels: usize,
    preamp: f64,
    coeffs: Vec<Coeffs>,
    /// Transposed direct form II state, `[band][channel]`.
    state: Vec<Vec<[f64; 2]>>,
}

impl Equalizer {
    /// Build the EQ for `channels` interleaved channels at `sample_rate` Hz.
    /// Frequencies are clamped below Nyquist.
    pub fn new(sample_rate: u32, channels: usize, preamp_db: f64, bands: &[EqBand]) -> Self {
        let rate = sample_rate as f64;
        Equalizer {
            channels,
            preamp: db_to_linear(preamp_db),
            coeffs: bands.iter().map(|b| Coeffs::design(b, rate)).collect(),
            state: vec![vec![[0.0; 2]; channels]; bands.len()],
        }
    }

    /// Filter interleaved `buf` in place.
    pub fn process(&mut self, buf: &mut [f64]) {
        if self.preamp != 1.0 {
            buf.iter_mut().for_each(|s| *s *= self.preamp);
        }
        for (c, st) in self.coeffs.iter().zip(self.state.iter_mut()) {
            for (ch, z) in st.iter_mut().enumerate() {
                for s in buf.iter_mut().skip(ch).step_by(self.channels) {
                    let x = *s;
                    let y = c.b0 * x + z[0];
                    z[0] = c.b1 * x - c.a1 * y + z[1];
                    z[1] = c.b2 * x - c.a2 * y;
                    *s = y;
                }
            }
        }
    }

    /// Clear the filter memory.
    pub fn reset(&mut self) {
        self.state.iter_mut().flatten().for_each(|z| *z = [0.0; 2]);
    }
}

/// A parsed AutoEQ / EqualizerAPO `ParametricEQ.txt`.
#[derive(Clone, Debug, PartialEq)]
pub struct AutoEqProfile {
    /// `Preamp:` value in dB (0 when absent).
    pub preamp_db: f64,
    /// The enabled filters, in file order.
    pub bands: Vec<EqBand>,
}

/// Parse AutoEQ text such as
/// `Preamp: -6.2 dB` and `Filter 1: ON PK Fc 105 Hz Gain -3.5 dB Q 0.70`.
///
/// Supported filter types are `PK`, `LSC`/`LS` (low shelf) and `HSC`/`HS`
/// (high shelf); `OFF` filters are skipped and shelves without `Q` use 0.707.
/// Unrelated lines are ignored; a malformed `Filter` line or a file without a
/// preamp or filter is an error.
pub fn parse_autoeq(text: &str) -> Result<AutoEqProfile, Error> {
    let bad = |line: &str| Error::InvalidEq(format!("cannot parse line: {line}"));
    let mut preamp = None;
    let mut bands = Vec::new();
    let mut seen_filter = false;
    for line in text.lines().map(str::trim) {
        let lower = line.to_ascii_lowercase();
        if let Some(rest) = lower.strip_prefix("preamp:") {
            let v = rest.split_whitespace().next().ok_or_else(|| bad(line))?;
            preamp = Some(v.parse::<f64>().map_err(|_| bad(line))?);
        } else if lower.starts_with("filter") {
            seen_filter = true;
            let (_, body) = lower.split_once(':').ok_or_else(|| bad(line))?;
            let tok: Vec<&str> = body.split_whitespace().collect();
            match tok.first() {
                Some(&"off") => continue,
                Some(&"on") => {}
                _ => return Err(bad(line)),
            }
            let kind = match tok.get(1).copied() {
                Some("pk") | Some("peq") => EqBandKind::Peak,
                Some("lsc") | Some("ls") => EqBandKind::LowShelf,
                Some("hsc") | Some("hs") => EqBandKind::HighShelf,
                _ => return Err(bad(line)),
            };
            let value = |key: &str| -> Option<f64> {
                let i = tok.iter().position(|t| *t == key)?;
                tok.get(i + 1)?.parse().ok()
            };
            let freq_hz = value("fc").ok_or_else(|| bad(line))?;
            let gain_db = value("gain").ok_or_else(|| bad(line))?;
            let q = match value("q") {
                Some(q) => q,
                None if kind != EqBandKind::Peak => std::f64::consts::FRAC_1_SQRT_2,
                None => return Err(bad(line)),
            };
            bands.push(EqBand {
                kind,
                freq_hz,
                gain_db,
                q,
            });
        }
    }
    if preamp.is_none() && !seen_filter {
        return Err(Error::InvalidEq("no Preamp or Filter lines found".into()));
    }
    Ok(AutoEqProfile {
        preamp_db: preamp.unwrap_or(0.0),
        bands,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_util::*;

    const RATE: u32 = 48_000;

    /// Gain in dB of the EQ for a sine at `freq` (steady state, mono).
    fn gain_at(eq_bands: &[EqBand], preamp: f64, freq: f64) -> f64 {
        let mut eq = Equalizer::new(RATE, 1, preamp, eq_bands);
        let mut x = sine(freq, RATE, 1, 48_000, 0.5);
        eq.process(&mut x);
        20.0 * (rms(&x[24_000..]) / (0.5 / 2f64.sqrt())).log10()
    }

    fn band(kind: EqBandKind, freq_hz: f64, gain_db: f64, q: f64) -> EqBand {
        EqBand {
            kind,
            freq_hz,
            gain_db,
            q,
        }
    }

    #[test]
    fn peak_hits_gain_at_centre_and_is_flat_far_away() {
        for g in [-9.0, -3.5, 6.0] {
            let b = [band(EqBandKind::Peak, 1000.0, g, 2.0)];
            assert!((gain_at(&b, 0.0, 1000.0) - g).abs() < 0.1, "gain {g}");
            assert!(gain_at(&b, 0.0, 40.0).abs() < 0.1);
            assert!(gain_at(&b, 0.0, 16_000.0).abs() < 0.1);
        }
    }

    #[test]
    fn shelves_reach_gain_at_extremes() {
        let ls = [band(EqBandKind::LowShelf, 200.0, 6.0, 0.707)];
        assert!((gain_at(&ls, 0.0, 20.0) - 6.0).abs() < 0.1);
        assert!(gain_at(&ls, 0.0, 10_000.0).abs() < 0.1);
        let hs = [band(EqBandKind::HighShelf, 4000.0, -5.0, 0.707)];
        assert!((gain_at(&hs, 0.0, 18_000.0) + 5.0).abs() < 0.1);
        assert!(gain_at(&hs, 0.0, 100.0).abs() < 0.1);
    }

    #[test]
    fn preamp_applies_and_channels_are_independent() {
        assert!((gain_at(&[], -6.0, 1000.0) + 6.0).abs() < 1e-6);
        let mut eq = Equalizer::new(RATE, 2, 0.0, &[band(EqBandKind::Peak, 500.0, 6.0, 1.0)]);
        let mut x: Vec<f64> = sine(500.0, RATE, 1, 4800, 0.5)
            .into_iter()
            .flat_map(|s| [s, 0.0])
            .collect();
        eq.process(&mut x);
        assert!(channel(&x, 2, 1).iter().all(|s| *s == 0.0));
        assert!(rms(&channel(&x, 2, 0)) > 0.3);
    }

    const AUTOEQ: &str = "Preamp: -6.2 dB\n\
Filter 1: ON LSC Fc 105 Hz Gain 5.5 dB Q 0.70\n\
Filter 2: ON PK Fc 105 Hz Gain -3.5 dB Q 0.70\n\
Filter 3: OFF PK Fc 2500 Hz Gain 2.0 dB Q 1.00\n\
Filter 4: ON PK Fc 5800 Hz Gain -2.1 dB Q 3.20\n\
Filter 5: ON HSC Fc 10000 Hz Gain -4.0 dB Q 0.70\n";

    #[test]
    fn parses_autoeq_profile() {
        let p = parse_autoeq(AUTOEQ).unwrap();
        assert_eq!(p.preamp_db, -6.2);
        assert_eq!(p.bands.len(), 4);
        assert_eq!(p.bands[0], band(EqBandKind::LowShelf, 105.0, 5.5, 0.70));
        assert_eq!(p.bands[1], band(EqBandKind::Peak, 105.0, -3.5, 0.70));
        assert_eq!(p.bands[2], band(EqBandKind::Peak, 5800.0, -2.1, 3.2));
        assert_eq!(p.bands[3], band(EqBandKind::HighShelf, 10000.0, -4.0, 0.70));
        assert!(parse_autoeq("hello").is_err());
        assert!(parse_autoeq("Filter 1: ON PK Fc 100 Hz").is_err());
    }
}
