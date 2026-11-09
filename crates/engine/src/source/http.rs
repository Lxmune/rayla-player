//! Seekable HTTP source that writes everything it reads through to a cache
//! file and remembers which byte ranges are present. A reopened source reads
//! cached ranges from disk and only requests the gaps; a fully cached track
//! never touches the network.

use anyhow::{anyhow, bail, Context, Result};
use std::fs::{File, OpenOptions};
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;
use symphonia::core::io::MediaSource;

/// Persist the range table after this many new bytes (and always on drop).
const META_EVERY: u64 = 4 << 20;
/// Forward gaps up to this size on a non-ranged (200) stream are read through.
const SKIP_LIMIT: u64 = 1 << 20;

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
}

struct Stream {
    reader: Box<dyn Read + Send + Sync>,
    /// Absolute offset of the next byte `reader` yields.
    next: u64,
    /// Exclusive limit this stream was asked for.
    end: u64,
    /// Server ignored the Range header and sends the whole file from 0.
    whole: bool,
}

pub struct HttpSource {
    url: String,
    headers: Vec<(String, String)>,
    agent: ureq::Agent,
    file: File,
    meta_path: PathBuf,
    len: u64,
    ranges: Ranges,
    pos: u64,
    stream: Option<Stream>,
    unsaved: u64,
}

pub(crate) fn agent() -> Result<ureq::Agent> {
    let b = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(10))
        .timeout_read(Duration::from_secs(20));
    #[cfg(any(target_os = "windows", target_os = "macos"))]
    let b = b.tls_connector(std::sync::Arc::new(native_tls::TlsConnector::new()?));
    Ok(b.build())
}

fn safe_key(key: &str) -> String {
    key.bytes()
        .map(|c| match c {
            b'a'..=b'z' | b'A'..=b'Z' | b'0'..=b'9' | b'-' | b'_' => (c as char).to_string(),
            _ => format!("%{c:02X}"),
        })
        .collect()
}

impl HttpSource {
    pub fn open(
        url: &str,
        headers: &[(String, String)],
        cache_dir: &Path,
        key: &str,
    ) -> Result<Self> {
        std::fs::create_dir_all(cache_dir)?;
        let base = safe_key(key);
        let data_path = cache_dir.join(format!("{base}.audio"));
        let meta_path = cache_dir.join(format!("{base}.meta"));
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(&data_path)
            .with_context(|| format!("open cache file {}", data_path.display()))?;
        let (mut len, mut ranges) = read_meta(&meta_path).unwrap_or((0, Ranges::default()));
        if len > 0 && file.metadata().map(|m| m.len()).unwrap_or(0) != len {
            // Data file was lost or truncated: the range table cannot be trusted.
            len = 0;
            ranges = Ranges::default();
        }
        let mut s = HttpSource {
            url: url.to_string(),
            headers: headers.to_vec(),
            agent: agent()?,
            file,
            meta_path,
            len,
            ranges,
            pos: 0,
            stream: None,
            unsaved: 0,
        };
        if s.len == 0 {
            // Unknown length: this first request also learns it.
            s.connect(0, None)?;
        }
        Ok(s)
    }

    /// Start a request at `pos`, bounded by `limit` (exclusive) when known.
    fn connect(&mut self, pos: u64, limit: Option<u64>) -> Result<()> {
        self.stream = None;
        let mut req = self.agent.get(&self.url);
        for (n, v) in &self.headers {
            req = req.set(n, v);
        }
        let range = match limit {
            Some(l) => format!("bytes={pos}-{}", l - 1),
            None => format!("bytes={pos}-"),
        };
        let resp = req
            .set("Range", &range)
            .call()
            .map_err(|e| anyhow!("GET {}: {e}", self.url))?;
        let (total, whole) = match resp.status() {
            206 => {
                let cr = resp.header("Content-Range").unwrap_or("");
                let total = cr
                    .rsplit('/')
                    .next()
                    .and_then(|t| t.trim().parse::<u64>().ok());
                (
                    total.ok_or_else(|| anyhow!("206 without usable Content-Range"))?,
                    false,
                )
            }
            200 => {
                let total = resp
                    .header("Content-Length")
                    .and_then(|t| t.trim().parse::<u64>().ok());
                (
                    total.ok_or_else(|| anyhow!("server did not report a length"))?,
                    true,
                )
            }
            s => bail!("unexpected HTTP status {s}"),
        };
        if total == 0 {
            bail!("empty response");
        }
        if self.len == 0 {
            self.len = total;
            self.file.set_len(total)?;
        } else if self.len != total {
            bail!("remote length changed ({} -> {total})", self.len);
        }
        self.stream = Some(Stream {
            reader: resp.into_reader(),
            next: if whole { 0 } else { pos },
            end: if whole { total } else { limit.unwrap_or(total) },
            whole,
        });
        Ok(())
    }

    fn save_meta(&mut self) {
        let mut text = format!("{}\n", self.len);
        for &(a, b) in &self.ranges.0 {
            text.push_str(&format!("{a} {b}\n"));
        }
        let _ = self.file.flush();
        let _ = std::fs::write(&self.meta_path, text);
        self.unsaved = 0;
    }

    fn store(&mut self, at: u64, data: &[u8]) -> io::Result<()> {
        self.file.seek(SeekFrom::Start(at))?;
        self.file.write_all(data)?;
        self.ranges.insert(at, at + data.len() as u64);
        self.unsaved += data.len() as u64;
        if self.unsaved >= META_EVERY || self.ranges.covers(self.len) {
            self.save_meta();
        }
        Ok(())
    }

    /// Make `self.stream` yield byte `self.pos` next.
    fn align_stream(&mut self, gap_end: u64) -> Result<()> {
        let pos = self.pos;
        if let Some(st) = &self.stream {
            if st.next == pos && pos < st.end {
                return Ok(());
            }
            if st.whole && st.next < pos && pos - st.next <= SKIP_LIMIT {
                return self.skip_to(pos);
            }
        }
        // Open-ended when nothing cached lies ahead, otherwise bounded to the gap.
        let limit = (gap_end < self.len).then_some(gap_end);
        self.connect(pos, limit)?;
        if self.stream.as_ref().is_some_and(|s| s.whole) && pos > 0 {
            if pos > SKIP_LIMIT {
                bail!("server ignores Range requests; cannot seek");
            }
            self.skip_to(pos)?;
        }
        Ok(())
    }

    /// Read-and-cache a non-ranged stream forward up to `target`.
    fn skip_to(&mut self, target: u64) -> Result<()> {
        let mut buf = vec![0u8; 64 << 10];
        while self.stream.as_ref().map_or(0, |s| s.next) < target {
            let st = self.stream.as_mut().unwrap();
            let want = ((target - st.next) as usize).min(buf.len());
            let n = st.reader.read(&mut buf[..want])?;
            if n == 0 {
                bail!("stream ended early");
            }
            let at = st.next;
            st.next += n as u64;
            self.store(at, &buf[..n])?;
        }
        Ok(())
    }

    fn read_network(&mut self, buf: &mut [u8], gap_end: u64) -> io::Result<usize> {
        let mut last_err = None;
        for _ in 0..2 {
            let res = self
                .align_stream(gap_end)
                .map_err(|e| io::Error::other(e.to_string()));
            if let Err(e) = res {
                last_err = Some(e);
                self.stream = None;
                continue;
            }
            let want = buf.len().min((gap_end - self.pos) as usize);
            let st = self.stream.as_mut().unwrap();
            match st.reader.read(&mut buf[..want]) {
                Ok(0) => {
                    self.stream = None;
                    last_err = Some(io::ErrorKind::UnexpectedEof.into());
                }
                Ok(n) => {
                    let at = st.next;
                    st.next += n as u64;
                    let done = st.next >= st.end;
                    if done {
                        self.stream = None;
                    }
                    self.store(at, &buf[..n])?;
                    return Ok(n);
                }
                Err(e) => {
                    self.stream = None;
                    last_err = Some(e);
                }
            }
        }
        Err(last_err.unwrap_or_else(|| io::Error::other("network read failed")))
    }
}

impl Drop for HttpSource {
    fn drop(&mut self) {
        self.save_meta();
    }
}

impl Read for HttpSource {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if buf.is_empty() || self.pos >= self.len {
            return Ok(0);
        }
        let n = if let Some(end) = self.ranges.cached_end(self.pos) {
            let n = buf.len().min((end - self.pos) as usize);
            self.file.seek(SeekFrom::Start(self.pos))?;
            self.file.read_exact(&mut buf[..n])?;
            n
        } else {
            let gap_end = self.ranges.next_start(self.pos).unwrap_or(self.len);
            self.read_network(buf, gap_end)?
        };
        self.pos += n as u64;
        Ok(n)
    }
}

impl Seek for HttpSource {
    fn seek(&mut self, to: SeekFrom) -> io::Result<u64> {
        let new = match to {
            SeekFrom::Start(p) => p as i128,
            SeekFrom::Current(d) => self.pos as i128 + d as i128,
            SeekFrom::End(d) => self.len as i128 + d as i128,
        };
        if new < 0 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "seek before start",
            ));
        }
        self.pos = new as u64;
        Ok(self.pos)
    }
}

impl MediaSource for HttpSource {
    fn is_seekable(&self) -> bool {
        true
    }
    fn byte_len(&self) -> Option<u64> {
        Some(self.len)
    }
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
