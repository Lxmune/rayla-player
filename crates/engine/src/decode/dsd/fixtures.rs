//! Synthetic DSD files for tests. Channel data is given MSB-first (oldest
//! sample in the top bit); `build_dsf` bit-reverses when asked for LSB-first.

pub fn build_dsf(rate: u32, chans: &[Vec<u8>], lsb_first: bool, block: usize, id3: Option<Vec<u8>>) -> Vec<u8> {
    let n = chans[0].len();
    let sets = n.div_ceil(block);
    let payload = sets * block * chans.len();
    let data_chunk = 12 + payload;
    let total_pre_meta = 28 + 52 + data_chunk;
    let mut v = Vec::new();
    v.extend(b"DSD ");
    v.extend(28u64.to_le_bytes());
    v.extend(((total_pre_meta + id3.as_ref().map_or(0, |t| t.len())) as u64).to_le_bytes());
    v.extend((if id3.is_some() { total_pre_meta as u64 } else { 0 }).to_le_bytes());
    v.extend(b"fmt ");
    v.extend(52u64.to_le_bytes());
    v.extend(1u32.to_le_bytes());
    v.extend(0u32.to_le_bytes());
    v.extend(2u32.to_le_bytes());
    v.extend((chans.len() as u32).to_le_bytes());
    v.extend(rate.to_le_bytes());
    v.extend((if lsb_first { 1u32 } else { 8 }).to_le_bytes());
    v.extend(((n * 8) as u64).to_le_bytes());
    v.extend((block as u32).to_le_bytes());
    v.extend(0u32.to_le_bytes());
    v.extend(b"data");
    v.extend((data_chunk as u64).to_le_bytes());
    for s in 0..sets {
        for c in chans {
            for i in 0..block {
                let b = c.get(s * block + i).copied().unwrap_or(0);
                v.push(if lsb_first { b.reverse_bits() } else { b });
            }
        }
    }
    if let Some(t) = id3 {
        v.extend(t);
    }
    v
}

fn chunk(id: &[u8; 4], body: &[u8]) -> Vec<u8> {
    let mut v = id.to_vec();
    v.extend((body.len() as u64).to_be_bytes());
    v.extend(body);
    if body.len() % 2 == 1 {
        v.push(0);
    }
    v
}

pub fn build_dff(rate: u32, chans: &[Vec<u8>], cmpr: &[u8; 4]) -> Vec<u8> {
    let mut prop = b"SND ".to_vec();
    prop.extend(chunk(b"FS  ", &rate.to_be_bytes()));
    let mut ch = (chans.len() as u16).to_be_bytes().to_vec();
    for i in 0..chans.len() {
        ch.extend(if i == 0 { b"SLFT" } else { b"SRGT" });
    }
    prop.extend(chunk(b"CHNL", &ch));
    let mut cm = cmpr.to_vec();
    cm.extend([14u8]);
    cm.extend(b"not compressed");
    prop.extend(chunk(b"CMPR", &cm));
    let mut body = b"DSD ".to_vec();
    body.extend(chunk(b"FVER", &[1, 5, 0, 0]));
    body.extend(chunk(b"PROP", &prop));
    let mut data = Vec::new();
    for i in 0..chans[0].len() {
        for c in chans {
            data.push(c[i]);
        }
    }
    body.extend(chunk(if cmpr == b"DSD " { b"DSD " } else { b"DST " }, &data));
    let mut v = b"FRM8".to_vec();
    v.extend((body.len() as u64).to_be_bytes());
    v.extend(body);
    v
}

pub fn id3_with_gain(track_gain: &str) -> Vec<u8> {
    let mut body = vec![3u8]; // UTF-8
    body.extend(b"REPLAYGAIN_TRACK_GAIN\0");
    body.extend(track_gain.as_bytes());
    let mut frame = b"TXXX".to_vec();
    frame.extend((body.len() as u32).to_be_bytes()); // v2.3: plain size
    frame.extend([0, 0]);
    frame.extend(body);
    let n = frame.len();
    let mut v = b"ID3".to_vec();
    v.extend([3, 0, 0]);
    v.extend([(n >> 21) as u8 & 0x7f, (n >> 14) as u8 & 0x7f, (n >> 7) as u8 & 0x7f, n as u8 & 0x7f]);
    v.extend(frame);
    v
}

/// Deterministic pseudo-random bytes.
pub fn noise_bytes(n: usize, seed: u64) -> Vec<u8> {
    let mut x = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
    (0..n)
        .map(|_| {
            x = x.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            (x >> 40) as u8
        })
        .collect()
}

/// Second-order sigma-delta modulation of `x` (|x| <= ~0.7) into MSB-first bytes.
pub fn sigma_delta2(x: &[f64]) -> Vec<u8> {
    let (mut i1, mut i2) = (0.0f64, 0.0f64);
    let mut bytes = Vec::with_capacity(x.len() / 8);
    let mut cur = 0u8;
    for (n, &v) in x.iter().enumerate() {
        let y = if i2 >= 0.0 { 1.0 } else { -1.0 };
        i1 += v - y;
        i2 += i1 - y;
        cur = (cur << 1) | (y > 0.0) as u8;
        if n % 8 == 7 {
            bytes.push(cur);
            cur = 0;
        }
    }
    bytes
}
