// Tests of the importer on maps made here (tools/bsp/fixture.ts): no copyrighted file is read.
//
//   node --test tools/import-bsp.test.ts        (or: bun test tools/)
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { inflateSync } from "node:zlib";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { MapData } from "../src/maps/types.ts";
import { ImportError, parseBsp, parseBspSteps, parseEntities, pointContents } from "../src/import/bsp.ts";
import { drain, fromBase64, latin1, toBase64, utf8 } from "../src/import/bytes.ts";
import { zlibDeflate } from "../src/import/deflate.ts";
import { Sha256, sha256 } from "../src/maps/hash.ts";
import { ALBEDO_SATURATION, MAX_LIGHTS, UNIT, albedoGain, baseColorPalette, brushRole, convertBsp, convertSteps, mapJson, meanLuminance, candelaFromBrightness, lumens, materialClass, overcastFromEntity, parseLight, parseRad, sunFromEntity, surfaceOf, textureLight, toGame, yawFromQuake } from "../src/import/convert.ts";
import { type FixtureFace, type FixtureMap, type FixtureTexture, buildBsp, buildWad, rectZ, wall } from "./bsp/fixture.ts";
import { parseGlb } from "../src/import/glb.ts";
import { collisionBytes, collisionHash } from "./bsp/hash.ts";
import { decodePng, encodeIndexedPng, encodeRgbaPng } from "./bsp/png.ts";
import { floorBelow, floorsBelow, raycast } from "../src/import/rays.ts";
import { verifyMap } from "./bsp/verify.ts";
import { parseWad, wantedWads } from "../src/import/wad.ts";
import { importedMapFiles } from "./check-no-imported-maps.ts";
import { importBsp, importedIds, indexSource, removeMap } from "./import-bsp.ts";

// ------------------------------------------------------------------------------------------------ the fixture

/** A palette with a few known colours: 1 red, 2 green, 3 a saturated orange, 255 the key colour (blue). */
function palette(): Uint8Array {
  const p = new Uint8Array(768);
  for (let i = 0; i < 256; i++) p.set([i, i, i], i * 3);
  p.set([255, 0, 0], 3);
  p.set([0, 255, 0], 6);
  p.set([200, 120, 40], 9);
  p.set([0, 0, 255], 765);
  return p;
}

const pixels = (w: number, h: number, at: (x: number, y: number) => number) => Uint8Array.from({ length: w * h }, (_, i) => at(i % w, Math.floor(i / w)));

const TEXTURES: FixtureTexture[] = [
  // Embedded in the map: red left half, green right half; the top row is orange.
  { name: "FLOOR", width: 16, height: 16, pixels: pixels(16, 16, (x, y) => (y === 0 ? 3 : x < 8 ? 1 : 2)), palette: palette() },
  // Named only: they are in the WAD.
  { name: "WALL", width: 32, height: 16 },
  { name: "{GRATE", width: 16, height: 16 },
  { name: "~LIGHT1", width: 16, height: 16 },
  { name: "+A~LIGHT1", width: 16, height: 16 },
  { name: "!WATER", width: 16, height: 16 },
  { name: "{BLUE", width: 16, height: 16 },
  { name: "sky", width: 16, height: 16 },
  { name: "AAATRIGGER", width: 16, height: 16 },
  { name: "NOWHERE", width: 16, height: 16 },
];

const WAD_TEXTURES: FixtureTexture[] = [
  { name: "wall", width: 32, height: 16, pixels: pixels(32, 16, (x) => 100 + x), palette: palette() },
  // A grate: every other column is the key colour.
  { name: "{grate", width: 16, height: 16, pixels: pixels(16, 16, (x) => (x % 2 ? 255 : 1)), palette: palette() },
  { name: "~light1", width: 16, height: 16, pixels: pixels(16, 16, () => 250), palette: palette() },
  { name: "+a~light1", width: 16, height: 16, pixels: pixels(16, 16, () => 20), palette: palette() },
  { name: "!water", width: 16, height: 16, pixels: pixels(16, 16, () => 2), palette: palette() },
  { name: "{blue", width: 16, height: 16, pixels: pixels(16, 16, () => 255), palette: palette() },
  { name: "sky", width: 16, height: 16, pixels: pixels(16, 16, () => 200), palette: palette() },
  { name: "aaatrigger", width: 16, height: 16, pixels: pixels(16, 16, () => 3), palette: palette() },
];

/**
 * A room 512 x 512 x 256 units with its floor at z = 0, a sky for a ceiling, and in it:
 *   model 1  func_wall         a grate across the room at y = 128
 *   model 2  func_illusionary  a lamp panel on the east wall
 *   model 3  func_ladder       a ladder volume at the west wall
 *   model 4  trigger_multiple  a trigger
 *   model 5  func_water        a pool surface at z = 8
 *   model 6  func_wall         an invisible wall (render mode 2, amount 0) at y = -128
 *   model 7  func_breakable    a window (render mode 2, amount 100) at x = -64
 *   model 8  func_door_rotating  a door with an origin brush: its faces are stored around its origin
 */
function room(extra: { entities?: Record<string, string>[]; faces?: FixtureFace[] } = {}): FixtureMap {
  const faces: FixtureFace[] = [
    { texture: "FLOOR", vertices: rectZ(-256, -256, 256, 256, 0) },
    { texture: "sky", vertices: rectZ(-256, -256, 256, 256, 256, false) },
    { texture: "WALL", vertices: wall([256, 256], [-256, 256], 0, 256) },     // north wall, facing south
    { texture: "WALL", vertices: wall([-256, -256], [256, -256], 0, 256) },   // south wall, facing north
    { texture: "WALL", vertices: wall([256, -256], [256, 256], 0, 256) },     // east wall, facing west
    { texture: "NOWHERE", vertices: wall([-256, 256], [-256, -256], 0, 256) }, // west wall, facing east
    { texture: "{GRATE", vertices: wall([-64, 128], [64, 128], 0, 64), model: 1 },
    { texture: "~LIGHT1", vertices: wall([255, -16], [255, 16], 100, 132), model: 2 },
    { texture: "AAATRIGGER", vertices: rectZ(-250, -32, -240, 32, 128), model: 3 },
    { texture: "AAATRIGGER", vertices: rectZ(-250, -32, -240, 32, 0, false), model: 3 },
    { texture: "AAATRIGGER", vertices: rectZ(0, 0, 64, 64, 32), model: 4 },
    { texture: "!WATER", vertices: rectZ(100, -200, 200, -150, 8), model: 5 },
    { texture: "!WATER", vertices: rectZ(100, -200, 200, -150, 8, false), model: 5 },
    { texture: "WALL", vertices: wall([-64, -128], [64, -128], 0, 64), model: 6 },
    { texture: "WALL", vertices: wall([-64, -32], [-64, 32], 0, 64), model: 7 },
    { texture: "+A~LIGHT1", vertices: wall([-8, 0], [8, 0], -32, 32), model: 8 },
    ...(extra.faces ?? []),
  ];
  const entities: Record<string, string>[] = [
    { classname: "worldspawn", wad: "\\sierra\\half-life\\valve\\halflife.wad;\\sierra\\half-life\\cstrike\\fixture.wad;", message: "A Room" },
    { classname: "func_wall", model: "*1", rendermode: "4", renderamt: "255" },
    { classname: "func_illusionary", model: "*2" },
    { classname: "func_ladder", model: "*3" },
    { classname: "trigger_multiple", model: "*4" },
    { classname: "func_water", model: "*5", rendermode: "2", renderamt: "100" },
    { classname: "func_wall", model: "*6", rendermode: "2" },
    { classname: "func_breakable", model: "*7", rendermode: "2", renderamt: "100" },
    { classname: "func_door_rotating", model: "*8", origin: "200 200 32" },
    { classname: "light_environment", angle: "0", pitch: "-45", _light: "255 255 128 80" },
    { classname: "info_player_start", origin: "0 -64 40", angles: "0 90 0" },
    { classname: "info_player_start", origin: "32 -64 36", angle: "0" },
    { classname: "info_player_deathmatch", origin: "-100 64 48", angles: "0 180 0" },
    { classname: "light", origin: "0 0 200", _light: "255 255 255 200" },
    { classname: "light", origin: "0 4 200", _light: "255 128 0 100" },
    { classname: "light_spot", origin: "100 100 200", _light: "255 255 255 150", pitch: "-90", _cone: "30", _cone2: "45" },
    { classname: "light", origin: "50 50 200", _light: "255 255 255 300", spawnflags: "1" },
    { classname: "monster_weird", origin: "nonsense", angles: "x" },
    ...(extra.entities ?? []),
  ];
  return { entities, textures: TEXTURES, faces };
}

const wad = () => parseWad(buildWad(WAD_TEXTURES), "fixture.wad");
const convert = (map: FixtureMap = room(), relight = true) => convertBsp(parseBsp(buildBsp(map), "room.bsp"), { id: "room", wads: [wad()], relight, source: "room.bsp" });

/** The GLB's primitives with their data read out. */
function primitives(glb: Uint8Array) {
  const { json, bin } = parseGlb(glb);
  const read = (i: number) => {
    const a = json.accessors[i], v = json.bufferViews[a.bufferView];
    const bytes = bin.slice(v.byteOffset, v.byteOffset + v.byteLength);
    return a.componentType === 5126 ? Array.from(new Float32Array(bytes.buffer)) : Array.from(a.componentType === 5123 ? new Uint16Array(bytes.buffer) : new Uint32Array(bytes.buffer));
  };
  return json.meshes[0].primitives.map((p: any) => {
    const material = json.materials[p.material];
    const image = json.images[json.textures[material.pbrMetallicRoughness.baseColorTexture.index].source];
    const view = json.bufferViews[image.bufferView];
    return { material, image, png: bin.subarray(view.byteOffset, view.byteOffset + view.byteLength), positions: read(p.attributes.POSITION), normals: read(p.attributes.NORMAL), uvs: read(p.attributes.TEXCOORD_0), indices: read(p.indices) };
  });
}
const named = (glb: Uint8Array, name: string) => primitives(glb).filter((p: any) => p.material.name === name);
const near = (a: number, b: number, eps = 1e-4) => assert.ok(Math.abs(a - b) <= eps, `${a} is not ${b}`);

// ------------------------------------------------------------------------------------------------ parsing

test("the BSP is parsed: lumps, entities, embedded and named textures", () => {
  const bsp = parseBsp(buildBsp(room()), "room.bsp");
  assert.equal(bsp.models.length, 9);
  assert.equal(bsp.faces.length, 16);
  assert.equal(bsp.models[0].numFaces, 6);
  assert.deepEqual(bsp.models[0].mins, [-256, -256, 0]);
  assert.deepEqual(bsp.models[0].maxs, [256, 256, 256]);
  assert.equal(bsp.textures.length, TEXTURES.length);
  assert.equal(bsp.textures[0].name, "FLOOR");
  assert.ok(bsp.textures[0].data, "FLOOR is embedded");
  assert.equal(bsp.textures[1].data, null, "WALL is only named");
  assert.deepEqual([bsp.textures[1].width, bsp.textures[1].height], [32, 16]);
  assert.equal(bsp.entities[0].classname, "worldspawn");
  assert.equal(bsp.entities.find((e) => e.classname === "info_player_start")!.keys.origin, "0 -64 40");
  // Hull 0: empty above the floor, solid below.
  assert.equal(pointContents(bsp, bsp.models[0], 0, 0, 10), -1);
  assert.equal(pointContents(bsp, bsp.models[0], 0, 0, -10), -2);
});

test("entities: odd text does not stop the parser", () => {
  const e = parseEntities('{ "classname" "a" "k" "v" "k" "second" }\n garbage { "classname" "b" "open" "no end');
  assert.equal(e.length, 1);
  assert.deepEqual(e[0].keys, { classname: "a", k: "v" });
  assert.deepEqual(parseEntities(""), []);
});

test("the WAD is parsed: names without case, pixels, palette", () => {
  const w = wad();
  assert.equal(w.entries.size, WAD_TEXTURES.length);
  assert.ok(w.entries.has("{grate"));
  assert.deepEqual(wantedWads("\\sierra\\half-life\\valve\\halflife.wad;C:/x/CS_Dust.WAD;"), ["halflife.wad", "cs_dust.wad"]);
  assert.throws(() => parseWad(new TextEncoder().encode("WAD2aaaaaaaaaaaa"), "old.wad"), /not a GoldSrc texture archive/);
  assert.throws(() => parseWad(buildWad(WAD_TEXTURES).subarray(0, 200), "cut.wad"), /truncated/);
});

test("wrong and broken files are refused with a reason", () => {
  const good = buildBsp(room());
  const source = good.slice();
  source.set(new TextEncoder().encode("VBSP"));
  assert.throws(() => parseBsp(source, "x.bsp"), (e: Error) => e instanceof ImportError && /Source engine map/.test(e.message));
  assert.throws(() => parseBsp(buildBsp({ ...room(), version: 29 }), "x.bsp"), (e: Error) => e instanceof ImportError && /Quake map \(BSP version 29\)/.test(e.message));
  assert.throws(() => parseBsp(buildBsp({ ...room(), version: 31 }), "x.bsp"), /version is 31, expected 30/);
  assert.throws(() => parseBsp(good.subarray(0, 60), "x.bsp"), (e: Error) => e instanceof ImportError && /truncated/.test(e.message));
  assert.throws(() => parseBsp(good.subarray(0, good.length - 100), "x.bsp"), (e: Error) => e instanceof ImportError && /truncated or damaged: its models lump/.test(e.message));
  assert.throws(() => parseBsp(new Uint8Array(2), "x.bsp"), /not a map/);
  assert.throws(() => parseBsp(buildWad(WAD_TEXTURES), "x.wad"), /texture archive \(WAD3\), not a map/);
  // An index that points nowhere is found before anything walks it.
  const view = new DataView(good.buffer);
  const surfedges = view.getInt32(4 + 13 * 8, true);
  const broken = good.slice();
  new DataView(broken.buffer).setInt32(surfedges, 60000, true);
  assert.throws(() => parseBsp(broken, "x.bsp"), /damaged: a surfedge names edge 60000/);
});

// ------------------------------------------------------------------------------------------------ axes, units, winding

test("units and axes: Z up inches become Y up metres, without mirroring", () => {
  assert.deepEqual(toGame(100, 0, 0), [2.54, 0, -0]);
  assert.deepEqual(toGame(0, 100, 0).map((v) => v || 0), [0, 0, -2.54]);   // GoldSrc north (+Y) is the game's -Z
  assert.deepEqual(toGame(0, 0, 72).map((v) => v || 0), [0, 72 * UNIT, 0]); // a 72-unit player is 1.83 m
  // A rotation: east x north = up stays right-handed.
  const e = toGame(1, 0, 0), n = toGame(0, 1, 0), u = toGame(0, 0, 1);
  const cross = [e[1] * n[2] - e[2] * n[1], e[2] * n[0] - e[0] * n[2], e[0] * n[1] - e[1] * n[0]];
  near(cross[0] * u[0] + cross[1] * u[1] + cross[2] * u[2], UNIT ** 3, 1e-12);
});

test("the floor: positions, normal, winding and texture coordinates", () => {
  const { glb } = convert();
  const [floor] = named(glb, "FLOOR");
  assert.equal(floor.positions.length, 12);
  const xs = floor.positions.filter((_: number, i: number) => i % 3 === 0), ys = floor.positions.filter((_: number, i: number) => i % 3 === 1), zs = floor.positions.filter((_: number, i: number) => i % 3 === 2);
  near(Math.min(...xs), -256 * UNIT);
  near(Math.max(...xs), 256 * UNIT);
  near(Math.max(...zs), 256 * UNIT);
  for (const y of ys) near(y, 0);
  for (let i = 0; i < 12; i += 3) assert.deepEqual(floor.normals.slice(i, i + 3).map((v: number) => v || 0), [0, 1, 0]);
  // Counter-clockwise seen from above: the triangle's own normal points up.
  const [a, b, c] = floor.indices.slice(0, 3).map((i: number) => floor.positions.slice(i * 3, i * 3 + 3));
  const up = (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]);
  assert.ok(up > 0, "the floor's triangles face up");
  // Texture coordinates: u grows to the east (s = x / 16), v grows to the south (t = -y / 16), whole repeats taken off.
  for (let i = 0; i < 4; i++) {
    const qx = floor.positions[i * 3] / UNIT, qy = -floor.positions[i * 3 + 2] / UNIT;
    near(floor.uvs[i * 2], qx / 16 + 16, 1e-3);
    near(floor.uvs[i * 2 + 1], -qy / 16 + 16, 1e-3);
  }
});

test("walls face into the room and what is east stays east", () => {
  const { glb } = convert();
  const walls = named(glb, "WALL");
  assert.equal(walls.length, 1, "faces with one texture are one primitive");
  const normals = new Set<string>();
  for (let i = 0; i < walls[0].normals.length; i += 3) normals.add(walls[0].normals.slice(i, i + 3).map((v: number) => Math.round(v)).join(","));
  // North wall (GoldSrc y = 256, the game's z = -6.5) faces +Z; south wall faces -Z; east wall (x = 256) faces -X.
  assert.deepEqual([...normals].sort(), ["-1,0,0", "0,0,-1", "0,0,1"]);
  for (let i = 0; i < walls[0].positions.length; i += 3) {
    const n = walls[0].normals.slice(i, i + 3).map((v: number) => Math.round(v)).join(",");
    if (n === "-1,0,0") near(walls[0].positions[i], 256 * UNIT);
    if (n === "0,0,1") near(walls[0].positions[i + 2], -256 * UNIT);
  }
  assert.deepEqual(verifyMap(convert().map, glb).problems, []);
});

test("an entity with an origin is drawn where it stands, textured in its own space", () => {
  const { glb } = convert();
  const [door] = named(glb, "+A~LIGHT1");
  const xs = door.positions.filter((_: number, i: number) => i % 3 === 0), ys = door.positions.filter((_: number, i: number) => i % 3 === 1);
  near(Math.min(...xs), 192 * UNIT);
  near(Math.max(...xs), 208 * UNIT);
  near(Math.min(...ys), 0);
  near(Math.max(...ys), 64 * UNIT);
  // 16 units wide on a 16-pixel texture: one repeat, wherever the door stands.
  const us = door.uvs.filter((_: number, i: number) => i % 2 === 0);
  near(Math.max(...us) - Math.min(...us), 1, 1e-3);
  assert.ok(Math.min(...us) >= 0 && Math.max(...us) <= 2);
});

// ------------------------------------------------------------------------------------------------ textures, materials

test("embedded textures are written as they are, as a base colour: lifted where dark, less saturated", () => {
  const { glb, stats } = convert();
  const [floor] = named(glb, "FLOOR");
  const png = decodePng(floor.png);
  assert.deepEqual([png.width, png.height], [16, 16]);
  const at = (x: number, y: number) => Array.from(png.rgba.subarray((y * 16 + x) * 4, (y * 16 + x) * 4 + 4));
  const floorTexture = { ...TEXTURES[0], pixels: TEXTURES[0].pixels!, palette: palette() };
  const gain = albedoGain(meanLuminance(floorTexture, false), "ground");
  assert.equal(gain, 1, "a texture that is light already is not lifted");
  const expected = baseColorPalette(palette(), gain, ALBEDO_SATURATION);
  assert.deepEqual(at(0, 5), [...expected.subarray(3, 6), 255]);   // red, left
  assert.deepEqual(at(15, 5), [...expected.subarray(6, 9), 255]);  // green, right
  assert.deepEqual(at(3, 0), [...expected.subarray(9, 12), 255]);  // the top row stays the top row
  const [r, g, b] = at(0, 5);
  assert.ok(r > g && g === b && g > 0, "red keeps its hue and loses saturation");
  assert.deepEqual(Array.from(baseColorPalette(Uint8Array.of(90, 90, 90, 255, 255, 255, 0, 0, 0), 1, 0.5)), [90, 90, 90, 255, 255, 255, 0, 0, 0], "greys stay");
  // The lift: a dark brick wall (5 % reflectance) becomes a plausible one (16 %), white stays white, black black.
  near(albedoGain(0.05, "concrete"), 3.2);
  near(albedoGain(0.01, "concrete"), 4);
  near(albedoGain(0.2, "wood"), 2);
  assert.equal(albedoGain(0.6, "concrete"), 1);
  assert.equal(albedoGain(0.01, "black"), 1);
  const lifted = baseColorPalette(Uint8Array.of(0, 0, 0, 255, 255, 255, 60, 60, 60), 3, 1);
  assert.deepEqual(Array.from(lifted.subarray(0, 6)), [0, 0, 0, 255, 255, 255]);
  assert.ok(lifted[6] > 95 && lifted[6] < 110, "a dark grey is nearly three times as light, in linear light");
  assert.equal(stats.textures.embedded, 1);
  assert.deepEqual(stats.textures.wadsUsed, ["fixture.wad"]);
});

test("{ textures are alpha-keyed on palette index 255, masked and double-sided", () => {
  const { glb } = convert();
  const [grate] = named(glb, "{GRATE");
  assert.equal(grate.material.alphaMode, "MASK");
  assert.equal(grate.material.alphaCutoff, 0.5);
  assert.equal(grate.material.doubleSided, true);
  const png = decodePng(grate.png);
  const grateTexture = { ...WAD_TEXTURES[1], pixels: WAD_TEXTURES[1].pixels!, palette: palette() };
  // The key colour does not count in the texture's mean: the grate is its red bars.
  near(meanLuminance(grateTexture, true), 0.2126);
  const expected = baseColorPalette(palette(), albedoGain(meanLuminance(grateTexture, true), "metal"), ALBEDO_SATURATION);
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      const p = Array.from(png.rgba.subarray((y * 16 + x) * 4, (y * 16 + x) * 4 + 4));
      // Keyed texels are transparent and carry the texture's colour, not the key's blue.
      assert.deepEqual(p, [...expected.subarray(3, 6), x % 2 ? 0 : 255]);
    }
  }
  // An opaque texture has no alpha at all.
  assert.ok(decodePng(named(glb, "WALL")[0].png).rgba.every((v, i) => i % 4 !== 3 || v === 255));
});

test("tool textures, sky, triggers and invisible walls are not drawn; a blank { texture neither", () => {
  const { glb, stats } = convert(room({ faces: [{ texture: "{BLUE", vertices: wall([-64, 200], [64, 200], 0, 64) }, { texture: "AAATRIGGER", vertices: rectZ(-10, -10, 10, 10, 0) }] }));
  const names = primitives(glb).map((p: any) => p.material.name).sort();
  assert.deepEqual(names, ["!WATER (water)", "+A~LIGHT1", "FLOOR", "NOWHERE", "WALL", "WALL (glass61)", "{GRATE", "~LIGHT1"]);
  assert.equal(stats.skyFaces, 1);
  assert.equal(stats.brushEntities.skipped, 1);
  assert.equal(surfaceOf("SKY"), "sky");
  assert.equal(surfaceOf("clip"), "tool");
  assert.equal(surfaceOf("!lava1"), "water");
  assert.equal(surfaceOf("{fence"), "masked");
  assert.equal(surfaceOf("-0out_wall"), "opaque");
});

test("texture lights glow; their switched-off frames do not", () => {
  const { glb, stats } = convert();
  const [lamp] = named(glb, "~LIGHT1");
  assert.deepEqual(lamp.material.emissiveFactor, [1, 1, 1]);
  assert.equal(lamp.material.emissiveTexture.index, lamp.material.pbrMetallicRoughness.baseColorTexture.index);
  assert.ok(lamp.material.extensions.KHR_materials_emissive_strength.emissiveStrength >= 1000);
  assert.equal(named(glb, "+A~LIGHT1")[0].material.emissiveTexture, undefined);
  assert.deepEqual(stats.emissiveTextures, ["~LIGHT1"]);
  assert.ok(parseGlb(glb).json.extensionsUsed.includes("KHR_materials_emissive_strength"));
  assert.equal(textureLight("+0~fifties_lgt2"), "lamp");
  assert.equal(textureLight("+a~fifties_lgt2"), null);
  assert.equal(textureLight("~lab1_comp7"), "screen");
  assert.equal(textureLight("light_fixture"), null);
  assert.equal(textureLight("skkylite"), "skylight");
  assert.equal(textureLight("skkylightdim"), null);
  // A lights.rad adds names the convention does not know.
  const listed = parseRad("// lights\nFIFTIES_LGT2 255 255 255 2000\r\n\n+0WALL 255 0 0 100 // red\nnot a light line\n");
  assert.deepEqual([...listed], ["fifties_lgt2", "+0wall"]);
  assert.equal(textureLight("Fifties_Lgt2", listed), "lamp");
  assert.equal(textureLight("fifties_lgt3", listed), null);
  const withRad = convertBsp(parseBsp(buildBsp(room()), "room.bsp"), { id: "room", wads: [wad()], lightTextures: parseRad("wall 255 255 255 500") });
  assert.deepEqual(withRad.stats.emissiveTextures, ["WALL", "~LIGHT1"]);
});

test("water is one glassy sheet; translucent brushes are glass", () => {
  const { glb, stats } = convert();
  const [water] = named(glb, "!WATER (water)");
  assert.equal(water.indices.length, 6, "the back-to-back pair is drawn once");
  assert.equal(stats.water, 1);
  assert.ok(water.material.extensions.KHR_materials_transmission.transmissionFactor > 0.5);
  assert.ok(water.material.pbrMetallicRoughness.roughnessFactor < 0.1);
  const [glass] = named(glb, "WALL (glass61)");
  near(glass.material.extensions.KHR_materials_transmission.transmissionFactor, 0.61);
  assert.equal(glass.material.doubleSided, true);
});

test("material classes come from the texture's name", () => {
  assert.equal(materialClass("-0out_grss1"), "ground");
  assert.equal(materialClass("{fence3"), "metal");
  assert.equal(materialClass("crate02"), "wood");
  assert.equal(materialClass("glass_bright"), "glass");
  assert.equal(materialClass("c1a0_labw2"), "concrete");
  const { glb } = convert();
  assert.ok(named(glb, "WALL")[0].material.pbrMetallicRoughness.roughnessFactor > 0.8);
  assert.equal(named(glb, "{GRATE")[0].material.pbrMetallicRoughness.metallicFactor > 0, true);
});

test("a texture no WAD has is a placeholder, and the warning names the WADs the map asks for", () => {
  const { glb, stats, warnings } = convert();
  assert.deepEqual(stats.textures.missing, ["NOWHERE"]);
  const png = decodePng(named(glb, "NOWHERE")[0].png);
  assert.deepEqual(Array.from(png.rgba.subarray(0, 4)), [255, 0, 255, 255]);
  const warning = warnings.find((w) => w.includes("NOWHERE"))!;
  assert.match(warning, /halflife\.wad, fixture\.wad/);
  assert.match(warning, /not found: halflife\.wad/);
  assert.match(warning, /--wad/);
});

// ------------------------------------------------------------------------------------------------ collision, hash

test("collision: solid things only, welded, wound outward", () => {
  const { map, stats } = convert();
  const { positions, indices } = map.collision;
  // The world (floor, sky, 4 walls) + the grate + the invisible wall + the window + the door: 10 quads.
  assert.equal(indices.length / 3, 20);
  assert.equal(stats.collision.triangles, 20);
  // The room's 8 corners are shared by its faces.
  assert.equal(positions.length / 3, 8 + 4 * 4);
  assert.deepEqual(map.bounds, { min: [-6.5024, 0, -6.5024], max: [6.5024, 6.5024, 6.5024] });
  assert.equal(map.killY, -5);
  // The floor is hit from above at y = 0; the lamp panel, the water and the trigger are not there to hit.
  const down = raycast(map.collision, 1, 1, 1, 0, -1, 0)!;
  near(down.t, 1);
  const i = down.triangle;
  const [a, b, c] = [0, 1, 2].map((k) => positions.slice(indices[i + k] * 3, indices[i + k] * 3 + 3));
  assert.ok((b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]) > 0, "counter-clockwise seen from the open side");
  assert.equal(raycast(map.collision, 150 * UNIT, 1, 175 * UNIT, 0, -1, 0)!.t, 1, "water is not solid");
  assert.equal(raycast(map.collision, 6, 116 * UNIT, 0, 1, 0, 0)!.t > 0.49, true, "the lamp panel is not solid");
  // The invisible wall is: a ray going north from the south side stops at GoldSrc y = -128.
  near(raycast(map.collision, 0, 0.5, 5, 0, 0, -1)!.t, 5 - 128 * UNIT);
  // The sky closes the room.
  near(raycast(map.collision, 1, 1, 1, 0, 1, 0)!.t, 256 * UNIT - 1);
});

test("the hash: SHA-256 over float32 positions then uint32 indices, little-endian, and stable", () => {
  const { map } = convert();
  assert.match(map.hash, /^[0-9a-f]{64}$/);
  const bytes = Buffer.concat([Buffer.from(new Float32Array(map.collision.positions).buffer), Buffer.from(new Uint32Array(map.collision.indices).buffer)]);
  assert.deepEqual(Buffer.from(collisionBytes(map.collision)), bytes);
  assert.equal(map.hash, createHash("sha256").update(bytes).digest("hex"));
  // The same map again, and the map after a trip through JSON, hash the same.
  assert.equal(convert().map.hash, map.hash);
  assert.equal(collisionHash(JSON.parse(JSON.stringify(map)).collision), map.hash);
  // Lights do not change it; geometry does.
  assert.equal(convert(room(), false).map.hash, map.hash);
  assert.notEqual(convert(room({ faces: [{ texture: "WALL", vertices: wall([0, 0], [16, 0], 0, 16) }] })).map.hash, map.hash);
  const moved = { positions: map.collision.positions.slice(), indices: map.collision.indices };
  moved.positions[0] += 0.001;
  assert.notEqual(collisionHash(moved), map.hash);
});

// ------------------------------------------------------------------------------------------------ entities

test("spawn yaw: GoldSrc degrees from east become radians from -Z, turning left", () => {
  near(yawFromQuake(90), 0);              // north: down -Z
  near(yawFromQuake(180), Math.PI / 2);   // west: a quarter turn left
  near(yawFromQuake(0), -Math.PI / 2);    // east: a quarter turn right
  near(yawFromQuake(270), Math.PI);       // south
  near(yawFromQuake(450), 0);
  near(yawFromQuake(-90), Math.PI);
  // The direction a yaw looks in is the GoldSrc direction, converted.
  for (const deg of [0, 21, 90, 135, 255, 317]) {
    const yaw = yawFromQuake(deg);
    const q = toGame(Math.cos((deg * Math.PI) / 180), Math.sin((deg * Math.PI) / 180), 0);
    near(-Math.sin(yaw) * UNIT, q[0], 1e-9);
    near(-Math.cos(yaw) * UNIT, q[2], 1e-9);
  }
});

test("spawns: teams, feet on the floor, yaw", () => {
  const { map, stats } = convert();
  assert.deepEqual(map.spawns, [
    { team: "a", position: [0, 0.01, 1.6256], yaw: 0 },
    { team: "a", position: [0.8128, 0.01, 1.6256], yaw: -1.5708 },
    { team: "b", position: [-2.54, 0.01, -1.6256], yaw: 1.5708 },
  ]);
  assert.deepEqual(stats.spawns, { a: 2, b: 1, any: 0, inSolid: 0, noFloor: 0 });
  // A map with one kind of spawn only is a deathmatch map: anyone spawns anywhere.
  const dm = room();
  dm.entities = dm.entities.filter((e) => e.classname !== "info_player_start");
  assert.deepEqual(convert(dm).map.spawns.map((s) => s.team), ["any"]);
  // A spawn the mapper sank into the floor is reported.
  const sunk = convert(room({ entities: [{ classname: "info_player_start", origin: "0 0 -20" }] }));
  assert.equal(sunk.stats.spawns.inSolid, 1);
  assert.ok(sunk.warnings.some((w) => w.includes("inside a solid")));
});

test("light_environment becomes the sun", () => {
  const { map } = convert();
  // Shining east and 45 degrees down: the sun stands in the west (-X), 45 degrees up. setSunAngles' azimuth is
  // atan2(x, z) of the direction to the sun.
  assert.equal(map.sun!.elevation, 45);
  assert.equal(map.sun!.azimuth, -90);
  assert.equal(map.sky, "atmosphere");
  // 1000 lux per brightness unit, weighted by the colour's luminance: 255 255 128 is 0.94 of white.
  near(map.sun!.illuminance, 1000 * 80 * (0.2126 + 0.7152 + 0.0722 * ((128 / 255 + 0.055) / 1.055) ** 2.4), 1);
  assert.equal(map.sun!.color! >> 16, 255);
  assert.ok((map.sun!.color! & 255) > 128 && (map.sun!.color! & 255) < 255, "half of the saturation is kept");
  const down = sunFromEntity({ classname: "light_environment", keys: { pitch: "-90", _light: "255 255 255 100" } })!;
  assert.equal(down.elevation, 90);
  assert.equal(down.illuminance, 100000);
  assert.equal(sunFromEntity({ classname: "light_environment", keys: { angles: "-30 90 0", _light: "255 255 255 500" } })!.illuminance, 120000, "clamped");
  // Shining north (+Y, the game's -Z): the sun is in the south (+Z), azimuth 0.
  near(sunFromEntity({ classname: "light_environment", keys: { angles: "-30 90 0" } })!.azimuth, 0);
  assert.equal(sunFromEntity({ classname: "light_environment", keys: { _light: "0 0 0 0" } }), null);
  // Shining upward: a mapper's overcast day. No sun; a uniform sky, 100 lux per brightness unit over pi, in nits.
  const up = { classname: "light_environment", keys: { angles: "90 0 0", _light: "255 255 255 150" } };
  assert.equal(sunFromEntity(up), null);
  assert.deepEqual(overcastFromEntity(up), { color: 0xffffff, intensity: Math.round(15000 / Math.PI) });
  assert.equal(overcastFromEntity({ classname: "light_environment", keys: { pitch: "-60" } }), null);
  const grey = room();
  grey.entities = grey.entities.map((e) => (e.classname === "light_environment" ? { classname: "light_environment", angles: "90 0 0", _light: "255 255 255 150" } : e));
  const overcast = convert(grey).map;
  assert.equal(overcast.sun, undefined);
  assert.deepEqual(overcast.sky, { color: 0xffffff, intensity: 4775 });
  // No light_environment at all: no sun, and the game's sky without one is night.
  const night = room();
  night.entities = night.entities.filter((e) => e.classname !== "light_environment");
  assert.equal(convert(night).map.sun, undefined);
  assert.equal(convert(night).map.sky, "atmosphere");
});

test("lights: brightness to lumens, merged, capped, and none with --no-relight", () => {
  assert.deepEqual(parseLight("255 128 0 100"), { brightness: 100, color: [1, 128 / 255, 0] });
  assert.deepEqual(parseLight("50 20 20"), { brightness: 50, color: [1, 0.4, 0.4] });
  assert.deepEqual(parseLight("80"), { brightness: 80, color: [1, 1, 1] });
  assert.equal(parseLight("0 0 0 0"), null);
  // The compiler's cube law: twice the brightness is eight times the lamp, up to the cap.
  near(candelaFromBrightness(100) / candelaFromBrightness(50), 8, 1e-9);
  near(candelaFromBrightness(100), (5000 / 255) * UNIT * UNIT / 10 * 1e6, 1e-9);
  assert.equal(candelaFromBrightness(5000), 5000);
  // The room's lights: 200 is over the cap on its own.
  assert.equal(candelaFromBrightness(200), 5000);
  // Lumens: all round for a point light, into the cone for a spot (as the game turns them back into candela).
  near(lumens(100), 400 * Math.PI, 1e-9);
  near(lumens(100, Math.PI / 2), 200 * Math.PI, 1e-9);

  const { map, stats } = convert();
  // The two lights 4 units apart are one lamp; the light that starts dark is left out.
  assert.equal(map.lights!.length, 2);
  assert.deepEqual(stats.lights, { found: 4, merged: 1, dropped: 0, kept: 2 });
  const [point, spot] = map.lights!;
  assert.equal(point.type, "point");
  assert.equal(point.power, Math.round(lumens(5000)), "merged lamps stay under the cap");
  near(point.position[1], 200 * UNIT, 1e-3);
  assert.ok(point.position[2] < 0 && point.position[2] > -4 * UNIT, "between the two, nearer the brighter");
  assert.equal(spot.type, "spot");
  assert.deepEqual(spot.position, [2.54, 5.08, -2.54]);
  assert.deepEqual(spot.target, [2.54, 4.08, -2.54]);   // straight down
  near(spot.angle!, (45 * Math.PI) / 180);
  assert.equal(spot.power, Math.round(lumens(candelaFromBrightness(150), spot.angle)));

  const many = room({ entities: Array.from({ length: 100 }, (_, i) => ({ classname: "light", origin: `${(i % 10) * 40 - 200} ${Math.floor(i / 10) * 40 - 200} 100`, _light: `255 255 255 ${50 + i}` })) });
  const capped = convert(many);
  assert.equal(capped.map.lights!.length, MAX_LIGHTS);
  assert.equal(capped.map.lights![0].power >= capped.map.lights![MAX_LIGHTS - 1].power, true);
  assert.equal(capped.stats.lights.dropped, 102 - MAX_LIGHTS);

  const dark = convert(room(), false);
  assert.deepEqual(dark.map.lights, []);
  assert.equal(dark.map.sun!.elevation, 45, "the sun stays");
});

test("brush entities: what is drawn, what is solid", () => {
  const role = (classname: string, keys: Record<string, string> = {}) => brushRole({ classname, keys });
  assert.deepEqual(role("func_wall"), { draw: true, solid: true, ladder: false, water: false, transmission: 0 });
  assert.equal(role("func_illusionary").solid, false);
  assert.equal(role("func_door").solid && role("func_door").draw, true);
  assert.equal(role("func_breakable").solid, true);
  assert.deepEqual([role("trigger_hurt").draw, role("trigger_hurt").solid], [false, false]);
  assert.deepEqual([role("func_buyzone").draw, role("func_bomb_target").solid], [false, false]);
  assert.equal(role("func_ladder").ladder, true);
  assert.deepEqual([role("func_wall", { rendermode: "2" }).draw, role("func_wall", { rendermode: "2" }).solid], [false, true]);
  assert.equal(role("func_wall", { rendermode: "5", renderamt: "200" }).draw, false);
  assert.equal(role("func_wall", { rendermode: "4", renderamt: "255" }).transmission, 0);
  assert.equal(role("func_wall_toggle", { spawnflags: "1" }).solid, false);
  assert.equal(role("something_new").solid, true);

  const { map } = convert();
  assert.deepEqual(map.ladders, [{ min: [-6.35, 0, -0.8128], max: [-6.096, 3.2512, 0.8128] }]);
});

test("the map data is whole and passes its own check", () => {
  const { map, glb } = convert();
  assert.equal(map.id, "room");
  assert.equal(map.title, "A Room");
  assert.equal(map.glb, "assets/maps/room/map.glb");
  assert.match(map.credits!, /room\.bsp/);
  const checked = verifyMap(map, glb);
  assert.deepEqual(checked.problems, []);
  assert.equal(checked.spawns.checked, 3);
  assert.ok(checked.spawns.maxFloorGap <= 0.011);
  assert.deepEqual([checked.glb.materials, checked.glb.images], [8, 7], "the wall and the window share an image");
  // The check does find what is wrong.
  assert.ok(verifyMap({ ...map, hash: "0".repeat(64) }, glb).problems.some((p) => p.includes("hash")));
  assert.ok(verifyMap({ ...map, spawns: [{ team: "a", position: [0, 1, 0], yaw: 0 }] }, glb).problems.some((p) => p.includes("floor")));
  assert.ok(verifyMap(map, glb.subarray(0, glb.length - 8)).problems.length > 0);
});

// ------------------------------------------------------------------------------------------------ PNG, files

test("PNG: what is written decodes to the same pixels", () => {
  const p = palette();
  const px = pixels(7, 5, (x, y) => (x * 37 + y * 11) % 256);
  const indexed = decodePng(encodeIndexedPng(7, 5, px, p, 255));
  assert.deepEqual([indexed.width, indexed.height], [7, 5]);
  px.forEach((k, i) => assert.deepEqual(Array.from(indexed.rgba.subarray(i * 4, i * 4 + 4)), [p[k * 3], p[k * 3 + 1], p[k * 3 + 2], k === 255 ? 0 : 255]));
  const rgba = Uint8Array.from({ length: 3 * 2 * 4 }, (_, i) => (i * 53) & 255);
  assert.deepEqual(Array.from(decodePng(encodeRgbaPng(3, 2, rgba)).rgba), Array.from(rgba));
  const bad = encodeRgbaPng(3, 2, rgba);
  bad[40] ^= 1;
  assert.throws(() => decodePng(bad), /CRC/);
});

test("importing writes the map, its GLB and the index; removing takes them out; the guard sees both", () => {
  const dir = mkdtempSync(join(tmpdir(), "os-import-"));
  try {
    const maps = join(dir, "in");
    const project = join(dir, "project");
    const bspPath = join(maps, "maps", "Room.bsp");
    importBspSetup(maps, bspPath);
    assert.deepEqual(importedMapFiles(project), []);

    // The WAD is found one directory up from the map; the id is the file's name in lower case.
    const r = importBsp({ bsp: bspPath, out: project });
    assert.equal(r.id, "room");
    assert.deepEqual(r.stats.textures.missing, ["NOWHERE"]);
    assert.deepEqual(r.wadsMissing, ["halflife.wad"]);
    const written: MapData = JSON.parse(readFileSync(join(project, "maps/room/map.json"), "utf8"));
    assert.deepEqual(written, JSON.parse(JSON.stringify(r.map)));
    assert.equal(collisionHash(written.collision), written.hash);
    assert.deepEqual(verifyMap(written, new Uint8Array(readFileSync(join(project, "assets/maps/room/map.glb")))).problems, []);

    importBsp({ bsp: bspPath, out: project, id: "second-map_2" });
    assert.deepEqual(importedIds(project), ["room", "second-map_2"]);
    const index = readFileSync(join(project, "maps/index.ts"), "utf8");
    assert.equal(index, indexSource(["second-map_2", "room"]));
    assert.match(index, /import room from "\.\/room\/map\.json";\nimport second_map_2 from "\.\/second-map_2\/map\.json";\n\nexport const maps: MapData\[\] = \[room as unknown as MapData, second_map_2 as unknown as MapData\];\n$/);
    assert.deepEqual(importedMapFiles(project), ["maps/room/", "maps/second-map_2/", "maps/index.ts (it lists imported maps)", "assets/maps/room", "assets/maps/second-map_2"]);

    assert.throws(() => importBsp({ bsp: bspPath, out: project, id: "Bad Id" }), (e: Error) => e instanceof ImportError && /cannot be a map id/.test(e.message));
    assert.throws(() => importBsp({ bsp: bspPath, out: project, id: "../up" }), ImportError);
    assert.throws(() => importBsp({ bsp: join(maps, "none.bsp"), out: project }), /no such file/);

    assert.equal(removeMap(project, "room"), true);
    assert.equal(removeMap(project, "second-map_2"), true);
    assert.equal(removeMap(project, "room"), false);
    assert.equal(readFileSync(join(project, "maps/index.ts"), "utf8"), indexSource([]));
    assert.deepEqual(importedMapFiles(project), []);
    assert.equal(existsSync(join(project, "assets/maps")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** <root>/maps/Room.bsp and <root>/fixture.wad: the layout of a game directory. */
function importBspSetup(root: string, bspPath: string): void {
  mkdirSync(dirname(bspPath), { recursive: true });
  writeFileSync(bspPath, buildBsp(room()));
  writeFileSync(join(root, "fixture.wad"), buildWad(WAD_TEXTURES));
}

test("the repository's own maps/index.ts is the empty one, and holds no imported map", () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  assert.equal(readFileSync(join(root, "maps/index.ts"), "utf8"), indexSource([]));
  assert.match(indexSource([]), /\nexport const maps: MapData\[\] = \[\];\n$/);
  assert.deepEqual(importedMapFiles(root), []);
});

// ------------------------------------------------------------------------------------------------ what the game runs
// The game converts maps itself (src/import/): no zlib, no crypto, no Buffer there. Its own pieces against Node's.

test("deflate: what src/import/deflate.ts writes, zlib reads back, for runs, noise, text and far repeats", () => {
  let seed = 7;
  const rnd = () => ((seed = Math.imul(seed ^ (seed >>> 13), 0x5bd1e995) >>> 0) & 255);
  const cases: [string, Uint8Array][] = [
    ["empty", new Uint8Array(0)],
    ["one byte", Uint8Array.of(42)],
    ["a run", new Uint8Array(100000).fill(9)],
    ["noise", Uint8Array.from({ length: 70000 }, rnd)],
    ["palette rows", pixels(256, 256, (x, y) => (((x >> 4) + (y >> 3)) % 7) * 30 + (x % 3))],
    ["text", new TextEncoder().encode("the quick brown fox jumps over the lazy dog ".repeat(3000))],
    ["far repeats", (() => { const a = Uint8Array.from({ length: 40000 }, rnd); const b = new Uint8Array(120000); b.set(a); b.set(a, 40000); b.set(a.subarray(0, 32000), 80000); return b; })()],
  ];
  for (const [what, data] of cases) {
    const z = zlibDeflate(data);
    assert.deepEqual(new Uint8Array(inflateSync(z)), data, what);
  }
  const palettised = cases[4]![1];
  assert.ok(zlibDeflate(palettised).length < palettised.length / 8, "palette images compress");
});

test("base64 and latin-1 without Buffer: the same as Node's, a slice at a time", () => {
  for (const n of [0, 1, 2, 3, 4, 5, 65535, 65536, 200001]) {
    const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 73 + (i >> 7)) & 255);
    const text = drain(toBase64(bytes));
    assert.equal(text, Buffer.from(bytes).toString("base64"), `encode ${n}`);
    assert.deepEqual(drain(fromBase64(text)), bytes, `decode ${n}`);
  }
  assert.deepEqual(drain(fromBase64("AAEC/w==\n")), Uint8Array.of(0, 1, 2, 255), "padding and a line break");
  assert.throws(() => drain(fromBase64("AA*A")), /base64/);
  const steps = [...fromBase64(Buffer.alloc(300000).toString("base64"))];
  assert.ok(steps.length >= 5 && steps.every((f, i) => f > 0 && f < 1 && (i === 0 || f > steps[i - 1]!)), "it yields its progress");
  assert.equal(latin1(Uint8Array.of(0x41, 0xe9, 0x7e)), "Aé~");
  assert.deepEqual(utf8("aé€😀"), new Uint8Array(Buffer.from("aé€😀", "utf8")));
});

test("SHA-256 a piece at a time: the same as node:crypto, however the input is cut", () => {
  const data = Uint8Array.from({ length: 10007 }, (_, i) => (i * 31) & 255);
  for (const cut of [1, 7, 63, 64, 65, 1000, 20000]) {
    const h = new Sha256();
    for (let at = 0; at < data.length; at += cut) h.update(data.subarray(at, at + cut));
    assert.equal(h.hex(), createHash("sha256").update(data).digest("hex"), `pieces of ${cut}`);
  }
  for (const n of [0, 55, 56, 63, 64, 119, 120]) assert.equal(sha256(new Uint8Array(n)), createHash("sha256").update(new Uint8Array(n)).digest("hex"), `${n} bytes`);
});

test("the conversion a slice at a time is the conversion at once; floors found in one pass are floorBelow's", () => {
  const bsp = parseBsp(buildBsp(room()), "room.bsp");
  const g = convertSteps(bsp, { id: "room", wads: [wad()], source: "room.bsp", glb: "user:maps/room/map.glb" });
  const seen: number[] = [];
  let r = g.next();
  for (; !r.done; r = g.next()) seen.push(r.value.done);
  const once = convertBsp(bsp, { id: "room", wads: [wad()], source: "room.bsp", glb: "user:maps/room/map.glb" });
  assert.equal(mapJson(r.value.map), mapJson(once.map));
  assert.deepEqual(r.value.glb, once.glb);
  assert.equal(r.value.map.glb, "user:maps/room/map.glb");
  assert.equal(r.value.map.hash, collisionHash(once.map.collision), "the hash taken a slice at a time is node:crypto's");
  assert.ok(seen.length > 3 && seen.every((d, i) => d >= 0 && d <= 1 && (i === 0 || d >= seen[i - 1]!)), `progress only goes forward (${seen.length} steps)`);
  const mesh = once.map.collision;
  const points: [number, number, number][] = [[0, 2, 0], [1.5, 0.3, -1.2], [-3, 5, 3], [100, 2, 100], [0, -1, 0]];
  const floors = drain(floorsBelow(mesh, points, 3));
  assert.deepEqual(floors, points.map((p) => floorBelow(mesh, p[0], p[1], p[2], 3)));
  assert.ok(floors[0] !== null && floors[3] === null);
  assert.deepEqual([...parseBspSteps(buildBsp(room()), "room.bsp")].length > 5, true, "parsing yields between lumps");
});
