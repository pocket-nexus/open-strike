//! Shared feathered muzzle, energy and impact geometry for native renderers.
use crate::{
    StrikeSim, muzzle,
    weapon::{EffectKind, FxBeam, FxSprite},
};
use alloc::vec::Vec;
use glam::{Mat4, Vec3};

pub struct EffectGeometry<V> {
    pub world: Vec<V>,
    pub viewmodel: Vec<V>,
    sprites: Vec<FxSprite>,
    beams: Vec<FxBeam>,
}
impl<V> Default for EffectGeometry<V> {
    fn default() -> Self {
        Self::new()
    }
}
impl<V> EffectGeometry<V> {
    pub fn new() -> Self {
        Self {
            world: Vec::with_capacity(crate::energy::MAX_FOCUS_VERTICES * 8),
            viewmodel: Vec::with_capacity(crate::energy::MAX_FOCUS_VERTICES),
            sprites: Vec::with_capacity(32),
            beams: Vec::with_capacity(32),
        }
    }
    pub fn prepare(
        &mut self,
        sim: &StrikeSim,
        fwd: Vec3,
        alpha: f32,
        vertex: impl Fn(Vec3, [f32; 4]) -> V,
    ) {
        self.world.clear();
        self.viewmodel.clear();
        self.sprites.clear();
        self.beams.clear();
        let right = fwd.cross(Vec3::Y).normalize_or_zero();
        let up = right.cross(fwd);
        for effect in &sim.effects.list {
            if let EffectKind::MuzzleFlash { pos } = effect.kind {
                let out = if effect.viewmodel {
                    &mut self.viewmodel
                } else {
                    &mut self.world
                };
                let mut emit = |v: muzzle::FlameVertex| {
                    let p = if effect.viewmodel {
                        sim.presentation.muzzle + v.position
                    } else {
                        pos + right * v.position.x + up * v.position.y - fwd * v.position.z
                    };
                    out.push(vertex(p, v.color));
                };
                if sim.presentation.shot == crate::presentation::ShotStyle::Beam {
                    crate::energy::focus(effect.age, effect.ttl, &mut emit);
                } else {
                    muzzle::emit(effect.age, effect.ttl, effect.variant, &mut emit);
                }
            } else if sim.presentation.shot != crate::presentation::ShotStyle::Flame {
                match effect.kind {
                    EffectKind::Tracer { a, b } => {
                        let a = if effect.viewmodel {
                            sim.viewmodel_transform_at(alpha)
                                .transform_point3(sim.presentation.muzzle)
                        } else {
                            a
                        };
                        crate::energy::beam(a, b, effect.age, effect.ttl, |v| {
                            self.world.push(vertex(v.position, v.color))
                        });
                    }
                    EffectKind::Impact { pos } | EffectKind::BloodPuff { pos } => {
                        crate::energy::focus(effect.age, effect.ttl, |v| {
                            self.world.push(vertex(
                                pos + right * v.position.x + up * v.position.y,
                                if sim.presentation.shot == crate::presentation::ShotStyle::Orb {
                                    [1.0, 0.84, 0.30, v.color[3]]
                                } else {
                                    v.color
                                },
                            ))
                        });
                    }
                    _ => {}
                }
            } else {
                effect.emit(&mut self.sprites, &mut self.beams);
            }
        }
        if sim.weapon.reloading()
            && sim.presentation.motion == crate::presentation::ViewMotion::Staff
        {
            let progress = sim.reload_frac();
            let angle = progress * core::f32::consts::TAU;
            let rotation = Mat4::from_rotation_z(angle);
            crate::energy::focus(0.0, 1.0, |v| {
                let p = sim.presentation.muzzle
                    + Vec3::Z * 5.0
                    + rotation.transform_vector3(v.position * (1.10 + 0.60 * progress));
                let mut color = v.color;
                color[3] *= (progress * 8.0).min(1.0) * (0.65 + 0.35 * progress);
                self.viewmodel.push(vertex(p, color));
            });
        }
        let mut quad = |a: Vec3, b: Vec3, c: Vec3, d: Vec3, color: [f32; 4]| {
            for p in [a, b, c, a, c, d] {
                self.world.push(vertex(p, color));
            }
        };
        for s in &self.sprites {
            let r = right * (s.size * 0.5);
            let u = up * (s.size * 0.5);
            quad(
                s.pos - r - u,
                s.pos + r - u,
                s.pos + r + u,
                s.pos - r + u,
                s.color,
            );
        }
        for b in &self.beams {
            let side = (b.b - b.a).cross(fwd).normalize_or_zero() * (b.width * 0.5);
            quad(b.a - side, b.b - side, b.b + side, b.a + side, b.color);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn muzzle_stays_in_viewmodel_space_and_expired_effects_clear() {
        let mut sim = StrikeSim::new(Vec3::new(100., 0., 200.), 0., Vec::new(), 0);
        sim.effects.spawn_viewmodel_muzzle(Vec3::splat(500.), 0.1);
        sim.effects.spawn(
            EffectKind::Impact {
                pos: Vec3::new(30., 40., 50.),
            },
            0.2,
        );
        let mut geometry = EffectGeometry::new();
        geometry.prepare(&sim, Vec3::NEG_Z, 0.5, |p, c| (p, c));
        assert!(geometry.viewmodel.len() > 6);
        assert!(!geometry.world.is_empty());
        assert!(
            geometry
                .viewmodel
                .iter()
                .all(|(p, _)| p.distance(sim.presentation.muzzle) < 40.)
        );
        assert!(geometry.viewmodel.iter().any(|(_, c)| c[3] == 0.));
        assert!(geometry.viewmodel.iter().any(|(_, c)| c[3] > 0.));
        let capacity = geometry.viewmodel.capacity();
        sim.effects.clear();
        geometry.prepare(&sim, Vec3::X, 1., |p, c| (p, c));
        assert!(geometry.world.is_empty() && geometry.viewmodel.is_empty());
        assert_eq!(geometry.viewmodel.capacity(), capacity);
    }
}
