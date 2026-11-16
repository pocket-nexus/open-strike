//! Exercise authored spawns without relocating the player or enemies.
use glam::Vec3;
use openstrike_core::{Phase, SimInput, StrikeSim};
use pocket3d_bsp::cooked;
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let bytes = std::fs::read(std::env::args().nth(1).ok_or("map.p3d required")?)?;
    let map = cooked::read(&bytes)?;
    let spawn = map.ct_spawns.first().ok_or("no player spawn")?;
    if map.t_spawns.len() < 3 {
        return Err("need three authored bot spawns".into());
    }
    for firing in [false, true] {
        let mut sim = StrikeSim::new(spawn.pos, spawn.yaw, map.t_spawns.clone(), 3);
        sim.phase = Phase::Live;
        let mut shots = 0;
        for _ in 0..64 * 20 {
            let mut input = SimInput::default();
            if firing {
                if let Some(bot) = sim.bots.iter().find(|b| b.alive()) {
                    let d = bot.state.pos + Vec3::Y * 5.0 - sim.player.eye();
                    sim.player.yaw = (-d.x).atan2(-d.z);
                    sim.player.pitch = d.y.atan2((d.x * d.x + d.z * d.z).sqrt());
                    input.fire = true;
                    input.reload = sim.weapon.ammo == 0;
                }
            }
            sim.tick(&map.collision, openstrike_core::clock::TICK_SECONDS, &input);
            shots += usize::from(sim.fired_this_tick);
            if (firing && sim.alive_bots() == 0) || (!firing && sim.player.health < 100) {
                break;
            }
        }
        if firing && sim.alive_bots() != 0 {
            return Err("authored spawn encounter cannot be completed in 20 seconds".into());
        }
        if !firing && sim.player.health == 100 {
            return Err("bots cannot attack player from authored spawn encounter".into());
        }
        println!(
            "{}: firing={firing}, player_hp={}, enemies={}, shots={shots}, elapsed={:.2}s",
            map.name,
            sim.player.health,
            sim.alive_bots(),
            sim.time
        );
    }
    Ok(())
}
