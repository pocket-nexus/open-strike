//! One actor's hands on its weapons: the trigger, recoil and spread, reloads, the swap, the sights, grenades, the
//! melee strike. `Arms::tick` advances it and says what happened (`Cue`s for sound and animation, a `Shot` to resolve).
use crate::util::{Rng, approach, damp};
use crate::weapons::{Class, SIDE_PATTERN, WeaponDef, rise_pattern};
use glam::Vec2;

pub const GRENADES: u32 = 2;
/// The grenade leaves the hand this long after the pin; the hand is back on the gun at `THROW_TIME`.
pub const THROW_RELEASE: f32 = 0.32;
pub const THROW_TIME: f32 = 0.75;
pub const MELEE_STRIKE: f32 = 0.13;
pub const MELEE_TIME: f32 = 0.55;

#[derive(Clone, Debug)]
pub struct Slot {
    pub def: &'static WeaponDef,
    pub mag: u32,
    pub reserve: u32,
}

impl Slot {
    pub fn new(def: &'static WeaponDef) -> Slot {
        Slot {
            def,
            mag: def.mag,
            reserve: def.reserve,
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub struct Reload {
    pub t: f32,
    pub dur: f32,
    /// From an empty gun: the bolt is racked at the end.
    pub empty: bool,
    /// The rounds are in.
    pub fed: bool,
    /// Sound cues given so far (bits: out, in, rack).
    pub cues: u8,
    /// Shotgun: shells still to load (0 for magazines).
    pub shells: u32,
}

/// The weapon change: the gun goes down (`lower`), the other comes up (its `draw`).
#[derive(Clone, Copy, Debug)]
pub struct Swap {
    pub t: f32,
    pub lower: f32,
    pub done: bool,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Cue {
    Shot,
    DryFire,
    MagOut,
    MagIn,
    BoltRack,
    ShellInsert,
    Swap,
    AdsIn,
    AdsOut,
    NadePin,
    NadeRelease,
    MeleeSwing,
    MeleeStrike,
}

/// What the actor asks of its hands this tick.
#[derive(Clone, Copy, Default, Debug)]
pub struct Ask {
    pub fire: bool,
    pub ads: bool,
    pub reload: bool,
    pub swap: bool,
    pub nade: bool,
    pub melee: bool,
    pub sprinting: bool,
    pub airborne: bool,
    pub crouched: bool,
    pub sliding: bool,
    /// Horizontal speed, units/s.
    pub speed: f32,
}

/// A shot to resolve: pellets within a cone (half angle, radians) around the view plus the kick.
#[derive(Clone, Copy, Debug)]
pub struct Shot {
    pub def: &'static WeaponDef,
    pub pellets: u32,
    pub spread: f32,
    pub pattern: f32,
    /// The magazine's last round.
    pub last: bool,
}

#[derive(Clone, Debug)]
pub struct Arms {
    pub slots: [Slot; 2],
    pub cur: usize,
    pub cooldown: f32,
    pub reload: Option<Reload>,
    pub swap: Option<Swap>,
    /// Remaining time of the draw.
    pub draw: f32,
    /// 0 hip .. 1 through the sights.
    pub ads: f32,
    /// Spread added by firing (radians).
    pub bloom: f32,
    /// The view's kick: (up, left) radians now, and where the last shots push it.
    pub recoil: Vec2,
    pub recoil_goal: Vec2,
    /// Shots in the current spray, and seconds since the last.
    pub spray: u32,
    pub since_shot: f32,
    trigger_up: bool,
    sprint_block: f32,
    pub nades: u32,
    pub throw: Option<f32>,
    pub melee: Option<f32>,
    melee_cd: f32,
    /// A reload asked for while busy (applied when free).
    want_reload: bool,
}

impl Arms {
    pub fn new(primary: &'static WeaponDef, secondary: &'static WeaponDef) -> Arms {
        Arms {
            slots: [Slot::new(primary), Slot::new(secondary)],
            cur: 0,
            cooldown: 0.0,
            reload: None,
            swap: None,
            draw: primary.draw,
            ads: 0.0,
            bloom: 0.0,
            recoil: Vec2::ZERO,
            recoil_goal: Vec2::ZERO,
            spray: 0,
            since_shot: 10.0,
            trigger_up: true,
            sprint_block: 0.0,
            nades: GRENADES,
            throw: None,
            melee: None,
            melee_cd: 0.0,
            want_reload: false,
        }
    }

    pub fn def(&self) -> &'static WeaponDef {
        self.slots[self.cur].def
    }

    pub fn slot(&self) -> &Slot {
        &self.slots[self.cur]
    }

    /// Busy with something that keeps the gun from firing or aiming.
    pub fn busy(&self) -> bool {
        self.reload.is_some()
            || self.swap.is_some()
            || self.draw > 0.0
            || self.throw.is_some()
            || self.melee.is_some()
    }

    /// 0..1 of the reload (HUD).
    pub fn reload_frac(&self) -> f32 {
        self.reload.map_or(0.0, |r| (r.t / r.dur).clamp(0.0, 1.0))
    }

    /// The cone half angle (radians) of a shot now.
    pub fn spread(&self, a: &Ask) -> f32 {
        let d = self.def();
        let k = self.ads * self.ads;
        let base = d.hip + (d.ads - d.hip) * k;
        let moving = (a.speed / 300.0).clamp(0.0, 1.0) * d.move_spread * (1.0 - 0.75 * k);
        let air = if a.airborne {
            3.0 * (1.0 - 0.5 * k)
        } else {
            0.0
        };
        let stance = if a.sliding {
            1.25
        } else if a.crouched {
            0.78
        } else {
            1.0
        };
        ((base + moving + air) * stance).to_radians() + self.bloom * (1.0 - 0.6 * k)
    }

    fn start_reload(&mut self) {
        let s = &self.slots[self.cur];
        let d = s.def;
        if s.mag >= d.mag || s.reserve == 0 || self.reload.is_some() {
            return;
        }
        let empty = s.mag == 0;
        self.reload = Some(match d.shell {
            // Shells: a lift, then one per `shell` seconds, then the gun comes back (0.35 s each end).
            Some(per) => {
                let shells = (d.mag - s.mag).min(s.reserve);
                Reload {
                    t: 0.0,
                    dur: 0.35 + per * shells as f32 + 0.35 + if empty { 0.3 } else { 0.0 },
                    empty,
                    fed: false,
                    cues: 0,
                    shells,
                }
            }
            None => Reload {
                t: 0.0,
                dur: if empty { d.reload_empty } else { d.reload },
                empty,
                fed: false,
                cues: 0,
                shells: 0,
            },
        });
    }

    pub fn tick(&mut self, dt: f32, a: &Ask, rng: &mut Rng, cues: &mut Vec<Cue>) -> Option<Shot> {
        let d = self.def();
        // (Down to a tick below zero: the next shot starts from there, so the rate is the weapon's, not the tick's.)
        self.cooldown = (self.cooldown - dt).max(-dt);
        self.draw = (self.draw - dt).max(0.0);
        self.melee_cd = (self.melee_cd - dt).max(0.0);
        self.since_shot += dt;
        if a.sprinting {
            self.sprint_block = d.sprint_out;
        } else {
            self.sprint_block = (self.sprint_block - dt).max(0.0);
        }
        if !a.fire {
            self.trigger_up = true;
        }

        // Recoil: the view chases the kick fast, and the kick eases back once the gun rests.
        self.recoil += (self.recoil_goal - self.recoil) * damp(38.0, dt);
        if self.since_shot > d.interval() + 0.05 {
            self.recoil_goal *= 1.0 - damp(7.5, dt);
            self.spray = 0;
        }
        if self.since_shot > 0.1 {
            self.bloom = (self.bloom - (d.bloom_max.to_radians() / 0.45) * dt).max(0.0);
        }

        // Melee.
        if let Some(t) = &mut self.melee {
            let before = *t;
            *t += dt;
            if before < MELEE_STRIKE && *t >= MELEE_STRIKE {
                cues.push(Cue::MeleeStrike);
            }
            if *t >= MELEE_TIME {
                self.melee = None;
            }
        } else if a.melee && self.melee_cd <= 0.0 && self.throw.is_none() && self.swap.is_none() {
            self.melee = Some(0.0);
            self.melee_cd = MELEE_TIME + 0.15;
            self.reload = None;
            cues.push(Cue::MeleeSwing);
        }

        // Grenade.
        if let Some(t) = &mut self.throw {
            let before = *t;
            *t += dt;
            if before < THROW_RELEASE && *t >= THROW_RELEASE {
                cues.push(Cue::NadeRelease);
            }
            if *t >= THROW_TIME {
                self.throw = None;
            }
        } else if a.nade && self.nades > 0 && self.melee.is_none() && self.swap.is_none() {
            self.nades -= 1;
            self.throw = Some(0.0);
            self.reload = None;
            cues.push(Cue::NadePin);
        }

        // Swap.
        if let Some(sw) = &mut self.swap {
            sw.t += dt;
            if !sw.done && sw.t >= sw.lower {
                sw.done = true;
                self.cur = 1 - self.cur;
                self.draw = self.slots[self.cur].def.draw;
                self.swap = None;
                self.bloom = 0.0;
                self.spray = 0;
            }
        } else if a.swap && self.throw.is_none() && self.melee.is_none() {
            self.reload = None;
            self.swap = Some(Swap {
                t: 0.0,
                lower: (d.draw * 0.55).max(0.14),
                done: false,
            });
            cues.push(Cue::Swap);
        }
        let d = self.def();

        // Reload.
        if a.reload {
            self.want_reload = true;
        }
        if self.slots[self.cur].mag == 0
            && self.slots[self.cur].reserve > 0
            && self.since_shot > 0.12
        {
            self.want_reload = true;
        }
        if self.want_reload && !self.busy() {
            self.want_reload = false;
            self.start_reload();
        } else if self.want_reload && (self.reload.is_some() || self.slots[self.cur].mag >= d.mag) {
            self.want_reload = false;
        }
        if let Some(mut r) = self.reload {
            r.t += dt;
            let s = &mut self.slots[self.cur];
            if let Some(per) = d.shell {
                // Shell k goes in at 0.35 + (k + 0.6) * per.
                let loaded =
                    (((r.t - 0.35) / per - 0.6).floor() + 1.0).clamp(0.0, r.shells as f32) as u32;
                let had = r.cues as u32;
                if loaded > had {
                    r.cues = had as u8 + 1;
                    s.mag += 1;
                    s.reserve -= 1;
                    cues.push(Cue::ShellInsert);
                }
                let all_in = r.cues as u32 >= r.shells;
                if all_in && r.empty && !r.fed && r.t >= 0.35 + per * r.shells as f32 + 0.25 {
                    r.fed = true;
                    cues.push(Cue::BoltRack);
                }
                // The trigger ends a shell reload once a shell is in.
                let cut = a.fire && self.trigger_up && s.mag > 0 && r.t > 0.35 + per * 0.7;
                self.reload = if r.t >= r.dur || cut { None } else { Some(r) };
                if cut {
                    self.cooldown = self.cooldown.max(0.25);
                }
            } else {
                let k = r.t / r.dur;
                let (out_at, in_at, rack_at) = if r.empty {
                    (0.16, 0.56, 0.82)
                } else {
                    (0.2, 0.68, 2.0)
                };
                if r.cues & 1 == 0 && k >= out_at {
                    r.cues |= 1;
                    cues.push(Cue::MagOut);
                }
                if r.cues & 2 == 0 && k >= in_at {
                    r.cues |= 2;
                    cues.push(Cue::MagIn);
                    let take = (d.mag - s.mag).min(s.reserve);
                    s.mag += take;
                    s.reserve -= take;
                    r.fed = true;
                }
                if r.cues & 4 == 0 && k >= rack_at {
                    r.cues |= 4;
                    cues.push(Cue::BoltRack);
                }
                self.reload = if r.t >= r.dur { None } else { Some(r) };
            }
        }

        // The sights.
        let can_ads = a.ads
            && !a.sprinting
            && self.swap.is_none()
            && self.draw <= 0.0
            && self.throw.is_none()
            && self.melee.is_none()
            && self.reload.is_none();
        let before = self.ads;
        self.ads = approach(self.ads, if can_ads { 1.0 } else { 0.0 }, dt / d.ads_time);
        if before == 0.0 && self.ads > 0.0 {
            cues.push(Cue::AdsIn);
        } else if before == 1.0 && self.ads < 1.0 {
            cues.push(Cue::AdsOut);
        }

        // The trigger.
        if !a.fire || self.busy() || self.cooldown > 1e-4 || self.sprint_block > 0.0 || a.sprinting
        {
            return None;
        }
        if !d.auto && !self.trigger_up {
            return None;
        }
        self.trigger_up = false;
        let spread = self.spread(a);
        let s = &mut self.slots[self.cur];
        if s.mag == 0 {
            if s.reserve == 0 {
                cues.push(Cue::DryFire);
                self.cooldown = 0.25;
            }
            return None;
        }
        let shot = Shot {
            def: d,
            pellets: d.pellets,
            spread,
            pattern: d.pattern.to_radians(),
            last: s.mag == 1,
        };
        s.mag -= 1;
        self.cooldown = self.cooldown.min(0.0) + d.interval();
        // Kick: up by the spray's rise, sideways along the pattern plus chance; the sights and a crouch tame it.
        let hold = (1.0 + (d.ads_kick - 1.0) * self.ads) * if a.crouched { 0.85 } else { 1.0 };
        let up = d.kick * rise_pattern(self.spray) * (1.0 + 0.12 * rng.s());
        let side = d.kick_side * SIDE_PATTERN[self.spray as usize % SIDE_PATTERN.len()]
            + d.kick_rand * rng.s();
        self.recoil_goal += Vec2::new(up, side) * hold * std::f32::consts::PI / 180.0;
        let max = if d.class == Class::Shotgun || d.class == Class::Marksman {
            0.2
        } else {
            0.15
        };
        self.recoil_goal.x = self.recoil_goal.x.min(max);
        self.recoil_goal.y = self.recoil_goal.y.clamp(-0.07, 0.07);
        self.bloom = (self.bloom + d.bloom.to_radians()).min(d.bloom_max.to_radians());
        self.spray += 1;
        self.since_shot = 0.0;
        cues.push(Cue::Shot);
        Some(shot)
    }
}
