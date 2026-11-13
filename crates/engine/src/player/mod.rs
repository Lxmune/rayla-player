//! Playback engine behind `crate::api::engine`.

mod dsp;
pub mod engine;
mod pipeline;
#[cfg(test)]
pub(crate) mod tests;

use crate::api::engine::*;
use crate::output::{self, Backend};
use crate::source::{self, Prefetcher};
use anyhow::{anyhow, Result};
use engine::{Cmd, Engine};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};

static ENGINE: OnceLock<Engine> = OnceLock::new();
static BACKEND: OnceLock<Arc<dyn Backend>> = OnceLock::new();
type Handler = Arc<dyn Fn(EngineEvent) + Send + Sync>;
static PREFETCH: OnceLock<Prefetcher> = OnceLock::new();
static CACHE_DIR: OnceLock<PathBuf> = OnceLock::new();
static SINK: Mutex<Option<Handler>> = Mutex::new(None);

fn backend() -> Arc<dyn Backend> {
    BACKEND.get_or_init(output::default_backend).clone()
}

fn engine() -> Result<&'static Engine> {
    ENGINE
        .get()
        .ok_or_else(|| anyhow!("engine not initialised; call init_engine first"))
}

pub fn init(cache_dir: String) -> Result<()> {
    let dir = PathBuf::from(cache_dir);
    std::fs::create_dir_all(&dir)?;
    // Download speed measured by the cache downloaders becomes events.
    source::set_throughput_hook(Arc::new(|track_id, bps| {
        let handler = SINK.lock().unwrap().clone();
        if let Some(h) = handler {
            h(EngineEvent {
                kind: EventKind::Throughput,
                state: PlaybackState::Stopped,
                track_id: Some(track_id.to_string()),
                entry_id: None,
                position_ms: 0,
                duration_ms: 0,
                signal_path: None,
                message: None,
                throughput_bps: bps,
                cached_bytes: 0,
                total_bytes: 0,
            });
        }
    }));
    // Cache fill level of tracks being fetched becomes events.
    source::set_progress_hook(Arc::new(|track_id, cached, total| {
        let handler = SINK.lock().unwrap().clone();
        if let Some(h) = handler {
            h(EngineEvent {
                kind: EventKind::FetchProgress,
                state: PlaybackState::Stopped,
                track_id: Some(track_id.to_string()),
                entry_id: None,
                position_ms: 0,
                duration_ms: 0,
                signal_path: None,
                message: None,
                throughput_bps: 0,
                cached_bytes: cached,
                total_bytes: total,
            });
        }
    }));
    let _ = CACHE_DIR.set(dir.clone());
    source::prune_cache(&dir);
    PREFETCH.get_or_init(|| Prefetcher::new(dir.clone()));
    ENGINE.get_or_init(|| {
        // Events are handed to their own thread: the engine thread feeds the
        // device and must never wait on the UI side (webview, event loop).
        let (tx, rx) = std::sync::mpsc::channel::<EngineEvent>();
        std::thread::Builder::new()
            .name("rayla-events".into())
            .spawn(move || {
                for e in rx {
                    let handler = SINK.lock().unwrap().clone();
                    if let Some(h) = handler {
                        h(e);
                    }
                }
            })
            .expect("spawn event thread");
        let tx = Mutex::new(tx);
        let emit: engine::EmitFn = Arc::new(move |e| {
            let _ = tx.lock().unwrap().send(e);
        });
        Engine::start(dir, backend(), emit)
    });
    Ok(())
}

pub fn set_event_handler(handler: Box<dyn Fn(EngineEvent) + Send + Sync>) {
    *SINK.lock().unwrap() = Some(Arc::from(handler));
}

pub fn list_devices() -> Result<Vec<OutputDevice>> {
    backend().list_devices()
}

pub fn set_output(device_id: Option<String>, exclusive: bool) -> Result<()> {
    engine()?.send(Cmd::SetOutput(device_id, exclusive))
}

pub fn load(track: TrackRequest, start_playing: bool) -> Result<()> {
    engine()?.send(Cmd::Load(track, start_playing))
}

pub fn set_next(track: Option<TrackRequest>) -> Result<()> {
    engine()?.send(Cmd::SetNext(track))
}

pub fn prefetch(tracks: Vec<TrackRequest>) -> Result<()> {
    PREFETCH
        .get()
        .ok_or_else(|| anyhow!("engine not initialised; call init_engine first"))?
        .set(tracks);
    Ok(())
}

fn cache_dir() -> Result<&'static PathBuf> {
    CACHE_DIR
        .get()
        .ok_or_else(|| anyhow!("engine not initialised; call init_engine first"))
}

pub fn cache_stats() -> Result<CacheStats> {
    Ok(source::cache_stats(cache_dir()?))
}

pub fn cache_clear() -> Result<()> {
    source::cache_clear(cache_dir()?);
    Ok(())
}

pub fn cache_set_limit(bytes: u64) -> Result<()> {
    source::cache_set_limit(cache_dir()?, bytes);
    Ok(())
}

pub fn cached_tracks(tracks: Vec<TrackRequest>) -> Result<Vec<String>> {
    Ok(source::cached_tracks(cache_dir()?, &tracks))
}

pub fn play() -> Result<()> {
    engine()?.send(Cmd::Play)
}

pub fn pause() -> Result<()> {
    engine()?.send(Cmd::Pause)
}

pub fn stop() -> Result<()> {
    engine()?.send(Cmd::Stop)
}

pub fn seek(position_ms: u64) -> Result<()> {
    engine()?.send(Cmd::Seek(position_ms))
}

pub fn set_dsp(config: DspConfig) -> Result<()> {
    engine()?.send(Cmd::SetDsp(config))
}
