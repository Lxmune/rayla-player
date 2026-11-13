//! Linux output: ALSA. Exclusive mode opens the card's `hw:` device directly
//! (no mixer, no conversion: bit-perfect, one client at a time) at the
//! track's exact rate; shared mode, and the fallback when the card is busy or
//! refuses the format, goes through `default` (PipeWire / PulseAudio / dmix),
//! which converts as needed.
//!
//! Streams are opened non-blocking so a busy card fails at once instead of
//! hanging the engine thread; writes wait on the device's poll descriptors.

use super::{quantize, Backend, Output, OutputInfo};
use crate::api::engine::OutputDevice;
use crate::decode::Format;
use alsa::pcm::{Access, Format as PcmFormat, HwParams, State, PCM};
use alsa::{Ctl, Direction, ValueOr};
use anyhow::{anyhow, bail, Context, Result};
use std::time::{Duration, Instant};

pub struct AlsaBackend;

const DEFAULT_ID: &str = "default";
const PROBE_RATES: [u32; 8] = [44100, 48000, 88200, 96000, 176400, 192000, 352800, 384000];
/// Device buffer. Short enough that a pause/seek fade is heard promptly,
/// long enough to ride out scheduling hiccups on a desktop.
const BUFFER_US: u32 = 150_000;
const PERIOD_US: u32 = 30_000;
const WAIT_MS: u32 = 3000;

/// How samples are laid out in the device buffer.
#[derive(Clone, Copy, Debug, PartialEq)]
enum Encoding {
    S16,
    /// 24 bits packed in 3 bytes.
    S24Packed,
    /// 24 bits right-justified in a 32-bit word (ALSA `S24_LE`).
    S24In32,
    S32,
}

impl Encoding {
    fn pcm_format(self) -> PcmFormat {
        match self {
            Encoding::S16 => PcmFormat::S16LE,
            Encoding::S24Packed => PcmFormat::S243LE,
            Encoding::S24In32 => PcmFormat::S24LE,
            Encoding::S32 => PcmFormat::S32LE,
        }
    }
    fn bits(self) -> u32 {
        match self {
            Encoding::S16 => 16,
            Encoding::S24Packed | Encoding::S24In32 => 24,
            Encoding::S32 => 32,
        }
    }
    fn bytes(self) -> usize {
        match self {
            Encoding::S16 => 2,
            Encoding::S24Packed => 3,
            Encoding::S24In32 | Encoding::S32 => 4,
        }
    }
}

/// Encodings to try for a wanted depth, best match first.
fn candidates(bits: u32) -> [Encoding; 4] {
    use Encoding::*;
    match bits {
        0..=16 => [S16, S24Packed, S24In32, S32],
        17..=24 => [S24Packed, S24In32, S32, S16],
        _ => [S32, S24In32, S24Packed, S16],
    }
}

/// Append left-justified `samples` to `out` in `enc`, rounding to `enc`'s depth.
fn encode(enc: Encoding, samples: &[i32], out: &mut Vec<u8>) {
    out.reserve(samples.len() * enc.bytes());
    for &s in samples {
        let q = quantize(s, enc.bits());
        match enc {
            Encoding::S16 => out.extend_from_slice(&((q >> 16) as i16).to_le_bytes()),
            Encoding::S24Packed => out.extend_from_slice(&(q >> 8).to_le_bytes()[..3]),
            Encoding::S24In32 => out.extend_from_slice(&(q >> 8).to_le_bytes()),
            Encoding::S32 => out.extend_from_slice(&q.to_le_bytes()),
        }
    }
}

/// A playback device on one card: `hw:CARD=<id>,DEV=<n>` plus a display name.
struct HwDevice {
    id: String,
    name: String,
}

fn hw_devices() -> Vec<HwDevice> {
    let mut out = Vec::new();
    for card in alsa::card::Iter::new().flatten() {
        let Ok(ctl) = Ctl::from_card(&card, false) else {
            continue;
        };
        let Ok(info) = ctl.card_info() else { continue };
        let (Ok(card_id), card_name) = (info.get_id(), info.get_name().unwrap_or("Sound card"))
        else {
            continue;
        };
        for dev in alsa::ctl::DeviceIter::new(&ctl) {
            let Ok(pcm) = ctl.pcm_info(dev as u32, 0, Direction::Playback) else {
                continue; // capture-only device
            };
            let pcm_name = pcm.get_name().unwrap_or("");
            let name = if pcm_name.is_empty() || pcm_name == card_name {
                card_name.to_string()
            } else {
                format!("{card_name}: {pcm_name}")
            };
            out.push(HwDevice {
                id: format!("hw:CARD={card_id},DEV={dev}"),
                name,
            });
        }
    }
    out
}

/// Rates and the deepest encoding the device takes. `None` when it can't be
/// opened right now (typically held by the sound server).
fn probe(id: &str) -> Option<(Vec<u32>, u32)> {
    let pcm = PCM::new(id, Direction::Playback, true).ok()?;
    let hwp = HwParams::any(&pcm).ok()?;
    let _ = hwp.set_rate_resample(false);
    let rates = PROBE_RATES
        .into_iter()
        .filter(|&r| hwp.test_rate(r).is_ok())
        .collect();
    let bits = [
        Encoding::S32,
        Encoding::S24In32,
        Encoding::S24Packed,
        Encoding::S16,
    ]
    .into_iter()
    .find(|e| hwp.test_format(e.pcm_format()).is_ok())
    .map_or(0, Encoding::bits);
    Some((rates, bits))
}

impl Backend for AlsaBackend {
    fn list_devices(&self) -> Result<Vec<OutputDevice>> {
        let mut out = vec![OutputDevice {
            id: DEFAULT_ID.into(),
            name: "System default".into(),
            is_default: true,
            supports_exclusive: false,
            sample_rates: Vec::new(),
            max_bit_depth: 0,
        }];
        for d in hw_devices() {
            // A busy card is still exclusive-capable once the sound server lets go.
            let (rates, bits) = probe(&d.id).unwrap_or_default();
            out.push(OutputDevice {
                id: d.id,
                name: d.name,
                is_default: false,
                supports_exclusive: true,
                sample_rates: rates,
                max_bit_depth: bits,
            });
        }
        Ok(out)
    }

    fn open(
        &self,
        device_id: Option<&str>,
        exclusive: bool,
        want: Format,
    ) -> Result<Box<dyn Output>> {
        let id = device_id.unwrap_or(DEFAULT_ID);
        if exclusive && id.starts_with("hw:") {
            // Busy or format refused: fall through to shared.
            if let Ok(o) = open_exclusive(id, want) {
                return Ok(Box::new(o));
            }
        }
        Ok(Box::new(open_shared(want)?))
    }
}

fn device_name(id: &str) -> String {
    hw_devices()
        .into_iter()
        .find(|d| d.id == id)
        .map_or_else(|| id.to_string(), |d| d.name)
}

fn open_exclusive(id: &str, want: Format) -> Result<AlsaOutput> {
    let mut last = anyhow!("no supported format");
    for enc in candidates(want.bits) {
        let pcm =
            PCM::new(id, Direction::Playback, true).with_context(|| format!("cannot open {id}"))?;
        match configure(&pcm, want, enc, false) {
            Ok(()) => {
                return AlsaOutput::new(
                    pcm,
                    device_name(id),
                    true,
                    enc,
                    Format {
                        rate: want.rate,
                        channels: want.channels,
                        bits: enc.bits(),
                    },
                )
            }
            Err(e) => last = e,
        }
    }
    Err(last)
}

fn open_shared(want: Format) -> Result<AlsaOutput> {
    let pcm = PCM::new(DEFAULT_ID, Direction::Playback, true)
        .context("cannot open the default ALSA device")?;
    configure(&pcm, want, Encoding::S32, true)?;
    AlsaOutput::new(
        pcm,
        "System default".into(),
        false,
        Encoding::S32,
        Format {
            rate: want.rate,
            channels: want.channels,
            bits: 32,
        },
    )
}

/// Set exactly `want`'s rate and channels in `enc`; `resample` lets the ALSA
/// plug layer convert (shared mode only).
fn configure(pcm: &PCM, want: Format, enc: Encoding, resample: bool) -> Result<()> {
    {
        let hwp = HwParams::any(pcm)?;
        hwp.set_access(Access::RWInterleaved)?;
        hwp.set_rate_resample(resample)?;
        hwp.set_format(enc.pcm_format())?;
        hwp.set_channels(want.channels)?;
        hwp.set_rate(want.rate, ValueOr::Nearest)?;
        hwp.set_buffer_time_near(BUFFER_US, ValueOr::Nearest)?;
        hwp.set_period_time_near(PERIOD_US, ValueOr::Nearest)?;
        pcm.hw_params(&hwp)?;
    }
    let hwp = pcm.hw_params_current()?;
    if hwp.get_rate()? != want.rate || hwp.get_channels()? != want.channels {
        bail!("device changed the requested format");
    }
    let buffer = hwp.get_buffer_size()?;
    let period = hwp.get_period_size()?;
    let swp = pcm.sw_params_current()?;
    // Start once the buffer is half full; wake the writer every period.
    swp.set_start_threshold(buffer / 2)?;
    swp.set_avail_min(period)?;
    pcm.sw_params(&swp)?;
    Ok(())
}

struct AlsaOutput {
    info: OutputInfo,
    pcm: PCM,
    enc: Encoding,
    /// Bytes per frame.
    bpf: usize,
    can_pause: bool,
    paused: bool,
    staging: Vec<u8>,
}

impl AlsaOutput {
    fn new(pcm: PCM, name: String, exclusive: bool, enc: Encoding, format: Format) -> Result<Self> {
        let can_pause = pcm.hw_params_current()?.can_pause();
        Ok(AlsaOutput {
            info: OutputInfo {
                device_name: name,
                exclusive,
                format,
            },
            pcm,
            enc,
            bpf: enc.bytes() * format.channels as usize,
            can_pause,
            paused: false,
            staging: Vec::new(),
        })
    }

    /// Write all staged frames, waiting for room as needed.
    fn flush(&mut self) -> Result<()> {
        let mut off = 0;
        while off < self.staging.len() {
            match self.pcm.io_bytes().writei(&self.staging[off..]) {
                Ok(frames) => off += frames * self.bpf,
                Err(e) if e.errno() == EAGAIN => {
                    if !self.pcm.wait(Some(WAIT_MS))? {
                        bail!("audio device stopped responding");
                    }
                }
                // Underrun (EPIPE) or suspend (ESTRPIPE): recover and retry.
                Err(e) => self
                    .pcm
                    .try_recover(e, true)
                    .context("audio device error")?,
            }
        }
        self.staging.clear();
        Ok(())
    }
}

/// `EAGAIN` (same value on every Linux architecture).
const EAGAIN: i32 = 11;

impl Output for AlsaOutput {
    fn info(&self) -> &OutputInfo {
        &self.info
    }

    fn write(&mut self, samples: &[i32]) -> Result<()> {
        encode(self.enc, samples, &mut self.staging);
        self.flush()
    }

    fn set_running(&mut self, running: bool) -> Result<()> {
        if running == !self.paused {
            return Ok(());
        }
        if self.can_pause {
            // Pausing a stream that never started is a no-op for us.
            if matches!(self.pcm.state(), State::Running | State::Paused) {
                self.pcm.pause(!running)?;
            }
        } else if running {
            self.pcm.prepare()?;
        } else {
            self.pcm.drop()?;
        }
        self.paused = !running;
        Ok(())
    }

    fn drain(&mut self) -> Result<()> {
        self.flush()?;
        if self.pcm.state() == State::Prepared {
            // Less than the start threshold was written: start it by hand.
            let _ = self.pcm.start();
        }
        // Non-blocking stream: snd_pcm_drain would return EAGAIN, so poll.
        let deadline = Instant::now() + Duration::from_secs(5);
        while self.pcm.state() == State::Running && Instant::now() < deadline {
            match self.pcm.delay() {
                Ok(d) if d > 0 => std::thread::sleep(Duration::from_millis(10)),
                _ => break,
            }
        }
        // Ready for the next write.
        self.pcm.drop()?;
        self.pcm.prepare()?;
        Ok(())
    }
}

impl Drop for AlsaOutput {
    fn drop(&mut self) {
        let _ = self.pcm.drop();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_each_layout_little_endian() {
        let s = [0x1234_5678i32];
        let mut out = Vec::new();
        encode(Encoding::S16, &s, &mut out);
        assert_eq!(out, 0x1234i16.to_le_bytes());
        out.clear();
        encode(Encoding::S24Packed, &s, &mut out);
        assert_eq!(out, [0x56, 0x34, 0x12]); // low byte 0x78 < 0x80 rounds down
        out.clear();
        encode(Encoding::S24In32, &s, &mut out);
        assert_eq!(out, [0x56, 0x34, 0x12, 0x00]);
        out.clear();
        encode(Encoding::S32, &s, &mut out);
        assert_eq!(out, 0x1234_5678i32.to_le_bytes());
    }

    #[test]
    fn negative_24_in_32_is_sign_extended() {
        let mut out = Vec::new();
        encode(Encoding::S24In32, &[i32::MIN], &mut out);
        assert_eq!(i32::from_le_bytes(out.try_into().unwrap()), -0x80_0000);
    }

    #[test]
    fn candidates_prefer_the_source_depth() {
        assert_eq!(candidates(16)[0], Encoding::S16);
        assert_eq!(candidates(24)[0], Encoding::S24Packed);
        assert_eq!(candidates(32)[0], Encoding::S32);
    }
}
