//! Build-time validation shared with CPU tests. No allocation or SDK required.
pub const MAX_CACHE_BYTES: usize = 16 * 1024 * 1024;

// Called by build.rs and the unit tests; runtime data has already passed it.
#[allow(dead_code)]
pub fn validate(data: &[u8]) -> Result<(), &'static str> {
    let read = |offset: usize| -> Result<u32, &'static str> {
        let bytes = data.get(offset..offset + 4).ok_or("truncated header")?;
        Ok(u32::from_le_bytes(bytes.try_into().unwrap()))
    };
    if data.get(..4) != Some(b"OPCH") {
        return Err("invalid magic");
    }
    let version = read(4)?;
    let header = match version {
        1 => 24,
        2 => 40,
        _ => return Err("unsupported version"),
    };
    let vertices = read(8)? as usize;
    let indices = read(12)? as usize;
    let clips = read(16)? as usize;
    let frames = read(20)? as usize;
    if !(1..=16000).contains(&vertices) || indices == 0 || indices > 32766 || indices % 3 != 0 {
        return Err("vertex/index budget exceeded");
    }
    if clips != 7 || frames < 14 || frames > 512 {
        return Err("invalid clip/frame count");
    }
    if frames * vertices * if version == 2 { 32 } else { 24 } > MAX_CACHE_BYTES {
        return Err("morph cache budget exceeded");
    }
    let texture_bytes = if version == 2 {
        let w = read(24)? as usize;
        let h = read(28)? as usize;
        if !(16..=256).contains(&w) || h != w || !w.is_power_of_two() {
            return Err("invalid texture dimensions");
        }
        if read(32)? as usize != w * h * 4 || read(36)? != 0 {
            return Err("invalid texture header");
        }
        w * h * 4
    } else {
        0
    };
    let index_start = header + clips * 16 + vertices * if version == 2 { 8 } else { 4 };
    let poses = index_start + indices * 2;
    let sockets = poses + frames * vertices * 6;
    let expected = sockets
        + if version == 2 {
            frames * 12 + texture_bytes
        } else {
            0
        };
    if data.len() != expected {
        return Err("invalid asset length");
    }
    let mut next_frame = 0;
    for clip in 0..clips {
        let at = header + clip * 16;
        let start = read(at)? as usize;
        let count = read(at + 4)? as usize;
        let duration = f32::from_bits(read(at + 8)?);
        let looping = read(at + 12)?;
        if start != next_frame
            || count < 2
            || count > frames.saturating_sub(start)
            || !duration.is_finite()
            || duration <= 0.0
            || duration > 30.0
            || looping != u32::from(clip < 3)
        {
            return Err("invalid clip record");
        }
        next_frame += count;
    }
    if next_frame != frames {
        return Err("unreferenced pose frames");
    }
    for i in 0..indices {
        let at = index_start + i * 2;
        let value = u16::from_le_bytes([data[at], data[at + 1]]) as usize;
        if value >= vertices {
            return Err("out-of-range vertex index");
        }
    }
    if version == 2 {
        for i in 0..frames * 3 {
            let value = f32::from_bits(read(sockets + i * 4)?);
            if !value.is_finite() || value.abs() > 128.0 {
                return Err("invalid attack socket");
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    extern crate std;
    use super::validate;
    use std::vec::Vec;

    fn fixture() -> Vec<u8> {
        let mut data = Vec::from(*b"OPCH");
        for n in [2u32, 3, 3, 7, 14, 16, 16, 1024, 0] {
            data.extend(n.to_le_bytes());
        }
        for clip in 0..7u32 {
            for n in [clip * 2, 2, 1.0f32.to_bits(), u32::from(clip < 3)] {
                data.extend(n.to_le_bytes());
            }
        }
        data.extend([255u8; 12]); // vertex colors
        data.extend([0u8; 12]); // UVs
        for i in 0..3u16 {
            data.extend(i.to_le_bytes());
        }
        data.extend([0u8; 14 * 3 * 6]); // poses
        data.extend([0u8; 14 * 12]); // attack sockets
        data.extend([255u8; 1024]);
        data
    }
    fn changed(offset: usize, value: u32) -> Vec<u8> {
        let mut data = fixture();
        data[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
        data
    }
    #[test]
    fn rejects_truncation_and_unbounded_gpu_allocations() {
        let data = fixture();
        validate(&data).unwrap();
        for len in [0, 4, 23, 39, 120, data.len() - 1] {
            assert!(validate(&data[..len]).is_err());
        }
        for (offset, value) in [
            (4, 3),
            (8, u32::MAX),
            (12, 65535),
            (20, 4096),
            (24, 257),
            (28, 32),
            (32, 1),
        ] {
            assert!(validate(&changed(offset, value)).is_err());
        }
    }
    #[test]
    fn rejects_invalid_clips_indices_and_nonfinite_sockets() {
        for (offset, value) in [(40, 1), (44, u32::MAX), (48, f32::NAN.to_bits()), (52, 0)] {
            assert!(validate(&changed(offset, value)).is_err());
        }
        let mut data = fixture();
        let indices = 40 + 7 * 16 + 3 * 8;
        data[indices..indices + 2].copy_from_slice(&3u16.to_le_bytes());
        assert_eq!(validate(&data), Err("out-of-range vertex index"));
        let socket = indices + 6 + 14 * 3 * 6;
        assert_eq!(
            validate(&changed(socket, f32::INFINITY.to_bits())),
            Err("invalid attack socket")
        );
    }
}
