//! The engine thread: owns the output device, the current and next track,
//! and turns commands into audio and events. Everything blocking (network,
//! decode) lives on the pipeline threads; this thread only moves buffered
//! samples to the device.

use super::dsp::DspStream;
use super::pipeline::{Msg, Pipeline};
use crate::api::engine::*;
use crate::decode::{DsdPlan, Format, TrackInfo};
use crate::output::{Backend, Output};
use std::path::PathBuf;
use std::sync::mpsc::{Receiver, Sender, TryRecvError};
use std::sync::{mpsc, Arc};
use std::time::{Duration, Instant};

pub type EmitFn = Arc<dyn Fn(EngineEvent) + Send + Sync>;

/// Frames handed to the device per write; bounds command latency.
const WRITE_FRAMES: usize = 1024;
const FADE_MS: u64 = 20;
const POLL: Duration = Duration::from_millis(20);
const POSITION_EVERY: Duration = Duration::from_millis(200);
/// How long the engine waits for the next track while crossfading.
const XFADE_WAIT: Duration = Duration::from_secs(3);
/// Crossfade tail holding starts this long before the tail itself would, so
/// an inexact container duration cannot make it start late.
const HOLD_MARGIN_MS: u64 = 1000;

pub enum Cmd {
    Load(TrackRequest, bool),
    SetNext(Option<TrackRequest>),
    Play,
    Pause,
    Stop,
    Seek(u64),
    SetDsp(DspConfig),
    SetOutput(Option<String>, bool),
}

#[derive(Clone)]
pub struct Engine {
    tx: Sender<Cmd>,
}

impl Engine {
    pub fn start(cache_dir: PathBuf, backend: Arc<dyn Backend>, emit: EmitFn) -> Engine {
        let (tx, rx) = mpsc::channel();
        std::thread::Builder::new()
            .name("rayla-engine".into())
            .spawn(move || {
                Core {
                    rx,
                    cache_dir,
                    backend,
                    emit,
                    cur: None,
                    next: None,
                    out: None,
                    out_req: None,
                    dev_rates: None,
                    dop_veto: false,
                    out_running: false,
                    device: None,
                    exclusive: false,
                    dsp: neutral_dsp(),
                    state: PlaybackState::Stopped,
                    want_play: false,
                    fade_in: None,
                    path_dirty: false,
                    last_path: String::new(),
                    last_pos: Instant::now(),
                }
                .run()
            })
            .expect("spawn engine thread");
        Engine { tx }
    }

    pub fn send(&self, cmd: Cmd) -> anyhow::Result<()> {
        self.tx
            .send(cmd)
            .map_err(|_| anyhow::anyhow!("engine thread has exited"))
    }
}

/// Every stage off and unity volume: samples may reach the device untouched.
pub fn dsp_is_neutral(c: &DspConfig) -> bool {
    c.volume == 1.0
        && c.replay_gain == ReplayGainMode::Off
        && c.preamp_db == 0.0
        && !c.clip_guard
        && !c.eq_enabled
        && c.convolution_path.is_none()
        && c.crossfeed == CrossfeedLevel::Off
        && !c.compressor.enabled
        && c.resample_to.is_none()
        && c.dither == DitherMode::Off
        && c.crossfade_ms == 0
}

pub fn neutral_dsp() -> DspConfig {
    DspConfig {
        volume: 1.0,
        replay_gain: ReplayGainMode::Off,
        preamp_db: 0.0,
        clip_guard: false,
        eq_enabled: false,
        eq_preamp_db: 0.0,
        eq_bands: Vec::new(),
        convolution_path: None,
        crossfeed: CrossfeedLevel::Off,
        compressor: CompressorConfig::default(),
        resample_to: None,
        dither: DitherMode::Off,
        crossfade_ms: 0,
        dsd: DsdMode::Dop,
    }
}

struct Slot {
    req: Arc<TrackRequest>,
    pipe: Pipeline,
    info: Option<TrackInfo>,
    /// Per-track DSP state, built once the decoder reports the format.
    stream: Option<DspStream>,
    /// Format requested from the device for this track.
    fmt: Option<Format>,
    buf: Vec<i32>,
    off: usize,
    /// Source frames taken from the decoder.
    pos_frames: u64,
    eof: bool,
    pending_seek: Option<u64>,
    started: bool,
}

impl Slot {
    fn new(req: TrackRequest, cache_dir: &PathBuf, plan: DsdPlan) -> Slot {
        let req = Arc::new(req);
        Slot {
            pipe: Pipeline::spawn(req.clone(), cache_dir.clone(), plan),
            req,
            info: None,
            stream: None,
            fmt: None,
            buf: Vec::new(),
            off: 0,
            pos_frames: 0,
            eof: false,
            pending_seek: None,
            started: false,
        }
    }

    /// Source frames currently held back in the stream (not yet audible).
    fn held_src(&self) -> u64 {
        self.stream.as_ref().map_or(0, |s| s.pending_src_frames())
    }

    /// Refill `buf` if it is exhausted. `Ok(true)` means data is available,
    /// `Ok(false)` that nothing is available right now (or EOF was reached,
    /// see `eof`), `Err` carries a decode failure.
    fn refill(&mut self, wait: Duration) -> Result<bool, String> {
        if self.off < self.buf.len() {
            return Ok(true);
        }
        if self.eof {
            return Ok(false);
        }
        match self.pipe.pop(wait) {
            Some(Msg::Chunk(c)) => {
                self.buf = c;
                self.off = 0;
                Ok(!self.buf.is_empty())
            }
            Some(Msg::Eof) => {
                self.eof = true;
                Ok(false)
            }
            Some(Msg::Failed(e)) => Err(e),
            Some(Msg::Opened(_)) | None => Ok(false),
        }
    }
}

/// Crossfade applies between different albums (unknown counts as different).
fn albums_differ(a: &TrackRequest, b: &TrackRequest) -> bool {
    match (&a.album_id, &b.album_id) {
        (Some(x), Some(y)) => x != y,
        _ => true,
    }
}

struct Core {
    rx: Receiver<Cmd>,
    cache_dir: PathBuf,
    backend: Arc<dyn Backend>,
    emit: EmitFn,
    cur: Option<Slot>,
    next: Option<Slot>,
    out: Option<Box<dyn Output>>,
    /// Format requested when the open output was opened.
    out_req: Option<Format>,
    /// Sample rates of the selected device (lazily listed).
    dev_rates: Option<Vec<u32>>,
    /// The device did not take a DoP stream as requested; DSD plays as PCM
    /// until the output selection changes.
    dop_veto: bool,
    out_running: bool,
    device: Option<String>,
    exclusive: bool,
    dsp: DspConfig,
    state: PlaybackState,
    /// User intent: audio should be flowing.
    want_play: bool,
    /// Frames of fade-in already applied.
    fade_in: Option<u64>,
    path_dirty: bool,
    last_path: String,
    last_pos: Instant,
}

impl Core {
    fn run(mut self) {
        loop {
            let active = self
                .cur
                .as_ref()
                .is_some_and(|c| self.want_play || c.info.is_none());
            let cmd = if active {
                match self.rx.try_recv() {
                    Ok(c) => Some(c),
                    Err(TryRecvError::Empty) => None,
                    Err(TryRecvError::Disconnected) => return,
                }
            } else {
                match self.rx.recv() {
                    Ok(c) => Some(c),
                    Err(_) => return,
                }
            };
            match cmd {
                Some(c) => self.handle(c),
                None => self.step(),
            }
        }
    }

    // ---- events -----------------------------------------------------------

    fn event(&self, kind: EventKind) -> EngineEvent {
        let (track_id, entry_id, position_ms, duration_ms) = match &self.cur {
            Some(c) => {
                let rate = c.info.as_ref().map_or(0, |i| i.sample_rate as u64);
                let pos = if rate > 0 {
                    c.pos_frames.saturating_sub(c.held_src()) * 1000 / rate
                } else {
                    0
                };
                let dur = c.info.as_ref().map_or(0, |i| i.duration_ms);
                (
                    Some(c.req.id.clone()),
                    Some(c.req.entry_id.clone()),
                    pos,
                    dur,
                )
            }
            None => (None, None, 0, 0),
        };
        EngineEvent {
            kind,
            state: self.state,
            track_id,
            entry_id,
            position_ms,
            duration_ms,
            signal_path: None,
            message: None,
            throughput_bps: 0,
            cached_bytes: 0,
            total_bytes: 0,
        }
    }

    fn set_state(&mut self, s: PlaybackState) {
        if self.state != s {
            self.state = s;
            let e = self.event(EventKind::StateChanged);
            (self.emit)(e);
        }
    }

    fn emit_position(&mut self) {
        self.last_pos = Instant::now();
        if self.cur.as_ref().is_some_and(|c| c.info.is_some()) {
            let e = self.event(EventKind::Position);
            (self.emit)(e);
        }
    }

    /// Report a failure, attributed to `req`'s track when given.
    fn emit_error(&self, req: Option<&TrackRequest>, msg: String) {
        let mut e = self.event(EventKind::Error);
        e.track_id = req.map(|r| r.id.clone());
        e.entry_id = req.map(|r| r.entry_id.clone());
        e.message = Some(msg);
        (self.emit)(e);
    }

    fn signal_path(&self) -> Option<SignalPath> {
        let cur = self.cur.as_ref()?;
        let info = cur.info.as_ref()?;
        let st = cur.stream.as_ref()?;
        let oi = self.out.as_ref()?.info();
        let mut stages = st.describe();
        let (source_rate, source_bits, bit_perfect) = match info.dsd {
            Some(d) => {
                let f = oi.format;
                let exact = st.is_neutral()
                    && oi.exclusive
                    && f.rate == info.sample_rate
                    && f.channels == info.channels
                    && f.bits >= 24;
                if d.dop {
                    stages.insert(0, "DoP".to_string());
                } else {
                    stages.insert(
                        0,
                        format!("DSD→PCM {:.1} kHz", info.sample_rate as f64 / 1000.0),
                    );
                }
                (d.rate, 1, d.dop && exact)
            }
            None => (
                info.sample_rate,
                info.bits,
                st.is_neutral() && oi.exclusive && oi.format == info.format() && !info.lossy,
            ),
        };
        Some(SignalPath {
            codec: info.codec.clone(),
            source_sample_rate: source_rate,
            source_bit_depth: source_bits,
            channels: info.channels,
            stages,
            device_name: oi.device_name.clone(),
            output_sample_rate: oi.format.rate,
            output_bit_depth: oi.format.bits,
            exclusive: oi.exclusive,
            bit_perfect,
        })
    }

    /// Emit `SignalPathChanged` if the path differs from the last one sent.
    fn refresh_path(&mut self) {
        if let Some(p) = self.signal_path() {
            let key = format!("{p:?}");
            if key != self.last_path {
                self.last_path = key;
                let mut e = self.event(EventKind::SignalPathChanged);
                e.signal_path = Some(p);
                (self.emit)(e);
            }
        }
    }

    // ---- commands ---------------------------------------------------------

    fn handle(&mut self, cmd: Cmd) {
        match cmd {
            Cmd::Load(req, start) => {
                self.fade_out_block();
                let plan = self.dsd_plan();
                self.cur = Some(Slot::new(req, &self.cache_dir, plan));
                self.next = None;
                self.want_play = start;
                self.fade_in = None;
                self.path_dirty = true;
                self.set_state(if start {
                    PlaybackState::Buffering
                } else {
                    PlaybackState::Paused
                });
            }
            Cmd::SetNext(req) => {
                let same = matches!((&self.next, &req),
                    (Some(n), Some(r)) if n.req.id == r.id && n.req.entry_id == r.entry_id);
                if !same {
                    let plan = self.dsd_plan();
                    self.next = req.map(|r| Slot::new(r, &self.cache_dir, plan));
                }
            }
            Cmd::Play => {
                if self.cur.is_some() && !self.want_play {
                    self.want_play = true;
                    self.fade_in = Some(0);
                    self.set_state(if self.out.is_some() {
                        PlaybackState::Playing
                    } else {
                        PlaybackState::Buffering
                    });
                }
            }
            Cmd::Pause => {
                if self.cur.is_some() && self.want_play {
                    self.fade_out_block();
                    self.set_running(false);
                    self.want_play = false;
                    self.set_state(PlaybackState::Paused);
                }
            }
            Cmd::Stop => {
                self.fade_out_block();
                self.close_output(true);
                self.cur = None;
                self.next = None;
                self.want_play = false;
                self.set_state(PlaybackState::Stopped);
            }
            Cmd::Seek(ms) => self.seek(ms),
            Cmd::SetDsp(cfg) => {
                let old = std::mem::replace(&mut self.dsp, cfg);
                if !self.reconfigure() {
                    self.dsp = old;
                }
                self.refresh_path();
            }
            Cmd::SetOutput(dev, excl) => {
                self.device = dev;
                self.exclusive = excl;
                self.dev_rates = None;
                self.dop_veto = false;
                if self.out.is_some() {
                    self.reconfigure();
                    self.fade_out_block();
                    self.close_output(false);
                    self.path_dirty = true;
                } else {
                    self.reconfigure();
                }
            }
        }
    }

    fn seek(&mut self, ms: u64) {
        let playing = self.want_play && self.state == PlaybackState::Playing;
        if playing {
            self.fade_out_block();
        }
        let Some(cur) = self.cur.as_mut() else { return };
        let Some(info) = cur.info.as_ref() else {
            cur.pending_seek = Some(ms);
            return;
        };
        let ms = if info.duration_ms > 0 {
            ms.min(info.duration_ms)
        } else {
            ms
        };
        cur.pos_frames = ms * info.sample_rate as u64 / 1000;
        cur.pipe.seek(ms);
        cur.buf.clear();
        cur.off = 0;
        cur.eof = false;
        if let Some(st) = cur.stream.as_mut() {
            st.reset_chain();
        }
        if self.want_play {
            self.fade_in = Some(0);
        }
        self.emit_position();
    }

    // ---- stream setup -----------------------------------------------------

    /// Sample rates of the selected device (listed once, then cached).
    fn device_rates(&mut self) -> Vec<u32> {
        if self.dev_rates.is_none() {
            let id = self.device.clone();
            let rates = self
                .backend
                .list_devices()
                .ok()
                .and_then(|ds| {
                    ds.into_iter()
                        .find(|d| match &id {
                            Some(i) => &d.id == i,
                            None => d.is_default,
                        })
                        .map(|d| d.sample_rates)
                })
                .unwrap_or_default();
            self.dev_rates = Some(rates);
        }
        self.dev_rates.clone().unwrap_or_default()
    }

    /// DSD delivery for tracks opened from now on: DoP only when requested,
    /// the output is exclusive, the whole chain is bypassed (bit-perfect
    /// conditions) and the device was not seen refusing it.
    fn dsd_plan(&mut self) -> DsdPlan {
        let allow_dop = self.dsp.dsd == DsdMode::Dop
            && self.exclusive
            && !self.dop_veto
            && dsp_is_neutral(&self.dsp);
        DsdPlan {
            allow_dop,
            device_rates: if allow_dop {
                self.device_rates()
            } else {
                Vec::new()
            },
        }
    }

    /// True if a DSD track was opened in a mode the current setup no longer wants.
    fn dsd_stale(&mut self, info: &TrackInfo) -> bool {
        match info.dsd {
            Some(d) => self.dsd_plan().use_dop(d.rate) != d.dop,
            None => false,
        }
    }

    /// Reopen the current track (new DSD delivery) and continue from `ms`.
    fn respawn_cur(&mut self, ms: u64) {
        let plan = self.dsd_plan();
        let Some(cur) = self.cur.as_mut() else { return };
        cur.pipe = Pipeline::spawn(cur.req.clone(), self.cache_dir.clone(), plan);
        cur.info = None;
        cur.stream = None;
        cur.fmt = None;
        cur.buf.clear();
        cur.off = 0;
        cur.pos_frames = 0;
        cur.eof = false;
        cur.pending_seek = (ms > 0).then_some(ms);
        self.path_dirty = true;
    }

    /// After opening the device for a DoP track: if the device did not grant
    /// exactly the carrier rate at 24+ bits, exclusive, drop DoP for this
    /// output and reopen the track as PCM.
    fn dop_refused(&mut self, want: Format) -> bool {
        if !self.cur_is_dop() {
            return false;
        }
        let ok = self.out.as_ref().is_some_and(|o| {
            let i = o.info();
            i.exclusive
                && i.format.rate == want.rate
                && i.format.channels == want.channels
                && i.format.bits >= 24
        });
        if ok {
            return false;
        }
        self.dop_veto = true;
        self.close_output(false);
        let cur = self.cur.as_ref().unwrap();
        let ms = cur.pos_frames * 1000 / cur.info.as_ref().unwrap().sample_rate as u64;
        self.respawn_cur(ms);
        let req = self.cur.as_ref().unwrap().req.clone();
        self.emit_error(
            Some(&req),
            "device does not accept DoP; playing DSD as PCM".into(),
        );
        true
    }

    fn cur_is_dop(&self) -> bool {
        self.cur
            .as_ref()
            .and_then(|c| c.info.as_ref())
            .and_then(|i| i.dsd)
            .is_some_and(|d| d.dop)
    }

    /// Output rate for a source rate: the forced rate, else the source rate
    /// if the (exclusive) device takes it, else the nearest rate it does.
    fn out_rate_for(&mut self, src: u32) -> u32 {
        if let Some(r) = self.dsp.resample_to.filter(|&r| r > 0) {
            return r;
        }
        if !self.exclusive {
            return src;
        }
        let rates = self.device_rates();
        let rates = rates.as_slice();
        if rates.is_empty() || rates.contains(&src) {
            return src;
        }
        let dist = |r: u32| (r as f64 / src as f64).ln().abs();
        rates
            .iter()
            .copied()
            .min_by(|&a, &b| dist(a).total_cmp(&dist(b)).then(b.cmp(&a)))
            .unwrap_or(src)
    }

    /// Build the DSP stream and the device format for a decoded track.
    fn prepare(
        &mut self,
        info: &TrackInfo,
        req: &TrackRequest,
    ) -> Result<(DspStream, Format), String> {
        let out_rate = self.out_rate_for(info.sample_rate);
        let stream = DspStream::new(&self.dsp, info, req, out_rate)?;
        let fmt = Format {
            rate: out_rate,
            channels: info.channels,
            bits: info.format().bits,
        };
        Ok((stream, fmt))
    }

    /// Give `cur` its stream. Reopens the device if the format changed (the
    /// previous track's audio must already be written).
    fn install(&mut self, info: TrackInfo, stream: DspStream, fmt: Format) {
        if self.out_req.is_some_and(|s| s != fmt) {
            self.close_output(true);
        }
        let cur = self.cur.as_mut().unwrap();
        let rate = info.sample_rate as u64;
        cur.info = Some(info);
        cur.stream = Some(stream);
        cur.fmt = Some(fmt);
        if let Some(ms) = cur.pending_seek.take() {
            cur.pipe.seek(ms);
            cur.pos_frames = ms * rate / 1000;
        }
        self.bind_stream();
        self.path_dirty = true;
        self.emit_position();
    }

    /// Tell the current stream which device depth it feeds.
    fn bind_stream(&mut self) {
        let Some(bits) = self.out.as_ref().map(|o| o.info().format.bits) else {
            return;
        };
        if let Some(cur) = self.cur.as_mut() {
            if let (Some(st), Some(info)) = (cur.stream.as_mut(), cur.info.as_ref()) {
                st.bind_output(bits, info.bits);
            }
        }
    }

    /// Throw away audio that was processed but never written, and decode
    /// again from the audible position.
    fn rewind_unplayed(&mut self) {
        let Some(cur) = self.cur.as_mut() else { return };
        let (Some(st), Some(info)) = (cur.stream.as_mut(), cur.info.as_ref()) else {
            return;
        };
        if st.pending_frames() == 0 {
            return;
        }
        cur.pos_frames = cur.pos_frames.saturating_sub(st.pending_src_frames());
        let ms = cur.pos_frames * 1000 / info.sample_rate as u64;
        st.reset_chain();
        cur.pipe.seek(ms);
        cur.buf.clear();
        cur.off = 0;
        cur.eof = false;
    }

    /// Rebuild the current track's chain after a config or device change.
    /// Returns false (after reporting) if the new chain cannot be built.
    fn reconfigure(&mut self) -> bool {
        let Some(cur) = self.cur.as_ref() else {
            return true;
        };
        let Some(info) = cur.info.clone() else {
            return true;
        };
        let req = cur.req.clone();
        if self.dsd_stale(&info) {
            // DoP data cannot be processed (and PCM cannot become DoP): reopen
            // the track in the other mode at the audible position.
            self.fade_out_block();
            let cur = self.cur.as_ref().unwrap();
            let ms = cur.pos_frames.saturating_sub(cur.held_src()) * 1000 / info.sample_rate as u64;
            self.respawn_cur(ms);
            return true;
        }
        let (stream, fmt) = match self.prepare(&info, &req) {
            Ok(x) => x,
            Err(e) => {
                self.emit_error(None, e);
                return false;
            }
        };
        self.fade_out_block();
        self.rewind_unplayed();
        if self.out_req.is_some_and(|s| s != fmt) {
            self.close_output(true);
        }
        let cur = self.cur.as_mut().unwrap();
        cur.stream = Some(stream);
        cur.fmt = Some(fmt);
        self.bind_stream();
        if self.want_play {
            self.fade_in = Some(0);
        }
        self.path_dirty = true;
        true
    }

    // ---- output -----------------------------------------------------------

    fn set_running(&mut self, run: bool) {
        if let Some(o) = self.out.as_mut() {
            if self.out_running != run {
                if let Err(e) = o.set_running(run) {
                    let msg = format!("{e:#}");
                    self.emit_error(None, msg);
                }
                self.out_running = run;
            }
        }
    }

    fn close_output(&mut self, drain: bool) {
        if let Some(mut o) = self.out.take() {
            if drain {
                let _ = o.drain();
            }
        }
        self.out_req = None;
        self.out_running = false;
    }

    /// Write to the device; on failure report it for `req` and stop.
    fn write_block(&mut self, req: &TrackRequest, v: &[i32]) -> bool {
        if v.is_empty() {
            return true;
        }
        let Some(o) = self.out.as_mut() else {
            return true;
        };
        if let Err(e) = o.write(v) {
            self.emit_error(Some(req), format!("audio output failed: {e:#}"));
            self.close_output(false);
            self.cur = None;
            self.next = None;
            self.want_play = false;
            self.set_state(PlaybackState::Stopped);
            return false;
        }
        true
    }

    fn fade_frames(rate: u32) -> u64 {
        (rate as u64 * FADE_MS / 1000).max(1)
    }

    /// Play the next ~20 ms of the current track with a falling ramp so a
    /// pause, stop, seek or track replacement does not click. Consumes those
    /// frames from the track.
    fn fade_out_block(&mut self) {
        if self.state != PlaybackState::Playing || !self.out_running || self.out.is_none() {
            return;
        }
        // Scaling would corrupt the DoP stream; it is cut without a ramp.
        if self.cur_is_dop() {
            return;
        }
        let Some(cur) = self.cur.as_mut() else { return };
        let Some(mut st) = cur.stream.take() else {
            return;
        };
        let Some(info) = cur.info.as_ref() else {
            cur.stream = Some(st);
            return;
        };
        let ch = info.channels as usize;
        let want = Self::fade_frames(st.out_rate()) as usize;
        let mut v: Vec<i32> = Vec::with_capacity(want * ch);
        while v.len() < want * ch {
            let need = want - v.len() / ch;
            if st.pending_frames() > 0 {
                let n = need.min(st.pending_frames());
                v.extend(st.take(n));
                continue;
            }
            if cur.off >= cur.buf.len() {
                match cur.refill(Duration::from_millis(5)) {
                    Ok(true) => {}
                    _ => break,
                }
            }
            let take = (st.src_for_out(need) * ch).min(cur.buf.len() - cur.off);
            let blk = &cur.buf[cur.off..cur.off + take];
            if st.can_bypass() {
                v.extend_from_slice(blk);
            } else {
                st.feed(blk);
            }
            cur.off += take;
            cur.pos_frames += (take / ch) as u64;
        }
        cur.stream = Some(st);
        if v.is_empty() {
            return;
        }
        let frames = v.len() / ch;
        for (i, f) in v.chunks_mut(ch).enumerate() {
            let g = 1.0 - (i + 1) as f64 / frames as f64;
            for s in f {
                *s = (*s as f64 * g).round() as i32;
            }
        }
        let req = cur.req.clone();
        let _ = self.write_block(&req, &v);
    }

    /// Frames of processed audio to keep back for a crossfade into `next`.
    fn hold_frames(&self) -> usize {
        let ms = self.dsp.crossfade_ms as u64;
        if ms == 0 || !self.want_play {
            return 0;
        }
        let (Some(c), Some(n)) = (self.cur.as_ref(), self.next.as_ref()) else {
            return 0;
        };
        if !albums_differ(&c.req, &n.req) {
            return 0;
        }
        let (Some(info), Some(st)) = (c.info.as_ref(), c.stream.as_ref()) else {
            return 0;
        };
        if info.duration_ms > 0 {
            let start = info.duration_ms.saturating_sub(ms + HOLD_MARGIN_MS);
            if c.pos_frames * 1000 < start * info.sample_rate as u64 {
                return 0;
            }
        }
        (ms * st.out_rate() as u64 / 1000) as usize
    }

    // ---- playback loop ----------------------------------------------------

    fn step(&mut self) {
        if self.last_pos.elapsed() >= POSITION_EVERY && self.want_play {
            self.emit_position();
        }
        let cur = self.cur.as_ref().unwrap();

        // 1. Wait for the decoder to open the track.
        if cur.info.is_none() {
            match cur.pipe.pop(POLL) {
                Some(Msg::Opened(info)) => self.on_opened(info),
                Some(Msg::Failed(e)) => self.finish_current(Some(e)),
                Some(_) => {}
                None => {
                    if self.want_play {
                        self.set_state(PlaybackState::Buffering);
                    }
                }
            }
            return;
        }
        if !self.want_play {
            return;
        }

        // 2. Make sure a device is open for this track's format.
        if self.out.is_none() {
            let fmt = cur.fmt.unwrap();
            match self
                .backend
                .open(self.device.as_deref(), self.exclusive, fmt)
            {
                Ok(o) => {
                    self.out = Some(o);
                    self.out_req = Some(fmt);
                    self.out_running = true;
                    self.path_dirty = true;
                    self.bind_stream();
                    if self.dop_refused(fmt) {
                        return;
                    }
                }
                Err(e) => {
                    let req = cur.req.clone();
                    self.emit_error(Some(&req), format!("cannot open audio output: {e:#}"));
                    self.close_output(false);
                    self.cur = None;
                    self.next = None;
                    self.want_play = false;
                    self.set_state(PlaybackState::Stopped);
                    return;
                }
            }
        }
        if self.path_dirty {
            self.path_dirty = false;
            self.refresh_path();
        }
        if !self.out_running {
            self.set_running(true);
        }

        // 3. Get samples.
        let cur = self.cur.as_mut().unwrap();
        if cur.off >= cur.buf.len() {
            if cur.eof {
                return self.finish_current(None);
            }
            match cur.refill(POLL) {
                Ok(true) => {}
                Ok(false) => {
                    if cur.eof {
                        return;
                    }
                    self.set_state(PlaybackState::Buffering);
                    return;
                }
                Err(e) => return self.finish_current(Some(e)),
            }
        }
        self.set_state(PlaybackState::Playing);

        // 4. Write one block.
        let hold = self.hold_frames();
        let cur = self.cur.as_mut().unwrap();
        let info = cur.info.as_ref().unwrap();
        let ch = info.channels as usize;
        let frames = ((cur.buf.len() - cur.off) / ch).min(WRITE_FRAMES);
        let end = cur.off + frames * ch;
        let block = cur.buf[cur.off..end].to_vec();
        cur.off = end;
        cur.pos_frames += frames as u64;
        let dop = info.dsd.is_some_and(|d| d.dop);
        let first = !cur.started;
        cur.started = true;
        let req = cur.req.clone();
        let st = cur.stream.as_mut().unwrap();
        let total = Self::fade_frames(st.out_rate());
        let mut block = st.render(block, hold);

        if dop {
            self.fade_in = None;
        }
        if let Some(done) = self.fade_in {
            for (i, f) in block.chunks_mut(ch).enumerate() {
                let g = ((done + i as u64 + 1) as f64 / total as f64).min(1.0);
                for s in f {
                    *s = (*s as f64 * g).round() as i32;
                }
            }
            let done = done + (block.len() / ch) as u64;
            self.fade_in = (done < total).then_some(done);
        }
        if !self.write_block(&req, &block) {
            return;
        }
        if first {
            let e = self.event(EventKind::TrackStarted);
            (self.emit)(e);
            self.emit_position();
        }
    }

    fn on_opened(&mut self, info: TrackInfo) {
        if self.dsd_stale(&info) {
            let ms = self.cur.as_mut().unwrap().pending_seek.take().unwrap_or(0);
            return self.respawn_cur(ms);
        }
        let req = self.cur.as_ref().unwrap().req.clone();
        match self.prepare(&info, &req) {
            Ok((stream, fmt)) => self.install(info, stream, fmt),
            Err(e) => self.finish_current(Some(e)),
        }
    }

    /// Write everything `st` still holds.
    fn write_rest(&mut self, req: &TrackRequest, st: &mut DspStream) -> bool {
        let n = st.pending_frames();
        let v = st.take(n);
        self.write_block(req, &v)
    }

    /// The current track is done: it played out (`error == None`) or failed.
    /// Continue with the queued next track, or stop.
    fn finish_current(&mut self, error: Option<String>) {
        let mut ended = self.cur.take().unwrap();
        let mut old = ended.stream.take();
        if error.is_none() {
            if let Some(s) = old.as_mut() {
                s.flush();
            }
        }
        let xfade = error.is_none()
            && self.want_play
            && self.out.is_some()
            && self.dsp.crossfade_ms > 0
            && old.is_some()
            && self
                .next
                .as_ref()
                .is_some_and(|n| albums_differ(&ended.req, &n.req));

        // Audio the old track still owes the device (all of it, or all but
        // the crossfade tail).
        if let Some(s) = old.as_mut() {
            let n = s.pending_frames();
            let lead = if xfade {
                let keep = self.dsp.crossfade_ms as usize * s.out_rate() as usize / 1000;
                n.saturating_sub(keep)
            } else {
                n
            };
            let v = s.take(lead);
            if !self.write_block(&ended.req, &v) {
                return;
            }
        }
        match error {
            None => {
                let dur = ended.info.as_ref().map_or(0, |i| i.duration_ms);
                (self.emit)(EngineEvent {
                    kind: EventKind::TrackEnded,
                    state: self.state,
                    track_id: Some(ended.req.id.clone()),
                    entry_id: Some(ended.req.entry_id.clone()),
                    position_ms: dur,
                    duration_ms: dur,
                    signal_path: None,
                    message: None,
                    throughput_bps: 0,
                    cached_bytes: 0,
                    total_bytes: 0,
                });
            }
            Some(msg) => self.emit_error(Some(&ended.req), msg),
        }
        drop(ended);
        match self.next.take() {
            Some(n) => {
                self.cur = Some(n);
                self.path_dirty = true;
                match old {
                    Some(o) if xfade => self.crossfade_into_cur(o),
                    Some(mut o) => {
                        let req = self.cur.as_ref().unwrap().req.clone();
                        let _ = self.write_rest(&req, &mut o);
                    }
                    None => {}
                }
            }
            None => {
                self.close_output(true);
                self.want_play = false;
                self.set_state(PlaybackState::Stopped);
            }
        }
    }

    /// `cur` is the freshly promoted next track; `old.pending` holds the
    /// last stretch of the previous one. Mix them if both share the output
    /// format, otherwise play the stretch out and continue normally.
    fn crossfade_into_cur(&mut self, mut old: DspStream) {
        let req = self.cur.as_ref().unwrap().req.clone();
        let deadline = Instant::now() + XFADE_WAIT;
        let info = loop {
            match self.cur.as_ref().unwrap().pipe.pop(POLL) {
                Some(Msg::Opened(i)) => break Some(i),
                Some(Msg::Failed(e)) => {
                    if self.write_rest(&req, &mut old) {
                        self.finish_current(Some(e));
                    }
                    return;
                }
                Some(_) => {}
                None if Instant::now() > deadline => break None,
                None => {}
            }
        };
        let Some(info) = info else {
            // Not ready; step() keeps waiting for it as usual.
            let _ = self.write_rest(&req, &mut old);
            return;
        };
        if self.dsd_stale(&info) {
            if self.write_rest(&req, &mut old) {
                self.respawn_cur(0);
            }
            return;
        }
        let (stream, fmt) = match self.prepare(&info, &req) {
            Ok(x) => x,
            Err(e) => {
                if self.write_rest(&req, &mut old) {
                    self.finish_current(Some(e));
                }
                return;
            }
        };
        if self.out_req != Some(fmt) {
            if self.write_rest(&req, &mut old) {
                self.install(info, stream, fmt);
            }
            return;
        }
        self.install(info, stream, fmt);

        let ch = fmt.channels as usize;
        let want = old.pending_frames();
        let cur = self.cur.as_mut().unwrap();
        let mut st = cur.stream.take().unwrap();
        // Decode the head of the new track through its own chain.
        let mut failure = None;
        while st.pending_frames() < want && !cur.eof {
            match cur.refill(POLL) {
                Ok(true) => {}
                Ok(false) => {
                    if cur.eof {
                        st.flush();
                        break;
                    }
                    if Instant::now() > deadline {
                        break;
                    }
                    continue;
                }
                Err(e) => {
                    cur.eof = true;
                    failure = Some(e);
                    break;
                }
            }
            let frames = ((cur.buf.len() - cur.off) / ch).min(WRITE_FRAMES);
            let end = cur.off + frames * ch;
            st.feed(&cur.buf[cur.off..end]);
            cur.off = end;
            cur.pos_frames += frames as u64;
        }
        let used = want.min(st.pending_frames());
        let tail = std::mem::take(&mut old.pending);
        let split = (want - used) * ch;
        let head: Vec<f64> = st.pending.drain(..used * ch).collect();
        let mixed = rayla_dsp::crossfade(&tail[split..], &head, ch);
        let mut pending = tail[..split].to_vec();
        pending.extend_from_slice(&mixed);
        pending.append(&mut st.pending);
        st.pending = pending;
        cur.stream = Some(st);
        if let Some(e) = failure {
            self.emit_error(Some(&req), e);
        }
    }
}
