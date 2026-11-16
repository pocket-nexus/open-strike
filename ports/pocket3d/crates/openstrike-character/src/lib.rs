//! Baked character presentation, shared by handheld renderers.
//! Geometry and poses are authored/evaluated in Blender; the runtime only
//! interpolates indexed vertices. No allocation, skeleton solver or glTF parser.
#![no_std]

use glam::Vec3;
use openstrike_core::bot::ActorClip;

mod format;
pub use format::MAX_CACHE_BYTES;
const DATA: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/character.opch"));
#[cfg(test)]
fn header() -> usize {
    selected_asset().header()
}
pub fn textured() -> bool {
    selected_asset().textured()
}
const RECORD: usize = 16;

#[derive(Clone, Copy, Debug, Default)]
#[repr(C)]
pub struct Vertex {
    pub color: u32,
    pub x: f32,
    pub y: f32,
    pub z: f32,
}

/// Quantized GE input, including explicit padding so no uninitialized bytes
/// reach the device. Two consecutive entries form one hardware morph vertex.
#[derive(Clone, Copy, Debug, Default)]
#[repr(C)]
pub struct PackedVertex {
    pub color: u32,
    pub x: i16,
    pub y: i16,
    pub z: i16,
    pub padding: u16,
}

pub fn baked_frame_count() -> usize {
    selected_asset().baked_frame_count()
}

pub fn baked_vertex(frame: usize, i: usize) -> PackedVertex {
    selected_asset().baked_vertex(frame, i)
}

#[cfg(test)]
fn u32_at(offset: usize) -> u32 {
    selected_asset().u32_at(offset)
}
pub fn vertex_count() -> usize {
    selected_asset().vertex_count()
}
pub fn index_count() -> usize {
    selected_asset().index_count()
}
pub fn triangle_count() -> usize {
    selected_asset().triangle_count()
}
pub fn asset_bytes() -> usize {
    selected_asset().asset_bytes()
}
pub fn index(i: usize) -> usize {
    selected_asset().index(i)
}
pub fn copy_indices(out: &mut [u16]) {
    selected_asset().copy_indices(out)
}
#[derive(Clone, Copy, Debug, Default)]
#[repr(C)]
pub struct TexturedVertex {
    pub u: u16,
    pub v: u16,
    pub vertex: PackedVertex,
}

pub fn textured_vertex(frame: usize, i: usize) -> TexturedVertex {
    selected_asset().textured_vertex(frame, i)
}

pub fn texture() -> Option<(usize, &'static [u8])> {
    selected_asset().texture()
}
/// One 16-byte row of a GE 16-byte by 8-row texture tile. Reordering leaves
/// every RGBA texel intact; the immutable atlas is prepared once at startup.
pub fn swizzled_rgba_block(rgba: &[u8], width: usize, block: usize) -> [u8; 16] {
    assert!(width >= 4 && width % 4 == 0 && block < rgba.len() / 16);
    let row_bytes = width * 4;
    let tiles_per_row = row_bytes / 16;
    let tile = block / 8;
    let row = (tile / tiles_per_row) * 8 + block % 8;
    let offset = row * row_bytes + (tile % tiles_per_row) * 16;
    rgba[offset..offset + 16].try_into().unwrap()
}
/// The attack starts on the first authored Fire pose. AI/hitscan timing stays
/// shared; hosts install this local-space origin before simulation ticks.
pub fn attack_origin() -> Vec3 {
    selected_asset().attack_origin()
}

pub fn duration(clip: ActorClip) -> f32 {
    selected_asset().duration(clip)
}

pub struct Pose {
    asset: Asset,
    a: usize,
    b: usize,
    mix: f32,
}
impl Pose {
    /// Global baked-frame indices and their interpolation weight. Renderers
    /// with vertex morphing can consume the same samples without CPU skinning.
    pub fn frame_pair(&self) -> (usize, usize, f32) {
        let stride = self.asset.vertex_count() * 6;
        (
            (self.a - self.asset.poses_start()) / stride,
            (self.b - self.asset.poses_start()) / stride,
            self.mix,
        )
    }
    pub fn new(clip: ActorClip, time: f32) -> Self {
        selected_asset().pose(clip, time)
    }
    /// Sample one unique vertex; callers reuse it through u16 indices.
    pub fn vertex(&self, i: usize) -> Vertex {
        assert!(i < self.asset.vertex_count());
        let component = |c| {
            let a = self.asset.u16_at(self.a + i * 6 + c) as i16 as f32;
            let b = self.asset.u16_at(self.b + i * 6 + c) as i16 as f32;
            (a + (b - a) * self.mix) * (1.0 / 256.0)
        };
        Vertex {
            color: self.asset.u32_at(self.asset.colors_start() + i * 4),
            x: component(0),
            y: component(2),
            z: component(4),
        }
    }
    pub fn fill(&self, out: &mut [Vertex]) {
        assert_eq!(out.len(), self.asset.vertex_count());
        // Validate the two complete frames once. Calling vertex() here left
        // six byte-range checks and a function call inside every vertex on
        // Allegrex; the checked fixed-size chunks keep the hot loop bounded.
        let bytes = out.len() * 6;
        let (a, _) = self.asset.data[self.a..self.a + bytes].as_chunks::<6>();
        let (b, _) = self.asset.data[self.b..self.b + bytes].as_chunks::<6>();
        let colors = self.asset.colors_start();
        let (colors, _) = self.asset.data[colors..colors + out.len() * 4].as_chunks::<4>();
        for (((v, a), b), color) in out.iter_mut().zip(a).zip(b).zip(colors) {
            let component = |offset: usize| {
                let a = i16::from_le_bytes([a[offset], a[offset + 1]]) as f32;
                let b = i16::from_le_bytes([b[offset], b[offset + 1]]) as f32;
                (a + (b - a) * self.mix) * (1.0 / 256.0)
            };
            *v = Vertex {
                color: u32::from_le_bytes(*color),
                x: component(0),
                y: component(2),
                z: component(4),
            };
        }
    }
    pub fn position(&self, i: usize) -> Vec3 {
        let v = self.vertex(i);
        Vec3::new(v.x, v.y, v.z)
    }
}

/// Validated immutable character data. A pose retains its originating asset,
/// so changing the active mod cannot reinterpret another character's offsets.
#[derive(Clone, Copy)]
pub struct Asset {
    data: &'static [u8],
}

impl Asset {
    pub fn parse(data: &'static [u8]) -> Result<Self, &'static str> {
        format::validate(data)?;
        Ok(Self { data })
    }
    fn header(&self) -> usize {
        if self.textured() { 40 } else { 24 }
    }
    pub fn textured(&self) -> bool {
        self.u32_at(4) == 2
    }
    pub fn baked_frame_count(&self) -> usize {
        self.u32_at(20) as usize
    }
    pub fn baked_vertex(&self, frame: usize, i: usize) -> PackedVertex {
        assert!(frame < self.baked_frame_count() && i < self.vertex_count());
        let at = self.poses_start() + (frame * self.vertex_count() + i) * 6;
        PackedVertex {
            color: self.u32_at(self.colors_start() + i * 4),
            x: self.u16_at(at) as i16,
            y: self.u16_at(at + 2) as i16,
            z: self.u16_at(at + 4) as i16,
            padding: 0,
        }
    }
    fn u32_at(&self, offset: usize) -> u32 {
        u32::from_le_bytes(self.data[offset..offset + 4].try_into().unwrap())
    }
    fn u16_at(&self, offset: usize) -> u16 {
        u16::from_le_bytes([self.data[offset], self.data[offset + 1]])
    }
    pub fn vertex_count(&self) -> usize {
        self.u32_at(8) as usize
    }
    pub fn index_count(&self) -> usize {
        self.u32_at(12) as usize
    }
    pub fn triangle_count(&self) -> usize {
        self.index_count() / 3
    }
    pub fn asset_bytes(&self) -> usize {
        self.data.len()
    }
    fn colors_start(&self) -> usize {
        self.header() + self.u32_at(16) as usize * RECORD
    }
    fn uv_start(&self) -> usize {
        self.colors_start() + self.vertex_count() * 4
    }
    fn indices_start(&self) -> usize {
        self.uv_start()
            + if self.textured() {
                self.vertex_count() * 4
            } else {
                0
            }
    }
    fn poses_start(&self) -> usize {
        self.indices_start() + self.index_count() * 2
    }
    pub fn index(&self, i: usize) -> usize {
        assert!(i < self.index_count());
        self.u16_at(self.indices_start() + i * 2) as usize
    }
    pub fn copy_indices(&self, out: &mut [u16]) {
        assert_eq!(out.len(), self.index_count());
        for (i, out) in out.iter_mut().enumerate() {
            *out = self.index(i) as u16;
        }
    }
    pub fn textured_vertex(&self, frame: usize, i: usize) -> TexturedVertex {
        assert!(self.textured() && i < self.vertex_count());
        TexturedVertex {
            u: self.u16_at(self.uv_start() + i * 4),
            v: self.u16_at(self.uv_start() + i * 4 + 2),
            vertex: self.baked_vertex(frame, i),
        }
    }
    fn sockets_start(&self) -> usize {
        self.poses_start() + self.baked_frame_count() * self.vertex_count() * 6
    }
    pub fn texture(&self) -> Option<(usize, &'static [u8])> {
        if !self.textured() {
            return None;
        }
        let start = self.sockets_start() + self.baked_frame_count() * 12;
        Some((self.u32_at(24) as usize, &self.data[start..]))
    }
    pub fn attack_origin(&self) -> Vec3 {
        if !self.textured() {
            return Vec3::new(3.60, 50.97, -36.52);
        }
        let frame = self.u32_at(self.header() + ActorClip::Fire as usize * RECORD) as usize;
        let at = self.sockets_start() + frame * 12;
        Vec3::new(
            f32::from_bits(self.u32_at(at)),
            f32::from_bits(self.u32_at(at + 4)),
            f32::from_bits(self.u32_at(at + 8)),
        )
    }
    pub fn duration(&self, clip: ActorClip) -> f32 {
        f32::from_bits(self.u32_at(self.header() + clip as usize * RECORD + 8))
    }
    pub fn pose(&self, clip: ActorClip, time: f32) -> Pose {
        let at = self.header() + clip as usize * RECORD;
        let start = self.u32_at(at) as usize;
        let count = self.u32_at(at + 4) as usize;
        let duration = self.duration(clip);
        let time = if time.is_finite() { time.max(0.0) } else { 0.0 };
        let time = if self.u32_at(at + 12) == 1 {
            time % duration
        } else {
            time.min(duration)
        };
        let frame = time / duration * (count - 1) as f32;
        let a = frame as usize;
        let b = (a + 1).min(count - 1);
        let stride = self.vertex_count() * 6;
        Pose {
            asset: *self,
            a: self.poses_start() + (start + a) * stride,
            b: self.poses_start() + (start + b) * stride,
            mix: frame - a as f32,
        }
    }
}

pub fn selected_asset() -> Asset {
    Asset { data: DATA }
}

#[cfg(test)]
mod tests {
    use super::*;
    extern crate std;
    #[test]
    fn poses_keep_their_own_asset_when_another_pack_is_selected() {
        let first = selected_asset();
        let mut bytes = DATA.to_vec();
        let color_at = first.colors_start();
        bytes[color_at..color_at + 4].copy_from_slice(&0xff123456u32.to_le_bytes());
        let second = Asset::parse(std::boxed::Box::leak(bytes.into_boxed_slice())).unwrap();
        let a = first.pose(ActorClip::Idle, 0.);
        let b = second.pose(ActorClip::Idle, 0.);
        assert_eq!(b.vertex(0).color, 0xff123456);
        assert_eq!(a.vertex(0).color, first.u32_at(color_at));
        assert_ne!(a.vertex(0).color, b.vertex(0).color);
        assert_eq!(a.position(0), b.position(0));
    }
    #[test]
    fn swizzled_texture_retains_every_texel_across_tile_boundaries() {
        for width in [16usize, 32, 128, 256] {
            let mut source = std::vec![0u8; width * width * 4];
            for (i, pixel) in source.chunks_exact_mut(4).enumerate() {
                pixel.copy_from_slice(&(i as u32).to_le_bytes());
            }
            let swizzled: std::vec::Vec<u8> = (0..source.len() / 16)
                .flat_map(|i| swizzled_rgba_block(&source, width, i))
                .collect();
            for y in 0..width {
                for x in 0..width {
                    let tile = (y / 8) * (width / 4) + x / 4;
                    let at = tile * 128 + (y % 8) * 16 + (x % 4) * 4;
                    assert_eq!(
                        &swizzled[at..at + 4],
                        &((y * width + x) as u32).to_le_bytes()
                    );
                }
            }
        }
    }
    #[test]
    fn authored_asset_stays_within_psp_budget_and_indices_are_valid() {
        assert_eq!(&DATA[..4], b"OPCH");
        format::validate(DATA).unwrap();
        assert_eq!(u32_at(16), ActorClip::ALL.len() as u32);
        assert!(asset_bytes() <= 4 * 1024 * 1024);
        assert!(triangle_count() <= 10922);
        if !textured() {
            assert!(asset_bytes() <= 512 * 1024);
            assert!(triangle_count() <= 1400);
        }
        assert!(index_count() * 2 <= 65536);
        assert_eq!(core::mem::size_of::<PackedVertex>(), 12);
        assert_eq!(core::mem::size_of::<TexturedVertex>(), 16);
        let stride = if textured() { 32 } else { 24 };
        assert!(baked_frame_count() * vertex_count() * stride <= MAX_CACHE_BYTES);
        for i in 0..index_count() {
            assert!(index(i) < vertex_count());
        }
    }
    #[test]
    fn every_authored_clip_moves_and_has_finite_bounded_poses() {
        for clip in ActorClip::ALL {
            let a = Pose::new(clip, 0.0);
            let b = Pose::new(clip, duration(clip) * 0.37);
            let mut moved = 0;
            for i in 0..vertex_count() {
                let p = b.position(i);
                assert!(p.is_finite() && p.abs().max_element() < 120.0);
                if a.position(i).distance_squared(p) > 0.01 {
                    moved += 1;
                }
            }
            assert!(moved > 10, "{clip:?}: only {moved} vertices moved");
        }
    }
    #[test]
    fn loops_wrap_and_one_shots_hold_final_pose() {
        for clip in ActorClip::ALL {
            let looping = matches!(clip, ActorClip::Idle | ActorClip::Walk | ActorClip::Run);
            let a = Pose::new(clip, if looping { 0.0 } else { duration(clip) });
            let b = Pose::new(clip, duration(clip) * 2.0);
            for i in 0..vertex_count() {
                assert!(a.position(i).distance(b.position(i)) < 0.01);
            }
        }
    }
    #[test]
    fn batch_sampling_preserves_every_clip_and_vertex() {
        let mut vertices = std::vec![Vertex::default(); vertex_count()];
        for clip in ActorClip::ALL {
            for fraction in [0.0, 0.13, 0.37, 0.81, 1.0, 2.0] {
                let pose = Pose::new(clip, duration(clip) * fraction);
                pose.fill(&mut vertices);
                let (a, b, weight) = pose.frame_pair();
                assert!(b == a || b == a + 1);
                assert!((0.0..=1.0).contains(&weight));
                if a == b {
                    assert_eq!(weight, 0.0);
                }
                for (i, batch) in vertices.iter().enumerate() {
                    let single = pose.vertex(i);
                    assert_eq!(batch.color, single.color);
                    assert_eq!([batch.x, batch.y, batch.z], [single.x, single.y, single.z]);
                    let a = baked_vertex(a, i);
                    let b = baked_vertex(b, i);
                    assert_eq!(a.color, single.color);
                    assert_eq!(a.color, b.color);
                    for ((a, b), expected) in [a.x, a.y, a.z]
                        .into_iter()
                        .zip([b.x, b.y, b.z])
                        .zip([single.x, single.y, single.z])
                    {
                        // GE decodes i16 / 32768; the model scale is 128.
                        let actual = (a as f32 * (1.0 - weight) + b as f32 * weight) / 256.0;
                        assert!((actual - expected).abs() < 0.001);
                    }
                }
            }
        }
    }
    #[test]
    fn death_is_a_grounded_authored_fall_and_gaits_close_the_loop() {
        let death = Pose::new(ActorClip::Death, duration(ActorClip::Death));
        let mut low = f32::MAX;
        let mut high = f32::MIN;
        for i in 0..vertex_count() {
            let y = death.position(i).y;
            low = low.min(y);
            high = high.max(y);
        }
        assert!(low >= 0.0 && low < 1.0);
        assert!(
            high < 30.0,
            "corpse must lie down in its own action: {high}"
        );
        for clip in [ActorClip::Idle, ActorClip::Walk, ActorClip::Run] {
            let (start, _, _) = Pose::new(clip, 0.0).frame_pair();
            let count = u32_at(header() + clip as usize * RECORD + 4) as usize;
            for i in 0..vertex_count() {
                let a = baked_vertex(start, i);
                let b = baked_vertex(start + count - 1, i);
                for (a, b) in [a.x, a.y, a.z].into_iter().zip([b.x, b.y, b.z]) {
                    assert!((a as i32 - b as i32).abs() < 128, "{clip:?} loop seam");
                }
            }
        }
    }
}
