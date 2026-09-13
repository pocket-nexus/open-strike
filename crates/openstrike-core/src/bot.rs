//! Bots: T-side dummies with a small patrol/chase/attack brain.

use core::f32::consts::{FRAC_PI_2, PI, TAU};

use glam::{Mat4, Vec3};
use pocket3d_bsp::collide::{CharacterState, HullKind, MoveInput, MoveParams, step_character};
use pocket3d_bsp::trace::{Hull, MapCollision};

use crate::weapon::{EffectKind, Effects, Rng, WeaponKind};
use crate::{AnimPlayback, atan2f, sin_cos, sqrtf};

pub const BOT_HEALTH: i32 = 100;
pub const BOT_EYE: f32 = 20.0;
const SIGHT_RANGE: f32 = 2600.0;
const ATTACK_RANGE: f32 = 760.0;
const LOSE_SIGHT_AFTER: f32 = 4.0;

/// Bot tuning — owned by the `strike` surface (mods set it through
/// `strike.configureBots`). Defaults are the base game's difficulty.
#[derive(Clone, Debug)]
pub struct BotConfig {
    /// Enemy count per round.
    pub count: usize,
    pub speed: f32,
    /// Seconds between attack volleys (scaled ±25% per shot).
    pub attack_interval: f32,
    pub damage_min: i32,
    pub damage_max: i32,
}

impl Default for BotConfig {
    fn default() -> Self {
        Self {
            count: 3,
            speed: 190.0,
            attack_interval: 1.4,
            damage_min: 8,
            damage_max: 14,
        }
    }
}

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum BotState {
    Patrol,
    Chase,
    Attack,
    Dead,
}

pub struct Bot {
    pub state: CharacterState,
    pub prev_pos: Vec3,
    pub yaw: f32,
    pub health: i32,
    pub brain: BotState,
    pub anim: AnimPlayback,
    wander_yaw: f32,
    think_timer: f32,
    attack_timer: f32,
    lost_timer: f32,
    pub death_time: f32,
    pub weapon: WeaponKind,
    pub armor: i32,
    last_seen: Vec3,
    detour: Vec3,
    detour_left: f32,
}

pub struct BotShot {
    pub damage: i32,
}

impl Bot {
    pub fn spawn(pos: Vec3, yaw: f32) -> Self {
        Self {
            state: CharacterState::new(pos),
            prev_pos: pos,
            yaw,
            health: BOT_HEALTH,
            brain: BotState::Patrol,
            anim: AnimPlayback::default(),
            wander_yaw: yaw,
            think_timer: 0.0,
            attack_timer: 1.0,
            lost_timer: 0.0,
            death_time: 0.0,
            weapon: WeaponKind::Glock18,
            armor: 0,
            last_seen: pos,
            detour: pos,
            detour_left: 0.0,
        }
    }

    pub fn alive(&self) -> bool {
        self.brain != BotState::Dead
    }

    pub fn eye(&self) -> Vec3 {
        self.state.pos + Vec3::Y * BOT_EYE
    }

    pub fn hurt(&mut self, dmg: i32) -> bool {
        self.hurt_with_armor(dmg, 1.0)
    }

    pub fn hurt_with_armor(&mut self, dmg: i32, armor_ratio: f32) -> bool {
        if !self.alive() {
            return false;
        }
        let mut actual = dmg;
        if self.armor > 0 {
            let reduced = libm::roundf((dmg as f32) * armor_ratio) as i32;
            let armor_cost = libm::roundf(((dmg - reduced).max(0) as f32) * 0.5) as i32;
            if armor_cost <= self.armor {
                actual = reduced;
                self.armor -= armor_cost;
            } else {
                actual = (dmg - self.armor * 2).max(0);
                self.armor = 0;
            }
        }
        self.health -= actual;
        if self.health <= 0 {
            self.brain = BotState::Dead;
            self.death_time = 0.0;
            return true;
        }
        false
    }

    /// Tiny deterministic buy strategy: pistol opening, then SMG, then rifle
    /// and armor. It mirrors a conservative CS economy without per-bot heaps.
    pub fn buy_for_budget(&mut self, budget: i32) {
        let mut left = budget;
        self.weapon = if left >= 2700 {
            left -= 2700;
            WeaponKind::Ak47
        } else if left >= 1250 {
            left -= 1250;
            WeaponKind::Mp5Navy
        } else {
            WeaponKind::Glock18
        };
        self.armor = if left >= 650 { 100 } else { 0 };
    }

    fn yaw_towards(&mut self, target: Vec3, dt: f32, rate: f32) {
        let d = target - self.state.pos;
        let want = atan2f(-d.x, -d.z);
        let mut diff = want - self.yaw;
        while diff > PI {
            diff -= TAU;
        }
        while diff < -PI {
            diff += TAU;
        }
        let max = rate * dt;
        self.yaw += diff.clamp(-max, max);
    }

    /// Advance one tick. Returns a shot descriptor when the bot lands a hit
    /// on the player this tick.
    #[allow(clippy::too_many_arguments)]
    pub fn tick(
        &mut self,
        col: &MapCollision,
        player_eye: Vec3,
        player_alive: bool,
        dt: f32,
        cfg: &BotConfig,
        rng: &mut Rng,
        effects: &mut Effects,
    ) -> Option<BotShot> {
        self.prev_pos = self.state.pos;
        if self.brain == BotState::Dead {
            self.death_time += dt;
            self.anim.speed = 0.0;
            return None;
        }

        // Perception: distance + line of sight to the player's eye.
        let to_player = player_eye - self.eye();
        let dist = to_player.length();
        let visible = player_alive && dist < SIGHT_RANGE && {
            let tr = col.trace(Hull::Point, self.eye(), player_eye);
            tr.fraction >= 1.0
        };

        if visible {
            self.lost_timer = 0.0;
            self.last_seen = player_eye;
        } else {
            self.lost_timer += dt;
        }

        // Brain transitions.
        self.brain = match self.brain {
            BotState::Patrol if visible => BotState::Chase,
            BotState::Chase if visible && dist < ATTACK_RANGE => BotState::Attack,
            BotState::Chase if self.lost_timer > LOSE_SIGHT_AFTER => BotState::Patrol,
            BotState::Attack if !visible || dist > ATTACK_RANGE * 1.25 => {
                if self.lost_timer > LOSE_SIGHT_AFTER {
                    BotState::Patrol
                } else {
                    BotState::Chase
                }
            }
            s => s,
        };

        let mut shot = None;
        let mut wish = Vec3::ZERO;
        let mut speed = 0.0;

        match self.brain {
            BotState::Patrol => {
                self.think_timer -= dt;
                let (sy, cy) = sin_cos(self.wander_yaw);
                let fwd = Vec3::new(-sy, 0.0, -cy);
                // Re-pick direction when the timer expires or a wall is close.
                let probe = col.trace(Hull::Stand, self.state.pos, self.state.pos + fwd * 56.0);
                if self.think_timer <= 0.0 || probe.fraction < 1.0 {
                    self.wander_yaw = rng.range(0.0, TAU);
                    self.think_timer = rng.range(1.5, 4.0);
                }
                let (sy, cy) = sin_cos(self.wander_yaw);
                let fwd = Vec3::new(-sy, 0.0, -cy);
                wish = fwd;
                speed = 0.55;
                self.yaw_towards(self.state.pos + fwd * 100.0, dt, 4.0);
            }
            BotState::Chase => {
                let target = if visible { player_eye } else { self.last_seen };
                let mut dir = Vec3::new(
                    target.x - self.state.pos.x,
                    0.0,
                    target.z - self.state.pos.z,
                ).normalize_or_zero();
                // A dynamic micro-waypoint gets around nearby corners until
                // cooked map waypoints are available. Two hull probes choose
                // the clearer side and the choice is held to prevent jitter.
                let blocked = col.trace(
                    Hull::Stand,
                    self.state.pos,
                    self.state.pos + dir * 72.0,
                ).fraction < 1.0;
                self.detour_left -= dt;
                if blocked && self.detour_left <= 0.0 {
                    let side = Vec3::new(-dir.z, 0.0, dir.x);
                    let lp = col.trace(Hull::Stand, self.state.pos, self.state.pos + side * 96.0);
                    let rp = col.trace(Hull::Stand, self.state.pos, self.state.pos - side * 96.0);
                    let chosen = if lp.fraction >= rp.fraction { side } else { -side };
                    self.detour = self.state.pos + chosen * 112.0 + dir * 64.0;
                    self.detour_left = 0.75;
                }
                if self.detour_left > 0.0 {
                    dir = Vec3::new(
                        self.detour.x - self.state.pos.x,
                        0.0,
                        self.detour.z - self.state.pos.z,
                    ).normalize_or_zero();
                }
                wish = dir;
                speed = 1.0;
                self.yaw_towards(target, dt, 9.0);
            }
            BotState::Attack => {
                self.yaw_towards(player_eye, dt, 9.0);
                self.attack_timer -= dt;
                if self.attack_timer <= 0.0 && visible {
                    self.attack_timer = cfg.attack_interval * rng.range(0.85, 1.25);
                    // Muzzle flash + tracer from the bot towards the player.
                    let from = self.eye() + Vec3::Y * 4.0;
                    let skill = match self.weapon {
                        WeaponKind::Pistol => 0.0,
                        WeaponKind::Smg => 0.08,
                        WeaponKind::Rifle => 0.16,
                        _ => 0.12,
                    };
                    let miss = rng.f32() > (1.30 - dist / 1200.0 + skill).clamp(0.35, 0.92);
                    let aim = if miss {
                        player_eye
                            + Vec3::new(rng.signed(), rng.signed() * 0.4, rng.signed()) * 45.0
                    } else {
                        player_eye
                    };
                    effects.spawn(EffectKind::MuzzleFlash { pos: from }, 0.08);
                    effects.spawn(EffectKind::Tracer { a: from, b: aim }, 0.09);
                    if !miss {
                        let span = (cfg.damage_max - cfg.damage_min).max(0) as f32;
                        let bonus = match self.weapon {
                            WeaponKind::Pistol => 0,
                            WeaponKind::Smg => 2,
                            WeaponKind::Rifle => 5,
                            _ => 4,
                        };
                        shot = Some(BotShot {
                            damage: cfg.damage_min
                                + bonus
                                + (rng.f32() * (span + 1.0)) as i32,
                        });
                    }
                }
            }
            BotState::Dead => {}
        }

        let input = MoveInput {
            wish_dir: wish,
            speed,
            jump: false,
        };
        step_character(
            col,
            HullKind::Stand,
            &mut self.state,
            &MoveParams {
                max_speed: cfg.speed,
                ..Default::default()
            },
            &input,
            dt,
        );

        // Animation: walk speed scales the clip; idle freezes it.
        let ground_speed =
            sqrtf(self.state.vel.x * self.state.vel.x + self.state.vel.z * self.state.vel.z);
        if ground_speed > 12.0 {
            self.anim.speed = (ground_speed / 90.0).clamp(0.6, 2.2);
        } else {
            self.anim.speed = 0.0;
        }
        self.anim.advance(dt);
        shot
    }

    /// World transform, including the death fall. `scale` maps the model's
    /// native height to the 70-unit game height (desktop passes
    /// `70.0 / asset.height()`).
    pub fn transform_scaled(&self, scale: f32) -> Mat4 {
        let feet = self.state.pos - Vec3::Y * 36.0;
        let fall = (self.death_time * 3.0).min(1.0);
        // Ease-out fall backwards, slight sink so the corpse hugs the ground.
        let ease = 1.0 - (1.0 - fall) * (1.0 - fall);
        Mat4::from_translation(feet + Vec3::Y * (2.0 - 2.0 * ease))
            * Mat4::from_rotation_y(self.yaw)
            * Mat4::from_rotation_x(-ease * FRAC_PI_2 * 0.94)
            * Mat4::from_scale(Vec3::splat(scale))
    }

    pub fn tint(&self) -> [f32; 4] {
        // The soldier ships real materials — no warm tint on the living.
        if self.alive() {
            [1.0, 1.0, 1.0, 1.0]
        } else {
            [0.5, 0.42, 0.4, 1.0]
        }
    }
}
