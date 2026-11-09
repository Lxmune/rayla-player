//! Byte sources for the decoder: local files and a cached HTTP range reader.

mod http;

pub use http::HttpSource;
pub(crate) use http::agent;

use anyhow::{Context, Result};
use std::path::Path;
use symphonia::core::io::MediaSource;

/// Opens the bytes behind a track. Local paths bypass HTTP and the cache.
/// Returns the source and a file-extension hint for the format probe.
pub fn open(
    local_path: Option<&str>,
    url: &str,
    headers: &[(String, String)],
    cache_dir: &Path,
    key: &str,
) -> Result<(Box<dyn MediaSource>, Option<String>)> {
    if let Some(p) = local_path {
        let ext = Path::new(p)
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_ascii_lowercase());
        let f = std::fs::File::open(p).with_context(|| format!("open {p}"))?;
        return Ok((Box::new(f), ext));
    }
    let src = HttpSource::open(url, headers, cache_dir, key)?;
    Ok((Box::new(src), None))
}
