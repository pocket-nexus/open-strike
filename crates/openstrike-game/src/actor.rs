//! A soldier, the player's or a bot's: its body on the map (jog, sprint, crouch, slide, jump, mantle: a GoldSrc-style
//! hull mover from pocket3d-bsp under them), its health, its hands (`Arms`), and its record in the match.
use crate::arms::Arms;
use crate::util::{Rng, approach, flat, yaw_dir, yaw_right};
use crate::weapons::WeaponDef;
use crate::world::{CROUCH_HALF, Map, STAND_HALF};
use glam::{Vec2, Vec3};
use pocket3d_bsp::collide::{CharacterState, HullKind, MoveInput, MoveParams, step_character};
use pocket3d_bsp::trace::Hull;

pub const JOG: f32 = 215.0;
pub const SPRINT: f32 = 305.0;
pub const CROUCH: f32 = 112.0;
pub const SLIDE_SPEED: f32 = 370.0;
pub const SLIDE_TIME: f32 = 0.85;
pub const JUMP_SPEED: f32 = 272.0;
/// Eye above the feet: standing, crouched, sliding.
pub const EYE_STAND: f32 = 64.0;
pub const EYE_CROUCH: f32 = 42.0;
pub const EYE_SLIDE: f32 = 32.0;
/// Health comes back this long after the last hit, at this rate.
pub const REGEN_DELAY: f32 = 4.5;
pub const REGEN_RATE: f32 = 32.0;
/// Ledges up to this far above the feet are climbed.
pub const MANTLE_MAX: f32 = 76.0;
pub const MANTLE_MIN: f32 = 22.0;

/// What an actor wants this tick. `mv`: strafe right, forward (-1..1). Pressed fields are edges.
#[derive(Clone, Copy, Default, Debug)]
pub struct Input {
    pub mv: Vec2,
    pub fire: bool,
    pub ads: bool,
    pub sprint: bool,
    pub jump: bool,
    /// The crouch button was pressed: toggles the crouch, or slides out of a sprint.
    pub crouch: bool,
    /// Bots: the stance they want (None: the toggle decides).
    pub stance: Option<bool>,
    pub reload: bool,
    pub swap: bool,
    pub nade: bool,
    pub melee: bool,
}

#[derive(Clone, Copy, Debug)]
pub struct Mantle {
    pub from: Vec3,
    pub to: Vec3,
    pub t: f32,
    pub dur: f32,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Step {
    Jog,
    Sprint,
    Crouch,
}

/// What the body did this tick (sound, camera).
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Moved {
    Step(Step),
    Jump,
    /// Fall speed at the landing.
    Land(f32),
    Slide,
    Mantle,
}

#[derive(Clone, Copy, Default, Debug)]
pub struct Record {
    pub kills: u32,
    pub deaths: u32,
    pub assists: u32,
    pub score: u32,
    pub streak: u32,
    pub best_streak: u32,
    pub headshots: u32,
    pub shots: u32,
    pub hits: u32,
    pub damage: f32,
}

#[derive(Clone, Debug)]
pub struct Actor {
    pub name: String,
    pub team: usize,
    pub bot: bool,
    pub body: CharacterState,
    /// Hull centre a tick ago (the screen interpolates).
    pub prev: Vec3,
    pub yaw: f32,
    pub pitch: f32,
    pub crouched: bool,
    /// 0 standing .. 1 crouched, eased (eye height, pose).
    pub crouch_k: f32,
    pub sprinting: bool,
    /// Seconds of slide left.
    pub slide: f32,
    pub mantle: Option<Mantle>,
    /// On a ladder; seconds until one can be grabbed again after jumping off.
    pub ladder: bool,
    ladder_block: f32,
    /// Distance since the last footstep, and the stride's phase (0..1 per two steps: the bob, the legs).
    stride: f32,
    pub stride_phase: f32,
    pub health: f32,
    pub alive: bool,
    pub since_hurt: f32,
    /// Seconds dead; the respawn at `respawn_at` (None: not in this round).
    pub dead_for: f32,
    pub respawn_in: Option<f32>,
    /// Seconds alive (spawn protection, the HUD's intro).
    pub alive_for: f32,
    pub arms: Arms,
    pub record: Record,
    /// Recent damage taken: (attacker, amount, age).
    pub hurt_by: Vec<(usize, f32, f32)>,
    /// Who killed this actor last (revenge).
    pub nemesis: Option<usize>,
    /// Kills in quick succession: (count, seconds since the last).
    pub multi: (u32, f32),
    /// Seconds since this actor last fired (radar, the bots' ears).
    pub since_fired: f32,
}

impl Actor {
    pub fn new(
        name: &str,
        team: usize,
        bot: bool,
        primary: &'static WeaponDef,
        secondary: &'static WeaponDef,
    ) -> Actor {
        Actor {
            name: name.into(),
            team,
            bot,
            body: CharacterState::new(Vec3::ZERO),
            prev: Vec3::ZERO,
            yaw: 0.0,
            pitch: 0.0,
            crouched: false,
            crouch_k: 0.0,
            sprinting: false,
            slide: 0.0,
            mantle: None,
            ladder: false,
            ladder_block: 0.0,
            stride: 0.0,
            stride_phase: 0.0,
            health: 100.0,
            alive: false,
            since_hurt: 100.0,
            dead_for: 0.0,
            respawn_in: None,
            alive_for: 0.0,
            arms: Arms::new(primary, secondary),
            record: Record::default(),
            hurt_by: vec![],
            nemesis: None,
            multi: (0, 100.0),
            since_fired: 100.0,
        }
    }

    /// Puts the actor at a spawn, alive, with full kit.
    pub fn spawn(&mut self, pos: Vec3, yaw: f32) {
        let (p, s) = (self.arms.slots[0].def, self.arms.slots[1].def);
        self.arms = Arms::new(p, s);
        self.body = CharacterState::new(pos);
        self.body.on_ground = true;
        self.prev = pos;
        self.yaw = yaw;
        self.pitch = 0.0;
        self.crouched = false;
        self.crouch_k = 0.0;
        self.sprinting = false;
        self.slide = 0.0;
        self.mantle = None;
        self.ladder = false;
        self.health = 100.0;
        self.alive = true;
        self.since_hurt = 100.0;
        self.dead_for = 0.0;
        self.respawn_in = None;
        self.alive_for = 0.0;
        self.hurt_by.clear();
        self.since_fired = 100.0;
    }

    pub fn half(&self) -> f32 {
        if self.crouched {
            CROUCH_HALF
        } else {
            STAND_HALF
        }
    }

    pub fn feet(&self) -> Vec3 {
        self.body.pos - Vec3::Y * self.half()
    }

    pub fn eye_height(&self) -> f32 {
        let crouch = if self.slide > 0.0 {
            EYE_SLIDE
        } else {
            EYE_CROUCH
        };
        EYE_STAND + (crouch - EYE_STAND) * self.crouch_k
    }

    pub fn eye(&self) -> Vec3 {
        self.feet() + Vec3::Y * self.eye_height()
    }

    /// The view with the weapon's kick.
    pub fn aim(&self) -> (f32, f32) {
        (
            self.yaw + self.arms.recoil.y,
            (self.pitch + self.arms.recoil.x).clamp(-1.5, 1.5),
        )
    }

    pub fn speed(&self) -> f32 {
        flat(self.body.vel).length()
    }

    fn hull(&self) -> (Hull, HullKind) {
        if self.crouched {
            (Hull::Crouch, HullKind::Crouch)
        } else {
            (Hull::Stand, HullKind::Stand)
        }
    }

    fn set_crouch(&mut self, map: &Map, down: bool) -> bool {
        if down == self.crouched {
            return true;
        }
        let d = STAND_HALF - CROUCH_HALF;
        if down {
            self.crouched = true;
            // On the ground the feet stay; in the air the legs tuck up.
            if self.body.on_ground {
                self.body.pos.y -= d;
                self.prev.y -= d;
            }
            true
        } else {
            let up = self.body.pos + Vec3::Y * d;
            let p = if map.fits(Hull::Stand, up) {
                Some(up)
            } else if map.fits(Hull::Stand, self.body.pos) {
                Some(self.body.pos)
            } else {
                None
            };
            match p {
                Some(p) => {
                    self.prev += p - self.body.pos;
                    self.body.pos = p;
                    self.crouched = false;
                    true
                }
                None => false,
            }
        }
    }

    /// A ledge ahead to climb: the standing hull centre on top of it.
    fn find_mantle(&self, map: &Map, dir: Vec3) -> Option<Vec3> {
        let feet = self.feet();
        let pos = self.body.pos;
        // Something in the way at this height...
        let ahead = map.hull(self.hull().0, pos, pos + dir * 20.0);
        if ahead.fraction >= 1.0 {
            return None;
        }
        // ...with a top within reach, flat enough to stand on...
        let over = Vec3::new(
            pos.x + dir.x * 34.0,
            feet.y + MANTLE_MAX + 4.0,
            pos.z + dir.z * 34.0,
        );
        let down = map.ray(over, Vec3::new(over.x, feet.y + MANTLE_MIN, over.z));
        if down.start_solid || down.fraction >= 1.0 || down.normal.y < 0.7 {
            return None;
        }
        let top = down.end.y;
        let to = Vec3::new(over.x, top + STAND_HALF + 1.0, over.z);
        // ...room to stand there, and a clear way up and over.
        if !map.fits(Hull::Stand, to) {
            return None;
        }
        let rise = Vec3::new(pos.x, to.y, pos.z);
        let hull = Hull::Crouch;
        let from = if self.crouched {
            pos
        } else {
            pos + Vec3::Y * (STAND_HALF - CROUCH_HALF)
        };
        let up = map.hull(
            hull,
            from,
            Vec3::new(pos.x, to.y - (STAND_HALF - CROUCH_HALF), pos.z),
        );
        if up.fraction < 1.0 || up.start_solid {
            return None;
        }
        let across = map.hull(Hull::Stand, rise, to);
        (across.fraction >= 1.0 && !across.start_solid
            || map.fits(Hull::Stand, rise) && across.fraction > 0.95)
            .then_some(to)
    }

    /// Advances the body one tick. `rng` varies the footsteps.
    pub fn step(&mut self, map: &Map, i: &Input, dt: f32, out: &mut Vec<Moved>, _rng: &mut Rng) {
        self.prev = self.body.pos;
        self.alive_for += dt;
        self.since_hurt += dt;
        self.since_fired += dt;
        self.multi.1 += dt;
        for h in &mut self.hurt_by {
            h.2 += dt;
        }
        self.hurt_by.retain(|h| h.2 < 8.0);
        if self.since_hurt > REGEN_DELAY && self.health < 100.0 {
            self.health = (self.health + REGEN_RATE * dt).min(100.0);
        }

        // A climb in progress: up, then over.
        if let Some(m) = &mut self.mantle {
            m.t += dt;
            let k = (m.t / m.dur).min(1.0);
            let up = crate::util::smooth((k / 0.62).min(1.0));
            let over = crate::util::smooth(((k - 0.45) / 0.55).clamp(0.0, 1.0));
            self.body.pos = Vec3::new(
                m.from.x + (m.to.x - m.from.x) * over,
                m.from.y + (m.to.y - m.from.y) * up,
                m.from.z + (m.to.z - m.from.z) * over,
            );
            if k >= 1.0 {
                let d = flat(m.to - m.from).normalize_or_zero();
                self.body.vel = d * 140.0;
                self.body.on_ground = true;
                self.mantle = None;
            }
            self.crouch_k = approach(self.crouch_k, 0.0, dt * 6.0);
            return;
        }

        let fwd = yaw_dir(self.yaw);
        let wish = (fwd * i.mv.y + yaw_right(self.yaw) * i.mv.x).clamp_length_max(1.0);
        let moving_fwd = i.mv.y > 0.4 && i.mv.length() > 0.5;
        let speed = self.speed();

        // A ladder: the look decides up or down, a jump lets go.
        self.ladder_block = (self.ladder_block - dt).max(0.0);
        let reach = self.body.pos + fwd * 20.0;
        let touching = self.ladder_block <= 0.0
            && self.slide <= 0.0
            && (map.on_ladder(reach)
                || map.on_ladder(reach - Vec3::Y * (self.half() - 6.0))
                || map.on_ladder(self.body.pos));
        if touching && (self.ladder || !self.body.on_ground || i.mv.y > 0.2) {
            if i.jump {
                self.ladder = false;
                self.ladder_block = 0.45;
                self.body.vel = -fwd * 170.0 + Vec3::Y * 150.0;
                out.push(Moved::Jump);
            } else {
                self.ladder = true;
                self.sprinting = false;
                let up = if self.pitch > -0.35 { 1.0 } else { -1.0 };
                let climb = i.mv.y * up * 175.0;
                // Onto the top: a push forward once the feet clear it.
                self.body.vel = Vec3::Y * climb
                    + yaw_right(self.yaw) * i.mv.x * 90.0
                    + fwd * if i.mv.y > 0.0 { 60.0 } else { 0.0 };
                let params = MoveParams {
                    gravity: 0.0,
                    air_accelerate: 0.0,
                    friction: 0.0,
                    ..MoveParams::default()
                };
                self.body.on_ground = false;
                step_character(
                    &map.col,
                    self.hull().1,
                    &mut self.body,
                    &params,
                    &MoveInput::default(),
                    dt,
                );
                self.stride += climb.abs() * dt;
                if self.stride > 44.0 {
                    self.stride = 0.0;
                    out.push(Moved::Step(Step::Crouch));
                }
                self.crouch_k = approach(
                    self.crouch_k,
                    if self.crouched { 1.0 } else { 0.0 },
                    dt * 7.0,
                );
                return;
            }
        } else {
            self.ladder = false;
        }

        // Stance: the slide out of a sprint, the crouch toggle, the bots' explicit stance.
        if self.slide > 0.0 {
            self.slide -= dt;
            if self.slide <= 0.0
                || speed < 120.0
                || !self.body.on_ground && self.slide < SLIDE_TIME - 0.2
            {
                self.slide = 0.0;
                if i.stance != Some(true) {
                    self.set_crouch(map, false);
                }
            }
        } else if i.crouch && self.sprinting && self.body.on_ground && speed > 230.0 {
            if self.set_crouch(map, true) {
                self.slide = SLIDE_TIME;
                let d = flat(self.body.vel).normalize_or(fwd);
                self.body.vel = d * speed.max(SLIDE_SPEED);
                out.push(Moved::Slide);
            }
        } else if i.crouch {
            let down = !self.crouched;
            self.set_crouch(map, down);
        } else if let Some(want) = i.stance {
            if want != self.crouched {
                self.set_crouch(map, want);
            }
        }
        self.sprinting = i.sprint
            && moving_fwd
            && !self.crouched
            && self.body.on_ground
            && !i.ads
            && !i.fire
            && self.slide <= 0.0;
        if self.sprinting && self.arms.ads > 0.0 {
            self.sprinting = false;
        }
        let ck = if self.slide > 0.0 { 9.0 } else { 7.0 };
        self.crouch_k = approach(
            self.crouch_k,
            if self.crouched { 1.0 } else { 0.0 },
            dt * ck,
        );

        // Jump: a ledge ahead is climbed instead; a jump out of a crouch stands up.
        let mut jump = false;
        if i.jump {
            let dir = if wish.length() > 0.3 {
                wish.normalize()
            } else {
                fwd
            };
            if let Some(to) = self.find_mantle(map, dir) {
                self.start_mantle(to, out);
                return;
            }
            if self.body.on_ground {
                if self.crouched && self.slide <= 0.0 {
                    self.set_crouch(map, false);
                }
                jump = !self.crouched || self.slide > 0.0;
                if jump {
                    self.slide = 0.0;
                    out.push(Moved::Jump);
                }
            }
        } else if !self.body.on_ground && moving_fwd && self.body.vel.y < 120.0 {
            // In the air, pushing into a ledge: grab it.
            if let Some(to) = self.find_mantle(map, fwd) {
                self.start_mantle(to, out);
                return;
            }
        }

        let d = self.arms.def();
        let gun = d.mobility * (1.0 + (d.ads_move - 1.0) * self.arms.ads);
        let sliding = self.slide > 0.0;
        let max = if sliding {
            SLIDE_SPEED
        } else if self.crouched {
            CROUCH
        } else if self.sprinting {
            SPRINT
        } else {
            JOG
        } * gun;
        let params = MoveParams {
            max_speed: max,
            accelerate: if sliding { 0.6 } else { 8.5 },
            friction: if sliding { 0.95 } else { 5.5 },
            jump_speed: JUMP_SPEED,
            air_accelerate: 12.0,
            ..MoveParams::default()
        };
        let was_ground = self.body.on_ground;
        let fall = -self.body.vel.y;
        let input = MoveInput {
            wish_dir: wish.normalize_or_zero(),
            speed: if sliding { 0.25 } else { wish.length() },
            jump,
        };
        step_character(&map.col, self.hull().1, &mut self.body, &params, &input, dt);
        if !was_ground && self.body.on_ground && fall > 180.0 {
            out.push(Moved::Land(fall));
            self.stride = 0.0;
        }

        // Footsteps by distance covered.
        if self.body.on_ground && !sliding {
            let v = self.speed();
            let (len, kind) = if self.crouched {
                (46.0, Step::Crouch)
            } else if self.sprinting {
                (84.0, Step::Sprint)
            } else {
                (62.0, Step::Jog)
            };
            if v > 40.0 {
                self.stride += v * dt;
                self.stride_phase = (self.stride_phase + v * dt / (len * 2.0)).fract();
                if self.stride >= len {
                    self.stride -= len;
                    out.push(Moved::Step(kind));
                }
            } else {
                self.stride = len * 0.5;
            }
        }
    }

    fn start_mantle(&mut self, to: Vec3, out: &mut Vec<Moved>) {
        let from = if self.crouched {
            self.body.pos + Vec3::Y * (STAND_HALF - CROUCH_HALF)
        } else {
            self.body.pos
        };
        self.crouched = false;
        self.slide = 0.0;
        self.sprinting = false;
        let h = (to.y - from.y).max(0.0);
        self.mantle = Some(Mantle {
            from,
            to,
            t: 0.0,
            dur: 0.26 + h * 0.0042,
        });
        self.body.vel = Vec3::ZERO;
        self.body.pos = from;
        self.prev = from;
        out.push(Moved::Mantle);
    }
}
