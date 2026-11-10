const COMMANDS: &[&str] = &[
    "update_now_playing",
    "clear_now_playing",
    "list_audio_outputs",
    "get_system_insets",
    "set_system_bars",
    // Needed by `addPluginListener` / `PluginListener.unregister` in @tauri-apps/api.
    "register_listener",
    "remove_listener",
];

fn main() {
    tauri_plugin::Builder::new(COMMANDS).android_path("android").build();
}
