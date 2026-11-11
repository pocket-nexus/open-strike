//! What the player sees of itself: the eye (bob, landing, recoil, shake, the sights' zoom, a death camera) and the
//! first-person weapon (hip and sight poses, sway behind the look, the kick, sprint and crouch poses, reloads, the
//! swap, a wall in the way), all procedural. And the effects of a firefight (`Fx`): tracers, muzzle flashes, impact
//! sparks and bullet holes, casings, blasts.
use crate::actor::{Actor, JOG, Moved};
use crate::arms::{Cue, MELEE_STRIKE, MELEE_TIME, THROW_TIME};
use crate::game::Event;
use crate::rig::Puppet;
use crate::util::{Rng, Spring, Spring3, damp, flat, smooth, view_quat, yaw_dir, yaw_right};
use crate::weapons::{Class, WeaponDef};
use crate::world::{Map, UNIT};
use glam::{Quat, Vec2, Vec3};
use std::collections::HashMap;

/// Vertical field of view from the hip, degrees.
pub const FOV: f32 = 58.0;
/// The first-person weapon is drawn narrower across the view than it is long (its X and Y scaled by this): what a
/// separate, narrower field of view for the weapon does in other games. The world's wide view would otherwise
/// stretch the gun and the arms across the bottom of the screen.
pub const SLIM: f32 = 0.74;

/// A weapon model's points, in its own space (metres; -Z along the barrel, the origin at the top of the grip).
#[derive(Clone, Copy, Debug)]
pub struct Meta {
    pub muzzle: Vec3,
    pub eject: Vec3,
    pub eject_dir: Vec3,
    /// Where the eye sits through the sights (the sight line runs along -Z from it).
    pub eye: Vec3,
    /// The support hand's place.
    pub grip_l: Vec3,
    /// The magazine's travel when pulled.
    pub mag_out: Vec3,
    /// The bolt's (slide's) travel, metres.
    pub bolt: f32,
}

/// weapons/meta.json.
#[derive(Clone, Debug, Default)]
pub struct WeaponMeta(HashMap<String, Meta>);

impl WeaponMeta {
    pub fn parse(text: &str) -> WeaponMeta {
        let mut out = HashMap::new();
        if let Ok(serde_json::Value::Object(m)) = serde_json::from_str::<serde_json::Value>(text) {
            for (id, v) in m {
                let d = Self::fallback(&id);
                let v3 = |k: &str, d: Vec3| {
                    v[k].as_array()
                        .filter(|a| a.len() == 3)
                        .map(|a| {
                            Vec3::new(
                                a[0].as_f64().unwrap_or(0.0) as f32,
                                a[1].as_f64().unwrap_or(0.0) as f32,
                                a[2].as_f64().unwrap_or(0.0) as f32,
                            )
                        })
                        .unwrap_or(d)
                };
                out.insert(
                    id.clone(),
                    Meta {
                        muzzle: v3("muzzle", d.muzzle),
                        eject: v3("eject", d.eject),
                        eject_dir: v3("ejectDir", d.eject_dir).normalize_or(Vec3::X),
                        eye: v3("eye", d.eye),
                        grip_l: v3("gripL", d.grip_l),
                        mag_out: v3("magOut", d.mag_out),
                        bolt: v["boltTravel"].as_f64().map_or(d.bolt, |b| b as f32),
                    },
                );
            }
        }
        WeaponMeta(out)
    }

    fn fallback(id: &str) -> Meta {
        let long = Meta {
            muzzle: Vec3::new(0.0, 0.045, -0.5),
            eject: Vec3::new(0.022, 0.045, -0.1),
            eject_dir: Vec3::new(0.85, 0.45, 0.25),
            eye: Vec3::new(0.0, 0.1, 0.12),
            grip_l: Vec3::new(0.0, 0.0, -0.3),
            mag_out: Vec3::new(0.0, -0.14, -0.02),
            bolt: 0.03,
        };
        match id {
            "pistol" => Meta {
                muzzle: Vec3::new(0.0, 0.03, -0.14),
                eject: Vec3::new(0.012, 0.035, -0.05),
                eye: Vec3::new(0.0, 0.05, 0.3),
                grip_l: Vec3::new(-0.02, -0.04, 0.0),
                mag_out: Vec3::new(0.0, -0.12, 0.02),
                bolt: 0.035,
                ..long
            },
            "smg" => Meta {
                muzzle: Vec3::new(0.0, 0.04, -0.34),
                grip_l: Vec3::new(0.0, -0.01, -0.2),
                ..long
            },
            "shotgun" => Meta {
                muzzle: Vec3::new(0.0, 0.045, -0.62),
                eye: Vec3::new(0.0, 0.075, 0.14),
                grip_l: Vec3::new(0.0, 0.01, -0.34),
                ..long
            },
            "dmr" => Meta {
                muzzle: Vec3::new(0.0, 0.045, -0.68),
                eye: Vec3::new(0.0, 0.105, 0.1),
                grip_l: Vec3::new(0.0, 0.0, -0.34),
                ..long
            },
            _ => long,
        }
    }

    pub fn get(&self, id: &str) -> Meta {
        self.0
            .get(id)
            .copied()
            .unwrap_or_else(|| Self::fallback(id))
    }
}

#[derive(Clone, Copy, Debug)]
pub struct Camera {
    /// GoldSrc units.
    pub eye: Vec3,
    pub rot: Quat,
    pub fov: f32,
}

/// The first-person weapon this frame (metres, world space; part offsets in the weapon's space).
#[derive(Clone, Debug)]
pub struct ViewModel {
    pub weapon: &'static str,
    pub pos: [f32; 3],
    pub rot: [f32; 4],
    /// The magazine's offset (the shotgun's loose shell: far away when not loading).
    pub mag: [f32; 3],
    /// The bolt's travel back (+Z).
    pub bolt: f32,
    /// The support arm's offset.
    pub arm_l: [f32; 3],
    /// The model's scale (see `SLIM`); the part offsets above are already scaled.
    pub scale: [f32; 3],
}

struct DeathCam {
    t: f32,
    eye: Vec3,
    rot: Quat,
    /// Seconds following a teammate (elimination: no respawn), and where the camera was when that began.
    watch: f32,
    from: Option<(Vec3, Quat)>,
}

pub struct View {
    pub meta: WeaponMeta,
    cam: Camera,
    vm: Option<ViewModel>,
    /// The muzzle and the ejection port in the world (units), and the casing's velocity.
    pub muzzle: Vec3,
    pub eject: Vec3,
    pub eject_vel: Vec3,
    look: Vec2,
    sway: Spring3,
    /// x: back (metres), y: rise (radians), z: roll (radians).
    kick: Spring3,
    land: Spring,
    jolt: Spring3,
    trauma: f32,
    punch: Spring,
    sprint_k: f32,
    wall_k: f32,
    air_k: f32,
    strafe: f32,
    bob_amp: f32,
    eye_y: Option<f32>,
    time: f32,
    locked: bool,
    death: Option<DeathCam>,
    alive: bool,
}

fn deg(d: f32) -> f32 {
    d.to_radians()
}

/// A vector from the environment ("x,y,z"), for tuning poses without a rebuild.
fn tune(key: &str) -> Option<Vec3> {
    let v: Vec<f32> = std::env::var(key)
        .ok()?
        .split(',')
        .filter_map(|x| x.trim().parse().ok())
        .collect();
    (v.len() == 3).then(|| Vec3::new(v[0], v[1], v[2]))
}

impl View {
    pub fn new(meta: WeaponMeta) -> View {
        View {
            meta,
            cam: Camera {
                eye: Vec3::ZERO,
                rot: Quat::IDENTITY,
                fov: FOV,
            },
            vm: None,
            muzzle: Vec3::ZERO,
            eject: Vec3::ZERO,
            eject_vel: Vec3::ZERO,
            look: Vec2::ZERO,
            sway: Spring3::default(),
            kick: Spring3::default(),
            land: Spring::default(),
            jolt: Spring3::default(),
            trauma: 0.0,
            punch: Spring::default(),
            sprint_k: 0.0,
            wall_k: 0.0,
            air_k: 0.0,
            strafe: 0.0,
            bob_amp: 0.0,
            eye_y: None,
            time: 0.0,
            locked: false,
            death: None,
            alive: true,
        }
    }

    pub fn reset(&mut self) {
        let meta = std::mem::take(&mut self.meta);
        *self = View::new(meta);
    }

    pub fn first_person(&self) -> bool {
        self.alive && self.death.is_none()
    }

    pub fn camera(&self) -> Camera {
        self.cam
    }

    pub fn viewmodel(&self) -> Option<ViewModel> {
        self.vm.clone()
    }

    /// The player turned the view (radians): the weapon lags behind it.
    pub fn turned(&mut self, yaw: f32, pitch: f32) {
        self.look += Vec2::new(yaw, pitch);
    }

    pub fn moved(&mut self, m: Moved) {
        match m {
            Moved::Land(fall) => self.land.v -= (fall * 0.055).min(46.0),
            Moved::Jump => self.land.v += 9.0,
            _ => {}
        }
    }

    pub fn cue(&mut self, c: Cue) {
        match c {
            Cue::MagIn => self.kick.v += Vec3::new(0.25, -0.5, 0.6),
            Cue::BoltRack => {
                self.kick.v += Vec3::new(0.5, 0.3, -1.2);
                self.locked = false;
            }
            Cue::MagOut => self.kick.v += Vec3::new(0.0, 0.35, -0.5),
            Cue::ShellInsert => self.kick.v += Vec3::new(0.1, -0.25, 0.3),
            _ => {}
        }
    }

    pub fn fired(&mut self, d: &'static WeaponDef, last: bool, rng: &mut Rng) {
        // The spring is driven by velocity: an impulse that peaks at about the weapon's travel.
        self.kick.v += Vec3::new(
            d.vm_back * 28.0,
            deg(d.vm_rise) * 26.0,
            deg(d.vm_rise) * 9.0 * rng.s(),
        );
        self.punch.v -= if d.class == Class::Shotgun || d.class == Class::Marksman {
            34.0
        } else {
            14.0
        };
        self.trauma = (self.trauma
            + if d.class == Class::Shotgun || d.class == Class::Marksman {
                0.2
            } else {
                0.07
            })
        .min(1.0);
        self.locked = last;
    }

    pub fn hurt(&mut self, amount: f32) {
        let k = (amount / 40.0).clamp(0.25, 1.4);
        self.jolt.v += Vec3::new(
            0.9 * (self.time * 91.0).sin(),
            -0.7,
            1.6 * (self.time * 57.0).cos(),
        ) * k;
        self.trauma = (self.trauma + 0.12 * k).min(1.0);
    }

    pub fn shake(&mut self, k: f32) {
        self.trauma = (self.trauma + k).min(1.0);
    }

    pub fn died(&mut self) {
        self.death = Some(DeathCam {
            t: 0.0,
            eye: self.cam.eye,
            rot: self.cam.rot,
            watch: 0.0,
            from: None,
        });
        self.vm = None;
    }

    /// `watch`: a living teammate to follow once dead for good (elimination).
    pub fn update(
        &mut self,
        dt: f32,
        a: &Actor,
        map: &Map,
        alpha: f32,
        killer: Option<&Actor>,
        body: &Puppet,
        watch: Option<&Actor>,
    ) {
        self.time += dt;
        self.alive = a.alive;
        self.trauma = (self.trauma - 1.5 * dt).max(0.0);
        self.kick.step(210.0, 21.0, dt);
        self.land.step(120.0, 15.0, dt);
        self.jolt.step(140.0, 14.0, dt);
        self.punch.step(160.0, 19.0, dt);
        if let Some(d) = &mut self.death {
            // The death camera: back and up from the body, away from the killer, so both are in view.
            d.t += dt;
            let target = body.chest().unwrap_or(a.body.pos);
            let away = match killer {
                Some(k) => flat(target - k.body.pos).normalize_or(-yaw_dir(a.yaw)),
                None => -yaw_dir(a.yaw),
            };
            let want = target + away * 105.0 + Vec3::Y * 46.0;
            let tr = map.ray(target + Vec3::Y * 8.0, want);
            let pos = (target + Vec3::Y * 8.0).lerp(want, (tr.fraction - 0.08).clamp(0.05, 1.0));
            let aim = match killer {
                Some(k) => target.lerp(k.body.pos, 0.22),
                None => target,
            };
            let (y, p) = crate::util::dir_angles((aim - pos).normalize_or(Vec3::NEG_Z));
            let rot = view_quat(y, p, 0.0);
            let k = smooth(d.t / 0.7);
            let mut cam = Camera {
                eye: d.eye.lerp(pos, k),
                rot: d.rot.slerp(rot, k),
                fov: FOV,
            };
            // Out of the round: over a teammate's shoulder.
            if let Some(w) = watch.filter(|_| d.t > 2.6) {
                let from = *d.from.get_or_insert((cam.eye, cam.rot));
                d.watch += dt;
                let (y, p) = w.aim();
                let eye =
                    w.prev.lerp(w.body.pos, alpha) - Vec3::Y * w.half() + Vec3::Y * w.eye_height();
                let want =
                    eye - crate::util::view_dir(y, p) * 84.0 + Vec3::Y * 12.0 + yaw_right(y) * 18.0;
                let tr = map.ray(eye, want);
                let at = eye.lerp(want, (tr.fraction - 0.1).clamp(0.1, 1.0));
                let k = smooth(d.watch / 0.6);
                cam = Camera {
                    eye: from.0.lerp(at, k),
                    rot: from.1.slerp(view_quat(y, p - 0.04, 0.0), k),
                    fov: FOV,
                };
            } else {
                d.from = None;
                d.watch = 0.0;
            }
            self.cam = cam;
            self.vm = None;
            return;
        }
        if !a.alive {
            return;
        }
        let arms = &a.arms;
        let def = arms.def();
        let m = self.meta.get(def.id);

        // The eye: stairs are smoothed, the bob and the landing dip added.
        let feet = a.prev.lerp(a.body.pos, alpha) - Vec3::Y * a.half();
        let mut eye = feet + Vec3::Y * a.eye_height();
        let y = match self.eye_y {
            Some(y) if a.body.on_ground && (eye.y - y).abs() < 30.0 && a.mantle.is_none() => {
                y + (eye.y - y) * damp(22.0, dt)
            }
            _ => eye.y,
        };
        self.eye_y = Some(y);
        eye.y = y;
        let speed = a.speed();
        let grounded = a.body.on_ground && a.slide <= 0.0;
        let ads = smooth(arms.ads);
        let amp = if grounded {
            (speed / JOG).min(1.5)
        } else {
            0.0
        };
        self.bob_amp += (amp - self.bob_amp) * damp(9.0, dt);
        let ph = a.stride_phase * std::f32::consts::TAU;
        let (bob_x, bob_y) = (ph.sin() * self.bob_amp, -(ph.sin().abs()) * self.bob_amp);
        self.sprint_k += ((a.sprinting as i32 as f32) - self.sprint_k) * damp(11.0, dt);
        self.air_k += (((!a.body.on_ground) as i32 as f32) - self.air_k) * damp(10.0, dt);
        let vel_right = a.body.vel.dot(yaw_right(a.yaw));
        self.strafe += ((vel_right / JOG).clamp(-1.4, 1.4) - self.strafe) * damp(9.0, dt);
        let (yaw, pitch) = a.aim();
        let t = self.trauma * self.trauma;
        let n = |f: f32, o: f32| {
            (self.time * f + o).sin() * 0.6 + (self.time * f * 2.3 + o * 1.7).sin() * 0.4
        };
        let shake = Vec3::new(n(31.0, 0.0), n(37.0, 2.0), n(29.0, 4.0)) * t * deg(2.4);
        let bob_k = 1.0 - 0.8 * ads;
        eye.y += bob_y * 1.0 * bob_k * (1.0 + 0.6 * self.sprint_k) + self.land.x;
        eye += yaw_right(yaw) * bob_x * 0.5 * bob_k;
        let roll = -self.strafe * deg(0.9)
            + bob_x * deg(0.35) * bob_k
            + self.jolt.x.z * 0.03
            + shake.z
            + if a.slide > 0.0 { deg(-3.5) } else { 0.0 } * a.crouch_k;
        let cam_rot = view_quat(
            yaw + shake.x + self.jolt.x.x * 0.02,
            pitch + shake.y + self.land.x * 0.004 + self.jolt.x.y * 0.02,
            roll,
        );
        let base = FOV + 4.5 * self.sprint_k + if a.slide > 0.0 { 4.0 * a.crouch_k } else { 0.0 };
        let fov = base + (def.ads_fov - base) * ads + self.punch.x * (1.0 - 0.6 * ads) * 0.08;
        self.cam = Camera {
            eye,
            rot: cam_rot,
            fov,
        };

        // The weapon, in the camera's space (metres): hip to sights, then everything that moves it.
        let hip = tune("OPENSTRIKE_HIP").unwrap_or(match def.class {
            Class::Pistol => Vec3::new(0.1, -0.105, -0.5),
            Class::Smg => Vec3::new(0.12, -0.14, -0.4),
            _ => Vec3::new(0.125, -0.145, -0.43),
        });
        let slim = Vec3::new(SLIM, SLIM, 1.0);
        // Through the sights: the eye on the sight line, a little further back than the model's eye point.
        let relief = if def.class == Class::Marksman || def.class == Class::Pistol {
            0.0
        } else {
            0.05
        };
        let sights = -(m.eye * slim) - Vec3::Z * relief;
        let mut pos = hip.lerp(sights, ads) - Vec3::Y * 0.014 * (ads * std::f32::consts::PI).sin();
        let hip_turn = tune("OPENSTRIKE_HIP_TURN").unwrap_or(if def.class == Class::Pistol {
            Vec3::new(0.0, 2.0, 0.0)
        } else {
            Vec3::new(1.0, 4.5, -2.0)
        });
        let mut rot = Quat::from_rotation_y(deg(hip_turn.y) * (1.0 - ads))
            * Quat::from_rotation_x(deg(hip_turn.x) * (1.0 - ads))
            * Quat::from_rotation_z(deg(hip_turn.z) * (1.0 - ads));
        // Sway: the gun trails the look and settles.
        let look = std::mem::take(&mut self.look);
        self.sway.v += Vec3::new(-look.x, -look.y, -look.x * 0.6) * 62.0 * (1.0 - 0.6 * ads);
        self.sway.step(95.0, 15.0, dt);
        let sway = self.sway.x.clamp(Vec3::splat(-0.09), Vec3::splat(0.09));
        rot *= Quat::from_rotation_y(sway.x)
            * Quat::from_rotation_x(sway.y)
            * Quat::from_rotation_z(sway.z * 0.7);
        pos += Vec3::new(-sway.x * 0.05, -sway.y * 0.04, 0.0);
        // Breathing, the stride, the strafe's lean, the fall.
        let breath = Vec2::new((self.time * 0.9).sin(), (self.time * 1.37).sin())
            * (0.0016
                + 0.0012
                    * ads
                    * if def.class == Class::Marksman {
                        1.6
                    } else {
                        0.4
                    });
        pos += Vec3::new(breath.x, breath.y, 0.0);
        pos += Vec3::new(bob_x * 0.0052, bob_y * 0.0058 + 0.002, 0.0)
            * bob_k
            * (1.0 + 0.9 * self.sprint_k);
        rot *= Quat::from_rotation_z(
            bob_x * deg(1.1) * bob_k - self.strafe * deg(2.2) * (1.0 - 0.7 * ads),
        );
        pos.x -= self.strafe * 0.005 * (1.0 - ads);
        pos.y -=
            (a.body.vel.y / 320.0).clamp(-1.0, 1.0) * 0.016 * self.air_k + self.land.x * 0.0018;
        // Poses: sprint (the gun across the chest, the pistol up), crouch, slide.
        let s = smooth(self.sprint_k);
        if s > 0.001 {
            let carry = tune("OPENSTRIKE_RUN").unwrap_or(if def.class == Class::Pistol {
                Vec3::new(0.1, -0.13, -0.4)
            } else {
                Vec3::new(0.1, -0.2, -0.34)
            });
            let t = tune("OPENSTRIKE_RUN_TURN").unwrap_or(if def.class == Class::Pistol {
                Vec3::new(42.0, 6.0, 0.0)
            } else {
                Vec3::new(24.0, 38.0, -16.0)
            });
            let r = Quat::from_rotation_y(deg(t.y))
                * Quat::from_rotation_x(deg(t.x))
                * Quat::from_rotation_z(deg(t.z));
            // The stride swings the carried gun more than it bobs the aimed one.
            let swing = Vec3::new(bob_x * 0.012, bob_y * 0.012, 0.0);
            pos = pos.lerp(carry + swing, s);
            rot = rot.slerp(r * Quat::from_rotation_z(bob_x * deg(2.5)), s);
        }
        let hip_k = 1.0 - ads;
        rot *= Quat::from_rotation_z(
            deg(-4.0) * a.crouch_k * hip_k
                + if a.slide > 0.0 {
                    deg(11.0) * a.crouch_k
                } else {
                    0.0
                },
        );
        pos.y -= 0.008 * a.crouch_k * hip_k;
        // A wall in the way: the gun comes back and up.
        let fwd = cam_rot * Vec3::NEG_Z;
        let reach = (m.muzzle.z.abs() + 0.3) / UNIT;
        let tr = map.ray(eye, eye + fwd * reach);
        self.wall_k += ((1.0 - tr.fraction).clamp(0.0, 1.0) * 1.6)
            .min(1.0)
            .max(0.0)
            .mul_add(1.0, -self.wall_k)
            * damp(13.0, dt);
        let wk = smooth(self.wall_k);
        pos += Vec3::new(-0.02, -0.035, 0.11) * wk;
        rot *= Quat::from_rotation_x(deg(34.0) * wk) * Quat::from_rotation_y(deg(14.0) * wk);

        // The hands' work.
        let mut mag = Vec3::ZERO;
        let mut arm_l = Vec3::ZERO;
        let mut bolt = 0.0f32;
        let hide = Vec3::new(0.0, -4.0, 0.0);
        if def.shell.is_some() {
            mag = hide;
        }
        let pulse = |x: f32, at: f32, w: f32| (1.0 - ((x - at) / w).abs()).clamp(0.0, 1.0);
        if let Some(r) = arms.reload {
            let k = (r.t / r.dur).clamp(0.0, 1.0);
            if let Some(per) = def.shell {
                // Shells: the port rolls up, the left hand feeds one shell after another.
                let tail = r.dur - r.t;
                let e = smooth(r.t / 0.3) * smooth(tail / 0.3);
                rot *= Quat::from_rotation_z(deg(32.0) * e) * Quat::from_rotation_x(deg(9.0) * e);
                pos += Vec3::new(-0.035, 0.012, 0.03) * e;
                let cyc = (r.t - 0.35) / per;
                if cyc >= 0.0 && (cyc as u32) < r.shells {
                    let p = cyc.fract();
                    let away = Vec3::new(-0.02, -0.16, 0.08);
                    let (hand, shell) = if p < 0.6 {
                        let q = smooth(p / 0.6);
                        (away * (1.0 - q), away * (1.0 - q))
                    } else {
                        let q = smooth((p - 0.6) / 0.4);
                        (away * q, hide)
                    };
                    arm_l = hand;
                    mag = shell;
                } else if r.empty && cyc >= r.shells as f32 {
                    bolt = m.bolt * pulse(r.t, 0.35 + per * r.shells as f32 + 0.25, 0.1);
                }
            } else {
                // A magazine: the gun cants, the old one drops with the hand, the new one comes up, the bolt goes home.
                let (out_at, in_at, rack_at) = if r.empty {
                    (0.16, 0.56, 0.82)
                } else {
                    (0.2, 0.68, 2.0)
                };
                let e = smooth(k / 0.12) * smooth((1.0 - k) / if r.empty { 0.1 } else { 0.16 });
                let cant = if def.class == Class::Pistol {
                    Quat::from_rotation_z(deg(-28.0) * e) * Quat::from_rotation_x(deg(20.0) * e)
                } else {
                    Quat::from_rotation_z(deg(-22.0) * e)
                        * Quat::from_rotation_x(deg(8.0) * e)
                        * Quat::from_rotation_y(deg(5.0) * e)
                };
                rot *= cant;
                pos += Vec3::new(-0.03, 0.022, 0.025) * e;
                let far = m.mag_out * 2.6 + Vec3::new(-0.06, -0.1, 0.05);
                let travel = if k < out_at {
                    Vec3::ZERO
                } else if k < out_at + 0.1 {
                    m.mag_out * smooth((k - out_at) / 0.1)
                } else if k < in_at - 0.2 {
                    m.mag_out.lerp(far, smooth((k - out_at - 0.1) / 0.1))
                } else if k < in_at - 0.07 {
                    far.lerp(m.mag_out, smooth((k - (in_at - 0.2)) / 0.13))
                } else if k < in_at {
                    m.mag_out * (1.0 - smooth((k - (in_at - 0.07)) / 0.07))
                } else {
                    Vec3::ZERO
                };
                mag = travel;
                // The hand leaves the handguard for the magazine, carries it, and goes back.
                let grab = smooth((k - (out_at - 0.12)) / 0.1) * smooth((in_at + 0.14 - k) / 0.12);
                let reach = if def.class == Class::Pistol {
                    Vec3::new(0.02, -0.07, 0.04)
                } else {
                    Vec3::new(0.012, -0.13, m.grip_l.z.abs() - 0.1)
                };
                arm_l = reach * grab + travel;
                if r.empty {
                    // Locked back until the rack lets it go.
                    bolt = if k < rack_at {
                        m.bolt
                    } else {
                        m.bolt * (1.0 - smooth((k - rack_at) / 0.04))
                    };
                    if k > rack_at - 0.08 && k < rack_at + 0.05 {
                        arm_l = Vec3::new(0.03, 0.03, 0.12) * pulse(k, rack_at - 0.01, 0.07);
                    }
                }
            }
        } else if self.locked && arms.slot().mag == 0 {
            bolt = m.bolt;
        }
        if let Some(t) = tune("OPENSTRIKE_ARM") {
            arm_l = t;
            mag = t;
        }
        // The bolt cycles with each shot.
        let sh = arms.since_shot;
        if sh < 0.09 && arms.reload.is_none() {
            bolt = bolt.max(
                m.bolt
                    * if sh < 0.025 {
                        sh / 0.025
                    } else {
                        1.0 - (sh - 0.025) / 0.065
                    },
            );
        }
        // The swap and the draw: down and up.
        let mut low = 0.0f32;
        if let Some(sw) = arms.swap {
            low = smooth(sw.t / sw.lower);
        } else if arms.draw > 0.0 {
            low = smooth(arms.draw / def.draw);
        }
        if a.mantle.is_some() {
            low = low.max(0.75);
        }
        // A grenade: the gun drops left while the arm throws.
        if let Some(t) = arms.throw {
            let e = smooth(t / 0.14) * smooth((THROW_TIME - t) / 0.3);
            low = low.max(e * 0.62);
            arm_l += Vec3::new(-0.1, -0.3, 0.1) * e;
        }
        if low > 0.0 {
            pos += Vec3::new(-0.02, -0.26, 0.04) * low;
            rot *= Quat::from_rotation_x(deg(-46.0) * low) * Quat::from_rotation_z(deg(14.0) * low);
        }
        // The strike: wind up, thrust the gun across, recover.
        if let Some(t) = arms.melee {
            let wind = smooth(t / MELEE_STRIKE);
            let hit = pulse(t, MELEE_STRIKE + 0.05, 0.09);
            let back = smooth((MELEE_TIME - t) / 0.25);
            let w = wind * back * (1.0 - hit);
            pos += Vec3::new(0.03, 0.0, 0.07) * w + Vec3::new(-0.11, 0.03, -0.2) * hit;
            rot *= Quat::from_rotation_y(deg(-18.0) * w + deg(48.0) * hit)
                * Quat::from_rotation_z(deg(-12.0) * w + deg(34.0) * hit);
        }
        // The kick.
        let kk = 1.0 - 0.45 * ads;
        pos.z += self.kick.x.x.clamp(-0.02, 0.09) * kk;
        rot *= Quat::from_rotation_x(self.kick.x.y.clamp(-0.1, 0.22) * kk)
            * Quat::from_rotation_z(self.kick.x.z * kk);
        pos += Vec3::new(self.jolt.x.x, self.jolt.x.y, 0.0) * 0.004;

        let wpos = eye + cam_rot * (pos / UNIT);
        let wrot = (cam_rot * rot).normalize();
        self.muzzle = wpos + wrot * (m.muzzle * slim / UNIT);
        self.eject = wpos + wrot * (m.eject * slim / UNIT);
        self.eject_vel = wrot * m.eject_dir * 105.0 + a.body.vel * 0.8;
        // The marksman's scope is the HUD's once it is up: the rifle leaves the picture.
        let scoped = def.class == Class::Marksman && arms.ads > 0.85;
        self.vm = (!scoped).then(|| ViewModel {
            weapon: def.id,
            pos: (wpos * UNIT).to_array(),
            rot: wrot.to_array(),
            mag: (mag * slim).to_array(),
            bolt,
            arm_l: (arm_l * slim).to_array(),
            scale: slim.to_array(),
        });
    }
}

// --------------------------------------------------------------------------------------------- effects

pub const TRACERS: usize = 6;
pub const FLASHES: usize = 3;
pub const SPARKS: usize = 6;
pub const DECALS: usize = 24;
pub const CASINGS: usize = 8;
pub const BLASTS: usize = 2;
pub const BLOODS: usize = 4;
pub const NADES: usize = 4;
pub const SCORCHES: usize = 3;
const TRACER_SPEED: f32 = 9000.0;
const TRACER_LEN: f32 = 230.0;

struct Tracer {
    from: Vec3,
    dir: Vec3,
    dist: f32,
    head: f32,
}

struct Casing {
    pos: Vec3,
    vel: Vec3,
    rot: Quat,
    spin: Vec3,
    age: f32,
    bounces: u32,
    shell: bool,
}

/// One placed thing on screen (metres).
#[derive(Clone, Copy, Debug, Default)]
pub struct Placed {
    pub pos: [f32; 3],
    pub rot: [f32; 4],
    /// Strength 0..1 (a flash's light, a spark's glow), or a length / radius in metres.
    pub k: f32,
    pub flag: bool,
}

#[derive(Clone, Debug, Default)]
pub struct FxFrame {
    /// Streaks: the centre, the rotation whose -Z runs along it, the length.
    pub tracers: Vec<Placed>,
    /// Muzzle flashes (flag: a big one).
    pub flashes: Vec<Placed>,
    pub sparks: Vec<Placed>,
    /// Bullet holes by slot (they stay until the slot is reused).
    pub decals: Vec<Option<Placed>>,
    /// Casings (flag: a shotgun shell).
    pub casings: Vec<Placed>,
    /// Blasts: k = age in seconds.
    pub blasts: Vec<Placed>,
    pub bloods: Vec<Placed>,
    pub nades: Vec<Placed>,
    /// Scorched ground where grenades went off.
    pub scorches: Vec<Placed>,
}

pub struct Fx {
    tracers: Vec<Tracer>,
    flashes: Vec<(usize, Vec3, f32, bool, Vec3)>,
    /// Position, velocity, age, life.
    sparks: Vec<(Vec3, Vec3, f32, f32)>,
    scorches: Vec<Vec3>,
    decals: Vec<Option<(Vec3, Vec3)>>,
    next_decal: usize,
    casings: Vec<Casing>,
    blasts: Vec<(Vec3, f32)>,
    bloods: Vec<(Vec3, Vec3, f32)>,
    seed: Rng,
}

/// The rotation whose -Z is `dir`.
pub fn aim_quat(dir: Vec3) -> Quat {
    Quat::from_rotation_arc(Vec3::NEG_Z, dir.normalize_or(Vec3::NEG_Z))
}

impl Fx {
    pub fn new(_meta: WeaponMeta) -> Fx {
        Fx {
            tracers: vec![],
            flashes: vec![],
            sparks: vec![],
            scorches: vec![],
            decals: vec![None; DECALS],
            next_decal: 0,
            casings: vec![],
            blasts: vec![],
            bloods: vec![],
            seed: Rng::new(77),
        }
    }

    pub fn tracer(&mut self, from: Vec3, to: Vec3) {
        let d = to - from;
        let dist = d.length();
        if dist < 160.0 {
            return;
        }
        if self.tracers.len() >= TRACERS {
            self.tracers.remove(0);
        }
        self.tracers.push(Tracer {
            from,
            dir: d / dist,
            dist,
            head: 90.0,
        });
    }

    pub fn flash(&mut self, actor: usize, pos: Vec3, big: bool, dir: Vec3) {
        self.flashes.retain(|f| f.0 != actor);
        if self.flashes.len() >= FLASHES {
            self.flashes.remove(0);
        }
        self.flashes.push((actor, pos, 0.0, big, dir));
    }

    pub fn impact(&mut self, pos: Vec3, normal: Vec3, mark: bool) {
        if self.sparks.len() >= SPARKS {
            self.sparks.remove(0);
        }
        self.sparks
            .push((pos + normal * 1.5, normal * 60.0, 0.0, 0.14));
        if mark {
            self.decals[self.next_decal] = Some((pos + normal * 0.12, normal));
            self.next_decal = (self.next_decal + 1) % DECALS;
        }
    }

    pub fn blood(&mut self, pos: Vec3, dir: Vec3) {
        if self.bloods.len() >= BLOODS {
            self.bloods.remove(0);
        }
        self.bloods.push((pos, dir * 60.0 + Vec3::Y * 20.0, 0.0));
    }

    pub fn casing(&mut self, pos: Vec3, vel: Vec3, shell: bool) {
        if self.casings.len() >= CASINGS {
            self.casings.remove(0);
        }
        let r = &mut self.seed;
        let jitter = Vec3::new(r.s(), r.s(), r.s()) * 22.0;
        self.casings.push(Casing {
            pos,
            vel: vel + jitter + Vec3::Y * 40.0,
            rot: Quat::from_rotation_y(r.f() * 6.0),
            spin: Vec3::new(r.s(), r.s(), r.s()) * 22.0,
            age: 0.0,
            bounces: 0,
            shell,
        });
    }

    pub fn blast(&mut self, pos: Vec3) {
        if self.blasts.len() >= BLASTS {
            self.blasts.remove(0);
        }
        self.blasts.push((pos, 0.0));
        // Burning fragments thrown out, and a scorched patch where it went off.
        for _ in 0..SPARKS {
            let d = self.seed.sphere();
            let v = Vec3::new(d.x, d.y.abs() * 0.8 + 0.25, d.z) * self.seed.range(260.0, 520.0);
            if self.sparks.len() >= SPARKS {
                self.sparks.remove(0);
            }
            self.sparks
                .push((pos + Vec3::Y * 6.0, v, 0.0, self.seed.range(0.35, 0.6)));
        }
        if self.scorches.len() >= SCORCHES {
            self.scorches.remove(0);
        }
        self.scorches.push(pos);
    }

    pub fn update(&mut self, dt: f32, map: &Map, events: &mut Vec<Event>) {
        for t in &mut self.tracers {
            t.head += TRACER_SPEED * dt;
        }
        self.tracers.retain(|t| t.head - TRACER_LEN < t.dist);
        for f in &mut self.flashes {
            f.2 += dt;
        }
        self.flashes.retain(|f| f.2 < 0.06);
        for s in &mut self.sparks {
            s.2 += dt;
            if s.3 > 0.2 {
                s.1.y -= 700.0 * dt;
            }
            s.0 += s.1 * dt;
        }
        self.sparks.retain(|s| s.2 < s.3);
        for b in &mut self.blasts {
            b.1 += dt;
        }
        self.blasts.retain(|b| b.1 < 0.55);
        for b in &mut self.bloods {
            b.2 += dt;
            b.1.y -= 500.0 * dt;
            b.0 += b.1 * dt;
        }
        self.bloods.retain(|b| b.2 < 0.2);
        for c in &mut self.casings {
            c.age += dt;
            if c.bounces >= 3 {
                continue;
            }
            c.vel.y -= 800.0 * dt;
            let to = c.pos + c.vel * dt;
            let tr = map.ray(c.pos, to);
            if tr.fraction < 1.0 && !tr.start_solid {
                c.pos = tr.end + tr.normal * 0.6;
                let into = -c.vel.dot(tr.normal);
                c.vel = (c.vel + tr.normal * into * 1.38) * 0.62;
                c.spin *= 0.55;
                if c.bounces == 0 && into > 40.0 {
                    events.push(Event::CasingLand { pos: c.pos });
                }
                c.bounces += if c.vel.length() < 60.0 { 3 } else { 1 };
            } else {
                c.pos = to;
            }
            let w = c.spin * dt;
            c.rot = (Quat::from_scaled_axis(w) * c.rot).normalize();
        }
        self.casings.retain(|c| c.age < 3.5);
    }

    pub fn frame(&self) -> FxFrame {
        let at = |p: Vec3, rot: Quat, k: f32, flag: bool| Placed {
            pos: (p * UNIT).to_array(),
            rot: rot.to_array(),
            k,
            flag,
        };
        let mut f = FxFrame::default();
        for t in &self.tracers {
            let (a, b) = ((t.head - TRACER_LEN).max(0.0), t.head.min(t.dist));
            if b - a < 8.0 {
                continue;
            }
            f.tracers.push(at(
                t.from + t.dir * (a + b) * 0.5,
                aim_quat(t.dir),
                (b - a) * UNIT,
                false,
            ));
        }
        for (_, p, age, big, dir) in &self.flashes {
            // One bright frame, then an ember.
            let k = if *age < 0.022 {
                1.0
            } else {
                (1.0 - age / 0.06).max(0.0) * 0.35
            };
            f.flashes.push(at(*p + *dir * 4.0, aim_quat(*dir), k, *big));
        }
        for (p, _, age, life) in &self.sparks {
            f.sparks
                .push(at(*p, Quat::IDENTITY, 1.0 - age / life, false));
        }
        f.scorches = self
            .scorches
            .iter()
            .map(|p| at(*p, Quat::IDENTITY, 1.0, false))
            .collect();
        f.decals = self
            .decals
            .iter()
            .map(|d| d.map(|(p, n)| at(p, aim_quat(-n), 1.0, false)))
            .collect();
        for c in &self.casings {
            f.casings.push(at(c.pos, c.rot, 1.0, c.shell));
        }
        for (p, age) in &self.blasts {
            f.blasts.push(at(*p, Quat::IDENTITY, *age, false));
        }
        for (p, _, age) in &self.bloods {
            f.bloods
                .push(at(*p, Quat::IDENTITY, 1.0 - age / 0.2, false));
        }
        f
    }
}
