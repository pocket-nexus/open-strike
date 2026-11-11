//! Staged scenes for looking at one thing at a time (screenshots, tuning): the bots stand down, a teammate and an enemy
//! are put in front of the player, and everyone does what the stage's tags say.
//!
//! Tags (comma separated): the two in front `tp:ready` (the default), `tp:aim`, `tp:crouch`, `tp:run`, `tp:strafe`,
//! `tp:sprint`, `tp:reload`, `tp:fire`, `tp:dead`, `tp:pistol`; the player `fp:ads`, `fp:fire`, `fp:reload`,
//! `fp:sprint`, `fp:crouch`, `fp:swap`, `fp:nade`, `fp:melee`, `fp:walk`; `far` puts the two 12 m away instead of 3.
use crate::actor::Input;
use crate::combat::Zone;
use crate::game::Game;
use crate::rules::Phase;
use crate::util::{yaw_dir, yaw_right};
use glam::{Vec2, Vec3};

pub struct Stage {
    pub tags: Vec<String>,
    pub t: f32,
    done: bool,
}

impl Stage {
    pub fn has(&self, tag: &str) -> bool {
        self.tags.iter().any(|t| t == tag)
    }
}

impl Game {
    pub fn stage(&mut self, tags: &str) {
        let stage = Stage {
            tags: tags
                .split(',')
                .map(|t| t.trim().to_string())
                .filter(|t| !t.is_empty())
                .collect(),
            t: 0.0,
            done: false,
        };
        for b in &mut self.brains {
            *b = None;
        }
        self.rules.phase = Phase::Live;
        self.rules.clock = 3600.0;
        self.rules.banner = None;
        // A teammate to the left and an enemy to the right, turned three quarters toward the player.
        let p = &self.actors[0];
        let (pos, yaw) = (p.body.pos, p.yaw);
        let dist = if stage.has("far") { 470.0 } else { 118.0 };
        let enemy = self.actors.iter().position(|a| a.team == 1);
        for (i, side, turn) in [(Some(1usize), -1.0f32, 2.5f32), (enemy, 1.0, -2.5)] {
            let Some(i) = i.filter(|i| *i < self.actors.len()) else {
                continue;
            };
            let at = pos + yaw_dir(yaw) * dist + yaw_right(yaw) * side * 34.0 + Vec3::Y * 6.0;
            let at = self.map.settle(at).unwrap_or(at);
            self.actors[i].spawn(at, yaw + turn);
            self.actors[i].alive_for = 10.0;
            if stage.has("tp:pistol") {
                self.actors[i].arms.cur = 1;
            }
            if stage.has("tp:reload") {
                self.actors[i].arms.slots[0].mag = 3;
            }
        }
        // Everyone else out of the picture.
        for i in 2..self.actors.len() {
            if Some(i) != enemy {
                self.actors[i].alive = false;
                self.actors[i].respawn_in = None;
            }
        }
        if stage.has("fp:reload") {
            self.actors[0].arms.slots[0].mag = if stage.has("fp:empty") { 0 } else { 7 };
        }
        self.staged = Some(stage);
    }

    /// The stage's inputs for actor `i` this tick.
    pub(crate) fn stage_input(&mut self, i: usize, dt: f32) -> Input {
        let Some(st) = &mut self.staged else {
            return Input::default();
        };
        if i == 0 {
            st.t += dt;
        }
        let t = st.t;
        let mut inp = Input::default();
        if i == 0 {
            inp.ads = st.has("fp:ads");
            inp.fire = st.has("fp:fire") && t > 1.0;
            inp.reload = st.has("fp:reload") && t > 1.0 && t < 1.1;
            inp.swap = st.has("fp:swap") && t > 1.0 && t < 1.03;
            inp.nade = st.has("fp:nade") && t > 1.0 && t < 1.03;
            inp.melee = st.has("fp:melee") && t > 1.0 && t < 1.03;
            if st.has("fp:sprint") {
                inp.mv = Vec2::new(0.0, 1.0);
                inp.sprint = true;
            }
            if st.has("fp:walk") {
                inp.mv = Vec2::new(0.0, 1.0);
            }
            inp.stance = Some(st.has("fp:crouch"));
        } else {
            // Back and forth, so they stay in front of the camera.
            let flip = if (t / 1.2) as i32 % 2 == 0 { 1.0 } else { -1.0 };
            if st.has("tp:run") || st.has("tp:sprint") {
                inp.mv = Vec2::new(0.0, flip);
                inp.sprint = st.has("tp:sprint");
            }
            if st.has("tp:strafe") {
                inp.mv = Vec2::new(flip, 0.0);
            }
            inp.stance = Some(st.has("tp:crouch"));
            inp.fire = st.has("tp:fire") && t > 1.0;
            inp.ads = st.has("tp:aim");
            inp.reload = st.has("tp:reload") && t > 0.6 && t < 0.7;
        }
        inp
    }

    /// What a stage does once (the deaths).
    pub(crate) fn stage_tick(&mut self) {
        let Some(st) = &mut self.staged else { return };
        if st.has("tp:dead") && st.t > 0.8 && !st.done {
            st.done = true;
            let from = self.actors[0].eye();
            for i in 1..self.actors.len() {
                if self.actors[i].alive {
                    let at = self.actors[i].eye() - Vec3::Y * 16.0;
                    let dir = (at - from).normalize_or(Vec3::NEG_Z);
                    self.damage(i, Some(0), 500.0, Zone::Body, "carbine", dir, at);
                }
            }
        }
    }

    pub(crate) fn stage_aiming(&self) -> Option<bool> {
        self.staged
            .as_ref()
            .map(|s| s.has("tp:aim") || s.has("tp:fire"))
    }
}
