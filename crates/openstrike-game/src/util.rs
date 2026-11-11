//! Small shared pieces: a random generator, angles, easing, springs.
use glam::{Quat, Vec2, Vec3};

/// xorshift64*: deterministic per seed.
#[derive(Clone)]
pub struct Rng(u64);

impl Rng {
    pub fn new(seed: u64) -> Rng {
        Rng(seed.wrapping_mul(0x9E3779B97F4A7C15) | 1)
    }
    pub fn u32(&mut self) -> u32 {
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        (self.0.wrapping_mul(0x2545F4914F6CDD1D) >> 32) as u32
    }
    /// 0..1.
    pub fn f(&mut self) -> f32 {
        (self.u32() >> 8) as f32 / (1u32 << 24) as f32
    }
    /// -1..1.
    pub fn s(&mut self) -> f32 {
        self.f() * 2.0 - 1.0
    }
    pub fn range(&mut self, a: f32, b: f32) -> f32 {
        a + (b - a) * self.f()
    }
    pub fn below(&mut self, n: usize) -> usize {
        if n == 0 { 0 } else { self.u32() as usize % n }
    }
    pub fn chance(&mut self, p: f32) -> bool {
        self.f() < p
    }
    /// A point in the unit disc.
    pub fn disc(&mut self) -> Vec2 {
        let (r, a) = (self.f().sqrt(), self.f() * std::f32::consts::TAU);
        Vec2::new(r * a.cos(), r * a.sin())
    }
    /// A unit vector.
    pub fn sphere(&mut self) -> Vec3 {
        let z = self.s();
        let a = self.f() * std::f32::consts::TAU;
        let r = (1.0 - z * z).max(0.0).sqrt();
        Vec3::new(r * a.cos(), z, r * a.sin())
    }
}

/// Forward of a yaw (flat).
pub fn yaw_dir(yaw: f32) -> Vec3 {
    Vec3::new(-yaw.sin(), 0.0, -yaw.cos())
}

/// Right of a yaw (flat).
pub fn yaw_right(yaw: f32) -> Vec3 {
    Vec3::new(yaw.cos(), 0.0, -yaw.sin())
}

/// The direction of a view (yaw, pitch).
pub fn view_dir(yaw: f32, pitch: f32) -> Vec3 {
    let c = pitch.cos();
    Vec3::new(-yaw.sin() * c, pitch.sin(), -yaw.cos() * c)
}

/// (yaw, pitch) of a direction.
pub fn dir_angles(d: Vec3) -> (f32, f32) {
    ((-d.x).atan2(-d.z), d.y.clamp(-1.0, 1.0).asin())
}

/// The rotation whose -Z is the view (yaw, pitch), with `roll` about it.
pub fn view_quat(yaw: f32, pitch: f32, roll: f32) -> Quat {
    Quat::from_rotation_y(yaw) * Quat::from_rotation_x(pitch) * Quat::from_rotation_z(roll)
}

/// a - b wrapped to -pi..pi.
pub fn angle_diff(a: f32, b: f32) -> f32 {
    let mut d = (a - b) % std::f32::consts::TAU;
    if d > std::f32::consts::PI {
        d -= std::f32::consts::TAU;
    } else if d < -std::f32::consts::PI {
        d += std::f32::consts::TAU;
    }
    d
}

pub fn smooth(k: f32) -> f32 {
    let k = k.clamp(0.0, 1.0);
    k * k * (3.0 - 2.0 * k)
}

pub fn lerp(a: f32, b: f32, k: f32) -> f32 {
    a + (b - a) * k
}

/// Moves `v` toward `to` by at most `step`.
pub fn approach(v: f32, to: f32, step: f32) -> f32 {
    if v < to {
        (v + step).min(to)
    } else {
        (v - step).max(to)
    }
}

/// Exponential approach factor for a rate (1/s) over dt.
pub fn damp(rate: f32, dt: f32) -> f32 {
    1.0 - (-rate * dt).exp()
}

pub fn flat(v: Vec3) -> Vec3 {
    Vec3::new(v.x, 0.0, v.z)
}

/// A damped spring toward 0 (value, velocity), kicked by impulses on the velocity.
#[derive(Clone, Copy, Default, Debug)]
pub struct Spring {
    pub x: f32,
    pub v: f32,
}

impl Spring {
    pub fn step(&mut self, stiffness: f32, damping: f32, dt: f32) {
        // Semi-implicit Euler, sub-stepped for the stiff ones.
        let n = ((dt * stiffness.sqrt() * 0.5).ceil() as usize).clamp(1, 8);
        let h = dt / n as f32;
        for _ in 0..n {
            self.v += (-stiffness * self.x - damping * self.v) * h;
            self.x += self.v * h;
        }
    }
}

#[derive(Clone, Copy, Default, Debug)]
pub struct Spring3 {
    pub x: Vec3,
    pub v: Vec3,
}

impl Spring3 {
    pub fn step(&mut self, stiffness: f32, damping: f32, dt: f32) {
        let n = ((dt * stiffness.sqrt() * 0.5).ceil() as usize).clamp(1, 8);
        let h = dt / n as f32;
        for _ in 0..n {
            self.v += (-stiffness * self.x - damping * self.v) * h;
            self.x += self.v * h;
        }
    }
}
