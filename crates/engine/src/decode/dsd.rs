//! DSD (DSF and uncompressed DSDIFF) support: container parsing, DoP packing
//! and DSD to PCM decimation.
//!
//! Both containers are normalised to one internal convention: per channel, a
//! stream of bytes whose most significant bit is the *oldest* 1-bit sample
//! (DSF stores LSB-first and is bit-reversed on read; DFF is already MSB-first).
//!
//! Output modes (chosen when the track is opened, see [`DsdPlan`]):
//! * DoP: 16 DSD bits per channel per 24-bit PCM frame, carrier rate = DSD
//!   rate / 16 (DSD64 = 176.4 kHz). Frames are left-justified in the `i32`
//!   (`pcm24 << 8`) and are never touched afterwards. The marker byte
//!   alternates 0x05 / 0xFA starting with 0x05 at the first frame of the
//!   track (and after every seek). Tracks always contain an even number of
//!   frames (the tail is padded with the DSD idle pattern 0x69) so that
//!   consecutive tracks keep the marker alternation unbroken (gapless).
//! * PCM: a linear-phase Kaiser FIR (120 dB stop band, -6 dB at 100 kHz,
//!   transition width about 86 kHz, 256 taps per 2.8224 MHz of input rate)
//!   decimates by 8 per DSD64 multiple, so DSD64/128/256/512 all come out at
//!   352.8 kHz (the 48 kHz family comes out at 384 kHz). It is evaluated with
//!   one 256-entry lookup table per input byte. 1 maps to +1 and 0 to -1 and
//!   the filter has unity DC gain, so a 50 % modulated sine (the SACD 0 dB
//!   reference) is -6 dBFS and 100 % modulation reaches 0 dBFS.

use super::{ReplayGain, TrackInfo};
use anyhow::{bail, Result};
use std::io::{Read, Seek, SeekFrom};
use symphonia::core::io::MediaSource;

/// DSD64 sampling rate (44.1 kHz x 64).
pub const DSD64_RATE: u32 = 2_822_400;
/// DSD "silence": a balanced 01101001 pattern.
pub const IDLE: u8 = 0x69;
pub const DOP_MARKERS: [u8; 2] = [0x05, 0xFA];
/// Bytes per channel read from the container per call.
const READ_BYTES: usize = 4096;

/// How the engine wants a DSD track delivered.
#[derive(Clone, Debug, Default)]
pub struct DsdPlan {
    /// The engine would accept DoP (exclusive output, DSP fully bypassed, DoP requested).
    pub allow_dop: bool,
    /// Sample rates the output device supports.
    pub device_rates: Vec<u32>,
}

impl DsdPlan {
    #[cfg(test)]
    pub fn pcm() -> Self {
        DsdPlan::default()
    }
    /// DoP is used when allowed and the device takes the carrier rate.
    pub fn use_dop(&self, dsd_rate: u32) -> bool {
        self.allow_dop && self.device_rates.contains(&(dsd_rate / 16))
    }
}

/// What a decoded DSD track reports besides the generic `TrackInfo`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DsdTrack {
    /// 1-bit sampling rate in Hz.
    pub rate: u32,
    /// Delivered as DoP (otherwise converted to PCM).
    pub dop: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Layout {
    Dsf { block: u32, lsb_first: bool },
    Dff,
}

#[derive(Clone, Debug)]
pub struct DsdFile {
    pub channels: u32,
    pub rate: u32,
    /// Samples (bits) per channel.
    pub samples: u64,
    pub replay_gain: ReplayGain,
    layout: Layout,
    data_start: u64,
    bytes_per_ch: u64,
}

impl DsdFile {
    #[cfg(test)]
    pub fn is_dsf(&self) -> bool {
        matches!(self.layout, Layout::Dsf { .. })
    }
}

pub fn name_for(rate: u32) -> String {
    if rate % 44100 == 0 {
        format!("DSD{}", rate / 44100)
    } else {
        "DSD".to_string()
    }
}

fn read_full<R: Read + ?Sized>(r: &mut R, buf: &mut [u8]) -> Result<usize> {
    let mut n = 0;
    while n < buf.len() {
        match r.read(&mut buf[n..]) {
            Ok(0) => break,
            Ok(k) => n += k,
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
            Err(e) => return Err(e.into()),
        }
    }
    Ok(n)
}

fn le32(b: &[u8]) -> u32 {
    u32::from_le_bytes(b[..4].try_into().unwrap())
}
fn le64(b: &[u8]) -> u64 {
    u64::from_le_bytes(b[..8].try_into().unwrap())
}
fn be32(b: &[u8]) -> u32 {
    u32::from_be_bytes(b[..4].try_into().unwrap())
}
fn be64(b: &[u8]) -> u64 {
    u64::from_be_bytes(b[..8].try_into().unwrap())
}

/// True if `magic` (the first four bytes of a file) starts a DSF or DFF.
pub fn is_dsd_magic(magic: &[u8]) -> bool {
    magic.starts_with(b"DSD ") || magic.starts_with(b"FRM8")
}

/// Parse the container header at the start of `r`.
pub fn parse<R: Read + Seek + ?Sized>(r: &mut R) -> Result<DsdFile> {
    r.seek(SeekFrom::Start(0))?;
    let mut magic = [0u8; 4];
    if read_full(r, &mut magic)? < 4 {
        bail!("file too short for DSD");
    }
    match &magic {
        b"DSD " => parse_dsf(r),
        b"FRM8" => parse_dff(r),
        _ => bail!("not a DSD file"),
    }
}

fn check_params(channels: u32, rate: u32) -> Result<()> {
    if channels == 0 || channels > 8 {
        bail!("unsupported DSD channel count {channels}");
    }
    if rate < 1_000_000 || rate > 50_000_000 {
        bail!("implausible DSD sampling rate {rate} Hz");
    }
    Ok(())
}

fn parse_dsf<R: Read + Seek + ?Sized>(r: &mut R) -> Result<DsdFile> {
    r.seek(SeekFrom::Start(0))?;
    let mut h = [0u8; 28];
    if read_full(r, &mut h)? < 28 {
        bail!("truncated DSF header");
    }
    let meta_ptr = le64(&h[20..]);
    let mut f = [0u8; 52];
    if read_full(r, &mut f)? < 52 || &f[..4] != b"fmt " {
        bail!("DSF: missing fmt chunk");
    }
    let fmt_size = le64(&f[4..]);
    if fmt_size < 52 {
        bail!("DSF: bad fmt chunk");
    }
    if le32(&f[16..]) != 0 {
        bail!("DSF: compressed or unknown DSD format id {}", le32(&f[16..]));
    }
    let channels = le32(&f[24..]);
    let rate = le32(&f[28..]);
    let bps = le32(&f[32..]);
    let samples = le64(&f[36..]);
    let block = le32(&f[44..]);
    check_params(channels, rate)?;
    if block == 0 || block > (1 << 24) {
        bail!("DSF: bad block size {block}");
    }
    let lsb_first = match bps {
        1 => true,
        8 => false,
        n => bail!("DSF: unsupported bits per sample {n}"),
    };
    // Locate the data chunk (normally right after fmt).
    let mut pos = 28 + fmt_size;
    let data_start = loop {
        r.seek(SeekFrom::Start(pos))?;
        let mut c = [0u8; 12];
        if read_full(r, &mut c)? < 12 {
            bail!("DSF: missing data chunk");
        }
        let size = le64(&c[4..]);
        if &c[..4] == b"data" {
            break pos + 12;
        }
        if size < 12 {
            bail!("DSF: corrupt chunk");
        }
        pos += size;
    };
    let mut file = DsdFile {
        channels,
        rate,
        samples,
        replay_gain: ReplayGain::default(),
        layout: Layout::Dsf { block, lsb_first },
        data_start,
        bytes_per_ch: samples.div_ceil(8),
    };
    if meta_ptr > 0 {
        if let Ok(g) = read_id3_gain(r, meta_ptr) {
            file.replay_gain = g;
        }
    }
    Ok(file)
}

fn parse_dff<R: Read + Seek + ?Sized>(r: &mut R) -> Result<DsdFile> {
    r.seek(SeekFrom::Start(12))?;
    let mut form = [0u8; 4];
    read_full(r, &mut form)?;
    if &form != b"DSD " {
        bail!("DSDIFF: form type is not DSD");
    }
    let (mut rate, mut channels) = (0u32, 0u32);
    let mut pos = 16u64;
    loop {
        r.seek(SeekFrom::Start(pos))?;
        let mut c = [0u8; 12];
        if read_full(r, &mut c)? < 12 {
            bail!("DSDIFF: missing DSD sound data chunk");
        }
        let size = be64(&c[4..]);
        let body = pos + 12;
        match &c[..4] {
            b"PROP" => {
                let mut p = vec![0u8; size.min(1 << 20) as usize];
                read_full(r, &mut p)?;
                if p.len() >= 4 && &p[..4] == b"SND " {
                    let mut i = 4;
                    while i + 12 <= p.len() {
                        let sz = be64(&p[i + 4..]) as usize;
                        let b = &p[i + 12..(i + 12 + sz).min(p.len())];
                        match &p[i..i + 4] {
                            b"FS  " if b.len() >= 4 => rate = be32(b),
                            b"CHNL" if b.len() >= 2 => {
                                channels = u16::from_be_bytes([b[0], b[1]]) as u32
                            }
                            b"CMPR" if b.len() >= 4 && &b[..4] != b"DSD " => {
                                if &b[..4] == b"DST " {
                                    bail!("DST-compressed DSDIFF is not supported");
                                }
                                bail!("unsupported DSDIFF compression {:?}", &b[..4]);
                            }
                            _ => {}
                        }
                        i += 12 + sz + (sz & 1);
                    }
                }
            }
            b"DST " => bail!("DST-compressed DSDIFF is not supported"),
            b"DSD " => {
                check_params(channels, rate)?;
                let bytes_per_ch = size / channels as u64;
                return Ok(DsdFile {
                    channels,
                    rate,
                    samples: bytes_per_ch * 8,
                    replay_gain: ReplayGain::default(),
                    layout: Layout::Dff,
                    data_start: body,
                    bytes_per_ch,
                });
            }
            _ => {}
        }
        pos = body + size + (size & 1);
    }
}

// ---- ID3v2 (DSF) ReplayGain ---------------------------------------------------

fn syncsafe(b: &[u8]) -> usize {
    ((b[0] as usize & 0x7f) << 21)
        | ((b[1] as usize & 0x7f) << 14)
        | ((b[2] as usize & 0x7f) << 7)
        | (b[3] as usize & 0x7f)
}

fn decode_text(enc: u8, b: &[u8]) -> String {
    match enc {
        1 | 2 => {
            let (mut be, mut b) = (enc == 2, b);
            if b.len() >= 2 && b[..2] == [0xFF, 0xFE] {
                be = false;
                b = &b[2..];
            } else if b.len() >= 2 && b[..2] == [0xFE, 0xFF] {
                be = true;
                b = &b[2..];
            }
            let u: Vec<u16> = b
                .chunks_exact(2)
                .map(|c| if be { u16::from_be_bytes([c[0], c[1]]) } else { u16::from_le_bytes([c[0], c[1]]) })
                .collect();
            String::from_utf16_lossy(&u)
        }
        3 => String::from_utf8_lossy(b).into_owned(),
        _ => b.iter().map(|&c| c as char).collect(),
    }
}

/// Read ReplayGain TXXX frames from the ID3v2 tag at `offset`.
fn read_id3_gain<R: Read + Seek + ?Sized>(r: &mut R, offset: u64) -> Result<ReplayGain> {
    r.seek(SeekFrom::Start(offset))?;
    let mut h = [0u8; 10];
    if read_full(r, &mut h)? < 10 || &h[..3] != b"ID3" {
        bail!("no ID3 tag");
    }
    let (ver, flags) = (h[3], h[5]);
    let size = syncsafe(&h[6..]).min(4 << 20);
    let mut t = vec![0u8; size];
    let n = read_full(r, &mut t)?;
    t.truncate(n);
    let mut i = 0;
    if flags & 0x40 != 0 && t.len() >= 4 {
        i = if ver >= 4 { syncsafe(&t) } else { be32(&t) as usize + 4 };
    }
    let mut g = ReplayGain::default();
    while i + 10 <= t.len() && t[i] != 0 {
        let sz = if ver >= 4 { syncsafe(&t[i + 4..]) } else { be32(&t[i + 4..]) as usize };
        let body = &t[(i + 10).min(t.len())..(i + 10 + sz).min(t.len())];
        if &t[i..i + 4] == b"TXXX" && !body.is_empty() {
            let enc = body[0];
            let rest = &body[1..];
            // Description ends at the first terminator (1 or 2 bytes by encoding).
            let wide = matches!(enc, 1 | 2);
            let split = if wide {
                rest.chunks_exact(2).position(|c| c == [0, 0]).map(|p| (p * 2, 2))
            } else {
                rest.iter().position(|&c| c == 0).map(|p| (p, 1))
            };
            if let Some((p, w)) = split {
                let key = decode_text(enc, &rest[..p]).to_ascii_lowercase();
                let val = decode_text(enc, &rest[(p + w).min(rest.len())..]);
                let num = val
                    .trim_matches(|c: char| c == '\0' || c.is_whitespace())
                    .trim_end_matches(|c: char| c.is_ascii_alphabetic() || c.is_whitespace())
                    .parse::<f64>()
                    .ok();
                match key.as_str() {
                    "replaygain_track_gain" => g.track_gain_db = num.or(g.track_gain_db),
                    "replaygain_track_peak" => g.track_peak = num.or(g.track_peak),
                    "replaygain_album_gain" => g.album_gain_db = num.or(g.album_gain_db),
                    "replaygain_album_peak" => g.album_peak = num.or(g.album_peak),
                    _ => {}
                }
            }
        }
        i += 10 + sz;
    }
    Ok(g)
}

// ---- reading ------------------------------------------------------------------

struct DsdSource {
    r: Box<dyn MediaSource>,
    f: DsdFile,
    /// Next byte (per channel) to read.
    pos: u64,
    cache: Option<(u64, Vec<u8>)>,
}

impl DsdSource {
    /// Append up to `want` bytes per channel (MSB = oldest sample) to `out`;
    /// returns the number appended per channel, 0 at the end.
    fn read(&mut self, want: usize, out: &mut [Vec<u8>]) -> Result<usize> {
        let remain = self.f.bytes_per_ch.saturating_sub(self.pos);
        if remain == 0 || want == 0 {
            return Ok(0);
        }
        let ch = self.f.channels as usize;
        let n;
        match self.f.layout {
            Layout::Dsf { block, lsb_first } => {
                let b = block as u64;
                let set = self.pos / b;
                let off = (self.pos % b) as usize;
                if self.cache.as_ref().map(|c| c.0) != Some(set) {
                    let mut buf = vec![0u8; block as usize * ch];
                    self.r
                        .seek(SeekFrom::Start(self.f.data_start + set * b * ch as u64))?;
                    let got = read_full(&mut self.r, &mut buf)?;
                    buf.truncate(got);
                    self.cache = Some((set, buf));
                }
                let buf = &self.cache.as_ref().unwrap().1;
                let mut k = want.min(block as usize - off).min(remain as usize);
                for c in 0..ch {
                    k = k.min(buf.len().saturating_sub(c * block as usize + off));
                }
                for (c, o) in out.iter_mut().enumerate().take(ch) {
                    let s = c * block as usize + off;
                    let src = &buf[s..s + k];
                    if lsb_first {
                        o.extend(src.iter().map(|x| x.reverse_bits()));
                    } else {
                        o.extend_from_slice(src);
                    }
                }
                n = k;
            }
            Layout::Dff => {
                let k = want.min(remain as usize);
                let mut buf = vec![0u8; k * ch];
                self.r
                    .seek(SeekFrom::Start(self.f.data_start + self.pos * ch as u64))?;
                let got = read_full(&mut self.r, &mut buf)? / ch;
                for (c, o) in out.iter_mut().enumerate().take(ch) {
                    o.extend((0..got).map(|i| buf[i * ch + c]));
                }
                n = got;
            }
        }
        self.pos += n as u64;
        Ok(n)
    }
}

// ---- DoP ----------------------------------------------------------------------

/// One DoP frame sample: marker in the top byte, `hi` then `lo` DSD bytes
/// (`hi` holds the older 8 bits), left-justified in an `i32`.
#[inline]
pub fn dop_word(marker: u8, hi: u8, lo: u8) -> i32 {
    (((marker as u32) << 16 | (hi as u32) << 8 | lo as u32) << 8) as i32
}

#[derive(Default)]
pub struct DopPacker {
    /// Marker of the next frame is 0xFA (else 0x05).
    odd: bool,
}

impl DopPacker {
    /// Pack `n` byte pairs per channel from `bytes` (each channel holds at
    /// least `2n` bytes) into interleaved frames.
    pub fn pack(&mut self, bytes: &[Vec<u8>], n: usize, out: &mut Vec<i32>) {
        for i in 0..n {
            let m = DOP_MARKERS[self.odd as usize];
            self.odd = !self.odd;
            for ch in bytes {
                out.push(dop_word(m, ch[2 * i], ch[2 * i + 1]));
            }
        }
    }
}

// ---- DSD to PCM ---------------------------------------------------------------

fn bessel_i0(x: f64) -> f64 {
    let (mut sum, mut term, q) = (1.0, 1.0, x * x / 4.0);
    for k in 1..60 {
        term *= q / (k * k) as f64;
        sum += term;
        if term < sum * 1e-17 {
            break;
        }
    }
    sum
}

pub struct DsdToPcm {
    /// Window length in bytes.
    t: usize,
    /// Input bytes per output sample.
    d: usize,
    lut: Vec<f64>,
    win: Vec<Vec<u8>>,
    /// Bytes since the last output.
    phase: usize,
    /// Outputs still to drop (filter delay / seek pre-roll).
    discard: u64,
    pub out_rate: u32,
}

impl DsdToPcm {
    pub fn new(rate: u32, channels: usize) -> Self {
        let d = ((rate as f64 / DSD64_RATE as f64).round() as usize).max(1);
        let taps = 256 * d;
        let t = taps / 8;
        let beta = 12.27; // about 120 dB
        let fc = 100_000.0 / rate as f64;
        let c = (taps as f64 - 1.0) / 2.0;
        let i0b = bessel_i0(beta);
        let mut h: Vec<f64> = (0..taps)
            .map(|n| {
                let x = n as f64 - c;
                let sinc = if x == 0.0 {
                    2.0 * fc
                } else {
                    (2.0 * std::f64::consts::PI * fc * x).sin() / (std::f64::consts::PI * x)
                };
                let r = x / c;
                sinc * bessel_i0(beta * (1.0 - r * r).max(0.0).sqrt()) / i0b
            })
            .collect();
        let sum: f64 = h.iter().sum();
        h.iter_mut().for_each(|v| *v /= sum);
        // lut[k][b]: byte k of the window (0 = oldest), bit 7 = oldest bit.
        let mut lut = vec![0.0; t * 256];
        for k in 0..t {
            for b in 0..256usize {
                let mut acc = 0.0;
                for i in 0..8 {
                    let delay = (t - 1 - k) * 8 + (7 - i);
                    let bit = (b >> (7 - i)) & 1;
                    acc += if bit == 1 { h[delay] } else { -h[delay] };
                }
                lut[k * 256 + b] = acc;
            }
        }
        let mut s = DsdToPcm {
            t,
            d,
            lut,
            win: vec![Vec::new(); channels],
            phase: 0,
            discard: 0,
            out_rate: rate / (8 * d as u32),
        };
        s.reset(0);
        s
    }

    /// Idle bytes that flush the filter after the last real byte.
    pub fn tail_bytes(&self) -> usize {
        self.t / 2
    }
    fn delay_outputs(&self) -> u64 {
        (self.t / (2 * self.d)) as u64
    }

    /// Restart with idle history; `preroll_outputs` extra leading outputs are
    /// dropped in addition to the filter delay.
    pub fn reset(&mut self, preroll_outputs: u64) {
        for w in &mut self.win {
            w.clear();
            w.resize(self.t, IDLE);
        }
        self.phase = 0;
        self.discard = self.delay_outputs() + preroll_outputs;
    }

    /// Feed equally long per-channel byte slices; append interleaved i32 PCM.
    pub fn process(&mut self, bytes: &[Vec<u8>], out: &mut Vec<i32>) {
        let n = bytes.first().map_or(0, |b| b.len());
        let t = self.t;
        for i in 0..n {
            for (w, b) in self.win.iter_mut().zip(bytes) {
                w.push(b[i]);
            }
            self.phase += 1;
            if self.phase < self.d {
                continue;
            }
            self.phase = 0;
            if self.discard > 0 {
                self.discard -= 1;
                continue;
            }
            for w in &self.win {
                let win = &w[w.len() - t..];
                let y: f64 = win
                    .iter()
                    .enumerate()
                    .map(|(k, &b)| self.lut[k * 256 + b as usize])
                    .sum();
                out.push((y * 2147483648.0).round().clamp(-2147483648.0, 2147483647.0) as i32);
            }
        }
        for w in &mut self.win {
            if w.len() > t + 65536 {
                let cut = w.len() - t;
                w.drain(..cut);
            }
        }
    }
}

// ---- decoder ------------------------------------------------------------------

enum Mode {
    Dop { packer: DopPacker, carry: Vec<Vec<u8>> },
    Pcm(DsdToPcm),
}

pub struct DsdDecoder {
    src: DsdSource,
    info: TrackInfo,
    mode: Mode,
    finished: bool,
}

impl DsdDecoder {
    /// `src` is positioned anywhere; parsing seeks to the start itself.
    pub fn open(mut src: Box<dyn MediaSource>, plan: &DsdPlan) -> Result<DsdDecoder> {
        let f = parse(&mut src)?;
        let dop = plan.use_dop(f.rate);
        let ch = f.channels as usize;
        let duration_ms = f.samples * 1000 / f.rate as u64;
        let (mode, sample_rate, bits) = if dop {
            (
                Mode::Dop { packer: DopPacker::default(), carry: vec![Vec::new(); ch] },
                f.rate / 16,
                24,
            )
        } else {
            let p = DsdToPcm::new(f.rate, ch);
            let r = p.out_rate;
            (Mode::Pcm(p), r, 0)
        };
        let info = TrackInfo {
            codec: name_for(f.rate),
            sample_rate,
            bits,
            channels: f.channels,
            duration_ms,
            lossy: false,
            replay_gain: f.replay_gain,
            dsd: Some(DsdTrack { rate: f.rate, dop }),
        };
        Ok(DsdDecoder {
            src: DsdSource { r: src, f, pos: 0, cache: None },
            info,
            mode,
            finished: false,
        })
    }

    pub fn info(&self) -> &TrackInfo {
        &self.info
    }

    pub fn next(&mut self, out: &mut Vec<i32>) -> Result<bool> {
        let ch = self.src.f.channels as usize;
        loop {
            if self.finished {
                return Ok(false);
            }
            let mut buf: Vec<Vec<u8>> = vec![Vec::new(); ch];
            let before = out.len();
            match &mut self.mode {
                Mode::Dop { packer, carry } => {
                    let n = self.src.read(READ_BYTES, &mut buf)?;
                    for (c, b) in carry.iter_mut().zip(&buf) {
                        c.extend_from_slice(b);
                    }
                    if n == 0 {
                        // End: complete an odd byte, then an odd frame count.
                        self.finished = true;
                        if carry[0].len() % 2 == 1 {
                            carry.iter_mut().for_each(|c| c.push(IDLE));
                        }
                        let pairs = carry[0].len() / 2;
                        packer.pack(carry, pairs, out);
                        if packer.odd {
                            let idle = vec![vec![IDLE, IDLE]; ch];
                            packer.pack(&idle, 1, out);
                        }
                    } else {
                        let pairs = carry[0].len() / 2;
                        packer.pack(carry, pairs, out);
                        carry.iter_mut().for_each(|c| {
                            c.drain(..pairs * 2);
                        });
                    }
                }
                Mode::Pcm(p) => {
                    let n = self.src.read(READ_BYTES, &mut buf)?;
                    if n == 0 {
                        self.finished = true;
                        let done = self.src.pos as usize;
                        let pad = (p.d - done % p.d) % p.d + p.tail_bytes();
                        buf = vec![vec![IDLE; pad]; ch];
                    }
                    p.process(&buf, out);
                }
            }
            if out.len() > before {
                return Ok(true);
            }
        }
    }

    pub fn seek(&mut self, ms: u64) -> Result<()> {
        let total = self.src.f.bytes_per_ch;
        let want = (ms * self.src.f.rate as u64 / 1000 / 8).min(total);
        self.finished = false;
        match &mut self.mode {
            Mode::Dop { packer, carry } => {
                *packer = DopPacker::default();
                carry.iter_mut().for_each(Vec::clear);
                self.src.pos = want & !1;
            }
            Mode::Pcm(p) => {
                let d = p.d as u64;
                let target = want - want % d;
                let start = target.saturating_sub(p.t as u64);
                p.reset((target - start) / d);
                self.src.pos = start;
            }
        }
        Ok(())
    }
}

/// Used by `Decoder::open`: sniff the magic, rewinding the source.
pub fn sniff(src: &mut Box<dyn MediaSource>) -> bool {
    let mut m = [0u8; 4];
    let ok = src.seek(SeekFrom::Start(0)).is_ok() && read_full(src, &mut m).map_or(false, |n| n == 4);
    let _ = src.seek(SeekFrom::Start(0));
    ok && is_dsd_magic(&m)
}


#[cfg(test)]
pub(crate) mod fixtures;
#[cfg(test)]
mod tests;
