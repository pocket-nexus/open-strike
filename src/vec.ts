// Small vector helpers on plain triples (the soldiers' poses, the hit tests): no objects to keep in step.
export type V3 = [number, number, number];

export const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
/** a + b * s */
export const mad = (a: V3, b: V3, s: number): V3 => [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s];
export const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const len = (a: V3): number => Math.hypot(a[0], a[1], a[2]);
export const norm = (a: V3): V3 => {
  const l = len(a);
  return l > 1e-9 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 1, 0];
};
export const lerp = (a: V3, b: V3, t: number): V3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
/** `v` turned about the unit `axis` by `angle` (Rodrigues). */
export function turn(v: V3, axis: V3, angle: number): V3 {
  const c = Math.cos(angle), s = Math.sin(angle), d = dot(axis, v) * (1 - c);
  const x = cross(axis, v);
  return [v[0] * c + x[0] * s + axis[0] * d, v[1] * c + x[1] * s + axis[1] * d, v[2] * c + x[2] * s + axis[2] * d];
}

/** Writes the matrix with columns x, y, z and translation t (column-major, as three.js keeps them) at `o`. */
export function writeBasis(out: Float32Array | number[], o: number, x: V3, y: V3, z: V3, t: V3): void {
  out[o] = x[0]; out[o + 1] = x[1]; out[o + 2] = x[2]; out[o + 3] = 0;
  out[o + 4] = y[0]; out[o + 5] = y[1]; out[o + 6] = y[2]; out[o + 7] = 0;
  out[o + 8] = z[0]; out[o + 9] = z[1]; out[o + 10] = z[2]; out[o + 11] = 0;
  out[o + 12] = t[0]; out[o + 13] = t[1]; out[o + 14] = t[2]; out[o + 15] = 1;
}

/** The unit quaternion [x, y, z, w] of the rotation whose columns are the orthonormal x, y, z. */
export function basisQuat(x: V3, y: V3, z: V3): [number, number, number, number] {
  const m11 = x[0], m21 = x[1], m31 = x[2], m12 = y[0], m22 = y[1], m32 = y[2], m13 = z[0], m23 = z[1], m33 = z[2];
  const tr = m11 + m22 + m33;
  if (tr > 0) {
    const s = 0.5 / Math.sqrt(tr + 1);
    return [(m32 - m23) * s, (m13 - m31) * s, (m21 - m12) * s, 0.25 / s];
  }
  if (m11 > m22 && m11 > m33) {
    const s = 2 * Math.sqrt(1 + m11 - m22 - m33);
    return [0.25 * s, (m12 + m21) / s, (m13 + m31) / s, (m32 - m23) / s];
  }
  if (m22 > m33) {
    const s = 2 * Math.sqrt(1 + m22 - m11 - m33);
    return [(m12 + m21) / s, 0.25 * s, (m23 + m32) / s, (m13 - m31) / s];
  }
  const s = 2 * Math.sqrt(1 + m33 - m11 - m22);
  return [(m13 + m31) / s, (m23 + m32) / s, 0.25 * s, (m21 - m12) / s];
}

/** A frame whose y axis is `y` (unit): some x and z perpendicular to it. */
export function frameY(y: V3): { x: V3; z: V3 } {
  const x = norm(cross(Math.abs(y[1]) < 0.95 ? [0, 1, 0] : [1, 0, 0], y));
  return { x, z: cross(x, y) };
}

/** The view's axes for a yaw and a pitch: forward, right, up (yaw 0 looks down -Z, positive turns left). */
export function viewAxes(yaw: number, pitch: number): { f: V3; r: V3; u: V3 } {
  const sy = Math.sin(yaw), cy = Math.cos(yaw), sp = Math.sin(pitch), cp = Math.cos(pitch);
  return { f: [-sy * cp, sp, -cy * cp], r: [cy, 0, -sy], u: [sy * sp, cp, cy * sp] };
}

// ---- rays against the shapes a soldier is hit by ----

/** Distance along the ray (origin o, unit direction d) to a sphere, or -1. */
export function raySphere(o: V3, d: V3, c: V3, r: number): number {
  const m = sub(o, c);
  const b = dot(m, d), cc = dot(m, m) - r * r;
  if (cc > 0 && b > 0) return -1;
  const disc = b * b - cc;
  if (disc < 0) return -1;
  return Math.max(0, -b - Math.sqrt(disc));
}

/** Distance along the ray to a capsule (segment a-b, radius r), or -1. */
export function rayCapsule(o: V3, d: V3, a: V3, b: V3, r: number): number {
  const ba = sub(b, a), oa = sub(o, a);
  const baba = dot(ba, ba), bard = dot(ba, d), baoa = dot(ba, oa), rdoa = dot(d, oa), oaoa = dot(oa, oa);
  const A = baba - bard * bard;
  if (Math.abs(A) < 1e-9) {
    const t0 = raySphere(o, d, a, r), t1 = raySphere(o, d, b, r);
    return t0 < 0 ? t1 : t1 < 0 ? t0 : Math.min(t0, t1);
  }
  const B = baba * rdoa - baoa * bard;
  const C = baba * oaoa - baoa * baoa - r * r * baba;
  const h = B * B - A * C;
  if (h >= 0) {
    const t = (-B - Math.sqrt(h)) / A;
    const y = baoa + t * bard;
    if (y > 0 && y < baba) return t >= 0 ? t : -1;       // the side
  }
  const t0 = raySphere(o, d, a, r), t1 = raySphere(o, d, b, r);       // the ends
  return t0 < 0 ? t1 : t1 < 0 ? t0 : Math.min(t0, t1);
}
