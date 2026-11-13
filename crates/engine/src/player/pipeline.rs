//! One track's decode thread and the bounded buffer between it and the
//! engine thread. Opening and decoding happen off the engine thread, so a
//! stalled network read shows up as an empty queue (Buffering) instead of
//! blocking the device writer.

use crate::api::engine::TrackRequest;
use crate::decode::{Decoder, DsdPlan, TrackInfo};
use crate::source;
use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

pub enum Msg {
    /// Always the first message.
    Opened(TrackInfo),
    /// Interleaved left-justified samples.
    Chunk(Vec<i32>),
    Eof,
    Failed(String),
}

#[derive(Default)]
struct Shared {
    q: VecDeque<Msg>,
    q_frames: usize,
    /// Bumped by `seek`; the decode thread drops output produced for an older epoch.
    epoch: u64,
    seek: Option<u64>,
    eof: bool,
    cancel: bool,
    /// Queue limit in samples (set once the format is known).
    limit: usize,
}

pub struct Pipeline {
    shared: Arc<(Mutex<Shared>, Condvar)>,
    /// Signalled when the queue gains data.
    ready: Arc<Condvar>,
    /// Tells a source blocked on the download to give up when the pipeline is dropped.
    cancel: Arc<AtomicBool>,
}

/// Seconds of audio decoded ahead.
const AHEAD_SECS: usize = 2;

impl Pipeline {
    pub fn spawn(req: Arc<TrackRequest>, cache_dir: PathBuf, plan: DsdPlan) -> Pipeline {
        let shared = Arc::new((
            Mutex::new(Shared {
                limit: usize::MAX,
                ..Default::default()
            }),
            Condvar::new(),
        ));
        let ready = Arc::new(Condvar::new());
        let cancel = Arc::new(AtomicBool::new(false));
        let (s, r, c) = (shared.clone(), ready.clone(), cancel.clone());
        std::thread::Builder::new()
            .name("rayla-decode".into())
            .spawn(move || run(req, cache_dir, plan, s, r, c))
            .expect("spawn decode thread");
        Pipeline {
            shared,
            ready,
            cancel,
        }
    }

    /// Next message, waiting up to `timeout`.
    pub fn pop(&self, timeout: Duration) -> Option<Msg> {
        let (m, space) = &*self.shared;
        let mut g = m.lock().unwrap();
        if g.q.is_empty() {
            g = self.ready.wait_timeout(g, timeout).unwrap().0;
        }
        let msg = g.q.pop_front();
        if let Some(Msg::Chunk(c)) = &msg {
            g.q_frames = g.q_frames.saturating_sub(c.len());
        }
        if msg.is_some() {
            space.notify_one();
        }
        msg
    }

    /// Discard buffered audio and continue decoding from `ms`.
    pub fn seek(&self, ms: u64) {
        let (m, space) = &*self.shared;
        let mut g = m.lock().unwrap();
        g.epoch += 1;
        g.seek = Some(ms);
        g.eof = false;
        // Keep a not-yet-consumed Opened message.
        g.q.retain(|m| matches!(m, Msg::Opened(_)));
        g.q_frames = 0;
        space.notify_one();
    }
}

impl Drop for Pipeline {
    fn drop(&mut self) {
        self.cancel.store(true, Ordering::Relaxed);
        let (m, space) = &*self.shared;
        m.lock().unwrap().cancel = true;
        space.notify_all();
    }
}

fn run(
    req: Arc<TrackRequest>,
    cache_dir: PathBuf,
    plan: DsdPlan,
    shared: Arc<(Mutex<Shared>, Condvar)>,
    ready: Arc<Condvar>,
    abort: Arc<AtomicBool>,
) {
    let (m, space) = &*shared;
    let post = |msg: Msg, epoch: Option<u64>| {
        let mut g = m.lock().unwrap();
        if g.cancel || epoch.is_some_and(|e| e != g.epoch) {
            return;
        }
        if let Msg::Chunk(c) = &msg {
            g.q_frames += c.len();
        }
        if matches!(msg, Msg::Eof | Msg::Failed(_)) {
            g.eof = true;
        }
        g.q.push_back(msg);
        ready.notify_one();
    };

    let headers: Vec<(String, String)> = req
        .headers
        .iter()
        .map(|h| (h.name.clone(), h.value.clone()))
        .collect();
    let opened = source::open(
        req.local_path.as_deref(),
        &req.url,
        &headers,
        &cache_dir,
        &req.id,
        Some(abort),
    )
    .and_then(|(src, ext)| Decoder::open(src, ext.as_deref(), &plan));
    let mut dec = match opened {
        Ok(d) => d,
        Err(e) => return post(Msg::Failed(format!("{e:#}")), None),
    };
    let info = dec.info().clone();
    {
        let mut g = m.lock().unwrap();
        g.limit = info.sample_rate as usize * info.channels as usize * AHEAD_SECS;
    }
    post(Msg::Opened(info), None);

    loop {
        // Wait for room (or a seek), then claim the work.
        let (seek, epoch) = {
            let mut g = m.lock().unwrap();
            while !g.cancel && g.seek.is_none() && (g.eof || g.q_frames >= g.limit) {
                g = space.wait(g).unwrap();
            }
            if g.cancel {
                return;
            }
            (g.seek.take(), g.epoch)
        };
        if let Some(ms) = seek {
            if let Err(e) = dec.seek(ms) {
                post(Msg::Failed(format!("{e:#}")), Some(epoch));
            }
            continue;
        }
        let mut chunk = Vec::new();
        match dec.next(&mut chunk) {
            Ok(true) => post(Msg::Chunk(chunk), Some(epoch)),
            Ok(false) => post(Msg::Eof, Some(epoch)),
            Err(e) => post(Msg::Failed(format!("{e:#}")), Some(epoch)),
        }
    }
}
