// Range: a small course of known shapes, for practice and for the scripted tests (tools/test-move.ts): a flat floor,
// a thin wall to run at, a step that can be walked over and one that cannot, a ramp that can be walked and one that
// is too steep, a tunnel to crouch through, a tower with a ladder. Built in code like Foundry.
import { MeshStandardMaterial, type Object3D } from "@threert/scene";
import { MapBuilder } from "./builder.ts";
import { collisionHash } from "./hash.ts";
import { RANGE } from "./range-course.ts";
import type { BuiltMap, Vec3 } from "./types.ts";

let made: BuiltMap | null = null;

export function range(): BuiltMap {
  if (made) return made;
  const b = new MapBuilder();
  const H = RANGE.half;
  b.box([-H, -0.5, -H], [H, 0, H], "floor");
  b.box([-H - 0.5, 0, -H - 0.5], [H + 0.5, 5, -H], "wall");
  b.box([-H - 0.5, 0, H], [H + 0.5, 5, H + 0.5], "wall");
  b.box([-H - 0.5, 0, -H], [-H, 5, H], "wall");
  b.box([H, 0, -H], [H + 0.5, 5, H], "wall");
  b.box([-5, 0, RANGE.thinWall.z - RANGE.thinWall.thickness], [5, 4, RANGE.thinWall.z], "mark");
  b.box([RANGE.step.x, 0, RANGE.step.z - 2], [RANGE.step.x + 4, RANGE.step.height, RANGE.step.z + 2], "block");
  b.box([RANGE.kerb.x, 0, RANGE.kerb.z - 2], [RANGE.kerb.x + 4, RANGE.kerb.height, RANGE.kerb.z + 2], "mark");
  const r = RANGE.ramp, s = RANGE.steep;
  b.prism("z", [[r.x, 0], [r.x - r.length, 0], [r.x - r.length, r.height]], r.z - 2, r.z + 2, "block");
  b.box([r.x - r.length - 4, 0, r.z - 2], [r.x - r.length, r.height, r.z + 2], "block");
  b.prism("z", [[s.x, 0], [s.x - s.length, 0], [s.x - s.length, s.height]], s.z - 2, s.z + 2, "mark");
  const t = RANGE.tunnel;
  b.box([t.x0, t.height, t.z - 1.5], [t.x1, t.height + 0.3, t.z + 1.5], "block");
  b.box([t.x0, 0, t.z - 1.8], [t.x1, t.height + 0.3, t.z - 1.5], "block");
  b.box([t.x0, 0, t.z + 1.5], [t.x1, t.height + 0.3, t.z + 1.8], "block");
  const w = RANGE.tower;
  b.box([-1.5, 0, w.z], [1.5, w.height, w.z + 3], "block");
  for (const x of [-0.3, 0.3]) b.pipe([x, 0, w.z - 0.12], [x, w.height + 1, w.z - 0.12], 0.03, "mark", 6);
  for (let y = 0.3; y < w.height; y += 0.3) b.pipe([-0.3, y, w.z - 0.12], [0.3, y, w.z - 0.12], 0.018, "mark", 6);

  made = {
    id: "range",
    title: "Range",
    credits: "OpenStrikeRT (built in code).",
    collision: b.collision,
    spawns: [
      { team: "a", position: [0, 0, 0], yaw: 0 },
      { team: "b", position: [6, 0, -22], yaw: 0.3 },
      { team: "b", position: [-6, 0, -24], yaw: -0.3 },
      { team: "any", position: [0, 0, -20], yaw: Math.PI },
      { team: "any", position: [12, 0, -16], yaw: 2.2 },
    ],
    sun: { azimuth: 215, elevation: 50, illuminance: 90000 },
    sky: "atmosphere",
    exposure: 14,
    bounds: { min: [...b.min] as Vec3, max: [...b.max] as Vec3 },
    killY: -10,
    ladders: [{ min: [-0.5, 0, w.z - 0.62], max: [0.5, w.height + 0.2, w.z - 0.02] }],
    hash: collisionHash(b.collision.positions, b.collision.indices),
    build(root) {
      const m = (name: string, color: number) => new MeshStandardMaterial({ name: `range ${name}`, color, roughness: 0.85 });
      (root as Object3D).add(...b.meshes({ floor: m("floor", 0x777a72), wall: m("wall", 0xa9886c), block: m("block", 0x8f9499), mark: m("mark", 0xd8a21e) }));
    },
  };
  return made;
}
