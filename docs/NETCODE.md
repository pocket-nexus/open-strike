# Netcode

A room of the platform (`@threert/net`, the package's README) runs the `fps` rules module:
**the room is the authority on the match**, the clients are the authority on what they did.

**What a client decides (and the room has to take on trust, within checks):**

- *Its own movement.* The client simulates its player and sends a pose 20 times a second: position (the feet), yaw,
  pitch, speed, flags (crouched, firing, in the air, sights, reloading, sprinting), the weapon. The room relays poses
  and keeps a second of everyone's positions; it does not simulate movement and has no map.
- *What its shots hit.* Hit detection runs on the shooter's client, against the map's collision and against the
  other players' hit volumes (a head sphere, a torso capsule, limb capsules from the same skeleton that is drawn)
  placed from the interpolated poses the shooter sees, 100 ms in the past. What you see is what you hit: no leading
  for lag.

**What the client sends:** `shot {weapon, shotTime, o, e}` for every shot (the others draw its flash and tracers
from it; the room counts it against the magazine and the rate of fire), `hit {target, weapon, zone, at, shotTime}`
for every pellet that landed, `reload {weapon, time}`, `die {cause}` for a fall out of the map.

**What the room decides:** whether each claim was possible, and everything that follows. A hit is taken when the
round is live, the weapon exists and could fire then (the table's rate of fire, magazine and reload), the shooter was
alive and within the weapon's range of the point, and the target's body was at the point when the shooter saw it
there (the room rewinds by the interpolation delay, with a tolerance of 100 ms and 0.75 m). The room then computes
the damage from **its** copy of the weapon table (zone multiplier × range falloff), and owns health, deaths, respawn
times, team assignment (the smaller team), the score, the round clock, who won, and the next round. All of it comes
back as shared state (`players.<pid>`, `score`, `round`) and events (`damage`, `kill`, `respawn`, `round`, `reject`)
and is shown as it comes: the HUD never predicts a kill.

**One table.** `src/config.ts` holds the weapons once. `roomRules()` puts their damage, zones, range, falloff,
rate, magazine, reload time and pellets into the room's `meta.rules` when a room is created; the client's side of
the same table (spread, recoil, handling) stays here. A client that joins reads the room's numbers back
(`state.rules`), so a room made by another version of the game is played by its rules.

**Clocks.** Shot times are in the room's clock (`room.time`, kept from pings). Shots are timed inside a frame, so
the rate of fire is the table's at any frame rate and the room's rate check passes without slack being used up.

**Connections.** A dropped connection reconnects for 30 s as the same player (same id, same pid, same team and
score). After that, or when the room says no (full, gone), the player is in practice and told why. There is no
host: authority is the room's, so nobody's leaving moves it.

## Cheating surface, honestly

This is a client-authoritative shooter with a referee, not a server-authoritative one. A modified client can:

- **Move however it likes** (speed, flight, through walls): the room does not check movement at all.
- **Claim hits it did not earn**, as long as each is plausible: an aimbot is indistinguishable from good aim, and a
  claim through a wall is taken, because the room has no map. What the room does stop: firing faster than the
  weapon, more pellets than a shot has, shooting while dead or reloading (as the room counts it), hitting from out
  of range, hitting a player who was not near the claimed point, damage other than the table's.
- **See everyone** (poses of all players reach every client).
- **Not report being hit**: it cannot, damage is the room's.

Private rooms among friends are the intended use for anything that matters. Movement checks against the map in the
room, and server-side ray tests, are what a competitive mode would need; neither exists.

## Known limits

- Players do not collide with each other, and team-mates do not block bullets.
- The magazine of a weapon survives death: the room keeps each player's guns for the whole round, so the client
  reloads what is not full the moment it dies and the room counts that reload while the player waits to respawn. In
  free-for-all (2.5 s respawn) a slow reload can still be running for a fraction of a second after the respawn.
- Spawn protection (1.5 s, ended by firing) is known for the player only: others are not shown as protected, and
  hits on them in that time are refused by the room (`reject: protected`).
- A fall does no partial damage (the room has no "hurt yourself" event, only `die`).
- Remote soldiers are posed in code from a pose's few numbers: no ragdolls, no reload or jump animation beyond a
  tucked pose.
- The HUD is drawn by the app, from the engine's schema: a name over a player is the name under the crosshair, not
  a tag in the world. The engine's own window (`threert-render play`) draws no HUD at all.
- Bots (practice only) wander and shoot; they do not path-find, use cover or climb.
- One built-in competitive map. Imported maps: `docs/MAPS.md` (no `clip` brushes, nothing moves or breaks).
- The Maps menu is a table the app draws: its rows are clicked or tapped (the app's `hud.choose`), or chosen with the
  keys (and a gamepad's buttons, which arrive as keys). With the pointer captured for aiming, Esc lets it go to click.
