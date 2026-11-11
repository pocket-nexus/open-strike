//! The sound list and each sound's mix data: its bus, its level, how far it carries.

/// Every sound the game can play. Each is synthesized at startup (a few variations of most), see `sounds.rs`.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
#[repr(u8)]
pub enum Sound {
    // Gunshots.
    ShotCarbine,
    ShotSmg,
    ShotShotgun,
    ShotDmr,
    ShotPistol,
    // Weapon handling.
    DryFire,
    MagOut,
    MagIn,
    BoltRack,
    ShellInsert,
    SwapWeapon,
    AdsIn,
    AdsOut,
    Melee,
    MeleeHit,
    // Movement.
    StepConcrete,
    StepSprint,
    StepCrouch,
    Jump,
    Land,
    Slide,
    Mantle,
    // Bullets.
    ImpactConcrete,
    ImpactMetal,
    ImpactFlesh,
    Ricochet,
    Whiz,
    Casing,
    // Feedback (not positional).
    Hitmarker,
    HitmarkerHead,
    KillConfirm,
    Hurt,
    Death,
    LowHealth,
    Medal,
    // Grenade.
    NadePin,
    NadeThrow,
    NadeBounce,
    Explosion,
    // UI and match.
    UiMove,
    UiSelect,
    UiBack,
    CountBeep,
    CountGo,
    Respawn,
    Victory,
    Defeat,
    LeadTaken,
    LeadLost,
}

/// What a sound is, which decides its bus: feedback and UI sounds skip the world's reverb and `muffle`, and are
/// never stolen for a world sound.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Category {
    Shot,
    Handling,
    Movement,
    Bullet,
    Feedback,
    Grenade,
    Ui,
}

pub(crate) struct Spec {
    pub cat: Category,
    /// Variations synthesized (one is picked per play).
    pub vars: u8,
    /// Authored loudness, dB (the bank's own short-term measure, see `bank::loudness`), and the peak it may not pass.
    pub loud: f32,
    pub peak: f32,
    /// Inverse-distance attenuation starts at `near` metres; the sound is gone at `far`.
    pub near: f32,
    pub far: f32,
    /// How much goes to the shared reverb.
    pub send: f32,
    /// Random pitch per play, ± this fraction.
    pub jitter: f32,
    /// Distance exponent of the wide (tail) stem: below 1 the tail carries further than the transient.
    pub tail_exp: f32,
}

const fn spec(
    cat: Category,
    vars: u8,
    loud: f32,
    peak: f32,
    near: f32,
    far: f32,
    send: f32,
    jitter: f32,
) -> Spec {
    Spec {
        cat,
        vars,
        loud,
        peak,
        near,
        far,
        send,
        jitter,
        tail_exp: 1.0,
    }
}
const fn shot(vars: u8, loud: f32, peak: f32, near: f32, send: f32) -> Spec {
    Spec {
        cat: Category::Shot,
        vars,
        loud,
        peak,
        near,
        far: 600.0,
        send,
        jitter: 0.025,
        tail_exp: 0.55,
    }
}

impl Sound {
    pub const ALL: &[Sound] = {
        use Sound::*;
        &[
            ShotCarbine,
            ShotSmg,
            ShotShotgun,
            ShotDmr,
            ShotPistol,
            DryFire,
            MagOut,
            MagIn,
            BoltRack,
            ShellInsert,
            SwapWeapon,
            AdsIn,
            AdsOut,
            Melee,
            MeleeHit,
            StepConcrete,
            StepSprint,
            StepCrouch,
            Jump,
            Land,
            Slide,
            Mantle,
            ImpactConcrete,
            ImpactMetal,
            ImpactFlesh,
            Ricochet,
            Whiz,
            Casing,
            Hitmarker,
            HitmarkerHead,
            KillConfirm,
            Hurt,
            Death,
            LowHealth,
            Medal,
            NadePin,
            NadeThrow,
            NadeBounce,
            Explosion,
            UiMove,
            UiSelect,
            UiBack,
            CountBeep,
            CountGo,
            Respawn,
            Victory,
            Defeat,
            LeadTaken,
            LeadLost,
        ]
    };
    pub(crate) const COUNT: usize = Sound::ALL.len();

    pub fn name(self) -> &'static str {
        use Sound::*;
        match self {
            ShotCarbine => "shot_carbine",
            ShotSmg => "shot_smg",
            ShotShotgun => "shot_shotgun",
            ShotDmr => "shot_dmr",
            ShotPistol => "shot_pistol",
            DryFire => "dry_fire",
            MagOut => "mag_out",
            MagIn => "mag_in",
            BoltRack => "bolt_rack",
            ShellInsert => "shell_insert",
            SwapWeapon => "swap_weapon",
            AdsIn => "ads_in",
            AdsOut => "ads_out",
            Melee => "melee",
            MeleeHit => "melee_hit",
            StepConcrete => "step_concrete",
            StepSprint => "step_sprint",
            StepCrouch => "step_crouch",
            Jump => "jump",
            Land => "land",
            Slide => "slide",
            Mantle => "mantle",
            ImpactConcrete => "impact_concrete",
            ImpactMetal => "impact_metal",
            ImpactFlesh => "impact_flesh",
            Ricochet => "ricochet",
            Whiz => "whiz",
            Casing => "casing",
            Hitmarker => "hitmarker",
            HitmarkerHead => "hitmarker_head",
            KillConfirm => "kill_confirm",
            Hurt => "hurt",
            Death => "death",
            LowHealth => "low_health",
            Medal => "medal",
            NadePin => "nade_pin",
            NadeThrow => "nade_throw",
            NadeBounce => "nade_bounce",
            Explosion => "explosion",
            UiMove => "ui_move",
            UiSelect => "ui_select",
            UiBack => "ui_back",
            CountBeep => "count_beep",
            CountGo => "count_go",
            Respawn => "respawn",
            Victory => "victory",
            Defeat => "defeat",
            LeadTaken => "lead_taken",
            LeadLost => "lead_lost",
        }
    }

    pub fn category(self) -> Category {
        self.spec().cat
    }

    /// Levels: shots loudest, then the explosion, then feedback and impacts, handling under those, steps far below.
    /// Distances: a shot is heard across a 100 m map, a footstep to about 15 m, a casing to about 8.
    pub(crate) fn spec(self) -> &'static Spec {
        use Category::*;
        use Sound::*;
        const fn s(sound: Sound) -> Spec {
            match sound {
                //                    vars loud   peak  near  send
                ShotCarbine => shot(3, -10.0, 0.86, 7.0, 0.30),
                ShotSmg => shot(3, -12.0, 0.84, 6.0, 0.26),
                ShotShotgun => shot(3, -9.0, 0.88, 8.0, 0.34),
                ShotDmr => shot(3, -9.0, 0.88, 8.5, 0.36),
                ShotPistol => shot(3, -11.5, 0.85, 6.0, 0.28),
                //                        vars loud   peak  near far   send  jitter
                DryFire => spec(Handling, 2, -27.0, 0.40, 1.2, 12.0, 0.10, 0.03),
                MagOut => spec(Handling, 2, -24.0, 0.45, 1.2, 14.0, 0.10, 0.03),
                MagIn => spec(Handling, 2, -23.0, 0.50, 1.2, 14.0, 0.10, 0.03),
                BoltRack => spec(Handling, 2, -21.5, 0.55, 1.2, 16.0, 0.12, 0.03),
                ShellInsert => spec(Handling, 3, -25.0, 0.40, 1.2, 12.0, 0.10, 0.04),
                SwapWeapon => spec(Handling, 2, -27.0, 0.35, 1.2, 10.0, 0.08, 0.04),
                AdsIn => spec(Handling, 2, -32.0, 0.25, 1.0, 6.0, 0.05, 0.05),
                AdsOut => spec(Handling, 2, -33.0, 0.25, 1.0, 6.0, 0.05, 0.05),
                Melee => spec(Handling, 3, -24.0, 0.45, 1.5, 12.0, 0.12, 0.05),
                MeleeHit => spec(Handling, 3, -18.0, 0.70, 2.0, 20.0, 0.18, 0.05),
                StepConcrete => spec(Movement, 4, -30.0, 0.30, 1.5, 15.0, 0.14, 0.05),
                StepSprint => spec(Movement, 4, -27.0, 0.38, 1.5, 18.0, 0.16, 0.05),
                StepCrouch => spec(Movement, 3, -37.0, 0.16, 1.5, 8.0, 0.10, 0.05),
                Jump => spec(Movement, 2, -30.0, 0.30, 1.5, 12.0, 0.12, 0.04),
                Land => spec(Movement, 3, -23.5, 0.50, 1.5, 18.0, 0.16, 0.04),
                Slide => spec(Movement, 2, -27.0, 0.35, 1.5, 16.0, 0.14, 0.04),
                Mantle => spec(Movement, 2, -27.0, 0.38, 1.5, 12.0, 0.12, 0.04),
                ImpactConcrete => spec(Bullet, 4, -19.0, 0.65, 3.0, 60.0, 0.22, 0.06),
                ImpactMetal => spec(Bullet, 4, -19.5, 0.62, 3.0, 60.0, 0.24, 0.06),
                ImpactFlesh => spec(Bullet, 3, -19.0, 0.62, 2.5, 40.0, 0.12, 0.05),
                Ricochet => spec(Bullet, 4, -20.5, 0.55, 3.0, 60.0, 0.26, 0.06),
                Whiz => spec(Bullet, 4, -18.0, 0.62, 2.0, 30.0, 0.10, 0.07),
                Casing => spec(Bullet, 4, -31.0, 0.26, 1.0, 8.0, 0.12, 0.06),
                Hitmarker => spec(Feedback, 1, -16.0, 0.62, 1.0, 1.0, 0.0, 0.012),
                HitmarkerHead => spec(Feedback, 1, -14.5, 0.68, 1.0, 1.0, 0.0, 0.01),
                KillConfirm => spec(Feedback, 1, -13.5, 0.74, 1.0, 1.0, 0.0, 0.0),
                Hurt => spec(Feedback, 3, -14.5, 0.72, 1.0, 1.0, 0.0, 0.04),
                Death => spec(Feedback, 1, -13.0, 0.80, 1.0, 1.0, 0.0, 0.0),
                LowHealth => spec(Feedback, 1, -18.0, 0.5, 1.0, 1.0, 0.0, 0.0),
                Medal => spec(Feedback, 1, -16.0, 0.60, 1.0, 1.0, 0.0, 0.0),
                NadePin => spec(Grenade, 2, -26.0, 0.40, 1.2, 12.0, 0.10, 0.03),
                NadeThrow => spec(Grenade, 2, -28.0, 0.32, 1.5, 12.0, 0.10, 0.04),
                NadeBounce => spec(Grenade, 3, -23.0, 0.50, 2.0, 30.0, 0.20, 0.06),
                Explosion => Spec {
                    cat: Grenade,
                    vars: 2,
                    loud: -12.8,
                    peak: 0.88,
                    near: 10.0,
                    far: 900.0,
                    send: 0.40,
                    jitter: 0.03,
                    tail_exp: 0.6,
                },
                UiMove => spec(Ui, 1, -30.0, 0.28, 1.0, 1.0, 0.0, 0.0),
                UiSelect => spec(Ui, 1, -25.0, 0.36, 1.0, 1.0, 0.0, 0.0),
                UiBack => spec(Ui, 1, -26.0, 0.34, 1.0, 1.0, 0.0, 0.0),
                CountBeep => spec(Ui, 1, -20.0, 0.45, 1.0, 1.0, 0.0, 0.0),
                CountGo => spec(Ui, 1, -16.5, 0.60, 1.0, 1.0, 0.0, 0.0),
                Respawn => spec(Ui, 1, -20.0, 0.48, 1.0, 1.0, 0.0, 0.0),
                Victory => spec(Ui, 1, -15.0, 0.72, 1.0, 1.0, 0.0, 0.0),
                Defeat => spec(Ui, 1, -15.0, 0.72, 1.0, 1.0, 0.0, 0.0),
                LeadTaken => spec(Ui, 1, -19.0, 0.50, 1.0, 1.0, 0.0, 0.0),
                LeadLost => spec(Ui, 1, -19.5, 0.50, 1.0, 1.0, 0.0, 0.0),
            }
        }
        static TABLE: [Spec; Sound::COUNT] = {
            let mut t = [const { spec(Ui, 1, 0.0, 0.0, 1.0, 1.0, 0.0, 0.0) }; Sound::COUNT];
            let mut i = 0;
            while i < Sound::COUNT {
                t[i] = s(Sound::ALL[i]);
                i += 1;
            }
            t
        };
        &TABLE[self as usize]
    }

    /// Feedback and UI: their own dry bus, and no world sound may take their voice.
    pub(crate) fn is_ui(self) -> bool {
        matches!(self.spec().cat, Category::Feedback | Category::Ui)
    }
}
