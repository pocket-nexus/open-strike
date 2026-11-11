//! The bots: each sees and hears the enemy, remembers where it was, picks a target, and plays one of a few plans: roam
//! toward the enemy's side, hunt a last known position, fight (close to its weapon's range, strafe, burst, crouch at
//! range, back off, swap to the sidearm on an empty magazine), take cover when hurt or reloading, flee a grenade.
//! It aims as a hand does: a reaction time, an error that settles while tracking, a turn rate.
use crate::actor::{Actor, Input};
use crate::combat::{Grenade, lob, sight_points};
use crate::nav::Nav;
use crate::util::{Rng, angle_diff, damp, dir_angles, flat, view_dir, yaw_dir, yaw_right};
use crate::weapons::Class;
use crate::world::Map;
use glam::{Vec2, Vec3};

#[derive(Clone, Copy, Debug)]
pub struct Skill {
    /// Seconds from seeing an enemy to the first shot.
    pub reaction: f32,
    /// Aim error (radians): on picking up a target, and the floor it settles to while tracking.
    pub error: f32,
    pub track: f32,
    /// How fast the error settles (1/s) and the view turns (radians/s).
    pub aim_rate: f32,
    pub turn: f32,
    /// Chance to go for the head.
    pub head: f32,
    /// Cosine of half the field of view.
    pub fov: f32,
    pub nades: bool,
}

impl Skill {
    pub fn of(difficulty: usize, rng: &mut Rng) -> Skill {
        let d = difficulty.min(2);
        let v = 1.0 + 0.12 * rng.s();
        Skill {
            reaction: [0.65, 0.42, 0.26][d] * v,
            error: [8.5f32, 5.6, 3.4][d].to_radians() * v,
            track: [3.6f32, 2.3, 1.3][d].to_radians() * v,
            aim_rate: [1.8, 3.0, 4.6][d] / v,
            turn: [250.0f32, 380.0, 540.0][d].to_radians(),
            head: [0.04, 0.14, 0.3][d],
            fov: [0.5, 0.42, 0.3][d],
            nades: d > 0,
        }
    }
}

/// What a bot knows of one enemy.
#[derive(Clone, Copy, Debug)]
pub struct Memory {
    pub pos: Vec3,
    /// Game time it was last seen or heard, and when the current sighting began.
    pub seen: f32,
    pub since: f32,
    pub visible: bool,
}

#[derive(Clone, Copy, PartialEq, Debug)]
enum Plan {
    Roam,
    /// Watching a place for a while (until, crouched).
    Hold(f32, bool),
    Hunt(usize),
    Fight,
    Cover {
        until: f32,
        crouch: bool,
        threat: Vec3,
    },
    Flee {
        until: f32,
    },
}

pub struct Senses<'a> {
    pub map: &'a Map,
    pub nav: &'a Nav,
    pub actors: &'a [Actor],
    pub grenades: &'a [Grenade],
    pub time: f32,
    /// The round is live (bots stand still through the countdown).
    pub live: bool,
}

pub struct Brain {
    pub skill: Skill,
    pub mem: Vec<Memory>,
    pub target: Option<usize>,
    plan: Plan,
    path: Vec<u32>,
    at: usize,
    goal: Option<u32>,
    repath: f32,
    sense: f32,
    decide: f32,
    strafe: f32,
    strafe_t: f32,
    crouch_fight: bool,
    err: Vec2,
    err_goal: Vec2,
    err_t: f32,
    aim_head: bool,
    burst: u32,
    pause: f32,
    last_mag: u32,
    click: f32,
    stuck_t: f32,
    stuck_pos: Vec3,
    stuck_n: u32,
    /// The path's next step is up a ledge; seconds until the next try at it.
    climb: bool,
    climb_t: f32,
    scan: f32,
    nade_cd: f32,
    nade_aim: Option<(Vec3, f32, bool)>,
    /// The view the bot holds.
    pub yaw: f32,
    pub pitch: f32,
}

impl Brain {
    pub fn new(skill: Skill, actors: usize, rng: &mut Rng) -> Brain {
        Brain {
            skill,
            mem: vec![
                Memory {
                    pos: Vec3::ZERO,
                    seen: -100.0,
                    since: 0.0,
                    visible: false
                };
                actors
            ],
            target: None,
            plan: Plan::Roam,
            path: vec![],
            at: 0,
            goal: None,
            repath: 0.0,
            sense: rng.f() * 0.1,
            decide: rng.f() * 0.3,
            strafe: 0.0,
            strafe_t: 0.0,
            crouch_fight: false,
            err: Vec2::ZERO,
            err_goal: Vec2::ZERO,
            err_t: 0.0,
            aim_head: false,
            burst: 0,
            pause: 0.0,
            last_mag: 0,
            click: 0.0,
            stuck_t: 0.0,
            stuck_pos: Vec3::ZERO,
            stuck_n: 0,
            climb: false,
            climb_t: 0.0,
            scan: rng.f() * 6.0,
            nade_cd: rng.range(6.0, 16.0),
            nade_aim: None,
            yaw: 0.0,
            pitch: 0.0,
        }
    }

    /// A fresh life: the plan and the path go, what it knew of the enemy fades.
    pub fn respawn(&mut self, yaw: f32) {
        self.plan = Plan::Roam;
        self.path.clear();
        self.at = 0;
        self.goal = None;
        self.target = None;
        self.burst = 0;
        self.nade_aim = None;
        self.yaw = yaw;
        self.pitch = 0.0;
        self.stuck_n = 0;
        for m in &mut self.mem {
            m.visible = false;
        }
    }

    /// A noise or a teammate's call: an enemy is about there.
    pub fn told(&mut self, who: usize, pos: Vec3, time: f32) {
        let m = &mut self.mem[who];
        if !m.visible {
            m.pos = pos;
            m.seen = time;
        }
    }

    fn set_goal(&mut self, nav: &Nav, from: Vec3, to: u32) -> bool {
        let Some(start) = nav.nearest(from) else {
            return false;
        };
        match nav.path(start, to, &|_| 0.0) {
            Some(p) => {
                self.path = p;
                self.at = 0;
                self.goal = Some(to);
                self.repath = 0.8;
                true
            }
            None => {
                self.goal = None;
                self.path.clear();
                false
            }
        }
    }

    fn arrived(&self) -> bool {
        self.at >= self.path.len()
    }

    /// The direction to walk along the path (None at its end). A waypoint up on a ledge is reached by a jump (the
    /// actor pulls itself up): `climb` asks for one once the ledge is close.
    fn steer(&mut self, nav: &Nav, pos: Vec3) -> Option<Vec3> {
        self.climb = false;
        while self.at < self.path.len() {
            let to = nav.pos(self.path[self.at]) - pos;
            let d = flat(to);
            if d.length() > 20.0 || to.y > 20.0 {
                self.climb = to.y > 20.0 && d.length() < 60.0;
                return Some(d.normalize_or(Vec3::NEG_Z));
            }
            self.at += 1;
        }
        None
    }

    fn roam_goal(&self, me: usize, w: &Senses, rng: &mut Rng) -> Option<u32> {
        let a = &w.actors[me];
        let r = rng.f();
        let centre = |t: usize| {
            w.map.spawns[t].iter().map(|s| s.pos).sum::<Vec3>()
                / w.map.spawns[t].len().max(1) as f32
        };
        if r < 0.3 {
            // The enemy's side.
            let s = &w.map.spawns[1 - a.team];
            let p = s[rng.below(s.len())].pos + Vec3::new(rng.s() * 300.0, 0.0, rng.s() * 300.0);
            w.nav.nearest(p)
        } else if r < 0.65 {
            // The ground between the two sides, where the lines meet.
            let k = rng.range(0.35, 0.7);
            let p = centre(a.team).lerp(centre(1 - a.team), k)
                + Vec3::new(rng.s() * 700.0, 0.0, rng.s() * 700.0);
            w.nav.nearest(p).or_else(|| Some(w.nav.random(rng)))
        } else if r < 0.8 {
            Some(w.nav.random(rng))
        } else {
            let mates: Vec<&Actor> = w
                .actors
                .iter()
                .enumerate()
                .filter(|(i, o)| *i != me && o.team == a.team && o.alive)
                .map(|(_, o)| o)
                .collect();
            if mates.is_empty() {
                Some(w.nav.random(rng))
            } else {
                w.nav.nearest(mates[rng.below(mates.len())].body.pos)
            }
        }
    }

    fn decide(&mut self, me: usize, w: &Senses, rng: &mut Rng) {
        let a = &w.actors[me];
        let pos = a.body.pos;
        let time = w.time;
        // Shorten the path where the next corner can be cut.
        let mut skips = 0;
        while skips < 3
            && self.at + 1 < self.path.len()
            && (w.nav.pos(self.path[self.at]).y - pos.y).abs() < 18.0
            && w.nav
                .walkable(w.map, pos, w.nav.pos(self.path[self.at + 1]))
        {
            self.at += 1;
            skips += 1;
        }
        // A grenade close by: run.
        if let Some(g) = w
            .grenades
            .iter()
            .find(|g| (g.pos - pos).length() < 300.0 && g.fuse < 1.9)
        {
            if !matches!(self.plan, Plan::Flee { .. }) {
                if let Some(n) = w.nav.nearest(pos) {
                    let pick =
                        w.nav
                            .around(n, 11, 140)
                            .into_iter()
                            .map(|(i, _)| i)
                            .max_by(|x, y| {
                                let s = |i: u32| {
                                    let p = w.nav.pos(i);
                                    (p - g.pos).length()
                                        + if w.map.los(g.pos + Vec3::Y * 8.0, p) {
                                            0.0
                                        } else {
                                            220.0
                                        }
                                };
                                s(*x).total_cmp(&s(*y))
                            });
                    if let Some(p) = pick {
                        self.set_goal(w.nav, pos, p);
                    }
                }
                self.plan = Plan::Flee {
                    until: time + g.fuse + 0.4,
                };
            }
            return;
        }
        if let Plan::Flee { until } = self.plan {
            if time < until {
                return;
            }
        }
        match self.target {
            Some(t) => {
                let threat = w.actors[t].eye();
                let hurt = a.health < 45.0 && a.since_hurt < 2.5;
                let dry = a.arms.reload.is_some() && a.arms.slot().mag == 0;
                match self.plan {
                    Plan::Cover { until, .. } if time < until && (hurt || dry) => {}
                    _ if (hurt || dry) && rng.chance(0.75) => {
                        let found = w
                            .nav
                            .nearest(pos)
                            .and_then(|n| w.nav.cover(w.map, n, threat, 9));
                        match found {
                            Some((n, crouch)) if self.set_goal(w.nav, pos, n) => {
                                self.plan = Plan::Cover {
                                    until: time + rng.range(2.4, 4.2),
                                    crouch,
                                    threat,
                                }
                            }
                            _ => self.plan = Plan::Fight,
                        }
                    }
                    Plan::Fight => {}
                    _ => {
                        self.plan = Plan::Fight;
                        let dist = (w.actors[t].body.pos - pos).length();
                        let c = a.arms.def().class;
                        self.crouch_fight = dist > 800.0
                            && rng.chance(if c == Class::Marksman { 0.7 } else { 0.3 });
                        self.path.clear();
                        self.at = 0;
                    }
                }
            }
            None => {
                if let Plan::Cover { until, .. } = self.plan {
                    if time < until && a.health < 85.0 {
                        return;
                    }
                }
                // The freshest trace of an enemy, else off toward their side.
                let fresh = self
                    .mem
                    .iter()
                    .enumerate()
                    .filter(|(i, m)| {
                        w.actors[*i].alive && w.actors[*i].team != a.team && time - m.seen < 12.0
                    })
                    .max_by(|x, y| x.1.seen.total_cmp(&y.1.seen))
                    .map(|(i, m)| (i, *m));
                match fresh {
                    Some((i, m)) => {
                        // A grenade for the one that just ducked away.
                        let age = time - m.seen;
                        let dist = (m.pos - pos).length();
                        if self.skill.nades
                            && self.nade_cd <= 0.0
                            && self.nade_aim.is_none()
                            && a.arms.nades > 0
                            && (0.5..3.5).contains(&age)
                            && (380.0..1050.0).contains(&dist)
                            && rng.chance(0.3)
                        {
                            if let Some(v) =
                                lob(a.eye(), m.pos - Vec3::Y * 20.0, crate::combat::THROW_SPEED)
                            {
                                self.nade_aim = Some((v.normalize(), 0.0, false));
                                self.nade_cd = rng.range(12.0, 22.0);
                            }
                        }
                        let stale = self.plan != Plan::Hunt(i) || self.arrived();
                        if stale {
                            if self.plan == Plan::Hunt(i) && self.arrived() && dist < 160.0 {
                                // Nobody here any more.
                                self.mem[i].seen = -100.0;
                                self.plan = Plan::Roam;
                                self.goal = None;
                            } else if let Some(n) = w.nav.nearest(m.pos) {
                                self.set_goal(w.nav, pos, n);
                                self.plan = Plan::Hunt(i);
                            }
                        }
                    }
                    None => match self.plan {
                        Plan::Hold(until, _) if time < until => {}
                        // There: watch the place for a while before moving on.
                        Plan::Roam if self.arrived() && self.goal.is_some() && rng.chance(0.75) => {
                            self.plan = Plan::Hold(time + rng.range(3.5, 9.0), rng.chance(0.4));
                            self.goal = None;
                        }
                        Plan::Roam if !self.arrived() && self.goal.is_some() => {}
                        _ => {
                            self.plan = Plan::Roam;
                            if let Some(g) = self.roam_goal(me, w, rng) {
                                self.set_goal(w.nav, pos, g);
                            }
                        }
                    },
                }
            }
        }
    }

    pub fn think(&mut self, me: usize, w: &Senses, dt: f32, rng: &mut Rng) -> Input {
        let a = &w.actors[me];
        let mut out = Input::default();
        let eye = a.eye();
        let pos = a.body.pos;
        let time = w.time;
        self.nade_cd -= dt;
        self.pause -= dt;
        self.click -= dt;
        self.scan += dt;

        // Eyes: enemies in view (or right next to it, or firing in the corner of the eye) with a clear line.
        self.sense -= dt;
        if self.sense <= 0.0 {
            self.sense = 0.1;
            let look = view_dir(self.yaw, self.pitch);
            for (i, o) in w.actors.iter().enumerate() {
                if o.team == a.team {
                    continue;
                }
                let m = &mut self.mem[i];
                let mut vis = false;
                if o.alive {
                    let to = o.eye() - eye;
                    let dist = to.length();
                    let facing = to.normalize_or_zero().dot(look);
                    if dist < 3800.0
                        && (facing > self.skill.fov
                            || dist < 150.0
                            || o.since_fired < 0.4 && facing > 0.1)
                    {
                        vis = sight_points(o).iter().any(|p| w.map.los(eye, *p));
                    }
                } else {
                    m.seen = -100.0;
                }
                if vis {
                    if !m.visible {
                        m.since = time;
                    }
                    m.pos = o.body.pos;
                    m.seen = time;
                }
                m.visible = vis;
            }
        }

        // The target: the nearest visible enemy, the current one preferred.
        let mut best: Option<(f32, usize)> = None;
        for (i, m) in self.mem.iter().enumerate() {
            if m.visible && w.actors[i].alive {
                let d = (m.pos - pos).length() - if self.target == Some(i) { 260.0 } else { 0.0 };
                if best.is_none_or(|(b, _)| d < b) {
                    best = Some((d, i));
                }
            }
        }
        let target = best.map(|b| b.1);
        if target != self.target {
            self.target = target;
            if let Some(t) = target {
                let dist = (w.actors[t].body.pos - pos).length();
                let d = rng.disc();
                self.err = d.normalize_or(Vec2::X)
                    * self.skill.error
                    * (0.6 + 0.4 * d.length())
                    * (1.0 + dist / 2200.0);
                self.aim_head = rng.chance(self.skill.head);
                self.burst = 0;
                self.pause = 0.0;
            }
        }

        self.decide -= dt;
        if self.decide <= 0.0 {
            self.decide = rng.range(0.2, 0.34);
            self.decide(me, w, rng);
        }
        if !w.live {
            self.turn(
                dir_angles(yaw_dir(self.yaw)).0 + 0.25 * (self.scan * 0.9).sin(),
                0.0,
                dt,
            );
            return out;
        }

        // Legs.
        let mut walk: Option<Vec3> = None;
        let mut sprint = false;
        let mut want_crouch = false;
        let fwd = yaw_dir(self.yaw);
        let right = yaw_right(self.yaw);
        let d = a.arms.def();
        match self.plan {
            Plan::Fight => {
                if let Some(t) = self.target {
                    let o = &w.actors[t];
                    let dist = flat(o.body.pos - pos).length();
                    let (near, far) = d.reach;
                    if dist > far {
                        // Close in along a path to where the enemy stands.
                        self.repath -= dt;
                        if self.repath <= 0.0 || self.arrived() {
                            if let Some(n) = w.nav.nearest(o.body.pos) {
                                self.set_goal(w.nav, pos, n);
                            }
                        }
                        walk = self.steer(w.nav, pos);
                        sprint = dist > far * 1.8 && dist > 1500.0;
                    } else {
                        self.strafe_t -= dt;
                        if self.strafe_t <= 0.0 {
                            self.strafe_t = rng.range(0.45, 1.3);
                            self.strafe = if self.crouch_fight && rng.chance(0.7) {
                                0.0
                            } else if rng.chance(0.5) {
                                1.0
                            } else {
                                -1.0
                            };
                        }
                        // A step sideways that stays on the floor.
                        if self.strafe != 0.0
                            && !w.nav.walkable(w.map, pos, pos + right * self.strafe * 44.0)
                        {
                            self.strafe = -self.strafe;
                            if !w.nav.walkable(w.map, pos, pos + right * self.strafe * 44.0) {
                                self.strafe = 0.0;
                            }
                        }
                        let push: f32 = if dist < near * 0.55
                            && d.class != Class::Shotgun
                            && d.class != Class::Smg
                        {
                            -0.7
                        } else if dist > (near + far) * 0.5 && !self.crouch_fight {
                            0.45
                        } else {
                            0.0
                        };
                        let ok = push == 0.0
                            || w.nav.walkable(w.map, pos, pos + fwd * push.signum() * 44.0);
                        let v = right * self.strafe + fwd * if ok { push } else { 0.0 };
                        if v.length() > 0.05 {
                            walk = Some(v.clamp_length_max(1.0));
                        }
                        want_crouch = self.crouch_fight;
                    }
                } else {
                    self.plan = Plan::Roam;
                    self.goal = None;
                }
            }
            Plan::Cover { crouch, .. } => {
                walk = self.steer(w.nav, pos);
                sprint = walk.is_some() && self.target.is_none();
                if walk.is_none() {
                    want_crouch = crouch;
                    if a.arms.slot().mag < d.mag {
                        out.reload = true;
                    }
                }
            }
            Plan::Flee { .. } => {
                walk = self.steer(w.nav, pos);
                sprint = true;
            }
            Plan::Hold(_, crouch) => want_crouch = crouch,
            Plan::Hunt(_) | Plan::Roam => {
                walk = self.steer(w.nav, pos);
                // A long way to go and nobody about: run. Near where the enemy was: on the toes.
                let left = self.path.len().saturating_sub(self.at);
                let quiet = self.mem.iter().all(|m| time - m.seen > 7.0);
                sprint = left > 34 && quiet;
            }
        }
        self.climb_t -= dt;
        if walk.is_some() && self.climb && self.climb_t <= 0.0 && a.body.on_ground {
            out.jump = true;
            self.climb_t = 0.35;
        }
        if let Some(dir) = walk {
            // On patrol and closing on a trace of the enemy: a walk, weapon ready. Otherwise all the legs give.
            let pace = if matches!(self.plan, Plan::Roam | Plan::Hunt(_)) && !sprint {
                0.66
            } else {
                1.0
            };
            out.mv = Vec2::new(dir.dot(right), dir.dot(fwd)) * pace;
            // Stuck against something: hop, then find another way.
            self.stuck_t += dt;
            if self.stuck_t > 0.5 {
                if (pos - self.stuck_pos).length() < 14.0 {
                    self.stuck_n += 1;
                    if self.stuck_n == 2 {
                        out.jump = true;
                    } else if self.stuck_n >= 4 {
                        self.stuck_n = 0;
                        self.goal = None;
                        self.path.clear();
                        self.plan = Plan::Roam;
                        self.strafe = -self.strafe;
                    }
                } else {
                    self.stuck_n = 0;
                }
                self.stuck_t = 0.0;
                self.stuck_pos = pos;
            }
        } else {
            self.stuck_t = 0.0;
            self.stuck_pos = pos;
        }
        out.sprint = sprint;
        out.stance = Some(want_crouch);

        // Eyes and hands.
        let mut want = (self.yaw, 0.0f32);
        let mut fire = false;
        if let Some((dir, t, pressed)) = &mut self.nade_aim {
            // A lob: line up (the throw adds its own loft), release, hold the line until it is away.
            let (y, p) = dir_angles(*dir);
            want = (y, p - 0.07);
            *t += dt;
            let off = view_dir(self.yaw, self.pitch).dot(view_dir(want.0, want.1));
            if !*pressed && off > 0.995 {
                out.nade = true;
                *pressed = true;
                *t = 0.0;
            }
            if *pressed && *t > 0.5 || !*pressed && *t > 1.6 {
                self.nade_aim = None;
            }
        } else if let Some(t) = self.target {
            let o = &w.actors[t];
            let pts = sight_points(o);
            let point = if self.aim_head { pts[0] } else { pts[1] };
            let to = point - eye;
            let dist = to.length().max(1.0);
            // The error wanders within what the hand can hold: more on a moving target, on the move, at range, in a spray.
            self.err_t -= dt;
            if self.err_t <= 0.0 {
                self.err_t = rng.range(0.16, 0.38);
                let side = flat(o.body.vel).length() / 250.0
                    + a.speed() / 320.0
                    + (a.arms.spray as f32 * 0.07).min(0.8);
                self.err_goal = rng.disc()
                    * self.skill.track
                    * (1.0 + side)
                    * if a.arms.ads > 0.6 { 0.7 } else { 1.0 };
            }
            let k = damp(self.skill.aim_rate, dt);
            self.err += (self.err_goal - self.err) * k;
            let (y, p) = dir_angles(to / dist);
            want = (y + self.err.x, p + self.err.y);
            let m = self.mem[t];
            let reacted = time - m.since > self.skill.reaction;
            let off = view_dir(self.yaw, self.pitch)
                .dot(view_dir(want.0, want.1))
                .clamp(-1.0, 1.0)
                .acos();
            let aimed = off < (16.0 / dist).atan().max(0.02) + 0.012;
            // No shot through a teammate.
            let look = view_dir(self.yaw, self.pitch);
            let blocked = w.actors.iter().enumerate().any(|(i, mate)| {
                i != me && mate.team == a.team && mate.alive && {
                    let v = mate.eye() - Vec3::Y * 14.0 - eye;
                    let l = v.length();
                    l < dist && l > 1.0 && (v / l).dot(look) > 0.992
                }
            });
            if reacted && aimed && !blocked && m.visible {
                if d.auto {
                    if self.burst == 0 && self.pause <= 0.0 {
                        let k = (1.0 - (dist - 300.0) / 1400.0).clamp(0.0, 1.0);
                        self.burst = d.burst.0
                            + ((d.burst.1 - d.burst.0) as f32 * k * (0.6 + 0.4 * rng.f())) as u32;
                    }
                    fire = self.burst > 0;
                } else if self.click <= 0.0 {
                    fire = true;
                    self.click = d.interval() + rng.range(0.06, 0.24) * (1.0 + dist / 2500.0);
                }
            }
            let mag = a.arms.slot().mag;
            if mag < self.last_mag && self.burst > 0 {
                self.burst -= 1;
                if self.burst == 0 {
                    self.pause = rng.range(0.25, 0.65) * (0.6 + dist / 1400.0);
                }
            }
            out.ads = (dist > 480.0 && d.class != Class::Shotgun || d.class == Class::Marksman)
                && self.plan == Plan::Fight;
            // An empty magazine in a close fight: the sidearm is faster than the reload.
            if mag == 0
                && a.arms.cur == 0
                && a.arms.swap.is_none()
                && dist < 520.0
                && a.arms.slots[1].mag > 0
            {
                out.swap = true;
            }
        } else {
            // No target: look where the path goes (sweeping a little), or at where the enemy was.
            let ahead = walk.map(|d| dir_angles(d).0);
            match self.plan {
                Plan::Hunt(i) => {
                    let m = self.mem[i];
                    let to = m.pos + Vec3::Y * 20.0 - eye;
                    if to.length() < 700.0 || w.map.los(eye, m.pos + Vec3::Y * 20.0) {
                        want = dir_angles(to.normalize_or(fwd));
                    } else if let Some(y) = ahead {
                        want = (y, 0.0);
                    }
                }
                Plan::Cover { threat, .. } if walk.is_none() => {
                    want = dir_angles((threat - eye).normalize_or(fwd))
                }
                Plan::Hold(..) => {
                    want = (
                        self.yaw + 0.55 * dt * (self.scan * 0.35).sin().signum(),
                        -0.02,
                    )
                }
                _ => {
                    if let Some(y) = ahead {
                        want = (y + 0.32 * (self.scan * 1.3).sin(), -0.02);
                    } else {
                        want = (self.yaw + 0.9 * dt * (self.scan * 0.5).sin().signum(), 0.0);
                    }
                }
            }
            // Top up, and back to the primary once it is quiet.
            let s = a.arms.slot();
            if s.mag * 2 < d.mag && s.reserve > 0 {
                out.reload = true;
            }
            if a.arms.cur == 1
                && a.arms.swap.is_none()
                && (a.arms.slots[0].mag > 0 || a.arms.slots[0].reserve > 0)
            {
                out.swap = true;
            }
        }
        self.last_mag = a.arms.slot().mag;
        out.fire = fire;
        if fire {
            out.sprint = false;
        }
        self.turn(want.0, want.1, dt);
        out
    }

    fn turn(&mut self, yaw: f32, pitch: f32, dt: f32) {
        let step = self.skill.turn * dt;
        let k = damp(13.0, dt);
        self.yaw += (angle_diff(yaw, self.yaw) * k).clamp(-step, step);
        self.pitch = (self.pitch + ((pitch - self.pitch) * k).clamp(-step, step)).clamp(-1.3, 1.3);
    }
}
