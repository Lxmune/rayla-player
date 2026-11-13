const COMMANDS: &[&str] = &[
    "update_now_playing",
    "clear_now_playing",
    "list_audio_outputs",
    "get_system_insets",
    "set_system_bars",
    "get_network_type",
    "is_ignoring_battery_optimizations",
    "request_ignore_battery_optimizations",
    "list_storage_volumes",
    // Needed by `addPluginListener` / `PluginListener.unregister` in @tauri-apps/api.
    "register_listener",
    "remove_listener",
];

fn main() {
    tauri_plugin::Builder::new(COMMANDS)
        .android_path("android")
        .build();
}
