//! Offline downloads: a directory of finished files plus an `index.json`.
//! Uses the same ureq agent (and therefore TLS stack) as the streaming source.
//! Files are written to `<id>.<ext>.part` and renamed only when complete, so
//! the index only ever points at whole files.

use crate::api::engine::HttpHeader;
use anyhow::{anyhow, bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const PROGRESS_INTERVAL: Duration = Duration::from_millis(200);

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadRecord {
    pub id: String,
    /// Absolute path of the finished file.
    pub path: String,
    pub bytes: u64,
    /// ISO-8601 UTC.
    pub added_at: String,
    pub item: serde_json::Value,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadRequest {
    pub id: String,
    pub url: String,
    pub headers: Vec<HttpHeader>,
    pub extension: String,
    pub item: serde_json::Value,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadProgress {
    pub id: String,
    pub received_bytes: u64,
    pub total_bytes: Option<u64>,
}

/// On-disk index entry (no absolute path, so the directory can move).
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct IndexEntry {
    id: String,
    file: String,
    bytes: u64,
    added_at: String,
    item: serde_json::Value,
}

pub struct DownloadStore {
    dir: PathBuf,
    /// Serialises read-modify-write cycles on the index.
    lock: Mutex<()>,
}

/// Keep only `[A-Za-z0-9_-]`; empty (after sanitising or before) is rejected.
fn sanitize(s: &str, what: &str) -> Result<String> {
    let out: String = s
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-')
        .collect();
    if out.is_empty() {
        bail!("invalid {what}: {s:?}");
    }
    Ok(out)
}

impl DownloadStore {
    pub fn new(dir: impl Into<PathBuf>) -> Result<Self> {
        let dir = dir.into();
        fs::create_dir_all(&dir).with_context(|| format!("create {}", dir.display()))?;
        Ok(Self { dir, lock: Mutex::new(()) })
    }

    fn index_path(&self) -> PathBuf {
        self.dir.join("index.json")
    }

    fn read_index(&self) -> Vec<IndexEntry> {
        fs::read(self.index_path())
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default()
    }

    fn write_index(&self, entries: &[IndexEntry]) -> Result<()> {
        let tmp = self.dir.join("index.json.tmp");
        let mut f = File::create(&tmp)?;
        f.write_all(&serde_json::to_vec_pretty(entries)?)?;
        f.sync_all()?;
        drop(f);
        fs::rename(&tmp, self.index_path())?;
        Ok(())
    }

    fn record(&self, e: &IndexEntry) -> DownloadRecord {
        DownloadRecord {
            id: e.id.clone(),
            path: self.dir.join(&e.file).to_string_lossy().into_owned(),
            bytes: e.bytes,
            added_at: e.added_at.clone(),
            item: e.item.clone(),
        }
    }

    /// Complete downloads whose file still exists.
    pub fn list(&self) -> Vec<DownloadRecord> {
        let _g = self.lock.lock().unwrap();
        self.read_index()
            .iter()
            .filter(|e| self.dir.join(&e.file).is_file())
            .map(|e| self.record(e))
            .collect()
    }

    /// Remove the file and the index entry. Unknown ids are not an error.
    pub fn delete(&self, id: &str) -> Result<()> {
        let _g = self.lock.lock().unwrap();
        let mut entries = self.read_index();
        if let Some(pos) = entries.iter().position(|e| e.id == id) {
            let e = entries.remove(pos);
            // Entry files come from our own index; still never follow a path.
            if Path::new(&e.file).components().count() == 1 {
                match fs::remove_file(self.dir.join(&e.file)) {
                    Ok(()) => {}
                    Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
                    Err(err) => return Err(err.into()),
                }
            }
            self.write_index(&entries)?;
        }
        Ok(())
    }

    /// Blocking download. `progress` is throttled (about 5/s, plus a final
    /// call). Setting `cancel` aborts, removes the `.part` file and errors.
    pub fn download(
        &self,
        req: &DownloadRequest,
        mut progress: impl FnMut(DownloadProgress),
        cancel: &AtomicBool,
    ) -> Result<DownloadRecord> {
        let id = sanitize(&req.id, "id")?;
        let ext = sanitize(&req.extension, "extension")?;
        let file_name = format!("{id}.{ext}");
        let final_path = self.dir.join(&file_name);
        let part_path = self.dir.join(format!("{file_name}.part"));

        let result = self.fetch(req, &id, &part_path, &mut progress, cancel);
        let bytes = match result {
            Ok(n) => n,
            Err(e) => {
                let _ = fs::remove_file(&part_path);
                return Err(e);
            }
        };
        let finish = || -> Result<DownloadRecord> {
            fs::rename(&part_path, &final_path)?;
            let _g = self.lock.lock().unwrap();
            let mut entries = self.read_index();
            if let Some(old) = entries.iter().find(|e| e.id == id) {
                if old.file != file_name && Path::new(&old.file).components().count() == 1 {
                    let _ = fs::remove_file(self.dir.join(&old.file));
                }
            }
            entries.retain(|e| e.id != id);
            let entry = IndexEntry {
                id: id.clone(),
                file: file_name.clone(),
                bytes,
                added_at: iso8601_now(),
                item: req.item.clone(),
            };
            entries.push(entry.clone());
            self.write_index(&entries)?;
            Ok(self.record(&entry))
        };
        finish().map_err(|e| {
            let _ = fs::remove_file(&part_path);
            e
        })
    }

    fn fetch(
        &self,
        req: &DownloadRequest,
        id: &str,
        part_path: &Path,
        progress: &mut impl FnMut(DownloadProgress),
        cancel: &AtomicBool,
    ) -> Result<u64> {
        if cancel.load(Ordering::Relaxed) {
            bail!("download cancelled");
        }
        let agent = crate::source::agent()?;
        let mut r = agent.get(&req.url);
        for h in &req.headers {
            r = r.set(&h.name, &h.value);
        }
        let resp = r.call().map_err(|e| anyhow!("download failed: {e}"))?;
        let total = resp
            .header("content-length")
            .and_then(|v| v.trim().parse::<u64>().ok());
        let mut reader = resp.into_reader();
        let mut file = File::create(part_path)
            .with_context(|| format!("create {}", part_path.display()))?;
        let mut buf = vec![0u8; 64 * 1024];
        let mut received = 0u64;
        let mut last: Option<Instant> = None;
        let report = |received: u64| DownloadProgress {
            id: id.to_string(),
            received_bytes: received,
            total_bytes: total,
        };
        loop {
            if cancel.load(Ordering::Relaxed) {
                bail!("download cancelled");
            }
            let n = reader.read(&mut buf).context("download read failed")?;
            if n == 0 {
                break;
            }
            file.write_all(&buf[..n])?;
            received += n as u64;
            if last.map_or(true, |t| t.elapsed() >= PROGRESS_INTERVAL) {
                last = Some(Instant::now());
                progress(report(received));
            }
        }
        if let Some(t) = total {
            if received != t {
                bail!("download truncated: got {received} of {t} bytes");
            }
        }
        file.sync_all()?;
        progress(report(received));
        Ok(received)
    }
}

fn iso8601_now() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    iso8601(secs)
}

/// Unix seconds to `YYYY-MM-DDTHH:MM:SSZ` (civil-from-days, no deps).
fn iso8601(secs: i64) -> String {
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z",
        rem / 3600,
        rem % 3600 / 60,
        rem % 60
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::player::tests::{body, hdrs, tmp, TestServer};
    use std::sync::atomic::AtomicBool;

    fn request(srv: &TestServer, id: &str, ext: &str) -> DownloadRequest {
        DownloadRequest {
            id: id.into(),
            url: srv.url(),
            headers: hdrs()
                .into_iter()
                .map(|(name, value)| HttpHeader { name, value })
                .collect(),
            extension: ext.into(),
            item: serde_json::json!({"Id": id, "Name": "Song"}),
        }
    }

    fn files(dir: &Path) -> Vec<String> {
        let mut v: Vec<String> = fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        v.sort();
        v
    }

    #[test]
    fn iso8601_formats_known_instants() {
        assert_eq!(iso8601(0), "1970-01-01T00:00:00Z");
        assert_eq!(iso8601(1_709_164_800 + 3661), "2024-02-29T01:01:01Z");
    }

    #[test]
    fn downloads_and_indexes() {
        let data = body(500_000);
        let srv = TestServer::start(data.clone());
        let dir = tmp("dl-ok");
        let store = DownloadStore::new(&dir).unwrap();
        let mut calls = Vec::new();
        let rec = store
            .download(&request(&srv, "abc", "flac"), |p| calls.push(p), &AtomicBool::new(false))
            .unwrap();
        assert_eq!(rec.id, "abc");
        assert_eq!(rec.bytes, 500_000);
        assert_eq!(rec.path, dir.join("abc.flac").to_string_lossy());
        assert_eq!(fs::read(&rec.path).unwrap(), data);
        assert!(rec.added_at.ends_with('Z') && rec.added_at.len() == 20);
        let last = calls.last().unwrap();
        assert_eq!(last.received_bytes, 500_000);
        assert_eq!(last.total_bytes, Some(500_000));
        assert_eq!(files(&dir), vec!["abc.flac", "index.json"]);

        let list = store.list();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].item["Name"], "Song");
        // A fresh store over the same directory sees the same index.
        assert_eq!(DownloadStore::new(&dir).unwrap().list().len(), 1);

        // Re-downloading replaces the entry instead of duplicating it.
        store
            .download(&request(&srv, "abc", "mp3"), |_| {}, &AtomicBool::new(false))
            .unwrap();
        let list = store.list();
        assert_eq!(list.len(), 1);
        assert!(list[0].path.ends_with("abc.mp3"));
        assert_eq!(files(&dir), vec!["abc.mp3", "index.json"]);
    }

    #[test]
    fn progress_is_throttled() {
        let srv = TestServer::start(body(2_000_000));
        let store = DownloadStore::new(tmp("dl-throttle")).unwrap();
        let mut n = 0;
        store
            .download(&request(&srv, "t", "bin"), |_| n += 1, &AtomicBool::new(false))
            .unwrap();
        // 2 MB is ~31 chunks; the local transfer takes far less than 200 ms
        // per chunk, so only the first and the final call should arrive.
        assert!(n >= 2 && n < 31, "got {n} progress calls");
    }

    #[test]
    fn cancel_removes_part_file() {
        let srv = TestServer::start(body(3_000_000));
        let dir = tmp("dl-cancel");
        let store = DownloadStore::new(&dir).unwrap();
        let cancel = AtomicBool::new(false);
        let err = store
            .download(
                &request(&srv, "c", "flac"),
                |_| cancel.store(true, Ordering::Relaxed),
                &cancel,
            )
            .unwrap_err();
        assert!(err.to_string().contains("cancel"), "{err}");
        assert!(files(&dir).is_empty(), "{:?}", files(&dir));
        assert!(store.list().is_empty());
    }

    #[test]
    fn precancelled_never_requests() {
        let srv = TestServer::start(body(10));
        let store = DownloadStore::new(tmp("dl-precancel")).unwrap();
        assert!(store
            .download(&request(&srv, "p", "x"), |_| {}, &AtomicBool::new(true))
            .is_err());
        assert!(srv.requests().is_empty());
    }

    #[test]
    fn http_error_leaves_nothing() {
        let srv = TestServer::start(body(1000));
        let dir = tmp("dl-403");
        let store = DownloadStore::new(&dir).unwrap();
        let mut req = request(&srv, "bad", "flac");
        req.headers.clear(); // server answers 403 without the token
        assert!(store.download(&req, |_| {}, &AtomicBool::new(false)).is_err());
        assert!(files(&dir).is_empty());
        assert!(store.list().is_empty());
    }

    #[test]
    fn sanitizes_id_and_extension() {
        let srv = TestServer::start(body(100));
        let dir = tmp("dl-sanitize");
        let store = DownloadStore::new(&dir).unwrap();
        let rec = store
            .download(&request(&srv, "../../etc/pa ss", "f.l/ac"), |_| {}, &AtomicBool::new(false))
            .unwrap();
        assert_eq!(rec.id, "etcpass");
        assert_eq!(files(&dir), vec!["etcpass.flac", "index.json"]);
        for bad in [("", "flac"), ("a", ""), ("../", "flac"), ("a", "./")] {
            assert!(store
                .download(&request(&srv, bad.0, bad.1), |_| {}, &AtomicBool::new(false))
                .is_err());
        }
        assert_eq!(files(&dir), vec!["etcpass.flac", "index.json"]);
    }

    #[test]
    fn delete_removes_file_and_entry() {
        let srv = TestServer::start(body(100));
        let dir = tmp("dl-delete");
        let store = DownloadStore::new(&dir).unwrap();
        for id in ["one", "two"] {
            store
                .download(&request(&srv, id, "flac"), |_| {}, &AtomicBool::new(false))
                .unwrap();
        }
        store.delete("one").unwrap();
        store.delete("missing").unwrap();
        assert_eq!(files(&dir), vec!["index.json", "two.flac"]);
        let list = store.list();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].id, "two");
    }
}
