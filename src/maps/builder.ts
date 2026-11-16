// Builds a map in code: boxes, prisms (ramps, wedges) and cylinders, each drawn with a named material and, unless
// said otherwise, solid. It keeps two things apart: what is seen (merged into one mesh a material, world-mapped
// textures need no UVs) and what bodies and bullets hit (one list of triangles: MapData.collision).
import { BufferGeometry, Float32BufferAttribute, Mesh, type MeshStandardMaterial } from "@threert/scene";
import type { Vec3 } from "./types.ts";

interface Buffers { pos: number[]; nor: number[]; idx: number[] }
export interface Solid {
  /** Not drawn (a ramp under a flight of steps, a blocker). */
  hidden?: boolean;
  /** Drawn, but nothing hits it (a pipe overhead, a lamp, trim). */
  ghost?: boolean;
}

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

export class MapBuilder {
  private readonly drawn = new Map<string, Buffers>();
  readonly collision = { positions: [] as number[], indices: [] as number[] };
  readonly min: Vec3 = [Infinity, Infinity, Infinity];
  readonly max: Vec3 = [-Infinity, -Infinity, -Infinity];

  /** A convex polygon (3 or more corners in one plane), facing away from `inside`. */
  face(corners: Vec3[], inside: Vec3, material: string | null, o: Solid = {}): void {
    let n = cross(sub(corners[1]!, corners[0]!), sub(corners[2]!, corners[0]!));
    const l = Math.hypot(n[0], n[1], n[2]) || 1;
    n = [n[0] / l, n[1] / l, n[2] / l];
    let pts = corners;
    if (dot(n, sub(corners[0]!, inside)) < 0) {
      n = [-n[0], -n[1], -n[2]];
      pts = [...corners].reverse();
    }
    if (material && !o.hidden) {
      let b = this.drawn.get(material);
      if (!b) this.drawn.set(material, (b = { pos: [], nor: [], idx: [] }));
      const base = b.pos.length / 3;
      for (const p of pts) { b.pos.push(p[0], p[1], p[2]); b.nor.push(n[0], n[1], n[2]); }
      for (let i = 1; i + 1 < pts.length; i++) b.idx.push(base, base + i, base + i + 1);
    }
    if (!o.ghost) {
      const c = this.collision;
      const base = c.positions.length / 3;
      for (const p of pts) {
        c.positions.push(p[0], p[1], p[2]);
        for (let k = 0; k < 3; k++) { this.min[k] = Math.min(this.min[k]!, p[k]!); this.max[k] = Math.max(this.max[k]!, p[k]!); }
      }
      for (let i = 1; i + 1 < pts.length; i++) c.indices.push(base, base + i, base + i + 1);
    }
  }

  /** An axis-aligned box from `a` to `b` (any two opposite corners). */
  box(a: Vec3, b: Vec3, material: string | null, o: Solid = {}): void {
    const x0 = Math.min(a[0], b[0]), x1 = Math.max(a[0], b[0]), y0 = Math.min(a[1], b[1]), y1 = Math.max(a[1], b[1]), z0 = Math.min(a[2], b[2]), z1 = Math.max(a[2], b[2]);
    const c: Vec3 = [(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2];
    const f = (p: Vec3[]) => this.face(p, c, material, o);
    f([[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]]);
    f([[x1, y0, z0], [x1, y0, z1], [x1, y1, z1], [x1, y1, z0]]);
    f([[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]]);
    f([[x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]]);
    f([[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0]]);
    f([[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]]);
  }

  /**
   * A convex profile extruded along an axis. `along: "z"`: the profile is (x, y), from z = `from` to `to`;
   * `along: "x"`: the profile is (z, y), from x = `from` to `to`. A ramp is a triangle.
   */
  prism(along: "x" | "z", profile: [number, number][], from: number, to: number, material: string | null, o: Solid = {}): void {
    const at = (p: [number, number], t: number): Vec3 => (along === "z" ? [p[0], p[1], t] : [t, p[1], p[0]]);
    const mid: [number, number] = [profile.reduce((s, p) => s + p[0], 0) / profile.length, profile.reduce((s, p) => s + p[1], 0) / profile.length];
    const c = at(mid, (from + to) / 2);
    this.face(profile.map((p) => at(p, from)), c, material, o);
    this.face(profile.map((p) => at(p, to)), c, material, o);
    for (let i = 0; i < profile.length; i++) {
      const p = profile[i]!, q = profile[(i + 1) % profile.length]!;
      this.face([at(p, from), at(q, from), at(q, to), at(p, to)], c, material, o);
    }
  }

  /** An upright cylinder (drawn with `sides` faces; it collides as that prism). */
  cylinder(center: Vec3, radius: number, height: number, material: string | null, o: Solid & { sides?: number } = {}): void {
    const n = o.sides ?? 16;
    const ring = (y: number): Vec3[] => Array.from({ length: n }, (_, i) => [center[0] + radius * Math.cos((i / n) * 2 * Math.PI), y, center[2] + radius * Math.sin((i / n) * 2 * Math.PI)] as Vec3);
    const lo = ring(center[1]), hi = ring(center[1] + height);
    const c: Vec3 = [center[0], center[1] + height / 2, center[2]];
    this.face(lo, c, material, o);
    this.face(hi, c, material, o);
    for (let i = 0; i < n; i++) this.face([lo[i]!, lo[(i + 1) % n]!, hi[(i + 1) % n]!, hi[i]!], c, material, o);
  }

  /** A cylinder between two points (pipes, rails): drawn only. */
  pipe(a: Vec3, b: Vec3, radius: number, material: string, sides = 8): void {
    const d = sub(b, a);
    const l = Math.hypot(d[0], d[1], d[2]);
    const z: Vec3 = [d[0] / l, d[1] / l, d[2] / l];
    let x = cross(z, Math.abs(z[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]);
    const xl = Math.hypot(x[0], x[1], x[2]);
    x = [x[0] / xl, x[1] / xl, x[2] / xl];
    const y = cross(z, x);
    const ring = (p: Vec3): Vec3[] => Array.from({ length: sides }, (_, i) => {
      const c = Math.cos((i / sides) * 2 * Math.PI) * radius, s = Math.sin((i / sides) * 2 * Math.PI) * radius;
      return [p[0] + x[0] * c + y[0] * s, p[1] + x[1] * c + y[1] * s, p[2] + x[2] * c + y[2] * s] as Vec3;
    });
    const ra = ring(a), rb = ring(b);
    const c: Vec3 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
    for (let i = 0; i < sides; i++) this.face([ra[i]!, ra[(i + 1) % sides]!, rb[(i + 1) % sides]!, rb[i]!], c, material, { ghost: true });
    this.face(ra, c, material, { ghost: true });
    this.face(rb, c, material, { ghost: true });
  }

  /** How many triangles are drawn. */
  get triangles(): number {
    let n = 0;
    for (const b of this.drawn.values()) n += b.idx.length / 3;
    return n;
  }

  /** One mesh a material. */
  meshes(materials: Record<string, MeshStandardMaterial>): Mesh[] {
    const out: Mesh[] = [];
    for (const [name, b] of this.drawn) {
      const material = materials[name];
      if (!material) throw new Error(`map: no material "${name}"`);
      const g = new BufferGeometry();
      g.setAttribute("position", new Float32BufferAttribute(b.pos, 3));
      g.setAttribute("normal", new Float32BufferAttribute(b.nor, 3));
      g.setAttribute("uv", new Float32BufferAttribute(new Float32Array((b.pos.length / 3) * 2), 2));
      g.setIndex(b.idx);
      const mesh = new Mesh(g, material);
      mesh.name = `map ${name}`;
      out.push(mesh);
    }
    return out;
  }
}
