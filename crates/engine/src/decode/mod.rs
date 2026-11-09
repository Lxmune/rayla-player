//! Symphonia-backed decoder producing interleaved `i32` samples that are
//! left-justified in the 32-bit word (a 16-bit sample `s` becomes `s << 16`),
//! so integer sources round-trip exactly and any device depth is a shift away.

pub mod dsd;

pub use dsd::{DsdPlan, DsdTrack};

use anyhow::{anyhow, bail, Result};
use symphonia::core::audio::SampleBuffer;
use symphonia::core::codecs::{Decoder as SymDecoder, DecoderOptions};
use symphonia::core::errors::Error as SymError;
use symphonia::core::formats::{FormatOptions, FormatReader, SeekMode, SeekTo};
use symphonia::core::io::{MediaSource, MediaSourceStream};
use symphonia::core::meta::{MetadataOptions, MetadataRevision, StandardTagKey};
use symphonia::core::probe::Hint;
use symphonia::core::units::Time;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Format {
    pub rate: u32,
    pub channels: u32,
    pub bits: u32,
}

#[derive(Clone, Copy, Default, Debug, PartialEq)]
pub struct ReplayGain {
    pub track_gain_db: Option<f64>,
    pub track_peak: Option<f64>,
    pub album_gain_db: Option<f64>,
    pub album_peak: Option<f64>,
}

#[derive(Clone, Debug)]
pub struct TrackInfo {
    pub codec: String,
    pub sample_rate: u32,
    /// Source bit depth; 0 for lossy / floating-point sources.
    pub bits: u32,
    pub channels: u32,
    pub duration_ms: u64,
    pub lossy: bool,
    pub replay_gain: ReplayGain,
    /// Set for DSD sources; `sample_rate` / `bits` then describe what the
    /// decoder delivers (DoP carrier 24-bit, or the PCM conversion).
    pub dsd: Option<DsdTrack>,
}

impl TrackInfo {
    /// Depth requested from the output: lossy sources decode to 24-bit.
    pub fn format(&self) -> Format {
        Format {
            rate: self.sample_rate,
            channels: self.channels,
            bits: if self.bits == 0 { 24 } else { self.bits },
        }
    }
}

pub struct PcmDecoder {
    reader: Box<dyn FormatReader>,
    dec: Box<dyn SymDecoder>,
    track_id: u32,
    info: TrackInfo,
    buf: Option<SampleBuffer<i32>>,
    /// Frames still to discard after an inexact container seek.
    skip: u64,
    channels: usize,
}

impl PcmDecoder {
    fn open(src: Box<dyn MediaSource>, ext: Option<&str>) -> Result<Self> {
        let mss = MediaSourceStream::new(src, Default::default());
        let mut hint = Hint::new();
        if let Some(e) = ext {
            hint.with_extension(e);
        }
        let fopts = FormatOptions {
            enable_gapless: true,
            ..Default::default()
        };
        let mut probed = symphonia::default::get_probe()
            .format(&hint, mss, &fopts, &MetadataOptions::default())
            .map_err(|e| anyhow!("unrecognised audio format: {e}"))?;
        let mut gain = ReplayGain::default();
        if let Some(m) = probed.metadata.get() {
            if let Some(rev) = m.current() {
                read_gain(rev, &mut gain);
            }
        }
        let mut reader = probed.format;
        if let Some(rev) = reader.metadata().current() {
            read_gain(rev, &mut gain);
        }
        let track = reader
            .tracks()
            .iter()
            .find(|t| t.codec_params.codec != symphonia::core::codecs::CODEC_TYPE_NULL)
            .ok_or_else(|| anyhow!("no audio track"))?;
        let p = track.codec_params.clone();
        let track_id = track.id;
        let sample_rate = p
            .sample_rate
            .ok_or_else(|| anyhow!("unknown sample rate"))?;
        let channels = p
            .channels
            .map(|c| c.count() as u32)
            .ok_or_else(|| anyhow!("unknown channel layout"))?;
        let short = symphonia::default::get_codecs()
            .get_codec(p.codec)
            .map(|d| d.short_name)
            .unwrap_or("unknown");
        let codec = if short.starts_with("pcm") {
            "PCM".to_string()
        } else {
            short.to_ascii_uppercase()
        };
        let lossy = matches!(short, "mp3" | "mp1" | "mp2" | "aac" | "vorbis" | "opus");
        let float_src = short.starts_with("pcm_f");
        let bits = if lossy || float_src {
            0
        } else {
            p.bits_per_sample.or(p.bits_per_coded_sample).unwrap_or(16)
        };
        let duration_ms = match p.n_frames {
            Some(n) => n * 1000 / sample_rate as u64,
            None => 0,
        };
        let dec = symphonia::default::get_codecs()
            .make(&p, &DecoderOptions::default())
            .map_err(|e| anyhow!("no decoder: {e}"))?;
        Ok(PcmDecoder {
            reader,
            dec,
            track_id,
            info: TrackInfo {
                codec,
                sample_rate,
                bits,
                channels,
                duration_ms,
                lossy: lossy || float_src,
                replay_gain: gain,
                dsd: None,
            },
            buf: None,
            skip: 0,
            channels: channels as usize,
        })
    }

    fn info(&self) -> &TrackInfo {
        &self.info
    }

    /// Append the next packet's samples to `out`. `Ok(false)` means end of stream.
    fn next(&mut self, out: &mut Vec<i32>) -> Result<bool> {
        loop {
            let packet = match self.reader.next_packet() {
                Ok(p) => p,
                Err(SymError::IoError(e)) if e.kind() == std::io::ErrorKind::UnexpectedEof => {
                    return Ok(false)
                }
                Err(SymError::ResetRequired) => return Ok(false),
                Err(e) => bail!("read error: {e}"),
            };
            if packet.track_id() != self.track_id {
                continue;
            }
            let decoded = match self.dec.decode(&packet) {
                Ok(d) => d,
                Err(SymError::DecodeError(_)) => continue, // corrupt frame: drop it
                Err(SymError::IoError(e)) if e.kind() == std::io::ErrorKind::UnexpectedEof => {
                    return Ok(false)
                }
                Err(e) => bail!("decode error: {e}"),
            };
            let frames = decoded.frames();
            if frames == 0 {
                continue;
            }
            let buf = self.buf.get_or_insert_with(|| {
                SampleBuffer::new(decoded.capacity() as u64, *decoded.spec())
            });
            if buf.capacity() < frames * self.channels {
                *buf = SampleBuffer::new(decoded.capacity() as u64, *decoded.spec());
            }
            buf.copy_interleaved_ref(decoded);
            let mut samples = buf.samples();
            if self.skip > 0 {
                let drop = (self.skip as usize).min(frames);
                self.skip -= drop as u64;
                samples = &samples[drop * self.channels..];
                if samples.is_empty() {
                    continue;
                }
            }
            out.extend_from_slice(samples);
            return Ok(true);
        }
    }

    /// Seek to `ms`. Samples between the container's seek point and `ms`
    /// are discarded so the next output frame is exactly at `ms`.
    /// Seeking past the end is not an error; the next read is end of stream.
    fn seek(&mut self, ms: u64) -> Result<()> {
        let time = Time::new((ms / 1000) as u64, (ms % 1000) as f64 / 1000.0);
        let to = SeekTo::Time {
            time,
            track_id: Some(self.track_id),
        };
        match self.reader.seek(SeekMode::Accurate, to) {
            Ok(s) => {
                // Audio time bases tick once per frame.
                self.skip = s.required_ts.saturating_sub(s.actual_ts);
            }
            Err(SymError::SeekError(_)) => {
                self.skip = 0;
            }
            Err(e) => bail!("seek failed: {e}"),
        }
        self.dec.reset();
        Ok(())
    }
}

/// Format-sniffing front end: DSD files (detected by magic bytes, not by
/// extension) go to the DSD decoder, everything else to symphonia.
pub enum Decoder {
    Pcm(Box<PcmDecoder>),
    Dsd(Box<dsd::DsdDecoder>),
}

impl Decoder {
    pub fn open(
        mut src: Box<dyn MediaSource>,
        ext: Option<&str>,
        plan: &DsdPlan,
    ) -> Result<Self> {
        if dsd::sniff(&mut src) {
            return Ok(Decoder::Dsd(Box::new(dsd::DsdDecoder::open(src, plan)?)));
        }
        Ok(Decoder::Pcm(Box::new(PcmDecoder::open(src, ext)?)))
    }

    pub fn info(&self) -> &TrackInfo {
        match self {
            Decoder::Pcm(d) => d.info(),
            Decoder::Dsd(d) => d.info(),
        }
    }

    /// Append the next packet's samples to `out`. `Ok(false)` means end of stream.
    pub fn next(&mut self, out: &mut Vec<i32>) -> Result<bool> {
        match self {
            Decoder::Pcm(d) => d.next(out),
            Decoder::Dsd(d) => d.next(out),
        }
    }

    pub fn seek(&mut self, ms: u64) -> Result<()> {
        match self {
            Decoder::Pcm(d) => d.seek(ms),
            Decoder::Dsd(d) => d.seek(ms),
        }
    }
}

fn read_gain(rev: &MetadataRevision, g: &mut ReplayGain) {
    for tag in rev.tags() {
        let val = tag.value.to_string();
        let num = || {
            val.trim()
                .trim_end_matches(|c: char| c.is_ascii_alphabetic() || c.is_whitespace())
                .parse::<f64>()
                .ok()
        };
        match tag.std_key {
            Some(StandardTagKey::ReplayGainTrackGain) => {
                g.track_gain_db = num().or(g.track_gain_db)
            }
            Some(StandardTagKey::ReplayGainTrackPeak) => g.track_peak = num().or(g.track_peak),
            Some(StandardTagKey::ReplayGainAlbumGain) => {
                g.album_gain_db = num().or(g.album_gain_db)
            }
            Some(StandardTagKey::ReplayGainAlbumPeak) => g.album_peak = num().or(g.album_peak),
            _ => match tag.key.to_ascii_lowercase().as_str() {
                "replaygain_track_gain" => g.track_gain_db = num().or(g.track_gain_db),
                "replaygain_track_peak" => g.track_peak = num().or(g.track_peak),
                "replaygain_album_gain" => g.album_gain_db = num().or(g.album_gain_db),
                "replaygain_album_peak" => g.album_peak = num().or(g.album_peak),
                _ => {}
            },
        }
    }
}
