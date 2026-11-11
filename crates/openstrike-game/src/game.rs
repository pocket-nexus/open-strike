//! The game: actors, bots, grenades and the match advanced at a fixed 60 Hz tick; what happened (`Event`s, for the
//! speakers and the HUD), what the screen shows (`Frame`), and the HUD's numbers.
use crate::actor::{Actor, Input, Moved};
use crate::ai::{Brain, Senses, Skill};
use crate::arms::{Ask, Cue, Shot};
use crate::combat::{BLAST_DAMAGE, BLAST_RADIUS, FUSE, Grenade, Zone, hit_actor, sight_points};
use crate::nav::Nav;
use crate::rig::{Puppet, Rig};
use crate::rules::{Feed, MatchConfig, Mode, Phase, RESPAWN, ROUND_END, Rules, WARMUP};
use crate::util::{Rng, angle_diff, dir_angles, flat, view_dir, view_quat, yaw_dir, yaw_right};
use crate::view::{Fx, View, WeaponMeta};
use crate::weapons::{Class, LOADOUTS, PISTOL, PRIMARIES, WeaponDef};
use crate::world::{Map, UNIT};
use glam::{Quat, Vec2, Vec3};
use serde_json::{Value, json};
use std::sync::Arc;

pub const TICK: f32 = 1.0 / 60.0;
const NAMES: [[&str; 5]; 2] = [
    ["You", "Ghost", "Viper", "Nomad", "Raven"],
    ["Jackal", "Cobra", "Wraith", "Reaper", "Hydra"],
];

/// The player's controls for a frame. Pressed fields are edges (latched until a tick takes them).
#[derive(Clone, Copy, Default, Debug)]
pub struct PlayerInput {
    pub mv: Vec2,
    pub fire: bool,
    pub ads: bool,
    pub sprint: bool,
    pub jump: bool,
    pub crouch: bool,
    pub reload: bool,
    pub swap: bool,
    pub nade: bool,
    pub melee: bool,
}

/// What happened, for the speakers and the HUD. Positions in GoldSrc units.
#[derive(Clone, Debug)]
pub enum Event {
    Shot {
        actor: usize,
        weapon: &'static str,
        pos: Vec3,
    },
    Impact {
        pos: Vec3,
        normal: Vec3,
        flesh: bool,
    },
    Cue {
        actor: usize,
        cue: Cue,
        pos: Vec3,
    },
    Moved {
        actor: usize,
        what: Moved,
        pos: Vec3,
    },
    /// Damage dealt: `fatal` kills. The player is `attacker` (a hit marker) or `victim` (a hurt cue from `from`).
    Hit {
        victim: usize,
        attacker: Option<usize>,
        zone: Zone,
        amount: f32,
        fatal: bool,
        from: Vec3,
    },
    Kill {
        victim: usize,
        attacker: Option<usize>,
        headshot: bool,
    },
    Whiz {
        pos: Vec3,
    },
    NadeBounce {
        pos: Vec3,
    },
    Explosion {
        pos: Vec3,
    },
    CasingLand {
        pos: Vec3,
    },
    Medal,
    Respawn {
        actor: usize,
    },
    Count(u32),
    Go,
    Lead {
        ours: bool,
    },
    RoundOver {
        won: Option<bool>,
    },
    MatchOver {
        won: Option<bool>,
    },
}

/// One soldier on screen.
#[derive(Clone, Debug, Default)]
pub struct ActorFrame {
    pub shown: bool,
    pub team: usize,
    /// Feet (metres), facing.
    pub pos: [f32; 3],
    pub yaw: f32,
    /// The rig's pose: per posed node (node index, translation, rotation), packed 8 floats each. Empty: the rest pose.
    pub pose: Vec<f32>,
    pub weapon: &'static str,
    /// The carried weapon's place (metres).
    pub weapon_pos: [f32; 3],
    pub weapon_rot: [f32; 4],
}

/// What the screen shows this frame (metres).
#[derive(Clone, Debug, Default)]
pub struct Frame {
    pub eye: [f32; 3],
    /// The camera's rotation (it looks along -Z).
    pub rot: [f32; 4],
    /// Vertical field of view, degrees.
    pub fov: f32,
    pub actors: Vec<ActorFrame>,
    pub fx: crate::view::FxFrame,
    pub vm: Option<crate::view::ViewModel>,
}

pub struct Game {
    pub map: Arc<Map>,
    pub nav: Arc<Nav>,
    pub rules: Rules,
    pub actors: Vec<Actor>,
    pub(crate) brains: Vec<Option<Brain>>,
    puppets: Vec<Puppet>,
    rig: Option<Arc<Rig>>,
    pub grenades: Vec<Grenade>,
    pub events: Vec<Event>,
    pub view: View,
    pub fx: Fx,
    rng: Rng,
    pub time: f32,
    acc: f32,
    latched: PlayerInput,
    intel: f32,
    /// The player's last hit marker: (seconds ago, head, kill), and recent damage taken: (from, seconds ago, amount).
    hit_mark: (f32, bool, bool),
    hurts: Vec<(Vec3, f32, f32)>,
    killer: Option<(usize, f32)>,
    /// Scaled time (the last kill of a match plays slow).
    pub time_scale: f32,
    pub(crate) staged: Option<crate::stage::Stage>,
}

impl Game {
    pub fn new(
        map: Arc<Map>,
        nav: Arc<Nav>,
        cfg: MatchConfig,
        rig: Option<Arc<Rig>>,
        meta: &WeaponMeta,
    ) -> Game {
        let mut rng = Rng::new(cfg.seed);
        let squad = cfg.squad.clamp(1, 5);
        let mut actors = vec![];
        let mut brains = vec![];
        for team in 0..2 {
            for k in 0..squad {
                let bot = !(team == 0 && k == 0);
                let primary: &'static WeaponDef = if bot {
                    let r = rng.f();
                    PRIMARIES[if r < 0.46 {
                        0
                    } else if r < 0.76 {
                        1
                    } else if r < 0.88 {
                        2
                    } else {
                        3
                    }]
                } else {
                    LOADOUTS[cfg.loadout.min(LOADOUTS.len() - 1)].primary
                };
                actors.push(Actor::new(NAMES[team][k], team, bot, primary, &PISTOL));
                brains.push(None);
            }
        }
        let n = actors.len();
        for (i, a) in actors.iter().enumerate() {
            if a.bot {
                brains[i] = Some(Brain::new(Skill::of(cfg.difficulty, &mut rng), n, &mut rng));
            }
        }
        let puppets = (0..n).map(|_| Puppet::new(rig.as_deref())).collect();
        let mut g = Game {
            map,
            nav,
            rules: Rules::new(cfg),
            actors,
            brains,
            puppets,
            rig,
            grenades: vec![],
            events: vec![],
            view: View::new(meta.clone()),
            fx: Fx::new(meta.clone()),
            rng,
            time: 0.0,
            acc: 0.0,
            latched: PlayerInput::default(),
            intel: 0.0,
            hit_mark: (10.0, false, false),
            hurts: vec![],
            killer: None,
            time_scale: 1.0,
            staged: None,
        };
        g.deploy_all();
        let (title, sub) = match cfg.mode {
            Mode::Tdm => (
                "TEAM DEATHMATCH",
                format!("First to {} eliminations", cfg.limit()),
            ),
            Mode::Elimination => (
                "ELIMINATION",
                format!("No respawns · first to {} rounds", cfg.limit()),
            ),
        };
        g.rules.say(title, &sub, "info", WARMUP + 1.2);
        g
    }

    pub fn player(&self) -> &Actor {
        &self.actors[0]
    }

    /// A bot's hands on the player's seat (demos, tests): it plays, the screen stays first person.
    pub fn set_autopilot(&mut self, on: bool) {
        let n = self.actors.len();
        self.brains[0] = on.then(|| {
            let mut b = Brain::new(
                Skill::of(self.rules.cfg.difficulty, &mut self.rng),
                n,
                &mut self.rng,
            );
            b.respawn(self.actors[0].yaw);
            b
        });
    }

    /// Everyone to their side's spawn points, alive.
    fn deploy_all(&mut self) {
        self.grenades.clear();
        let mut used = [0usize; 2];
        for i in 0..self.actors.len() {
            let team = self.actors[i].team;
            let list = &self.map.spawns[team];
            let s = list[used[team] % list.len()];
            used[team] += 1;
            self.place(i, s.pos, s.yaw);
        }
    }

    fn place(&mut self, i: usize, pos: Vec3, yaw: f32) {
        self.actors[i].spawn(pos, yaw);
        if let Some(b) = &mut self.brains[i] {
            b.respawn(yaw);
        }
        self.puppets[i].revive();
        if i == 0 {
            self.view.reset();
            self.killer = None;
            self.hurts.clear();
        }
    }

    /// A place to come back at: a spawn point far from the enemy and out of its sight, the own side's preferred.
    fn respawn(&mut self, i: usize) {
        let team = self.actors[i].team;
        let mut best: Option<(f32, Vec3, f32)> = None;
        for (side, list) in self.map.spawns.iter().enumerate() {
            for s in list {
                let head = s.pos + Vec3::Y * 28.0;
                let mut near = 4000.0f32;
                let mut seen = false;
                for (j, o) in self.actors.iter().enumerate() {
                    if j == i || !o.alive {
                        continue;
                    }
                    let d = (o.body.pos - s.pos).length();
                    if o.team != team {
                        near = near.min(d);
                        seen |= d < 2600.0 && self.map.los(o.eye(), head);
                    } else if d < 40.0 {
                        near = 0.0;
                    }
                }
                let score = near.min(2400.0) - if seen { 1800.0 } else { 0.0 }
                    + if side == team { 500.0 } else { 0.0 }
                    + self.rng.f() * 240.0;
                if best.is_none_or(|(b, _, _)| score > b) {
                    best = Some((score, s.pos, s.yaw));
                }
            }
        }
        if let Some((_, pos, yaw)) = best {
            self.place(i, pos, yaw);
            self.events.push(Event::Respawn { actor: i });
        }
    }

    /// Turns the player's view (radians: left, up), every frame; `assist` (0..1) is a controller's aim assist.
    pub fn look(&mut self, yaw: f32, pitch: f32, assist: f32, dt: f32) {
        if !self.actors[0].alive || self.rules.over().is_some() {
            return;
        }
        // Through the sights the same hand movement covers the same part of the picture.
        let zoom = (self.view.camera().fov / crate::view::FOV).clamp(0.2, 1.0);
        let (mut yaw, mut pitch) = (yaw * zoom, pitch * zoom);
        if self.brains[0].is_some() {
            return;
        }
        if assist > 0.0 {
            let (slow, pull) = self.assist(assist, dt);
            yaw = yaw * slow + pull.0;
            pitch = pitch * slow + pull.1;
        }
        let a = &mut self.actors[0];
        a.yaw += yaw;
        a.pitch = (a.pitch + pitch).clamp(-1.45, 1.45);
        self.view.turned(yaw, pitch);
    }

    /// Aim assist: near an enemy the stick slows (friction), and while the player moves or aims the view follows the
    /// target a little (the slowdown factor, the pull in radians).
    fn assist(&self, k: f32, dt: f32) -> (f32, (f32, f32)) {
        let a = &self.actors[0];
        let eye = a.eye();
        let (vy, vp) = a.aim();
        let fwd = view_dir(vy, vp);
        let mut best: Option<(f32, Vec3, f32, Vec3)> = None;
        for o in self.actors.iter().filter(|o| o.team != a.team && o.alive) {
            let p = sight_points(o)[1] + Vec3::Y * 6.0;
            let to = p - eye;
            let dist = to.length();
            if !(40.0..2600.0).contains(&dist) {
                continue;
            }
            let ang = (to / dist).dot(fwd).clamp(-1.0, 1.0).acos();
            // The cone: a body's width at that distance plus a margin.
            let cone = (26.0 / dist).atan() + 0.045;
            if ang < cone && best.is_none_or(|(b, ..)| ang < b) && self.map.los(eye, p) {
                best = Some((ang, to / dist, cone, o.body.vel));
            }
        }
        let Some((ang, dir, cone, vel)) = best else {
            return (1.0, (0.0, 0.0));
        };
        let closeness = 1.0 - (ang / cone).clamp(0.0, 1.0);
        let slow = 1.0 - 0.5 * k * closeness.sqrt();
        // Follow the target's motion across the view (not onto it): tracking, not snapping.
        let (ty, tp) = dir_angles(dir);
        let engaged = a.arms.ads > 0.3
            || a.arms.since_shot < 0.3
            || a.speed() > 60.0
            || flat(vel).length() > 60.0;
        let rate = if engaged { 1.6 * k * closeness } else { 0.0 };
        let step = (rate * dt).min(1.0);
        (slow, (angle_diff(ty, vy) * step, (tp - vp) * step))
    }

    /// Advances the game by `dt` seconds of wall time.
    pub fn update(&mut self, dt: f32, input: &PlayerInput) {
        let l = &mut self.latched;
        l.mv = input.mv;
        l.fire = input.fire;
        l.ads = input.ads;
        l.sprint = input.sprint;
        l.jump |= input.jump;
        l.crouch |= input.crouch;
        l.reload |= input.reload;
        l.swap |= input.swap;
        l.nade |= input.nade;
        l.melee |= input.melee;
        // The winning kill plays slow for a moment.
        self.time_scale = match self.rules.phase {
            Phase::Over(_, t) if t < 1.6 => 0.3,
            _ => 1.0,
        };
        let real = dt.min(0.1);
        self.acc += real * self.time_scale;
        while self.acc >= TICK {
            self.acc -= TICK;
            self.tick(TICK);
            let l = &mut self.latched;
            (l.jump, l.crouch, l.reload, l.swap, l.nade, l.melee) =
                (false, false, false, false, false, false);
        }
        self.rules.age(real);
        self.hit_mark.0 += real;
        for h in &mut self.hurts {
            h.1 += real;
        }
        self.hurts.retain(|h| h.1 < 1.6);
        if let Some(k) = &mut self.killer {
            k.1 += real;
        }
        // The screen's side: the first-person view, the bodies, the effects.
        let alpha = (self.acc / TICK).clamp(0.0, 1.0);
        let sdt = real * self.time_scale;
        // Dead with no respawn coming: the camera goes to a living teammate.
        let watch = (!self.actors[0].alive && self.actors[0].respawn_in.is_none())
            .then(|| {
                self.actors
                    .iter()
                    .skip(1)
                    .find(|a| a.team == self.actors[0].team && a.alive)
            })
            .flatten();
        self.view.update(
            sdt,
            &self.actors[0],
            &self.map,
            alpha,
            self.killer.map(|k| &self.actors[k.0]),
            &self.puppets[0],
            watch,
        );
        for i in 0..self.actors.len() {
            let aim = match (&self.brains[i], self.stage_aiming()) {
                (_, Some(a)) => a || i == 0,
                (Some(b), _) => b.target.is_some(),
                (None, _) => true,
            };
            self.puppets[i].update(
                self.rig.as_deref(),
                &self.actors[i],
                &self.map,
                sdt,
                alpha,
                aim,
                &self.view.meta,
            );
        }
        self.fx.update(sdt, &self.map, &mut self.events);
    }

    fn alpha(&self) -> f32 {
        (self.acc / TICK).clamp(0.0, 1.0)
    }

    fn tick(&mut self, dt: f32) {
        self.time += dt;
        // The match's phases.
        match self.rules.phase {
            Phase::Warmup(t) => {
                let n = t - dt;
                if n.ceil() < t.ceil() && n > 0.0 && n < 3.0 {
                    self.events.push(Event::Count(n.ceil() as u32));
                }
                if n <= 0.0 {
                    self.rules.phase = Phase::Live;
                    self.events.push(Event::Go);
                } else {
                    self.rules.phase = Phase::Warmup(n);
                }
            }
            Phase::Live => {
                self.rules.clock -= dt;
                if self.rules.clock <= 0.0 {
                    self.rules.clock = 0.0;
                    self.time_up();
                }
            }
            Phase::RoundEnd(w, t) => {
                if t - dt <= 0.0 {
                    self.rules.round += 1;
                    self.rules.clock = self.rules.cfg.time();
                    self.rules.phase = Phase::Warmup(WARMUP);
                    self.deploy_all();
                    let r = self.rules.round;
                    self.rules.say(&format!("ROUND {r}"), "", "info", WARMUP);
                } else {
                    self.rules.phase = Phase::RoundEnd(w, t - dt);
                }
            }
            Phase::Over(w, t) => self.rules.phase = Phase::Over(w, t + dt),
        }
        let live = self.rules.live();
        let acting = live || matches!(self.rules.phase, Phase::RoundEnd(..));
        let over = self.rules.over().is_some();

        // What everyone wants.
        let n = self.actors.len();
        let mut inputs = vec![Input::default(); n];
        {
            let senses = Senses {
                map: &self.map,
                nav: &self.nav,
                actors: &self.actors,
                grenades: &self.grenades,
                time: self.time,
                live: acting && !over,
            };
            for i in 0..n {
                if !self.actors[i].alive {
                    continue;
                }
                match &mut self.brains[i] {
                    Some(b) => inputs[i] = b.think(i, &senses, dt, &mut self.rng),
                    None => {
                        let l = &self.latched;
                        inputs[i] = Input {
                            mv: l.mv,
                            fire: l.fire,
                            ads: l.ads,
                            sprint: l.sprint,
                            jump: l.jump,
                            crouch: l.crouch,
                            stance: None,
                            reload: l.reload,
                            swap: l.swap,
                            nade: l.nade,
                            melee: l.melee,
                        };
                    }
                }
                if !acting || over {
                    inputs[i] = Input::default();
                }
            }
        }
        if self.staged.is_some() {
            for i in 0..n {
                if self.actors[i].alive {
                    inputs[i] = self.stage_input(i, dt);
                }
            }
            self.stage_tick();
        }
        for i in 0..n {
            if let Some(b) = &self.brains[i] {
                if self.actors[i].alive {
                    if i == 0 {
                        self.view.turned(
                            crate::util::angle_diff(b.yaw, self.actors[0].yaw),
                            b.pitch - self.actors[0].pitch,
                        );
                    }
                    self.actors[i].yaw = b.yaw;
                    self.actors[i].pitch = b.pitch;
                }
            }
        }

        // Bodies, then hands.
        let mut moved = vec![];
        let mut cues = vec![];
        for i in 0..n {
            if !self.actors[i].alive {
                let a = &mut self.actors[i];
                a.dead_for += dt;
                a.prev = a.body.pos;
                if let Some(t) = &mut a.respawn_in {
                    *t -= dt;
                    if *t <= 0.0 && live {
                        self.respawn(i);
                    }
                }
                continue;
            }
            moved.clear();
            self.actors[i].step(&self.map, &inputs[i], dt, &mut moved, &mut self.rng);
            let pos = self.actors[i].feet();
            for m in moved.drain(..) {
                if i == 0 {
                    self.view.moved(m);
                }
                self.events.push(Event::Moved {
                    actor: i,
                    what: m,
                    pos,
                });
            }
            let a = &mut self.actors[i];
            let inp = &inputs[i];
            let ask = Ask {
                fire: inp.fire,
                ads: inp.ads,
                reload: inp.reload,
                swap: inp.swap,
                nade: inp.nade,
                melee: inp.melee,
                sprinting: a.sprinting,
                airborne: !a.body.on_ground && a.mantle.is_none(),
                crouched: a.crouched,
                sliding: a.slide > 0.0,
                speed: a.speed(),
            };
            cues.clear();
            let shot = if a.mantle.is_some() {
                None
            } else {
                a.arms.tick(dt, &ask, &mut self.rng, &mut cues)
            };
            let eye = self.actors[i].eye();
            for c in cues.drain(..) {
                match c {
                    Cue::NadeRelease => self.throw(i),
                    Cue::MeleeStrike => self.melee(i),
                    _ => {}
                }
                if c != Cue::Shot {
                    self.events.push(Event::Cue {
                        actor: i,
                        cue: c,
                        pos: eye,
                    });
                }
                if i == 0 {
                    self.view.cue(c);
                }
            }
            if let Some(s) = shot {
                self.fire(i, s);
            }
        }

        // Grenades.
        let mut k = 0;
        while k < self.grenades.len() {
            if let Some(_speed) = self.grenades[k].step(&self.map, dt) {
                self.events.push(Event::NadeBounce {
                    pos: self.grenades[k].pos,
                });
            }
            if self.grenades[k].fuse <= 0.0 {
                let g = self.grenades.remove(k);
                self.explode(g.pos, g.owner);
            } else {
                k += 1;
            }
        }

        // What one bot sees, its squad knows.
        self.intel -= dt;
        if self.intel <= 0.0 {
            self.intel = 0.3;
            let mut calls = vec![];
            for (i, b) in self.brains.iter().enumerate() {
                let Some(b) = b else { continue };
                if !self.actors[i].alive {
                    continue;
                }
                for (e, m) in b.mem.iter().enumerate() {
                    if m.visible {
                        calls.push((self.actors[i].team, self.actors[i].body.pos, e, m.pos));
                    }
                }
            }
            for (team, from, e, pos) in calls {
                for (j, b) in self.brains.iter_mut().enumerate() {
                    if let Some(b) = b {
                        if self.actors[j].team == team
                            && (self.actors[j].body.pos - from).length() < 1900.0
                        {
                            b.told(e, pos, self.time);
                        }
                    }
                }
            }
        }

        if live && self.rules.cfg.mode == Mode::Elimination {
            let alive = |t: usize| {
                self.actors
                    .iter()
                    .filter(|a| a.team == t && a.alive)
                    .count()
            };
            let (a, b) = (alive(0), alive(1));
            if a == 0 || b == 0 {
                self.round_won(if a == 0 && b == 0 {
                    None
                } else if b == 0 {
                    Some(0)
                } else {
                    Some(1)
                });
            }
        }
    }

    /// The clock ran out.
    fn time_up(&mut self) {
        match self.rules.cfg.mode {
            Mode::Tdm => {
                let s = self.rules.score;
                self.match_won(if s[0] == s[1] {
                    None
                } else if s[0] > s[1] {
                    Some(0)
                } else {
                    Some(1)
                });
            }
            Mode::Elimination => {
                let side = |t: usize| {
                    let alive: Vec<&Actor> = self
                        .actors
                        .iter()
                        .filter(|a| a.team == t && a.alive)
                        .collect();
                    (alive.len(), alive.iter().map(|a| a.health).sum::<f32>())
                };
                let (a, b) = (side(0), side(1));
                self.round_won(if a.0 != b.0 {
                    Some(if a.0 > b.0 { 0 } else { 1 })
                } else if (a.1 - b.1).abs() > 1.0 {
                    Some(if a.1 > b.1 { 0 } else { 1 })
                } else {
                    None
                });
            }
        }
    }

    fn round_won(&mut self, winner: Option<usize>) {
        if let Some(w) = winner {
            self.rules.score[w] += 1;
            if self.rules.score[w] >= self.rules.cfg.limit() {
                self.match_won(Some(w));
                return;
            }
        }
        self.rules.phase = Phase::RoundEnd(winner, ROUND_END);
        let won = winner.map(|w| w == 0);
        self.events.push(Event::RoundOver { won });
        let (title, tone) = match won {
            Some(true) => ("ROUND WON", "good"),
            Some(false) => ("ROUND LOST", "bad"),
            None => ("DRAW", "info"),
        };
        let s = self.rules.score;
        self.rules
            .say(title, &format!("{} – {}", s[0], s[1]), tone, ROUND_END);
    }

    fn match_won(&mut self, winner: Option<usize>) {
        self.rules.phase = Phase::Over(winner, 0.0);
        self.events.push(Event::MatchOver {
            won: winner.map(|w| w == 0),
        });
    }

    fn told(&mut self, team: usize, who: usize, pos: Vec3, radius: f32) {
        for (j, b) in self.brains.iter_mut().enumerate() {
            if let Some(b) = b {
                if self.actors[j].team == team
                    && self.actors[j].alive
                    && (self.actors[j].body.pos - pos).length() < radius
                {
                    b.told(who, pos, self.time);
                }
            }
        }
    }

    /// Resolves a shot: each pellet against the enemy's hit zones and the world.
    fn fire(&mut self, i: usize, shot: Shot) {
        let a = &self.actors[i];
        let (yaw, pitch) = a.aim();
        let eye = a.eye();
        let rot = view_quat(yaw, pitch, 0.0);
        let (fwd, right, up) = (rot * Vec3::NEG_Z, rot * Vec3::X, rot * Vec3::Y);
        let team = a.team;
        let def = shot.def;
        // Where the tracer leaves: the player's view model, a bot's carried gun.
        let muzzle = if i == 0 && self.view.first_person() {
            self.view.muzzle
        } else {
            self.puppets[i].muzzle(&self.actors[i], &self.view.meta)
        };
        let mut any = false;
        for p in 0..shot.pellets {
            let s = self.rng.disc() * shot.spread.tan()
                + if shot.pattern > 0.0 {
                    self.rng.disc() * shot.pattern.tan()
                } else {
                    Vec2::ZERO
                };
            let dir = (fwd + right * s.x + up * s.y).normalize();
            let end = eye + dir * 8192.0;
            let tr = self.map.ray(eye, end);
            let wall = tr.fraction * 8192.0;
            let mut hit: Option<(usize, f32, Zone)> = None;
            for (j, o) in self.actors.iter().enumerate() {
                if o.team == team || !o.alive {
                    continue;
                }
                if let Some((t, z)) = hit_actor(o, eye, dir) {
                    if t < wall && hit.is_none_or(|(_, b, _)| t < b) {
                        hit = Some((j, t, z));
                    }
                }
            }
            let to = match hit {
                Some((j, t, zone)) => {
                    any = true;
                    let pos = eye + dir * t;
                    let k = match zone {
                        Zone::Head => def.head,
                        Zone::Body => 1.0,
                        Zone::Limb => def.limb,
                    };
                    self.events.push(Event::Impact {
                        pos,
                        normal: -dir,
                        flesh: true,
                    });
                    self.fx.blood(pos, dir);
                    self.damage(j, Some(i), def.damage_at(t) * k, zone, def.id, dir, pos);
                    pos
                }
                None => {
                    if tr.fraction < 1.0 {
                        self.events.push(Event::Impact {
                            pos: tr.end,
                            normal: tr.normal,
                            flesh: false,
                        });
                        self.fx.impact(tr.end, tr.normal, p == 0);
                    }
                    tr.end
                }
            };
            // Tracers: the player's every shot, the others' every second one.
            if i == 0 || p == 0 && self.rng.chance(0.6) {
                self.fx.tracer(muzzle, to);
            }
            // A round passing the player's head.
            if i != 0 && self.actors[0].alive && team != self.actors[0].team {
                let ear = self.actors[0].eye();
                let t = (ear - eye).dot(dir);
                if t > 60.0 && t < (to - eye).length() {
                    let near = eye + dir * t;
                    if (near - ear).length() < 70.0 && p == 0 {
                        self.events.push(Event::Whiz { pos: near });
                    }
                }
            }
        }
        let a = &mut self.actors[i];
        a.record.shots += 1;
        a.record.hits += any as u32;
        a.since_fired = 0.0;
        let pos = a.body.pos;
        self.events.push(Event::Shot {
            actor: i,
            weapon: def.id,
            pos: muzzle,
        });
        self.fx.flash(
            i,
            muzzle,
            def.class == Class::Shotgun || def.class == Class::Marksman,
            fwd,
        );
        if i == 0 {
            self.view.fired(def, shot.last, &mut self.rng);
            self.fx.casing(
                self.view.eject,
                self.view.eject_vel,
                def.class == Class::Shotgun,
            );
        }
        // The other side hears where it came from.
        self.told(1 - team, i, pos, 2300.0);
    }

    pub(crate) fn damage(
        &mut self,
        victim: usize,
        attacker: Option<usize>,
        amount: f32,
        zone: Zone,
        weapon: &'static str,
        dir: Vec3,
        pos: Vec3,
    ) {
        let cfg = self.rules.cfg;
        let v = &self.actors[victim];
        if !v.alive || self.rules.over().is_some() {
            return;
        }
        // A moment's protection at the spawn, until the spawned one shoots.
        if v.alive_for < 1.2 && v.since_fired > v.alive_for {
            return;
        }
        let mut amount = amount;
        if victim == 0 && attacker.is_some_and(|k| k != 0) {
            amount *= [0.55, 0.8, 1.0][cfg.difficulty.min(2)];
        }
        let from = attacker.map_or(pos, |k| self.actors[k].body.pos);
        let v = &mut self.actors[victim];
        v.health -= amount;
        v.since_hurt = 0.0;
        if let Some(k) = attacker {
            match v.hurt_by.iter_mut().find(|h| h.0 == k) {
                Some(h) => {
                    h.1 += amount;
                    h.2 = 0.0;
                }
                None => v.hurt_by.push((k, amount, 0.0)),
            }
        }
        let fatal = v.health <= 0.0;
        self.puppets[victim].flinch(dir, amount);
        if let Some(k) = attacker {
            self.actors[k].record.damage += amount;
            if let Some(b) = &mut self.brains[victim] {
                b.told(k, from, self.time);
            }
            // The squad hears who is being shot.
            let team = self.actors[k].team;
            let vpos = self.actors[victim].body.pos;
            self.told(team, victim, vpos, 1500.0);
        }
        if attacker == Some(0) {
            self.hit_mark = (0.0, zone == Zone::Head, fatal);
        }
        if victim == 0 {
            self.hurts.push((from, 0.0, amount));
            self.view.hurt(amount);
        }
        self.events.push(Event::Hit {
            victim,
            attacker,
            zone,
            amount,
            fatal,
            from,
        });
        if fatal {
            self.kill(victim, attacker, weapon, zone, dir, pos);
        }
    }

    fn kill(
        &mut self,
        victim: usize,
        attacker: Option<usize>,
        weapon: &'static str,
        zone: Zone,
        dir: Vec3,
        pos: Vec3,
    ) {
        let mode = self.rules.cfg.mode;
        let headshot = zone == Zone::Head && weapon != "frag" && weapon != "melee";
        let dist;
        {
            let v = &mut self.actors[victim];
            v.alive = false;
            v.health = 0.0;
            v.record.deaths += 1;
            v.record.streak = 0;
            v.dead_for = 0.0;
            v.nemesis = attacker;
            v.sprinting = false;
            v.slide = 0.0;
            v.respawn_in = (mode == Mode::Tdm).then_some(RESPAWN);
            dist = attacker.map_or(0.0, |k| {
                (self.actors[k].body.pos - self.actors[victim].body.pos).length()
            });
        }
        let force = match weapon {
            "frag" => 620.0,
            "shotgun" => 420.0,
            "dmr" => 380.0,
            "melee" => 300.0,
            _ => 240.0,
        };
        let vel = self.actors[victim].body.vel;
        self.puppets[victim].die(
            self.rig.as_deref(),
            &self.actors[victim],
            dir * force,
            pos,
            vel,
        );
        if victim == 0 {
            self.killer = attacker.filter(|k| *k != 0).map(|k| (k, 0.0));
            self.view.died();
        }
        let (vname, vteam) = (self.actors[victim].name.clone(), self.actors[victim].team);
        let weapon_name = match weapon {
            "frag" => "FRAG",
            "melee" => "MELEE",
            id => crate::weapons::by_id(id).map_or("", |w| w.name),
        };
        if let Some(k) = attacker.filter(|k| *k != victim) {
            let revenge = self.actors[k].nemesis == Some(victim);
            let helpers: Vec<usize> = self.actors[victim]
                .hurt_by
                .iter()
                .filter(|h| h.0 != k && h.1 >= 25.0 && self.actors[h.0].team == self.actors[k].team)
                .map(|h| h.0)
                .collect();
            let a = &mut self.actors[k];
            a.record.kills += 1;
            a.record.score += 100;
            a.record.streak += 1;
            a.record.best_streak = a.record.best_streak.max(a.record.streak);
            a.record.headshots += headshot as u32;
            a.multi = (if a.multi.1 < 3.5 { a.multi.0 + 1 } else { 1 }, 0.0);
            if revenge {
                a.nemesis = None;
            }
            let (streak, multi, low) = (a.record.streak, a.multi.0, a.health < 30.0);
            let team = a.team;
            let kname = a.name.clone();
            for h in helpers {
                self.actors[h].record.assists += 1;
                self.actors[h].record.score += 40;
                if h == 0 {
                    self.rules.popup("ASSIST", 40, false);
                }
            }
            if k == 0 {
                // What the player earned.
                let mut bonus = 0;
                self.rules
                    .popup(&format!("ELIMINATED  {vname}"), 100, false);
                let mut medal = |r: &mut Rules, text: &str, pts: u32| {
                    r.popup(text, pts, true);
                    bonus += pts;
                };
                if !self.rules.first_blood {
                    medal(&mut self.rules, "FIRST BLOOD", 50);
                }
                if headshot {
                    medal(&mut self.rules, "HEADSHOT", 25);
                }
                if weapon == "frag" {
                    medal(&mut self.rules, "FRAG OUT", 25);
                }
                if weapon == "melee" {
                    medal(&mut self.rules, "EXECUTION", 50);
                }
                if dist > 1500.0 && weapon != "frag" {
                    medal(&mut self.rules, "LONGSHOT", 25);
                }
                if revenge {
                    medal(&mut self.rules, "REVENGE", 25);
                }
                if low {
                    medal(&mut self.rules, "CLUTCH", 25);
                }
                match multi {
                    2 => medal(&mut self.rules, "DOUBLE KILL", 50),
                    3 => medal(&mut self.rules, "TRIPLE KILL", 75),
                    4.. => medal(&mut self.rules, "MULTI KILL", 100),
                    _ => {}
                }
                match streak {
                    3 => medal(&mut self.rules, "KILLING SPREE", 50),
                    5 => medal(&mut self.rules, "RAMPAGE", 100),
                    8 => medal(&mut self.rules, "UNSTOPPABLE", 150),
                    _ => {}
                }
                if bonus > 0 {
                    self.actors[0].record.score += bonus;
                    self.events.push(Event::Medal);
                }
            }
            self.rules.first_blood = true;
            self.rules.feed.push(Feed {
                killer: kname,
                killer_team: team,
                victim: vname,
                victim_team: vteam,
                weapon: weapon_name,
                headshot,
                own: k == 0 || victim == 0,
                age: 0.0,
            });
            if mode == Mode::Tdm && self.rules.live() {
                self.rules.score[team] += 1;
                let s = self.rules.score;
                let limit = self.rules.cfg.limit();
                if s[team] >= limit {
                    self.match_won(Some(team));
                } else {
                    let lead = if s[0] == s[1] {
                        self.rules.lead
                    } else {
                        Some(if s[0] > s[1] { 0 } else { 1 })
                    };
                    if lead != self.rules.lead && self.rules.lead.is_some() {
                        let ours = lead == Some(0);
                        self.events.push(Event::Lead { ours });
                        self.rules.say(
                            if ours { "LEAD TAKEN" } else { "LEAD LOST" },
                            &format!("{} – {}", s[0], s[1]),
                            if ours { "good" } else { "bad" },
                            2.4,
                        );
                    }
                    self.rules.lead = lead;
                    if s[team] + 5 == limit && !self.rules.near_called[team] {
                        self.rules.near_called[team] = true;
                        let ours = team == 0;
                        self.rules.say(
                            if ours {
                                "5 TO WIN"
                            } else {
                                "ENEMY NEAR VICTORY"
                            },
                            &format!("{} – {}", s[0], s[1]),
                            if ours { "good" } else { "bad" },
                            2.4,
                        );
                    }
                }
            }
        } else {
            self.rules.feed.push(Feed {
                killer: String::new(),
                killer_team: vteam,
                victim: vname,
                victim_team: vteam,
                weapon: weapon_name,
                headshot: false,
                own: victim == 0,
                age: 0.0,
            });
        }
        if self.rules.feed.len() > 6 {
            self.rules.feed.remove(0);
        }
        self.events.push(Event::Kill {
            victim,
            attacker,
            headshot,
        });
    }

    fn throw(&mut self, i: usize) {
        let a = &self.actors[i];
        let (yaw, pitch) = a.aim();
        let dir = view_dir(yaw, pitch + 0.07);
        let pos = a.eye() + view_dir(yaw, pitch) * 14.0 + yaw_right(yaw) * 7.0 - Vec3::Y * 4.0;
        // Not through a wall the thrower is leaning on.
        let pos = if self.map.los(a.eye(), pos) {
            pos
        } else {
            a.eye()
        };
        self.grenades.push(Grenade {
            pos,
            vel: dir * crate::combat::THROW_SPEED + a.body.vel * 0.5,
            fuse: FUSE,
            owner: i,
            spin: 0.0,
            resting: false,
        });
    }

    fn melee(&mut self, i: usize) {
        let a = &self.actors[i];
        let (yaw, pitch) = a.aim();
        let fwd = view_dir(yaw, pitch);
        let eye = a.eye();
        let mut best: Option<(f32, usize)> = None;
        for (j, o) in self.actors.iter().enumerate() {
            if o.team == a.team || !o.alive {
                continue;
            }
            let to = sight_points(o)[1] - eye;
            let d = to.length();
            if d < 84.0 && (to / d.max(1.0)).dot(fwd) > 0.55 && best.is_none_or(|(b, _)| d < b) {
                best = Some((d, j));
            }
        }
        if let Some((_, j)) = best {
            // From behind it is final.
            let behind = yaw_dir(self.actors[j].yaw).dot(flat(fwd).normalize_or_zero()) > 0.4;
            let pos = sight_points(&self.actors[j])[1];
            self.events.push(Event::Impact {
                pos,
                normal: -fwd,
                flesh: true,
            });
            self.damage(
                j,
                Some(i),
                if behind { 200.0 } else { 75.0 },
                Zone::Body,
                "melee",
                fwd,
                pos,
            );
        }
    }

    fn explode(&mut self, pos: Vec3, owner: usize) {
        self.events.push(Event::Explosion { pos });
        self.fx.blast(pos);
        let team = self.actors[owner].team;
        let center = pos + Vec3::Y * 10.0;
        let mut hits = vec![];
        for (j, o) in self.actors.iter().enumerate() {
            if !o.alive || o.team == team && j != owner {
                continue;
            }
            let pts = sight_points(o);
            let d = (pts[1] - center).length();
            if d < BLAST_RADIUS && pts.iter().any(|p| self.map.los(center, *p)) {
                let k = 1.0 - d / BLAST_RADIUS;
                hits.push((
                    j,
                    BLAST_DAMAGE * k.powf(0.8) * if j == owner { 0.6 } else { 1.0 },
                    (pts[1] - center).normalize_or(Vec3::Y),
                ));
            }
        }
        for (j, amount, dir) in hits {
            let p = sight_points(&self.actors[j])[1];
            self.damage(
                j,
                Some(owner),
                amount,
                Zone::Body,
                "frag",
                (dir + Vec3::Y * 0.5).normalize(),
                p,
            );
        }
        // The blast shakes the player's view and is heard by everyone.
        let d = (self.actors[0].eye() - pos).length();
        self.view.shake((1.0 - d / 900.0).clamp(0.0, 1.0));
        self.told(1 - team, owner, pos, 2600.0);
    }

    /// The frame for the screen.
    pub fn frame(&self) -> Frame {
        let alpha = self.alpha();
        let cam = self.view.camera();
        let mut f = Frame {
            eye: (cam.eye * UNIT).to_array(),
            rot: cam.rot.to_array(),
            fov: cam.fov,
            actors: vec![],
            fx: self.fx.frame(),
            vm: self.view.viewmodel(),
        };
        for (i, a) in self.actors.iter().enumerate() {
            let p = &self.puppets[i];
            // The player's own body shows once it is down (the death camera looks at it).
            let shown = if i == 0 {
                !a.alive && !self.view.first_person()
            } else {
                a.alive || p.dead()
            };
            let feet = p.root(a, alpha) * UNIT;
            let (wp, wr) = p.weapon();
            f.actors.push(ActorFrame {
                shown,
                team: a.team,
                pos: feet.to_array(),
                yaw: p.yaw(),
                pose: p.pose().to_vec(),
                weapon: a.arms.def().id,
                weapon_pos: (wp * UNIT).to_array(),
                weapon_rot: wr.to_array(),
            });
        }
        for g in self.grenades.iter().take(crate::view::NADES) {
            let rot = Quat::from_rotation_x(g.spin) * Quat::from_rotation_z(g.spin * 0.7);
            f.fx.nades.push(crate::view::Placed {
                pos: (g.pos * UNIT).to_array(),
                rot: rot.to_array(),
                k: 1.0,
                flag: false,
            });
        }
        f
    }

    /// The HUD's state.
    pub fn hud(&self) -> Value {
        let a = &self.actors[0];
        let r = &self.rules;
        let (phase, countdown, won) = match r.phase {
            Phase::Warmup(t) => ("warmup", t, None),
            Phase::Live => ("live", 0.0, None),
            Phase::RoundEnd(w, t) => ("roundEnd", t, w.map(|w| w == 0)),
            Phase::Over(w, _) => ("over", 0.0, w.map(|w| w == 0)),
        };
        let s = a.arms.slot();
        let o = &a.arms.slots[1 - a.arms.cur];
        let ask = Ask {
            sprinting: a.sprinting,
            airborne: !a.body.on_ground,
            crouched: a.crouched,
            sliding: a.slide > 0.0,
            speed: a.speed(),
            ..Ask::default()
        };
        let (yaw, _) = a.aim();
        // Radar: teammates always; enemies while they fire or a teammate sees them.
        let mut dots = vec![];
        for (i, x) in self.actors.iter().enumerate().skip(1) {
            if !x.alive {
                continue;
            }
            let known = x.team == a.team
                || x.since_fired < 1.6
                || self.brains.iter().enumerate().any(|(j, b)| {
                    b.as_ref().is_some_and(|b| {
                        self.actors[j].team == a.team && self.actors[j].alive && b.mem[i].visible
                    })
                });
            if !known {
                continue;
            }
            let d = (x.body.pos - a.body.pos) * UNIT;
            // Player space: x right, y forward.
            let (fx, rx) = (yaw_dir(yaw), yaw_right(yaw));
            dots.push(json!({ "x": d.dot(rx), "y": d.dot(fx), "ally": x.team == a.team, "fire": x.since_fired < 0.25 }));
        }
        let hurts: Vec<Value> = self
            .hurts
            .iter()
            .map(|(from, age, amount)| {
                let (y, _) = dir_angles((*from - a.body.pos).normalize_or(Vec3::NEG_Z));
                // Clockwise from straight ahead.
                json!({ "angle": -angle_diff(y, yaw), "age": age, "amount": amount })
            })
            .collect();
        let board: Vec<Value> = self.actors.iter().enumerate().map(|(i, x)| json!({ "name": x.name, "team": x.team, "k": x.record.kills, "d": x.record.deaths, "a": x.record.assists, "score": x.record.score, "alive": x.alive, "you": i == 0 })).collect();
        let rec = a.record;
        let killer = self.killer.map(|(k, _)| json!({ "name": self.actors[k].name, "weapon": self.actors[k].arms.def().name, "hp": self.actors[k].health.max(0.0).round() }));
        json!({
            "kind": "game",
            "map": self.map.name,
            "mode": match r.cfg.mode { Mode::Tdm => "tdm", Mode::Elimination => "elim" },
            "phase": phase,
            "countdown": countdown,
            "clock": r.clock,
            "limit": r.cfg.limit(),
            "score": r.score,
            "round": r.round,
            "won": won,
            "overFor": match r.phase { Phase::Over(_, t) => t, _ => 0.0 },
            "hp": a.health.max(0.0).round(),
            "alive": a.alive,
            "respawn": a.respawn_in.filter(|_| !a.alive),
            "killer": killer,
            "weapon": { "id": s.def.id, "name": s.def.name, "mag": s.mag, "cap": s.def.mag, "reserve": s.reserve, "reload": a.arms.reload.map(|x| (x.t / x.dur).clamp(0.0, 1.0)), "auto": s.def.auto },
            "other": { "id": o.def.id, "name": o.def.name, "mag": o.mag, "reserve": o.reserve },
            "nades": a.arms.nades,
            "ads": a.arms.ads,
            "scope": s.def.class == Class::Marksman && a.arms.ads > 0.85,
            "spread": a.arms.spread(&ask),
            "fov": self.view.camera().fov,
            "stance": if a.slide > 0.0 { "slide" } else if a.crouched { "crouch" } else { "stand" },
            "sprint": a.sprinting,
            "hit": { "age": self.hit_mark.0, "head": self.hit_mark.1, "kill": self.hit_mark.2 },
            "hurts": hurts,
            "sinceHurt": a.since_hurt,
            "popups": r.popups.iter().map(|p| json!({ "text": p.text, "points": p.points, "medal": p.medal, "age": p.age })).collect::<Vec<_>>(),
            "feed": r.feed.iter().map(|f| json!({ "killer": f.killer, "kt": f.killer_team, "victim": f.victim, "vt": f.victim_team, "weapon": f.weapon, "head": f.headshot, "own": f.own, "age": f.age })).collect::<Vec<_>>(),
            "banner": r.banner.as_ref().map(|b| json!({ "title": b.title, "sub": b.sub, "tone": b.tone, "age": b.age, "life": b.life })),
            "radar": dots,
            "board": board,
            "stats": { "kills": rec.kills, "deaths": rec.deaths, "assists": rec.assists, "score": rec.score, "accuracy": if rec.shots > 0 { rec.hits as f32 / rec.shots as f32 } else { 0.0 }, "headshots": rec.headshots, "streak": rec.best_streak, "damage": rec.damage.round() },
        })
    }

    /// For logs and tests.
    pub fn summary(&self) -> String {
        let a = &self.actors[0];
        format!(
            "t {:.0}s score {}-{} hp {:.0} k/d {}/{} phase {:?}",
            self.time,
            self.rules.score[0],
            self.rules.score[1],
            a.health,
            a.record.kills,
            a.record.deaths,
            self.rules.phase
        )
    }

    pub fn camera_basis(&self) -> (Vec3, Quat) {
        let c = self.view.camera();
        (c.eye * UNIT, c.rot)
    }
}
