//! Windows output: WASAPI exclusive mode, event driven, with a shared-mode
//! fallback (system mixer, automatic format conversion) when exclusive access
//! or the requested rate is refused.

use super::{quantize, Backend, Output, OutputInfo};
use crate::api::engine::OutputDevice;
use crate::decode::Format;
use anyhow::{anyhow, bail, Result};
use wasapi::{
    initialize_mta, AudioClient, AudioRenderClient, Device, DeviceCollection, Direction, Handle,
    SampleType, StreamMode, WaveFormat,
};

pub struct WasapiBackend;

const WAIT_MS: u32 = 3000;
const PROBE_RATES: [u32; 8] = [44100, 48000, 88200, 96000, 176400, 192000, 352800, 384000];

/// (container bits, valid bits) to try for a wanted depth, best match first.
fn candidates(bits: u32) -> [(usize, usize); 4] {
    match bits {
        0..=16 => [(16, 16), (24, 24), (32, 24), (32, 32)],
        17..=24 => [(24, 24), (32, 24), (32, 32), (16, 16)],
        _ => [(32, 32), (32, 24), (24, 24), (16, 16)],
    }
}

fn find_device(id: Option<&str>) -> Result<Device> {
    let _ = initialize_mta();
    match id {
        None => Ok(wasapi::get_default_device(&Direction::Render)?),
        Some(id) => {
            let coll = DeviceCollection::new(&Direction::Render)?;
            for d in &coll {
                let d = d?;
                if d.get_id()? == id {
                    return Ok(d);
                }
            }
            bail!("output device not found: {id}")
        }
    }
}

impl Backend for WasapiBackend {
    fn list_devices(&self) -> Result<Vec<OutputDevice>> {
        let _ = initialize_mta();
        let default_id = wasapi::get_default_device(&Direction::Render)
            .and_then(|d| d.get_id())
            .ok();
        let coll = DeviceCollection::new(&Direction::Render)?;
        let mut out = Vec::new();
        for d in &coll {
            let d = d?;
            let id = d.get_id()?;
            let name = d.get_friendlyname().unwrap_or_else(|_| id.clone());
            let mut rates = Vec::new();
            let mut max_bits = 0;
            if let Ok(client) = d.get_iaudioclient() {
                for rate in PROBE_RATES {
                    let mut ok = false;
                    for bits in [16usize, 24, 32] {
                        // Container == valid bits is enough to learn the depth.
                        let fmt =
                            WaveFormat::new(bits, bits, &SampleType::Int, rate as usize, 2, None);
                        if client.is_supported_exclusive_with_quirks(&fmt).is_ok() {
                            ok = true;
                            max_bits = max_bits.max(bits as u32);
                        }
                    }
                    if ok {
                        rates.push(rate);
                    }
                }
            }
            out.push(OutputDevice {
                is_default: default_id.as_deref() == Some(id.as_str()),
                id,
                name,
                supports_exclusive: !rates.is_empty(),
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
        let dev = find_device(device_id)?;
        let name = dev.get_friendlyname().unwrap_or_default();
        if exclusive {
            match open_exclusive(&dev, &name, want) {
                Ok(o) => return Ok(Box::new(o)),
                Err(_) => {} // refused: fall through to shared
            }
        }
        Ok(Box::new(open_shared(&dev, &name, want)?))
    }
}

fn open_exclusive(dev: &Device, name: &str, want: Format) -> Result<WasapiOutput> {
    let mut last = anyhow!("no supported exclusive format");
    for (store, valid) in candidates(want.bits) {
        let mut client = dev.get_iaudioclient()?;
        let fmt = WaveFormat::new(
            store,
            valid,
            &SampleType::Int,
            want.rate as usize,
            want.channels as usize,
            None,
        );
        let Ok(fmt) = client.is_supported_exclusive_with_quirks(&fmt) else {
            continue;
        };
        let (default_period, _) = client.get_device_period()?;
        // HDA-style devices need buffer sizes in multiples of 128 bytes.
        let period = client
            .calculate_aligned_period_near(default_period, Some(128), &fmt)
            .unwrap_or(default_period);
        if let Err(e) = client.initialize_client(
            &fmt,
            &Direction::Render,
            &StreamMode::EventsExclusive { period_hns: period },
        ) {
            last = e.into();
            continue;
        }
        return WasapiOutput::new(
            client,
            name,
            true,
            false,
            store as u32,
            valid as u32,
            Format {
                rate: want.rate,
                channels: want.channels,
                bits: valid as u32,
            },
        );
    }
    Err(last)
}

fn open_shared(dev: &Device, name: &str, want: Format) -> Result<WasapiOutput> {
    let mut client = dev.get_iaudioclient()?;
    let mix_rate = client.get_mixformat()?.get_samplespersec();
    let fmt = WaveFormat::new(
        32,
        32,
        &SampleType::Float,
        want.rate as usize,
        want.channels as usize,
        None,
    );
    client.initialize_client(
        &fmt,
        &Direction::Render,
        &StreamMode::EventsShared {
            autoconvert: true,
            buffer_duration_hns: 400_000,
        },
    )?;
    WasapiOutput::new(
        client,
        name,
        false,
        true,
        32,
        32,
        Format {
            rate: mix_rate,
            channels: want.channels,
            bits: 32,
        },
    )
}

struct WasapiOutput {
    info: OutputInfo,
    client: AudioClient,
    render: AudioRenderClient,
    event: Handle,
    store_bits: u32,
    valid_bits: u32,
    float: bool,
    bpf: usize,
    /// Frames per device buffer.
    buf_frames: usize,
    staging: Vec<u8>,
    started: bool,
}

impl WasapiOutput {
    fn new(
        client: AudioClient,
        name: &str,
        exclusive: bool,
        float: bool,
        store_bits: u32,
        valid_bits: u32,
        format: Format,
    ) -> Result<Self> {
        let event = client.set_get_eventhandle()?;
        let render = client.get_audiorenderclient()?;
        let buf_frames = client.get_buffer_size()? as usize;
        Ok(WasapiOutput {
            info: OutputInfo {
                device_name: name.to_string(),
                exclusive,
                format,
            },
            client,
            render,
            event,
            store_bits,
            valid_bits,
            float,
            bpf: (store_bits / 8 * format.channels) as usize,
            buf_frames,
            staging: Vec::new(),
            started: false,
        })
    }

    fn encode(&mut self, samples: &[i32]) {
        let out = &mut self.staging;
        out.reserve(samples.len() * (self.store_bits / 8) as usize);
        for &s in samples {
            if self.float {
                out.extend_from_slice(&((s as f64 / 2147483648.0) as f32).to_le_bytes());
                continue;
            }
            let q = quantize(s, self.valid_bits);
            match self.store_bits {
                16 => out.extend_from_slice(&((q >> 16) as i16).to_le_bytes()),
                24 => out.extend_from_slice(&(q >> 8).to_le_bytes()[..3]),
                _ => out.extend_from_slice(&q.to_le_bytes()),
            }
        }
    }

    fn wait(&self) -> Result<()> {
        self.event
            .wait_for_event(WAIT_MS)
            .map_err(|_| anyhow!("audio device stopped responding"))
    }

    /// Hand `frames` staged frames to the device.
    fn push(&mut self, frames: usize) -> Result<()> {
        let bytes = frames * self.bpf;
        self.render
            .write_to_device(frames, &self.staging[..bytes], None)?;
        self.staging.drain(..bytes);
        Ok(())
    }
}

impl Output for WasapiOutput {
    fn info(&self) -> &OutputInfo {
        &self.info
    }

    fn write(&mut self, samples: &[i32]) -> Result<()> {
        self.encode(samples);
        loop {
            let staged = self.staging.len() / self.bpf;
            if self.info.exclusive {
                // Period == buffer: every event wants one whole buffer.
                if staged < self.buf_frames {
                    return Ok(());
                }
                if self.started {
                    self.wait()?;
                }
                self.push(self.buf_frames)?;
                if !self.started {
                    self.client.start_stream()?;
                    self.started = true;
                }
            } else {
                if staged == 0 {
                    return Ok(());
                }
                let avail = self.client.get_available_space_in_frames()? as usize;
                if avail == 0 {
                    self.wait()?;
                    continue;
                }
                self.push(staged.min(avail))?;
                if !self.started {
                    self.client.start_stream()?;
                    self.started = true;
                }
            }
        }
    }

    fn set_running(&mut self, running: bool) -> Result<()> {
        if self.started {
            if running {
                self.client.start_stream()?;
            } else {
                self.client.stop_stream()?;
            }
        }
        Ok(())
    }

    fn drain(&mut self) -> Result<()> {
        if !self.started {
            return Ok(());
        }
        if self.info.exclusive {
            let staged = self.staging.len() / self.bpf;
            if staged > 0 {
                self.staging.resize(self.buf_frames * self.bpf, 0);
                self.wait()?;
                self.push(self.buf_frames)?;
            }
            // Let the last real buffer play out.
            self.wait()?;
            self.wait()?;
        } else {
            let staged = self.staging.len() / self.bpf;
            if staged > 0 {
                self.write(&[])?;
            }
            for _ in 0..200 {
                if self.client.get_current_padding()? == 0 {
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
        }
        Ok(())
    }
}

impl Drop for WasapiOutput {
    fn drop(&mut self) {
        let _ = self.client.stop_stream();
        let _ = self.client.reset_stream();
    }
}
