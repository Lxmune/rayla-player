//! Byte sources for the decoder: local files and a cached HTTP reader backed
//! by a background downloader (`cache`), plus background prefetch.

mod cache;
mod http;
mod prefetch;

pub(crate) use http::agent;
pub use http::HttpSource;
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

/// Receives `(track id, cached bytes, total bytes)`; total 0 = unknown length.
type ProgressHook = Arc<dyn Fn(&str, u64, u64) + Send + Sync>;
static PROGRESS_HOOK: Mutex<Option<ProgressHook>> = Mutex::new(None);

/// Install the callback the player uses to turn cache fill level into events.
pub(crate) fn set_progress_hook(hook: ProgressHook) {
    *PROGRESS_HOOK.lock().unwrap() = Some(hook);
}

pub(crate) fn emit_progress(track_id: &str, cached: u64, total: u64) {
    let hook = PROGRESS_HOOK.lock().unwrap().clone();
    if let Some(h) = hook {
        h(track_id, cached, total);
    }
}

/// Trim the stream cache to its size limit (least recently used first).
pub(crate) fn prune_cache(dir: &Path) {
    cache::prune(dir, cache::limit());
}

pub(crate) fn cache_stats(dir: &Path) -> crate::api::engine::CacheStats {
    cache::stats(dir)
}

/// Delete every cache entry not currently in use.
pub(crate) fn cache_clear(dir: &Path) {
    cache::prune(dir, 0);
}

pub(crate) fn cache_set_limit(dir: &Path, bytes: u64) {
    cache::set_limit(bytes);
    cache::prune(dir, bytes);
}

/// Ids of `tracks` whose stream-cache entry is complete on disk.
pub(crate) fn cached_tracks(
    dir: &Path,
    tracks: &[crate::api::engine::TrackRequest],
) -> Vec<String> {
    tracks
        .iter()
        .filter(|t| t.local_path.is_none())
        .filter(|t| cache::is_complete(dir, &cache::cache_key(&t.id, &t.url)))
        .map(|t| t.id.clone())
        .collect()
}

#[cfg(test)]
mod cache_tests;

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
