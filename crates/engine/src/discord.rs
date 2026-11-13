//! Discord Rich Presence over the local Discord IPC socket / named pipe.
//!
//! `set_activity` only records the latest desired state and wakes a worker
//! thread; the worker owns the connection, connects lazily, reconnects when
//! Discord (re)starts, and coalesces updates under Discord's rate limit.

use crate::api::engine::DiscordActivity;
use anyhow::Result;
use std::io::{self, Read, Write};
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

const OP_HANDSHAKE: u32 = 0;
const OP_FRAME: u32 = 1;
const OP_CLOSE: u32 = 2;
const OP_PING: u32 = 3;
const OP_PONG: u32 = 4;
const MAX_FRAME: usize = 1 << 20;

// ---------------------------------------------------------------- JSON ----

fn json_str(s: &str) -> String {
    let mut o = String::with_capacity(s.len() + 2);
    o.push('"');
    for c in s.chars() {
        match c {
            '"' => o.push_str("\\\""),
            '\\' => o.push_str("\\\\"),
            '\n' => o.push_str("\\n"),
            '\r' => o.push_str("\\r"),
            '\t' => o.push_str("\\t"),
            c if (c as u32) < 0x20 => o.push_str(&format!("\\u{:04x}", c as u32)),
            c => o.push(c),
        }
    }
    o.push('"');
    o
}

/// Discord requires 2..=128 characters and rejects empty strings.
fn clean_text(s: &str) -> Option<String> {
    let t = s.trim();
    let n = t.chars().count();
    if n == 0 {
        None
    } else if n == 1 {
        Some(format!("{t}\u{2800}"))
    } else if n > 128 {
        let mut o: String = t.chars().take(127).collect();
        o.push('\u{2026}');
        Some(o)
    } else {
        Some(t.to_string())
    }
}

fn clean_opt(s: &Option<String>) -> Option<String> {
    s.as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// Render the `activity` JSON object.
pub(crate) fn render_activity(a: &DiscordActivity) -> String {
    let mut f: Vec<String> = Vec::new();
    f.push("\"type\":2".into());
    if let Some(d) = clean_text(&a.details) {
        f.push(format!("\"details\":{}", json_str(&d)));
    }
    if let Some(s) = clean_text(&a.state) {
        f.push(format!("\"state\":{}", json_str(&s)));
    }
    let mut ts = Vec::new();
    if let Some(s) = a.start_timestamp_ms.filter(|v| *v > 0) {
        ts.push(format!("\"start\":{s}"));
    }
    if let Some(e) = a.end_timestamp_ms.filter(|v| *v > 0) {
        ts.push(format!("\"end\":{e}"));
    }
    if !ts.is_empty() {
        f.push(format!("\"timestamps\":{{{}}}", ts.join(",")));
    }
    let mut assets = Vec::new();
    if let Some(v) = clean_opt(&a.large_image) {
        assets.push(format!("\"large_image\":{}", json_str(&v)));
    }
    if let Some(v) = a.large_text.as_deref().and_then(clean_text) {
        assets.push(format!("\"large_text\":{}", json_str(&v)));
    }
    if let Some(v) = clean_opt(&a.small_image) {
        assets.push(format!("\"small_image\":{}", json_str(&v)));
    }
    if let Some(v) = a.small_text.as_deref().and_then(clean_text) {
        assets.push(format!("\"small_text\":{}", json_str(&v)));
    }
    if !assets.is_empty() {
        f.push(format!("\"assets\":{{{}}}", assets.join(",")));
    }
    let buttons: Vec<String> = a
        .buttons
        .iter()
        .filter_map(|b| {
            let label: String = b.label.trim().chars().take(32).collect();
            let url = b.url.trim();
            if label.is_empty() || url.is_empty() || url.len() > 512 {
                return None;
            }
            Some(format!(
                "{{\"label\":{},\"url\":{}}}",
                json_str(&label),
                json_str(url)
            ))
        })
        .take(2)
        .collect();
    if !buttons.is_empty() {
        f.push(format!("\"buttons\":[{}]", buttons.join(",")));
    }
    format!("{{{}}}", f.join(","))
}

fn handshake_json(app_id: &str) -> String {
    format!("{{\"v\":1,\"client_id\":{}}}", json_str(app_id))
}

fn set_activity_json(activity: Option<&str>, nonce: &str) -> String {
    format!(
        "{{\"cmd\":\"SET_ACTIVITY\",\"args\":{{\"pid\":{},\"activity\":{}}},\"nonce\":{}}}",
        std::process::id(),
        activity.unwrap_or("null"),
        json_str(nonce)
    )
}

// ------------------------------------------------------------- framing ----

fn write_frame(w: &mut dyn Write, op: u32, body: &str) -> io::Result<()> {
    let mut buf = Vec::with_capacity(8 + body.len());
    buf.extend_from_slice(&op.to_le_bytes());
    buf.extend_from_slice(&(body.len() as u32).to_le_bytes());
    buf.extend_from_slice(body.as_bytes());
    w.write_all(&buf)?;
    w.flush()
}

fn read_frame(r: &mut dyn Read) -> io::Result<(u32, String)> {
    let mut h = [0u8; 8];
    r.read_exact(&mut h)?;
    let op = u32::from_le_bytes([h[0], h[1], h[2], h[3]]);
    let len = u32::from_le_bytes([h[4], h[5], h[6], h[7]]) as usize;
    if len > MAX_FRAME {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "oversized frame",
        ));
    }
    let mut b = vec![0u8; len];
    r.read_exact(&mut b)?;
    Ok((op, String::from_utf8_lossy(&b).into_owned()))
}

// ----------------------------------------------------------- transport ----

pub(crate) trait Conn: Read + Write + Send {
    fn set_timeout(&mut self, _d: Duration) {}
}

pub(crate) trait Transport: Send + Sync + 'static {
    fn connect(&self) -> io::Result<Box<dyn Conn>>;
}

#[cfg(unix)]
impl Conn for std::os::unix::net::UnixStream {
    fn set_timeout(&mut self, d: Duration) {
        let _ = self.set_read_timeout(Some(d));
        let _ = self.set_write_timeout(Some(d));
    }
}

#[cfg(unix)]
pub(crate) struct UnixTransport {
    dirs: Vec<std::path::PathBuf>,
}

#[cfg(unix)]
impl UnixTransport {
    pub(crate) fn from_env() -> Self {
        let mut bases = Vec::new();
        for k in ["XDG_RUNTIME_DIR", "TMPDIR", "TMP", "TEMP"] {
            if let Some(v) = std::env::var_os(k).filter(|v| !v.is_empty()) {
                bases.push(std::path::PathBuf::from(v));
            }
        }
        bases.push("/tmp".into());
        let mut dirs = Vec::new();
        for b in bases {
            for sub in ["", "app/com.discordapp.Discord", "snap.discord"] {
                let d = if sub.is_empty() {
                    b.clone()
                } else {
                    b.join(sub)
                };
                if !dirs.contains(&d) {
                    dirs.push(d);
                }
            }
        }
        Self { dirs }
    }

    #[cfg(test)]
    pub(crate) fn with_dirs(dirs: Vec<std::path::PathBuf>) -> Self {
        Self { dirs }
    }
}

#[cfg(unix)]
impl Transport for UnixTransport {
    fn connect(&self) -> io::Result<Box<dyn Conn>> {
        let mut last = io::Error::new(io::ErrorKind::NotFound, "discord ipc not found");
        for d in &self.dirs {
            for i in 0..10 {
                match std::os::unix::net::UnixStream::connect(d.join(format!("discord-ipc-{i}"))) {
                    Ok(s) => return Ok(Box::new(s)),
                    Err(e) => last = e,
                }
            }
        }
        Err(last)
    }
}

#[cfg(windows)]
impl Conn for std::fs::File {}

#[cfg(windows)]
pub(crate) struct PipeTransport;

#[cfg(windows)]
impl Transport for PipeTransport {
    fn connect(&self) -> io::Result<Box<dyn Conn>> {
        let mut last = io::Error::new(io::ErrorKind::NotFound, "discord ipc not found");
        for i in 0..10 {
            match std::fs::OpenOptions::new()
                .read(true)
                .write(true)
                .open(format!(r"\\.\pipe\discord-ipc-{i}"))
            {
                Ok(f) => return Ok(Box::new(f)),
                Err(e) => last = e,
            }
        }
        Err(last)
    }
}

fn default_transport() -> Box<dyn Transport> {
    #[cfg(unix)]
    {
        Box::new(UnixTransport::from_env())
    }
    #[cfg(windows)]
    {
        Box::new(PipeTransport)
    }
    #[cfg(not(any(unix, windows)))]
    {
        struct None_;
        impl Transport for None_ {
            fn connect(&self) -> io::Result<Box<dyn Conn>> {
                Err(io::Error::new(io::ErrorKind::Unsupported, "no discord ipc"))
            }
        }
        Box::new(None_)
    }
}

// -------------------------------------------------------------- worker ----

#[derive(Clone, PartialEq)]
struct Desired {
    app_id: String,
    /// Rendered activity JSON; `None` clears.
    activity: Option<String>,
}

struct State {
    desired: Option<Desired>,
    shutdown: bool,
}

struct Shared {
    st: Mutex<State>,
    cv: Condvar,
}

pub(crate) struct Config {
    /// Minimum spacing between SET_ACTIVITY sends (Discord: ~5 per 20 s).
    pub min_interval: Duration,
    /// Delay before retrying when Discord is absent / handshake fails.
    pub retry_interval: Duration,
    pub io_timeout: Duration,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            min_interval: Duration::from_secs(4),
            retry_interval: Duration::from_secs(15),
            io_timeout: Duration::from_secs(5),
        }
    }
}

pub(crate) struct Worker {
    shared: Arc<Shared>,
}

impl Worker {
    pub(crate) fn new(transport: Box<dyn Transport>, cfg: Config) -> Self {
        let shared = Arc::new(Shared {
            st: Mutex::new(State {
                desired: None,
                shutdown: false,
            }),
            cv: Condvar::new(),
        });
        let s = shared.clone();
        let _ = thread::Builder::new()
            .name("rayla-discord".into())
            .spawn(move || run(s, transport, cfg));
        Self { shared }
    }

    fn set(&self, app_id: String, activity: Option<String>) {
        let mut st = self.shared.st.lock().unwrap_or_else(|e| e.into_inner());
        st.desired = Some(Desired { app_id, activity });
        self.shared.cv.notify_all();
    }
}

impl Drop for Worker {
    fn drop(&mut self) {
        let mut st = self.shared.st.lock().unwrap_or_else(|e| e.into_inner());
        st.shutdown = true;
        self.shared.cv.notify_all();
    }
}

struct Live {
    conn: Box<dyn Conn>,
    app_id: String,
}

fn nonce() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static N: AtomicU64 = AtomicU64::new(0);
    let n = N.fetch_add(1, Ordering::Relaxed);
    let t = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{t:x}-{n:x}")
}

/// Read until a non-ping frame arrives; answer pings. Err on close/EOF/timeout.
fn read_reply(c: &mut dyn Conn) -> io::Result<String> {
    loop {
        let (op, body) = read_frame(c)?;
        match op {
            OP_PING => write_frame(c, OP_PONG, &body)?,
            OP_CLOSE => return Err(io::Error::new(io::ErrorKind::ConnectionAborted, body)),
            OP_PONG => {}
            _ => return Ok(body),
        }
    }
}

fn open(transport: &dyn Transport, app_id: &str, cfg: &Config) -> io::Result<Live> {
    let mut conn = transport.connect()?;
    conn.set_timeout(cfg.io_timeout);
    write_frame(&mut *conn, OP_HANDSHAKE, &handshake_json(app_id))?;
    loop {
        let body = read_reply(&mut *conn)?;
        if body.contains("\"READY\"") {
            return Ok(Live {
                conn,
                app_id: app_id.to_string(),
            });
        }
        if body.contains("\"evt\":\"ERROR\"") {
            return Err(io::Error::new(io::ErrorKind::PermissionDenied, body));
        }
    }
}

fn send_activity(l: &mut Live, activity: Option<&str>) -> io::Result<()> {
    write_frame(
        &mut *l.conn,
        OP_FRAME,
        &set_activity_json(activity, &nonce()),
    )?;
    // Discord answers every command; an ERROR reply is non-fatal.
    let _ = read_reply(&mut *l.conn)?;
    Ok(())
}

fn close(l: Live) {
    let mut c = l.conn;
    let _ = write_frame(&mut *c, OP_CLOSE, "{}");
}

fn run(shared: Arc<Shared>, transport: Box<dyn Transport>, cfg: Config) {
    let mut live: Option<Live> = None;
    let mut sent: Option<Desired> = None; // what Discord currently shows (on `live`)
    let mut last_send: Option<Instant> = None;
    let mut next_connect = Instant::now();

    loop {
        let want = {
            let mut st = shared.st.lock().unwrap_or_else(|e| e.into_inner());
            loop {
                if st.shutdown {
                    drop(st);
                    if let Some(l) = live.take() {
                        close(l);
                    }
                    return;
                }
                let now = Instant::now();
                match &st.desired {
                    Some(d) if sent.as_ref() != Some(d) => {
                        let mut at = last_send.map_or(now, |t| t + cfg.min_interval);
                        if live.is_none() && d.activity.is_some() {
                            at = at.max(next_connect);
                        }
                        if at <= now {
                            break d.clone();
                        }
                        st = shared
                            .cv
                            .wait_timeout(st, at - now)
                            .unwrap_or_else(|e| e.into_inner())
                            .0;
                    }
                    _ => st = shared.cv.wait(st).unwrap_or_else(|e| e.into_inner()),
                }
            }
        };

        // Application changed: drop the old connection (clears its activity).
        if live.as_ref().is_some_and(|l| l.app_id != want.app_id) {
            if let Some(l) = live.take() {
                close(l);
            }
            sent = None;
        }
        // Clearing with nothing connected: nothing to do.
        if live.is_none() && want.activity.is_none() {
            sent = Some(want);
            continue;
        }
        if live.is_none() {
            match open(&*transport, &want.app_id, &cfg) {
                Ok(l) => live = Some(l),
                Err(_) => {
                    next_connect = Instant::now() + cfg.retry_interval;
                    continue;
                }
            }
        }
        let l = live.as_mut().unwrap();
        last_send = Some(Instant::now());
        match send_activity(l, want.activity.as_deref()) {
            Ok(()) => sent = Some(want),
            Err(_) => {
                // Pipe broke (Discord restarted): reconnect and resend.
                live = None;
                sent = None;
                next_connect = Instant::now();
            }
        }
    }
}

// ----------------------------------------------------------------- API ----

static WORKER: OnceLock<Worker> = OnceLock::new();

pub fn set_activity(application_id: String, activity: Option<DiscordActivity>) -> Result<()> {
    let w = WORKER.get_or_init(|| Worker::new(default_transport(), Config::default()));
    let app = application_id.trim().to_string();
    let rendered = if app.is_empty() {
        None
    } else {
        activity.as_ref().map(render_activity)
    };
    w.set(app, rendered);
    Ok(())
}

// --------------------------------------------------------------- tests ----

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use crate::api::engine::DiscordButton;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::mpsc::{channel, Receiver, Sender};

    type Msg = (usize, u32, String);

    /// In-memory duplex end (the sandbox used for development forbids AF_UNIX).
    struct Mem {
        rx: Receiver<Vec<u8>>,
        buf: Vec<u8>,
        pos: usize,
        tx: Sender<Vec<u8>>,
    }
    fn mem_pair() -> (Mem, Mem) {
        let (t1, r1) = channel();
        let (t2, r2) = channel();
        (
            Mem {
                rx: r1,
                buf: vec![],
                pos: 0,
                tx: t2,
            },
            Mem {
                rx: r2,
                buf: vec![],
                pos: 0,
                tx: t1,
            },
        )
    }
    impl Read for Mem {
        fn read(&mut self, out: &mut [u8]) -> io::Result<usize> {
            if self.pos == self.buf.len() {
                match self.rx.recv_timeout(Duration::from_secs(5)) {
                    Ok(v) => {
                        self.buf = v;
                        self.pos = 0;
                    }
                    Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => return Ok(0),
                    Err(_) => return Err(io::ErrorKind::TimedOut.into()),
                }
            }
            let n = out.len().min(self.buf.len() - self.pos);
            out[..n].copy_from_slice(&self.buf[self.pos..self.pos + n]);
            self.pos += n;
            Ok(n)
        }
    }
    impl Write for Mem {
        fn write(&mut self, b: &[u8]) -> io::Result<usize> {
            self.tx
                .send(b.to_vec())
                .map_err(|_| io::Error::from(io::ErrorKind::BrokenPipe))?;
            Ok(b.len())
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }
    impl Conn for Mem {}

    struct FakeTransport {
        up: Arc<AtomicBool>,
        accept: Sender<Mem>,
    }
    impl Transport for FakeTransport {
        fn connect(&self) -> io::Result<Box<dyn Conn>> {
            if !self.up.load(Ordering::SeqCst) {
                return Err(io::ErrorKind::NotFound.into());
            }
            let (c, s) = mem_pair();
            self.accept
                .send(s)
                .map_err(|_| io::Error::from(io::ErrorKind::NotFound))?;
            Ok(Box::new(c))
        }
    }

    struct Fake {
        transport: Option<Box<dyn Transport>>,
        rx: Receiver<Msg>,
        up: Arc<AtomicBool>,
        drop_after_activity: Arc<AtomicBool>,
    }

    /// Fake Discord: answers READY to the handshake and acks every command.
    fn serve<S: Read + Write + Send + 'static>(
        idx: usize,
        mut s: S,
        tx: Sender<Msg>,
        df: Arc<AtomicBool>,
    ) {
        thread::spawn(move || {
            while let Ok((op, body)) = read_frame(&mut s) {
                let _ = tx.send((idx, op, body));
                match op {
                    0 => {
                        let _ = write_frame(
                            &mut s,
                            1,
                            "{\"cmd\":\"DISPATCH\",\"evt\":\"READY\",\"data\":{}}",
                        );
                    }
                    1 => {
                        let _ = write_frame(&mut s, 1, "{\"cmd\":\"SET_ACTIVITY\",\"evt\":null}");
                        if df.swap(false, Ordering::SeqCst) {
                            return; // drop the connection
                        }
                    }
                    _ => {}
                }
            }
        });
    }

    fn fake() -> Fake {
        let (tx, rx) = channel::<Msg>();
        let (acc_tx, acc_rx) = channel::<Mem>();
        let up = Arc::new(AtomicBool::new(true));
        let df = Arc::new(AtomicBool::new(false));
        let dfc = df.clone();
        thread::spawn(move || {
            for (idx, s) in acc_rx.into_iter().enumerate() {
                serve(idx, s, tx.clone(), dfc.clone());
            }
        });
        Fake {
            transport: Some(Box::new(FakeTransport {
                up: up.clone(),
                accept: acc_tx,
            })),
            rx,
            up,
            drop_after_activity: df,
        }
    }

    fn worker(f: &mut Fake, min_ms: u64) -> Worker {
        Worker::new(
            f.transport.take().unwrap(),
            Config {
                min_interval: Duration::from_millis(min_ms),
                retry_interval: Duration::from_millis(50),
                io_timeout: Duration::from_secs(2),
            },
        )
    }

    /// Real Unix-socket transport against a listener (skipped where the
    /// environment forbids creating sockets).
    #[test]
    fn unix_socket_transport_end_to_end() {
        let dir = std::env::temp_dir().join(format!("rayla-dc-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let Ok(l) = std::os::unix::net::UnixListener::bind(dir.join("discord-ipc-3")) else {
            eprintln!("skipped: cannot bind unix socket here");
            return;
        };
        let (tx, rx) = channel::<Msg>();
        let df = Arc::new(AtomicBool::new(false));
        thread::spawn(move || {
            if let Ok((s, _)) = l.accept() {
                serve(0, s, tx, df);
            }
        });
        let w = Worker::new(
            Box::new(UnixTransport::with_dirs(vec![dir.clone()])),
            Config::default(),
        );
        w.set("42".into(), Some(render_activity(&act("Unix"))));
        let t = Duration::from_secs(3);
        let (_, op, h) = rx.recv_timeout(t).unwrap();
        assert!(op == 0 && h.contains("\"42\""));
        let (_, op, b) = rx.recv_timeout(t).unwrap();
        assert!(op == 1 && b.contains("Unix"));
        drop(w);
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn recv(f: &Fake) -> Msg {
        f.rx.recv_timeout(Duration::from_secs(3))
            .expect("no frame from client")
    }

    fn act(details: &str) -> DiscordActivity {
        DiscordActivity {
            details: details.into(),
            state: "".into(),
            large_image: None,
            large_text: None,
            small_image: None,
            small_text: None,
            start_timestamp_ms: None,
            end_timestamp_ms: None,
            buttons: vec![],
        }
    }

    #[test]
    fn handshake_and_activity_shape() {
        let mut f = fake();
        let w = worker(&mut f, 10);
        let mut a = act("Song Title");
        a.state = "Artist".into();
        a.large_image = Some("https://x/y.jpg".into());
        a.large_text = Some("Album".into());
        a.small_image = Some("".into());
        a.start_timestamp_ms = Some(1_700_000_000_000);
        a.end_timestamp_ms = Some(1_700_000_200_000);
        a.buttons = (0..3)
            .map(|i| DiscordButton {
                label: format!("b{i}"),
                url: format!("https://e/{i}"),
            })
            .collect();
        w.set("123456".into(), Some(render_activity(&a)));

        let (_, op, body) = recv(&f);
        assert_eq!(
            (op, body.as_str()),
            (0, "{\"v\":1,\"client_id\":\"123456\"}")
        );
        let (_, op, body) = recv(&f);
        assert_eq!(op, 1);
        assert!(body.starts_with("{\"cmd\":\"SET_ACTIVITY\",\"args\":{\"pid\":"));
        assert!(body.contains("\"nonce\":\""));
        assert!(body.contains("\"type\":2"));
        assert!(body.contains("\"details\":\"Song Title\""));
        assert!(body.contains("\"state\":\"Artist\""));
        assert!(body.contains("\"timestamps\":{\"start\":1700000000000,\"end\":1700000200000}"));
        assert!(body.contains("\"large_image\":\"https://x/y.jpg\""));
        assert!(body.contains("\"large_text\":\"Album\""));
        assert!(!body.contains("small_image"));
        assert!(body.contains("{\"label\":\"b1\",\"url\":\"https://e/1\"}"));
        // Not just "b2": the random hex nonce can contain that by chance.
        assert!(!body.contains("\"label\":\"b2\""));
    }

    #[test]
    fn render_omits_empty_and_fixes_lengths() {
        let mut a = act("x");
        a.state = "y".repeat(300);
        let j = render_activity(&a);
        assert!(!j.contains("timestamps") && !j.contains("assets") && !j.contains("buttons"));
        assert!(j.contains("\"details\":\"x\u{2800}\""));
        assert!(j.contains(&format!("\"state\":\"{}\u{2026}\"", "y".repeat(127))));
        let j = render_activity(&act("  "));
        assert!(!j.contains("details") && !j.contains("state"));
        assert!(render_activity(&act("a\"b\\c")).contains("a\\\"b\\\\c"));
    }

    #[test]
    fn none_sends_null() {
        let mut f = fake();
        let w = worker(&mut f, 10);
        w.set("1".into(), Some(render_activity(&act("Hello"))));
        recv(&f);
        recv(&f);
        w.set("1".into(), None);
        let (_, op, body) = recv(&f);
        assert_eq!(op, 1);
        assert!(body.contains("\"activity\":null"), "{body}");
    }

    #[test]
    fn app_id_change_reconnects() {
        let mut f = fake();
        let w = worker(&mut f, 10);
        w.set("111".into(), Some(render_activity(&act("One"))));
        let (c0, _, h) = recv(&f);
        assert!(h.contains("\"client_id\":\"111\""));
        recv(&f);
        w.set("222".into(), Some(render_activity(&act("Two"))));
        // Frames of the two connections arrive via separate server threads,
        // so their relative order is not guaranteed: gather until all seen.
        let (mut saw_close, mut saw_hs, mut saw_act) = (false, false, false);
        while !(saw_close && saw_hs && saw_act) {
            let (c, op, body) = recv(&f);
            match op {
                2 => {
                    assert_eq!(c, c0);
                    saw_close = true;
                }
                0 => {
                    assert!(c != c0 && body.contains("\"client_id\":\"222\""));
                    saw_hs = true;
                }
                1 => {
                    assert!(c != c0 && body.contains("\"details\":\"Two\""));
                    saw_act = true;
                }
                _ => {}
            }
        }
    }

    #[test]
    fn reconnects_after_server_drop() {
        let mut f = fake();
        let w = worker(&mut f, 10);
        f.drop_after_activity.store(true, Ordering::SeqCst);
        w.set("9".into(), Some(render_activity(&act("First"))));
        let (c0, _, _) = recv(&f);
        recv(&f);
        w.set("9".into(), Some(render_activity(&act("Second"))));
        // Second may be written on the dead socket, then a reconnect resends it.
        loop {
            let (c, op, body) = recv(&f);
            if op == 1 && c != c0 && body.contains("Second") {
                break;
            }
        }
    }

    #[test]
    fn retries_until_discord_appears() {
        let mut f = fake();
        f.up.store(false, Ordering::SeqCst);
        let w = worker(&mut f, 10);
        w.set("5".into(), Some(render_activity(&act("Later"))));
        thread::sleep(Duration::from_millis(200));
        assert!(f.rx.try_recv().is_err());
        f.up.store(true, Ordering::SeqCst);
        let (_, op, _) = recv(&f);
        assert_eq!(op, 0);
        let (_, op, body) = recv(&f);
        assert!(op == 1 && body.contains("Later"));
    }

    #[test]
    fn rapid_updates_coalesce_last_wins() {
        let mut f = fake();
        let w = worker(&mut f, 300);
        w.set("7".into(), Some(render_activity(&act("A1"))));
        recv(&f);
        let (_, _, first) = recv(&f);
        assert!(first.contains("A1"));
        for n in ["B2", "C3", "D4", "E5"] {
            w.set("7".into(), Some(render_activity(&act(n))));
        }
        let (_, _, body) = recv(&f);
        assert!(body.contains("E5"), "{body}");
        assert!(
            f.rx.recv_timeout(Duration::from_millis(600)).is_err(),
            "extra frames sent"
        );
    }
}
