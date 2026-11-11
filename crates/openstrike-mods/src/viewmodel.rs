//! OPVM/1: 24-byte header (magic, version, vertex count, muzzle XYZ), then
//! unindexed triangles of XYZ f32 + RGBA8, 16 bytes per vertex.
use glam::Vec3;

#[derive(Clone, Copy)]
pub struct ViewModel {
    data: &'static [u8],
}

pub fn validate(data: &[u8]) -> Result<(), &'static str> {
    if data.len() < 24 || &data[..4] != b"OPVM" {
        return Err("invalid viewmodel header");
    }
    let word = |at| u32::from_le_bytes(data[at..at + 4].try_into().unwrap());
    let count = word(8) as usize;
    if word(4) != 1 || count == 0 || count > 3072 || count % 3 != 0 || data.len() != 24 + count * 16
    {
        return Err("viewmodel triangle budget or length is invalid");
    }
    for at in [12, 16, 20].into_iter().chain(
        (24..data.len())
            .step_by(16)
            .flat_map(|at| [at, at + 4, at + 8]),
    ) {
        let value = f32::from_bits(word(at));
        if !value.is_finite() || value.abs() > 128.0 {
            return Err("viewmodel coordinate is invalid");
        }
    }
    for at in (39..data.len()).step_by(16) {
        if data[at] != 255 {
            return Err("viewmodel must be opaque");
        }
    }
    Ok(())
}

impl ViewModel {
    pub fn parse(data: &'static [u8]) -> Result<Self, &'static str> {
        validate(data)?;
        Ok(Self { data })
    }
    fn float(&self, at: usize) -> f32 {
        f32::from_le_bytes(self.data[at..at + 4].try_into().unwrap())
    }
    pub fn muzzle(&self) -> Vec3 {
        Vec3::new(self.float(12), self.float(16), self.float(20))
    }
    pub fn len(&self) -> usize {
        (self.data.len() - 24) / 16
    }
    pub fn vertex(&self, index: usize) -> (Vec3, u32) {
        assert!(index < self.len());
        let at = 24 + index * 16;
        (
            Vec3::new(self.float(at), self.float(at + 4), self.float(at + 8)),
            u32::from_le_bytes(self.data[at + 12..at + 16].try_into().unwrap()),
        )
    }
}

#[cfg(test)]
mod tests {
    extern crate std;
    use super::*;
    fn fixture() -> std::vec::Vec<u8> {
        let mut bytes = std::vec![0u8; 24 + 3*16];
        bytes[..4].copy_from_slice(b"OPVM");
        bytes[4..8].copy_from_slice(&1u32.to_le_bytes());
        bytes[8..12].copy_from_slice(&3u32.to_le_bytes());
        for at in [39, 55, 71] {
            bytes[at] = 255;
        }
        bytes
    }
    #[test]
    fn rejects_corrupt_or_unbounded_geometry_before_rendering() {
        let good = fixture();
        assert_eq!(validate(&good), Ok(()));
        for len in 0..good.len() {
            assert!(validate(&good[..len]).is_err());
        }
        for (at, value) in [
            (4, 2),
            (8, 3075),
            (8, 2),
            (12, f32::NAN.to_bits()),
            (24, 129f32.to_bits()),
            (36, 0x80ffffff),
        ] {
            let mut bad = good.clone();
            bad[at..at + 4].copy_from_slice(&value.to_le_bytes());
            assert!(validate(&bad).is_err(), "offset {at}");
        }
        let mesh = ViewModel::parse(std::boxed::Box::leak(good.into_boxed_slice())).unwrap();
        assert_eq!(mesh.len(), 3);
        assert_eq!(mesh.muzzle(), Vec3::ZERO);
        assert_eq!(mesh.vertex(2), (Vec3::ZERO, 0xff000000));
    }
}
