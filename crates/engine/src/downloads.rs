//! Offline downloads: a directory of finished files plus an `index.json`.
//! Uses the same ureq agent (and therefore TLS stack) as the streaming source.
//! Files are written to `<id>.<ext>.part` and renamed only when complete, so
//! the index only ever points at whole files. A `.part` survives network
//! failure / app exit (with `.part.meta` holding the total length) and is
//! resumed with a Range request by the next download of the same id.

use crate::api::engine::HttpHeader;
use anyhow::{anyhow, bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const PROGRESS_INTERVAL: Duration = Duration::from_millis(200);
const BACKOFF_MIN: Duration = Duration::from_millis(500);
const BACKOFF_MAX: Duration = Duration::from_secs(10);
/// Give up (keeping the partial file) after this long without any new bytes.
const GIVE_UP_AFTER: Duration = Duration::from_secs(120);

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
    /// Absolute folder holding `file` when it is not the default folder.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    dir: Option<String>,
    bytes: u64,
    added_at: String,
    item: serde_json::Value,
}

pub struct DownloadStore {
    dir: PathBuf,
    /// Folder for new downloads; `None` = `dir`.
    custom: Mutex<Option<PathBuf>>,
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
        Ok(Self {
            dir,
            custom: Mutex::new(None),
            lock: Mutex::new(()),
        })
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

    /// Where an entry's file lives.
    fn entry_dir(&self, e: &IndexEntry) -> PathBuf {
        e.dir
            .as_ref()
            .map(PathBuf::from)
            .unwrap_or_else(|| self.dir.clone())
    }

    /// Folder new downloads go to right now.
    fn target_dir(&self) -> PathBuf {
        self.custom
            .lock()
            .unwrap()
            .clone()
            .unwrap_or_else(|| self.dir.clone())
    }

    /// Choose the folder for new downloads (`None`/empty = default). Creates it
    /// and checks it is writable; on error the previous choice stays.
    pub fn set_dir(&self, dir: Option<&str>) -> Result<()> {
        let dir = dir.map(str::trim).filter(|d| !d.is_empty());
        let Some(dir) = dir else {
            *self.custom.lock().unwrap() = None;
            return Ok(());
        };
        let path = PathBuf::from(dir);
        if !path.is_absolute() {
            bail!("downloads folder must be an absolute path: {dir}");
        }
        fs::create_dir_all(&path).with_context(|| format!("create {}", path.display()))?;
        let probe = path.join(".rayla-write-test");
        File::create(&probe)
            .and_then(|mut f| f.write_all(b"x"))
            .with_context(|| format!("{} is not writable", path.display()))?;
        let _ = fs::remove_file(&probe);
        *self.custom.lock().unwrap() = Some(path);
        Ok(())
    }

    fn record(&self, e: &IndexEntry) -> DownloadRecord {
        DownloadRecord {
            id: e.id.clone(),
            path: self
                .entry_dir(e)
                .join(&e.file)
                .to_string_lossy()
                .into_owned(),
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
            .filter(|e| self.entry_dir(e).join(&e.file).is_file())
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
                match fs::remove_file(self.entry_dir(&e).join(&e.file)) {
                    Ok(()) => {}
                    Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
                    Err(err) => return Err(err.into()),
                }
            }
            self.write_index(&entries)?;
        }
        Ok(())
    }

    /// Blocking, resumable download. `progress` is throttled (about 5/s, plus a
    /// final call). Network errors are retried with backoff inside the call;
    /// if it still fails (or the app exits) the `.part` file stays and the
    /// next call for the same id resumes it with a Range request. Setting
    /// `cancel` aborts, removes the partial file and errors.
    pub fn download(
        &self,
        req: &DownloadRequest,
        mut progress: impl FnMut(DownloadProgress),
        cancel: &AtomicBool,
    ) -> Result<DownloadRecord> {
        let id = sanitize(&req.id, "id")?;
        let ext = sanitize(&req.extension, "extension")?;
        let file_name = format!("{id}.{ext}");
        let target = self.target_dir();
        let entry_dir = (target != self.dir).then(|| target.to_string_lossy().into_owned());
        fs::create_dir_all(&target).with_context(|| format!("create {}", target.display()))?;
        let final_path = target.join(&file_name);
        let part_path = target.join(format!("{file_name}.part"));
        let meta_path = target.join(format!("{file_name}.part.meta"));

        let result = self.fetch(req, &id, &part_path, &meta_path, &mut progress, cancel);
        let bytes = match result {
            Ok(n) => n,
            Err(f) => {
                if f.discard {
                    let _ = fs::remove_file(&part_path);
                    let _ = fs::remove_file(&meta_path);
                }
                return Err(f.err);
            }
        };
        let _ = fs::remove_file(&meta_path);
        let finish = || -> Result<DownloadRecord> {
            fs::rename(&part_path, &final_path)?;
            let _g = self.lock.lock().unwrap();
            let mut entries = self.read_index();
            if let Some(old) = entries.iter().find(|e| e.id == id) {
                let old_path = self.entry_dir(old).join(&old.file);
                if old_path != final_path && Path::new(&old.file).components().count() == 1 {
                    let _ = fs::remove_file(old_path);
                }
            }
            entries.retain(|e| e.id != id);
            let entry = IndexEntry {
                id: id.clone(),
                file: file_name.clone(),
                dir: entry_dir.clone(),
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
        meta_path: &Path,
        progress: &mut impl FnMut(DownloadProgress),
        cancel: &AtomicBool,
    ) -> Result<u64, Failure> {
        let cancelled = || Failure {
            discard: true,
            err: anyhow!("download cancelled"),
        };
        if cancel.load(Ordering::Relaxed) {
            return Err(cancelled());
        }
        let io = |e: std::io::Error| Failure {
            discard: false,
            err: e.into(),
        };
        let agent = crate::source::agent().map_err(|err| Failure { discard: true, err })?;

        // Resume only when the sidecar knows the total and the partial file is shorter.
        let part_len = fs::metadata(part_path).map(|m| m.len()).unwrap_or(0);
        let mut total: Option<u64> = fs::read_to_string(meta_path)
            .ok()
            .and_then(|t| t.trim().parse::<u64>().ok());
        let mut offset = match total {
            Some(t) if part_len > 0 && part_len < t => part_len,
            _ => 0,
        };
        if offset == 0 {
            total = None;
        }
        let mut file = OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(false)
            .open(part_path)
            .map_err(io)?;
        file.set_len(offset).map_err(io)?;
        file.seek(SeekFrom::Start(offset)).map_err(io)?;

        let mut buf = vec![0u8; 64 * 1024];
        let mut last: Option<Instant> = None;
        let mut backoff = BACKOFF_MIN;
        let mut last_progress = Instant::now();
        if offset > 0 {
            progress(DownloadProgress {
                id: id.to_string(),
                received_bytes: offset,
                total_bytes: total,
            });
        }
        loop {
            if cancel.load(Ordering::Relaxed) {
                return Err(cancelled());
            }
            let before = offset;
            match self.attempt(
                req,
                &agent,
                &mut file,
                meta_path,
                &mut offset,
                &mut total,
                &mut buf,
                &mut last,
                id,
                progress,
                cancel,
            ) {
                Ok(()) => break,
                Err(Attempt::Cancelled) => return Err(cancelled()),
                Err(Attempt::Fatal(e)) => {
                    return Err(Failure {
                        discard: true,
                        err: e,
                    })
                }
                Err(Attempt::Restart) => {
                    // Server ignored/rejected the Range or the file changed: begin again.
                    file.set_len(0).map_err(io)?;
                    file.seek(SeekFrom::Start(0)).map_err(io)?;
                    offset = 0;
                    total = None;
                    let _ = fs::remove_file(meta_path);
                }
                Err(Attempt::Retry(e)) => {
                    let progressed = offset > before;
                    // Unknown length (chunked): nothing safe to resume from.
                    if total.is_none() && offset > 0 {
                        file.set_len(0).map_err(io)?;
                        file.seek(SeekFrom::Start(0)).map_err(io)?;
                        offset = 0;
                    }
                    if progressed {
                        backoff = BACKOFF_MIN;
                        last_progress = Instant::now();
                        continue;
                    }
                    if last_progress.elapsed() >= GIVE_UP_AFTER {
                        return Err(Failure {
                            discard: false,
                            err: e.context("no progress for 2 minutes; will resume on retry"),
                        });
                    }
                    let until = Instant::now() + backoff;
                    while Instant::now() < until {
                        if cancel.load(Ordering::Relaxed) {
                            return Err(cancelled());
                        }
                        std::thread::sleep(Duration::from_millis(50));
                    }
                    backoff = (backoff * 2).min(BACKOFF_MAX);
                }
            }
        }
        file.sync_all().map_err(io)?;
        progress(DownloadProgress {
            id: id.to_string(),
            received_bytes: offset,
            total_bytes: total,
        });
        Ok(offset)
    }

    /// One HTTP request, appending to `file` from `offset`. `Ok` = whole file received.
    #[allow(clippy::too_many_arguments)]
    fn attempt(
        &self,
        req: &DownloadRequest,
        agent: &ureq::Agent,
        file: &mut File,
        meta_path: &Path,
        offset: &mut u64,
        total: &mut Option<u64>,
        buf: &mut [u8],
        last: &mut Option<Instant>,
        id: &str,
        progress: &mut impl FnMut(DownloadProgress),
        cancel: &AtomicBool,
    ) -> Result<(), Attempt> {
        let mut r = agent.get(&req.url);
        for h in &req.headers {
            r = r.set(&h.name, &h.value);
        }
        if *offset > 0 {
            r = r.set("Range", &format!("bytes={}-", *offset));
        }
        let resp = match r.call() {
            Ok(resp) => resp,
            Err(ureq::Error::Status(416, _)) if *offset > 0 => return Err(Attempt::Restart),
            Err(ureq::Error::Status(c, _)) if (400..500).contains(&c) && c != 408 && c != 429 => {
                return Err(Attempt::Fatal(anyhow!("download failed: HTTP {c}")));
            }
            Err(e) => return Err(Attempt::Retry(anyhow!("download failed: {e}"))),
        };
        let content_len = resp
            .header("content-length")
            .and_then(|v| v.trim().parse::<u64>().ok());
        match resp.status() {
            206 => {
                // "bytes a-b/total": must continue exactly where we stopped, same total.
                let cr = resp.header("content-range").unwrap_or("").to_string();
                let start = cr
                    .strip_prefix("bytes ")
                    .and_then(|r| r.split('-').next())
                    .and_then(|a| a.trim().parse::<u64>().ok());
                let t = cr
                    .rsplit('/')
                    .next()
                    .and_then(|t| t.trim().parse::<u64>().ok());
                match (start, t) {
                    (Some(s), Some(t)) if s == *offset && total.map_or(true, |k| k == t) => {
                        *total = Some(t)
                    }
                    _ if *offset > 0 => return Err(Attempt::Restart),
                    _ => return Err(Attempt::Retry(anyhow!("unusable Content-Range {cr:?}"))),
                }
            }
            200 => {
                if *offset > 0 {
                    return Err(Attempt::Restart); // Range ignored: re-request from scratch
                }
                *total = content_len;
            }
            s => return Err(Attempt::Retry(anyhow!("unexpected HTTP status {s}"))),
        }
        match *total {
            Some(t) => {
                let _ = fs::write(meta_path, t.to_string());
            }
            None => {
                let _ = fs::remove_file(meta_path);
            }
        }
        let mut reader = resp.into_reader();
        loop {
            if cancel.load(Ordering::Relaxed) {
                return Err(Attempt::Cancelled);
            }
            let n = reader
                .read(buf)
                .map_err(|e| Attempt::Retry(anyhow!("download read failed: {e}")))?;
            if n == 0 {
                break;
            }
            file.write_all(&buf[..n])
                .map_err(|e| Attempt::Fatal(anyhow!("write failed: {e}")))?;
            *offset += n as u64;
            if last.map_or(true, |t| t.elapsed() >= PROGRESS_INTERVAL) {
                *last = Some(Instant::now());
                progress(DownloadProgress {
                    id: id.to_string(),
                    received_bytes: *offset,
                    total_bytes: *total,
                });
            }
            if total.is_some_and(|t| *offset >= t) {
                break;
            }
        }
        if let Some(t) = *total {
            if *offset != t {
                return Err(Attempt::Retry(anyhow!(
                    "download truncated: got {} of {t} bytes",
                    *offset
                )));
            }
        }
        Ok(())
    }
}

/// Why a download call ended; `discard` = also delete the partial file.
struct Failure {
    discard: bool,
    err: anyhow::Error,
}

enum Attempt {
    Cancelled,
    Fatal(anyhow::Error),
    Retry(anyhow::Error),
    /// Throw the partial file away and start from byte 0.
    Restart,
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
            .download(
                &request(&srv, "abc", "flac"),
                |p| calls.push(p),
                &AtomicBool::new(false),
            )
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
            .download(
                &request(&srv, "abc", "mp3"),
                |_| {},
                &AtomicBool::new(false),
            )
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
            .download(
                &request(&srv, "t", "bin"),
                |_| n += 1,
                &AtomicBool::new(false),
            )
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
        assert!(store
            .download(&req, |_| {}, &AtomicBool::new(false))
            .is_err());
        assert!(files(&dir).is_empty());
        assert!(store.list().is_empty());
    }

    #[test]
    fn sanitizes_id_and_extension() {
        let srv = TestServer::start(body(100));
        let dir = tmp("dl-sanitize");
        let store = DownloadStore::new(&dir).unwrap();
        let rec = store
            .download(
                &request(&srv, "../../etc/pa ss", "f.l/ac"),
                |_| {},
                &AtomicBool::new(false),
            )
            .unwrap();
        assert_eq!(rec.id, "etcpass");
        assert_eq!(files(&dir), vec!["etcpass.flac", "index.json"]);
        for bad in [("", "flac"), ("a", ""), ("../", "flac"), ("a", "./")] {
            assert!(store
                .download(
                    &request(&srv, bad.0, bad.1),
                    |_| {},
                    &AtomicBool::new(false)
                )
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

    use crate::player::tests::Behavior;

    fn seed_part(dir: &Path, name: &str, data: &[u8], total: Option<u64>) {
        fs::write(dir.join(format!("{name}.part")), data).unwrap();
        if let Some(t) = total {
            fs::write(dir.join(format!("{name}.part.meta")), t.to_string()).unwrap();
        }
    }

    #[test]
    fn dropped_connection_resumes_within_one_download() {
        let data = body(600_000);
        let srv = TestServer::start_with(data.clone(), Behavior::DropFirstAfter(150_000));
        let dir = tmp("dl-drop");
        let store = DownloadStore::new(&dir).unwrap();
        let mut calls = Vec::new();
        let rec = store
            .download(
                &request(&srv, "d", "flac"),
                |p| calls.push(p),
                &AtomicBool::new(false),
            )
            .unwrap();
        assert_eq!(fs::read(&rec.path).unwrap(), data);
        let reqs = srv.requests();
        assert_eq!(reqs.len(), 2, "{reqs:?}");
        assert_eq!(reqs[0], "");
        assert!(
            reqs[1].starts_with("bytes=") && reqs[1].ends_with('-') && reqs[1] != "bytes=0-",
            "{reqs:?}"
        );
        let last = calls.last().unwrap();
        assert_eq!(
            (last.received_bytes, last.total_bytes),
            (600_000, Some(600_000))
        );
        assert!(calls.iter().all(|p| p.total_bytes == Some(600_000)));
        assert_eq!(files(&dir), vec!["d.flac", "index.json"]);
    }

    #[test]
    fn existing_part_is_resumed_by_a_new_start() {
        let data = body(400_000);
        let srv = TestServer::start(data.clone());
        let dir = tmp("dl-resume");
        let store = DownloadStore::new(&dir).unwrap();
        seed_part(&dir, "r.flac", &data[..123_456], Some(400_000));
        assert!(store.list().is_empty(), "partial files are not downloads");
        let mut calls = Vec::new();
        let rec = store
            .download(
                &request(&srv, "r", "flac"),
                |p| calls.push(p),
                &AtomicBool::new(false),
            )
            .unwrap();
        assert_eq!(srv.requests(), vec!["bytes=123456-".to_string()]);
        assert_eq!(fs::read(&rec.path).unwrap(), data);
        assert_eq!(calls[0].received_bytes, 123_456);
        assert_eq!(calls.last().unwrap().received_bytes, 400_000);
        assert_eq!(files(&dir), vec!["index.json", "r.flac"]);
    }

    #[test]
    fn changed_length_or_missing_sidecar_restarts_from_zero() {
        let data = body(300_000);
        let srv = TestServer::start(data.clone());
        for (name, total) in [("a", Some(999_999)), ("b", None)] {
            let dir = tmp(&format!("dl-restart-{name}"));
            let store = DownloadStore::new(&dir).unwrap();
            seed_part(&dir, "x.bin", &vec![7u8; 50_000], total);
            let before = srv.requests().len();
            let rec = store
                .download(&request(&srv, "x", "bin"), |_| {}, &AtomicBool::new(false))
                .unwrap();
            assert_eq!(fs::read(&rec.path).unwrap(), data, "{name}");
            if total.is_none() {
                assert_eq!(srv.requests()[before..], [String::new()]);
            }
        }
    }

    #[test]
    fn server_ignoring_range_restarts_from_zero() {
        let data = body(200_000);
        let srv = TestServer::start_with(data.clone(), Behavior::Chunked);
        let dir = tmp("dl-ignore-range");
        let store = DownloadStore::new(&dir).unwrap();
        seed_part(&dir, "c.bin", &data[..1000], Some(200_000));
        let rec = store
            .download(&request(&srv, "c", "bin"), |_| {}, &AtomicBool::new(false))
            .unwrap();
        assert_eq!(fs::read(&rec.path).unwrap(), data);
        assert_eq!(files(&dir), vec!["c.bin", "index.json"]);
    }

    #[test]
    fn cancel_deletes_resumable_partial() {
        let data = body(3_000_000);
        let srv = TestServer::start(data.clone());
        let dir = tmp("dl-cancel-part");
        let store = DownloadStore::new(&dir).unwrap();
        seed_part(&dir, "k.flac", &data[..500_000], Some(3_000_000));
        let cancel = AtomicBool::new(false);
        let err = store
            .download(
                &request(&srv, "k", "flac"),
                |_| cancel.store(true, Ordering::Relaxed),
                &cancel,
            )
            .unwrap_err();
        assert!(err.to_string().contains("cancel"), "{err}");
        assert!(files(&dir).is_empty(), "{:?}", files(&dir));
    }

    #[test]
    fn custom_dir_downloads_and_both_dirs_list_and_delete() {
        let srv = TestServer::start(body(1000));
        let dir = tmp("dl-custom-default");
        let custom = tmp("dl-custom-dir");
        let store = DownloadStore::new(&dir).unwrap();
        store
            .download(
                &request(&srv, "old", "flac"),
                |_| {},
                &AtomicBool::new(false),
            )
            .unwrap();
        store.set_dir(Some(custom.to_str().unwrap())).unwrap();
        let rec = store
            .download(
                &request(&srv, "new", "flac"),
                |_| {},
                &AtomicBool::new(false),
            )
            .unwrap();
        assert_eq!(rec.path, custom.join("new.flac").to_string_lossy());
        assert_eq!(files(&custom), vec!["new.flac"]);
        assert_eq!(files(&dir), vec!["index.json", "old.flac"]);
        assert_eq!(store.list().len(), 2);
        // A fresh store (new run, default folder) still lists both.
        let again = DownloadStore::new(&dir).unwrap();
        assert_eq!(again.list().len(), 2);
        again.delete("new").unwrap();
        store.delete("old").unwrap();
        assert!(store.list().is_empty());
        assert!(files(&custom).is_empty());
        assert_eq!(files(&dir), vec!["index.json"]);
        // Back to default.
        store.set_dir(None).unwrap();
        let rec = store
            .download(&request(&srv, "x", "flac"), |_| {}, &AtomicBool::new(false))
            .unwrap();
        assert_eq!(rec.path, dir.join("x.flac").to_string_lossy());
    }

    #[test]
    fn invalid_dir_errors_and_keeps_previous() {
        let dir = tmp("dl-baddir");
        let store = DownloadStore::new(&dir).unwrap();
        assert!(store.set_dir(Some("relative/path")).is_err());
        let blocker = dir.join("afile");
        fs::write(&blocker, b"x").unwrap();
        assert!(store
            .set_dir(Some(blocker.join("sub").to_str().unwrap()))
            .is_err());
        assert_eq!(store.target_dir(), dir);
    }

    #[test]
    fn partial_in_old_dir_is_ignored_after_dir_change() {
        let data = body(300_000);
        let srv = TestServer::start(data.clone());
        let dir = tmp("dl-part-old");
        let custom = tmp("dl-part-new");
        let store = DownloadStore::new(&dir).unwrap();
        seed_part(&dir, "p.flac", &data[..100_000], Some(300_000));
        store.set_dir(Some(custom.to_str().unwrap())).unwrap();
        let rec = store
            .download(&request(&srv, "p", "flac"), |_| {}, &AtomicBool::new(false))
            .unwrap();
        assert_eq!(srv.requests(), vec![String::new()]);
        assert_eq!(fs::read(&rec.path).unwrap(), data);
    }
}
