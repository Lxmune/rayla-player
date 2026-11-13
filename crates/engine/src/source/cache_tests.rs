//! Progress events, cache stats / clear / limit and the "which tracks are cached" query.

use super::cache::{self, Status};
use super::cache_stats;
use crate::api::engine::{HttpHeader, TrackRequest};
use crate::player::tests::{body, hdrs, tmp, TestServer};
use std::sync::{Arc, Mutex};
use std::time::Duration;

fn request(id: &str, url: String) -> TrackRequest {
    TrackRequest {
        id: id.into(),
        entry_id: "e".into(),
        url,
        headers: vec![HttpHeader {
            name: "X-Token".into(),
            value: "secret".into(),
        }],
        local_path: None,
        album_id: None,
        fallback_gain_db: None,
    }
}

fn fetch_fully(dir: &std::path::Path, t: &TrackRequest) -> cache::Handle {
    let key = cache::cache_key(&t.id, &t.url);
    let h = cache::attach(&t.url, &hdrs(), dir, &key, &t.id).unwrap();
    assert!(matches!(h.wait(Duration::from_secs(20)), Status::Complete));
    h
}

#[test]
fn fetch_progress_events_end_with_a_complete_one() {
    let data = body(800_000);
    let srv = TestServer::start(data);
    let got: Arc<Mutex<Vec<(String, u64, u64)>>> = Arc::default();
    let g = got.clone();
    super::set_progress_hook(Arc::new(move |id, c, t| {
        g.lock().unwrap().push((id.into(), c, t))
    }));
    let dir = tmp("progress");
    let t = request("prog-track", srv.url());
    let _h = fetch_fully(&dir, &t);
    // The final event is emitted just after `complete` is published.
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    loop {
        let ev: Vec<_> = got
            .lock()
            .unwrap()
            .iter()
            .filter(|e| e.0 == "prog-track")
            .cloned()
            .collect();
        if ev.last().is_some_and(|e| e.1 == 800_000 && e.2 == 800_000) {
            assert_eq!(ev.iter().filter(|e| e.1 == e.2).count(), 1, "{ev:?}");
            assert!(ev.windows(2).all(|w| w[0].1 <= w[1].1), "monotonic: {ev:?}");
            break;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "no complete event: {ev:?}"
        );
        std::thread::sleep(Duration::from_millis(5));
    }
}

#[test]
fn stats_clear_and_cached_tracks() {
    let srv = TestServer::start(body(100_000));
    let dir = tmp("stats");
    assert_eq!(cache_stats(&dir).entries, 0);
    let a = request("a", srv.url());
    let b = request("b", srv.url());
    let held = fetch_fully(&dir, &a);
    drop(fetch_fully(&dir, &b));
    let s = cache_stats(&dir);
    assert_eq!(s.entries, 2);
    assert!(s.used_bytes >= 200_000, "{s:?}");

    let mut local = request("c", srv.url());
    local.local_path = Some("/x.flac".into());
    let missing = request("d", srv.url());
    let mut ids = super::cached_tracks(&dir, &[a.clone(), b.clone(), local, missing]);
    ids.sort();
    assert_eq!(ids, vec!["a", "b"]);
    // Same id with another URL is a different entry.
    assert!(super::cached_tracks(&dir, &[request("a", format!("{}?x=1", srv.url()))]).is_empty());

    // Clear keeps the entry that is still held (a), drops the unused one (b).
    super::cache_clear(&dir);
    let ids = super::cached_tracks(&dir, &[a.clone(), b.clone()]);
    assert_eq!(ids, vec!["a"]);
    assert_eq!(cache_stats(&dir).entries, 1);
    drop(held);
    super::cache_clear(&dir);
    assert_eq!(cache_stats(&dir).entries, 0);
    assert_eq!(cache_stats(&dir).used_bytes, 0);
}

#[test]
fn set_limit_prunes_immediately() {
    let dir = tmp("limit");
    let old = cache::limit();
    for (i, name) in ["x1", "x2", "x3"].iter().enumerate() {
        let p = dir.join(format!("{name}.audio"));
        std::fs::write(&p, vec![0u8; 1000]).unwrap();
        std::fs::write(dir.join(format!("{name}.meta")), "1000\n0 1000\n").unwrap();
        let f = std::fs::OpenOptions::new().write(true).open(&p).unwrap();
        f.set_modified(std::time::SystemTime::UNIX_EPOCH + Duration::from_secs(100 + i as u64))
            .unwrap();
    }
    super::cache_set_limit(&dir, 2500);
    let s = cache_stats(&dir);
    cache::set_limit(old);
    assert_eq!(s.limit_bytes, 2500);
    assert_eq!(s.entries, 2);
    assert!(!dir.join("x1.audio").exists());
}
