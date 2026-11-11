//! Bounded ballistic shots. Hosts draw these positions; impact is resolved by
//! the fixed-step simulation, never by an effect timer or the initial aim ray.
use alloc::vec::Vec;
use glam::Vec3;

pub const MAX_PROJECTILES: usize = 32;

#[derive(Clone, Copy, Debug)]
pub struct Config {
    pub speed: f32,
    pub gravity: f32,
    pub lift: f32,
    pub radius: f32,
    pub lifetime: f32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Owner {
    Player,
    Bot,
}

pub struct Projectile {
    pub position: Vec3,
    pub previous: Vec3,
    pub velocity: Vec3,
    pub owner: Owner,
    pub age: f32,
    pub config: Config,
    pub damage_body: i32,
    pub damage_head: i32,
}

pub struct Projectiles {
    pub list: Vec<Projectile>,
}
impl Default for Projectiles {
    fn default() -> Self {
        Self {
            list: Vec::with_capacity(MAX_PROJECTILES),
        }
    }
}
impl Projectiles {
    pub fn available(&self) -> bool {
        self.list.len() < MAX_PROJECTILES
    }
    #[allow(clippy::too_many_arguments)]
    pub fn launch(
        &mut self,
        from: Vec3,
        target: Vec3,
        owner: Owner,
        config: Config,
        body: i32,
        head: i32,
    ) -> bool {
        if !self.available() || !from.is_finite() || !target.is_finite() {
            return false;
        }
        self.list.push(Projectile {
            position: from,
            previous: from,
            velocity: (target - from).normalize_or_zero() * config.speed + Vec3::Y * config.lift,
            owner,
            age: 0.0,
            config,
            damage_body: body,
            damage_head: head,
        });
        true
    }
}

impl Projectile {
    pub fn advance(&mut self, dt: f32) {
        self.previous = self.position;
        self.position += self.velocity * dt - Vec3::Y * (0.5 * self.config.gravity * dt * dt);
        self.velocity.y -= self.config.gravity * dt;
        self.age += dt;
    }
}

/// A segment against an actor's expanded bounds, including axis-parallel
/// trajectories. Returns a fraction and cannot skip a thin target at speed.
pub fn segment_box(start: Vec3, end: Vec3, min: Vec3, max: Vec3) -> Option<f32> {
    let delta = end - start;
    let mut enter = 0.0f32;
    let mut exit = 1.0f32;
    for axis in 0..3 {
        if delta[axis].abs() < 0.000001 {
            if start[axis] < min[axis] || start[axis] > max[axis] {
                return None;
            }
        } else {
            let a = (min[axis] - start[axis]) / delta[axis];
            let b = (max[axis] - start[axis]) / delta[axis];
            enter = enter.max(a.min(b));
            exit = exit.min(a.max(b));
            if enter > exit {
                return None;
            }
        }
    }
    Some(enter)
}
