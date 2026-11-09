//! Engine tests run against the in-memory sink; the HTTP tests use a small
//! Range-capable server on a loopback socket.

use super::engine::{Cmd, Engine, EmitFn};
use crate::api::engine::*;
use crate::decode::Format;
use crate::output::sink::SinkBackend;
use crate::source::HttpSource;
use std::io::{Read, Seek, SeekFrom, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

// ---- fixtures ---------------------------------------------------------------

pub(crate) fn tmp(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("rayla-test-{}-{name}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

/// Deterministic full-range-ish samples of `bits` depth (right-justified).
fn noise(n: usize, bits: u32, seed: u64) -> Vec<i32> {
    let mut x = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
    (0..n)
        .map(|_| {
            x = x.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            ((x >> 33) as i64 as i32) >> (32 - bits) // arithmetic shift keeps sign
        })
        .collect()
}

fn wav_bytes(rate: u32, channels: u16, bits: u16, samples: &[i32]) -> Vec<u8> {
    let bytes = bits as usize / 8;
    let data_len = samples.len() * bytes;
    let mut v = Vec::new();
    v.extend(b"RIFF");
    v.extend(((36 + data_len) as u32).to_le_bytes());
    v.extend(b"WAVEfmt ");
    v.extend(16u32.to_le_bytes());
    v.extend(1u16.to_le_bytes());
    v.extend(channels.to_le_bytes());
    v.extend(rate.to_le_bytes());
    v.extend((rate * channels as u32 * bytes as u32).to_le_bytes());
    v.extend((channels * bytes as u16).to_le_bytes());
    v.extend(bits.to_le_bytes());
    v.extend(b"data");
    v.extend((data_len as u32).to_le_bytes());
    for s in samples {
        v.extend(&s.to_le_bytes()[..bytes]);
    }
    v
}

fn write_wav(dir: &PathBuf, name: &str, rate: u32, bits: u16, samples: &[i32]) -> String {
    let p = dir.join(name);
    std::fs::write(&p, wav_bytes(rate, 2, bits, samples)).unwrap();
    p.to_string_lossy().into_owned()
}

fn left_justified(samples: &[i32], bits: u32) -> Vec<i32> {
    samples.iter().map(|s| s << (32 - bits)).collect()
}

fn local(id: &str, path: &str) -> TrackRequest {
    TrackRequest {
        id: id.into(),
        entry_id: format!("e-{id}"),
        url: String::new(),
        headers: vec![],
        local_path: Some(path.into()),
        album_id: None,
        fallback_gain_db: None,
    }
}

struct Rig {
    engine: Engine,
    sink: SinkBackend,
    rx: Receiver<EngineEvent>,
    dir: PathBuf,
}

fn rig(name: &str, speed: f64) -> Rig {
    let dir = tmp(name);
    let sink = SinkBackend::with_speed(speed);
    let (tx, rx) = mpsc::channel();
    let tx = Mutex::new(tx);
    let emit: EmitFn = Arc::new(move |e| {
        let _ = tx.lock().unwrap().send(e);
    });
    let engine = Engine::start(dir.join("cache"), Arc::new(sink.clone()), emit);
    Rig { engine, sink, rx, dir }
}

impl Rig {
    /// Collect events until `pred` matches one (returned last in the vec).
    fn until(&self, what: &str, pred: impl Fn(&EngineEvent) -> bool) -> Vec<EngineEvent> {
        let end = Instant::now() + Duration::from_secs(20);
        let mut seen = Vec::new();
        loop {
            let left = end.saturating_duration_since(Instant::now());
            let e = self.rx.recv_timeout(left).unwrap_or_else(|_| panic!("timed out waiting for {what}; saw {seen:?}"));
            let hit = pred(&e);
            seen.push(e);
            if hit {
                return seen;
            }
        }
    }
    fn until_stopped(&self) -> Vec<EngineEvent> {
        self.until("Stopped", |e| e.kind == EventKind::StateChanged && e.state == PlaybackState::Stopped)
    }
    fn samples(&self) -> Vec<i32> {
        self.sink.log.lock().unwrap().samples.clone()
    }
}

fn path_of(events: &[EngineEvent]) -> SignalPath {
    events
        .iter()
        .rev()
        .find_map(|e| e.signal_path.clone())
        .expect("no SignalPathChanged event")
}

// ---- bit-perfect --------------------------------------------------------------

fn bit_perfect_case(bits: u16) {
    let r = rig(&format!("bp{bits}"), 0.0);
    let pcm = noise(2 * 30_000, bits as u32, 7);
    let path = write_wav(&r.dir, "a.wav", 44100, bits, &pcm);
    r.engine.send(Cmd::SetOutput(None, true)).unwrap();
    r.engine.send(Cmd::Load(local("a", &path), true)).unwrap();
    let ev = r.until_stopped();
    assert_eq!(r.samples(), left_justified(&pcm, bits as u32), "{bits}-bit samples changed");
    let sp = path_of(&ev);
    assert!(sp.bit_perfect && sp.exclusive, "{sp:?}");
    assert_eq!((sp.source_sample_rate, sp.source_bit_depth), (44100, bits as u32));
    assert_eq!((sp.output_sample_rate, sp.output_bit_depth), (44100, bits as u32));
    assert_eq!(sp.codec, "PCM");
    assert!(ev.iter().any(|e| e.kind == EventKind::TrackStarted));
    assert!(ev.iter().any(|e| e.kind == EventKind::TrackEnded && e.track_id.as_deref() == Some("a")));
}

#[test]
fn bit_perfect_16() {
    bit_perfect_case(16);
}

#[test]
fn bit_perfect_24() {
    bit_perfect_case(24);
}

#[test]
fn shared_output_is_not_bit_perfect() {
    let r = rig("shared", 0.0);
    let path = write_wav(&r.dir, "a.wav", 44100, 16, &noise(2 * 5000, 16, 1));
    r.engine.send(Cmd::Load(local("a", &path), true)).unwrap();
    let sp = path_of(&r.until_stopped());
    assert!(!sp.bit_perfect && !sp.exclusive);
}

#[test]
fn volume_scales_and_breaks_bit_perfect() {
    let r = rig("volume", 0.0);
    let pcm = noise(2 * 5000, 16, 3);
    let path = write_wav(&r.dir, "a.wav", 44100, 16, &pcm);
    let mut cfg = super::engine::neutral_dsp();
    cfg.volume = 0.5;
    r.engine.send(Cmd::SetOutput(None, true)).unwrap();
    r.engine.send(Cmd::SetDsp(cfg)).unwrap();
    r.engine.send(Cmd::Load(local("a", &path), true)).unwrap();
    let ev = r.until_stopped();
    let out = r.samples();
    assert_eq!(out.len(), pcm.len());
    for (o, p) in out.iter().zip(&pcm) {
        // Quantized to the 16-bit device depth, left-justified.
        assert_eq!(*o, ((*p as f64 * 0.5).round() as i32) << 16);
    }
    let sp = path_of(&ev);
    assert!(!sp.bit_perfect);
    assert_eq!(sp.stages, vec!["Volume \u{2212}6.0 dB".to_string()]);
}

// ---- gapless ----------------------------------------------------------------

#[test]
fn gapless_same_format_is_seamless() {
    let r = rig("gapless", 0.0);
    let a = noise(2 * 20_001, 16, 11);
    let b = noise(2 * 17_777, 16, 12);
    let pa = write_wav(&r.dir, "a.wav", 44100, 16, &a);
    let pb = write_wav(&r.dir, "b.wav", 44100, 16, &b);
    r.engine.send(Cmd::SetOutput(None, true)).unwrap();
    r.engine.send(Cmd::SetNext(Some(local("b", &pb)))).unwrap();
    r.engine.send(Cmd::Load(local("a", &pa), true)).unwrap();
    // Load clears the queue, so queue b after loading a.
    r.engine.send(Cmd::SetNext(Some(local("b", &pb)))).unwrap();
    let ev = r.until_stopped();
    let out = r.samples();
    let mut want = left_justified(&a, 16);
    want.extend(left_justified(&b, 16));
    assert_eq!(out.len(), a.len() + b.len(), "frames inserted or dropped");
    assert_eq!(out, want);
    assert_eq!(r.sink.log.lock().unwrap().opens.len(), 1, "device was reopened");
    let order: Vec<_> = ev
        .iter()
        .filter(|e| matches!(e.kind, EventKind::TrackStarted | EventKind::TrackEnded))
        .map(|e| (e.kind, e.track_id.clone().unwrap()))
        .collect();
    assert_eq!(
        order,
        vec![
            (EventKind::TrackStarted, "a".to_string()),
            (EventKind::TrackEnded, "a".to_string()),
            (EventKind::TrackStarted, "b".to_string()),
            (EventKind::TrackEnded, "b".to_string()),
        ]
    );
}

#[test]
fn format_change_reopens_device_without_losing_samples() {
    let r = rig("reopen", 0.0);
    let a = noise(2 * 9000, 16, 21);
    let b = noise(2 * 9000, 24, 22);
    let pa = write_wav(&r.dir, "a.wav", 44100, 16, &a);
    let pb = write_wav(&r.dir, "b.wav", 96000, 24, &b);
    r.engine.send(Cmd::SetOutput(None, true)).unwrap();
    r.engine.send(Cmd::Load(local("a", &pa), true)).unwrap();
    r.engine.send(Cmd::SetNext(Some(local("b", &pb)))).unwrap();
    r.until_stopped();
    let mut want = left_justified(&a, 16);
    want.extend(left_justified(&b, 24));
    assert_eq!(r.samples(), want);
    let log = r.sink.log.lock().unwrap();
    assert_eq!(
        log.opens,
        vec![Format { rate: 44100, channels: 2, bits: 16 }, Format { rate: 96000, channels: 2, bits: 24 }]
    );
    assert!(log.drains >= 1);
}

// ---- seek / pause -------------------------------------------------------------

/// Left channel counts frames modulo 20000; right is its negative.
fn ramp(frames: usize) -> Vec<i32> {
    (0..frames).flat_map(|f| [(f % 20000) as i32, -((f % 20000) as i32)]).collect()
}

#[test]
fn seek_lands_on_target_with_fade_in() {
    let r = rig("seek", 4.0);
    let frames = 44100 * 3;
    let path = write_wav(&r.dir, "a.wav", 44100, 16, &ramp(frames));
    r.engine.send(Cmd::Load(local("a", &path), true)).unwrap();
    r.until("TrackStarted", |e| e.kind == EventKind::TrackStarted);
    r.engine.send(Cmd::Seek(2000)).unwrap();
    let ev = r.until_stopped();
    let out = r.samples();
    let left: Vec<i32> = out.iter().step_by(2).map(|s| s >> 16).collect();
    // Skipped most of the first two seconds.
    assert!(left.len() < frames - 80_000, "{} frames written", left.len());
    // The last discontinuity is the end of the 20 ms fade-in: 20 ms of
    // 44.1 kHz is 882 frames, so frame 88200 + 881 is the first at full gain.
    let bad = (1..left.len()).rev().find(|&i| left[i] != left[i - 1] + 1 && left[i] != 0).unwrap();
    assert_eq!(left[bad], ((88_200 + 881) % 20000) as i32);
    assert_eq!(*left.last().unwrap(), ((frames - 1) % 20000) as i32);
    // Frames inside the fade are attenuated, not full scale.
    assert!(left[bad - 400] < ((88_200 + 481) % 20000) as i32 || (88_200 + 481) % 20000 < 400);
    assert!(ev.iter().any(|e| e.kind == EventKind::Position));
}

#[test]
fn pause_stops_writing_and_resume_continues_without_loss() {
    let r = rig("pause", 4.0);
    let frames = 44100 * 3;
    let path = write_wav(&r.dir, "a.wav", 44100, 16, &ramp(frames));
    r.engine.send(Cmd::Load(local("a", &path), true)).unwrap();
    r.until("TrackStarted", |e| e.kind == EventKind::TrackStarted);
    r.engine.send(Cmd::Pause).unwrap();
    r.until("Paused", |e| e.kind == EventKind::StateChanged && e.state == PlaybackState::Paused);
    std::thread::sleep(Duration::from_millis(60));
    let n1 = r.samples().len();
    std::thread::sleep(Duration::from_millis(150));
    assert_eq!(r.samples().len(), n1, "audio written while paused");
    assert!(!r.sink.log.lock().unwrap().running);
    assert!(n1 > 0 && n1 < 2 * frames);
    r.engine.send(Cmd::Play).unwrap();
    r.until("Playing", |e| e.kind == EventKind::StateChanged && e.state == PlaybackState::Playing);
    r.until_stopped();
    let out = r.samples();
    assert_eq!(out.len(), 2 * frames, "frames lost or duplicated across pause");
    let left: Vec<i32> = out.iter().step_by(2).map(|s| s >> 16).collect();
    assert_eq!(*left.last().unwrap(), ((frames - 1) % 20000) as i32);
    // Pause fade-out ends in silence and resume fades in from near-silence.
    let pause_at = n1 / 2;
    assert!(left[pause_at - 1].abs() < 100 || left[pause_at - 1] % 20000 < 100);
}

#[test]
fn seek_while_paused_then_play() {
    let r = rig("seekpaused", 0.0);
    let frames = 44100;
    let path = write_wav(&r.dir, "a.wav", 44100, 16, &ramp(frames));
    r.engine.send(Cmd::Load(local("a", &path), false)).unwrap();
    r.engine.send(Cmd::Seek(500)).unwrap();
    r.engine.send(Cmd::Play).unwrap();
    r.until_stopped();
    let left: Vec<i32> = r.samples().iter().step_by(2).map(|s| s >> 16).collect();
    assert_eq!(left.len(), frames - 22050);
    assert_eq!(*left.last().unwrap(), ((frames - 1) % 20000) as i32);
}

#[test]
fn stop_clears_track_and_reports_stopped() {
    let r = rig("stop", 4.0);
    let path = write_wav(&r.dir, "a.wav", 44100, 16, &ramp(44100 * 3));
    r.engine.send(Cmd::Load(local("a", &path), true)).unwrap();
    r.until("TrackStarted", |e| e.kind == EventKind::TrackStarted);
    r.engine.send(Cmd::Stop).unwrap();
    let ev = r.until_stopped();
    assert!(!ev.iter().any(|e| e.kind == EventKind::TrackEnded));
}

#[test]
fn missing_file_reports_error() {
    let r = rig("missing", 0.0);
    r.engine.send(Cmd::Load(local("x", "/nonexistent/file.flac"), true)).unwrap();
    let ev = r.until("Error", |e| e.kind == EventKind::Error);
    assert_eq!(ev.last().unwrap().track_id.as_deref(), Some("x"));
    r.until_stopped();
}

// ---- HTTP source --------------------------------------------------------------

pub(crate) struct TestServer {
    addr: SocketAddr,
    ranges: Arc<Mutex<Vec<String>>>,
    stop: Arc<AtomicBool>,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl TestServer {
    /// Serves `body` honouring `Range`; requires `X-Token: secret`.
    pub(crate) fn start(body: Vec<u8>) -> TestServer {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let addr = listener.local_addr().unwrap();
        let ranges = Arc::new(Mutex::new(Vec::new()));
        let stop = Arc::new(AtomicBool::new(false));
        let body = Arc::new(body);
        let (r2, s2) = (ranges.clone(), stop.clone());
        let thread = std::thread::spawn(move || {
            while !s2.load(Ordering::Relaxed) {
                match listener.accept() {
                    Ok((sock, _)) => {
                        let (b, r) = (body.clone(), r2.clone());
                        std::thread::spawn(move || {
                            let _ = serve(sock, &b, &r);
                        });
                    }
                    Err(_) => std::thread::sleep(Duration::from_millis(2)),
                }
            }
        });
        TestServer { addr, ranges, stop, thread: Some(thread) }
    }
    pub(crate) fn url(&self) -> String {
        format!("http://{}/audio", self.addr)
    }
    pub(crate) fn requests(&self) -> Vec<String> {
        self.ranges.lock().unwrap().clone()
    }
    fn shutdown(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(t) = self.thread.take() {
            t.join().unwrap(); // listener is dropped with the thread
        }
    }
}

impl Drop for TestServer {
    fn drop(&mut self) {
        self.shutdown();
    }
}

fn serve(mut sock: TcpStream, body: &[u8], log: &Mutex<Vec<String>>) -> std::io::Result<()> {
    sock.set_nonblocking(false)?;
    let mut head = Vec::new();
    let mut b = [0u8; 1];
    while !head.ends_with(b"\r\n\r\n") {
        if sock.read(&mut b)? == 0 {
            return Ok(());
        }
        head.push(b[0]);
    }
    let text = String::from_utf8_lossy(&head).to_string();
    let header = |name: &str| {
        text.lines().find_map(|l| {
            let (k, v) = l.split_once(':')?;
            k.eq_ignore_ascii_case(name).then(|| v.trim().to_string())
        })
    };
    if header("x-token").as_deref() != Some("secret") {
        return sock.write_all(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
    }
    let total = body.len();
    let range = header("range");
    log.lock().unwrap().push(range.clone().unwrap_or_default());
    let (start, end) = match range.as_deref().and_then(|r| r.strip_prefix("bytes=")) {
        Some(r) => {
            let (a, b) = r.split_once('-').unwrap();
            (a.parse::<usize>().unwrap(), b.parse::<usize>().map_or(total, |e| e + 1).min(total))
        }
        None => (0, total),
    };
    let status = if range.is_some() { "206 Partial Content" } else { "200 OK" };
    let mut resp = format!("HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n", end - start);
    if range.is_some() {
        resp += &format!("Content-Range: bytes {start}-{}/{total}\r\n", end - 1);
    }
    resp += "\r\n";
    sock.write_all(resp.as_bytes())?;
    sock.write_all(&body[start..end])
}

pub(crate) fn body(n: usize) -> Vec<u8> {
    (0..n).map(|i| (i.wrapping_mul(31) ^ (i >> 8)) as u8).collect()
}

pub(crate) fn hdrs() -> Vec<(String, String)> {
    vec![("X-Token".into(), "secret".into())]
}

fn read_n(s: &mut HttpSource, n: usize) -> Vec<u8> {
    let mut out = vec![0u8; n];
    let mut got = 0;
    while got < n {
        let k = s.read(&mut out[got..(got + 16 * 1024).min(n)]).unwrap();
        assert!(k > 0, "unexpected EOF at {got}");
        got += k;
    }
    out
}

#[test]
fn http_sequential_read_sends_headers_and_caches() {
    let data = body(300_000);
    let srv = TestServer::start(data.clone());
    let cache = tmp("http-seq");
    let mut s = HttpSource::open(&srv.url(), &hdrs(), &cache, "track/1").unwrap();
    use symphonia::core::io::MediaSource;
    assert_eq!(s.byte_len(), Some(300_000));
    let mut all = Vec::new();
    s.read_to_end(&mut all).unwrap();
    assert_eq!(all, data);
    assert_eq!(srv.requests().len(), 1);
    // Without the header the server refuses.
    assert!(HttpSource::open(&srv.url(), &[], &tmp("http-nohdr"), "x").is_err());
}

#[test]
fn http_seek_uses_range_requests() {
    let data = body(300_000);
    let srv = TestServer::start(data.clone());
    let mut s = HttpSource::open(&srv.url(), &hdrs(), &tmp("http-seek"), "t").unwrap();
    s.seek(SeekFrom::Start(200_000)).unwrap();
    assert_eq!(read_n(&mut s, 5000), data[200_000..205_000]);
    s.seek(SeekFrom::Start(10)).unwrap();
    assert_eq!(read_n(&mut s, 3000), data[10..3010]);
    assert_eq!(s.seek(SeekFrom::End(-100)).unwrap(), 299_900);
    assert_eq!(read_n(&mut s, 100), data[299_900..]);
    let mut b = [0u8; 4];
    assert_eq!(s.read(&mut b).unwrap(), 0);
    // Re-reading cached bytes needs no new request.
    let n = srv.requests().len();
    s.seek(SeekFrom::Start(200_000)).unwrap();
    assert_eq!(read_n(&mut s, 5000), data[200_000..205_000]);
    assert_eq!(srv.requests().len(), n);
}

#[test]
fn http_resumes_from_partial_cache_fetching_only_gaps() {
    let data = body(300_000);
    let srv = TestServer::start(data.clone());
    let cache = tmp("http-partial");
    {
        let mut s = HttpSource::open(&srv.url(), &hdrs(), &cache, "t").unwrap();
        assert_eq!(read_n(&mut s, 100_000), data[..100_000]);
    }
    let first = srv.requests().len();
    let mut s = HttpSource::open(&srv.url(), &hdrs(), &cache, "t").unwrap();
    let mut all = Vec::new();
    s.read_to_end(&mut all).unwrap();
    assert_eq!(all, data);
    let reqs = srv.requests();
    assert_eq!(reqs.len(), first + 1, "{reqs:?}");
    assert_eq!(reqs.last().unwrap(), "bytes=100000-", "only the missing tail may be fetched");
}

#[test]
fn http_gap_in_the_middle_is_bounded() {
    let data = body(300_000);
    let srv = TestServer::start(data.clone());
    let cache = tmp("http-gap");
    {
        let mut s = HttpSource::open(&srv.url(), &hdrs(), &cache, "t").unwrap();
        assert_eq!(read_n(&mut s, 50_000), data[..50_000]);
        s.seek(SeekFrom::Start(150_000)).unwrap();
        assert_eq!(read_n(&mut s, 150_000), data[150_000..]);
    }
    let before = srv.requests().len();
    let mut s = HttpSource::open(&srv.url(), &hdrs(), &cache, "t").unwrap();
    let mut all = Vec::new();
    s.read_to_end(&mut all).unwrap();
    assert_eq!(all, data);
    let reqs = srv.requests();
    assert_eq!(&reqs[before..], &["bytes=50000-149999".to_string()]);
}

#[test]
fn http_fully_cached_needs_no_network() {
    let data = body(200_000);
    let mut srv = TestServer::start(data.clone());
    let url = srv.url();
    let cache = tmp("http-full");
    {
        let mut s = HttpSource::open(&url, &hdrs(), &cache, "t").unwrap();
        let mut all = Vec::new();
        s.read_to_end(&mut all).unwrap();
        assert_eq!(all, data);
    }
    srv.shutdown();
    assert!(TcpStream::connect(srv.addr).is_err(), "server should be down");
    let mut s = HttpSource::open(&url, &hdrs(), &cache, "t").unwrap();
    let mut all = Vec::new();
    s.read_to_end(&mut all).unwrap();
    assert_eq!(all, data);
    s.seek(SeekFrom::Start(77)).unwrap();
    assert_eq!(read_n(&mut s, 10), data[77..87]);
}

#[test]
fn engine_plays_http_track_then_replays_offline_from_cache() {
    let pcm = noise(2 * 30_000, 16, 5);
    let wav = wav_bytes(44100, 2, 16, &pcm);
    let mut srv = TestServer::start(wav);
    let r = rig("http-engine", 0.0);
    let url = srv.url();
    let req = |id: &str| TrackRequest {
        id: id.into(),
        entry_id: format!("e-{id}"),
        url: url.clone(),
        headers: vec![HttpHeader { name: "X-Token".into(), value: "secret".into() }],
        local_path: None,
        album_id: None,
        fallback_gain_db: None,
    };
    r.engine.send(Cmd::SetOutput(None, true)).unwrap();
    r.engine.send(Cmd::Load(req("jf-1"), true)).unwrap();
    r.until_stopped();
    assert_eq!(r.samples(), left_justified(&pcm, 16));
    srv.shutdown();
    r.sink.log.lock().unwrap().samples.clear();
    r.engine.send(Cmd::Load(req("jf-1"), true)).unwrap();
    r.until_stopped();
    assert_eq!(r.samples(), left_justified(&pcm, 16), "offline replay differs");
}

// ---- DSP integration ------------------------------------------------------------

#[test]
fn replay_gain_scales_and_is_listed() {
    let r = rig("rg", 0.0);
    let pcm = noise(2 * 6000, 16, 4);
    let path = write_wav(&r.dir, "a.wav", 44100, 16, &pcm);
    let mut cfg = super::engine::neutral_dsp();
    cfg.replay_gain = ReplayGainMode::Track;
    let mut req = local("a", &path);
    // The WAV has no tags, so the server-side gain is used.
    req.fallback_gain_db = Some(-6.0206);
    r.engine.send(Cmd::SetOutput(None, true)).unwrap();
    r.engine.send(Cmd::SetDsp(cfg)).unwrap();
    r.engine.send(Cmd::Load(req, true)).unwrap();
    let ev = r.until_stopped();
    let out = r.samples();
    assert_eq!(out.len(), pcm.len());
    for (o, p) in out.iter().zip(&pcm) {
        let want = *p as f64 * 0.5;
        assert!(((*o >> 16) as f64 - want).abs() <= 1.0, "{o} vs {want}");
    }
    let sp = path_of(&ev);
    assert!(!sp.bit_perfect);
    assert!(sp.stages.iter().any(|s| s.starts_with("ReplayGain")), "{:?}", sp.stages);
}

#[test]
fn neutral_config_with_dither_not_needed_stays_exact() {
    let r = rig("dither-exact", 0.0);
    let pcm = noise(2 * 6000, 16, 8);
    let path = write_wav(&r.dir, "a.wav", 44100, 16, &pcm);
    let mut cfg = super::engine::neutral_dsp();
    cfg.dither = DitherMode::Tpdf;
    cfg.crossfade_ms = 50;
    r.engine.send(Cmd::SetOutput(None, true)).unwrap();
    r.engine.send(Cmd::SetDsp(cfg)).unwrap();
    r.engine.send(Cmd::Load(local("a", &path), true)).unwrap();
    let ev = r.until_stopped();
    assert_eq!(r.samples(), left_justified(&pcm, 16));
    assert!(path_of(&ev).bit_perfect);
}

#[test]
fn resample_to_fixed_rate_opens_device_there() {
    let r = rig("resample", 0.0);
    let frames = 30_000usize;
    let pcm = noise(2 * frames, 16, 31);
    let path = write_wav(&r.dir, "a.wav", 44100, 16, &pcm);
    let mut cfg = super::engine::neutral_dsp();
    cfg.resample_to = Some(96000);
    r.engine.send(Cmd::SetOutput(None, true)).unwrap();
    r.engine.send(Cmd::SetDsp(cfg)).unwrap();
    r.engine.send(Cmd::Load(local("a", &path), true)).unwrap();
    let ev = r.until_stopped();
    let n = r.samples().len() / 2;
    let want = frames as f64 * 96000.0 / 44100.0;
    assert!((n as f64 - want).abs() <= 4.0, "{n} frames, expected about {want}");
    assert_eq!(
        r.sink.log.lock().unwrap().opens,
        vec![Format { rate: 96000, channels: 2, bits: 16 }]
    );
    let sp = path_of(&ev);
    assert_eq!((sp.source_sample_rate, sp.output_sample_rate), (44100, 96000));
    assert!(!sp.bit_perfect);
    assert!(sp.stages.iter().any(|s| s.starts_with("Resample")), "{:?}", sp.stages);
}

#[test]
fn unsupported_source_rate_uses_nearest_device_rate() {
    let r = rig("nearest", 0.0);
    let path = write_wav(&r.dir, "a.wav", 32000, 16, &noise(2 * 8000, 16, 2));
    r.engine.send(Cmd::SetOutput(None, true)).unwrap();
    r.engine.send(Cmd::Load(local("a", &path), true)).unwrap();
    r.until_stopped();
    assert_eq!(r.sink.log.lock().unwrap().opens[0].rate, 44100);
}

#[test]
fn fixed_output_rate_keeps_different_source_rates_gapless() {
    let r = rig("resample-gapless", 0.0);
    let pa = write_wav(&r.dir, "a.wav", 44100, 16, &noise(2 * 20_000, 16, 41));
    let pb = write_wav(&r.dir, "b.wav", 48000, 16, &noise(2 * 20_000, 16, 42));
    let mut cfg = super::engine::neutral_dsp();
    cfg.resample_to = Some(96000);
    r.engine.send(Cmd::SetOutput(None, true)).unwrap();
    r.engine.send(Cmd::SetDsp(cfg)).unwrap();
    r.engine.send(Cmd::Load(local("a", &pa), true)).unwrap();
    r.engine.send(Cmd::SetNext(Some(local("b", &pb)))).unwrap();
    let ev = r.until_stopped();
    let log = r.sink.log.lock().unwrap();
    assert_eq!(log.opens.len(), 1, "device reopened: {:?}", log.opens);
    let n = log.samples.len() as f64 / 2.0;
    let want = 20_000.0 * 96000.0 / 44100.0 + 20_000.0 * 2.0;
    assert!((n - want).abs() <= 8.0, "{n} frames, expected about {want}");
    let started: Vec<_> = ev
        .iter()
        .filter(|e| e.kind == EventKind::TrackStarted)
        .map(|e| e.track_id.clone().unwrap())
        .collect();
    assert_eq!(started, vec!["a", "b"]);
}

fn two_tracks(r: &Rig, a_album: Option<&str>, b_album: Option<&str>, ms: u32) -> (Vec<i32>, Vec<i32>) {
    let a = noise(2 * 30_000, 16, 51);
    let b = noise(2 * 25_000, 16, 52);
    let pa = write_wav(&r.dir, "a.wav", 44100, 16, &a);
    let pb = write_wav(&r.dir, "b.wav", 44100, 16, &b);
    let mut cfg = super::engine::neutral_dsp();
    cfg.crossfade_ms = ms;
    r.engine.send(Cmd::SetOutput(None, true)).unwrap();
    r.engine.send(Cmd::SetDsp(cfg)).unwrap();
    let mut ta = local("a", &pa);
    ta.album_id = a_album.map(Into::into);
    let mut tb = local("b", &pb);
    tb.album_id = b_album.map(Into::into);
    r.engine.send(Cmd::Load(ta, true)).unwrap();
    r.engine.send(Cmd::SetNext(Some(tb))).unwrap();
    (left_justified(&a, 16), left_justified(&b, 16))
}

#[test]
fn crossfade_between_albums_overlaps_tracks() {
    let r = rig("xfade", 0.0);
    let (a, b) = two_tracks(&r, Some("A"), Some("B"), 100);
    let ev = r.until_stopped();
    let out = r.samples();
    let n = 4410; // 100 ms at 44.1 kHz
    assert_eq!(out.len(), a.len() + b.len() - 2 * n, "total length");
    // Outside the overlap both tracks are untouched.
    let pre = a.len() - 2 * n;
    assert_eq!(out[..pre], a[..pre]);
    assert_eq!(out[pre + 2 * n..], b[2 * n..]);
    // Inside it the signal is a mix, not either track.
    assert_ne!(out[pre..pre + 2 * n], a[pre..]);
    assert_ne!(out[pre..pre + 2 * n], b[..2 * n]);
    assert_eq!(r.sink.log.lock().unwrap().opens.len(), 1);
    let started: Vec<_> = ev
        .iter()
        .filter(|e| e.kind == EventKind::TrackStarted)
        .map(|e| e.track_id.clone().unwrap())
        .collect();
    assert_eq!(started, vec!["a", "b"]);
}

#[test]
fn crossfade_with_unknown_album_still_mixes() {
    let r = rig("xfade-none", 0.0);
    let (a, b) = two_tracks(&r, None, None, 100);
    r.until_stopped();
    assert_eq!(r.samples().len(), a.len() + b.len() - 2 * 4410);
}

#[test]
fn same_album_crossfade_stays_gapless_and_exact() {
    let r = rig("xfade-same", 0.0);
    let (a, b) = two_tracks(&r, Some("A"), Some("A"), 100);
    r.until_stopped();
    let mut want = a;
    want.extend(b);
    assert_eq!(r.samples(), want);
}

#[test]
fn crossfade_with_different_formats_falls_back_to_reopen() {
    let r = rig("xfade-fmt", 0.0);
    let a = noise(2 * 20_000, 16, 61);
    let b = noise(2 * 20_000, 24, 62);
    let pa = write_wav(&r.dir, "a.wav", 44100, 16, &a);
    let pb = write_wav(&r.dir, "b.wav", 96000, 24, &b);
    let mut cfg = super::engine::neutral_dsp();
    cfg.crossfade_ms = 100;
    r.engine.send(Cmd::SetOutput(None, true)).unwrap();
    r.engine.send(Cmd::SetDsp(cfg)).unwrap();
    r.engine.send(Cmd::Load(local("a", &pa), true)).unwrap();
    r.engine.send(Cmd::SetNext(Some(local("b", &pb)))).unwrap();
    r.until_stopped();
    let mut want = left_justified(&a, 16);
    want.extend(left_justified(&b, 24));
    assert_eq!(r.samples(), want);
    assert_eq!(r.sink.log.lock().unwrap().opens.len(), 2);
}

#[test]
fn entry_ids_distinguish_the_same_track_queued_twice() {
    let r = rig("entry", 0.0);
    let path = write_wav(&r.dir, "a.wav", 44100, 16, &noise(2 * 6000, 16, 71));
    let mk = |e: &str| {
        let mut t = local("same", &path);
        t.entry_id = e.into();
        t
    };
    r.engine.send(Cmd::SetOutput(None, true)).unwrap();
    r.engine.send(Cmd::Load(mk("e1"), true)).unwrap();
    r.engine.send(Cmd::SetNext(Some(mk("e2")))).unwrap();
    let ev = r.until_stopped();
    let seq: Vec<_> = ev
        .iter()
        .filter(|e| matches!(e.kind, EventKind::TrackStarted | EventKind::TrackEnded))
        .map(|e| (e.kind, e.entry_id.clone().unwrap()))
        .collect();
    assert_eq!(
        seq,
        vec![
            (EventKind::TrackStarted, "e1".to_string()),
            (EventKind::TrackEnded, "e1".to_string()),
            (EventKind::TrackStarted, "e2".to_string()),
            (EventKind::TrackEnded, "e2".to_string()),
        ]
    );
    assert!(ev.iter().filter(|e| e.kind == EventKind::Position).all(|e| e.entry_id.is_some()));
}

#[test]
fn error_event_carries_entry_id() {
    let r = rig("entry-err", 0.0);
    r.engine.send(Cmd::Load(local("x", "/nonexistent/file.flac"), true)).unwrap();
    let ev = r.until("Error", |e| e.kind == EventKind::Error);
    assert_eq!(ev.last().unwrap().entry_id.as_deref(), Some("e-x"));
}

#[test]
fn set_dsp_while_playing_rebuilds_chain() {
    let r = rig("setdsp", 4.0);
    let frames = 44100 * 3;
    let path = write_wav(&r.dir, "a.wav", 44100, 16, &ramp(frames));
    r.engine.send(Cmd::SetOutput(None, true)).unwrap();
    r.engine.send(Cmd::Load(local("a", &path), true)).unwrap();
    r.until("TrackStarted", |e| e.kind == EventKind::TrackStarted);
    let mut cfg = super::engine::neutral_dsp();
    cfg.volume = 0.5;
    r.engine.send(Cmd::SetDsp(cfg)).unwrap();
    let ev = r.until_stopped();
    assert!(ev.iter().any(|e| e.signal_path.as_ref().is_some_and(|p| !p.bit_perfect
        && p.stages.iter().any(|s| s.starts_with("Volume")))));
    let left: Vec<i32> = r.samples().iter().step_by(2).map(|s| s >> 16).collect();
    // The tail of the ramp is at half level.
    let last = (frames - 1) % 20000;
    assert_eq!(*left.last().unwrap(), ((last as f64) * 0.5).round() as i32);
}

// ---- DSD ------------------------------------------------------------------------

use crate::decode::dsd::fixtures::{build_dsf, noise_bytes, sigma_delta2};
use crate::decode::dsd::{dop_word, DSD64_RATE};

fn write_dsf(dir: &PathBuf, name: &str, chans: &[Vec<u8>]) -> String {
    let p = dir.join(name);
    std::fs::write(&p, build_dsf(DSD64_RATE, chans, true, 4096, None)).unwrap();
    p.to_string_lossy().into_owned()
}

/// What the DoP path must produce for stereo `chans` (even byte count).
fn expected_dop(chans: &[Vec<u8>], first_marker: usize) -> Vec<i32> {
    let mut v = Vec::new();
    for i in 0..chans[0].len() / 2 {
        for c in chans {
            v.push(dop_word([0x05, 0xFA][(i + first_marker) % 2], c[2 * i], c[2 * i + 1]));
        }
    }
    v
}

fn assert_markers_alternate(out: &[i32]) {
    for (i, f) in out.chunks(2).enumerate() {
        for s in f {
            assert_eq!((*s as u32 >> 24) as u8, [0x05, 0xFA][i % 2], "marker broken at frame {i}");
        }
    }
}

#[test]
fn dsd_dop_is_byte_exact_and_bit_perfect() {
    let r = rig("dop", 0.0);
    let chans = vec![noise_bytes(20_000, 21), noise_bytes(20_000, 22)];
    let path = write_dsf(&r.dir, "a.dsf", &chans);
    r.engine.send(Cmd::SetOutput(None, true)).unwrap();
    r.engine.send(Cmd::Load(local("a", &path), true)).unwrap();
    let ev = r.until_stopped();
    assert_eq!(r.samples(), expected_dop(&chans, 0));
    assert_eq!(
        r.sink.log.lock().unwrap().opens,
        vec![Format { rate: 176400, channels: 2, bits: 24 }]
    );
    let sp = path_of(&ev);
    assert_eq!(sp.codec, "DSD64");
    assert_eq!((sp.source_sample_rate, sp.source_bit_depth, sp.channels), (2_822_400, 1, 2));
    assert_eq!((sp.output_sample_rate, sp.output_bit_depth), (176400, 24));
    assert!(sp.exclusive && sp.bit_perfect, "{sp:?}");
    assert_eq!(sp.stages, vec!["DoP".to_string()]);
}

#[test]
fn dsd_dop_gapless_keeps_marker_alternation() {
    let r = rig("dopgapless", 0.0);
    // The second track has an odd number of DoP frames; padding keeps phase.
    let a = vec![noise_bytes(8_192, 31), noise_bytes(8_192, 32)];
    let b = vec![noise_bytes(6_002, 33), noise_bytes(6_002, 34)];
    let (pa, pb) = (write_dsf(&r.dir, "a.dsf", &a), write_dsf(&r.dir, "b.dsf", &b));
    r.engine.send(Cmd::SetOutput(None, true)).unwrap();
    r.engine.send(Cmd::Load(local("a", &pa), true)).unwrap();
    r.engine.send(Cmd::SetNext(Some(local("b", &pb)))).unwrap();
    r.until_stopped();
    let mut want = expected_dop(&a, 0);
    want.extend(expected_dop(&b, 0));
    // 6002 bytes = 3001 frames: one idle frame completes the pair.
    want.extend([dop_word(0xFA, 0x69, 0x69); 2]);
    let out = r.samples();
    assert_eq!(out, want);
    assert_markers_alternate(&out);
    assert_eq!(r.sink.log.lock().unwrap().opens.len(), 1, "device reopened between DoP tracks");
}

#[test]
fn dsd_dop_pause_seek_never_scale_samples() {
    let r = rig("dopseek", 4.0);
    let chans = vec![noise_bytes(441_000, 41), noise_bytes(441_000, 42)]; // 1.25 s
    let path = write_dsf(&r.dir, "a.dsf", &chans);
    r.engine.send(Cmd::SetOutput(None, true)).unwrap();
    r.engine.send(Cmd::Load(local("a", &path), true)).unwrap();
    r.until("TrackStarted", |e| e.kind == EventKind::TrackStarted);
    r.engine.send(Cmd::Pause).unwrap();
    r.until("Paused", |e| e.kind == EventKind::StateChanged && e.state == PlaybackState::Paused);
    r.engine.send(Cmd::Seek(500)).unwrap();
    r.engine.send(Cmd::Play).unwrap();
    r.until_stopped();
    let out = r.samples();
    // Every written word is an unmodified DoP word: marker byte valid, low byte
    // of the 32-bit container zero, and the payload equals source data.
    let all: std::collections::HashSet<(u8, u8)> = chans[0]
        .chunks(2)
        .map(|p| (p[0], p[1]))
        .collect();
    for f in out.chunks(2) {
        let w = f[0] as u32;
        assert!(matches!((w >> 24) as u8, 0x05 | 0xFA), "scaled sample {w:08x}");
        assert_eq!(w & 0xFF, 0);
        assert!(all.contains(&(((w >> 16) & 0xFF) as u8, ((w >> 8) & 0xFF) as u8)));
    }
    // The seek target (500 ms = 176400 bytes = 88200 frames) is in the output.
    let want = expected_dop(&[chans[0][176_400..].to_vec(), chans[1][176_400..].to_vec()], 0);
    assert_eq!(&out[out.len() - want.len()..], &want[..]);
}

fn pcm_fallback_case(name: &str, exclusive: bool, tweak: impl Fn(&mut DspConfig)) {
    let r = rig(name, 0.0);
    let chans = vec![noise_bytes(8_000, 51), noise_bytes(8_000, 52)];
    let path = write_dsf(&r.dir, "a.dsf", &chans);
    let mut cfg = super::engine::neutral_dsp();
    tweak(&mut cfg);
    r.engine.send(Cmd::SetOutput(None, exclusive)).unwrap();
    r.engine.send(Cmd::SetDsp(cfg)).unwrap();
    r.engine.send(Cmd::Load(local("a", &path), true)).unwrap();
    let ev = r.until_stopped();
    let sp = path_of(&ev);
    assert_eq!(sp.codec, "DSD64");
    assert_eq!((sp.source_sample_rate, sp.source_bit_depth), (2_822_400, 1));
    assert!(!sp.bit_perfect, "{sp:?}");
    assert_eq!(sp.stages.first().map(String::as_str), Some("DSD\u{2192}PCM 352.8 kHz"), "{sp:?}");
    // Shared: one PCM frame per input byte at 352.8 kHz. Exclusive on the test
    // sink (max 192 kHz): the chain resamples to the nearest device rate.
    let rate = r.sink.log.lock().unwrap().opens[0].rate;
    if exclusive {
        assert_eq!(rate, 192000);
        assert!(sp.stages.iter().any(|s| s.contains("esampl")), "{sp:?}");
    } else {
        assert_eq!(rate, 352800);
        assert_eq!(r.samples().len(), 2 * 8_000);
    }
}

#[test]
fn dsd_falls_back_to_pcm_when_not_exclusive() {
    pcm_fallback_case("dsdshared", false, |_| {});
}

#[test]
fn dsd_falls_back_to_pcm_when_dsp_active() {
    pcm_fallback_case("dsdvol", true, |c| c.volume = 0.5);
}

#[test]
fn dsd_pcm_mode_never_uses_dop() {
    pcm_fallback_case("dsdpcm", true, |c| c.dsd = DsdMode::Pcm);
}

#[test]
fn dsd_pcm_level_through_engine_is_minus_6_dbfs_for_half_modulation() {
    let r = rig("dsdlevel", 0.0);
    let x: Vec<f64> = (0..DSD64_RATE as usize / 5)
        .map(|i| 0.5 * (2.0 * std::f64::consts::PI * 1000.0 * i as f64 / DSD64_RATE as f64).sin())
        .collect();
    let b = sigma_delta2(&x);
    let path = write_dsf(&r.dir, "s.dsf", &[b.clone(), b.clone()]);
    let mut cfg = super::engine::neutral_dsp();
    cfg.dsd = DsdMode::Pcm;
    r.engine.send(Cmd::SetOutput(None, true)).unwrap();
    r.engine.send(Cmd::SetDsp(cfg)).unwrap();
    r.engine.send(Cmd::Load(local("s", &path), true)).unwrap();
    r.until_stopped();
    let out = r.samples();
    let peak = out
        .chunks(2)
        .skip(2000)
        .take(20_000)
        .map(|f| (f[0] as f64 / 2147483648.0).abs())
        .fold(0.0, f64::max);
    assert!((0.48..0.53).contains(&peak), "peak {peak}");
}

#[test]
fn dsd_set_dsp_mid_track_reopens_as_pcm() {
    let r = rig("dsdswitch", 4.0);
    let chans = vec![noise_bytes(441_000, 61), noise_bytes(441_000, 62)];
    let path = write_dsf(&r.dir, "a.dsf", &chans);
    r.engine.send(Cmd::SetOutput(None, true)).unwrap();
    r.engine.send(Cmd::Load(local("a", &path), true)).unwrap();
    r.until("TrackStarted", |e| e.kind == EventKind::TrackStarted);
    let mut cfg = super::engine::neutral_dsp();
    cfg.volume = 0.5;
    r.engine.send(Cmd::SetDsp(cfg)).unwrap();
    let ev = r.until_stopped();
    let sp = path_of(&ev);
    assert!(!sp.bit_perfect);
    assert_eq!(sp.stages[0], "DSD\u{2192}PCM 352.8 kHz");
    assert_eq!(r.sink.log.lock().unwrap().opens.last().unwrap().rate, 192000);
}
