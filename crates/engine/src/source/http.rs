//! Decoder-side view of a cached HTTP track. The bytes come from the shared
//! cache entry (see `cache.rs`), which a background thread fills completely;
//! this reader just serves cached bytes from disk and waits when the
//! downloader has not reached the wanted position yet.

use super::cache::{self, Handle};
use anyhow::{bail, Result};
use std::fs::File;
use std::io::{self, Read, Seek, SeekFrom};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use symphonia::core::io::MediaSource;

/// A read fails when the download makes no progress at all for this long.
const STALL_LIMIT: Duration = Duration::from_secs(60);
/// How often a waiting reader re-checks cancellation and the stall timer.
const POLL: Duration = Duration::from_millis(250);

pub struct HttpSource {
    entry: Handle,
    /// Private read handle: the downloader's writes never move our cursor.
    file: File,
    pos: u64,
    /// Set when the owner no longer wants this source (a waiting read aborts).
    cancel: Option<Arc<AtomicBool>>,
}

pub(crate) fn agent() -> Result<ureq::Agent> {
    let b = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(10))
        .timeout_read(Duration::from_secs(20));
    #[cfg(any(target_os = "windows", target_os = "macos"))]
    let b = b.tls_connector(std::sync::Arc::new(native_tls::TlsConnector::new()?));
    Ok(b.build())
}

impl HttpSource {
    /// `key` names the cache entry; it also labels throughput events.
    #[cfg(test)]
    pub fn open(
        url: &str,
        headers: &[(String, String)],
        cache_dir: &std::path::Path,
        key: &str,
    ) -> Result<Self> {
        Self::open_track(url, headers, cache_dir, key, key, None)
    }

    pub(crate) fn open_track(
        url: &str,
        headers: &[(String, String)],
        cache_dir: &std::path::Path,
        key: &str,
        track_id: &str,
        cancel: Option<Arc<AtomicBool>>,
    ) -> Result<Self> {
        let entry = cache::attach(url, headers, cache_dir, key, track_id)?;
        let file = File::open(&entry.entry().data_path)?;
        let s = HttpSource {
            entry,
            file,
            pos: 0,
            cancel,
        };
        s.wait_ready()?;
        Ok(s)
    }

    /// Block until the first response arrived (length or bytes known), the
    /// server refused for good, or nothing happens for `STALL_LIMIT`.
    fn wait_ready(&self) -> Result<()> {
        let e = self.entry.entry();
        let mut st = e.st.lock().unwrap();
        let (mut seen, mut since) = (st.progress, Instant::now());
        loop {
            if st.len.is_some() || !st.ranges.is_empty() {
                return Ok(());
            }
            if st.fatal {
                bail!("{}", st.error.as_deref().unwrap_or("download failed"));
            }
            if self.cancelled() {
                bail!("cancelled");
            }
            st = e.cv.wait_timeout(st, POLL).unwrap().0;
            if st.progress != seen {
                (seen, since) = (st.progress, Instant::now());
            } else if since.elapsed() >= STALL_LIMIT {
                bail!(
                    "no response: {}",
                    st.error.as_deref().unwrap_or("timed out")
                );
            }
        }
    }

    fn cancelled(&self) -> bool {
        self.cancel
            .as_ref()
            .is_some_and(|c| c.load(Ordering::Relaxed))
    }

    /// Whether every byte is on disk.
    #[cfg(test)]
    pub(crate) fn is_complete(&self) -> bool {
        self.entry.entry().st.lock().unwrap().complete
    }
}

impl Read for HttpSource {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if buf.is_empty() {
            return Ok(0);
        }
        let e = self.entry.entry();
        let mut st = e.st.lock().unwrap();
        let (mut seen, mut since) = (st.progress, Instant::now());
        let n = loop {
            if st.len.is_some_and(|l| self.pos >= l) {
                return Ok(0); // EOF
            }
            if let Some(end) = st.ranges.cached_end(self.pos) {
                st.want = None;
                break buf.len().min((end - self.pos) as usize);
            }
            if st.fatal {
                let msg = st.error.clone().unwrap_or_else(|| "download failed".into());
                return Err(io::Error::other(msg));
            }
            if self.cancelled() {
                return Err(io::ErrorKind::Interrupted.into());
            }
            // Not downloaded yet: tell the downloader where we are and wait.
            st.want = Some(self.pos);
            e.cv.notify_all();
            st = e.cv.wait_timeout(st, POLL).unwrap().0;
            if st.progress != seen {
                (seen, since) = (st.progress, Instant::now());
            } else if since.elapsed() >= STALL_LIMIT {
                let msg = st.error.clone().unwrap_or_else(|| "timed out".into());
                return Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    format!("download stalled: {msg}"),
                ));
            }
        };
        drop(st);
        self.file.seek(SeekFrom::Start(self.pos))?;
        self.file.read_exact(&mut buf[..n])?;
        self.pos += n as u64;
        Ok(n)
    }
}

impl Seek for HttpSource {
    fn seek(&mut self, to: SeekFrom) -> io::Result<u64> {
        let new = match to {
            SeekFrom::Start(p) => p as i128,
            SeekFrom::Current(d) => self.pos as i128 + d as i128,
            SeekFrom::End(d) => {
                let Some(len) = self.byte_len() else {
                    return Err(io::Error::new(
                        io::ErrorKind::Unsupported,
                        "stream length not known yet",
                    ));
                };
                len as i128 + d as i128
            }
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
    /// Chunked transcodes have no length until fully received.
    fn is_seekable(&self) -> bool {
        self.byte_len().is_some()
    }
    fn byte_len(&self) -> Option<u64> {
        self.entry.entry().st.lock().unwrap().len
    }
}
