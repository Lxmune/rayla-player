//! Android output: one blocking AAudio stream. Exclusive mode asks AAudio for
//! an EXCLUSIVE (MMAP) stream and falls back to shared when refused. The
//! stream is opened at the track's rate; AAudio reports what it granted.
//!
//! Sample formats: 16-bit sources go out as PCM_I16 (exact). Deeper sources
//! try PCM_I32 (API 31+) and fall back to float, which is exact for 24 bits.
//!
//! Uses the raw `ndk-sys` bindings: the `ndk` crate's 0.9 `write()` treats
//! the positive frame count AAudio returns as an error.

use super::{Backend, Output, OutputInfo};
use crate::api::engine::OutputDevice;
use crate::decode::Format;
use anyhow::{anyhow, Result};
use ndk_sys as ffi;
use std::ffi::CStr;
use std::ptr::{self, NonNull};
use std::time::Duration;

const WRITE_TIMEOUT_NS: i64 = 2_000_000_000;

/// Turns an AAudio status code into a readable error.
fn check(code: ffi::aaudio_result_t, what: &str) -> Result<i32> {
    if code >= 0 {
        return Ok(code);
    }
    // SAFETY: AAudio returns a static C string for every code.
    let text = unsafe { CStr::from_ptr(ffi::AAudio_convertResultToText(code)) };
    Err(anyhow!("{what}: {} ({code})", text.to_string_lossy()))
}

pub struct AAudioBackend;

#[derive(Clone, Copy, PartialEq)]
enum Sample {
    I16,
    I32,
    F32,
}

impl Sample {
    fn aaudio(self) -> ffi::aaudio_format_t {
        (match self {
            Sample::I16 => ffi::AAUDIO_FORMAT_PCM_I16,
            Sample::I32 => ffi::AAUDIO_FORMAT_PCM_I32,
            Sample::F32 => ffi::AAUDIO_FORMAT_PCM_FLOAT,
        }) as ffi::aaudio_format_t
    }
    fn bytes(self) -> usize {
        if self == Sample::I16 {
            2
        } else {
            4
        }
    }
    /// Bit depth reported to the engine: what the format carries exactly.
    fn bits(self) -> u32 {
        match self {
            Sample::I16 => 16,
            Sample::I32 => 32,
            Sample::F32 => 24,
        }
    }
}

/// Owned `AAudioStream`; closed on drop.
struct Stream(NonNull<ffi::AAudioStream>);

impl Stream {
    fn open(device: Option<i32>, want: Format, exclusive: bool, sample: Sample) -> Result<Stream> {
        let mut builder: *mut ffi::AAudioStreamBuilder = ptr::null_mut();
        // SAFETY: plain AAudio C calls; the builder is deleted on every path.
        unsafe {
            check(
                ffi::AAudio_createStreamBuilder(&mut builder),
                "create stream builder",
            )?;
            let sharing = if exclusive {
                ffi::AAUDIO_SHARING_MODE_EXCLUSIVE
            } else {
                ffi::AAUDIO_SHARING_MODE_SHARED
            };
            if let Some(id) = device {
                ffi::AAudioStreamBuilder_setDeviceId(builder, id);
            }
            ffi::AAudioStreamBuilder_setDirection(builder, ffi::AAUDIO_DIRECTION_OUTPUT as i32);
            ffi::AAudioStreamBuilder_setSharingMode(builder, sharing as i32);
            ffi::AAudioStreamBuilder_setPerformanceMode(
                builder,
                ffi::AAUDIO_PERFORMANCE_MODE_NONE as i32,
            );
            ffi::AAudioStreamBuilder_setSampleRate(builder, want.rate as i32);
            ffi::AAudioStreamBuilder_setChannelCount(builder, want.channels as i32);
            ffi::AAudioStreamBuilder_setFormat(builder, sample.aaudio());
            let mut raw: *mut ffi::AAudioStream = ptr::null_mut();
            let opened = check(
                ffi::AAudioStreamBuilder_openStream(builder, &mut raw),
                "open stream",
            );
            ffi::AAudioStreamBuilder_delete(builder);
            opened?;
            let stream =
                Stream(NonNull::new(raw).ok_or_else(|| anyhow!("open stream: null stream"))?);
            if ffi::AAudioStream_getFormat(raw) != sample.aaudio() {
                return Err(anyhow!("device refused the sample format"));
            }
            Ok(stream)
        }
    }

    fn ptr(&self) -> *mut ffi::AAudioStream {
        self.0.as_ptr()
    }
}

impl Drop for Stream {
    fn drop(&mut self) {
        // SAFETY: we own the stream; nothing uses it after this.
        unsafe {
            ffi::AAudioStream_requestStop(self.ptr());
            ffi::AAudioStream_close(self.ptr());
        }
    }
}

impl Backend for AAudioBackend {
    fn list_devices(&self) -> Result<Vec<OutputDevice>> {
        // Routing is Android's job (speaker, wired, Bluetooth, USB DAC); the
        // app always opens the current default output.
        Ok(vec![OutputDevice {
            id: "default".into(),
            name: "System output".into(),
            is_default: true,
            supports_exclusive: true,
            sample_rates: vec![44100, 48000, 88200, 96000, 176400, 192000],
            max_bit_depth: 32,
        }])
    }

    fn open(&self, device: Option<&str>, exclusive: bool, want: Format) -> Result<Box<dyn Output>> {
        // An unparsable id means default routing.
        let device_id: Option<i32> = device.and_then(|s| s.trim().parse().ok());
        let order: &[Sample] = if want.bits <= 16 {
            &[Sample::I16, Sample::F32]
        } else {
            &[Sample::I32, Sample::F32, Sample::I16]
        };
        let modes: &[bool] = if exclusive { &[true, false] } else { &[false] };
        let mut last = anyhow!("no output format accepted");
        for &excl in modes {
            for &sample in order {
                let stream = match Stream::open(device_id, want, excl, sample) {
                    Ok(s) => s,
                    Err(e) => {
                        last = e;
                        continue;
                    }
                };
                // Read back what AAudio actually granted; the signal path
                // must report this, not what we asked for.
                // SAFETY: getters on a live stream.
                let (rate, channels, granted_excl, granted_format, dev_id) = unsafe {
                    (
                        ffi::AAudioStream_getSampleRate(stream.ptr()),
                        ffi::AAudioStream_getChannelCount(stream.ptr()),
                        ffi::AAudioStream_getSharingMode(stream.ptr())
                            == ffi::AAUDIO_SHARING_MODE_EXCLUSIVE as i32,
                        ffi::AAudioStream_getFormat(stream.ptr()),
                        ffi::AAudioStream_getDeviceId(stream.ptr()),
                    )
                };
                // Format actually granted decides the sample type and depth.
                let sample = [Sample::I16, Sample::I32, Sample::F32]
                    .into_iter()
                    .find(|s| s.aaudio() == granted_format)
                    .unwrap_or(sample);
                // Device names need JNI (AudioDeviceInfo); the id is the honest part.
                let device_name = if dev_id > 0 {
                    format!("Android audio (device {dev_id})")
                } else {
                    "Android audio".to_string()
                };
                check(
                    unsafe { ffi::AAudioStream_requestStart(stream.ptr()) },
                    "start stream",
                )?;
                return Ok(Box::new(AAudioOutput {
                    info: OutputInfo {
                        device_name,
                        exclusive: granted_excl,
                        format: Format {
                            rate: rate as u32,
                            channels: channels as u32,
                            bits: sample.bits(),
                        },
                    },
                    stream,
                    sample,
                    running: true,
                    scratch: Vec::new(),
                }));
            }
        }
        Err(last)
    }
}

struct AAudioOutput {
    info: OutputInfo,
    stream: Stream,
    sample: Sample,
    running: bool,
    /// Converted samples for the current write (device format, raw bytes).
    scratch: Vec<u8>,
}

impl AAudioOutput {
    fn convert(&mut self, samples: &[i32]) {
        self.scratch.clear();
        match self.sample {
            Sample::I32 => {
                for s in samples {
                    self.scratch.extend_from_slice(&s.to_ne_bytes());
                }
            }
            Sample::I16 => {
                for &s in samples {
                    let v = (super::quantize(s, 16) >> 16) as i16;
                    self.scratch.extend_from_slice(&v.to_ne_bytes());
                }
            }
            Sample::F32 => {
                for &s in samples {
                    let v = (s as f64 / 2_147_483_648.0) as f32;
                    self.scratch.extend_from_slice(&v.to_ne_bytes());
                }
            }
        }
    }
}

impl Output for AAudioOutput {
    fn info(&self) -> &OutputInfo {
        &self.info
    }

    fn write(&mut self, samples: &[i32]) -> Result<()> {
        let frame_bytes = self.info.format.channels.max(1) as usize * self.sample.bytes();
        self.convert(samples);
        let total = self.scratch.len() / frame_bytes;
        let mut done = 0usize;
        let mut stalls = 0;
        while done < total {
            let p = self.stream.ptr();
            // SAFETY: getter on a live stream.
            if unsafe { ffi::AAudioStream_getState(p) }
                == ffi::AAUDIO_STREAM_STATE_DISCONNECTED as i32
            {
                return Err(anyhow!("audio output disconnected"));
            }
            let buf = self.scratch[done * frame_bytes..].as_ptr().cast();
            // SAFETY: `buf` points at `total - done` whole frames in `scratch`.
            let code =
                unsafe { ffi::AAudioStream_write(p, buf, (total - done) as i32, WRITE_TIMEOUT_NS) };
            let n = check(code, "write")? as usize;
            if n == 0 {
                stalls += 1;
                if stalls > 3 {
                    return Err(anyhow!("audio device stopped responding"));
                }
            } else {
                stalls = 0;
            }
            done += n;
        }
        Ok(())
    }

    fn set_running(&mut self, running: bool) -> Result<()> {
        if running != self.running {
            let p = self.stream.ptr();
            // SAFETY: state requests on a live stream.
            let code = unsafe {
                if running {
                    ffi::AAudioStream_requestStart(p)
                } else {
                    ffi::AAudioStream_requestPause(p)
                }
            };
            check(
                code,
                if running {
                    "start stream"
                } else {
                    "pause stream"
                },
            )?;
            self.running = running;
        }
        Ok(())
    }

    fn drain(&mut self) -> Result<()> {
        // Wait until the device has consumed what was written.
        let p = self.stream.ptr();
        for _ in 0..200 {
            // SAFETY: getters on a live stream.
            if unsafe {
                ffi::AAudioStream_getFramesRead(p) >= ffi::AAudioStream_getFramesWritten(p)
            } {
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        Ok(())
    }
}
