# openstrike-game

The modern game: a team shooter on the same GoldSrc maps as the rest of OpenStrike, written for hosts that have a GPU
to spare (its first host renders it with a real-time path tracer on a Mac, an iPhone, a Steam Deck and an AYN Thor).
Like `openstrike-core` it is platform-free: no renderer, no window, no audio device. Unlike the core it needs `std`
and a float unit, so the PSP, the Vita, the 3DS, the iPod and the E7 keep the core and its mods.

What is in it:

- **Matches** (`rules.rs`): team deathmatch (respawns, first to the score limit or ahead on the clock) and
  elimination (rounds without respawns, first to four), two to five a side, three skills, medals and score popups.
- **Movement** (`actor.rs`): jog, sprint, crouch, slide, jump, mantle and ladders on the BSP's collision hulls
  (`pocket3d-bsp`'s mover under them). Health comes back out of a fight.
- **Weapons** (`weapons.rs`, `arms.rs`): a carbine, an SMG, a shotgun, a marksman rifle and a pistol, each with sights,
  a recoil pattern and its recovery, spread and bloom, damage falloff and hit zones, magazine or shell reloads, the
  swap; grenades and a melee strike (`combat.rs`).
- **Bots** (`nav.rs`, `ai.rs`): a walk graph flooded from the spawn points (stairs, drops, ledges to climb), sight,
  hearing and a memory shared with the squad, a reaction time and an aim that settles, cover, grenades.
- **Bodies** (`rig.rs`): one skinned glTF soldier (`assets/models/Soldier.glb`) posed by the game: clips blended by
  speed, the spine and head on the aim, both hands on the weapon by two-bone IK, a crouch over planted feet, a ragdoll
  at death.
- **The first person** (`view.rs`): the camera and the weapon in the hands, all procedural, and a firefight's pieces
  (tracers, flashes, sparks, bullet holes, casings, blasts).

## A host's side

```rust
let map = Arc::new(Map::load(bsp_path)?);          // collision and spawns from the BSP
let nav = Arc::new(Nav::build(&map));              // where bots can walk (tens of milliseconds)
let rig = Rig::load(soldier_glb).ok().map(Arc::new);
let mut game = Game::new(map, nav, MatchConfig::default(), rig, &WeaponMeta::default());
loop {
    game.look(yaw, pitch, aim_assist, dt);         // every frame: the view (radians)
    game.update(dt, &PlayerInput { .. });          // fixed 60 Hz ticks inside
    let frame = game.frame();                      // camera, bodies' poses, the weapon, effects (metres)
    let hud = game.hud();                          // the HUD's state (JSON)
    for event in game.events.drain(..) { /* sounds */ }
}
```

Doors stand open and fragile glass is gone in this game (`world::brush_layout`): a host that draws the map should
leave the same brush entities out.

## Without a screen

```sh
cargo test -p openstrike-game                      # the rules; map tests need OPENSTRIKE_MAPS (maps/*.bsp) or assets/maps
cargo run -p openstrike-game --release --example sim -- assets/maps de_dust2 600 4 1        # a whole match of bots
cargo run -p openstrike-game --release --example sim -- assets/maps de_inferno 900 4 2 elim # ... of elimination
cargo run -p openstrike-game --release --example reach -- assets/maps/*.bsp                 # both sides joined?
```

`stage.rs` puts a teammate and an enemy in front of the player doing one thing (aiming, running, reloading, dying),
for a host's screenshots.
