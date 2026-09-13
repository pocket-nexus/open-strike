//! The rifle: config, firing state, timed effects, the procedural viewmodel
//! geometry (as plain data), and the shared deterministic RNG.

use alloc::vec::Vec;

use glam::Vec3;

pub const RANGE: f32 = 8192.0;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WeaponKind {
    // Legacy presets retained for mod/API compatibility.
    Pistol,
    Smg,
    Rifle,
    P228,
    Glock18,
    Scout,
    Xm1014,
    Mac10,
    Aug,
    Elite,
    FiveSeven,
    Ump45,
    Sg550,
    Galil,
    Famas,
    Usp,
    Awp,
    Mp5Navy,
    M249,
    M3,
    M4A1,
    Tmp,
    G3Sg1,
    Deagle,
    Sg552,
    Ak47,
    P90,
}

impl WeaponKind {
    pub fn name(self) -> &'static str {
        match self {
            Self::Pistol => "PISTOL",
            Self::Smg => "SMG",
            Self::Rifle => "RIFLE",
            Self::P228 => "P228",
            Self::Glock18 => "GLOCK 18",
            Self::Scout => "SCOUT",
            Self::Xm1014 => "XM1014",
            Self::Mac10 => "MAC-10",
            Self::Aug => "AUG",
            Self::Elite => "DUAL ELITES",
            Self::FiveSeven => "FIVE-SEVEN",
            Self::Ump45 => "UMP45",
            Self::Sg550 => "SG-550",
            Self::Galil => "GALIL",
            Self::Famas => "FAMAS",
            Self::Usp => "USP",
            Self::Awp => "AWP",
            Self::Mp5Navy => "MP5 NAVY",
            Self::M249 => "M249",
            Self::M3 => "M3",
            Self::M4A1 => "M4A1",
            Self::Tmp => "TMP",
            Self::G3Sg1 => "G3SG1",
            Self::Deagle => "DESERT EAGLE",
            Self::Sg552 => "SG-552",
            Self::Ak47 => "AK-47",
            Self::P90 => "P90",
        }
    }

    pub const fn asset_stem(self) -> &'static str {
        match self {
            Self::Pistol | Self::Glock18 => "glock18",
            Self::Smg | Self::Mp5Navy => "mp5",
            Self::Rifle | Self::Ak47 => "ak47",
            Self::P228 => "p228", Self::Scout => "scout", Self::Xm1014 => "xm1014",
            Self::Mac10 => "mac10", Self::Aug => "aug", Self::Elite => "elite",
            Self::FiveSeven => "fiveseven", Self::Ump45 => "ump45", Self::Sg550 => "sg550",
            Self::Galil => "galil", Self::Famas => "famas", Self::Usp => "usp",
            Self::Awp => "awp", Self::M249 => "m249", Self::M3 => "m3",
            Self::M4A1 => "m4a1", Self::Tmp => "tmp", Self::G3Sg1 => "g3sg1",
            Self::Deagle => "deagle", Self::Sg552 => "sg552", Self::P90 => "p90",
        }
    }

    /// Counter-Strike 1.6 purchase price. Legacy presets keep their original
    /// OpenStrike prices so existing mods remain compatible.
    pub const fn price(self) -> i32 {
        match self {
            Self::Pistol => 400, Self::Smg => 1250, Self::Rifle => 2700,
            Self::P228 => 600, Self::Glock18 => 400, Self::Scout => 2750,
            Self::Xm1014 => 3000, Self::Mac10 => 1400, Self::Aug => 3500,
            Self::Elite => 800, Self::FiveSeven => 750, Self::Ump45 => 1700,
            Self::Sg550 => 4200, Self::Galil => 2000, Self::Famas => 2250,
            Self::Usp => 500, Self::Awp => 4750, Self::Mp5Navy => 1500,
            Self::M249 => 5750, Self::M3 => 1700, Self::M4A1 => 3100,
            Self::Tmp => 1250, Self::G3Sg1 => 5000, Self::Deagle => 650,
            Self::Sg552 => 3500, Self::Ak47 => 2500, Self::P90 => 2350,
        }
    }

    /// Damage retained per 500 world units, matching GoldSrc's range falloff
    /// convention. The legacy presets intentionally keep no falloff.
    pub const fn range_modifier(self) -> f32 {
        match self {
            Self::Pistol | Self::Smg | Self::Rifle => 1.0,
            Self::Deagle => 0.81, Self::Elite | Self::Glock18 => 0.75,
            Self::FiveSeven => 0.885, Self::P228 => 0.80, Self::Usp => 0.79,
            Self::Mac10 => 0.82, Self::Tmp => 0.85, Self::Mp5Navy => 0.84,
            Self::Ump45 => 0.82, Self::P90 => 0.885,
            Self::Ak47 | Self::Scout => 0.98, Self::Awp => 0.99,
            Self::M3 | Self::Xm1014 => 0.70,
            _ => 0.96,
        }
    }

    /// Fraction of normal damage retained after armor (GoldSrc's weapon
    /// armor ratio multiplied by its global 0.5 armor ratio).
    pub const fn armor_ratio(self) -> f32 {
        match self {
            Self::Awp => 0.4875, Self::Ak47 => 0.3875, Self::Deagle => 0.345,
            Self::M4A1 => 0.35, Self::Aug | Self::Sg552 => 0.35,
            Self::FiveSeven | Self::P90 => 0.375,
            Self::G3Sg1 | Self::Sg550 | Self::Scout => 0.375,
            Self::Pistol | Self::Smg | Self::Rifle => 1.0,
            _ => 0.25,
        }
    }

    pub fn config(self) -> WeaponConfig {
        match self {
            Self::Pistol => WeaponConfig {
                mag_size: 12,
                reserve: 36,
                fire_interval: 0.22,
                reload_time: 1.8,
                damage_body: 24,
                damage_head: 72,
            },
            Self::Smg => WeaponConfig {
                mag_size: 30,
                reserve: 90,
                fire_interval: 0.085,
                reload_time: 2.1,
                damage_body: 22,
                damage_head: 66,
            },
            Self::Rifle => WeaponConfig::default(),
            Self::P228 => cfg(13, 52, 0.15, 2.7, 32),
            Self::Glock18 => cfg(20, 120, 0.15, 2.2, 25),
            Self::Scout => cfg(10, 90, 1.25, 2.0, 75),
            Self::Xm1014 => cfg(7, 32, 0.25, 3.0, 20),
            Self::Mac10 => cfg(30, 100, 0.075, 3.15, 29),
            Self::Aug => cfg(30, 90, 0.0825, 3.3, 32),
            Self::Elite => cfg(30, 120, 0.12, 4.5, 36),
            Self::FiveSeven => cfg(20, 100, 0.15, 2.7, 20),
            Self::Ump45 => cfg(25, 100, 0.105, 3.5, 30),
            Self::Sg550 => cfg(30, 90, 0.25, 3.35, 40),
            Self::Galil => cfg(35, 90, 0.0875, 2.45, 30),
            Self::Famas => cfg(25, 90, 0.09, 3.3, 30),
            Self::Usp => cfg(12, 100, 0.15, 2.7, 34),
            Self::Awp => cfg(10, 30, 1.455, 2.5, 115),
            Self::Mp5Navy => cfg(30, 120, 0.075, 2.63, 26),
            Self::M249 => cfg(100, 200, 0.08, 4.7, 32),
            Self::M3 => cfg(8, 32, 0.875, 0.5, 20),
            Self::M4A1 => cfg(30, 90, 0.0875, 3.05, 33),
            Self::Tmp => cfg(30, 120, 0.07, 2.12, 20),
            Self::G3Sg1 => cfg(20, 90, 0.25, 4.7, 80),
            Self::Deagle => cfg(7, 35, 0.225, 2.2, 54),
            Self::Sg552 => cfg(30, 90, 0.0825, 3.0, 33),
            Self::Ak47 => cfg(30, 90, 0.1, 2.45, 36),
            Self::P90 => cfg(50, 100, 0.066, 3.4, 21),
        }
    }
}

/// Stable IDs shared by the native hosts and the PocketJS buy menu. The first
/// five retain the original OpenStrike menu layout; additional firearms use
/// IDs 5..26.
pub const BUY_WEAPONS: &[(u8, WeaponKind)] = &[
    (0, WeaponKind::Glock18), (1, WeaponKind::Mp5Navy), (2, WeaponKind::Ak47),
    (5, WeaponKind::P228), (6, WeaponKind::Scout), (7, WeaponKind::Xm1014),
    (8, WeaponKind::Mac10), (9, WeaponKind::Aug), (10, WeaponKind::Elite),
    (11, WeaponKind::FiveSeven), (12, WeaponKind::Ump45), (13, WeaponKind::Sg550),
    (14, WeaponKind::Galil), (15, WeaponKind::Famas), (16, WeaponKind::Usp),
    (17, WeaponKind::Awp), (18, WeaponKind::M249), (19, WeaponKind::M3),
    (20, WeaponKind::M4A1), (21, WeaponKind::Tmp), (22, WeaponKind::G3Sg1),
    (23, WeaponKind::Deagle), (24, WeaponKind::Sg552), (25, WeaponKind::P90),
];

pub fn buy_weapon(id: u8) -> Option<WeaponKind> {
    BUY_WEAPONS.iter().find(|(item, _)| *item == id).map(|(_, kind)| *kind)
}

const fn cfg(mag_size: u32, reserve: u32, fire_interval: f32, reload_time: f32, damage: i32) -> WeaponConfig {
    WeaponConfig { mag_size, reserve, fire_interval, reload_time, damage_body: damage, damage_head: damage * 4 }
}

/// Weapon tuning — owned by the `strike` surface (mods set it through
/// `strike.configureWeapon`). Defaults are the base game's rifle.
#[derive(Clone, Debug)]
pub struct WeaponConfig {
    pub mag_size: u32,
    pub reserve: u32,
    /// Seconds between shots (0.105 ≈ 570 rpm).
    pub fire_interval: f32,
    pub reload_time: f32,
    pub damage_body: i32,
    pub damage_head: i32,
}

impl Default for WeaponConfig {
    fn default() -> Self {
        Self {
            mag_size: 30,
            reserve: 90,
            fire_interval: 0.105,
            reload_time: 2.4,
            damage_body: 34,
            damage_head: 100,
        }
    }
}

pub struct Weapon {
    pub kind: WeaponKind,
    pub cfg: WeaponConfig,
    pub ammo: u32,
    pub reserve: u32,
    pub cooldown: f32,
    pub reload_left: f32,
    /// 0..1 visual recoil, decays.
    pub recoil: f32,
    /// `recoil` at the previous tick (the viewmodel interpolates between the
    /// two so recoil doesn't step at the tick rate on high-Hz displays).
    pub prev_recoil: f32,
}

impl Default for Weapon {
    fn default() -> Self {
        Self::with_kind(WeaponKind::Rifle)
    }
}

impl Weapon {
    pub fn with_kind(kind: WeaponKind) -> Self {
        let mut weapon = Self::with_config(kind.config());
        weapon.kind = kind;
        weapon
    }

    pub fn with_config(cfg: WeaponConfig) -> Self {
        Self {
            kind: WeaponKind::Rifle,
            ammo: cfg.mag_size,
            reserve: cfg.reserve,
            cfg,
            cooldown: 0.0,
            reload_left: 0.0,
            recoil: 0.0,
            prev_recoil: 0.0,
        }
    }

    pub fn reloading(&self) -> bool {
        self.reload_left > 0.0
    }

    pub fn can_fire(&self) -> bool {
        self.cooldown <= 0.0 && self.ammo > 0 && !self.reloading()
    }

    pub fn tick(&mut self, dt: f32) {
        self.cooldown -= dt;
        self.prev_recoil = self.recoil;
        self.recoil = (self.recoil - dt * 3.0).max(0.0);
        if self.reload_left > 0.0 {
            self.reload_left -= dt;
            if self.reload_left <= 0.0 {
                let want = self.cfg.mag_size - self.ammo;
                let take = want.min(self.reserve);
                self.ammo += take;
                self.reserve -= take;
            }
        }
    }

    pub fn trigger_reload(&mut self) {
        if !self.reloading() && self.ammo < self.cfg.mag_size && self.reserve > 0 {
            self.reload_left = self.cfg.reload_time;
        }
    }

    /// Consume one round; returns false if empty.
    pub fn fire(&mut self) -> bool {
        if !self.can_fire() {
            return false;
        }
        self.ammo -= 1;
        self.cooldown = self.cfg.fire_interval;
        self.recoil = (self.recoil + 0.35).min(1.0);
        true
    }

    /// Fresh magazine under the current config (round reset).
    pub fn reset(&mut self) {
        let kind = self.kind;
        *self = Self::with_kind(kind);
    }

    pub fn equip(&mut self, kind: WeaponKind) {
        *self = Self::with_kind(kind);
    }
}

// ---------------------------------------------------------------------------
// Timed world-space effects (flashes, tracers, impacts)
// ---------------------------------------------------------------------------

pub enum EffectKind {
    MuzzleFlash { pos: Vec3 },
    Tracer { a: Vec3, b: Vec3 },
    Impact { pos: Vec3 },
    BloodPuff { pos: Vec3 },
}

pub struct Effect {
    pub kind: EffectKind,
    pub age: f32,
    pub ttl: f32,
}

/// Renderer-agnostic effect output (the desktop maps these to scene
/// sprites/beams; the PSP draws billboards).
#[derive(Clone, Copy, Debug)]
pub struct FxSprite {
    pub pos: Vec3,
    pub size: f32,
    pub color: [f32; 4],
}

#[derive(Clone, Copy, Debug)]
pub struct FxBeam {
    pub a: Vec3,
    pub b: Vec3,
    pub width: f32,
    pub color: [f32; 4],
}

#[derive(Default)]
pub struct Effects {
    pub list: Vec<Effect>,
}

impl Effects {
    pub fn spawn(&mut self, kind: EffectKind, ttl: f32) {
        self.list.push(Effect { kind, age: 0.0, ttl });
    }

    pub fn tick(&mut self, dt: f32) {
        for e in &mut self.list {
            e.age += dt;
        }
        self.list.retain(|e| e.age < e.ttl);
    }

    pub fn clear(&mut self) {
        self.list.clear();
    }

    /// Emit sprites/beams for this frame.
    pub fn emit(&self, sprites: &mut Vec<FxSprite>, beams: &mut Vec<FxBeam>) {
        for e in &self.list {
            let f = 1.0 - (e.age / e.ttl).clamp(0.0, 1.0);
            match e.kind {
                EffectKind::MuzzleFlash { pos } => sprites.push(FxSprite {
                    pos,
                    size: 14.0 + 6.0 * f,
                    color: [1.0, 0.85, 0.4, 0.9 * f],
                }),
                EffectKind::Tracer { a, b } => beams.push(FxBeam {
                    a,
                    b,
                    width: 1.6,
                    color: [1.0, 0.9, 0.55, 0.7 * f],
                }),
                EffectKind::Impact { pos } => sprites.push(FxSprite {
                    pos,
                    size: 6.0 + 6.0 * (1.0 - f),
                    color: [0.9, 0.8, 0.6, 0.8 * f],
                }),
                EffectKind::BloodPuff { pos } => sprites.push(FxSprite {
                    pos,
                    size: 10.0 + 8.0 * (1.0 - f),
                    color: [0.75, 0.1, 0.05, 0.8 * f],
                }),
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Procedural rifle viewmodel (geometry only; platforms upload/draw it)
// ---------------------------------------------------------------------------

/// Material palette (one texel per entry on desktop; vertex colors on PSP).
pub const GUN_COLORS: [[u8; 4]; 6] = [
    [38, 38, 42, 255],   // 0 receiver: gunmetal
    [22, 22, 24, 255],   // 1 barrel: near-black
    [82, 58, 38, 255],   // 2 wood furniture
    [55, 55, 60, 255],   // 3 magazine
    [30, 30, 33, 255],   // 4 grip/sights
    [140, 120, 90, 255], // 5 accent
];

/// Where the muzzle sits in viewmodel-local space (gun points -Z).
pub const MUZZLE_LOCAL: Vec3 = Vec3::new(0.0, 0.6, -31.0);

/// One box of the rifle, in viewmodel-local space.
#[derive(Clone, Copy, Debug)]
pub struct RifleBox {
    pub min: Vec3,
    pub max: Vec3,
    /// Index into [`GUN_COLORS`].
    pub color: usize,
}

/// The rifle as boxes (receiver, barrel, furniture, ...). Kept as data so
/// each backend builds its own vertex format from one source of truth.
pub fn rifle_boxes() -> [RifleBox; 10] {
    let b = |min: Vec3, max: Vec3, color: usize| RifleBox { min, max, color };
    [
        // Receiver.
        b(Vec3::new(-1.3, -2.0, -16.0), Vec3::new(1.3, 1.6, 4.0), 0),
        // Barrel + muzzle.
        b(Vec3::new(-0.45, 0.1, -30.0), Vec3::new(0.45, 1.0, -16.0), 1),
        b(Vec3::new(-0.65, -0.05, -32.0), Vec3::new(0.65, 1.15, -30.0), 4),
        // Wood handguard under the barrel.
        b(Vec3::new(-0.95, -1.3, -26.0), Vec3::new(0.95, 0.1, -16.0), 2),
        // Magazine (slightly raked).
        b(Vec3::new(-0.95, -6.4, -10.5), Vec3::new(0.95, -2.0, -6.0), 3),
        // Pistol grip.
        b(Vec3::new(-0.85, -5.2, -1.2), Vec3::new(0.85, -2.0, 1.6), 4),
        // Stock.
        b(Vec3::new(-1.05, -2.4, 4.0), Vec3::new(1.05, 1.0, 12.5), 2),
        // Front sight + rear sight.
        b(Vec3::new(-0.18, 1.0, -29.4), Vec3::new(0.18, 2.2, -28.6), 4),
        b(Vec3::new(-0.5, 1.6, -6.0), Vec3::new(0.5, 2.3, -4.8), 4),
        // Carry-handle hint above receiver.
        b(Vec3::new(-0.4, 1.6, -4.0), Vec3::new(0.4, 2.0, 2.0), 0),
    ]
}

/// A tiny deterministic PRNG (xorshift) — reproducible headless runs.
#[derive(Clone)]
pub struct Rng(pub u64);

impl Rng {
    pub fn next_u32(&mut self) -> u32 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.0 = x;
        (x >> 32) as u32
    }

    /// Uniform in [0, 1).
    pub fn f32(&mut self) -> f32 {
        (self.next_u32() >> 8) as f32 / (1 << 24) as f32
    }

    /// Uniform in [-1, 1).
    pub fn signed(&mut self) -> f32 {
        self.f32() * 2.0 - 1.0
    }

    pub fn range(&mut self, lo: f32, hi: f32) -> f32 {
        lo + self.f32() * (hi - lo)
    }
}

#[cfg(test)]
mod tests {
    use super::{buy_weapon, Weapon, WeaponKind, BUY_WEAPONS};

    #[test]
    fn cs16_catalog_has_stable_buy_ids_and_core_timing() {
        assert_eq!(BUY_WEAPONS.len(), 24);
        assert_eq!(buy_weapon(0), Some(WeaponKind::Glock18));
        assert_eq!(buy_weapon(2), Some(WeaponKind::Ak47));
        assert_eq!(WeaponKind::Ak47.price(), 2500);
        assert_eq!(WeaponKind::Ak47.config().damage_body, 36);
        assert!((WeaponKind::Ak47.config().fire_interval - 0.1).abs() < f32::EPSILON);
        assert_eq!(WeaponKind::Awp.config().damage_body, 115);
        assert_eq!(WeaponKind::M249.config().mag_size, 100);
        assert_eq!(WeaponKind::P90.config().mag_size, 50);
    }

    #[test]
    fn held_reload_request_refills_once_without_spending_extra_reserve() {
        let mut weapon = Weapon::default();
        weapon.ammo = 23;

        for _ in 0..360 {
            weapon.tick(1.0 / 60.0);
            weapon.trigger_reload();
        }

        assert_eq!(weapon.ammo, 30);
        assert_eq!(weapon.reserve, 83);
        assert!(!weapon.reloading());
    }
}
