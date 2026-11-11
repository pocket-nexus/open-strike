//! Untextured muzzle flame geometry. Local -Z follows the barrel; the origin
//! is the muzzle. Straight vertex alpha supplies the feathered silhouette.

use glam::Vec3;

#[derive(Clone, Copy, Debug)]
pub struct FlameVertex {
    pub position: Vec3,
    pub color: [f32; 4],
}

/// At most 56 triangles (2,688 bytes in the PSP's packed vertex format).
pub const MAX_VERTICES: usize = 56 * 3;

/// Emit a short white-hot core, irregular amber corona and two crossed jets.
/// No allocations, texture uploads or gameplay RNG calls are needed. The
/// silhouette stays stable within a shot and changes between shots.
pub fn emit(age: f32, ttl: f32, variant: u32, mut vertex: impl FnMut(FlameVertex)) {
    if ttl <= 0.0 || age >= ttl || !age.is_finite() || !ttl.is_finite() {
        return;
    }
    let t = (age / ttl).clamp(0.0, 1.0);
    let fade = 1.0 - t;
    let seed = variant.wrapping_mul(0x9e37_79b9).wrapping_add(0x85eb_ca6b);
    let (sin, cos) = crate::sin_cos((seed >> 16) as f32 * (core::f32::consts::TAU / 65536.0));
    let size = (0.85 + (seed & 255) as f32 / 1024.0) * (1.0 - 0.3 * t);
    let rotate = |p: Vec3| Vec3::new(p.x * cos - p.y * sin, p.x * sin + p.y * cos, p.z) * size;
    let v = |p: Vec3, rgb: [f32; 3], alpha: f32| FlameVertex {
        position: rotate(p),
        color: [rgb[0], rgb[1], rgb[2], alpha * fade],
    };
    let white = [1.0, 0.98, 0.78];
    let gold = [1.0, 0.65, 0.16];
    let orange = [1.0, 0.22, 0.015];
    let center = v(Vec3::new(0.0, 0.0, -2.0), white, 1.0);
    // Alternating long tongues and short gaps; different lengths avoid a
    // regular star outline. The last ring has zero alpha at every edge.
    const CIRCLE: [(f32, f32); 16] = [
        (1.0, 0.0),
        (0.92388, 0.382683),
        (0.707107, 0.707107),
        (0.382683, 0.92388),
        (0.0, 1.0),
        (-0.382683, 0.92388),
        (-0.707107, 0.707107),
        (-0.92388, 0.382683),
        (-1.0, 0.0),
        (-0.92388, -0.382683),
        (-0.707107, -0.707107),
        (-0.382683, -0.92388),
        (0.0, -1.0),
        (0.382683, -0.92388),
        (0.707107, -0.707107),
        (0.92388, -0.382683),
    ];
    let ring = |i: usize| {
        let (x, y) = CIRCLE[i % 16];
        let jitter = ((seed.rotate_left(i as u32) >> 28) as f32) / 15.0;
        let radius = if i % 4 == 0 {
            4.5 + jitter * 2.0
        } else {
            2.0 + jitter
        };
        (
            v(Vec3::new(x, y, -2.0), gold, 0.8),
            v(
                Vec3::new(x * radius, y * radius, -3.0 - jitter),
                orange,
                0.0,
            ),
        )
    };
    for i in 0..16 {
        let (inner_a, outer_a) = ring(i);
        let (inner_b, outer_b) = ring((i + 1) % 16);
        for p in [
            center, inner_a, inner_b, inner_a, outer_a, outer_b, inner_a, outer_b, inner_b,
        ] {
            vertex(p);
        }
    }
    // The jets extend away from the gun in two planes, so the flash has
    // depth when seen along or across the barrel instead of facing the camera.
    let length = 13.0 + ((seed >> 8) & 15) as f32 * 0.3;
    for side in [Vec3::X, Vec3::Y] {
        let root = v(Vec3::new(0.0, 0.0, -1.0), white, 0.85);
        let hot = v(Vec3::new(0.0, 0.0, -6.0), gold, 0.75);
        let a = v(side * 2.2 + Vec3::new(0.0, 0.0, -5.0), orange, 0.0);
        let b = v(side * -1.8 + Vec3::new(0.0, 0.0, -5.0), orange, 0.0);
        let tip = v(Vec3::new(0.0, 0.0, -length), orange, 0.0);
        for p in [root, a, hot, root, hot, b, hot, a, tip, hot, tip, b] {
            vertex(p);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloc::vec::Vec;

    fn mesh(age: f32, variant: u32) -> Vec<FlameVertex> {
        let mut out = Vec::new();
        emit(age, 0.06, variant, |v| out.push(v));
        out
    }

    #[test]
    fn flash_is_bounded_finite_and_expires() {
        for variant in [0, 1, 12, u32::MAX] {
            for age in [0.0, 0.016, 0.04, 0.059] {
                let vertices = mesh(age, variant);
                assert!(!vertices.is_empty() && vertices.len() <= MAX_VERTICES);
                assert_eq!(vertices.len() % 3, 0);
                for v in &vertices {
                    assert!(v.position.is_finite());
                    assert!(v.position.z < 0.0 && v.position.length() < 20.0);
                    assert!(v.color.iter().all(|c| (0.0..=1.0).contains(c)));
                    if v.position.truncate().length() > 2.0 || v.position.z < -10.0 {
                        assert_eq!(v.color[3], 0.0, "outer edges must blend into the scene");
                    }
                }
            }
        }
        assert!(mesh(0.06, 0).is_empty());
        assert!(mesh(1.0, 0).is_empty());
        for ttl in [0.0, -1.0, f32::NAN] {
            emit(0.0, ttl, 0, |_| panic!("invalid lifetime emitted a vertex"));
        }
    }

    #[test]
    fn variation_is_stable_and_fades_without_darkening_rgb() {
        let a = mesh(0.0, 7);
        let again = mesh(0.0, 7);
        let b = mesh(0.0, 8);
        let fading = mesh(0.03, 7);
        assert!(
            a.iter()
                .zip(&again)
                .all(|(x, y)| x.position == y.position && x.color == y.color)
        );
        assert!(a.iter().zip(&b).any(|(x, y)| x.position != y.position));
        for (early, late) in a.iter().zip(&fading) {
            assert_eq!(early.color[..3], late.color[..3]);
            assert!((late.color[3] - early.color[3] * 0.5).abs() < 0.0001);
        }
    }
}
