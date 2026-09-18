//! Platform-neutral, build-validated mod packs. Hosts publish METADATA to
//! the guest and select resources at a game initialization boundary.
#![no_std]

pub mod viewmodel;
use openstrike_character::Asset;
use openstrike_core::presentation::ShotStyle;
pub use viewmodel::ViewModel;

pub struct ModPack {
    pub id: &'static str,
    character: &'static [u8],
    viewmodel: Option<&'static [u8]>,
    pub effects: ShotStyle,
}
impl ModPack {
    pub fn character(&self) -> Asset {
        Asset::parse(self.character).expect("build-validated character")
    }
    pub fn viewmodel(&self) -> Option<ViewModel> {
        self.viewmodel
            .map(|data| ViewModel::parse(data).expect("build-validated viewmodel"))
    }
    pub fn presentation(&self) -> openstrike_core::presentation::Presentation {
        openstrike_core::presentation::Presentation {
            muzzle: self
                .viewmodel()
                .map(|m| m.muzzle())
                .unwrap_or(openstrike_core::weapon::MUZZLE_LOCAL),
            shot: self.effects,
        }
    }
}

include!(concat!(env!("OUT_DIR"), "/catalog.rs"));

pub fn get(index: usize) -> Option<&'static ModPack> {
    PACKS.get(index)
}
