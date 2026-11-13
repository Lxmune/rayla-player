//! Desktop OS media controls: media keys, Windows SMTC, macOS Now Playing,
//! Linux MPRIS. FROZEN CONTRACT with `ipc.mediaUpdateNowPlaying`,
//! `ipc.mediaClearNowPlaying` and the `media://action` event (payload =
//! `MediaAction` in src/lib/android.ts). No-op on Android (the rayla-android
//! plugin owns the media session there).
//!
//! Backend: `souvlaki` 0.8 (zbus feature on Linux). The `MediaControls` handle is created
//! on the main thread in `setup` (Windows' SMTC needs the main window's HWND and an
//! initialised COM thread; macOS needs the main-thread event loop, which Tauri runs) and then
//! only ever touched on that thread: commands hop over with `run_on_main_thread`, so the
//! platform handles never cross threads. Any init failure leaves the commands as no-ops.

use serde::{Deserialize, Serialize};

/// Mirrors `NowPlayingInfo` in src/lib/android.ts.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NowPlayingInfo {
    pub title: String,
    pub artist: String,
    pub album: String,
    pub art_url: Option<String>,
    pub duration_ms: u64,
    pub position_ms: u64,
    pub playing: bool,
    pub can_previous: bool,
    pub can_next: bool,
}

/// Emitted as `media://action`; mirrors `MediaAction` in src/lib/android.ts.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
#[cfg_attr(any(target_os = "android", target_os = "ios"), allow(dead_code))]
pub enum MediaAction {
    Play,
    Pause,
    Next,
    Previous,
    Stop,
    #[serde(rename_all = "camelCase")]
    Seek {
        position_ms: u64,
    },
}

#[cfg_attr(any(target_os = "android", target_os = "ios"), allow(dead_code))]
pub const MEDIA_ACTION_EVENT: &str = "media://action";

/// Platform-independent core; depends only on souvlaki and std so it can be checked on its own.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
mod desktop {
    use super::{MediaAction, NowPlayingInfo};
    use souvlaki::{
        MediaControlEvent, MediaControls, MediaMetadata, MediaPlayback, MediaPosition,
        PlatformConfig, SeekDirection,
    };
    use std::ffi::c_void;
    use std::sync::{Arc, Mutex};
    use std::time::{Duration, Instant};

    /// Step used for a `Seek(direction)` event that carries no offset.
    const DEFAULT_SEEK_STEP_MS: u64 = 10_000;

    /// Last state pushed to the OS; needed to resolve Toggle and relative seeks.
    #[derive(Debug)]
    pub struct Shared {
        pub playing: bool,
        pub position_ms: u64,
        pub duration_ms: u64,
        pub at: Instant,
    }

    impl Shared {
        pub fn new() -> Self {
            Shared {
                playing: false,
                position_ms: 0,
                duration_ms: 0,
                at: Instant::now(),
            }
        }

        /// Position extrapolated from the last update while playing.
        pub fn position_now(&self) -> u64 {
            let mut p = self.position_ms;
            if self.playing {
                p += self.at.elapsed().as_millis() as u64;
            }
            if self.duration_ms > 0 {
                p = p.min(self.duration_ms);
            }
            p
        }

        fn seek_to(&self, ms: u64) -> MediaAction {
            let ms = if self.duration_ms > 0 {
                ms.min(self.duration_ms)
            } else {
                ms
            };
            MediaAction::Seek { position_ms: ms }
        }
    }

    /// Maps an OS event to the frontend action; `None` for events the app ignores.
    pub fn map_event(ev: MediaControlEvent, st: &Shared) -> Option<MediaAction> {
        match ev {
            MediaControlEvent::Play => Some(MediaAction::Play),
            MediaControlEvent::Pause => Some(MediaAction::Pause),
            MediaControlEvent::Toggle => Some(if st.playing {
                MediaAction::Pause
            } else {
                MediaAction::Play
            }),
            MediaControlEvent::Next => Some(MediaAction::Next),
            MediaControlEvent::Previous => Some(MediaAction::Previous),
            MediaControlEvent::Stop => Some(MediaAction::Stop),
            MediaControlEvent::SetPosition(MediaPosition(d)) => {
                Some(st.seek_to(d.as_millis() as u64))
            }
            MediaControlEvent::Seek(dir) => Some(relative_seek(st, dir, DEFAULT_SEEK_STEP_MS)),
            MediaControlEvent::SeekBy(dir, d) => Some(relative_seek(st, dir, d.as_millis() as u64)),
            MediaControlEvent::SetVolume(_)
            | MediaControlEvent::OpenUri(_)
            | MediaControlEvent::Raise
            | MediaControlEvent::Quit => None,
        }
    }

    fn relative_seek(st: &Shared, dir: SeekDirection, by_ms: u64) -> MediaAction {
        let cur = st.position_now();
        st.seek_to(match dir {
            SeekDirection::Forward => cur.saturating_add(by_ms),
            SeekDirection::Backward => cur.saturating_sub(by_ms),
        })
    }

    pub struct Session {
        controls: MediaControls,
        state: Arc<Mutex<Shared>>,
    }

    impl Session {
        /// `hwnd` is the main window handle on Windows, `None` elsewhere.
        pub fn new(
            hwnd: Option<*mut c_void>,
            emit: impl Fn(MediaAction) + Send + 'static,
        ) -> Result<Self, String> {
            let mut controls = MediaControls::new(PlatformConfig {
                dbus_name: "rayla",
                display_name: "Rayla",
                hwnd,
            })
            .map_err(|e| format!("{e:?}"))?;
            let state = Arc::new(Mutex::new(Shared::new()));
            let st = state.clone();
            controls
                .attach(move |ev: MediaControlEvent| {
                    let action = match st.lock() {
                        Ok(g) => map_event(ev, &g),
                        Err(_) => None,
                    };
                    if let Some(a) = action {
                        emit(a);
                    }
                })
                .map_err(|e| format!("{e:?}"))?;
            Ok(Session { controls, state })
        }

        pub fn update(&mut self, info: &NowPlayingInfo) -> Result<(), String> {
            if let Ok(mut g) = self.state.lock() {
                *g = Shared {
                    playing: info.playing,
                    position_ms: info.position_ms,
                    duration_ms: info.duration_ms,
                    at: Instant::now(),
                };
            }
            let duration = (info.duration_ms > 0).then(|| Duration::from_millis(info.duration_ms));
            self.controls
                .set_metadata(MediaMetadata {
                    title: Some(&info.title),
                    artist: Some(&info.artist),
                    album: Some(&info.album),
                    cover_url: info.art_url.as_deref(),
                    duration,
                })
                .map_err(|e| format!("{e:?}"))?;
            let progress = Some(MediaPosition(Duration::from_millis(info.position_ms)));
            self.controls
                .set_playback(if info.playing {
                    MediaPlayback::Playing { progress }
                } else {
                    MediaPlayback::Paused { progress }
                })
                .map_err(|e| format!("{e:?}"))
        }

        pub fn clear(&mut self) -> Result<(), String> {
            if let Ok(mut g) = self.state.lock() {
                *g = Shared::new();
            }
            self.controls
                .set_playback(MediaPlayback::Stopped)
                .map_err(|e| format!("{e:?}"))?;
            self.controls
                .set_metadata(MediaMetadata::default())
                .map_err(|e| format!("{e:?}"))
        }
    }
}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
thread_local! {
    /// Main-thread only (created in `setup`, used via `run_on_main_thread`).
    static SESSION: std::cell::RefCell<Option<desktop::Session>> = const { std::cell::RefCell::new(None) };
}

/// Called once from the Tauri `setup` hook (main thread).
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub fn setup(app: &mut tauri::App) {
    use tauri::{Emitter, Manager};
    let win = app
        .get_webview_window("main")
        .or_else(|| app.webview_windows().into_values().next());
    #[cfg(target_os = "windows")]
    let hwnd: Option<*mut std::ffi::c_void> = match win.as_ref().map(|w| w.hwnd()) {
        Some(Ok(h)) => Some(h.0 as *mut std::ffi::c_void),
        _ => {
            eprintln!("media controls: no window handle, disabled");
            return;
        }
    };
    #[cfg(not(target_os = "windows"))]
    let hwnd: Option<*mut std::ffi::c_void> = {
        let _ = &win;
        None
    };
    let handle = app.handle().clone();
    match desktop::Session::new(hwnd, move |a| {
        let _ = handle.emit(MEDIA_ACTION_EVENT, a);
    }) {
        Ok(s) => SESSION.with(|cell| *cell.borrow_mut() = Some(s)),
        Err(e) => eprintln!("media controls unavailable: {e}"),
    }
}

#[cfg(any(target_os = "android", target_os = "ios"))]
pub fn setup(_app: &mut tauri::App) {}

#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn with_session(
    app: &tauri::AppHandle,
    f: impl FnOnce(&mut desktop::Session) -> Result<(), String> + Send + 'static,
) -> Result<(), String> {
    let run = app.run_on_main_thread(move || {
        SESSION.with(|cell| {
            // Not initialised (no D-Bus session, no window, ...): silently a no-op.
            if let Some(s) = cell.borrow_mut().as_mut() {
                if let Err(e) = f(s) {
                    eprintln!("media controls: {e}");
                }
            }
        })
    });
    if let Err(e) = run {
        eprintln!("media controls: {e}");
    }
    Ok(())
}

#[tauri::command]
pub fn media_update_now_playing(app: tauri::AppHandle, info: NowPlayingInfo) -> Result<(), String> {
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    return with_session(&app, move |s| s.update(&info));
    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        let _ = (app, info);
        Ok(())
    }
}

#[tauri::command]
pub fn media_clear_now_playing(app: tauri::AppHandle) -> Result<(), String> {
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    return with_session(&app, |s| s.clear());
    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        let _ = app;
        Ok(())
    }
}
