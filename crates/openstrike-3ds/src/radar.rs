//! A bounded floor slice derived from canonical cooked geometry, north = -Z.
use alloc::{vec, vec::Vec};
use glam::Vec3;
use pocket3d_bsp::cooked::{CookedMap, VERTEX_STRIDE};
pub const WIDTH: usize = 208;
pub const HEIGHT: usize = 152;
pub const TEXTURE_WIDTH: usize = 256;
pub const TEXTURE_HEIGHT: usize = 256;
pub fn texture_pixels(pixels: &[u8]) -> Vec<u8> {
    let mut padded = vec![0; TEXTURE_WIDTH * TEXTURE_HEIGHT * 4];
    for y in 0..HEIGHT {
        padded[y * TEXTURE_WIDTH * 4..y * TEXTURE_WIDTH * 4 + WIDTH * 4]
            .copy_from_slice(&pixels[y * WIDTH * 4..(y + 1) * WIDTH * 4]);
    }
    padded
}

#[derive(Clone, Copy)]
pub struct Projection {
    pub scale: f32,
    pub x: f32,
    pub z: f32,
}
impl Projection {
    pub fn new(min: Vec3, max: Vec3) -> Self {
        let scale = ((WIDTH - 12) as f32 / (max.x - min.x).max(1.0))
            .min((HEIGHT - 12) as f32 / (max.z - min.z).max(1.0));
        Self {
            scale,
            x: WIDTH as f32 / 2.0 - (min.x + max.x) * 0.5 * scale,
            z: HEIGHT as f32 / 2.0 - (min.z + max.z) * 0.5 * scale,
        }
    }
    pub fn point(&self, p: Vec3) -> [f32; 2] {
        [p.x * self.scale + self.x, p.z * self.scale + self.z]
    }
}
pub fn vertex(map: &CookedMap<'_>, index: usize) -> Vec3 {
    let v = &map.verts[index * VERTEX_STRIDE..][12..];
    let read = |i| i16::from_le_bytes([v[i], v[i + 1]]) as f32;
    Vec3::new(read(0), read(2), read(4))
}
/// Upward geometry is decoded once; floor changes do not scan walls or roofs again.
pub struct FloorMesh {
    projection: Projection,
    triangles: Vec<[Vec3; 3]>,
}
impl FloorMesh {
    pub fn new(map: &CookedMap<'_>) -> Self {
        let mut triangles = Vec::new();
        for batch in &map.batches {
            for tri in map.indices[batch.index_base as usize..][..batch.index_count as usize]
                .as_chunks::<3>()
                .0
            {
                let v = [
                    vertex(map, batch.vert_base as usize + tri[0] as usize),
                    vertex(map, batch.vert_base as usize + tri[1] as usize),
                    vertex(map, batch.vert_base as usize + tri[2] as usize),
                ];
                let normal = (v[1] - v[0]).cross(v[2] - v[0]);
                if normal.y <= -normal.length() * 0.35 {
                    triangles.push(v);
                }
            }
        }
        Self {
            projection: Projection::new(map.bounds.0, map.bounds.1),
            triangles,
        }
    }
}
/// Incremental floor selection; each turn has a bounded triangle budget.
pub struct RasterJob {
    pub projection: Projection,
    pub floor: f32,
    heights: Vec<f32>,
    offset: usize,
}
impl RasterJob {
    pub fn new(mesh: &FloorMesh, floor: f32) -> Self {
        Self {
            projection: mesh.projection,
            floor,
            heights: vec![f32::NEG_INFINITY; WIDTH * HEIGHT],
            offset: 0,
        }
    }
    pub fn advance(&mut self, mesh: &FloorMesh, triangles: usize) -> bool {
        let end = self
            .offset
            .saturating_add(triangles)
            .min(mesh.triangles.len());
        for &v in &mesh.triangles[self.offset..end] {
            raster_triangle(self.projection, self.floor, &mut self.heights, v);
        }
        self.offset = end;
        end == mesh.triangles.len()
    }
    pub fn pixels(&self) -> Vec<u8> {
        finish(&self.heights, self.floor)
    }
}
fn raster_triangle(p: Projection, floor: f32, heights: &mut [f32], v: [Vec3; 3]) {
    let q = v.map(|a| p.point(a));
    let edge = |a: [f32; 2], b: [f32; 2], c: [f32; 2]| {
        (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
    };
    let area = edge(q[0], q[1], q[2]);
    if area.abs() < 0.01 {
        return;
    }
    let minx = q.iter().map(|a| a[0]).fold(f32::INFINITY, f32::min).max(0.) as usize;
    let maxx = libm::ceilf(q.iter().map(|a| a[0]).fold(f32::NEG_INFINITY, f32::max))
        .min((WIDTH - 1) as f32) as usize;
    let miny = q.iter().map(|a| a[1]).fold(f32::INFINITY, f32::min).max(0.) as usize;
    let maxy = libm::ceilf(q.iter().map(|a| a[1]).fold(f32::NEG_INFINITY, f32::max))
        .min((HEIGHT - 1) as f32) as usize;
    for y in miny..=maxy {
        for x in minx..=maxx {
            let at = [x as f32 + 0.5, y as f32 + 0.5];
            let a = edge(q[1], q[2], at) / area;
            let b = edge(q[2], q[0], at) / area;
            let c = 1. - a - b;
            if a < 0. || b < 0. || c < 0. {
                continue;
            }
            let h = a * v[0].y + b * v[1].y + c * v[2].y;
            let score =
                |height: f32| (height - floor).abs() + if height > floor + 40. { 512. } else { 0. };
            if score(h) < score(heights[y * WIDTH + x]) {
                heights[y * WIDTH + x] = h;
            }
        }
    }
}
fn finish(heights: &[f32], floor: f32) -> Vec<u8> {
    let mut pixels = vec![0; WIDTH * HEIGHT * 4];
    for (i, y) in heights.iter().enumerate() {
        let color = if y.is_finite() {
            let dim = ((floor - y).abs() / 384.0).min(0.70);
            [
                (87.0 * (1.0 - dim)) as u8,
                (111.0 * (1.0 - dim)) as u8,
                (122.0 * (1.0 - dim)) as u8,
                255,
            ]
        } else {
            [10, 19, 26, 255]
        };
        pixels[i * 4..i * 4 + 4].copy_from_slice(&color);
    }
    // One-pixel contour separates walkable areas from the surrounding void.
    for y in 1..HEIGHT - 1 {
        for x in 1..WIDTH - 1 {
            let i = y * WIDTH + x;
            if heights[i].is_finite()
                && [i - 1, i + 1, i - WIDTH, i + WIDTH]
                    .iter()
                    .any(|j| !heights[*j].is_finite())
            {
                pixels[i * 4..i * 4 + 4].copy_from_slice(&[137, 164, 174, 255]);
            }
        }
    }
    pixels
}
pub fn raster(map: &CookedMap<'_>, floor: f32) -> (Projection, Vec<u8>) {
    let mesh = FloorMesh::new(map);
    let mut job = RasterJob::new(&mesh, floor);
    job.advance(&mesh, usize::MAX);
    (job.projection, job.pixels())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn tall_and_wide_worlds_preserve_aspect_and_north() {
        for max in [Vec3::new(4096., 10., 512.), Vec3::new(256., 10., 8192.)] {
            let p = Projection::new(Vec3::ZERO, max);
            let a = p.point(Vec3::ZERO);
            let b = p.point(max);
            assert!(
                a[0] >= 5.9
                    && a[1] >= 5.9
                    && b[0] <= WIDTH as f32 - 5.9
                    && b[1] <= HEIGHT as f32 - 5.9
            );
            assert!(((b[0] - a[0]) / (b[1] - a[1]) - max.x / max.z).abs() < 0.001);
            assert!(p.point(Vec3::NEG_Z)[1] < a[1]);
        }
    }
    #[test]
    #[ignore = "requires locally cooked maps; writes radar previews"]
    fn cooked_maps_have_readable_floor_coverage() {
        use std::{fs, path::PathBuf};
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
        let maps = std::env::var_os("OPENSTRIKE_COOKED_MAPS")
            .map(PathBuf::from)
            .unwrap_or(root.join("dist/maps"));
        let out = root.join("out/3ds/radars");
        fs::create_dir_all(&out).unwrap();
        for name in [
            "cs_assault",
            "cs_office",
            "de_aztec",
            "de_dust",
            "de_dust2",
            "de_inferno",
            "de_nuke",
            "de_train",
            "wwdc24-parkour",
        ] {
            let bytes = fs::read(maps.join(format!("{name}.p3d"))).unwrap();
            let map = pocket3d_bsp::cooked::read(&bytes).unwrap();
            let (_, pixels) = raster(&map, -96.);
            let mesh = FloorMesh::new(&map);
            let mut incremental = RasterJob::new(&mesh, -96.);
            while !incremental.advance(&mesh, 128) {}
            assert_eq!(
                incremental.pixels(),
                pixels,
                "{name}: incremental floor differs"
            );
            let covered = pixels
                .chunks_exact(4)
                .filter(|p| p[0] != 10 || p[1] != 19)
                .count();
            assert!(
                covered > WIDTH * HEIGHT / 20,
                "{name}: only {covered} floor pixels"
            );
            let mut ppm = format!("P6\n{WIDTH} {HEIGHT}\n255\n").into_bytes();
            for p in pixels.chunks_exact(4) {
                ppm.extend_from_slice(&p[..3]);
            }
            fs::write(out.join(format!("{name}.ppm")), ppm).unwrap();
        }
    }
}
