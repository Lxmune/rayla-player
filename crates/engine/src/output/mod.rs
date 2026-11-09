//! Audio device layer. Samples cross this boundary as interleaved `i32`
//! left-justified in the 32-bit word; backends narrow to the device depth.

#[cfg(target_os = "macos")]
pub mod coreaudio;
pub mod sink;
#[cfg(target_os = "windows")]
pub mod wasapi;

use crate::api::engine::OutputDevice;
use crate::decode::Format;
use anyhow::Result;
use std::sync::Arc;

/// What the device actually granted.
#[derive(Clone, Debug)]
pub struct OutputInfo {
    pub device_name: String,
    pub exclusive: bool,
    pub format: Format,
}

/// An open playback stream. Dropping it closes the device.
/// Created and used on the engine thread only, so it need not be `Send`.
pub trait Output {
    fn info(&self) -> &OutputInfo;
    /// Blocking write of whole interleaved frames.
    fn write(&mut self, samples: &[i32]) -> Result<()>;
    /// Stop (`false`) or restart (`true`) the hardware clock; used for pause.
    fn set_running(&mut self, running: bool) -> Result<()>;
    /// Block until everything written so far has been played.
    fn drain(&mut self) -> Result<()>;
}

pub trait Backend: Send + Sync {
    fn list_devices(&self) -> Result<Vec<OutputDevice>>;
    /// `device_id == None` is the system default. In exclusive mode the
    /// backend opens `want` if the device takes it and otherwise the nearest
    /// format it supports (see `OutputInfo::format`); if exclusive access is
    /// refused it falls back to shared and says so in `OutputInfo::exclusive`.
    fn open(
        &self,
        device_id: Option<&str>,
        exclusive: bool,
        want: Format,
    ) -> Result<Box<dyn Output>>;
}

pub fn default_backend() -> Arc<dyn Backend> {
    #[cfg(target_os = "windows")]
    return Arc::new(wasapi::WasapiBackend);
    #[cfg(target_os = "macos")]
    return Arc::new(coreaudio::CoreAudioBackend);
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    return Arc::new(sink::SinkBackend::default());
}

/// Narrow a left-justified sample to `bits` (rounding, clamped), still
/// left-justified. Exact (identity) when the source has no bits below `bits`.
#[inline]
#[cfg_attr(not(any(test, target_os = "windows")), allow(dead_code))]
pub fn quantize(s: i32, bits: u32) -> i32 {
    if bits >= 32 {
        return s;
    }
    let shift = 32 - bits;
    let half = 1i64 << (shift - 1);
    let max = (1i64 << (bits - 1)) - 1;
    let v = ((s as i64 + half) >> shift).clamp(-max - 1, max);
    (v << shift) as i32
}

#[cfg(test)]
mod tests {
    use super::quantize;

    #[test]
    fn quantize_is_identity_for_matching_depth_and_rounds_otherwise() {
        assert_eq!(quantize(0x1234_0000, 16), 0x1234_0000);
        assert_eq!(quantize(-0x8000_0000, 16), i32::MIN);
        assert_eq!(quantize(0x1234_8000, 16), 0x1235_0000);
        assert_eq!(quantize(i32::MAX, 16), 0x7FFF_0000);
        assert_eq!(quantize(0x12_3400, 24), 0x12_3400);
        assert_eq!(quantize(i32::MAX, 32), i32::MAX);
    }
}
