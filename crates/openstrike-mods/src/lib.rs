//! Platform-neutral, build-validated mod packs. Hosts publish METADATA to
//! the guest and select resources at a game initialization boundary.
#![no_std]

pub mod viewmodel;
use openstrike_character::Asset;
use openstrike_core::presentation::{ShotStyle, ViewMotion};
use openstrike_core::projectile::Config as ProjectileConfig;
pub use viewmodel::ViewModel;

pub struct ModPack {
    pub id: &'static str,
    character: &'static [u8],
    viewmodel: Option<&'static [u8]>,
    pub effects: ShotStyle,
    pub motion: ViewMotion,
    pub projectile: Option<ProjectileConfig>,
    projectile_mesh: Option<&'static [u8]>,
}
impl ModPack {
    pub fn character(&self) -> Asset {
        Asset::parse(self.character).expect("build-validated character")
    }
    pub fn viewmodel(&self) -> Option<ViewModel> {
        self.viewmodel
            .map(|data| ViewModel::parse(data).expect("build-validated viewmodel"))
    }
    pub fn projectile_mesh(&self) -> Option<ViewModel> {
        self.projectile_mesh
            .map(|data| ViewModel::parse(data).expect("build-validated projectile"))
    }
    pub fn configure(&self, sim: &mut openstrike_core::StrikeSim) {
        sim.presentation = self.presentation();
        sim.projectile_config = self.projectile;
    }
    pub fn presentation(&self) -> openstrike_core::presentation::Presentation {
        openstrike_core::presentation::Presentation {
            muzzle: self
                .viewmodel()
                .map(|m| m.muzzle())
                .unwrap_or(openstrike_core::weapon::MUZZLE_LOCAL),
            shot: self.effects,
            motion: self.motion,
        }
    }
}

include!(concat!(env!("OUT_DIR"), "/catalog.rs"));

pub fn get(index: usize) -> Option<&'static ModPack> {
    PACKS.get(index)
}
