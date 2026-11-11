//! The guns' numbers. Angles in degrees, distances in GoldSrc units, times in seconds.

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Class {
    Rifle,
    Smg,
    Shotgun,
    Marksman,
    Pistol,
}

#[derive(Debug)]
pub struct WeaponDef {
    /// Model and sound id (weapons/meta.json, the scene's weapon models).
    pub id: &'static str,
    pub name: &'static str,
    pub class: Class,
    pub mag: u32,
    pub reserve: u32,
    pub rpm: f32,
    /// Fires while the trigger is held.
    pub auto: bool,
    pub pellets: u32,
    pub damage: f32,
    /// Damage falls from full at `.0` to `.2` of it at `.1`.
    pub falloff: (f32, f32, f32),
    pub head: f32,
    pub limb: f32,
    /// A magazine change with a round chambered, and from empty (the bolt is racked).
    pub reload: f32,
    pub reload_empty: f32,
    /// Shells are loaded one by one (the shotgun): seconds per shell.
    pub shell: Option<f32>,
    pub ads_time: f32,
    /// Vertical field of view through the sights.
    pub ads_fov: f32,
    /// Move speed while aiming, and with the gun out (x the actor's).
    pub ads_move: f32,
    pub mobility: f32,
    pub draw: f32,
    /// Cone half angles: from the hip, through the sights, added per shot (up to `bloom_max`), added at a full run.
    pub hip: f32,
    pub ads: f32,
    pub bloom: f32,
    pub bloom_max: f32,
    pub move_spread: f32,
    /// A pellet pattern's own half angle (the shotgun), added to the cone.
    pub pattern: f32,
    /// View kick per shot: up, and sideways (pattern amplitude, random part).
    pub kick: f32,
    pub kick_side: f32,
    pub kick_rand: f32,
    /// How much of the kick the sights keep.
    pub ads_kick: f32,
    /// The view model's own recoil: back (metres) and up (degrees) per shot.
    pub vm_back: f32,
    pub vm_rise: f32,
    /// Seconds after a sprint before it can fire.
    pub sprint_out: f32,
    /// Bots: burst lengths (short at range, long up close) and the range they like to fight at.
    pub burst: (u32, u32),
    pub reach: (f32, f32),
}

impl WeaponDef {
    pub fn interval(&self) -> f32 {
        60.0 / self.rpm
    }

    /// Damage at a distance (before the hit zone).
    pub fn damage_at(&self, dist: f32) -> f32 {
        let (a, b, min) = self.falloff;
        let k = ((dist - a) / (b - a).max(1.0)).clamp(0.0, 1.0);
        self.damage * (1.0 + (min - 1.0) * k)
    }
}

pub const CARBINE: WeaponDef = WeaponDef {
    id: "carbine",
    name: "AR-7 KESTREL",
    class: Class::Rifle,
    mag: 30,
    reserve: 150,
    rpm: 720.0,
    auto: true,
    pellets: 1,
    damage: 30.0,
    falloff: (1400.0, 3200.0, 0.72),
    head: 1.6,
    limb: 0.85,
    reload: 2.0,
    reload_empty: 2.45,
    shell: None,
    ads_time: 0.22,
    ads_fov: 43.0,
    ads_move: 0.62,
    mobility: 1.0,
    draw: 0.42,
    hip: 2.1,
    ads: 0.07,
    bloom: 0.2,
    bloom_max: 1.9,
    move_spread: 1.6,
    pattern: 0.0,
    kick: 0.58,
    kick_side: 0.2,
    kick_rand: 0.1,
    ads_kick: 0.8,
    vm_back: 0.026,
    vm_rise: 1.5,
    sprint_out: 0.2,
    burst: (3, 9),
    reach: (350.0, 1500.0),
};

pub const SMG: WeaponDef = WeaponDef {
    id: "smg",
    name: "MP-9 WASP",
    class: Class::Smg,
    mag: 35,
    reserve: 175,
    rpm: 900.0,
    auto: true,
    pellets: 1,
    damage: 24.0,
    falloff: (550.0, 1500.0, 0.55),
    head: 1.5,
    limb: 0.9,
    reload: 1.75,
    reload_empty: 2.2,
    shell: None,
    ads_time: 0.16,
    ads_fov: 46.0,
    ads_move: 0.78,
    mobility: 1.05,
    draw: 0.34,
    hip: 1.7,
    ads: 0.24,
    bloom: 0.17,
    bloom_max: 1.8,
    move_spread: 0.9,
    pattern: 0.0,
    kick: 0.42,
    kick_side: 0.24,
    kick_rand: 0.14,
    ads_kick: 0.85,
    vm_back: 0.02,
    vm_rise: 1.1,
    sprint_out: 0.13,
    burst: (4, 12),
    reach: (150.0, 800.0),
};

pub const SHOTGUN: WeaponDef = WeaponDef {
    id: "shotgun",
    name: "S-12 BREACHER",
    class: Class::Shotgun,
    mag: 7,
    reserve: 35,
    rpm: 210.0,
    auto: false,
    pellets: 8,
    damage: 13.5,
    falloff: (260.0, 900.0, 0.26),
    head: 1.25,
    limb: 0.9,
    reload: 0.5,
    reload_empty: 0.5,
    shell: Some(0.5),
    ads_time: 0.22,
    ads_fov: 48.0,
    ads_move: 0.65,
    mobility: 0.97,
    draw: 0.45,
    hip: 0.6,
    ads: 0.2,
    bloom: 0.0,
    bloom_max: 0.0,
    move_spread: 0.8,
    pattern: 2.6,
    kick: 3.4,
    kick_side: 0.5,
    kick_rand: 0.5,
    ads_kick: 0.9,
    vm_back: 0.07,
    vm_rise: 5.0,
    sprint_out: 0.22,
    burst: (1, 2),
    reach: (60.0, 420.0),
};

pub const DMR: WeaponDef = WeaponDef {
    id: "dmr",
    name: "MR-10 LONGBOW",
    class: Class::Marksman,
    mag: 10,
    reserve: 50,
    rpm: 250.0,
    auto: false,
    pellets: 1,
    damage: 70.0,
    falloff: (3500.0, 7000.0, 0.85),
    head: 2.0,
    limb: 0.85,
    reload: 2.4,
    reload_empty: 2.9,
    shell: None,
    ads_time: 0.3,
    ads_fov: 17.0,
    ads_move: 0.45,
    mobility: 0.93,
    draw: 0.5,
    hip: 4.2,
    ads: 0.015,
    bloom: 0.7,
    bloom_max: 2.0,
    move_spread: 2.4,
    pattern: 0.0,
    kick: 2.3,
    kick_side: 0.35,
    kick_rand: 0.3,
    ads_kick: 0.75,
    vm_back: 0.05,
    vm_rise: 3.2,
    sprint_out: 0.26,
    burst: (1, 2),
    reach: (700.0, 3000.0),
};

pub const PISTOL: WeaponDef = WeaponDef {
    id: "pistol",
    name: "P-45 SIDEARM",
    class: Class::Pistol,
    mag: 15,
    reserve: 60,
    rpm: 420.0,
    auto: false,
    pellets: 1,
    damage: 34.0,
    falloff: (600.0, 1600.0, 0.6),
    head: 1.7,
    limb: 0.9,
    reload: 1.35,
    reload_empty: 1.65,
    shell: None,
    ads_time: 0.12,
    ads_fov: 50.0,
    ads_move: 0.88,
    mobility: 1.08,
    draw: 0.24,
    hip: 1.5,
    ads: 0.18,
    bloom: 0.45,
    bloom_max: 1.9,
    move_spread: 0.8,
    pattern: 0.0,
    kick: 1.25,
    kick_side: 0.3,
    kick_rand: 0.25,
    ads_kick: 0.85,
    vm_back: 0.03,
    vm_rise: 4.0,
    sprint_out: 0.1,
    burst: (2, 4),
    reach: (100.0, 900.0),
};

pub const PRIMARIES: [&WeaponDef; 4] = [&CARBINE, &SMG, &SHOTGUN, &DMR];

/// A loadout: a primary and the sidearm.
pub struct Loadout {
    pub id: &'static str,
    pub title: &'static str,
    pub role: &'static str,
    pub primary: &'static WeaponDef,
}

pub const LOADOUTS: [Loadout; 4] = [
    Loadout {
        id: "assault",
        title: "ASSAULT",
        role: "All-round rifle",
        primary: &CARBINE,
    },
    Loadout {
        id: "cqb",
        title: "CQB",
        role: "Fast, close",
        primary: &SMG,
    },
    Loadout {
        id: "breacher",
        title: "BREACHER",
        role: "One shot up close",
        primary: &SHOTGUN,
    },
    Loadout {
        id: "marksman",
        title: "MARKSMAN",
        role: "Scoped, two hits",
        primary: &DMR,
    },
];

pub fn by_id(id: &str) -> Option<&'static WeaponDef> {
    [&CARBINE, &SMG, &SHOTGUN, &DMR, &PISTOL]
        .into_iter()
        .find(|w| w.id == id)
}

/// Sideways kick per shot of a spray (x the weapon's `kick_side`): a gentle S the hand can learn.
pub const SIDE_PATTERN: [f32; 16] = [
    0.0, 0.25, -0.15, 0.35, 0.6, 0.45, 0.1, -0.35, -0.7, -0.55, -0.2, 0.25, 0.6, 0.3, -0.1, -0.4,
];

/// Upward kick per shot of a spray (x `kick`): a hard first shots, then the gun settles.
pub fn rise_pattern(shot: u32) -> f32 {
    match shot {
        0 => 1.15,
        1..=3 => 1.0,
        4..=8 => 0.82,
        _ => 0.6,
    }
}
