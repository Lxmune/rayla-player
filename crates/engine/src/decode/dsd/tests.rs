use super::fixtures::*;
use super::*;
use std::io::Cursor;

fn open(bytes: Vec<u8>, plan: &DsdPlan) -> Result<DsdDecoder> {
    DsdDecoder::open(Box::new(Cursor::new(bytes)), plan)
}

fn dop_plan() -> DsdPlan {
    DsdPlan { allow_dop: true, device_rates: vec![176400] }
}

fn drain(d: &mut DsdDecoder) -> Vec<i32> {
    let mut v = Vec::new();
    while d.next(&mut v).unwrap() {}
    v
}

#[test]
fn dsf_header_parses_both_bit_orders_and_blocks() {
    for lsb in [true, false] {
        let chans = vec![noise_bytes(5000, 1), noise_bytes(5000, 2)];
        let bytes = build_dsf(DSD64_RATE, &chans, lsb, 4096, None);
        let f = parse(&mut Cursor::new(&bytes)).unwrap();
        assert_eq!((f.channels, f.rate, f.samples), (2, DSD64_RATE, 40_000));
        assert!(f.is_dsf());
        // DoP of the whole file reproduces the original MSB-first bytes.
        let mut d = open(bytes, &dop_plan()).unwrap();
        let info = d.info().clone();
        assert_eq!(info.codec, "DSD64");
        assert_eq!((info.sample_rate, info.bits, info.channels), (176400, 24, 2));
        assert_eq!(info.dsd, Some(DsdTrack { rate: DSD64_RATE, dop: true }));
        assert_eq!(info.duration_ms, 40_000 * 1000 / DSD64_RATE as u64);
        let out = drain(&mut d);
        assert_eq!(out.len(), 2 * 2500);
        for (i, f) in out.chunks(2).enumerate() {
            for c in 0..2 {
                let w = (f[c] as u32) >> 8;
                assert_eq!((w >> 16) as u8, DOP_MARKERS[i % 2], "marker at frame {i}");
                assert_eq!((w >> 8) as u8, chans[c][2 * i], "hi byte frame {i} ch {c} lsb={lsb}");
                assert_eq!(w as u8, chans[c][2 * i + 1]);
            }
        }
    }
}

#[test]
fn dff_parses_and_dst_is_rejected() {
    let chans = vec![noise_bytes(3000, 3), noise_bytes(3000, 4)];
    let bytes = build_dff(2 * DSD64_RATE, &chans, b"DSD ");
    let f = parse(&mut Cursor::new(&bytes)).unwrap();
    assert_eq!((f.channels, f.rate, f.samples), (2, 2 * DSD64_RATE, 24_000));
    assert!(!f.is_dsf());
    let mut d = open(bytes, &DsdPlan { allow_dop: true, device_rates: vec![352800] }).unwrap();
    assert_eq!(d.info().codec, "DSD128");
    assert_eq!(d.info().sample_rate, 352800);
    let out = drain(&mut d);
    assert_eq!(out.len(), 2 * 1500);
    let w = (out[2] as u32) >> 8; // frame 1, ch 0
    assert_eq!(((w >> 16) as u8, (w >> 8) as u8, w as u8), (0xFA, chans[0][2], chans[0][3]));

    let err = open(build_dff(DSD64_RATE, &chans, b"DST "), &dop_plan()).err().unwrap();
    assert!(format!("{err:#}").contains("DST"), "{err:#}");
}

#[test]
fn dop_word_layout_and_marker_alternation() {
    assert_eq!(dop_word(0x05, 0xAB, 0xCD), 0x05AB_CD00u32 as i32);
    assert_eq!(dop_word(0xFA, 0x12, 0x34), 0xFA12_3400u32 as i32);
    assert!(dop_word(0xFA, 0, 0) < 0 && dop_word(0x05, 0, 0) > 0);
    let mut p = DopPacker::default();
    let mut out = Vec::new();
    p.pack(&[vec![1, 2, 3, 4, 5, 6]], 3, &mut out);
    let markers: Vec<u8> = out.iter().map(|&w| (w as u32 >> 24) as u8).collect();
    assert_eq!(markers, [0x05, 0xFA, 0x05]);
}

#[test]
fn dop_pads_to_an_even_frame_count_with_idle() {
    // 3 bytes per channel: 1 frame + a lone byte -> padded to 2 frames.
    let chans = vec![vec![0x11, 0x22, 0x33], vec![0x44, 0x55, 0x66]];
    let bytes = build_dff(DSD64_RATE, &chans, b"DSD ");
    let out = drain(&mut open(bytes, &dop_plan()).unwrap());
    assert_eq!(out.len(), 4);
    assert_eq!(out[2], dop_word(0xFA, 0x33, IDLE));
    assert_eq!(out[3], dop_word(0xFA, 0x66, IDLE));
    // 4 bytes = 2 frames, already even: nothing added.
    let c4 = vec![vec![1, 2, 3, 4], vec![5, 6, 7, 8]];
    assert_eq!(drain(&mut open(build_dff(DSD64_RATE, &c4, b"DSD "), &dop_plan()).unwrap()).len(), 4);
    // 2 bytes = 1 frame: one idle frame appended.
    let c2 = vec![vec![1, 2], vec![5, 6]];
    let out = drain(&mut open(build_dff(DSD64_RATE, &c2, b"DSD "), &dop_plan()).unwrap());
    assert_eq!(out.len(), 4);
    assert_eq!(out[2], dop_word(0xFA, IDLE, IDLE));
}

#[test]
fn dop_seek_restarts_marker_phase() {
    let chans = vec![noise_bytes(20_000, 5), noise_bytes(20_000, 6)];
    let bytes = build_dsf(DSD64_RATE, &chans, true, 4096, None);
    let mut d = open(bytes, &dop_plan()).unwrap();
    let mut v = Vec::new();
    d.next(&mut v).unwrap();
    d.seek(10).unwrap(); // 10 ms = 28224 samples = 3528 bytes
    let out = drain(&mut d);
    assert_eq!((out[0] as u32) >> 24, 0x05);
    let w = (out[0] as u32) >> 8;
    assert_eq!(((w >> 8) as u8, w as u8), (chans[0][3528], chans[0][3529]));
    assert_eq!(out.len(), 2 * (20_000 - 3528) / 2);
}

#[test]
fn id3_replaygain_in_dsf_is_read() {
    let chans = vec![noise_bytes(100, 1)];
    let bytes = build_dsf(DSD64_RATE, &chans, true, 4096, Some(id3_with_gain("-6.20 dB")));
    let f = parse(&mut Cursor::new(&bytes)).unwrap();
    assert_eq!(f.replay_gain.track_gain_db, Some(-6.2));
}

fn sine_dsf(rate: u32, amp: f64, hz: f64, seconds: f64) -> (Vec<u8>, Vec<u8>) {
    let n = (rate as f64 * seconds) as usize;
    let x: Vec<f64> = (0..n)
        .map(|i| amp * (2.0 * std::f64::consts::PI * hz * i as f64 / rate as f64).sin())
        .collect();
    let b = sigma_delta2(&x);
    (build_dsf(rate, &[b.clone(), b.clone()], true, 4096, None), b)
}

/// Amplitude and relative residual of the best-fit sine at `hz`.
fn fit(pcm: &[f64], rate: f64, hz: f64) -> (f64, f64) {
    let (mut c, mut s) = (0.0, 0.0);
    for (i, v) in pcm.iter().enumerate() {
        let ph = 2.0 * std::f64::consts::PI * hz * i as f64 / rate;
        c += v * ph.cos();
        s += v * ph.sin();
    }
    let (a, b) = (2.0 * c / pcm.len() as f64, 2.0 * s / pcm.len() as f64);
    let amp = (a * a + b * b).sqrt();
    let resid: f64 = pcm
        .iter()
        .enumerate()
        .map(|(i, v)| {
            let ph = 2.0 * std::f64::consts::PI * hz * i as f64 / rate;
            (v - a * ph.cos() - b * ph.sin()).powi(2)
        })
        .sum::<f64>()
        / pcm.len() as f64;
    (amp, (resid / (amp * amp / 2.0)).sqrt())
}

#[test]
fn dsd_to_pcm_decodes_a_modulated_sine() {
    for (rate, mult) in [(DSD64_RATE, 1u32), (2 * DSD64_RATE, 2), (4 * DSD64_RATE, 4)] {
        let (bytes, raw) = sine_dsf(rate, 0.5, 1000.0, 0.2);
        let mut d = open(bytes, &DsdPlan::pcm()).unwrap();
        let info = d.info().clone();
        assert_eq!((info.sample_rate, info.bits, info.channels), (352800, 0, 2));
        assert_eq!(info.dsd, Some(DsdTrack { rate, dop: false }));
        let out = drain(&mut d);
        // Output length: one sample per 8*mult input bits.
        assert_eq!(out.len(), 2 * raw.len().div_ceil(mult as usize), "length for x{mult}");
        let l: Vec<f64> = out.chunks(2).map(|f| f[0] as f64 / 2147483648.0).collect();
        assert_eq!(l.iter().zip(out.chunks(2)).filter(|(a, f)| (**a * 2147483648.0) as i32 != f[1]).count(), 0);
        // Skip the edges (modulator start-up / filter tail), then fit.
        let body = &l[2000..l.len() - 2000];
        let (amp, resid) = fit(body, 352800.0, 1000.0);
        assert!((amp - 0.5).abs() < 0.01, "x{mult}: amplitude {amp}");
        // Residual includes all modulator noise below 100 kHz (2nd order: ~-39 dB).
        assert!(resid < 0.02, "x{mult}: residual {resid}");
    }
}

#[test]
fn dsd_to_pcm_seek_matches_continuous_decode() {
    let (bytes, _) = sine_dsf(DSD64_RATE, 0.5, 1000.0, 0.3);
    let all = drain(&mut open(bytes.clone(), &DsdPlan::pcm()).unwrap());
    let mut d = open(bytes, &DsdPlan::pcm()).unwrap();
    d.seek(100).unwrap();
    let tail = drain(&mut d);
    let start = 2 * 35_280; // 100 ms at 352.8 kHz
    assert_eq!(tail.len(), all.len() - start);
    assert_eq!(&tail[..], &all[start..]);
}

#[test]
fn dsd_filter_has_unity_dc_gain_and_rejects_ultrasonics() {
    // All ones = +1.0 full scale; idle pattern = silence.
    let ones = vec![vec![0xFFu8; 4000]];
    let bytes = build_dff(DSD64_RATE, &[ones[0].clone()], b"DSD ");
    let out = drain(&mut open(bytes, &DsdPlan::pcm()).unwrap());
    let mid = out[1000] as f64 / 2147483648.0;
    assert!((mid - 1.0).abs() < 1e-6, "{mid}");
    let idle = vec![IDLE; 4000];
    let out = drain(&mut open(build_dff(DSD64_RATE, &[idle], b"DSD "), &DsdPlan::pcm()).unwrap());
    assert!(out[1000].abs() < 1 << 12);
}
