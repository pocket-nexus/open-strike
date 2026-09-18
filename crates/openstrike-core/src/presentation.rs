//! Appearance parameters are selected at game initialization. They do not
//! change collision, hitscan, damage, or the simulation's random sequence.
use glam::Vec3;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum ShotStyle {
    #[default]
    Flame,
    Beam,
    Orb,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum ViewMotion {
    #[default]
    Rifle,
    Staff,
    Throw,
}

#[derive(Clone, Copy, Debug)]
pub struct Presentation {
    pub muzzle: Vec3,
    pub shot: ShotStyle,
    pub motion: ViewMotion,
}
impl Default for Presentation {
    fn default() -> Self {
        Self {
            muzzle: crate::weapon::MUZZLE_LOCAL,
            shot: ShotStyle::Flame,
            motion: ViewMotion::Rifle,
        }
    }
}
