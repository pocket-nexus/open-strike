//! Prints the first-person weapon's place in the camera's space for a staged scene (a check of view.rs).
use glam::{Quat, Vec3};
use openstrike_game::game::{Game, PlayerInput};
use openstrike_game::nav::Nav;
use openstrike_game::rules::MatchConfig;
use openstrike_game::view::WeaponMeta;
use openstrike_game::world::Map;
use std::sync::Arc;

fn main() -> anyhow::Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let m = Arc::new(Map::load(std::path::Path::new(&args[0]))?);
    let nav = Arc::new(Nav::build(&m));
    let meta = WeaponMeta::parse(&std::fs::read_to_string(&args[1]).unwrap_or_default());
    let mut g = Game::new(m, nav, MatchConfig::default(), None, &meta);
    g.stage(args.get(2).map(String::as_str).unwrap_or(""));
    for f in 0..120 {
        g.update(1.0 / 30.0, &PlayerInput::default());
        if f % 6 == 5 && f > 28 && f < 100 {
            let fr = g.frame();
            let rot = Quat::from_array(fr.rot);
            match &fr.vm {
                Some(vm) => {
                    let local =
                        rot.inverse() * (Vec3::from_array(vm.pos) - Vec3::from_array(fr.eye));
                    let fwd = rot.inverse() * (Quat::from_array(vm.rot) * Vec3::NEG_Z);
                    let up = rot.inverse() * (Quat::from_array(vm.rot) * Vec3::Y);
                    println!(
                        "t {:.2} at {:.3?} barrel {:.2?} up {:.2?} mag {:.3?} arm {:.3?} bolt {:.3}",
                        f as f32 / 30.0,
                        local,
                        fwd,
                        up,
                        vm.mag,
                        vm.arm_l,
                        vm.bolt
                    );
                }
                None => println!("no view model"),
            }
        }
    }
    Ok(())
}
