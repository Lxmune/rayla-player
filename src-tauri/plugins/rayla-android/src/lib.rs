//! `rayla-android`: Kotlin foreground media service + MediaSession + output
//! enumeration. On every other platform the commands are harmless no-ops, so
//! the plugin (and its capability) can be registered everywhere.

use serde::{Deserialize, Serialize};
use tauri::{
    command,
    ipc::Channel,
    plugin::{Builder, TauriPlugin},
    AppHandle, Runtime,
};

#[cfg(target_os = "android")]
const PLUGIN_IDENTIFIER: &str = "dev.rayla.androidplugin";

#[cfg(target_os = "android")]
struct Native<R: Runtime>(tauri::plugin::PluginHandle<R>);

/// Mirrors `NowPlayingInfo` in `src/lib/android.ts`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NowPlayingInfo {
    pub title: String,
    pub artist: String,
    pub album: String,
    pub art_url: Option<String>,
    pub duration_ms: i64,
    pub position_ms: i64,
    pub playing: bool,
    pub can_previous: bool,
    pub can_next: bool,
    #[serde(default)]
    pub liked: bool,
}

/// Mirrors `OutputDevice` in `src/lib/ipc.ts`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutputDevice {
    pub id: String,
    pub name: String,
    pub is_default: bool,
    pub supports_exclusive: bool,
    pub sample_rates: Vec<u32>,
    pub max_bit_depth: u32,
}

#[cfg(target_os = "android")]
#[derive(Deserialize)]
struct DevicesResponse {
    devices: Vec<OutputDevice>,
}

#[cfg(target_os = "android")]
fn native<R: Runtime>(app: &AppHandle<R>) -> Result<tauri::plugin::PluginHandle<R>, String> {
    use tauri::Manager;
    app.try_state::<Native<R>>()
        .map(|n| n.0.clone())
        .ok_or_else(|| "rayla-android plugin not initialised".to_string())
}

#[command]
async fn update_now_playing<R: Runtime>(app: AppHandle<R>, info: NowPlayingInfo) -> Result<(), String> {
    #[cfg(target_os = "android")]
    native(&app)?
        .run_mobile_plugin_async::<()>("updateNowPlaying", serde_json::json!({ "info": info }))
        .await
        .map_err(|e| e.to_string())?;
    #[cfg(not(target_os = "android"))]
    let _ = (app, info);
    Ok(())
}

#[command]
async fn clear_now_playing<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    #[cfg(target_os = "android")]
    native(&app)?
        .run_mobile_plugin_async::<()>("clearNowPlaying", ())
        .await
        .map_err(|e| e.to_string())?;
    #[cfg(not(target_os = "android"))]
    let _ = app;
    Ok(())
}

#[command]
async fn list_audio_outputs<R: Runtime>(app: AppHandle<R>) -> Result<Vec<OutputDevice>, String> {
    #[cfg(target_os = "android")]
    {
        let r: DevicesResponse = native(&app)?
            .run_mobile_plugin_async("listAudioOutputs", ())
            .await
            .map_err(|e| e.to_string())?;
        Ok(r.devices)
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        Ok(Vec::new())
    }
}

/// Mirrors `SystemInsets` in `src/lib/android.ts` (CSS px).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemInsets {
    pub top: f64,
}

#[command]
async fn get_system_insets<R: Runtime>(app: AppHandle<R>) -> Result<SystemInsets, String> {
    #[cfg(target_os = "android")]
    return native(&app)?
        .run_mobile_plugin_async("getSystemInsets", ())
        .await
        .map_err(|e| e.to_string());
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        Ok(SystemInsets::default())
    }
}

/// Status / navigation bar icon colour and the window colour behind the bars.
#[command]
async fn set_system_bars<R: Runtime>(app: AppHandle<R>, light_background: bool, background: String) -> Result<(), String> {
    #[cfg(target_os = "android")]
    native(&app)?
        .run_mobile_plugin_async::<()>(
            "setSystemBars",
            serde_json::json!({ "lightBackground": light_background, "background": background }),
        )
        .await
        .map_err(|e| e.to_string())?;
    #[cfg(not(target_os = "android"))]
    let _ = (app, light_background, background);
    Ok(())
}

/// Mirrors `NetworkType` in `src/lib/android.ts`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NetworkInfo {
    #[serde(rename = "type")]
    pub kind: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BoolValue {
    pub value: bool,
}

/// Mirrors `StorageVolume` in `src/lib/android.ts`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageVolume {
    pub path: String,
    pub label: String,
    pub removable: bool,
    pub free_bytes: u64,
    pub total_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VolumesResponse {
    pub volumes: Vec<StorageVolume>,
}

#[command]
async fn get_network_type<R: Runtime>(app: AppHandle<R>) -> Result<NetworkInfo, String> {
    #[cfg(target_os = "android")]
    return native(&app)?
        .run_mobile_plugin_async("getNetworkType", ())
        .await
        .map_err(|e| e.to_string());
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        Ok(NetworkInfo { kind: "other".into() })
    }
}

#[command]
async fn is_ignoring_battery_optimizations<R: Runtime>(app: AppHandle<R>) -> Result<BoolValue, String> {
    #[cfg(target_os = "android")]
    return native(&app)?
        .run_mobile_plugin_async("isIgnoringBatteryOptimizations", ())
        .await
        .map_err(|e| e.to_string());
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        Ok(BoolValue { value: true })
    }
}

#[command]
async fn request_ignore_battery_optimizations<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    #[cfg(target_os = "android")]
    native(&app)?
        .run_mobile_plugin_async::<()>("requestIgnoreBatteryOptimizations", ())
        .await
        .map_err(|e| e.to_string())?;
    #[cfg(not(target_os = "android"))]
    let _ = app;
    Ok(())
}

#[command]
async fn list_storage_volumes<R: Runtime>(app: AppHandle<R>) -> Result<VolumesResponse, String> {
    #[cfg(target_os = "android")]
    return native(&app)?
        .run_mobile_plugin_async("listStorageVolumes", ())
        .await
        .map_err(|e| e.to_string());
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        Ok(VolumesResponse { volumes: Vec::new() })
    }
}

/// Used by `addPluginListener`: forwards the JS channel to the Kotlin plugin.
#[command]
async fn register_listener<R: Runtime>(
    app: AppHandle<R>,
    event: String,
    handler: Channel<serde_json::Value>,
) -> Result<(), String> {
    #[cfg(target_os = "android")]
    native(&app)?
        .run_mobile_plugin_async::<()>("registerListener", serde_json::json!({ "event": event, "handler": handler }))
        .await
        .map_err(|e| e.to_string())?;
    #[cfg(not(target_os = "android"))]
    let _ = (app, event, handler);
    Ok(())
}

#[command]
async fn remove_listener<R: Runtime>(app: AppHandle<R>, event: String, channel_id: u32) -> Result<(), String> {
    #[cfg(target_os = "android")]
    native(&app)?
        .run_mobile_plugin_async::<()>("removeListener", serde_json::json!({ "event": event, "channelId": channel_id }))
        .await
        .map_err(|e| e.to_string())?;
    #[cfg(not(target_os = "android"))]
    let _ = (app, event, channel_id);
    Ok(())
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("rayla-android")
        .invoke_handler(tauri::generate_handler![
            update_now_playing,
            clear_now_playing,
            list_audio_outputs,
            get_system_insets,
            set_system_bars,
            get_network_type,
            is_ignoring_battery_optimizations,
            request_ignore_battery_optimizations,
            list_storage_volumes,
            register_listener,
            remove_listener
        ])
        .setup(|app, api| {
            #[cfg(target_os = "android")]
            {
                use tauri::Manager;
                let handle = api.register_android_plugin(PLUGIN_IDENTIFIER, "RaylaAndroidPlugin")?;
                app.manage(Native(handle));
            }
            #[cfg(not(target_os = "android"))]
            let _ = (app, api);
            Ok(())
        })
        .build()
}
