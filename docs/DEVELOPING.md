# Developing OpenStrike

The game at the repository root: TypeScript on [ThreeRT](https://github.com/meshy-dev/ThreeRT). Rules, tables and maps are decided here; the ports follow it (README.md "Ports").

## Controls

W A S D move · Shift sprint · C (or Ctrl) crouch · Space jump · mouse aim · left button fire · right button sights ·
R reload · 1 2 3 or the wheel: weapons · Tab scoreboard · M maps. Click the picture to capture the pointer; Esc lets go.

The Maps menu (M): click or tap a row; or Up / Down (W / S, the wheel) choose, Enter (Space) takes the choice,
Backspace goes back, M closes it. While it is open the keys are the menu's: the player stands still.

## Running it

In ThreeRT (macOS, iPhone): `threert dev` in this directory; once it is published, `threert open
https://openstrike.threert.app`. A private room's invitation is `https://openstrike.threert.app/#room=<CODE>`.

With the engine's toolchain alone: a checkout of [ThreeRT](https://github.com/meshy-dev/ThreeRT) with its renderer
built (beside this one, or at `THREERT_ENGINE`), and `@threert/net`, which comes with ThreeRT's SDK (an installed
ThreeRT has it; else a ThreeRT client checkout, at `THREERT_SDK`):

```
node tools/setup.ts [--engine <engine checkout>] [--sdk <ThreeRT SDK or client checkout>]   # once: says what it found
node tools/build.ts                                    # -> out/openstrike.js (the bundle)
<engine>/renderer/target/release/threert-render play out/openstrike.js --assets . --presets <engine>/presets \
    [--launch '{"room":"new","name":"Ada"}'] [--hud-log] [--store <dir>] [--pick <folder>]
```

`tools/setup.ts` records where things are in `.threert/` (not committed): `paths.json`, and `tsconfig.paths.json`,
which `tsconfig.json` extends for the typecheck. That window has real sockets and captures the pointer; it draws no
HUD (`--hud-log` prints it). `--store` is the directory it keeps the game's store in, and `--pick` answers the Maps
menu's "Import from your game folder…" with that folder in place of a dialog. How the game is opened decides where
the player goes (`host.launch`, the app's `launch` message):

| `launch` | |
|---|---|
| `room: "K7Q4MZ"` | join that room |
| `room: "new"` | a private room of your own; the HUD shows its code and the invitation |
| nothing | quick play: the public room with the most players and a free place, else a new public one |
| `practice: true` | no room: bots on the same map (`bots: n`, `targets: true` for bots that stand still) |
| `name`, `mode` (`"tdm"` / `"dm"`), `map` (an id) | the nickname; for a room this player creates, its mode and map |
| `api` | the platform's address (default `https://threert.app`; also read from the manifest's `platform.rooms`) |
| `id` | the player's stable id, when the app keeps one (the same id is the same player after a reconnection) |
| `rules` | for a room this player creates: `{scoreLimit, roundTime, respawn, intermission, protect}` |

No network, no platform at the address, a room that is full or gone, a room on a map this copy does not have: the
player is put in practice and the HUD says why.

## How it is put together

| File | What |
|---|---|
| `game.ts` | the frame: input, the player, the shots and what they met, the camera, what is sent and shown |
| `src/config.ts` | every number: movement, the weapon table, the match rules (and what a room is created with) |
| `src/player.ts` | the player's capsule: fixed 120 Hz steps, shape sweeps, steps, slopes, ladders, the crouch |
| `src/weapons.ts` | the weapons in hand: rate of fire, magazines, reloads, sights, spread, recoil |
| `src/match.ts`, `src/net.ts`, `src/practice.ts` | the match and its two sources: a room of the platform, or bots here |
| `src/soldiers.ts` | the other players: bodies built and posed in code, and the volumes shots are tested against |
| `src/viewmodel.ts`, `src/effects.ts` | the first-person weapon; flashes, tracers, sparks, marks, casings |
| `src/hud.ts`, `src/sound.ts` | the HUD's description; the sound: the game's names to files, levels, falloffs |
| `src/menu.ts` | the Maps menu (M): the maps, practice or a room on one, importing, removing |
| `src/maps/` | what a map is (`types.ts`, `docs/MAPS.md`), Foundry and Range in code, the list of maps, mounting any map |
| `src/import/` | importing a GoldSrc map in the game: the converter (plain TypeScript), the app's files and store, the player's maps |
| `maps/index.ts` | the maps a developer's copy bundles (`tools/import-bsp.ts`; empty as shipped) |
| `tools/` | the build, the weapon models (`weapons/`), textures (`assets.ts`), sounds (`sounds.ts`), pictures (`shots.ts`), the tests |

## Sound

The engine plays it (`audio` of `@threert/gameplay`, the engine's docs/RUNTIME.md "Sound"): the same mix in every app,
the listener the camera. The game names a moment, `sound(name, at?, gain?)` in `src/sound.ts`, which picks the file
(a variant, not the same twice in a row), varies its pitch and level a little, gives it a falloff (a gunshot carries
8 to 12 m at full level, a step 2.5 m) and calls `audio.play`. The player's own shots, steps and body sounds are in the
head; everything of anyone else is where it happens. Another player's shot blends the close file and the distant one
(duller, longer, echoing) between 10 and 26 m. Every file is preloaded in `setup`. The names and what plays them are
listed at the top of `src/sound.ts`.

The files (`assets/sounds/*.ogg`, 35, about 400 KiB) are synthesized by `node tools/sounds.ts` (it needs ffmpeg,
whose own Vorbis encoder it uses): noise, filters,
envelopes, swept sines, damped "metal" modes and a synthetic room, seeded, so a run writes the same files. It prints
each one's length, peak, RMS, DC and edges, and `--png` writes spectrograms to `out/sounds/`. To change a sound, change
its recipe there and run it.

The engine's sound API is newer than ThreeRT 0.4.0: build and test against an engine checkout that has
`packages/gameplay/src/audio.ts` (`THREERT_ENGINE=<it>`). An app without sound ignores the messages.

## Tests

All of them run the real game in the engine's headless renderer with a script as the app (`tools/lib/`: real
sockets for the rooms, a temporary directory as the store, scripted folder picks):

```
node tools/test-move.ts       # movement on numbers, at 30 / 60 / 120 Hz (the Range map)
node tools/test-weapons.ts    # rate of fire, recoil, bloom, reloads, the sights, damage by zone, the sounds, at 30 / 60 / 120 Hz
node tools/test-match.ts      # two players in a real room: hits, deaths, respawns, the score, a round won; the ways in
node tools/test-maps.ts       # the Maps menu: import a folder in the game, practice and a room on the map, remove it
node --test tools/import-bsp.test.ts    # the converter on maps made by the test
<engine>/node_modules/.bin/tsc -p .
```

`test-match` and the room part of `test-maps` need rooms: `--api https://threert.app` uses the real ones; a rooms
server on this machine (the default address, `http://127.0.0.1:8933`) needs access to the ThreeRT platform. Without
rooms, `test-maps` leaves its room part out and says so. `node tools/shots.ts` takes the pictures in `media/`;
`node tools/shots-imported.ts <your game folder>` takes `media/imported-de_dust2.jpg`, `imported-de_inferno.jpg` and
`maps-menu.jpg` (it imports your own copies in the game, into a temporary store that it removes again).

## Releasing

```
node tools/test-move.ts && node tools/test-weapons.ts && node tools/test-maps.ts && node --test tools/import-bsp.test.ts
node tools/test-match.ts --api https://threert.app      # two players through the real rooms
node tools/check-no-imported-maps.ts                    # imported maps never leave this machine (docs/MAPS.md)
threert publish --yes                                   # as the account that owns `openstrike`
```

The version is `version` in `threert.config.json`. The published game is https://openstrike.threert.app/.

## Assets

Everything shipped is original or CC0: `assets/CREDITS.md`. The weapons are modelled in code
(`node tools/weapons/build.ts`), the sounds synthesized in code (`node tools/sounds.ts`), the textures are Poly
Haven's (`node tools/assets.ts` copies them from the machine's asset store). `@threert/net` is not in this repository:
the ThreeRT CLI gives it to every project, and `tools/build.ts` takes it from ThreeRT's SDK (`tools/setup.ts`).
Imported maps are the players' own and never part of the game (`docs/MAPS.md`).
