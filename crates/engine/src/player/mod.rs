//! Playback engine behind `crate::api::engine`.

mod dsp;
pub mod engine;
mod pipeline;
#[cfg(test)]
pub(crate) mod tests;

use crate::api::engine::*;
use crate::output::{self, Backend};
use anyhow::{anyhow, Result};
use engine::{Cmd, Engine};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};

static ENGINE: OnceLock<Engine> = OnceLock::new();
static BACKEND: OnceLock<Arc<dyn Backend>> = OnceLock::new();
type Handler = Arc<dyn Fn(EngineEvent) + Send + Sync>;
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
    ENGINE.get_or_init(|| {
        let emit: engine::EmitFn = Arc::new(|e| {
            let handler = SINK.lock().unwrap().clone();
            if let Some(h) = handler {
                h(e);
            }
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
