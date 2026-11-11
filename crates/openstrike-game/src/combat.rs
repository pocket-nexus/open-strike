//! Shots and grenades: a ray against the actors' hit zones (head, body, legs) and the world, a grenade's flight.
use crate::actor::Actor;
use crate::world::Map;
use glam::Vec3;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Zone {
    Head,
    Body,
    Limb,
}

/// Ray (origin, unit direction) against a sphere: the entry distance.
fn ray_sphere(o: Vec3, d: Vec3, c: Vec3, r: f32) -> Option<f32> {
    let m = o - c;
    let b = m.dot(d);
    let q = m.length_squared() - r * r;
    if q > 0.0 && b > 0.0 {
        return None;
    }
    let disc = b * b - q;
    (disc >= 0.0).then(|| (-b - disc.sqrt()).max(0.0))
}

/// Ray against a vertical capsule (axis from `a` up to `b`, radius r): the entry distance.
fn ray_capsule(o: Vec3, d: Vec3, a: Vec3, b: Vec3, r: f32) -> Option<f32> {
    // The cylinder's side (in the horizontal plane), between the caps.
    let (ox, oz) = (o.x - a.x, o.z - a.z);
    let qa = d.x * d.x + d.z * d.z;
    let mut best: Option<f32> = None;
    if qa > 1e-8 {
        let qb = ox * d.x + oz * d.z;
        let qc = ox * ox + oz * oz - r * r;
        let disc = qb * qb - qa * qc;
        if disc >= 0.0 {
            let t = (-qb - disc.sqrt()) / qa;
            let y = o.y + d.y * t;
            if t >= 0.0 && y >= a.y && y <= b.y {
                best = Some(t);
            }
        }
    }
    for c in [a, b] {
        if let Some(t) = ray_sphere(o, d, c, r) {
            if best.is_none_or(|x| t < x) {
                best = Some(t);
            }
        }
    }
    best
}

/// Where a ray enters an actor, and which zone: the nearest of its head, body and legs.
pub fn hit_actor(a: &Actor, o: Vec3, d: Vec3) -> Option<(f32, Zone)> {
    let f = a.feet();
    let eye = a.eye_height();
    // Crouched, the body folds: shorter zones under a lower head.
    let k = a.crouch_k;
    let head = f + Vec3::Y * (eye + 2.5);
    let (b0, b1) = (eye - 29.0 + 9.0 * k, eye - 9.0);
    let (l0, l1) = (6.0, (eye - 31.0 + 9.0 * k).max(8.0));
    let mut best: Option<(f32, Zone)> = None;
    let mut take = |t: Option<f32>, z: Zone| {
        if let Some(t) = t {
            if best.is_none_or(|(x, _)| t < x) {
                best = Some((t, z));
            }
        }
    };
    // A quick reject on the whole silhouette first.
    if ray_capsule(o, d, f + Vec3::Y * 6.0, f + Vec3::Y * (eye + 4.0), 14.0).is_none() {
        return None;
    }
    take(ray_sphere(o, d, head, 5.6), Zone::Head);
    take(
        ray_capsule(o, d, f + Vec3::Y * b0, f + Vec3::Y * b1, 9.2),
        Zone::Body,
    );
    take(
        ray_capsule(o, d, f + Vec3::Y * l0, f + Vec3::Y * l1, 8.2),
        Zone::Limb,
    );
    best
}

/// The points of an actor a watcher checks for sight: head, chest.
pub fn sight_points(a: &Actor) -> [Vec3; 2] {
    let f = a.feet();
    let eye = a.eye_height();
    [f + Vec3::Y * (eye + 1.0), f + Vec3::Y * (eye - 18.0)]
}

pub const FUSE: f32 = 2.4;
/// A thrown grenade's speed: about 28 m of reach under GoldSrc's gravity.
pub const THROW_SPEED: f32 = 950.0;
pub const BLAST_RADIUS: f32 = 330.0;
pub const BLAST_DAMAGE: f32 = 150.0;

#[derive(Clone, Copy, Debug)]
pub struct Grenade {
    pub pos: Vec3,
    pub vel: Vec3,
    pub fuse: f32,
    pub owner: usize,
    /// Tumble (radians), for the screen.
    pub spin: f32,
    pub resting: bool,
}

impl Grenade {
    /// Advances the flight; the speed into a surface it bounced off, if it did.
    pub fn step(&mut self, map: &Map, dt: f32) -> Option<f32> {
        self.fuse -= dt;
        if self.resting {
            return None;
        }
        self.vel.y -= 800.0 * dt;
        self.spin += self.vel.length() * dt * 0.06;
        let to = self.pos + self.vel * dt;
        let tr = map.ray(self.pos, to);
        if tr.start_solid {
            self.resting = true;
            return None;
        }
        if tr.fraction >= 1.0 {
            self.pos = to;
            return None;
        }
        let n = tr.normal;
        self.pos = tr.end + n * 0.5;
        let into = -self.vel.dot(n);
        // Bounce: most of the normal speed is lost, the ground rubs the rest.
        let mut v = self.vel + n * into * 1.42;
        if n.y > 0.7 {
            v.x *= 0.72;
            v.z *= 0.72;
            if v.length() < 55.0 {
                self.resting = true;
                v = Vec3::ZERO;
            }
        }
        self.vel = v;
        (into > 60.0).then_some(into)
    }
}

/// The velocity to lob a grenade from `from` so it lands near `to` (a flat arc; None beyond its reach).
pub fn lob(from: Vec3, to: Vec3, speed: f32) -> Option<Vec3> {
    let d = to - from;
    let h = Vec3::new(d.x, 0.0, d.z);
    let x = h.length();
    if x < 1.0 {
        return None;
    }
    let (g, v2) = (800.0, speed * speed);
    let disc = v2 * v2 - g * (g * x * x + 2.0 * d.y * v2);
    if disc < 0.0 {
        return None;
    }
    let angle = ((v2 - disc.sqrt()) / (g * x)).atan();
    Some(h / x * speed * angle.cos() + Vec3::Y * speed * angle.sin())
}
