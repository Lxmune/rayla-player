#![allow(dead_code)] // test double; unused in builds with a native backend

//! In-memory output used by tests and by builds without a native backend.

use super::{Backend, Output, OutputInfo};
use crate::api::engine::OutputDevice;
use crate::decode::Format;
use anyhow::Result;
use std::sync::{Arc, Mutex};
use std::time::Duration;

#[derive(Default, Debug)]
pub struct SinkLog {
    /// Everything written, in order.
    pub samples: Vec<i32>,
    /// One entry per open.
    pub opens: Vec<Format>,
    pub drains: usize,
    pub running: bool,
}

#[derive(Clone, Default)]
pub struct SinkBackend {
    pub log: Arc<Mutex<SinkLog>>,
    /// Playback speed relative to real time; 0 writes as fast as possible.
    pub speed: f64,
}

impl SinkBackend {
    pub fn with_speed(speed: f64) -> Self {
        SinkBackend {
            speed,
            ..Default::default()
        }
    }
}

struct SinkOutput {
    info: OutputInfo,
    log: Arc<Mutex<SinkLog>>,
    speed: f64,
}

impl Backend for SinkBackend {
    fn list_devices(&self) -> Result<Vec<OutputDevice>> {
        Ok(vec![OutputDevice {
            id: "sink".into(),
            name: "Test sink".into(),
            is_default: true,
            supports_exclusive: true,
            sample_rates: vec![44100, 48000, 88200, 96000, 176400, 192000],
            max_bit_depth: 32,
        }])
    }
    fn open(
        &self,
        _device: Option<&str>,
        exclusive: bool,
        want: Format,
    ) -> Result<Box<dyn Output>> {
        let mut l = self.log.lock().unwrap();
        l.opens.push(want);
        l.running = true;
        Ok(Box::new(SinkOutput {
            info: OutputInfo {
                device_name: "Test sink".into(),
                exclusive,
                format: want,
            },
            log: self.log.clone(),
            speed: self.speed,
        }))
    }
}

impl Output for SinkOutput {
    fn info(&self) -> &OutputInfo {
        &self.info
    }
    fn write(&mut self, samples: &[i32]) -> Result<()> {
        self.log.lock().unwrap().samples.extend_from_slice(samples);
        if self.speed > 0.0 {
            let f = &self.info.format;
            let secs = samples.len() as f64 / f.channels as f64 / f.rate as f64 / self.speed;
            std::thread::sleep(Duration::from_secs_f64(secs));
        }
        Ok(())
    }
    fn set_running(&mut self, running: bool) -> Result<()> {
        self.log.lock().unwrap().running = running;
        Ok(())
    }
    fn drain(&mut self) -> Result<()> {
        self.log.lock().unwrap().drains += 1;
        Ok(())
    }
}
