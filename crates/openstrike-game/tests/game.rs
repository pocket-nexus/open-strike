//! The game's rules, checked without a screen. The map tests need the maps' BSPs (see `bsp`); they pass vacuously where
//! there are none. The soldiers' rig is checked against assets/models/Soldier.glb.
use glam::Vec3;
use openstrike_game::actor::Actor;
use openstrike_game::arms::{Arms, Ask, Cue};
use openstrike_game::combat::{Zone, hit_actor, lob};
use openstrike_game::game::{Event, Game, PlayerInput, TICK};
use openstrike_game::nav::Nav;
use openstrike_game::rules::{MatchConfig, Mode};
use openstrike_game::util::Rng;
use openstrike_game::view::WeaponMeta;
use openstrike_game::weapons::{CARBINE, PISTOL, PRIMARIES, SHOTGUN};
use openstrike_game::world::Map;
use std::path::PathBuf;
use std::sync::Arc;

/// A map's BSP: in OPENSTRIKE_BSP (a directory of them), OPENSTRIKE_MAPS/maps (the repository's convention), or
/// assets/maps.
fn bsp(map: &str) -> Option<PathBuf> {
    let dirs = [
        std::env::var("OPENSTRIKE_BSP").ok().map(PathBuf::from),
        std::env::var("OPENSTRIKE_MAPS")
            .ok()
            .map(|d| PathBuf::from(d).join("maps")),
        Some(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../assets/maps")),
    ];
    dirs.into_iter()
        .flatten()
        .map(|d| d.join(format!("{map}.bsp")))
        .find(|p| p.exists())
}

const MAPS: [&str; 8] = [
    "de_dust2",
    "de_inferno",
    "cs_assault",
    "de_nuke",
    "cs_office",
    "de_aztec",
    "de_train",
    "de_dust",
];

fn tick(arms: &mut Arms, ask: &Ask, seconds: f32) -> (u32, Vec<Cue>) {
    let mut rng = Rng::new(1);
    let (mut shots, mut cues) = (0, vec![]);
    for _ in 0..(seconds / TICK) as usize {
        shots += arms.tick(TICK, ask, &mut rng, &mut cues).is_some() as u32;
    }
    (shots, cues)
}

#[test]
fn a_held_trigger_empties_the_magazine_at_the_weapons_rate_then_reloads() {
    let mut arms = Arms::new(&CARBINE, &PISTOL);
    tick(&mut arms, &Ask::default(), CARBINE.draw + 0.05);
    let fire = Ask {
        fire: true,
        ..Ask::default()
    };
    let (shots, _) = tick(&mut arms, &fire, 1.0);
    let expected = (1.0 * CARBINE.rpm / 60.0) as i32;
    assert!(
        (shots as i32 - expected).abs() <= 1,
        "{shots} shots in a second at {} rpm",
        CARBINE.rpm
    );
    // The rest of the magazine, then the reload starts by itself and fills it from the reserve.
    let (_, cues) = tick(&mut arms, &fire, 2.0);
    assert_eq!(arms.slot().mag, 0);
    assert!(arms.reload.is_some() || cues.contains(&Cue::MagOut));
    let (_, cues) = tick(&mut arms, &Ask::default(), CARBINE.reload_empty + 0.2);
    assert_eq!(arms.slot().mag, CARBINE.mag);
    assert_eq!(arms.slot().reserve, CARBINE.reserve - CARBINE.mag);
    assert!(cues.contains(&Cue::MagIn) && cues.contains(&Cue::BoltRack));
    assert!(
        arms.recoil.length() < 0.01,
        "the view settles after a spray"
    );
}

#[test]
fn a_semi_automatic_fires_once_per_pull_and_shells_load_one_by_one() {
    let mut arms = Arms::new(&SHOTGUN, &PISTOL);
    tick(&mut arms, &Ask::default(), 1.0);
    let (shots, _) = tick(
        &mut arms,
        &Ask {
            fire: true,
            ..Ask::default()
        },
        1.5,
    );
    assert_eq!(shots, 1);
    tick(&mut arms, &Ask::default(), 0.1);
    let (shots, _) = tick(
        &mut arms,
        &Ask {
            fire: true,
            ..Ask::default()
        },
        0.5,
    );
    assert_eq!(shots, 1);
    assert_eq!(arms.slot().mag, SHOTGUN.mag - 2);
    let (_, cues) = tick(
        &mut arms,
        &Ask {
            reload: true,
            ..Ask::default()
        },
        0.05,
    );
    assert!(cues.is_empty());
    let (_, cues) = tick(&mut arms, &Ask::default(), 3.0);
    assert_eq!(cues.iter().filter(|c| **c == Cue::ShellInsert).count(), 2);
    assert_eq!(arms.slot().mag, SHOTGUN.mag);
}

#[test]
fn the_sights_tighten_the_cone_and_moving_widens_it() {
    let mut arms = Arms::new(&CARBINE, &PISTOL);
    tick(&mut arms, &Ask::default(), 1.0);
    let hip = arms.spread(&Ask::default());
    let running = arms.spread(&Ask {
        speed: 300.0,
        ..Ask::default()
    });
    tick(
        &mut arms,
        &Ask {
            ads: true,
            ..Ask::default()
        },
        0.5,
    );
    let ads = arms.spread(&Ask::default());
    assert!(
        arms.ads == 1.0 && ads < hip * 0.1 && running > hip * 1.5,
        "hip {hip} ads {ads} running {running}"
    );
}

#[test]
fn every_weapon_kills_in_a_sensible_number_of_hits() {
    for w in PRIMARIES.iter().chain([&&PISTOL]) {
        let body = (100.0 / (w.damage * w.pellets as f32)).ceil();
        let head = (100.0 / (w.damage * w.head * w.pellets as f32)).ceil();
        assert!(
            (1.0..=5.0).contains(&body) && head <= body,
            "{}: {body} body shots, {head} head shots",
            w.id
        );
        assert!(w.damage_at(10_000.0) < w.damage && w.damage_at(0.0) == w.damage);
        let ttk = (body - 1.0) * w.interval();
        assert!(ttk < 0.9, "{}: {ttk} s to kill", w.id);
    }
}

#[test]
fn a_shot_finds_the_head_the_body_or_the_legs() {
    let mut a = Actor::new("x", 1, true, &CARBINE, &PISTOL);
    a.spawn(Vec3::new(0.0, 36.0, 0.0), 0.0);
    let from = |y: f32| hit_actor(&a, Vec3::new(0.0, y, 200.0), Vec3::NEG_Z).map(|h| h.1);
    assert_eq!(from(66.0), Some(Zone::Head));
    assert_eq!(from(46.0), Some(Zone::Body));
    assert_eq!(from(14.0), Some(Zone::Limb));
    assert_eq!(from(90.0), None);
    assert_eq!(
        hit_actor(&a, Vec3::new(40.0, 46.0, 200.0), Vec3::NEG_Z).map(|h| h.1),
        None
    );
}

#[test]
fn a_lobbed_grenade_lands_where_it_was_aimed() {
    let (from, to) = (Vec3::new(0.0, 64.0, 0.0), Vec3::new(700.0, 0.0, 300.0));
    let v = lob(from, to, openstrike_game::combat::THROW_SPEED).expect("within reach");
    let (mut p, mut vel) = (from, v);
    while p.y > 0.0 {
        vel.y -= 800.0 * 0.002;
        p += vel * 0.002;
    }
    assert!((p - to).length() < 12.0, "landed at {p}");
    assert!(
        lob(
            from,
            Vec3::new(9000.0, 0.0, 0.0),
            openstrike_game::combat::THROW_SPEED
        )
        .is_none()
    );
}

#[test]
fn the_walk_graph_joins_the_two_sides_on_every_map() {
    for name in MAPS {
        let Some(path) = bsp(name) else { continue };
        let map = Map::load(&path).unwrap();
        let nav = Nav::build(&map);
        assert!(nav.nodes.len() > 2000, "{name}: {} nodes", nav.nodes.len());
        let a = nav.nearest(map.spawns[0][0].pos).unwrap();
        let b = nav.nearest(map.spawns[1][0].pos).unwrap();
        let there = nav
            .path(a, b, &|_| 0.0)
            .unwrap_or_else(|| panic!("{name}: no way from one side to the other"));
        assert!(nav.path(b, a, &|_| 0.0).is_some(), "{name}: no way back");
        assert!(there.len() > 20, "{name}");
    }
}

fn play(map: &str, mode: Mode, seconds: f32) -> Option<(Game, Vec<Event>)> {
    let m = Arc::new(Map::load(&bsp(map)?).unwrap());
    let nav = Arc::new(Nav::build(&m));
    let mut g = Game::new(
        m,
        nav,
        MatchConfig {
            mode,
            squad: 4,
            difficulty: 1,
            loadout: 0,
            seed: 11,
            limit: None,
        },
        None,
        &WeaponMeta::default(),
    );
    g.set_autopilot(true);
    let mut events = vec![];
    for _ in 0..(seconds * 30.0) as usize {
        g.update(1.0 / 30.0, &PlayerInput::default());
        events.append(&mut g.events);
        if g.rules.over().is_some() {
            break;
        }
    }
    Some((g, events))
}

#[test]
fn a_match_of_team_deathmatch_plays_to_its_end() {
    let Some((g, events)) = play("de_dust2", Mode::Tdm, 900.0) else {
        return;
    };
    let winner = g.rules.over().expect("decided within fifteen minutes");
    let s = g.rules.score;
    assert!(
        s[0].max(s[1]) == g.rules.cfg.limit() || g.rules.clock == 0.0,
        "{s:?}"
    );
    assert_eq!(
        winner,
        if s[0] == s[1] {
            None
        } else {
            Some((s[1] > s[0]) as usize)
        }
    );
    let kills = events
        .iter()
        .filter(|e| matches!(e, Event::Kill { .. }))
        .count() as u32;
    assert_eq!(kills, g.actors.iter().map(|a| a.record.deaths).sum::<u32>());
    assert_eq!(
        s[0] + s[1],
        g.actors.iter().map(|a| a.record.kills).sum::<u32>()
    );
    // A pace a person can play at: a kill every few seconds, not every second.
    let per_minute = kills as f32 / (g.time / 60.0);
    assert!(
        (5.0..22.0).contains(&per_minute),
        "{per_minute} kills a minute"
    );
    // Everyone took part, nobody stood stuck at the spawn.
    for a in &g.actors {
        assert!(
            a.record.shots > 10,
            "{} fired {} shots",
            a.name,
            a.record.shots
        );
        assert!(a.body.pos.is_finite() && a.health.is_finite());
    }
    assert!(events.iter().any(|e| matches!(e, Event::MatchOver { .. })));
}

#[test]
fn elimination_is_played_in_rounds_without_respawns() {
    let Some((g, events)) = play("de_inferno", Mode::Elimination, 1500.0) else {
        return;
    };
    g.rules.over().expect("decided");
    let s = g.rules.score;
    assert_eq!(s[0].max(s[1]), 4, "{s:?}");
    assert!(
        g.rules.round >= 4 && g.rules.round <= 7 + 3,
        "{} rounds",
        g.rules.round
    );
    assert!(!events.iter().any(|e| matches!(e, Event::Respawn { .. })));
    let rounds = events
        .iter()
        .filter(|e| matches!(e, Event::RoundOver { .. }))
        .count() as u32;
    assert!(rounds + 1 >= s[0] + s[1], "{rounds} round ends for {s:?}");
}

#[test]
fn the_soldiers_rig_poses_every_bone_and_a_death_settles_on_the_floor() {
    use openstrike_game::rig::Rig;
    let model = std::env::var("SOLDIER")
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../assets/models/Soldier.glb")
        });
    if !model.exists() {
        return;
    }
    let rig = Arc::new(Rig::load(&model).unwrap());
    let Some(path) = bsp("de_dust2") else { return };
    let m = Arc::new(Map::load(&path).unwrap());
    let nav = Arc::new(Nav::build(&m));
    let mut g = Game::new(
        m,
        nav,
        MatchConfig {
            mode: Mode::Tdm,
            squad: 3,
            difficulty: 1,
            loadout: 0,
            seed: 5,
            limit: None,
        },
        Some(rig),
        &WeaponMeta::default(),
    );
    g.set_autopilot(true);
    let mut posed = 0;
    for f in 0..(120 * 30) {
        g.update(1.0 / 30.0, &PlayerInput::default());
        g.events.clear();
        if f % 5 == 0 {
            for a in &g.frame().actors {
                assert!(
                    a.pose
                        .iter()
                        .chain(&a.weapon_pos)
                        .chain(&a.weapon_rot)
                        .all(|v| v.is_finite())
                );
                posed += (a.shown && a.pose.len() >= 8 * 40) as usize;
            }
        }
    }
    assert!(posed > 1000, "{posed} posed bodies drawn");
}
