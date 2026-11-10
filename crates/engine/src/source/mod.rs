//! Byte sources for the decoder: local files and a cached HTTP reader backed
//! by a background downloader (`cache`), plus background prefetch.

mod cache;
mod http;
mod prefetch;

pub use http::HttpSource;
pub(crate) use http::agent;
pub use prefetch::Prefetcher;

use anyhow::{Context, Result};
use std::path::Path;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};
use symphonia::core::io::MediaSource;

/// Receives `(track id, bits per second)` while a track downloads.
type ThroughputHook = Arc<dyn Fn(&str, u64) + Send + Sync>;
static THROUGHPUT_HOOK: Mutex<Option<ThroughputHook>> = Mutex::new(None);

/// Install the callback the player uses to turn download speed into events.
pub(crate) fn set_throughput_hook(hook: ThroughputHook) {
    *THROUGHPUT_HOOK.lock().unwrap() = Some(hook);
}

pub(crate) fn emit_throughput(track_id: &str, bps: u64) {
    let hook = THROUGHPUT_HOOK.lock().unwrap().clone();
    if let Some(h) = hook {
        h(track_id, bps);
    }
}

/// Trim the stream cache to its size cap (least recently used first).
pub(crate) fn prune_cache(dir: &Path) {
    cache::prune(dir, cache::CACHE_CAP);
}

#[cfg(test)]
pub(crate) use cache::cache_key;
#[cfg(test)]
pub(crate) fn prune_to(dir: &Path, cap: u64) {
    cache::prune(dir, cap);
}

/// Opens the bytes behind a track. Local paths bypass HTTP and the cache.
/// Returns the source and a file-extension hint for the format probe.
/// `cancel` aborts a read that is waiting for the download.
pub fn open(
    local_path: Option<&str>,
    url: &str,
    headers: &[(String, String)],
    cache_dir: &Path,
    id: &str,
    cancel: Option<Arc<AtomicBool>>,
) -> Result<(Box<dyn MediaSource>, Option<String>)> {
    if let Some(p) = local_path {
        let ext = Path::new(p)
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_ascii_lowercase());
        let f = std::fs::File::open(p).with_context(|| format!("open {p}"))?;
        return Ok((Box::new(f), ext));
    }
    let key = cache::cache_key(id, url);
    let src = HttpSource::open_track(url, headers, cache_dir, &key, id, cancel)?;
    Ok((Box::new(src), None))
}
