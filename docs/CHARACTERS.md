# Characters

The soldiers and the first-person arms are modelled in code: there is no modelling file. This page is how they are
made and how to change them.

```
node tools/characters/build.ts [--look]                      # the soldier: assets/characters/operator.glb, src/character/meta.json
node tools/characters/look.ts                                # the pictures again, without building
node tools/weapons/build.ts [--only carbine]                  # the weapons with their first-person arms: assets/weapons/*.glb
node tools/shots.ts --only squad,portrait,poses,rear,joints   # the soldiers in the game (studies; look at them)
node tools/bench-soldiers.ts                                  # what the soldiers cost a frame (8 bots running)
node tools/shots.ts --only fp-carbine,fp-shotgun,fp-dmr,fp-reload,fp-ads   # the first-person view
node tools/characters/studio.ts --weapon carbine --camera '{"position":[-0.35,1.25,0.25],"target":[0,1,-0.2]}'   # any model, any camera
```

`--look` renders the soldier in the bind pose in the three outfits (`out/studio/operator-front.png`, `-back`, `-head`)
and in a pose that bends every joint (`-bent`, `-bent-side`). Look at the pictures after every change: the numbers do
not tell you what a shape looks like.

## How a model is made

| File | What |
|---|---|
| `tools/characters/sdf.ts` | shapes as signed distance fields: balls, capsules, boxes, bodies lofted through sections (`profile`); unions that blend like clay (`blend`), cuts, panels that follow a body (`over` in `operator.ts`), cloth folds |
| `tools/characters/mesh.ts` | a shape to triangles (surface nets); normals from the field at a finer scale than the triangles |
| `tools/characters/simplify.ts` | takes out the triangles a surface does not need (edge collapse within a tolerance) |
| `tools/characters/textures.ts` | the cloth's pictures, made in code (camouflage, nylon, the weave's relief) and their mapping |
| `tools/characters/gltf.ts` | the glTF writer (the weapons use it too) |
| `tools/characters/operator.ts` | **the soldier**: one function for each part of the body |
| `tools/characters/skeleton.ts` | the bind pose: where each part is when the cloth is made one body |
| `tools/characters/skin.ts` | the skinned body: the parts' cloth meshed as one surface, each vertex's joints and weights |
| `tools/characters/look.ts` | the pictures of `--look`, and a small forward kinematics to pose the model in the studio |
| `tools/characters/hand.ts` | **the gloved hand and forearm**, from the joints of a hand pose: the first-person arms and the soldier's hands |
| `tools/characters/outfits.ts` | the materials of each outfit (`ember`, `azure`, and `ranger` for a soldier of no team), which materials are cloth |
| `tools/weapons/arms.ts` | how a hand is posed on a weapon (the poses themselves are in each weapon's file) |
| `src/character/rig.ts` | **the skeleton**: the proportions the model is sculpted to and the game poses with, the skinned body's joints (`SKELETON`) |
| `src/soldiers.ts` | the pose: where every part is each frame (the body's joints and the gear), and the hit volumes |

## The rules of the model

- **Fifteen parts** (`PARTS` in `rig.ts`), each in its own frame: the origin at the joint it turns about, +X the
  soldier's right, +Y up, +Z the back; a limb hangs down -Y. Millimetres in the tools, metres in the game. The game
  works out every part's frame each frame (`src/soldiers.ts`).
- **One skinned body, rigid gear.** A layer marked `skin` is cloth: the cloth of all the parts is put in the bind
  pose (`skeleton.ts`: arms out, legs apart, so no limbs run together) and meshed as one surface, skinned to the joints
  of `SKELETON` (nodes of the file named as the parts). The game poses those joints itself (the engine's
  `AnimationPose.nodes`, engine 0.5.3 and later: hence `minClient` in `threert.config.json`), so the cloth bends at
  the shoulders, elbows, hips, knees, waist and neck as one piece. Everything else (helmet, carrier, pads, gloves,
  boots) is gear: a rigid model per part (`<part>.<outfit>`), placed at the part's frame.
- **The weights come from the parts** (`skin.ts`): a vertex belongs to the joints whose parts it lies on, only among
  a joint and its skeleton neighbours, and the weights are smoothed over the surface. So the balls of cloth each part
  has about its joints are what the joint bends: make a joint bend better by shaping those balls, not by numbers.
- **Cloth inside gear is left out only where it moves with that gear's part alone**; near a joint it stays (there
  the cloth bends away from the gear). Gear keeps what of it is inside the cloth within `JOINT_ZONE` of its joints.
- **A part is a list of layers**: a shape, a material, a triangle size. Layers pass through each other (a pouch sits
  in the carrier); what ends up inside another layer is left out. One material's shapes that should read as separate
  things go in one `union`; shapes that should flow into each other go in a `blend`.
- **Nothing thin.** A panel or a strap is the body grown by its thickness and cut to a region (`over`), not a shell:
  a shell thinner than a triangle does not mesh.
- **The left limbs are the right ones mirrored** (`left()`); what only one side has (the holster, the microphone) is
  on the trunk or the head.
- **The outfits share the triangles** and differ in materials: a new outfit is an entry in `outfits.ts` and in
  `OUTFITS` (`rig.ts`). The teams must stay apart at a glance: by the whole kit (light and warm, dark and cold) and
  by the bright hook panels.
- **The hands are modelled closed on the weapon** from the carbine's hand poses (`hands.ts`): the game places them
  with the weapon and brings the forearms to the wrists.
- **Budget:** the skinned body is about 9,000 triangles (`BODY_CELL` in `build.ts`): every moving soldier is skinned
  again and its BLAS rebuilt every frame, and the CPU uploads it (M3 Max, 8 bots running: about 1 ms of skinning,
  1.8 ms of uploads, 0.9 ms of GPU more than rigid parts; `tools/bench-soldiers.ts`). The gear, about 58,000
  triangles, costs nothing a frame (instances). A weapon's two arms are about 30,000. All of it is made when the game
  starts (a model that first appears in a frame is loaded in that frame, and a frame's script has 50 ms); each body is
  posed once then, so it is a pose of its own and posing it never rebuilds the scene. `build.ts` prints the counts.

## Death

A soldier that dies becomes a ragdoll (`src/ragdoll.ts`): its skeleton as points (Verlet, constraints projected a
few times a step), started from its last live pose and moving as it moved, struck by the shot that killed it (`blow`
on its state: where the shooter was, the zone, how hard by weapon, `push` in `src/soldiers.ts`; set by the room's
`kill` event, by practice, and for the player's own body). The pelvis and the chest are rigid, joined at the waist;
knees and elbows are hinges that bend one way and not all the way; the neck, the spine and the hips are cones. Angle
limits are corrected softly (`SOFT`) and no point moves faster than `FASTEST`: a hard correction is a kick in Verlet.
The map is felt through a ray a point a frame (none for a point that has not moved); a contact plane holds only until
the next frame's ray. The weapon leaves the hands and falls as a stick of its own. Once the body has lain still for
half a second it sleeps: no pose, no skinning.

`soldiers.ts` turns the points into the parts' frames (`limp`): the same skinned body and gear as alive.
`node tools/test-ragdoll.ts` checks four deaths on numbers (down, on the floor, near where they stood, asleep) and
prints the frame script's cost; `node tools/shots.ts --only death-9,death-24,death-48,death-180,death-close` shows a
fall at 0.15, 0.4, 0.8 and 3 s. Tune by looking at those, not by numbers alone.

## The first-person view

`src/viewmodel.ts` places the weapon against the camera (`hip` in `src/config.ts` is where the grip sits from the
eye). The arms are nodes of the weapon's model (`arm_r`, `arm_l`), made by `arm()` from the hand poses in the
weapon's file: a pose is the wrist, the hand's directions, the fingers' curls, the thumb's joints and where the
forearm goes (`elbow`, off the picture). `fitSupport` fits the support hand to a handguard's section.

In the open the game brings the exposure down a stop (`SUN_STOPS` in `game.ts`): the meter averages a picture that
is mostly shade, and would burn out what the sun is on, the weapon in the hands first.
