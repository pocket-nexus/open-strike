//! OpenStrike's game: a modern team shooter on GoldSrc maps.
//!
//! - `world`: the map (BSP collision hulls, spawns), units.
//! - `weapons`: the guns' numbers; `arms`: one actor's hands on them (fire, recoil, spread, reload, swap, aim).
//! - `actor`: a soldier (the player or a bot): movement (jog, sprint, crouch, slide, jump, mantle), health.
//! - `combat`: shots against hit zones and the world, grenades, damage.
//! - `nav`: a walk graph flooded from the spawns, paths and cover; `ai`: the bots.
//! - `rules`: the match (team deathmatch, elimination), score, spawns, medals, the kill feed.
//! - `view`: the player's eye and first-person weapon; `rig`: the soldiers' bodies (clips, aim, IK, ragdolls).
//! - `stage`: staged scenes for looking at one thing at a time.
//! - `game`: all of it advanced at a fixed tick, and what the screen (`Frame`), the HUD and the speakers get.
//!
//! Space: Y up, GoldSrc units (1 unit = 1 inch; `UNIT` metres). Yaw 0 looks along -Z, positive yaw turns left
//! (forward = (-sin yaw, 0, -cos yaw)); pitch positive looks up.
pub mod actor;
pub mod ai;
pub mod arms;
pub mod combat;
pub mod game;
pub mod nav;
pub mod rig;
pub mod rules;
pub mod stage;
pub mod util;
pub mod view;
pub mod weapons;
pub mod world;

pub use game::{Event, Frame, Game, PlayerInput};
pub use rules::{MatchConfig, Mode};
pub use world::{Map, UNIT};
