# Characters

The soldiers and the first-person arms are modelled in code: there is no modelling file. This page is how they are
made and how to change them.

```
node tools/characters/build.ts [--only head,chest] [--look]   # the soldier: assets/characters/operator.glb, src/character/meta.json
node tools/weapons/build.ts [--only carbine]                  # the weapons with their first-person arms: assets/weapons/*.glb
node tools/shots.ts --only squad,portrait,poses,rear          # the soldiers in the game (studies; look at them)
node tools/shots.ts --only fp-carbine,fp-shotgun,fp-dmr,fp-reload,fp-ads   # the first-person view
node tools/characters/studio.ts --weapon carbine --camera '{"position":[-0.35,1.25,0.25],"target":[0,1,-0.2]}'   # any model, any camera
```

`--look` renders the soldier at rest in the three outfits (`out/studio/operator-front.png`, `-back`, `-head`). Look
at the pictures after every change: the numbers do not tell you what a shape looks like.

## How a model is made

| File | What |
|---|---|
| `tools/characters/sdf.ts` | shapes as signed distance fields: balls, capsules, boxes, bodies lofted through sections (`profile`); unions that blend like clay (`blend`), cuts, panels that follow a body (`over` in `operator.ts`), cloth folds |
| `tools/characters/mesh.ts` | a shape to triangles (surface nets); normals from the field at a finer scale than the triangles |
| `tools/characters/simplify.ts` | takes out the triangles a surface does not need (edge collapse within a tolerance) |
| `tools/characters/textures.ts` | the cloth's pictures, made in code (camouflage, nylon, the weave's relief) and their mapping |
| `tools/characters/gltf.ts` | the glTF writer (the weapons use it too) |
| `tools/characters/operator.ts` | **the soldier**: one function for each part of the body |
| `tools/characters/hand.ts` | **the gloved hand and forearm**, from the joints of a hand pose: the first-person arms and the soldier's hands |
| `tools/characters/outfits.ts` | the materials of each outfit (`ember`, `azure`, and `ranger` for a soldier of no team), which materials are cloth |
| `tools/weapons/arms.ts` | how a hand is posed on a weapon (the poses themselves are in each weapon's file) |
| `src/character/rig.ts` | **the skeleton**: the proportions the model is sculpted to and the game poses with |
| `src/soldiers.ts` | the pose: where every part is each frame, and the hit volumes |

## The rules of the model

- **Fifteen rigid parts** (`PARTS` in `rig.ts`). The engine poses a skinned model by a clip only, so a soldier is
  rigid parts placed by the game. Each part's origin is the joint it turns about; +X is the soldier's right, +Y up,
  +Z the back; a limb hangs down -Y. Millimetres in the tools, metres in the game.
- **A ball of cloth about every joint, on both parts that meet there**, so no pose opens a gap. Pads and gear go on
  top of that.
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
- **Budget:** the soldier is about 85,000 triangles (2.3 MB), a weapon's two arms about 30,000. All of it is loaded
  when the game starts (a model that first appears in a frame is loaded in that frame, and a frame's script has
  50 ms). `tools/characters/build.ts` prints the count of every part.

## The first-person view

`src/viewmodel.ts` places the weapon against the camera (`hip` in `src/config.ts` is where the grip sits from the
eye). The arms are nodes of the weapon's model (`arm_r`, `arm_l`), made by `arm()` from the hand poses in the
weapon's file: a pose is the wrist, the hand's directions, the fingers' curls, the thumb's joints and where the
forearm goes (`elbow`, off the picture). `fitSupport` fits the support hand to a handguard's section.

In the open the game brings the exposure down a stop (`SUN_STOPS` in `game.ts`): the meter averages a picture that
is mostly shade, and would burn out what the sun is on, the weapon in the hands first.
