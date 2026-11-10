//! Shared stream-cache entries. One `Entry` per cached track owns the data
//! file, the table of byte ranges present, the known length and ONE
//! background downloader thread that fetches every missing range until the
//! whole file is on disk. The decoder side (`HttpSource`) and the prefetch
//! worker attach to the same entry through a process-wide registry, so a
//! track is never downloaded twice and the file never has two writers.
//!
//! The downloader runs as long as somebody holds the entry (a `Handle`) and
//! the file is incomplete. Network errors are retried forever with backoff.

use super::http::agent;
use anyhow::{Context, Result};
use std::collections::HashMap;
use std::fs::{File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex, Weak};
use std::time::{Duration, Instant, SystemTime};

/// Stream cache size cap; least recently used entries are pruned beyond it.
pub(crate) const CACHE_CAP: u64 = 3 << 30;
/// Persist the range table after this many new bytes (and when finishing).
const META_EVERY: u64 = 4 << 20;
/// A wanted position this close ahead of a running request is simply read through.
const RESTART_SLACK: u64 = 512 << 10;
const BACKOFF_MIN: Duration = Duration::from_millis(500);
const BACKOFF_MAX: Duration = Duration::from_secs(10);
/// Throughput is reported over windows of this length while downloading.
const THROUGHPUT_WINDOW: Duration = Duration::from_secs(3);
/// Smallest download worth an average-speed report.
const THROUGHPUT_MIN_BYTES: u64 = 256 << 10;

/// Sorted, disjoint, merged half-open byte ranges.
#[derive(Default, Debug, Clone, PartialEq)]
pub struct Ranges(Vec<(u64, u64)>);

impl Ranges {
    pub fn insert(&mut self, start: u64, end: u64) {
        if start >= end {
            return;
        }
        let (mut s, mut e) = (start, end);
        let mut out = Vec::with_capacity(self.0.len() + 1);
        let mut placed = false;
        for &(a, b) in &self.0 {
            if b < s {
                out.push((a, b));
            } else if a > e {
                if !placed {
                    out.push((s, e));
                    placed = true;
                }
                out.push((a, b));
            } else {
                s = s.min(a);
                e = e.max(b);
            }
        }
        if !placed {
            out.push((s, e));
        }
        self.0 = out;
    }
    /// End of the cached range containing `pos`.
    pub fn cached_end(&self, pos: u64) -> Option<u64> {
        self.0
            .iter()
            .find(|&&(a, b)| a <= pos && pos < b)
            .map(|&(_, b)| b)
    }
    /// Start of the first cached range after `pos`.
    pub fn next_start(&self, pos: u64) -> Option<u64> {
        self.0.iter().find(|&&(a, _)| a > pos).map(|&(a, _)| a)
    }
    pub fn covers(&self, len: u64) -> bool {
        len == 0 || self.0.first().is_some_and(|&(a, b)| a == 0 && b >= len)
    }
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
    /// First uncached position at or after `pos` below `len`.
    fn gap_from(&self, pos: u64, len: u64) -> Option<u64> {
        let p = self.cached_end(pos).unwrap_or(pos);
        (p < len).then_some(p)
    }
    /// The uncached sub-ranges of `[at, end)`.
    fn missing(&self, at: u64, end: u64) -> Vec<(u64, u64)> {
        let mut out = Vec::new();
        let mut p = at;
        while p < end {
            if let Some(e) = self.cached_end(p) {
                p = e;
                continue;
            }
            let nx = self.next_start(p).map_or(end, |s| s.min(end));
            out.push((p, nx));
            p = nx;
        }
        out
    }
}

pub(crate) struct State {
    /// Total size once the server told us (or a chunked stream ended).
    pub len: Option<u64>,
    pub ranges: Ranges,
    pub complete: bool,
    /// Last download error (cleared on progress), for diagnostics.
    pub error: Option<String>,
    /// Permanent failure (e.g. HTTP 403/404): the downloader has given up.
    pub fatal: bool,
    /// Position a reader is waiting for (priority for the downloader).
    pub want: Option<u64>,
    /// Bumped on every change a waiter could care about.
    pub progress: u64,
    holders: usize,
    running: bool,
    unsaved: u64,
}

pub(crate) struct Entry {
    url: String,
    /// Replaced on every attach so a fresh auth token is picked up on retry.
    auth: Mutex<Vec<(String, String)>>,
    track_id: String,
    pub data_path: PathBuf,
    meta_path: PathBuf,
    cache_dir: PathBuf,
    /// Only the downloader thread (and `reset`) write through this handle.
    writer: Mutex<File>,
    pub st: Mutex<State>,
    pub cv: Condvar,
}

/// Keeps an entry's downloader alive; the last drop stops it.
pub(crate) struct Handle(pub(crate) Arc<Entry>);

impl Drop for Handle {
    fn drop(&mut self) {
        let mut st = self.0.st.lock().unwrap();
        st.holders -= 1;
        drop(st);
        self.0.cv.notify_all();
    }
}

pub(crate) enum Status {
    Complete,
    Failed,
    Pending,
}

impl Handle {
    pub fn entry(&self) -> &Entry {
        &self.0
    }
    /// Wait up to `timeout` for the file to be complete or the download to fail.
    pub fn wait(&self, timeout: Duration) -> Status {
        let mut st = self.0.st.lock().unwrap();
        let deadline = Instant::now() + timeout;
        loop {
            if st.complete {
                return Status::Complete;
            }
            if st.fatal {
                return Status::Failed;
            }
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return Status::Pending;
            }
            st = self.0.cv.wait_timeout(st, left).unwrap().0;
        }
    }
}

type Registry = Mutex<HashMap<PathBuf, Weak<Entry>>>;
static REGISTRY: std::sync::OnceLock<Registry> = std::sync::OnceLock::new();

fn registry() -> &'static Registry {
    REGISTRY.get_or_init(Default::default)
}

/// File-name-safe form of a cache key.
pub(crate) fn safe_key(key: &str) -> String {
    key.bytes()
        .map(|c| match c {
            b'a'..=b'z' | b'A'..=b'Z' | b'0'..=b'9' | b'-' | b'_' => (c as char).to_string(),
            _ => format!("%{c:02X}"),
        })
        .collect()
}

fn fnv1a64(s: &str) -> u64 {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in s.bytes() {
        h ^= b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    h
}

/// Cache key of a track: the URL is part of it so a bitrate-capped or
/// transcoded stream never shares bytes with the original file.
pub(crate) fn cache_key(id: &str, url: &str) -> String {
    format!("{id}-{:016x}", fnv1a64(url))
}

/// Attach to (creating if needed) the entry for `key`. Starts the downloader
/// when the file is incomplete and it is not already running.
pub(crate) fn attach(
    url: &str,
    headers: &[(String, String)],
    cache_dir: &Path,
    key: &str,
    track_id: &str,
) -> Result<Handle> {
    std::fs::create_dir_all(cache_dir)?;
    let base = safe_key(key);
    let data_path = cache_dir.join(format!("{base}.audio"));
    let entry = {
        let mut reg = registry().lock().unwrap();
        reg.retain(|_, w| w.strong_count() > 0);
        match reg.get(&data_path).and_then(Weak::upgrade) {
            Some(e) => e,
            None => {
                let e = Arc::new(Entry::open(
                    url,
                    track_id,
                    cache_dir,
                    data_path.clone(),
                    cache_dir.join(format!("{base}.meta")),
                )?);
                reg.insert(data_path, Arc::downgrade(&e));
                e
            }
        }
    };
    *entry.auth.lock().unwrap() = headers.to_vec();
    // Mark as recently used for pruning.
    let _ = entry.writer.lock().unwrap().set_modified(SystemTime::now());
    let spawn = {
        let mut st = entry.st.lock().unwrap();
        st.holders += 1;
        if st.fatal {
            // A fresh open gets a fresh chance (new token, server back up).
            st.fatal = false;
            st.error = None;
        }
        let spawn = !st.complete && !st.running;
        st.running |= spawn;
        spawn
    };
    if spawn {
        let e = entry.clone();
        let started = std::thread::Builder::new()
            .name("rayla-fetch".into())
            .spawn(move || run(e));
        if started.is_err() {
            entry.st.lock().unwrap().running = false;
        }
    }
    Ok(Handle(entry))
}

impl Entry {
    fn open(
        url: &str,
        track_id: &str,
        cache_dir: &Path,
        data_path: PathBuf,
        meta_path: PathBuf,
    ) -> Result<Entry> {
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(&data_path)
            .with_context(|| format!("open cache file {}", data_path.display()))?;
        let size = file.metadata().map(|m| m.len()).unwrap_or(0);
        let (len, ranges) = match read_meta(&meta_path) {
            Some((l, r)) if l == size => (Some(l), r),
            _ => {
                // No usable table (or the data file was lost/truncated).
                let _ = file.set_len(0);
                (None, Ranges::default())
            }
        };
        let complete = len.is_some_and(|l| ranges.covers(l));
        Ok(Entry {
            url: url.to_string(),
            auth: Mutex::new(Vec::new()),
            track_id: track_id.to_string(),
            data_path,
            meta_path,
            cache_dir: cache_dir.to_path_buf(),
            writer: Mutex::new(file),
            st: Mutex::new(State {
                len,
                ranges,
                complete,
                error: None,
                fatal: false,
                want: None,
                progress: 0,
                holders: 0,
                running: false,
                unsaved: 0,
            }),
            cv: Condvar::new(),
        })
    }

    /// Persist the range table (only meaningful once the length is known).
    fn save_meta(&self, st: &mut State) {
        st.unsaved = 0;
        let Some(len) = st.len else {
            let _ = std::fs::remove_file(&self.meta_path);
            return;
        };
        let mut text = format!("{len}\n");
        for &(a, b) in &st.ranges.0 {
            text.push_str(&format!("{a} {b}\n"));
        }
        let _ = self.writer.lock().unwrap().flush();
        let _ = std::fs::write(&self.meta_path, text);
    }

    /// Forget everything cached (remote file changed) and adopt `new_len`.
    fn reset(&self, new_len: Option<u64>) {
        let mut st = self.st.lock().unwrap();
        st.ranges = Ranges::default();
        st.len = new_len;
        st.complete = false;
        st.progress += 1;
        {
            let w = self.writer.lock().unwrap();
            let _ = w.set_len(0);
            if let Some(l) = new_len {
                let _ = w.set_len(l);
            }
        }
        self.save_meta(&mut st);
        drop(st);
        self.cv.notify_all();
    }

    fn fail(&self, msg: String, fatal: bool) {
        let mut st = self.st.lock().unwrap();
        st.error = Some(msg);
        st.fatal |= fatal;
        st.progress += 1;
        drop(st);
        self.cv.notify_all();
    }

    /// Sleep for `d`, cut short when nobody holds the entry any more.
    fn backoff(&self, d: Duration) {
        let deadline = Instant::now() + d;
        let mut st = self.st.lock().unwrap();
        while st.holders > 0 {
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                break;
            }
            st = self.cv.wait_timeout(st, left).unwrap().0;
        }
    }

    /// What to fetch next: the position a reader waits for, else the first gap
    /// after where the last request ended, else the first gap from the start.
    fn plan(st: &State, cursor: u64) -> (u64, Option<u64>) {
        let Some(len) = st.len else { return (0, None) };
        let start = st
            .want
            .filter(|&w| w < len && st.ranges.cached_end(w).is_none())
            .or_else(|| st.ranges.gap_from(cursor, len))
            .or_else(|| st.ranges.gap_from(0, len))
            .unwrap_or(0);
        // Bounded to the gap; open-ended when nothing cached lies ahead.
        (start, st.ranges.next_start(start))
    }
}

/// Download speed bookkeeping for `Throughput` events.
struct Dl {
    cursor: u64,
    win_start: Instant,
    win_bytes: u64,
    total_bytes: u64,
    /// Time spent inside requests (excludes backoff sleeps).
    active: Duration,
}

fn bps(bytes: u64, d: Duration) -> u64 {
    (bytes as f64 * 8.0 / d.as_secs_f64().max(1e-3)) as u64
}

struct Fail {
    fatal: bool,
    msg: String,
}

fn retry(msg: impl ToString) -> Fail {
    Fail { fatal: false, msg: msg.to_string() }
}

/// The downloader thread: lives while somebody holds the entry and bytes are missing.
fn run(e: Arc<Entry>) {
    let agent = match agent() {
        Ok(a) => a,
        Err(err) => {
            e.fail(format!("{err:#}"), true);
            e.st.lock().unwrap().running = false;
            return;
        }
    };
    let mut backoff = BACKOFF_MIN;
    let mut dl = Dl {
        cursor: 0,
        win_start: Instant::now(),
        win_bytes: 0,
        total_bytes: 0,
        active: Duration::ZERO,
    };
    loop {
        let (start, limit) = {
            let mut st = e.st.lock().unwrap();
            if st.holders == 0 || st.complete || st.fatal {
                let done = st.complete;
                e.save_meta(&mut st);
                st.running = false;
                drop(st);
                e.cv.notify_all();
                if done {
                    finished(&e, &dl);
                }
                return;
            }
            let (s, l) = Entry::plan(&st, dl.cursor);
            (s, l)
        };
        dl.win_start = Instant::now();
        dl.win_bytes = 0;
        let bytes0 = dl.total_bytes;
        let t0 = Instant::now();
        let res = fetch(&e, &agent, start, limit, &mut dl);
        dl.active += t0.elapsed();
        let progressed = dl.total_bytes != bytes0;
        let immediate = match res {
            Ok(again) => again,
            Err(f) if f.fatal => {
                e.fail(f.msg, true);
                continue;
            }
            Err(f) => {
                e.fail(f.msg, false);
                false
            }
        };
        if immediate || progressed {
            // Made headway (or must restart elsewhere): carry on at once.
            backoff = BACKOFF_MIN;
            continue;
        }
        e.backoff(backoff);
        backoff = (backoff * 2).min(BACKOFF_MAX);
    }
}

/// Completion bookkeeping: average-speed report and cache pruning.
fn finished(e: &Entry, dl: &Dl) {
    if dl.total_bytes >= THROUGHPUT_MIN_BYTES && !dl.active.is_zero() {
        super::emit_throughput(&e.track_id, bps(dl.total_bytes, dl.active));
    }
    prune(&e.cache_dir, CACHE_CAP);
}

/// One request: stream bytes into the cache until its range ends, a reader
/// needs somewhere else, or the connection breaks. `Ok(true)` = go again now.
fn fetch(
    e: &Entry,
    agent: &ureq::Agent,
    start: u64,
    limit: Option<u64>,
    dl: &mut Dl,
) -> Result<bool, Fail> {
    let mut req = agent.get(&e.url);
    for (n, v) in e.auth.lock().unwrap().iter() {
        req = req.set(n, v);
    }
    let range = match limit {
        Some(l) => format!("bytes={start}-{}", l - 1),
        None => format!("bytes={start}-"),
    };
    let resp = match req.set("Range", &range).call() {
        Ok(r) => r,
        Err(ureq::Error::Status(416, _)) => {
            // The file shrank: forget what we know and learn the length again.
            e.reset(None);
            return Err(retry("HTTP 416 (file shrank)"));
        }
        Err(ureq::Error::Status(c, _)) if (400..500).contains(&c) && c != 408 && c != 429 => {
            return Err(Fail { fatal: true, msg: format!("HTTP {c}") });
        }
        Err(err) => return Err(retry(err)),
    };
    let (total, whole) = match resp.status() {
        206 => {
            let total = resp
                .header("Content-Range")
                .and_then(|cr| cr.rsplit('/').next())
                .and_then(|t| t.trim().parse::<u64>().ok());
            match total {
                Some(t) => (Some(t), false),
                None => return Err(retry("206 without usable Content-Range")),
            }
        }
        // The server ignored Range and sends the whole file from 0; chunked
        // transcodes have no Content-Length.
        200 => (
            resp.header("Content-Length").and_then(|t| t.trim().parse::<u64>().ok()),
            true,
        ),
        s => return Err(retry(format!("unexpected HTTP status {s}"))),
    };
    if total == Some(0) {
        return Err(Fail { fatal: true, msg: "empty response".into() });
    }
    let len = {
        let mut st = e.st.lock().unwrap();
        match (st.len, total) {
            (Some(l), Some(t)) if l != t => {
                drop(st);
                e.reset(Some(t)); // remote file changed: start over
                return Ok(true);
            }
            (None, Some(t)) => {
                st.len = Some(t);
                st.progress += 1;
                let _ = e.writer.lock().unwrap().set_len(t);
                e.cv.notify_all();
            }
            _ => {}
        }
        st.len
    };
    let mut reader = resp.into_reader();
    let mut next = if whole { 0 } else { start };
    // Exclusive end of what this response carries; unknown for chunked 200s.
    let end = if whole { len } else { limit.or(total) };
    let mut buf = vec![0u8; 64 << 10];
    loop {
        if end.is_some_and(|en| next >= en) {
            return Ok(false);
        }
        let want = end.map_or(buf.len(), |en| buf.len().min((en - next) as usize));
        match reader.read(&mut buf[..want]) {
            Ok(0) => {
                return match end {
                    None => finish_unknown(e, next).map(|_| true),
                    Some(en) if next < en => Err(retry("stream ended early")),
                    Some(_) => Ok(false),
                };
            }
            Ok(n) => {
                if !store(e, next, &buf[..n], whole, end, dl)? {
                    return Ok(true);
                }
                next += n as u64;
            }
            Err(err) => return Err(retry(err)),
        }
    }
}

/// A chunked stream ended cleanly: its length is now known and the file complete.
fn finish_unknown(e: &Entry, len: u64) -> Result<(), Fail> {
    if len == 0 {
        return Err(retry("empty response"));
    }
    let mut st = e.st.lock().unwrap();
    st.len = Some(len);
    st.complete = st.ranges.covers(len);
    st.progress += 1;
    let _ = e.writer.lock().unwrap().set_len(len);
    e.save_meta(&mut st);
    drop(st);
    e.cv.notify_all();
    Ok(())
}

/// Write the not-yet-cached part of `data` (at `at`) and record it. Returns
/// whether the current request should go on.
fn store(
    e: &Entry,
    at: u64,
    data: &[u8],
    whole: bool,
    end: Option<u64>,
    dl: &mut Dl,
) -> Result<bool, Fail> {
    let n = data.len() as u64;
    let segs = e.st.lock().unwrap().ranges.missing(at, at + n);
    {
        let mut w = e.writer.lock().unwrap();
        for (a, b) in segs {
            let io = w
                .seek(SeekFrom::Start(a))
                .and_then(|_| w.write_all(&data[(a - at) as usize..(b - at) as usize]));
            io.map_err(|err| retry(format!("cache write: {err}")))?;
        }
    }
    let mut st = e.st.lock().unwrap();
    st.ranges.insert(at, at + n);
    st.unsaved += n;
    st.progress += 1;
    st.error = None;
    dl.cursor = at + n;
    if st.len.is_some_and(|l| st.ranges.covers(l)) {
        st.complete = true;
        e.save_meta(&mut st);
    } else if st.unsaved >= META_EVERY {
        e.save_meta(&mut st);
    }
    let mut go = st.holders > 0 && !st.complete;
    // A reader needs a place this request will not reach soon: restart there.
    if go && !whole {
        if let Some(w) = st.want.filter(|&w| st.ranges.cached_end(w).is_none()) {
            let nx = at + n;
            let near = w >= nx && end.is_some_and(|en| w < en) && w - nx <= RESTART_SLACK;
            go = near;
        }
    }
    drop(st);
    e.cv.notify_all();
    dl.total_bytes += n;
    dl.win_bytes += n;
    if dl.win_start.elapsed() >= THROUGHPUT_WINDOW {
        super::emit_throughput(&e.track_id, bps(dl.win_bytes, dl.win_start.elapsed()));
        dl.win_start = Instant::now();
        dl.win_bytes = 0;
    }
    Ok(go)
}

fn read_meta(path: &Path) -> Option<(u64, Ranges)> {
    let text = std::fs::read_to_string(path).ok()?;
    let mut lines = text.lines();
    let len: u64 = lines.next()?.trim().parse().ok()?;
    let mut r = Ranges::default();
    for l in lines {
        let mut it = l.split_whitespace();
        let a: u64 = it.next()?.parse().ok()?;
        let b: u64 = it.next()?.parse().ok()?;
        if b > len {
            return None;
        }
        r.insert(a, b);
    }
    Some((len, r))
}

/// Delete least recently used cache entries (by data-file mtime) until the
/// directory is within `cap` bytes. Entries currently in the registry are
/// never touched. Errors are ignored.
pub(crate) fn prune(dir: &Path, cap: u64) {
    // Hold the registry so nothing attaches to a file while it is deleted.
    let reg = registry().lock().unwrap();
    let live: Vec<&PathBuf> = reg
        .iter()
        .filter(|(_, w)| w.strong_count() > 0)
        .map(|(p, _)| p)
        .collect();
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    let size = |p: &Path| std::fs::metadata(p).map(|m| m.len()).unwrap_or(0);
    let mut total = 0u64;
    let mut files: Vec<(SystemTime, PathBuf, u64)> = Vec::new();
    for ent in rd.flatten() {
        let p = ent.path();
        match p.extension().and_then(|x| x.to_str()) {
            Some("audio") => {
                let m = ent.metadata().ok();
                let sz = m.as_ref().map_or(0, |m| m.len()) + size(&p.with_extension("meta"));
                let t = m.and_then(|m| m.modified().ok()).unwrap_or(SystemTime::UNIX_EPOCH);
                total += sz;
                files.push((t, p, sz));
            }
            _ => {}
        }
    }
    files.sort();
    for (_, p, sz) in files {
        if total <= cap {
            break;
        }
        if live.contains(&&p) {
            continue;
        }
        let _ = std::fs::remove_file(&p);
        let _ = std::fs::remove_file(p.with_extension("meta"));
        total = total.saturating_sub(sz);
    }
}
