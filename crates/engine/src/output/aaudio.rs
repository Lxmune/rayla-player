//! Android output: one blocking AAudio stream. Exclusive mode asks AAudio for
//! an EXCLUSIVE (MMAP) stream and falls back to shared when refused. The
//! stream is opened at the track's rate; AAudio reports what it granted.
//!
//! Sample formats: 16-bit sources go out as PCM_I16 (exact). Deeper sources
//! try PCM_I32 (API 31+) and fall back to float, which is exact for 24 bits.
//!
//! NOTE: only compiled for Android; built here but never run on a device.

use super::{Backend, Output, OutputInfo};
use crate::api::engine::OutputDevice;
use crate::decode::Format;
use anyhow::{anyhow, Result};
use ndk::audio::{
    AudioDirection, AudioFormat, AudioPerformanceMode, AudioSharingMode, AudioStream,
    AudioStreamBuilder, AudioStreamState,
};
use std::time::Duration;

/// `AAUDIO_FORMAT_PCM_I32`, not named by the `ndk` crate (API 31+).
const PCM_I32: i32 = 4;
const WRITE_TIMEOUT_NS: i64 = 2_000_000_000;

pub struct AAudioBackend;

#[derive(Clone, Copy, PartialEq)]
enum Sample {
    I16,
    I32,
    F32,
}

fn open_stream(want: Format, exclusive: bool, sample: Sample) -> Result<AudioStream> {
    let format = match sample {
        Sample::I16 => AudioFormat::PCM_I16,
        Sample::I32 => AudioFormat::from(PCM_I32),
        Sample::F32 => AudioFormat::PCM_Float,
    };
    let sharing = if exclusive { AudioSharingMode::Exclusive } else { AudioSharingMode::Shared };
    let stream = AudioStreamBuilder::new()?
        .direction(AudioDirection::Output)
        .sharing_mode(sharing)
        .performance_mode(AudioPerformanceMode::None)
        .sample_rate(want.rate as i32)
        .channel_count(want.channels as i32)
        .format(format)
        .open_stream()?;
    if stream.format() != format {
        return Err(anyhow!("device refused {format:?}"));
    }
    Ok(stream)
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

    fn open(&self, _device: Option<&str>, exclusive: bool, want: Format) -> Result<Box<dyn Output>> {
        let order: &[Sample] = if want.bits <= 16 {
            &[Sample::I16, Sample::F32]
        } else {
            &[Sample::I32, Sample::F32, Sample::I16]
        };
        let mut last = anyhow!("no output format accepted");
        let mut modes = vec![exclusive];
        if exclusive {
            modes.push(false);
        }
        for &excl in &modes {
            for &sample in order {
                match open_stream(want, excl, sample) {
                    Ok(stream) => {
                        let granted_excl = stream.sharing_mode() == AudioSharingMode::Exclusive;
                        let bits = match sample {
                            Sample::I16 => 16,
                            Sample::I32 => 32,
                            Sample::F32 => 24,
                        };
                        let format = Format {
                            rate: stream.sample_rate() as u32,
                            channels: stream.channel_count() as u32,
                            bits,
                        };
                        stream.request_start()?;
                        return Ok(Box::new(AAudioOutput {
                            info: OutputInfo {
                                device_name: "System output".into(),
                                exclusive: granted_excl,
                                format,
                            },
                            stream,
                            sample,
                            running: true,
                            scratch: Vec::new(),
                        }));
                    }
                    Err(e) => last = e,
                }
            }
        }
        Err(last)
    }
}

struct AAudioOutput {
    info: OutputInfo,
    stream: AudioStream,
    sample: Sample,
    running: bool,
    /// Converted samples for the current write (i16 / f32 as raw bytes).
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
        let channels = self.info.format.channels.max(1) as usize;
        let frame_bytes = channels * if self.sample == Sample::I16 { 2 } else { 4 };
        self.convert(samples);
        let total = self.scratch.len() / frame_bytes;
        let mut done = 0usize;
        let mut stalls = 0;
        while done < total {
            if self.stream.state() == AudioStreamState::Disconnected {
                return Err(anyhow!("audio output disconnected"));
            }
            let ptr = self.scratch[done * frame_bytes..].as_ptr().cast();
            // SAFETY: `ptr` points at `total - done` whole frames in `scratch`.
            let n = unsafe { self.stream.write(ptr, (total - done) as i32, WRITE_TIMEOUT_NS)? } as usize;
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
            if running {
                self.stream.request_start()?;
            } else {
                self.stream.request_pause()?;
            }
            self.running = running;
        }
        Ok(())
    }

    fn drain(&mut self) -> Result<()> {
        // Wait until the device has consumed what was written.
        for _ in 0..200 {
            if self.stream.frames_read() >= self.stream.frames_written() {
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        Ok(())
    }
}

impl Drop for AAudioOutput {
    fn drop(&mut self) {
        let _ = self.stream.request_stop();
    }
}
