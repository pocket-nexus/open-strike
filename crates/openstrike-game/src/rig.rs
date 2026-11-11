//! The soldiers' bodies: one skinned glTF model (a Mixamo skeleton with Idle / Walk / Run clips) posed every frame by
//! this module rather than by canned clips: the legs blend the clips by speed and run along the direction of travel,
//! the spine and head follow the aim, both arms are placed on the carried weapon by two-bone IK (ready, aiming,
//! sprinting, reloading), a crouch lowers the hips over planted feet, a hit jolts the torso, and death hands the body
//! to a ragdoll (verlet particles and sticks against the map) that the skeleton then follows.
//!
//! Model space: metres, Y up, facing -Z, the origin between the feet. `Puppet::pose` is the result: local translation
//! and rotation of every posed node, packed for the renderer.
use crate::actor::Actor;
use crate::util::{Rng, Spring3, angle_diff, damp, flat, smooth, yaw_dir, yaw_right};
use crate::view::WeaponMeta;
use crate::weapons::Class;
use crate::world::{Map, UNIT};
use anyhow::{Context, Result, anyhow};
use glam::{Mat3, Quat, Vec3};
use std::collections::HashMap;
use std::path::Path;

struct Track {
    times: Vec<f32>,
    values: Vec<[f32; 4]>,
}

impl Track {
    fn sample(&self, t: f32) -> [f32; 4] {
        let n = self.times.len();
        if n == 0 {
            return [0.0, 0.0, 0.0, 1.0];
        }
        if t <= self.times[0] || n == 1 {
            return self.values[0];
        }
        if t >= self.times[n - 1] {
            return self.values[n - 1];
        }
        let k = self.times.partition_point(|&x| x <= t) - 1;
        let u = (t - self.times[k]) / (self.times[k + 1] - self.times[k]).max(1e-6);
        let (a, b) = (self.values[k], self.values[k + 1]);
        [0, 1, 2, 3].map(|i| a[i] + (b[i] - a[i]) * u)
    }
}

struct Clip {
    duration: f32,
    /// Per node: translation and rotation tracks.
    tracks: Vec<(Option<Track>, Option<Track>)>,
}

/// The named bones this module moves.
#[derive(Clone, Copy, Default)]
struct Bones {
    hips: usize,
    spine: [usize; 3],
    neck: usize,
    head: usize,
    head_top: usize,
    /// Per side (0 left, 1 right): upper arm, forearm, hand; thigh, shin, foot.
    arm: [[usize; 3]; 2],
    leg: [[usize; 3]; 2],
}

pub struct Rig {
    parents: Vec<Option<usize>>,
    /// Nodes in an order with parents first.
    order: Vec<usize>,
    rest: Vec<(Vec3, Quat, f32)>,
    clips: HashMap<&'static str, Clip>,
    b: Bones,
    /// The nodes written to the pose: the skeleton under the hips.
    posed: Vec<usize>,
    /// The fingers' curl around a grip (local rotations).
    fingers: Vec<(usize, Quat)>,
    /// Rest pose in model space.
    rest_g: Vec<G>,
    /// Hand rest orientations expressed by (finger direction, palm normal), per side.
    hand_axes: [(Vec3, Vec3); 2],
}

/// A node's global transform: position, rotation, uniform scale.
#[derive(Clone, Copy, Debug)]
struct G {
    p: Vec3,
    r: Quat,
    s: f32,
}

impl Rig {
    pub fn load(path: &Path) -> Result<Rig> {
        let g = gltf::Gltf::open(path).with_context(|| format!("{}", path.display()))?;
        let blob = g.blob.clone().context("the soldier must be a .glb")?;
        let doc = g.document;
        let n = doc.nodes().len();
        let mut parents = vec![None; n];
        let mut names = vec![String::new(); n];
        let mut rest = vec![(Vec3::ZERO, Quat::IDENTITY, 1.0); n];
        for node in doc.nodes() {
            let (t, r, s) = node.transform().decomposed();
            rest[node.index()] = (Vec3::from(t), Quat::from_array(r), s[0]);
            names[node.index()] = node.name().unwrap_or("").to_string();
            for c in node.children() {
                parents[c.index()] = Some(node.index());
            }
        }
        let mut order = vec![];
        let mut stack: Vec<usize> = (0..n).filter(|i| parents[*i].is_none()).collect();
        while let Some(i) = stack.pop() {
            order.push(i);
            stack.extend(doc.nodes().nth(i).unwrap().children().map(|c| c.index()));
        }
        let find = |name: &str| {
            names
                .iter()
                .position(|x| x.strip_prefix("mixamorig:").unwrap_or(x) == name)
                .ok_or_else(|| anyhow!("the soldier has no bone {name}"))
        };
        let side = |s: &str, parts: [&str; 3]| -> Result<[usize; 3]> {
            Ok([
                find(&format!("{s}{}", parts[0]))?,
                find(&format!("{s}{}", parts[1]))?,
                find(&format!("{s}{}", parts[2]))?,
            ])
        };
        let b = Bones {
            hips: find("Hips")?,
            spine: [find("Spine")?, find("Spine1")?, find("Spine2")?],
            neck: find("Neck")?,
            head: find("Head")?,
            head_top: find("HeadTop_End")?,
            arm: [
                side("Left", ["Arm", "ForeArm", "Hand"])?,
                side("Right", ["Arm", "ForeArm", "Hand"])?,
            ],
            leg: [
                side("Left", ["UpLeg", "Leg", "Foot"])?,
                side("Right", ["UpLeg", "Leg", "Foot"])?,
            ],
        };
        let mut clips = HashMap::new();
        for a in doc.animations() {
            let key = match a.name() {
                Some("Idle") => "Idle",
                Some("Walk") => "Walk",
                Some("Run") => "Run",
                _ => continue,
            };
            let mut clip = Clip {
                duration: 0.0,
                tracks: (0..n).map(|_| (None, None)).collect(),
            };
            for ch in a.channels() {
                let r = ch.reader(|_| Some(&blob[..]));
                let (Some(inputs), Some(outputs)) = (r.read_inputs(), r.read_outputs()) else {
                    continue;
                };
                let times: Vec<f32> = inputs.collect();
                clip.duration = clip.duration.max(times.last().copied().unwrap_or(0.0));
                let node = ch.target().node().index();
                use gltf::animation::util::ReadOutputs;
                match outputs {
                    ReadOutputs::Translations(t) => {
                        clip.tracks[node].0 = Some(Track {
                            times,
                            values: t.map(|v| [v[0], v[1], v[2], 0.0]).collect(),
                        })
                    }
                    ReadOutputs::Rotations(q) => {
                        clip.tracks[node].1 = Some(Track {
                            times,
                            values: q.into_f32().collect(),
                        })
                    }
                    _ => {}
                }
            }
            clips.insert(key, clip);
        }
        for k in ["Idle", "Walk", "Run"] {
            if !clips.contains_key(k) {
                return Err(anyhow!("the soldier has no {k} clip"));
            }
        }
        // The skeleton: the hips and everything under them.
        let under = |mut i: usize| loop {
            if i == b.hips {
                return true;
            }
            match parents[i] {
                Some(p) => i = p,
                None => return false,
            }
        };
        let posed: Vec<usize> = order.iter().copied().filter(|i| under(*i)).collect();
        let mut rig = Rig {
            parents,
            order,
            rest,
            clips,
            b,
            posed,
            fingers: vec![],
            rest_g: vec![],
            hand_axes: [(Vec3::X, Vec3::NEG_Y); 2],
        };
        let l: Vec<(Vec3, Quat)> = rig.rest.iter().map(|r| (r.0, r.1)).collect();
        rig.rest_g = rig.fk(&l);
        // Fingers curl toward the palm: in the T pose that is a turn about the model's Z axis (mirrored per hand).
        for (i, name) in names.iter().enumerate() {
            let short = name.strip_prefix("mixamorig:").unwrap_or(name);
            let (left, rest_name) = match (
                short.strip_prefix("LeftHand"),
                short.strip_prefix("RightHand"),
            ) {
                (Some(r), _) => (true, r),
                (_, Some(r)) => (false, r),
                _ => continue,
            };
            if rest_name.is_empty() || rest_name.ends_with('4') {
                continue;
            }
            let joint = rest_name
                .chars()
                .last()
                .and_then(|c| c.to_digit(10))
                .unwrap_or(1);
            let thumb = rest_name.starts_with("Thumb");
            let angle: f32 = if thumb {
                [0.0, 22.0, 28.0, 30.0][joint as usize]
            } else {
                [0.0, 58.0, 66.0, 44.0][joint as usize]
            };
            let world_axis = if thumb {
                Vec3::new(0.0, if left { -1.0 } else { 1.0 }, 0.35).normalize()
            } else {
                Vec3::Z * if left { 1.0 } else { -1.0 }
            };
            let axis = rig.rest_g[i].r.inverse() * world_axis;
            rig.fingers.push((
                i,
                rig.rest[i].1 * Quat::from_axis_angle(axis, angle.to_radians()),
            ));
        }
        // Hands at rest: fingers along the arm, palms down.
        for s in 0..2 {
            let hand = rig.b.arm[s][2];
            let fore = rig.b.arm[s][1];
            let dir = (rig.rest_g[hand].p - rig.rest_g[fore].p).normalize();
            rig.hand_axes[s] = (dir, Vec3::NEG_Y);
        }
        Ok(rig)
    }

    fn fk(&self, l: &[(Vec3, Quat)]) -> Vec<G> {
        let mut g = vec![
            G {
                p: Vec3::ZERO,
                r: Quat::IDENTITY,
                s: 1.0
            };
            l.len()
        ];
        for &i in &self.order {
            let (t, r) = l[i];
            let s = self.rest[i].2;
            g[i] = match self.parents[i] {
                Some(p) => {
                    let pg = g[p];
                    G {
                        p: pg.p + pg.r * (t * pg.s),
                        r: (pg.r * r).normalize(),
                        s: pg.s * s,
                    }
                }
                None => G { p: t, r, s },
            };
        }
        g
    }

    /// The clips blended by weight at a shared phase (0..1).
    fn sample(&self, weights: [f32; 3], phase: f32, idle_t: f32) -> Vec<(Vec3, Quat)> {
        let mut out: Vec<(Vec3, Quat)> = self.rest.iter().map(|r| (r.0, r.1)).collect();
        let clips = [
            (&self.clips["Idle"], weights[0], idle_t),
            (&self.clips["Walk"], weights[1], phase),
            (&self.clips["Run"], weights[2], phase),
        ];
        for &i in &self.posed {
            let mut t = Vec3::ZERO;
            let mut q = [0.0f32; 4];
            let mut first: Option<Quat> = None;
            let (mut wt, mut wq) = (0.0, 0.0);
            for (k, (clip, w, ph)) in clips.iter().enumerate() {
                if *w <= 0.001 {
                    continue;
                }
                let time = if k == 0 {
                    ph % clip.duration
                } else {
                    ph * clip.duration
                };
                let (tt, rt) = &clip.tracks[i];
                if let Some(tt) = tt {
                    let v = tt.sample(time);
                    t += Vec3::new(v[0], v[1], v[2]) * *w;
                    wt += w;
                }
                if let Some(rt) = rt {
                    let mut v = Quat::from_array(rt.sample(time));
                    match first {
                        Some(f) if f.dot(v) < 0.0 => v = -v,
                        None => first = Some(v),
                        _ => {}
                    }
                    for c in 0..4 {
                        q[c] += v.to_array()[c] * *w;
                    }
                    wq += w;
                }
            }
            if wt > 0.0 {
                out[i].0 = t / wt;
            }
            if wq > 0.0 {
                out[i].1 = Quat::from_array(q).normalize();
            }
        }
        out
    }
}

/// A pose being worked on: locals, and the globals they give.
struct Pose<'a> {
    rig: &'a Rig,
    l: Vec<(Vec3, Quat)>,
    g: Vec<G>,
}

impl<'a> Pose<'a> {
    fn new(rig: &'a Rig, l: Vec<(Vec3, Quat)>) -> Pose<'a> {
        let g = rig.fk(&l);
        Pose { rig, l, g }
    }
    fn fk(&mut self) {
        self.g = self.rig.fk(&self.l);
    }
    fn p(&self, i: usize) -> Vec3 {
        self.g[i].p
    }
    fn r(&self, i: usize) -> Quat {
        self.g[i].r
    }
    /// Sets a node's rotation in model space.
    fn set_r(&mut self, i: usize, r: Quat) {
        let pr = self.rig.parents[i].map_or(Quat::IDENTITY, |p| self.g[p].r);
        self.l[i].1 = (pr.inverse() * r).normalize();
        self.fk();
    }
    /// Turns a node (and what hangs from it) by `q` in model space, about its own origin.
    fn turn(&mut self, i: usize, q: Quat) {
        self.set_r(i, q * self.g[i].r);
    }
    /// Moves a node's origin in model space (its parent stays).
    fn set_p(&mut self, i: usize, p: Vec3) {
        let pg = self.rig.parents[i].map_or(
            G {
                p: Vec3::ZERO,
                r: Quat::IDENTITY,
                s: 1.0,
            },
            |p| self.g[p],
        );
        self.l[i].0 = pg.r.inverse() * (p - pg.p) / pg.s;
        self.fk();
    }
    /// Two-bone IK: the chain a-b-c reaches `target` with the middle joint toward `pole`.
    fn reach(&mut self, [a, b, c]: [usize; 3], target: Vec3, pole: Vec3) {
        let (pa, pb, pc) = (self.p(a), self.p(b), self.p(c));
        let (l1, l2) = ((pb - pa).length(), (pc - pb).length());
        let d = target - pa;
        let dist = d.length().clamp((l1 - l2).abs() + 1e-3, (l1 + l2) * 0.999);
        let dir = d.normalize_or(Vec3::NEG_Y);
        let x = (l1 * l1 - l2 * l2 + dist * dist) / (2.0 * dist);
        let h = (l1 * l1 - x * x).max(0.0).sqrt();
        let side = (pole - dir * pole.dot(dir)).normalize_or(dir.any_orthonormal_vector());
        let mid = pa + dir * x + side * h;
        let end = pa + dir * dist;
        self.turn(
            a,
            Quat::from_rotation_arc((pb - pa).normalize(), (mid - pa).normalize()),
        );
        let (pb, pc) = (self.p(b), self.p(c));
        self.turn(
            b,
            Quat::from_rotation_arc((pc - pb).normalize(), (end - pb).normalize()),
        );
    }
}

/// The rotation taking the frame (x0, y0) to the frame (x1, y1) (each pair made orthonormal).
fn frame_to_frame(x0: Vec3, y0: Vec3, x1: Vec3, y1: Vec3) -> Quat {
    let basis = |x: Vec3, y: Vec3| {
        let x = x.normalize_or(Vec3::X);
        let z = x.cross(y).normalize_or(Vec3::Z);
        Mat3::from_cols(x, z.cross(x), z)
    };
    Quat::from_mat3(&(basis(x1, y1) * basis(x0, y0).transpose())).normalize()
}

// ------------------------------------------------------------------------------------------- the ragdoll

const HIPS: usize = 0;
const CHEST: usize = 1;
const HEAD: usize = 2;
/// Particles 3..: per side (left, right): shoulder, elbow, wrist, hip, knee, ankle.
const fn limb(side: usize, k: usize) -> usize {
    3 + side * 6 + k
}
const PARTICLES: usize = 15;

struct Ragdoll {
    /// World positions (units), now and a tick ago.
    p: [Vec3; PARTICLES],
    q: [Vec3; PARTICLES],
    sticks: Vec<(usize, usize, f32, bool)>,
    age: f32,
    still: f32,
    asleep: bool,
    acc: f32,
}

impl Ragdoll {
    fn new(points: [Vec3; PARTICLES], vel: [Vec3; PARTICLES]) -> Ragdoll {
        let dt = 1.0 / 60.0;
        let mut q = points;
        for i in 0..PARTICLES {
            q[i] = points[i] - vel[i] * dt;
        }
        let mut sticks = vec![];
        let mut stick = |a: usize, b: usize, min_only: bool| {
            sticks.push((a, b, (points[a] - points[b]).length(), min_only))
        };
        // The torso: a stiff frame of hips, chest, head, shoulders and hip joints.
        let (ls, rs, lh, rh) = (limb(0, 0), limb(1, 0), limb(0, 3), limb(1, 3));
        for (a, b) in [
            (HIPS, CHEST),
            (CHEST, HEAD),
            (CHEST, ls),
            (CHEST, rs),
            (ls, rs),
            (HIPS, lh),
            (HIPS, rh),
            (lh, rh),
            (ls, HIPS),
            (rs, HIPS),
            (CHEST, lh),
            (CHEST, rh),
            (HEAD, ls),
            (HEAD, rs),
            (ls, rh),
            (rs, lh),
            (ls, lh),
            (rs, rh),
        ] {
            stick(a, b, false);
        }
        for s in 0..2 {
            stick(limb(s, 0), limb(s, 1), false);
            stick(limb(s, 1), limb(s, 2), false);
            stick(limb(s, 3), limb(s, 4), false);
            stick(limb(s, 4), limb(s, 5), false);
        }
        let mut r = Ragdoll {
            p: points,
            q,
            sticks,
            age: 0.0,
            still: 0.0,
            asleep: false,
            acc: 0.0,
        };
        // Joints that must not fold flat: the head off the hips, knees and elbows apart, feet off the hips.
        let mins: [(usize, usize, f32); 7] = [
            (HEAD, HIPS, 0.72),
            (limb(0, 4), limb(1, 4), 0.5),
            (limb(0, 5), limb(1, 5), 0.45),
            (limb(0, 5), HIPS, 0.45),
            (limb(1, 5), HIPS, 0.45),
            (limb(0, 2), CHEST, 0.3),
            (limb(1, 2), CHEST, 0.3),
        ];
        for (a, b, k) in mins {
            let d = (r.p[a] - r.p[b]).length() * k;
            r.sticks.push((a, b, d, true));
        }
        r
    }

    fn step(&mut self, map: &Map, dt: f32) {
        if self.asleep {
            return;
        }
        self.age += dt;
        self.acc += dt;
        let h = 1.0 / 60.0;
        let mut moved = 0.0f32;
        while self.acc >= h {
            self.acc -= h;
            for i in 0..PARTICLES {
                let v = (self.p[i] - self.q[i]) * 0.992;
                self.q[i] = self.p[i];
                self.p[i] += v + Vec3::NEG_Y * 800.0 * h * h;
            }
            for _ in 0..6 {
                for &(a, b, len, min_only) in &self.sticks {
                    let d = self.p[b] - self.p[a];
                    let l = d.length().max(1e-4);
                    if min_only && l >= len {
                        continue;
                    }
                    let fix = d * ((l - len) / l * 0.5);
                    self.p[a] += fix;
                    self.p[b] -= fix;
                }
            }
            // The map: nothing passes a surface, and a body part rests a little above the floor it lies on.
            for i in 0..PARTICLES {
                let r = if i == HEAD {
                    4.5
                } else if i == HIPS || i == CHEST {
                    5.0
                } else {
                    2.6
                };
                let tr = map.ray(self.q[i], self.p[i]);
                if tr.fraction < 1.0 && !tr.start_solid {
                    let v = self.p[i] - self.q[i];
                    self.p[i] = tr.end + tr.normal * 0.2;
                    // What is left of the motion slides along the surface, rubbed.
                    let along = v - tr.normal * v.dot(tr.normal);
                    self.q[i] = self.p[i] - along * 0.45;
                }
                let down = map.ray(self.p[i] + Vec3::Y * 6.0, self.p[i] - Vec3::Y * r);
                if down.fraction < 1.0 && !down.start_solid && down.normal.y > 0.5 {
                    let floor = down.end.y + r;
                    if self.p[i].y < floor {
                        self.p[i].y = floor;
                        let v = self.p[i] - self.q[i];
                        self.q[i] = self.p[i] - Vec3::new(v.x * 0.55, 0.0, v.z * 0.55);
                    }
                }
                moved = moved.max((self.p[i] - self.q[i]).length());
            }
        }
        // Settled: stop simulating (the pose stays).
        if moved < 0.12 {
            self.still += dt;
        } else {
            self.still = 0.0;
        }
        if self.still > 0.6 && self.age > 1.0 || self.age > 7.0 {
            self.asleep = true;
        }
    }
}

// ------------------------------------------------------------------------------------------- the puppet

pub struct Puppet {
    yaw: f32,
    phase: f32,
    idle_t: f32,
    /// The legs' turn toward the direction of travel, and whether they run backwards.
    leg_turn: f32,
    aim_k: f32,
    sprint_k: f32,
    speed: f32,
    flinch: Spring3,
    kick: f32,
    ragdoll: Option<Ragdoll>,
    /// The feet at death (the model's origin while the ragdoll plays), units.
    root: Vec3,
    pose: Vec<f32>,
    /// The carried weapon in the world (units).
    weapon: (Vec3, Quat),
    drop: Option<(Vec3, Vec3, f32)>,
    chest: Vec3,
    seed: Rng,
}

impl Puppet {
    pub fn new(_rig: Option<&Rig>) -> Puppet {
        Puppet {
            yaw: 0.0,
            phase: 0.0,
            idle_t: 0.0,
            leg_turn: 0.0,
            aim_k: 0.0,
            sprint_k: 0.0,
            speed: 0.0,
            flinch: Spring3::default(),
            kick: 0.0,
            ragdoll: None,
            root: Vec3::ZERO,
            pose: vec![],
            weapon: (Vec3::ZERO, Quat::IDENTITY),
            drop: None,
            chest: Vec3::ZERO,
            seed: Rng::new(3),
        }
    }

    pub fn revive(&mut self) {
        self.ragdoll = None;
        self.drop = None;
        self.flinch = Spring3::default();
        self.aim_k = 0.0;
    }

    pub fn dead(&self) -> bool {
        self.ragdoll.is_some()
    }

    pub fn yaw(&self) -> f32 {
        self.yaw
    }

    pub fn pose(&self) -> &[f32] {
        &self.pose
    }

    pub fn weapon(&self) -> (Vec3, Quat) {
        self.weapon
    }

    /// The body's middle in the world (units), once it is a ragdoll.
    pub fn chest(&self) -> Option<Vec3> {
        self.ragdoll.as_ref().map(|r| r.p[CHEST])
    }

    /// Where the feet stand (units): the model's origin.
    pub fn root(&self, a: &Actor, alpha: f32) -> Vec3 {
        if self.ragdoll.is_some() {
            self.root
        } else {
            a.prev.lerp(a.body.pos, alpha) - Vec3::Y * a.half()
        }
    }

    /// The carried weapon's muzzle in the world (units).
    pub fn muzzle(&self, a: &Actor, meta: &WeaponMeta) -> Vec3 {
        if self.pose.is_empty() {
            let (y, p) = a.aim();
            return a.eye() + crate::util::view_dir(y, p) * 30.0 - Vec3::Y * 6.0;
        }
        self.weapon.0 + self.weapon.1 * (meta.get(a.arms.def().id).muzzle / UNIT)
    }

    pub fn flinch(&mut self, dir: Vec3, amount: f32) {
        // In the body's frame: pushed back along the shot, twisted by where it came from.
        let local = Quat::from_rotation_y(-self.yaw) * dir;
        let k = (amount / 35.0).clamp(0.3, 1.6);
        self.flinch.v += Vec3::new(-local.z * 3.2, local.x * 2.6, self.seed.s() * 1.4) * k;
    }

    fn pack(&mut self, rig: &Rig, l: &[(Vec3, Quat)]) {
        self.pose.clear();
        for &i in &rig.posed {
            let (t, r) = l[i];
            self.pose
                .extend_from_slice(&[i as f32, t.x, t.y, t.z, r.x, r.y, r.z, r.w]);
        }
    }

    /// The living pose: legs, spine, arms on the weapon. Returns the pose and the weapon's place in model space.
    fn stand(
        &mut self,
        rig: &Rig,
        a: &Actor,
        dt: f32,
        aiming: bool,
        meta: &WeaponMeta,
    ) -> (Vec<(Vec3, Quat)>, Vec3, Quat) {
        let b = rig.b;
        let v = flat(a.body.vel);
        let speed = v.length();
        self.speed += (speed - self.speed) * damp(10.0, dt);
        let sp = self.speed;
        // Clip weights by speed; the stride's phase by distance covered.
        // (A patrol's 3.6 m/s is already a jog: the run clip, slower, rather than the walk's stride at double time.)
        let run = smooth((sp - 70.0) / 60.0);
        let walk = (1.0 - run) * smooth((sp - 6.0) / 34.0);
        let idle = (1.0 - run - walk).max(0.0);
        let moving = walk + run;
        // Backwards past a right angle: the legs turn the other way round and the stride runs in reverse.
        let fwd = yaw_dir(a.yaw);
        let right = yaw_right(a.yaw);
        let mut travel = if sp > 12.0 {
            v.dot(right).atan2(v.dot(fwd))
        } else {
            0.0
        };
        let back = travel.abs() > 1.9;
        if back {
            travel = angle_diff(travel, std::f32::consts::PI);
        }
        let want = -travel.clamp(-1.25, 1.25) * moving.min(1.0);
        self.leg_turn += (want - self.leg_turn) * damp(9.0, dt);
        let cycles = if run > 0.5 {
            sp / 165.0 / 0.7
        } else {
            sp / 62.0 / 1.03
        };
        let rate = cycles.clamp(0.0, 2.1) * if back { -1.0 } else { 1.0 };
        self.phase = (self.phase + rate * dt).rem_euclid(1.0);
        self.idle_t += dt;
        let mut pose = Pose::new(rig, rig.sample([idle, walk, run], self.phase, self.idle_t));

        // Legs along the travel, the chest back on the aim.
        if self.leg_turn.abs() > 0.002 {
            let chest = pose.r(b.spine[0]);
            pose.turn(b.hips, Quat::from_rotation_y(self.leg_turn));
            pose.set_r(b.spine[0], chest);
        }
        // A crouch (and a slide: lower, leaning back): the hips come down over the feet where they were.
        let sliding = a.slide > 0.0;
        let ck = smooth(a.crouch_k);
        let airborne = !a.body.on_ground && a.mantle.is_none();
        if ck > 0.01 || airborne {
            let feet = [pose.p(b.leg[0][2]), pose.p(b.leg[1][2])];
            let foot_r = [pose.r(b.leg[0][2]), pose.r(b.leg[1][2])];
            let mut hips = pose.p(b.hips);
            hips.y -= ck * if sliding { 0.6 } else { 0.4 };
            hips.z += ck * if sliding { 0.16 } else { -0.04 };
            // In the air the knees come up a little.
            let tuck = if airborne { 0.12 } else { 0.0 };
            pose.set_p(b.hips, hips);
            let legs = Quat::from_rotation_y(self.leg_turn);
            for s in 0..2 {
                let out = if s == 0 { -1.0 } else { 1.0 };
                let mut f = feet[s];
                f.y = f.y.max(0.09) + tuck;
                if sliding {
                    // Feet first.
                    f = Vec3::new(f.x * 0.6, 0.12 + 0.1 * s as f32, -0.55 - 0.25 * s as f32);
                } else {
                    // A crouch spreads the stance: one foot forward.
                    f.z += ck * if s == 0 { -0.16 } else { 0.14 };
                }
                pose.reach(b.leg[s], f, legs * Vec3::new(out * 0.35, 0.2, -1.0));
                pose.set_r(b.leg[s][2], foot_r[s]);
            }
        }

        // The aim: the spine carries most of the pitch, the head the rest.
        let (_, pitch) = a.aim();
        self.sprint_k += ((a.sprinting as i32 as f32) - self.sprint_k) * damp(9.0, dt);
        let busy = a.arms.reload.is_some() || a.arms.swap.is_some() || a.arms.draw > 0.0;
        let raise = aiming || a.arms.since_shot < 1.2 || a.arms.ads > 0.1;
        self.aim_k +=
            ((raise as i32 as f32) - self.aim_k) * damp(if raise { 14.0 } else { 5.0 }, dt);
        let aim = smooth(self.aim_k) * (1.0 - smooth(self.sprint_k));
        let lean = ck * if sliding { -0.5 } else { 0.32 }
            + self.sprint_k * 0.14
            + if a.mantle.is_some() { 0.3 } else { 0.0 };
        self.flinch.step(120.0, 13.0, dt);
        let fl = self.flinch.x;
        let bend = Quat::from_rotation_x((pitch * 0.72 - lean) / 3.0);
        for (k, s) in b.spine.iter().enumerate() {
            let jolt = if k == 1 {
                Quat::from_rotation_x(fl.x * 0.1)
                    * Quat::from_rotation_y(fl.y * 0.1)
                    * Quat::from_rotation_z(fl.z * 0.08)
            } else {
                Quat::IDENTITY
            };
            pose.turn(*s, bend * jolt);
        }
        let d = a.arms.def();
        let m = meta.get(d.id);
        let pistol = d.class == Class::Pistol;
        // The head: level with the aim, tipped onto the stock when the sights are up.
        let look = Quat::from_rotation_x(pitch * 0.9)
            * Quat::from_rotation_z(if pistol { 0.0 } else { -0.16 * aim });
        pose.set_r(b.head, look * rig.rest_g[b.head].r);

        // The weapon in model space: aimed from the shoulder, at the low ready, or across the chest in a sprint.
        let shoulder = pose.p(b.arm[1][0]);
        let chest = pose.p(b.spine[2]);
        let aim_r = Quat::from_rotation_x(pitch);
        let (aim_p, aim_q) = if pistol {
            (chest + aim_r * Vec3::new(0.03, 0.17, -0.5), aim_r)
        } else {
            (
                shoulder + aim_r * Vec3::new(-0.085, 0.035, -0.24),
                aim_r * Quat::from_rotation_z(-0.06),
            )
        };
        let low_r = Quat::from_rotation_y(0.42) * Quat::from_rotation_x(-0.62 + pitch * 0.3);
        let (low_p, low_q) = if pistol {
            (
                chest + Vec3::new(0.1, -0.12, -0.3),
                Quat::from_rotation_x(-0.75),
            )
        } else {
            (shoulder + Vec3::new(-0.1, -0.2, -0.2), low_r)
        };
        let run_r = Quat::from_rotation_y(1.05) * Quat::from_rotation_x(0.5);
        let (run_p, run_q) = if pistol {
            (
                chest + Vec3::new(0.18, -0.08, -0.22),
                Quat::from_rotation_x(0.9),
            )
        } else {
            (shoulder + Vec3::new(-0.06, -0.24, -0.2), run_r)
        };
        let s = smooth(self.sprint_k);
        let mut wp = low_p.lerp(aim_p, aim).lerp(run_p, s);
        let mut wq = low_q.slerp(aim_q, aim).slerp(run_q, s);
        // Each shot shoves it back into the shoulder.
        let sh = a.arms.since_shot;
        self.kick = if sh < 0.1 {
            (1.0 - sh / 0.1) * d.vm_back
        } else {
            0.0
        };
        wp += wq * Vec3::new(0.0, 0.0, self.kick * 1.2);
        wq *= Quat::from_rotation_x(self.kick * 2.4);
        // A reload: the gun drops and cants, the left hand goes down for a magazine and back.
        let mut left = m.grip_l;
        if let Some(r) = a.arms.reload {
            let k = (r.t / r.dur).clamp(0.0, 1.0);
            let e = smooth(k / 0.15) * smooth((1.0 - k) / 0.15);
            wq *= Quat::from_rotation_x(-0.3 * e) * Quat::from_rotation_z(-0.5 * e);
            wp += Vec3::new(-0.03, -0.06, 0.03) * e;
            let fetch = (k
                * std::f32::consts::TAU
                * if d.shell.is_some() {
                    r.shells.max(1) as f32
                } else {
                    1.0
                })
            .sin()
            .max(0.0);
            left = Vec3::new(0.0, -0.06, -0.06).lerp(Vec3::new(-0.08, -0.34, 0.06), fetch) * e
                + m.grip_l * (1.0 - e);
        } else if busy {
            wq *= Quat::from_rotation_x(-0.5);
            wp.y -= 0.12;
        }
        if let Some(t) = a.arms.throw {
            let e = smooth(t / 0.15) * smooth((crate::arms::THROW_TIME - t) / 0.3);
            left = left.lerp(
                Vec3::new(
                    -0.3,
                    0.35 - 0.5 * smooth(t / 0.32),
                    0.2 - 0.7 * smooth(t / 0.32),
                ),
                e,
            );
        }

        // Hands onto it: the right on the grip, the left under the handguard.
        let wrist_r = wp + wq * Vec3::new(0.022, -0.075, 0.06);
        let hand_dir_l = Vec3::new(0.72, 0.5, -0.48).normalize();
        let wrist_l = wp
            + wq * (left
                + if pistol {
                    Vec3::new(-0.05, -0.05, 0.05)
                } else {
                    -hand_dir_l * 0.085 + Vec3::new(0.0, -0.025, 0.0)
                });
        pose.reach(b.arm[1], wrist_r, Vec3::new(0.75, -1.0, 0.35));
        pose.reach(b.arm[0], wrist_l, Vec3::new(-0.7, -1.0, 0.2));
        // Right: fingers forward and up along the grip, the palm facing in. Left: fingers across under the handguard,
        // the palm up.
        let (f0, n0) = rig.hand_axes[1];
        pose.set_r(
            b.arm[1][2],
            wq * frame_to_frame(f0, n0, Vec3::new(-0.2, 0.42, -0.88), Vec3::NEG_X)
                * rig.rest_g[b.arm[1][2]].r,
        );
        let (f0, n0) = rig.hand_axes[0];
        let (lf, ln) = if pistol {
            (Vec3::new(0.35, 0.4, -0.85), Vec3::X)
        } else {
            (hand_dir_l, Vec3::Y)
        };
        pose.set_r(
            b.arm[0][2],
            wq * frame_to_frame(f0, n0, lf, ln) * rig.rest_g[b.arm[0][2]].r,
        );
        for (i, q) in &rig.fingers {
            pose.l[*i].1 = *q;
        }
        (pose.l, wp, wq)
    }

    pub fn update(
        &mut self,
        rig: Option<&Rig>,
        a: &Actor,
        map: &Map,
        dt: f32,
        alpha: f32,
        aiming: bool,
        meta: &WeaponMeta,
    ) {
        let Some(rig) = rig else {
            if a.alive {
                self.yaw = a.yaw;
            }
            return;
        };
        if let Some(rd) = &mut self.ragdoll {
            let was = rd.asleep;
            rd.step(map, dt);
            self.chest = rd.p[CHEST];
            // The dropped weapon falls beside the body.
            if let Some((p, v, t)) = &mut self.drop {
                *t += dt;
                v.y -= 800.0 * dt;
                let to = *p + *v * dt;
                let tr = map.ray(*p, to - Vec3::Y * 2.0);
                if tr.fraction < 1.0 && !tr.start_solid {
                    *p = tr.end + tr.normal * 2.2;
                    *v = Vec3::ZERO;
                    let (y, _, _) = self.weapon.1.to_euler(glam::EulerRot::YXZ);
                    let flat = Quat::from_rotation_y(y) * Quat::from_rotation_z(1.5);
                    self.weapon.1 = self.weapon.1.slerp(flat, damp(14.0, dt));
                } else {
                    *p = to;
                    self.weapon.1 = (Quat::from_rotation_x(3.0 * dt) * self.weapon.1).normalize();
                }
                self.weapon.0 = *p;
            }
            if !was {
                let l = self.follow(rig);
                self.pack(rig, &l);
            }
            return;
        }
        if !a.alive {
            return;
        }
        self.yaw = a.yaw;
        let (l, wp, wq) = self.stand(rig, a, dt, aiming, meta);
        let root = self.root(a, alpha);
        let turn = Quat::from_rotation_y(self.yaw);
        self.weapon = (root + turn * (wp / UNIT), (turn * wq).normalize());
        self.pack(rig, &l);
    }

    /// Death: the body's joints become a ragdoll, pushed by what killed it.
    pub fn die(&mut self, rig: Option<&Rig>, a: &Actor, impulse: Vec3, at: Vec3, vel: Vec3) {
        let Some(rig) = rig else {
            return;
        };
        self.yaw = a.yaw;
        let meta = WeaponMeta::default();
        let (l, wp, wq) = self.stand(rig, a, 0.0, true, &meta);
        let g = rig.fk(&l);
        let root = a.body.pos - Vec3::Y * a.half();
        let turn = Quat::from_rotation_y(self.yaw);
        let world = |i: usize| root + turn * (g[i].p / UNIT);
        let b = rig.b;
        let mut pts = [Vec3::ZERO; PARTICLES];
        pts[HIPS] = world(b.hips);
        pts[CHEST] = world(b.spine[2]);
        pts[HEAD] = world(b.head_top).lerp(world(b.head), 0.45);
        for s in 0..2 {
            for k in 0..3 {
                pts[limb(s, k)] = world(b.arm[s][k]);
                pts[limb(s, 3 + k)] = world(b.leg[s][k]);
            }
        }
        // The push lands hardest near where the body was hit; the legs give way.
        let mut v = [vel; PARTICLES];
        for i in 0..PARTICLES {
            let near = (1.0 - (pts[i] - at).length() / 40.0).clamp(0.25, 1.0);
            let r = Vec3::new(self.seed.s(), self.seed.s(), self.seed.s()) * 22.0;
            v[i] += impulse * near + r;
        }
        for s in 0..2 {
            v[limb(s, 4)] += turn * Vec3::new(0.0, 0.0, -70.0);
        }
        self.root = root;
        self.ragdoll = Some(Ragdoll::new(pts, v));
        self.weapon = (root + turn * (wp / UNIT), (turn * wq).normalize());
        self.drop = Some((self.weapon.0, vel + impulse * 0.3 + Vec3::Y * 60.0, 0.0));
        self.chest = pts[CHEST];
        let l = self.follow(rig);
        self.pack(rig, &l);
    }

    /// The skeleton laid along the ragdoll's particles.
    fn follow(&self, rig: &Rig) -> Vec<(Vec3, Quat)> {
        let rd = self.ragdoll.as_ref().unwrap();
        let b = rig.b;
        let inv = Quat::from_rotation_y(-self.yaw);
        // Particles in model space (metres).
        let p: Vec<Vec3> =
            rd.p.iter()
                .map(|w| inv * ((*w - self.root) * UNIT))
                .collect();
        let rest = &rig.rest_g;
        let mut pose = Pose::new(rig, rig.rest.iter().map(|r| (r.0, r.1)).collect());
        for (i, q) in &rig.fingers {
            pose.l[*i].1 = Quat::slerp(rig.rest[*i].1, *q, 0.45);
        }
        // The pelvis: across the hip joints, up toward the chest.
        let (lh, rh, ls, rs) = (limb(0, 3), limb(1, 3), limb(0, 0), limb(1, 0));
        let hips_q = frame_to_frame(
            rest[b.leg[1][0]].p - rest[b.leg[0][0]].p,
            rest[b.spine[2]].p - rest[b.hips].p,
            p[rh] - p[lh],
            p[CHEST] - p[HIPS],
        );
        let chest_q = frame_to_frame(
            rest[b.arm[1][0]].p - rest[b.arm[0][0]].p,
            rest[b.spine[2]].p - rest[b.hips].p,
            p[rs] - p[ls],
            p[CHEST] - p[HIPS],
        );
        pose.set_p(b.hips, p[HIPS]);
        pose.set_r(b.hips, hips_q * rest[b.hips].r);
        pose.set_r(b.spine[0], hips_q.slerp(chest_q, 0.34) * rest[b.spine[0]].r);
        pose.set_r(b.spine[1], hips_q.slerp(chest_q, 0.67) * rest[b.spine[1]].r);
        pose.set_r(b.spine[2], chest_q * rest[b.spine[2]].r);
        // The head along chest -> head.
        let neck_dir = chest_q * (rest[b.head_top].p - rest[b.neck].p).normalize();
        let head_q = Quat::from_rotation_arc(neck_dir, (p[HEAD] - p[CHEST]).normalize_or(neck_dir))
            * chest_q;
        pose.set_r(b.neck, chest_q.slerp(head_q, 0.5) * rest[b.neck].r);
        pose.set_r(b.head, head_q * rest[b.head].r);
        // Limbs: each bone swung from where its parent leaves it to where the particles run.
        for s in 0..2 {
            for (bones, base, parent_q) in [
                (b.arm[s], limb(s, 0), chest_q),
                (b.leg[s], limb(s, 3), hips_q),
            ] {
                let d0 = (rest[bones[1]].p - rest[bones[0]].p).normalize();
                let upper = Quat::from_rotation_arc(
                    parent_q * d0,
                    (p[base + 1] - p[base]).normalize_or(parent_q * d0),
                ) * parent_q;
                pose.set_r(bones[0], upper * rest[bones[0]].r);
                let d1 = (rest[bones[2]].p - rest[bones[1]].p).normalize();
                let lower = Quat::from_rotation_arc(
                    upper * d1,
                    (p[base + 2] - p[base + 1]).normalize_or(upper * d1),
                ) * upper;
                pose.set_r(bones[1], lower * rest[bones[1]].r);
                pose.set_r(bones[2], lower * rest[bones[2]].r);
            }
        }
        pose.l
    }
}
