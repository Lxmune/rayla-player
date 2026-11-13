//! Background prefetch: downloads a list of tracks completely into the
//! stream cache, one at a time, in order. Each `set` replaces the list; a
//! download in flight for a track that was dropped is aborted (unless a
//! player source still uses the same cache entry).

use super::cache::{self, Status};
use crate::api::engine::TrackRequest;
use std::path::PathBuf;
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

#[derive(Default)]
struct List {
    tracks: Vec<TrackRequest>,
    /// Bumped on every `set`.
    generation: u64,
}

pub struct Prefetcher {
    shared: Arc<(Mutex<List>, Condvar)>,
}

impl Prefetcher {
    pub fn new(cache_dir: PathBuf) -> Prefetcher {
        let shared = Arc::new((Mutex::new(List::default()), Condvar::new()));
        let s = shared.clone();
        std::thread::Builder::new()
            .name("rayla-prefetch".into())
            .spawn(move || worker(s, cache_dir))
            .expect("spawn prefetch thread");
        Prefetcher { shared }
    }

    /// Replace the list. Local files need no download and are skipped.
    pub fn set(&self, tracks: Vec<TrackRequest>) {
        let (m, cv) = &*self.shared;
        let mut g = m.lock().unwrap();
        g.tracks = tracks
            .into_iter()
            .filter(|t| t.local_path.is_none())
            .collect();
        g.generation += 1;
        cv.notify_all();
    }
}

fn worker(shared: Arc<(Mutex<List>, Condvar)>, cache_dir: PathBuf) {
    let (m, cv) = &*shared;
    loop {
        let (tracks, generation) = {
            let g = m.lock().unwrap();
            (g.tracks.clone(), g.generation)
        };
        let replaced = || m.lock().unwrap().generation != generation;
        'tracks: for t in tracks {
            let headers: Vec<(String, String)> = t
                .headers
                .iter()
                .map(|h| (h.name.clone(), h.value.clone()))
                .collect();
            let key = cache::cache_key(&t.id, &t.url);
            let Ok(handle) = cache::attach(&t.url, &headers, &cache_dir, &key, &t.id) else {
                continue;
            };
            // Complete entries return at once; failures move on to the next track.
            loop {
                match handle.wait(Duration::from_millis(300)) {
                    Status::Complete | Status::Failed => break,
                    Status::Pending if replaced() => break 'tracks,
                    Status::Pending => {}
                }
            }
        }
        // List done (or replaced): sleep until the next `set`.
        let mut g = m.lock().unwrap();
        while g.generation == generation {
            g = cv.wait(g).unwrap();
        }
    }
}
