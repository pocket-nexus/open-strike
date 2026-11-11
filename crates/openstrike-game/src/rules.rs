//! The match: team deathmatch (respawns, first to the score limit or ahead when the clock runs out) and elimination
//! (rounds without respawns, first to four), their phases and clock, the kill feed, the player's score popups.

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Mode {
    Tdm,
    Elimination,
}

#[derive(Clone, Copy, Debug)]
pub struct MatchConfig {
    pub mode: Mode,
    /// Soldiers per team (the player included): 2..=5.
    pub squad: usize,
    /// 0 recruit, 1 regular, 2 veteran.
    pub difficulty: usize,
    /// The player's loadout (weapons::LOADOUTS).
    pub loadout: usize,
    pub seed: u64,
    /// The score that wins, if not the mode's own (tests).
    pub limit: Option<u32>,
}

impl Default for MatchConfig {
    fn default() -> Self {
        MatchConfig {
            mode: Mode::Tdm,
            squad: 4,
            difficulty: 1,
            loadout: 0,
            seed: 1,
            limit: None,
        }
    }
}

pub const ROUNDS_TO_WIN: u32 = 4;
pub const WARMUP: f32 = 3.2;
pub const RESPAWN: f32 = 5.0;
pub const ROUND_END: f32 = 4.5;

impl MatchConfig {
    /// Kills (team deathmatch) or rounds (elimination) that win.
    pub fn limit(&self) -> u32 {
        if let Some(l) = self.limit {
            return l;
        }
        match self.mode {
            Mode::Tdm => [16, 20, 25, 32, 40][self.squad.clamp(1, 5) - 1],
            Mode::Elimination => ROUNDS_TO_WIN,
        }
    }

    /// Seconds on the clock (a match of team deathmatch, a round of elimination).
    pub fn time(&self) -> f32 {
        match self.mode {
            Mode::Tdm => 480.0,
            Mode::Elimination => 120.0,
        }
    }
}

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Phase {
    /// The countdown before the match / round goes live.
    Warmup(f32),
    Live,
    /// Elimination: a round was won (None: a draw); the next starts when the pause is over.
    RoundEnd(Option<usize>, f32),
    /// The match is over (None: a draw); seconds since.
    Over(Option<usize>, f32),
}

#[derive(Clone, Debug)]
pub struct Feed {
    pub killer: String,
    pub killer_team: usize,
    pub victim: String,
    pub victim_team: usize,
    pub weapon: &'static str,
    pub headshot: bool,
    /// The player is the killer or the victim.
    pub own: bool,
    pub age: f32,
}

/// A line under the crosshair: what the player just earned.
#[derive(Clone, Debug)]
pub struct Popup {
    pub text: String,
    pub points: u32,
    /// A medal (headshot, double kill, ...) rather than the kill itself.
    pub medal: bool,
    pub age: f32,
}

#[derive(Clone, Debug)]
pub struct Banner {
    pub title: String,
    pub sub: String,
    /// "good", "bad" or "info".
    pub tone: &'static str,
    pub age: f32,
    pub life: f32,
}

pub struct Rules {
    pub cfg: MatchConfig,
    pub phase: Phase,
    /// Kills or rounds per team.
    pub score: [u32; 2],
    pub round: u32,
    /// Seconds left.
    pub clock: f32,
    pub feed: Vec<Feed>,
    pub popups: Vec<Popup>,
    pub banner: Option<Banner>,
    pub first_blood: bool,
    /// Who leads (team deathmatch), to call the lead changes.
    pub lead: Option<usize>,
    pub near_called: [bool; 2],
}

impl Rules {
    pub fn new(cfg: MatchConfig) -> Rules {
        Rules {
            cfg,
            phase: Phase::Warmup(WARMUP),
            score: [0, 0],
            round: 1,
            clock: cfg.time(),
            feed: vec![],
            popups: vec![],
            banner: None,
            first_blood: false,
            lead: None,
            near_called: [false; 2],
        }
    }

    pub fn live(&self) -> bool {
        self.phase == Phase::Live
    }

    pub fn over(&self) -> Option<Option<usize>> {
        match self.phase {
            Phase::Over(w, _) => Some(w),
            _ => None,
        }
    }

    pub fn say(&mut self, title: &str, sub: &str, tone: &'static str, life: f32) {
        self.banner = Some(Banner {
            title: title.into(),
            sub: sub.into(),
            tone,
            age: 0.0,
            life,
        });
    }

    pub fn popup(&mut self, text: &str, points: u32, medal: bool) {
        self.popups.push(Popup {
            text: text.into(),
            points,
            medal,
            age: 0.0,
        });
        if self.popups.len() > 6 {
            self.popups.remove(0);
        }
    }

    /// Ages the feed, the popups and the banner (real seconds).
    pub fn age(&mut self, dt: f32) {
        for f in &mut self.feed {
            f.age += dt;
        }
        self.feed.retain(|f| f.age < 6.5);
        for p in &mut self.popups {
            p.age += dt;
        }
        self.popups.retain(|p| p.age < 2.6);
        if let Some(b) = &mut self.banner {
            b.age += dt;
            if b.age > b.life {
                self.banner = None;
            }
        }
    }
}
