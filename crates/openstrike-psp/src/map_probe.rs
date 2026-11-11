//! Camera-only stress tour. The normal simulation and HUD continue running.
//! Tour rows: eye x y z, pitch degrees. One complete yaw sweep per 600 frames.
use alloc::vec::Vec;
use glam::Vec3;
use pocket3d_gu::Camera3d;

pub struct MapProbe {
    views: Vec<(Vec3, f32)>,
}
impl MapProbe {
    pub fn new() -> Self {
        let views = include_str!(concat!(env!("OUT_DIR"), "/map-tour.txt"))
            .lines()
            .filter(|line| !line.trim().is_empty() && !line.starts_with('#'))
            .map(|line| {
                let p: Vec<f32> = line
                    .split_whitespace()
                    .map(|v| v.parse::<f32>().expect("tour number"))
                    .collect();
                assert!(p.len() == 4 && p.iter().all(|v| v.is_finite()), "tour row");
                (Vec3::new(p[0], p[1], p[2]), p[3].to_radians())
            })
            .collect::<Vec<_>>();
        assert!(!views.is_empty(), "empty tour");
        Self { views }
    }
    pub fn camera(&self, frame: u32, camera: &mut Camera3d) {
        let frame = frame.min(6000) % 6000; // hold the first view after the measured tour
        let (pos, pitch) = self.views[frame as usize / 600 % self.views.len()];
        camera.pos = pos;
        camera.pitch = pitch;
        camera.yaw = (frame % 600) as f32 * core::f32::consts::TAU / 600.0;
    }
}
