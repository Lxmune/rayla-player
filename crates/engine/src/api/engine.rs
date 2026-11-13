//! The only surface exposed to Dart. Dart owns Jellyfin browsing and queue
//! order; the engine owns everything from "URL + headers" to the DAC.
//! Commands go in through these functions, state comes back on `events`.

use crate::player;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpHeader {
    pub name: String,
    pub value: String,
}

/// One track to play. `id` is opaque to the engine (the Jellyfin item id) and
/// doubles as the cache key: a fully cached track is an offline download.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackRequest {
    pub id: String,
    /// Opaque queue-entry id chosen by Dart. Echoed on every event about this
    /// track, so the same `id` queued twice can still be told apart.
    pub entry_id: String,
    pub url: String,
    pub headers: Vec<HttpHeader>,
    /// Play this local file instead of `url` when set.
    pub local_path: Option<String>,
    /// Used to pick album gain and to suppress crossfade inside an album.
    pub album_id: Option<String>,
    /// Gain from Jellyfin, used only when the file carries no ReplayGain tags.
    pub fallback_gain_db: Option<f64>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutputDevice {
    pub id: String,
    pub name: String,
    pub is_default: bool,
    pub supports_exclusive: bool,
    pub sample_rates: Vec<u32>,
    pub max_bit_depth: u32,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PlaybackState {
    Stopped,
    Buffering,
    Playing,
    Paused,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ReplayGainMode {
    Off,
    Track,
    Album,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum EqBandKind {
    Peak,
    LowShelf,
    HighShelf,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EqBand {
    pub kind: EqBandKind,
    pub freq_hz: f64,
    pub gain_db: f64,
    pub q: f64,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CrossfeedLevel {
    Off,
    Low,
    Medium,
    High,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DitherMode {
    Off,
    Tpdf,
    Shaped,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DsdMode {
    /// DSD over PCM (DoP) when the output is exclusive, the DSP chain is fully
    /// bypassed and the device supports the DoP carrier rate; otherwise falls
    /// back to `Pcm` (the signal path says which one is active).
    Dop,
    /// Always convert DSD to PCM (352.8 kHz) and run the normal chain.
    Pcm,
}

/// Downward compressor; `enabled: false` removes the stage.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompressorConfig {
    pub enabled: bool,
    pub threshold_db: f64,
    pub ratio: f64,
    pub attack_ms: f64,
    pub release_ms: f64,
    pub makeup_db: f64,
}

impl Default for CompressorConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            threshold_db: -18.0,
            ratio: 3.0,
            attack_ms: 10.0,
            release_ms: 150.0,
            makeup_db: 0.0,
        }
    }
}

/// Whole DSP chain configuration. Everything off/empty with `volume == 1.0`
/// means the engine passes decoded samples to the device untouched.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DspConfig {
    pub volume: f64,
    pub replay_gain: ReplayGainMode,
    pub preamp_db: f64,
    pub clip_guard: bool,
    pub eq_enabled: bool,
    pub eq_preamp_db: f64,
    pub eq_bands: Vec<EqBand>,
    /// WAV impulse response for convolution; `None` disables the stage.
    pub convolution_path: Option<String>,
    pub crossfeed: CrossfeedLevel,
    /// Missing in configs from older frontends: defaults to off.
    #[serde(default)]
    pub compressor: CompressorConfig,
    /// Force this output rate. `None` plays at the source rate, or at the
    /// nearest rate the (exclusive-mode) device supports.
    pub resample_to: Option<u32>,
    pub dither: DitherMode,
    /// 0 disables crossfade. Never applied between tracks of one album.
    pub crossfade_ms: u32,
    pub dsd: DsdMode,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SignalPath {
    pub codec: String,
    pub source_sample_rate: u32,
    /// 0 for lossy and floating-point sources (no meaningful integer depth).
    pub source_bit_depth: u32,
    pub channels: u32,
    /// Human-readable active stages in order, e.g. "ReplayGain -6.2 dB".
    pub stages: Vec<String>,
    pub device_name: String,
    pub output_sample_rate: u32,
    pub output_bit_depth: u32,
    pub exclusive: bool,
    pub bit_perfect: bool,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum EventKind {
    /// `state` changed.
    StateChanged,
    /// Periodic `position_ms` / `duration_ms` for `track_id` (about 5 Hz).
    /// The position counts frames handed to the device (audio still held in
    /// the engine for crossfade is not included).
    Position,
    /// `track_id` became the audible track (also on gapless advance).
    TrackStarted,
    /// `track_id` played to its end.
    TrackEnded,
    /// `signal_path` changed.
    SignalPathChanged,
    /// `message` describes a failure, for `track_id` when it is set.
    Error,
    /// Network rate (`throughput_bps`) measured while fetching `track_id` into the cache.
    Throughput,
    /// `cached_bytes` of `total_bytes` of `track_id`'s stream-cache entry are on disk
    /// (about 2 Hz while its downloader progresses, and once when complete).
    FetchProgress,
}

/// Flat event record; which fields are meaningful depends on `kind`.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineEvent {
    pub kind: EventKind,
    pub state: PlaybackState,
    pub track_id: Option<String>,
    /// `TrackRequest::entry_id` of the track the event is about (set on
    /// TrackStarted, TrackEnded, Position, Error and track-related state/path
    /// events).
    pub entry_id: Option<String>,
    pub position_ms: u64,
    pub duration_ms: u64,
    pub signal_path: Option<SignalPath>,
    pub message: Option<String>,
    /// Network rate in bits/s; set on `Throughput` events, else 0.
    #[serde(default)]
    pub throughput_bps: u64,
    /// Set on `FetchProgress` events, else 0.
    #[serde(default)]
    pub cached_bytes: u64,
    /// Length of the file for `FetchProgress` events; 0 = unknown, else 0.
    #[serde(default)]
    pub total_bytes: u64,
}

/// Size of the stream cache.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheStats {
    pub used_bytes: u64,
    pub limit_bytes: u64,
    pub entries: u64,
}

/// Start the engine. `cache_dir` holds stream cache and downloads.
pub fn init_engine(cache_dir: String) -> anyhow::Result<()> {
    player::init(cache_dir)
}

/// Register the event handler. A new handler replaces the previous one.
pub fn set_event_handler(handler: Box<dyn Fn(EngineEvent) + Send + Sync>) {
    player::set_event_handler(handler)
}

pub fn list_devices() -> anyhow::Result<Vec<OutputDevice>> {
    player::list_devices()
}

/// `device_id == None` selects the system default device. Returns as soon as
/// the command is queued; failures arrive as `Error` events.
pub fn set_output(device_id: Option<String>, exclusive: bool) -> anyhow::Result<()> {
    player::set_output(device_id, exclusive)
}

/// Replace the current track. Clears any queued next track. Returns as soon
/// as the command is queued; opening, decoding and device failures arrive
/// later as `Error` events carrying the track's `entry_id`.
pub fn load(track: TrackRequest, start_playing: bool) -> anyhow::Result<()> {
    player::load(track, start_playing)
}

/// Track to continue with gaplessly when the current one ends.
pub fn set_next(track: Option<TrackRequest>) -> anyhow::Result<()> {
    player::set_next(track)
}

/// Download these tracks completely into the stream cache in the background,
/// in order, one at a time. Each call replaces the previous list; tracks no
/// longer listed are dropped (their download is aborted unless playback uses
/// the same entry). Complete entries and tracks with `local_path` are skipped.
pub fn prefetch(tracks: Vec<TrackRequest>) -> anyhow::Result<()> {
    player::prefetch(tracks)
}

/// Size, limit and entry count of the stream cache.
pub fn cache_stats() -> anyhow::Result<CacheStats> {
    player::cache_stats()
}

/// Delete every stream-cache entry that is not currently in use.
pub fn cache_clear() -> anyhow::Result<()> {
    player::cache_clear()
}

/// Set the stream-cache size limit (bytes) and prune to it immediately.
pub fn cache_set_limit(bytes: u64) -> anyhow::Result<()> {
    player::cache_set_limit(bytes)
}

/// Ids of the tracks whose stream-cache entry is completely on disk.
/// Tracks with a `local_path` are skipped.
pub fn cached_tracks(tracks: Vec<TrackRequest>) -> anyhow::Result<Vec<String>> {
    player::cached_tracks(tracks)
}

pub fn play() -> anyhow::Result<()> {
    player::play()
}

pub fn pause() -> anyhow::Result<()> {
    player::pause()
}

pub fn stop() -> anyhow::Result<()> {
    player::stop()
}

pub fn seek(position_ms: u64) -> anyhow::Result<()> {
    player::seek(position_ms)
}

pub fn set_dsp(config: DspConfig) -> anyhow::Result<()> {
    player::set_dsp(config)
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscordButton {
    pub label: String,
    pub url: String,
}

/// Rich Presence activity, already rendered from the user's templates by Dart.
/// Empty strings / `None` leave the field out of the activity.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscordActivity {
    pub details: String,
    pub state: String,
    /// Asset key or public https URL.
    pub large_image: Option<String>,
    pub large_text: Option<String>,
    pub small_image: Option<String>,
    pub small_text: Option<String>,
    /// Unix epoch milliseconds.
    pub start_timestamp_ms: Option<i64>,
    pub end_timestamp_ms: Option<i64>,
    /// At most two are sent.
    pub buttons: Vec<DiscordButton>,
    /// Which text Discord shows after "Listening to" in the member list:
    /// 0 = application name, 1 = state, 2 = details. `None` leaves Discord's default (name).
    #[serde(default)]
    pub status_display_type: Option<u8>,
}

/// Show `activity` on Discord under `application_id`, or clear it with `None`.
/// Connects lazily, reconnects if the Discord client restarts, switches
/// connection when `application_id` changes. Returns as soon as the update is
/// queued; Discord not running is not an error (the update is kept and sent
/// once Discord appears).
pub fn discord_set_activity(
    application_id: String,
    activity: Option<DiscordActivity>,
) -> anyhow::Result<()> {
    crate::discord::set_activity(application_id, activity)
}

#[cfg(test)]
mod contract_tests {
    //! Pins the JSON shapes promised by `src/lib/ipc.ts`.
    use super::*;
    use serde_json::json;

    #[test]
    fn engine_event_json_is_camel_case() {
        let e = EngineEvent {
            kind: EventKind::SignalPathChanged,
            state: PlaybackState::Playing,
            track_id: Some("t".into()),
            entry_id: Some("e".into()),
            position_ms: 5,
            duration_ms: 10,
            signal_path: Some(SignalPath {
                codec: "FLAC".into(),
                source_sample_rate: 44100,
                source_bit_depth: 16,
                channels: 2,
                stages: vec!["ReplayGain".into()],
                device_name: "d".into(),
                output_sample_rate: 48000,
                output_bit_depth: 24,
                exclusive: true,
                bit_perfect: false,
            }),
            message: None,
            throughput_bps: 0,
            cached_bytes: 0,
            total_bytes: 0,
        };
        let v = serde_json::to_value(&e).unwrap();
        assert_eq!(
            v,
            json!({
                "kind": "signalPathChanged", "state": "playing",
                "trackId": "t", "entryId": "e", "positionMs": 5, "durationMs": 10,
                "signalPath": {
                    "codec": "FLAC", "sourceSampleRate": 44100, "sourceBitDepth": 16,
                    "channels": 2, "stages": ["ReplayGain"], "deviceName": "d",
                    "outputSampleRate": 48000, "outputBitDepth": 24,
                    "exclusive": true, "bitPerfect": false
                },
                "message": null, "throughputBps": 0, "cachedBytes": 0, "totalBytes": 0
            })
        );
    }

    #[test]
    fn dsp_config_json_is_camel_case() {
        let j = json!({
            "volume": 1.0, "replayGain": "album", "preampDb": 0.0, "clipGuard": true,
            "eqEnabled": true, "eqPreampDb": -3.0,
            "eqBands": [{"kind": "lowShelf", "freqHz": 100.0, "gainDb": 2.0, "q": 0.7}],
            "convolutionPath": null, "crossfeed": "medium",
            "compressor": {"enabled": true, "thresholdDb": -20.0, "ratio": 4.0, "attackMs": 5.0,
                           "releaseMs": 120.0, "makeupDb": 2.0},
            "resampleTo": null, "dither": "tpdf", "crossfadeMs": 0, "dsd": "dop"
        });
        let c: DspConfig = serde_json::from_value(j.clone()).unwrap();
        assert_eq!(c.eq_bands[0].kind, EqBandKind::LowShelf);
        assert_eq!(c.replay_gain, ReplayGainMode::Album);
        assert_eq!(c.dsd, DsdMode::Dop);
        assert_eq!(serde_json::to_value(&c).unwrap(), j);
        // A config without the compressor (older frontend) still parses, with it off.
        let mut old = j.clone();
        old.as_object_mut().unwrap().remove("compressor");
        let c: DspConfig = serde_json::from_value(old).unwrap();
        assert_eq!(c.compressor, CompressorConfig::default());
    }

    #[test]
    fn track_request_and_devices_json() {
        let t: TrackRequest = serde_json::from_value(json!({
            "id": "1", "entryId": "e1", "url": "http://x", "headers": [{"name": "A", "value": "b"}],
            "localPath": null, "albumId": "al", "fallbackGainDb": -2.5
        }))
        .unwrap();
        assert_eq!(t.entry_id, "e1");
        assert_eq!(t.album_id.as_deref(), Some("al"));
        assert_eq!(t.fallback_gain_db, Some(-2.5));
        let d = OutputDevice {
            id: "i".into(),
            name: "n".into(),
            is_default: true,
            supports_exclusive: false,
            sample_rates: vec![44100],
            max_bit_depth: 24,
        };
        assert_eq!(
            serde_json::to_value(d).unwrap(),
            json!({"id":"i","name":"n","isDefault":true,"supportsExclusive":false,
                   "sampleRates":[44100],"maxBitDepth":24})
        );
        let a: DiscordActivity = serde_json::from_value(json!({
            "details": "d", "state": "s", "largeImage": null, "largeText": null,
            "smallImage": "play", "smallText": null, "startTimestampMs": 1,
            "endTimestampMs": null, "buttons": [{"label": "l", "url": "u"}]
        }))
        .unwrap();
        assert_eq!(a.start_timestamp_ms, Some(1));
        assert_eq!(a.buttons[0].label, "l");
    }
}
