# OpenStrike — a ThreeRT game

ThreeRT path-traces three.js-style scene code in real time. This project is one game: `game.ts` (entry in
`threert.config.json`). The same file runs natively (ThreeRT for macOS / iPhone: every light traced) and as three.js in
any browser. You develop it through the `threert` CLI; never edit `.threert/` (build output).

## Loop

1. Keep a dev server running: `threert dev --detach` (bundles on every save, serves the game, reloads every client;
   `threert stop` ends it). It opens the game in ThreeRT for macOS.
2. Edit `game.ts`.
3. `threert check` — bundles, runs `setup` and three frames headless, typechecks; prints objects, lights, files the
   scene reads (and which are missing), handlers, keys, and the game's console output. Fix every error first.
4. `threert shot -o .threert/shot.png` — waits for the live view to settle and saves the traced frame. **Look at the
   image** (read the PNG) before you call a change done. `--camera '{"position":[x,y,z],"target":[x,y,z],"fov":40}'`
   to look from elsewhere; `threert camera reset` returns to the game camera.
5. Test gameplay like a player: `threert click <u> <v>` (image coordinates 0..1; it reports what was picked),
   `threert key L`, `threert event <handler> '<json>'`, `threert state`. `threert logs` shows the game's
   `console.log` lines and errors.
6. `threert render -o out.png --spp 256` for a converged still when the look matters.

Every command takes `--json`. `threert status` says what is open, the frame rate and the GPU time per frame (budget:
16.7 ms for 60 fps).

## Scene code

- Imports only from `@threert/scene` (classes as in three.js: `Scene`, `Mesh`, `*Geometry`, `MeshStandardMaterial`,
  `MeshPhysicalMaterial`, lights, `PerspectiveCamera`, `Color`, `Vector3`, `GLTFModel`, …) and `@threert/gameplay`
  (`defineGame`). No DOM, no `window`, no timers, no network: the code runs inside the engine.
- Physical units: sun `new DirectionalLight(0xffffff, 80000)` (lux) with `.setSunAngles(elevation, azimuth)` and
  `scene.environment = new SkyAtmosphere({ sun })`; point / spot lights in candela (hundreds to thousands); emissive
  surfaces in nits (`emissiveIntensity` 100–2000 glows and lights its surroundings). Night: sun below the horizon.
- There are no shadow maps, light probes or baking: shadows, bounce light and reflections come from tracing. Don't
  add fake fill lights to fake GI.
- Game state is plain JSON, changed only in `handlers` (`tx.state`, `tx.decide(cond, why)` to refuse). `frame(f)`
  reads `f.state` and sets the scene (`f.object(id)`, materials, lights, transforms, `f.time` for animation). Give
  objects you touch a stable `id`. `click` receives `{ target, point }` for the object under the cursor.
- Files (glTF models, textures) go in `assets/` and are referenced as `"assets/…"`; the dev server also serves the
  ThreeRT asset store (e.g. `assets/DamagedHelmet.glb`).
- Reference, in the engine (ThreeRT's SDK has it at `engine/`, a checkout at its root):
  `.claude/skills/threert-scene-authoring/SKILL.md` (materials, lighting, atmosphere values),
  `compare/hello/threert/*.ts` (small scenes), `games/` (full games), `tests/three-compat/README.md` (what maps how
  from three.js).

## Sharing

- iPhone: `threert dev` prints a QR code; scan it with the ThreeRT app (same code, traced on the phone).
- Web: the dev server's root URL is the three.js version of the game. `threert pack` writes a static package
  (`dist/`) any web host can serve; `threert open https://…` opens it in a client.
- threert.app: `threert publish` puts the game on the platform under a name, its address
  (`https://<name>.threert.app`). It needs `threert login` once, done by the person in a browser. Without questions:
  `threert publish --yes --name <name> --summary "…"`. Publish only when the person asks for it.

## This project (OpenStrike)

The notes above are the ThreeRT CLI's, for any project. This one is larger than a single file: `game.ts` is the
entry and the frame, the rest is in `src/` (docs/DEVELOPING.md "How it is put together"; the netcode is
docs/NETCODE.md). Numbers live in `src/config.ts`.

- Ports: `ports/pocket3d` is a port of this game to other runtimes. The game here is the canonical one: its rules,
  tables and maps are decided here and the ports follow. Game work does not change `ports/`; see ThreeRT's
  docs/PORTS.md for how ports follow the game.
- Where ThreeRT is: `node tools/setup.ts [--engine <engine checkout>] [--sdk <ThreeRT SDK or client checkout>]`
  records it in `.threert/` (never committed) and writes `.threert/tsconfig.paths.json`, which `tsconfig.json`
  extends. `THREERT_ENGINE` / `THREERT_SDK` override it for one run. No local path goes into a committed file.
- Build with the engine's toolchain: `node tools/build.ts` (`@threert/net` from ThreeRT's SDK, as the CLI does).
- Typecheck: `<engine>/node_modules/.bin/tsc -p .`.
- Tests (the real game, headless, a script as the app): `node tools/test-move.ts`, `test-weapons.ts`,
  `test-match.ts` (needs rooms: `--api https://threert.app`, or a local rooms server, which needs access to the
  ThreeRT platform), `test-maps.ts` (its room part is skipped without rooms), `node --test tools/import-bsp.test.ts`.
  Run the ones a change touches; all of them before a release.
- Sounds: `src/sound.ts` (names to files) plays through the engine's `audio` (an engine with
  `packages/gameplay/src/audio.ts`); the files are synthesized by `node tools/sounds.ts` (recipes in it; `--png`
  spectrograms to look at, since a sound cannot be listened to here).
- Pictures: `node tools/shots.ts` (look at them). The map is `src/maps/foundry.ts`.
- Maps: `docs/MAPS.md` is what a map is and how GoldSrc maps are converted: additive changes only. The converter is
  `src/import/` (plain TypeScript: the game runs it, so nothing of Node's in it); the player imports through the Maps
  menu (`src/menu.ts`) into the app's store, a developer with `tools/import-bsp.ts` into a remix. Imported maps are
  copyrighted: never commit, publish, upload or send one; tests make their own (`tools/bsp/fixture.ts`).
- The engine's files and store (docs/RUNTIME.md "Files" in the engine) are reached through `src/import/host.ts`:
  requests and answers on the host channel, nothing that waits.
- The runtime may run no promise callbacks (`.then`, `await` never resume in older engines): nothing in game code
  may wait on one. Long work is a generator stepped a few milliseconds a frame (`src/import/sliced.ts`).
