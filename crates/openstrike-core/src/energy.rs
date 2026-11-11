//! Bounded, untextured energy focus and beam meshes. Shared by presentation
//! backends; these functions never consume simulation RNG or allocate.
use crate::muzzle::FlameVertex;
use glam::Vec3;
const CIRCLE: [(f32, f32); 16] = [
    (1., 0.),
    (0.92388, 0.382683),
    (0.707107, 0.707107),
    (0.382683, 0.92388),
    (0., 1.),
    (-0.382683, 0.92388),
    (-0.707107, 0.707107),
    (-0.92388, 0.382683),
    (-1., 0.),
    (-0.92388, -0.382683),
    (-0.707107, -0.707107),
    (-0.382683, -0.92388),
    (0., -1.),
    (0.382683, -0.92388),
    (0.707107, -0.707107),
    (0.92388, -0.382683),
];
pub const MAX_FOCUS_VERTICES: usize = 16 * 6 * 2 + 8 * 6;
pub const MAX_BEAM_VERTICES: usize = 8 * 6 * 2;

fn fade(age: f32, ttl: f32) -> Option<f32> {
    if !age.is_finite() || !ttl.is_finite() || ttl <= 0. || age >= ttl {
        None
    } else {
        Some(1. - (age / ttl).clamp(0., 1.))
    }
}
pub fn focus(age: f32, ttl: f32, mut emit: impl FnMut(FlameVertex)) {
    let Some(alpha) = fade(age, ttl) else { return };
    let scale = 1. + (1. - alpha) * 0.22;
    let v = |x: f32, y: f32, a: f32| FlameVertex {
        position: Vec3::new(x * scale, y * scale, -0.5),
        color: [0.63, 0.88, 1., a * alpha],
    };
    for radius in [3.8, 5.3] {
        for i in 0..16 {
            let (x, y) = CIRCLE[i];
            let (u, w) = CIRCLE[(i + 1) % 16];
            let a = v(x * (radius - 0.10), y * (radius - 0.10), 0.95);
            let b = v(u * (radius - 0.10), w * (radius - 0.10), 0.95);
            let c = v(u * (radius + 0.10), w * (radius + 0.10), 0.95);
            let d = v(x * (radius + 0.10), y * (radius + 0.10), 0.95);
            for p in [a, b, c, a, c, d] {
                emit(p);
            }
        }
    }
    // Eight angular marks connect the two rings without a solid disc.
    for i in (0..16).step_by(2) {
        let (x, y) = CIRCLE[i];
        let a = v(x * 4.0, y * 4.0, 0.85);
        let b = v(x * 4.9 - y * 0.22, y * 4.9 + x * 0.22, 0.85);
        let c = v(x * 4.9 + y * 0.22, y * 4.9 - x * 0.22, 0.85);
        let d = v(x * 4.55, y * 4.55, 0.85);
        for p in [a, b, d, a, d, c] {
            emit(p);
        }
    }
}

pub fn beam(a: Vec3, b: Vec3, age: f32, ttl: f32, mut emit: impl FnMut(FlameVertex)) {
    let Some(alpha) = fade(age, ttl) else { return };
    let delta = b - a;
    if !a.is_finite() || !b.is_finite() || delta.length_squared() < 0.0001 {
        return;
    }
    let dir = delta.normalize();
    let axis = if dir.y.abs() < 0.9 { Vec3::Y } else { Vec3::X };
    let right = dir.cross(axis).normalize();
    let up = right.cross(dir);
    for (radius, color) in [
        (1.25, [1., 1., 1., alpha]),
        (2.8, [0.28, 0.62, 1., 0.22 * alpha]),
    ] {
        for i in 0..8 {
            let (x, y) = CIRCLE[i * 2];
            let (u, w) = CIRCLE[((i + 1) * 2) % 16];
            let p = right * x * radius + up * y * radius;
            let q = right * u * radius + up * w * radius;
            for position in [a + p, b + p, b + q, a + p, b + q, a + q] {
                emit(FlameVertex { position, color });
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn meshes_are_bounded_finite_and_expire_in_every_direction() {
        for end in [Vec3::X, Vec3::Y, Vec3::Z, -Vec3::Y] {
            let mut count = 0;
            beam(Vec3::ZERO, end * 100., 0., 0.18, |v| {
                count += 1;
                assert!(v.position.is_finite());
                assert!(v.color.iter().all(|x| (0.0..=1.0).contains(x)));
            });
            assert_eq!(count, MAX_BEAM_VERTICES);
        }
        let mut count = 0;
        focus(0., 0.18, |v| {
            count += 1;
            assert!(v.position.is_finite());
        });
        assert_eq!(count, MAX_FOCUS_VERTICES);
        focus(0.18, 0.18, |_| panic!("expired focus"));
        beam(Vec3::ZERO, Vec3::ZERO, 0., 0.18, |_| panic!("zero beam"));
        beam(Vec3::ZERO, Vec3::X, f32::NAN, 0.18, |_| {
            panic!("invalid age")
        });
    }
}
