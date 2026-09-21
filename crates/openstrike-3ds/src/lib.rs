#![cfg_attr(target_os = "horizon", no_std)]
#![allow(static_mut_refs)]
#![cfg_attr(not(target_os = "horizon"), allow(dead_code))]
extern crate alloc;

mod input;
mod radar;
mod touch;

#[cfg(target_os = "horizon")]
pub mod host {
    pub fn halt(message: &str) -> ! {
        panic!("{message}")
    }
}

#[cfg(target_os = "horizon")]
extern crate self as libquickjs_sys;
#[cfg(target_os = "horizon")]
extern crate self as pocketjs_psp;
#[cfg(target_os = "horizon")]
mod quickjs;
#[cfg(target_os = "horizon")]
pub use quickjs::*;
#[cfg(target_os = "horizon")]
pub mod ffi;
#[cfg(target_os = "horizon")]
mod maps;
#[cfg(target_os = "horizon")]
mod native;
#[cfg(target_os = "horizon")]
#[allow(dead_code)]
#[path = "../../openstrike-vita/src/present_data.rs"]
mod present_data;
#[cfg(target_os = "horizon")]
#[path = "../../openstrike-vita/src/sim_boot.rs"]
mod sim_boot;
#[cfg(target_os = "horizon")]
#[path = "../../openstrike-psp/src/strike.rs"]
mod strike;
