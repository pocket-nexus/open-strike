//! A match without a screen: bots on both sides (the player's seat is driven by a bot's hands too, or stands idle),
//! run faster than real time, with what happened printed. For checking the rules, the navigation and the bots.
//!
//!   cargo run -p openstrike-game --release --example sim -- <bsp dir> [map] [seconds] [squad] [difficulty] [mode]
use openstrike_game::game::{Event, Game, PlayerInput, TICK};
use openstrike_game::nav::Nav;
use openstrike_game::rules::{MatchConfig, Mode};
use openstrike_game::view::WeaponMeta;
use openstrike_game::world::Map;
use std::sync::Arc;
use std::time::Instant;

fn main() -> anyhow::Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let dir = args
        .first()
        .cloned()
        .unwrap_or_else(|| "assets/maps".into());
    let map = args.get(1).cloned().unwrap_or_else(|| "de_dust2".into());
    let seconds: f32 = args.get(2).and_then(|v| v.parse().ok()).unwrap_or(120.0);
    let squad: usize = args.get(3).and_then(|v| v.parse().ok()).unwrap_or(4);
    let difficulty: usize = args.get(4).and_then(|v| v.parse().ok()).unwrap_or(1);
    let mode = if args.get(5).is_some_and(|m| m == "elim") {
        Mode::Elimination
    } else {
        Mode::Tdm
    };
    let t = Instant::now();
    let m = Arc::new(Map::load(std::path::Path::new(&format!(
        "{dir}/{map}.bsp"
    )))?);
    let t_map = t.elapsed();
    let t = Instant::now();
    let nav = Arc::new(Nav::build(&m));
    let links: usize = nav.nodes.iter().map(|n| n.links.len()).sum();
    println!(
        "{map}: spawns {}/{}, nav {} nodes {} links (map {:.0} ms, nav {:.0} ms)",
        m.spawns[0].len(),
        m.spawns[1].len(),
        nav.nodes.len(),
        links,
        t_map.as_secs_f32() * 1e3,
        t.elapsed().as_secs_f32() * 1e3
    );
    // SOLDIER=<glb>: with the bodies posed (the rig, the ragdolls), and their poses checked.
    let rig = match std::env::var("SOLDIER") {
        Ok(p) => Some(Arc::new(openstrike_game::rig::Rig::load(
            std::path::Path::new(&p),
        )?)),
        Err(_) => None,
    };
    let posed = rig.is_some();
    let mut g = Game::new(
        m,
        nav,
        MatchConfig {
            mode,
            squad,
            difficulty,
            loadout: 0,
            seed: 7,
            limit: None,
        },
        rig,
        &WeaponMeta::default(),
    );
    let mut bad = 0;
    let t = Instant::now();
    let mut shots = 0;
    let mut hits = 0;
    let mut kills = vec![];
    let frames = (seconds / (TICK * 2.0)) as usize;
    let mut moved = vec![0.0f32; g.actors.len()];
    let mut last: Vec<glam::Vec3> = g.actors.iter().map(|a| a.body.pos).collect();
    for f in 0..frames {
        g.update(TICK * 2.0, &PlayerInput::default());
        for (i, a) in g.actors.iter().enumerate() {
            let d = (a.body.pos - last[i]).length();
            if d < 200.0 {
                moved[i] += d;
            }
            last[i] = a.body.pos;
        }
        if posed && f % 7 == 0 {
            let fr = g.frame();
            for a in &fr.actors {
                if a.pose.iter().any(|v| !v.is_finite())
                    || a.weapon_pos.iter().any(|v| !v.is_finite())
                    || a.weapon_rot.iter().any(|v| !v.is_finite())
                {
                    bad += 1;
                }
            }
        }
        for e in g.events.drain(..) {
            match e {
                Event::Shot { .. } => shots += 1,
                Event::Hit { .. } => hits += 1,
                Event::Kill {
                    victim,
                    attacker,
                    headshot,
                } => kills.push((g.time, victim, attacker, headshot)),
                _ => {}
            }
        }
        if f % (30 * 20) == 0 {
            println!("  {}", g.summary());
        }
        if g.rules.over().is_some() {
            break;
        }
    }
    let real = t.elapsed().as_secs_f32();
    println!(
        "{:.0} s of play in {:.2} s ({:.0}x): {shots} shots, {hits} hits, {} kills, score {:?}, phase {:?}",
        g.time,
        real,
        g.time / real,
        kills.len(),
        g.rules.score,
        g.rules.phase
    );
    for (i, a) in g.actors.iter().enumerate() {
        let r = a.record;
        println!(
            "  {:8} team {} {:8} k {:2} d {:2} a {:2} score {:4} acc {:3.0}% hs {:2} moved {:5.0} m",
            a.name,
            a.team,
            a.arms.slots[0].def.id,
            r.kills,
            r.deaths,
            r.assists,
            r.score,
            if r.shots > 0 {
                100.0 * r.hits as f32 / r.shots as f32
            } else {
                0.0
            },
            r.headshots,
            moved[i] * 0.0254
        );
    }
    if posed {
        println!("poses: {bad} with a value that is not finite");
    }
    if let Some(first) = kills.first() {
        println!(
            "first kill at {:.1} s; {} headshots",
            first.0,
            kills.iter().filter(|k| k.3).count()
        );
    }
    Ok(())
}
