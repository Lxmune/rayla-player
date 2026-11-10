//! Rayla Tauri backend: thin command layer over `rayla_engine`, plus secrets
//! (OS keychain; app-private file on Android) and offline downloads. Command
//! names, argument names and JSON shapes are the contract in `src/lib/ipc.ts`.

use rayla_engine::api::engine::{self as api, DiscordActivity, DspConfig, EngineEvent, OutputDevice, TrackRequest};
use rayla_engine::downloads::{DownloadProgress, DownloadRecord, DownloadRequest, DownloadStore};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State};

mod secrets;
use secrets::Secrets;

const ENGINE_EVENT: &str = "engine://event";
const DOWNLOAD_PROGRESS_EVENT: &str = "downloads://progress";

struct AppState {
    engine_init_error: Option<String>,
    downloads: Option<Arc<DownloadStore>>,
    downloads_error: Option<String>,
    cancels: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

fn err<E: std::fmt::Display>(e: E) -> String {
    format!("{e:#}")
}

// ---------------------------------------------------------------- engine

#[tauri::command]
fn engine_init_error(state: State<'_, AppState>) -> Option<String> {
    state.engine_init_error.clone()
}

#[tauri::command]
fn engine_list_devices() -> Result<Vec<OutputDevice>, String> {
    api::list_devices().map_err(err)
}

#[tauri::command]
fn engine_set_output(device_id: Option<String>, exclusive: bool) -> Result<(), String> {
    api::set_output(device_id, exclusive).map_err(err)
}

#[tauri::command]
fn engine_load(track: TrackRequest, start_playing: bool) -> Result<(), String> {
    api::load(track, start_playing).map_err(err)
}

#[tauri::command]
fn engine_set_next(track: Option<TrackRequest>) -> Result<(), String> {
    api::set_next(track).map_err(err)
}

#[tauri::command]
fn engine_play() -> Result<(), String> {
    api::play().map_err(err)
}

#[tauri::command]
fn engine_pause() -> Result<(), String> {
    api::pause().map_err(err)
}

#[tauri::command]
fn engine_stop() -> Result<(), String> {
    api::stop().map_err(err)
}

#[tauri::command]
fn engine_seek(position_ms: u64) -> Result<(), String> {
    api::seek(position_ms).map_err(err)
}

#[tauri::command]
fn engine_set_dsp(config: DspConfig) -> Result<(), String> {
    api::set_dsp(config).map_err(err)
}

#[tauri::command]
fn discord_set_activity(
    application_id: String,
    activity: Option<DiscordActivity>,
) -> Result<(), String> {
    api::discord_set_activity(application_id, activity).map_err(err)
}

// --------------------------------------------------------------- secrets

#[tauri::command]
fn secret_get(secrets: State<'_, Secrets>, key: String) -> Result<Option<String>, String> {
    secrets.get(&key)
}

#[tauri::command]
fn secret_set(secrets: State<'_, Secrets>, key: String, value: Option<String>) -> Result<(), String> {
    secrets.set(&key, value.filter(|v| !v.is_empty()))
}

// ------------------------------------------------------------- downloads

fn store(state: &AppState) -> Result<Arc<DownloadStore>, String> {
    state.downloads.clone().ok_or_else(|| {
        format!(
            "downloads unavailable: {}",
            state.downloads_error.as_deref().unwrap_or("not initialised")
        )
    })
}

#[tauri::command]
fn downloads_list(state: State<'_, AppState>) -> Result<Vec<DownloadRecord>, String> {
    Ok(store(&state)?.list())
}

#[tauri::command]
async fn downloads_start(
    app: AppHandle,
    state: State<'_, AppState>,
    request: DownloadRequest,
) -> Result<DownloadRecord, String> {
    let store = store(&state)?;
    let cancel = Arc::new(AtomicBool::new(false));
    {
        let mut map = state.cancels.lock().unwrap();
        if map.contains_key(&request.id) {
            return Err(format!("download {} already in progress", request.id));
        }
        map.insert(request.id.clone(), cancel.clone());
    }
    let id = request.id.clone();
    let emitter = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        store.download(
            &request,
            |p: DownloadProgress| {
                let _ = emitter.emit(DOWNLOAD_PROGRESS_EVENT, p);
            },
            &cancel,
        )
    })
    .await;
    state.cancels.lock().unwrap().remove(&id);
    match result {
        Ok(r) => r.map_err(err),
        Err(e) => Err(err(e)),
    }
}

#[tauri::command]
fn downloads_cancel(state: State<'_, AppState>, id: String) -> Result<(), String> {
    if let Some(flag) = state.cancels.lock().unwrap().get(&id) {
        flag.store(true, Ordering::Relaxed);
    }
    Ok(())
}

#[tauri::command]
fn downloads_delete(state: State<'_, AppState>, id: String) -> Result<(), String> {
    store(&state)?.delete(&id).map_err(err)
}

// ------------------------------------------------------------------- app

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_websocket::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let engine_init_error = app
                .path()
                .app_cache_dir()
                .map_err(err)
                .and_then(|d| api::init_engine(d.join("engine").to_string_lossy().into_owned()).map_err(err))
                .err();
            let handle = app.handle().clone();
            api::set_event_handler(Box::new(move |event: EngineEvent| {
                let _ = handle.emit(ENGINE_EVENT, event);
            }));

            app.manage(Secrets::new(app.path().app_data_dir().ok()));

            let (downloads, downloads_error) = match app
                .path()
                .app_data_dir()
                .map_err(err)
                .and_then(|d| DownloadStore::new(d.join("downloads")).map_err(err))
            {
                Ok(s) => (Some(Arc::new(s)), None),
                Err(e) => (None, Some(e)),
            };
            app.manage(AppState {
                engine_init_error,
                downloads,
                downloads_error,
                cancels: Mutex::new(HashMap::new()),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            engine_init_error,
            engine_list_devices,
            engine_set_output,
            engine_load,
            engine_set_next,
            engine_play,
            engine_pause,
            engine_stop,
            engine_seek,
            engine_set_dsp,
            discord_set_activity,
            secret_get,
            secret_set,
            downloads_list,
            downloads_start,
            downloads_cancel,
            downloads_delete,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Rayla");
}
