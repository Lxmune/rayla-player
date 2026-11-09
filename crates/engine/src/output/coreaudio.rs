//! macOS output: AUHAL audio unit fed from a small ring buffer. Exclusive mode
//! takes hog mode, sets the device's nominal sample rate and, where the
//! device offers it, a matching integer physical format.
//!
//! NOTE: this file is only compiled on macOS and has not been built or run
//! on the development machine.

use super::{Backend, Output, OutputInfo};
use crate::api::engine::OutputDevice;
use crate::decode::Format;
use anyhow::{anyhow, Result};
use coreaudio::audio_unit::audio_format::LinearPcmFlags;
use coreaudio::audio_unit::macos_helpers::{
    audio_unit_from_device_id, find_matching_physical_format, get_audio_device_ids_for_scope,
    get_default_device_id, get_device_name, get_hogging_pid, get_supported_physical_stream_formats,
    set_device_physical_stream_format, set_device_sample_rate, toggle_hog_mode,
};
use coreaudio::audio_unit::render_callback::{data, Args};
use coreaudio::audio_unit::{AudioUnit, Element, SampleFormat, Scope, StreamFormat};
use coreaudio::sys::AudioDeviceID;
use std::collections::VecDeque;
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

pub struct CoreAudioBackend;

const PROBE_RATES: [u32; 8] = [44100, 48000, 88200, 96000, 176400, 192000, 352800, 384000];
/// Ring length in milliseconds. Kept short so a seek or pause fade written
/// to the ring is heard almost immediately.
const RING_MS: usize = 50;

struct Ring {
    q: Mutex<VecDeque<i32>>,
    cv: Condvar,
}

fn int_format(rate: u32, channels: u32, bits: u32) -> StreamFormat {
    StreamFormat {
        sample_rate: rate as f64,
        sample_format: match bits {
            16 => SampleFormat::I16,
            24 => SampleFormat::I24,
            _ => SampleFormat::I32,
        },
        flags: LinearPcmFlags::IS_SIGNED_INTEGER | LinearPcmFlags::IS_PACKED,
        channels,
    }
}

impl Backend for CoreAudioBackend {
    fn list_devices(&self) -> Result<Vec<OutputDevice>> {
        let default = get_default_device_id(false);
        let mut out = Vec::new();
        for id in get_audio_device_ids_for_scope(Scope::Output)? {
            let mut rates = Vec::new();
            let mut max_bits = 0;
            if let Ok(fmts) = get_supported_physical_stream_formats(id) {
                for f in &fmts {
                    max_bits = max_bits.max(f.mFormat.mBitsPerChannel);
                    for r in PROBE_RATES {
                        let r_f = r as f64;
                        if r_f >= f.mSampleRateRange.mMinimum
                            && r_f <= f.mSampleRateRange.mMaximum
                            && !rates.contains(&r)
                        {
                            rates.push(r);
                        }
                    }
                }
            }
            rates.sort_unstable();
            out.push(OutputDevice {
                id: id.to_string(),
                name: get_device_name(id).unwrap_or_else(|_| id.to_string()),
                is_default: default == Some(id),
                supports_exclusive: true,
                sample_rates: rates,
                max_bit_depth: max_bits,
            });
        }
        Ok(out)
    }

    fn open(
        &self,
        device_id: Option<&str>,
        exclusive: bool,
        want: Format,
    ) -> Result<Box<dyn Output>> {
        let dev: AudioDeviceID = match device_id {
            Some(s) => s.parse().map_err(|_| anyhow!("bad device id {s}"))?,
            None => {
                get_default_device_id(false).ok_or_else(|| anyhow!("no default output device"))?
            }
        };
        let name = get_device_name(dev).unwrap_or_default();
        let me = std::process::id() as i32;

        let mut hogged = false;
        let mut bits = 32;
        if exclusive {
            let owner = get_hogging_pid(dev).unwrap_or(-1);
            hogged = owner == me
                || (owner == -1 && toggle_hog_mode(dev).map(|p| p == me).unwrap_or(false));
            if hogged {
                let _ = set_device_sample_rate(dev, want.rate as f64);
                let order: [u32; 3] = match want.bits {
                    0..=16 => [16, 24, 32],
                    17..=24 => [24, 32, 16],
                    _ => [32, 24, 16],
                };
                for b in order {
                    let sf = int_format(want.rate, want.channels, b);
                    if let Some(asbd) = find_matching_physical_format(dev, sf) {
                        if set_device_physical_stream_format(dev, asbd).is_ok() {
                            bits = b;
                            break;
                        }
                    }
                }
            }
        }

        let mut unit = audio_unit_from_device_id(dev, false)?;
        unit.set_stream_format(
            int_format(want.rate, want.channels, 32),
            Scope::Input,
            Element::Output,
        )?;
        let ring = Arc::new(Ring {
            q: Mutex::new(VecDeque::new()),
            cv: Condvar::new(),
        });
        let cb_ring = ring.clone();
        unit.set_render_callback(move |args: Args<data::Interleaved<i32>>| {
            let buf = args.data.buffer;
            let mut filled = 0;
            // Never block the audio thread: on contention play silence.
            if let Ok(mut q) = cb_ring.q.try_lock() {
                while filled < buf.len() {
                    match q.pop_front() {
                        Some(s) => {
                            buf[filled] = s;
                            filled += 1;
                        }
                        None => break,
                    }
                }
            }
            buf[filled..].fill(0);
            cb_ring.cv.notify_one();
            Ok(())
        })?;
        unit.initialize()?;
        unit.start()?;

        let rate = if hogged {
            want.rate
        } else {
            unit.stream_format(Scope::Output, Element::Output)
                .map(|f| f.sample_rate as u32)
                .unwrap_or(want.rate)
        };
        Ok(Box::new(CoreAudioOutput {
            info: OutputInfo {
                device_name: name,
                exclusive: hogged,
                format: Format {
                    rate,
                    channels: want.channels,
                    bits,
                },
            },
            unit,
            ring,
            cap: want.rate as usize * want.channels as usize * RING_MS / 1000,
            dev,
            hogged,
            running: true,
        }))
    }
}

struct CoreAudioOutput {
    info: OutputInfo,
    unit: AudioUnit,
    ring: Arc<Ring>,
    cap: usize,
    dev: AudioDeviceID,
    hogged: bool,
    running: bool,
}

impl Output for CoreAudioOutput {
    fn info(&self) -> &OutputInfo {
        &self.info
    }

    fn write(&mut self, samples: &[i32]) -> Result<()> {
        let mut i = 0;
        let mut stalls = 0;
        while i < samples.len() {
            let mut q = self.ring.q.lock().unwrap();
            if q.len() >= self.cap {
                let (g, t) = self
                    .ring
                    .cv
                    .wait_timeout(q, Duration::from_millis(100))
                    .unwrap();
                drop(g);
                stalls = if t.timed_out() { stalls + 1 } else { 0 };
                if stalls > 30 {
                    return Err(anyhow!("audio device stopped responding"));
                }
                continue;
            }
            let n = (self.cap - q.len()).min(samples.len() - i);
            q.extend(&samples[i..i + n]);
            i += n;
        }
        Ok(())
    }

    fn set_running(&mut self, running: bool) -> Result<()> {
        if running != self.running {
            if running {
                self.unit.start()?;
            } else {
                self.unit.stop()?;
            }
            self.running = running;
        }
        Ok(())
    }

    fn drain(&mut self) -> Result<()> {
        for _ in 0..100 {
            if self.ring.q.lock().unwrap().is_empty() {
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        std::thread::sleep(Duration::from_millis(60));
        Ok(())
    }
}

impl Drop for CoreAudioOutput {
    fn drop(&mut self) {
        let _ = self.unit.stop();
        let _ = self.unit.uninitialize();
        if self.hogged
            && get_hogging_pid(self.dev)
                .map(|p| p == std::process::id() as i32)
                .unwrap_or(false)
        {
            let _ = toggle_hog_mode(self.dev);
        }
    }
}
