// The game's sounds, synthesized: every file in assets/sounds/ is rendered here from noise, filters, envelopes and a few
// oscillators, then encoded to Ogg Vorbis. Nothing is sampled or taken from anyone: the recipes below are the source.
// It is deterministic (each sound's randomness is seeded from its name), so a run writes the same files.
//
//   node tools/sounds.ts [--only carbine-1,step-2] [--png] [--wav]
// Writes assets/sounds/<name>.ogg (ffmpeg's own Vorbis encoder, -q:a 5; it encodes two channels only, so each file is
// the same signal on both: the engine places it), and prints for each its length, peak, RMS, DC and edge levels.
// `--png`: a spectrogram of each in out/sounds/ (look at a few after a change). `--wav`: keep the float WAVs there.
//
// The parts (one 48 kHz Float32 signal each): white noise; RBJ biquads (low / high / band pass, peak) whose cutoff may
// follow time; exponential envelopes; sines with pitch sweeps (thumps); damped sines (metal: clicks, pings, bells);
// grains (debris, rattles); tanh saturation; a room: an exponentially decaying noise impulse response that darkens as
// it decays, with a few early reflections, by FFT convolution. Then: a 20 Hz high pass, DC removed, fades at both ends
// and the peak normalized (each sound's own level, so the files sit right against each other at gain 1).
import { spawnSync } from "node:child_process";
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const OUT = join(ROOT, "assets/sounds");
const WORK = join(ROOT, "out/sounds");
const SR = 48000;

type Sig = Float32Array;
type Rng = () => number;
type Fn = (t: number) => number;

// ---------------------------------------------------------------------------------------------------------------------
// The parts

const N = (sec: number) => Math.max(1, Math.round(sec * SR));
const zeros = (sec: number): Sig => new Float32Array(N(sec));
const db = (d: number) => Math.pow(10, d / 20);

function mulberry(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash(s: string): number {
  let h = 2166136261;
  for (const ch of s) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return h >>> 0;
}

/** A number between a and b. */
const uni = (r: Rng, a: number, b: number) => a + (b - a) * r();
/** x, give or take a share. */
const vary = (r: Rng, x: number, share: number) => x * (1 + share * (2 * r() - 1));

function noise(sec: number, r: Rng): Sig {
  const x = zeros(sec);
  for (let i = 0; i < x.length; i++) x[i] = 2 * r() - 1;
  return x;
}

/** Multiplies by an envelope of time (s), in place. */
function shape(x: Sig, env: Fn): Sig {
  for (let i = 0; i < x.length; i++) x[i]! *= env(i / SR);
  return x;
}

/** exp(-t / tau). */
const decay = (tau: number): Fn => (t) => Math.exp(-t / tau);
/** A rise over `att` (a sine-squared, no corner), then exp(-t / tau). */
const ad = (att: number, tau: number): Fn => (t) => (t < att ? Math.sin((0.5 * Math.PI * t) / att) ** 2 : Math.exp(-(t - att) / tau));
/** A swell: up over `att`, held for `hold`, down with exp(-t / tau). */
const ahd = (att: number, hold: number, tau: number): Fn => (t) =>
  t < att ? Math.sin((0.5 * Math.PI * t) / att) ** 2 : t < att + hold ? 1 : Math.exp(-(t - att - hold) / tau);
/** From a to b, exponentially, with time constant tau. */
const glide = (a: number, b: number, tau: number): Fn => (t) => b + (a - b) * Math.exp(-t / tau);
/** From a to b over `sec`, geometrically (then held). */
const sweep = (a: number, b: number, sec: number): Fn => (t) => a * Math.pow(b / a, Math.min(1, t / sec));

type FilterType = "lp" | "hp" | "bp" | "peak";

/** An RBJ biquad over x (a new signal). `f` may follow time (coefficients every 16 samples). */
function filt(x: Sig, type: FilterType, f: number | Fn, q = 0.707, gainDb = 0): Sig {
  const y = new Float32Array(x.length);
  let b0 = 0, b1 = 0, b2 = 0, a1 = 0, a2 = 0;
  const set = (hz: number) => {
    const w = (2 * Math.PI * Math.min(Math.max(hz, 10), SR * 0.45)) / SR;
    const c = Math.cos(w), al = Math.sin(w) / (2 * q);
    let n0: number, n1: number, n2: number, d0: number, d1: number, d2: number;
    if (type === "lp") { n0 = (1 - c) / 2; n1 = 1 - c; n2 = n0; d0 = 1 + al; d1 = -2 * c; d2 = 1 - al; }
    else if (type === "hp") { n0 = (1 + c) / 2; n1 = -(1 + c); n2 = n0; d0 = 1 + al; d1 = -2 * c; d2 = 1 - al; }
    else if (type === "bp") { n0 = al; n1 = 0; n2 = -al; d0 = 1 + al; d1 = -2 * c; d2 = 1 - al; }
    else { const A = Math.pow(10, gainDb / 40); n0 = 1 + al * A; n1 = -2 * c; n2 = 1 - al * A; d0 = 1 + al / A; d1 = -2 * c; d2 = 1 - al / A; }
    b0 = n0 / d0; b1 = n1 / d0; b2 = n2 / d0; a1 = d1 / d0; a2 = d2 / d0;
  };
  const fn = typeof f === "function" ? f : null;
  if (!fn) set(f as number);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    if (fn && (i & 15) === 0) set(fn(i / SR));
    const xi = x[i]!;
    const yi = b0 * xi + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = xi; y2 = y1; y1 = yi;
    y[i] = yi;
  }
  return y;
}

/** A sine whose frequency (Hz) and amplitude follow time; starts at phase 0 (no click). */
function osc(sec: number, freq: number | Fn, amp: Fn, phase = 0): Sig {
  const x = zeros(sec);
  let ph = phase;
  for (let i = 0; i < x.length; i++) {
    const t = i / SR;
    x[i] = Math.sin(ph) * amp(t);
    ph += (2 * Math.PI * (typeof freq === "function" ? freq(t) : freq)) / SR;
  }
  return x;
}

/** A thump: a sine falling from f0 to f1 (time constant `bend`), with a 1 ms rise and exp decay `tau`. */
const thump = (sec: number, f0: number, f1: number, bend: number, tau: number, att = 0.001) => osc(sec, glide(f0, f1, bend), ad(att, tau));

/** Damped sines: [Hz, amplitude, decay s]. Metal: clicks, pings, a bell. A 0.3 ms rise. */
function modes(sec: number, list: readonly (readonly [number, number, number])[]): Sig {
  const x = zeros(sec);
  for (const [f, a, tau] of list) {
    const w = (2 * Math.PI * f) / SR;
    for (let i = 0; i < x.length; i++) {
      const t = i / SR;
      x[i]! += a * Math.sin(w * i) * Math.exp(-t / tau) * Math.min(1, t / 0.0003);
    }
  }
  return x;
}

/** A click: a noise burst of a few ms, band passed. */
function click(r: Rng, hz: number, tau = 0.0008, q = 1.2, sec = 0.03): Sig {
  return filt(shape(noise(sec, r), ad(0.0002, tau)), "bp", hz, q);
}

/** Mixes src into dst at `at` seconds, scaled; src's last 3 ms faded (a part cut off while it still sounds would click). */
function mix(dst: Sig, src: Sig, at = 0, gain = 1): Sig {
  const o = Math.round(at * SR), n = Math.min(src.length, dst.length - o), tail = Math.min(N(0.003), src.length >> 2);
  for (let i = Math.max(0, -o); i < n; i++) {
    const k = src.length - 1 - i;
    dst[i + o]! += src[i]! * gain * (k < tail ? Math.sin((0.5 * Math.PI * k) / tail) ** 2 : 1);
  }
  return dst;
}

/** Scaled, in place. */
function amp(x: Sig, g: number): Sig {
  for (let i = 0; i < x.length; i++) x[i]! *= g;
  return x;
}

/** Soft clipping: tanh(drive x) / tanh(drive). */
function sat(x: Sig, drive: number): Sig {
  const k = 1 / Math.tanh(drive);
  for (let i = 0; i < x.length; i++) x[i] = Math.tanh(drive * x[i]!) * k;
  return x;
}

/** Many small clicks spread over time, fewer and quieter as it goes: debris, rattle, grit. */
function grains(r: Rng, sec: number, o: { count: number; spread: number; lo: number; hi: number; tau?: number; fall?: number; ring?: number }): Sig {
  const x = zeros(sec);
  for (let k = 0; k < o.count; k++) {
    const t = Math.min(sec - 0.02, -o.spread * Math.log(1 - r() * 0.98));
    const f = o.lo * Math.pow(o.hi / o.lo, r());
    const a = uni(r, 0.3, 1) * Math.exp(-t / (o.fall ?? o.spread * 2));
    const g = o.ring ? modes(0.04, [[f, 1, o.ring], [f * uni(r, 1.4, 1.9), 0.5, o.ring * 0.6]]) : click(r, f, o.tau ?? 0.0006, 1.5, 0.02);
    mix(x, g, t, a);
  }
  return x;
}

// ---- the room: convolution with a synthesized response ----

function fft(re: Float64Array, im: Float64Array, inverse: boolean): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j]!, re[i]!]; [im[i], im[j]] = [im[j]!, im[i]!]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((inverse ? 2 : -2) * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const xr = re[b]! * cr - im[b]! * ci, xi = re[b]! * ci + im[b]! * cr;
        re[b] = re[a]! - xr; im[b] = im[a]! - xi;
        re[a]! += xr; im[a]! += xi;
        const t = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = t;
      }
    }
  }
  if (inverse) for (let i = 0; i < n; i++) { re[i]! /= n; im[i]! /= n; }
}

function convolve(x: Sig, h: Sig, outLen: number): Sig {
  let n = 1;
  while (n < x.length + h.length) n <<= 1;
  const ar = new Float64Array(n), ai = new Float64Array(n), br = new Float64Array(n), bi = new Float64Array(n);
  ar.set(x); br.set(h);
  fft(ar, ai, false); fft(br, bi, false);
  for (let i = 0; i < n; i++) {
    const r = ar[i]! * br[i]! - ai[i]! * bi[i]!, m = ar[i]! * bi[i]! + ai[i]! * br[i]!;
    ar[i] = r; ai[i] = m;
  }
  fft(ar, ai, true);
  const y = new Float32Array(outLen);
  for (let i = 0; i < outLen && i < n; i++) y[i] = ar[i]!;
  return y;
}

interface Room {
  /** Seconds to fall 60 dB. */
  rt60: number;
  /** Wet level against the dry (the response has unit energy). */
  wet: number;
  /** Seconds before the first reflection. */
  pre?: number;
  /** Low pass of the response at its start and at rt60, Hz (it darkens as it decays). */
  bright?: number;
  dark?: number;
  /** Early reflections (discrete taps in the first 40 ms). */
  early?: number;
}

function roomIR(r: Rng, o: Room): Sig {
  const len = o.rt60 * 1.1, pre = o.pre ?? 0.008;
  const h = zeros(len + pre);
  const tail = shape(noise(len, r), (t) => Math.exp((-6.9 * t) / o.rt60) * Math.min(1, t / 0.012));
  mix(h, filt(tail, "lp", sweep(o.bright ?? 6000, o.dark ?? 900, o.rt60), 0.6), pre);
  for (let k = 0; k < (o.early ?? 6); k++) {
    const t = pre + uni(r, 0, 0.04);
    h[N(t)] = (h[N(t)] ?? 0) + (r() < 0.5 ? -1 : 1) * uni(r, 0.2, 0.6) * Math.exp(-t / 0.05) * 6;
  }
  let e = 0;
  for (const v of h) e += v * v;
  return amp(filt(h, "hp", 120, 0.6), 1 / Math.sqrt(e));
}

/** x in a room: dry plus the convolved, `sec` long. */
function room(x: Sig, r: Rng, o: Room, sec: number): Sig {
  const y = convolve(x, roomIR(r, o), N(sec));
  for (let i = 0; i < y.length; i++) y[i] = y[i]! * o.wet + (i < x.length ? x[i]! : 0);
  return y;
}

/** A copy of x, `sec` long (padded or cut). */
function fit(x: Sig, sec: number): Sig {
  const y = zeros(sec);
  y.set(x.subarray(0, y.length));
  return y;
}

// ---- musical voices (the stingers) ----

const NOTE: Record<string, number> = {};
{
  const names = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
  for (let o = 1; o <= 7; o++) names.forEach((n, i) => (NOTE[`${n}${o}`] = 440 * Math.pow(2, (o - 4) + (i - 9) / 12)));
}
const hz = (n: string) => NOTE[n] ?? (() => { throw new Error(n); })();

/** A band-limited saw-ish voice (additive, two detuned copies), its harmonics rolled off above `cutoff(t)`. */
function synth(sec: number, f: number, env: Fn, cutoff: Fn, o: { detune?: number; partials?: number; odd?: number } = {}): Sig {
  const x = zeros(sec);
  const cents = o.detune ?? 7;
  for (const d of [-cents, cents]) {
    const fd = f * Math.pow(2, d / 1200);
    const K = Math.min(o.partials ?? 40, Math.floor(16000 / fd));
    const phase0 = d < 0 ? 0 : 1.3;
    for (let i = 0; i < x.length; i++) {
      const t = i / SR, fc = cutoff(t), e = env(t);
      if (e < 1e-5) continue;
      let s = 0;
      for (let k = 1; k <= K; k++) {
        const r = (k * fd) / fc;
        const a = 1 / k / (1 + r * r * r * r) * (k % 2 === 0 ? 1 - (o.odd ?? 0) : 1);
        if (a < 1e-4) break;
        s += a * Math.sin(k * (2 * Math.PI * fd * t + phase0));
      }
      x[i]! += 0.5 * s * e;
    }
  }
  return x;
}

/** A note with an attack, a gate (held to `gate` s) and a release. */
const gate = (att: number, hold: number, rel: number, sustain = 0.7, dec = 0.15): Fn => (t) => {
  const on = t < att ? Math.sin((0.5 * Math.PI * t) / att) ** 2 : sustain + (1 - sustain) * Math.exp(-(t - att) / dec);
  return t < hold ? on : on * Math.exp(-(t - hold) / rel);
};

/** A bell: inharmonic partials. */
const bell = (sec: number, f: number, tau: number) => modes(sec, [[f, 1, tau], [f * 2.0, 0.4, tau * 0.6], [f * 2.76, 0.3, tau * 0.45], [f * 5.4, 0.12, tau * 0.2]]);

/** A low drum hit (a soft taiko-like boom). */
function drum(r: Rng, sec: number, f = 70, level = 1): Sig {
  const x = thump(sec, f * 1.8, f, 0.03, 0.18, 0.002);
  mix(x, filt(shape(noise(sec, r), ad(0.001, 0.035)), "lp", 1800, 0.7), 0, 0.5);
  return amp(x, level);
}

// ---------------------------------------------------------------------------------------------------------------------
// The recipes

interface Gun {
  crack: { level: number; hp: number; tau: number; nwave: number };
  blast: { level: number; from: number; to: number; bend: number; tau: number };
  bark: { level: number; hz: number; tau: number };
  thump: { level: number; f0: number; f1: number; bend: number; tau: number };
  rumble: { level: number; tau: number; lp: number };
  drive: number;
  room: Room;
  sec: number;
}

const GUNS: Record<string, Gun> = {
  // 5.56-ish carbine: a tight crack, a bright short body, a short room.
  carbine: {
    crack: { level: 0.8, hp: 2200, tau: 0.0007, nwave: 0.0004 },
    blast: { level: 1.0, from: 7500, to: 900, bend: 0.008, tau: 0.026 },
    bark: { level: 0.55, hz: 1300, tau: 0.02 },
    thump: { level: 0.9, f0: 150, f1: 58, bend: 0.012, tau: 0.045 },
    rumble: { level: 0.22, tau: 0.16, lp: 320 },
    drive: 2.4,
    room: { rt60: 0.85, wet: 0.24, pre: 0.012, bright: 5000, dark: 700, early: 7 },
    sec: 0.75,
  },
  // 12 gauge: little crack, a big low boom and a long body.
  shotgun: {
    crack: { level: 0.35, hp: 1600, tau: 0.0009, nwave: 0.0006 },
    blast: { level: 1.15, from: 5000, to: 450, bend: 0.014, tau: 0.06 },
    bark: { level: 0.5, hz: 800, tau: 0.035 },
    thump: { level: 1.25, f0: 120, f1: 42, bend: 0.02, tau: 0.11 },
    rumble: { level: 0.4, tau: 0.3, lp: 260 },
    drive: 2.8,
    room: { rt60: 1.1, wet: 0.26, pre: 0.014, bright: 4000, dark: 600, early: 8 },
    sec: 1.0,
  },
  // A full-power rifle: a loud supersonic crack, a heavy body, a long hall.
  marksman: {
    crack: { level: 1.25, hp: 2600, tau: 0.001, nwave: 0.0006 },
    blast: { level: 1.05, from: 9000, to: 1100, bend: 0.01, tau: 0.04 },
    bark: { level: 0.6, hz: 1100, tau: 0.03 },
    thump: { level: 1.1, f0: 130, f1: 45, bend: 0.016, tau: 0.08 },
    rumble: { level: 0.35, tau: 0.36, lp: 300 },
    drive: 2.6,
    room: { rt60: 1.5, wet: 0.3, pre: 0.016, bright: 6000, dark: 600, early: 8 },
    sec: 1.45,
  },
};

/** The shot itself, dry: crack, blast, bark, thump, saturated together; and the rumble of the gas. */
function shotDry(r: Rng, g: Gun, sec: number): Sig {
  const x = zeros(sec);
  // The crack: an N-wave (a pressure step up then down) and a hiss of noise, both very short.
  const nw = N(g.crack.nwave);
  const crack = zeros(0.01);
  for (let i = 0; i < nw; i++) crack[i] = 1 - (2 * i) / nw;
  mix(crack, filt(shape(noise(0.01, r), ad(0.0001, g.crack.tau)), "hp", g.crack.hp, 0.6), 0, 1.2);
  mix(x, filt(crack, "hp", 400, 0.7), 0, g.crack.level);
  // The blast: noise through a low pass that closes fast.
  mix(x, filt(shape(noise(0.4, r), ad(0.0003, g.blast.tau)), "lp", glide(g.blast.from, g.blast.to, g.blast.bend), 0.8), 0, g.blast.level);
  // The bark: the middle, a resonance of the muzzle.
  mix(x, filt(shape(noise(0.3, r), ad(0.0005, g.bark.tau)), "bp", g.bark.hz, 1.3), 0, g.bark.level * 2.5);
  mix(x, thump(0.5, g.thump.f0, g.thump.f1, g.thump.bend, g.thump.tau), 0, g.thump.level);
  sat(amp(x, 0.6), g.drive);
  mix(x, filt(filt(shape(noise(sec, r), ad(0.008, g.rumble.tau)), "lp", g.rumble.lp, 0.7), "lp", g.rumble.lp * 1.5, 0.6), 0, g.rumble.level * 2);
  return x;
}

/** The action cycling: a bolt clack after the shot (the carbine). */
function bolt(r: Rng, level: number): Sig {
  const x = zeros(0.08);
  mix(x, click(r, 3400, 0.0015, 1.5, 0.04), 0, 0.8);
  mix(x, modes(0.06, [[2100, 0.3, 0.008], [3500, 0.25, 0.006], [5600, 0.12, 0.004]]), 0);
  mix(x, click(r, 2600, 0.0012, 1.5, 0.04), 0.022, 0.6);
  return amp(x, level);
}

/** A shotgun's pump: back (a slide, a clack), forward (a slide, a bigger clack). */
function pump(r: Rng): Sig {
  const x = zeros(0.4);
  mix(x, filt(shape(noise(0.08, r), ahd(0.02, 0.03, 0.01)), "bp", sweep(1300, 2200, 0.07), 0.9), 0, 0.25);
  mix(x, click(r, 2200, 0.002, 1.2, 0.05), 0.07, 0.9);
  mix(x, modes(0.08, [[900, 0.35, 0.02], [1750, 0.3, 0.015], [2900, 0.2, 0.01]]), 0.07);
  mix(x, filt(shape(noise(0.06, r), ahd(0.015, 0.02, 0.01)), "bp", sweep(2000, 1300, 0.05), 0.9), 0.15, 0.25);
  mix(x, click(r, 1800, 0.0025, 1.0, 0.05), 0.205, 1.1);
  mix(x, modes(0.1, [[780, 0.45, 0.025], [1500, 0.35, 0.02], [2650, 0.25, 0.012]]), 0.205);
  mix(x, thump(0.06, 260, 140, 0.01, 0.012), 0.205, 0.35);
  return x;
}

function gunNear(id: string, r: Rng): Sig {
  const g = GUNS[id]!;
  const x = shotDry(r, g, g.sec);
  if (id === "carbine") mix(x, bolt(r, 0.09), 0.026);
  if (id === "marksman") mix(x, bolt(r, 0.06), 0.05);
  const y = room(x, r, g.room, g.sec);
  // A slap off the far walls for the rifle.
  if (id === "marksman") mix(y, filt(fit(x, 0.4), "lp", 1800, 0.7), 0.19, 0.16);
  if (id === "shotgun") mix(y, room(pump(r), r, { rt60: 0.4, wet: 0.12 }, 0.45), 0.36, 0.11);
  return y;
}

/** Someone else's shot, from across the map: the highs gone, the crack a pop, the tail longer, echoes off buildings. */
function gunFar(id: string, r: Rng): Sig {
  const g = GUNS[id]!;
  const sec = g.sec + 0.6;
  const x = shotDry(r, { ...g, crack: { ...g.crack, level: g.crack.level * 0.4 }, rumble: { ...g.rumble, level: g.rumble.level * 1.6, tau: g.rumble.tau * 1.5 } }, sec);
  let d = filt(filt(x, "lp", 2200, 0.6), "lp", 3200, 0.6);
  d = filt(d, "peak", 180, 0.8, 3);
  const y = room(d, r, { ...g.room, rt60: g.room.rt60 * 1.6, wet: g.room.wet * 2.4, pre: 0.03, bright: 2500, dark: 400 }, sec);
  const echo = filt(fit(d, 0.5), "lp", 1200, 0.6);
  mix(y, echo, 0.13, 0.32);
  mix(y, echo, 0.29, 0.18);
  mix(y, echo, 0.52, 0.1);
  return y;
}

/** Concrete takes a round: a crack, a body, debris falling. Or (metal) a ping and a ricochet's whine. */
function impactWall(r: Rng, metal: boolean): Sig {
  const sec = metal ? 0.55 : 0.45;
  const x = zeros(sec);
  mix(x, filt(shape(noise(0.02, r), ad(0.0001, 0.0005)), "hp", 2800, 0.7), 0, 1.4);
  mix(x, filt(shape(noise(0.1, r), ad(0.0003, vary(r, 0.012, 0.2))), "bp", vary(r, 1700, 0.2), 0.9), 0, 1.6);
  mix(x, thump(0.06, vary(r, 240, 0.1), 120, 0.006, 0.014), 0, 0.35);
  if (metal) {
    mix(x, modes(0.3, [[vary(r, 1900, 0.05), 0.35, 0.08], [3300, 0.3, 0.06], [5100, 0.25, 0.04], [7400, 0.15, 0.025]]), 0.001);
    const whine = osc(0.4, (t) => sweep(vary(r, 4300, 0.05), 1700, 0.32)(t) * (1 + 0.012 * Math.sin(2 * Math.PI * 23 * t)), ahd(0.015, 0.04, 0.11));
    mix(x, filt(whine, "lp", 5000, 0.7), 0.02, 0.22);
  } else {
    mix(x, filt(grains(r, sec, { count: 26, spread: 0.07, lo: 1800, hi: 7000, tau: 0.0007, fall: 0.15 }), "lp", 6500, 0.7), 0.004, 0.55);
    mix(x, filt(shape(noise(sec, r), ad(0.01, 0.07)), "hp", 2500, 0.7), 0, 0.06);
  }
  return room(sat(x, 1.4), r, { rt60: 0.5, wet: 0.14, bright: 5000, dark: 900 }, sec);
}

/** A round meets a body: a wet thud. */
function impactBody(r: Rng): Sig {
  const sec = 0.3;
  const x = zeros(sec);
  mix(x, filt(shape(noise(0.15, r), ad(0.0005, vary(r, 0.018, 0.2))), "lp", vary(r, 900, 0.15), 0.8), 0, 1.2);
  mix(x, thump(0.15, vary(r, 140, 0.1), 68, 0.01, 0.03), 0, 0.9);
  mix(x, filt(shape(noise(0.02, r), ad(0.0001, 0.0018)), "hp", 2000, 0.7), 0, 0.4);
  mix(x, filt(shape(noise(0.15, r), ad(0.005, 0.025)), "bp", vary(r, 620, 0.15), 2.2), 0.003, 0.9);
  return room(sat(x, 2), r, { rt60: 0.35, wet: 0.08 }, sec);
}

/** A boot on concrete: heel, then toe, a scuff and some grit. */
function step(r: Rng): Sig {
  const sec = 0.3;
  const x = zeros(sec);
  const hit = (at: number, level: number, bright: number) => {
    mix(x, thump(0.08, vary(r, 100, 0.12), 58, 0.008, vary(r, 0.016, 0.2)), at, 0.7 * level);
    mix(x, filt(shape(noise(0.08, r), ad(0.0006, vary(r, 0.009, 0.2))), "lp", bright, 0.8), at, 0.9 * level);
  };
  hit(0.004, 1, vary(r, 1500, 0.2));
  hit(uni(r, 0.045, 0.07), uni(r, 0.4, 0.6), vary(r, 2600, 0.2));
  mix(x, filt(shape(noise(0.1, r), ad(0.008, 0.025)), "bp", vary(r, 3000, 0.2), 0.7), uni(r, 0, 0.02), 0.18);
  mix(x, filt(grains(r, 0.12, { count: 8, spread: 0.03, lo: 2500, hi: 8000, tau: 0.0004 }), "hp", 1500, 0.7), 0.004, 0.3);
  return room(x, r, { rt60: 0.45, wet: 0.1, bright: 4000 }, sec);
}

/** A soldier's gear: small metal and plastic rattles. */
const rattle = (r: Rng, sec: number, count: number, spread: number) => grains(r, sec, { count, spread, lo: 1800, hi: 5200, ring: 0.006, fall: spread * 3 });
/** Cloth moving: band-passed noise, swelling and going. */
const cloth = (r: Rng, sec: number, att: number, tau: number, from = 900, to = 2400) => filt(shape(noise(sec, r), ad(att, tau)), "bp", sweep(from, to, att + tau), 0.7);

function jump(r: Rng): Sig {
  const sec = 0.4;
  const x = zeros(sec);
  mix(x, cloth(r, sec, 0.05, 0.1, 700, 2600), 0, 0.5);
  mix(x, filt(shape(noise(0.08, r), ad(0.002, 0.018)), "bp", 2200, 0.8), 0, 0.45);
  mix(x, thump(0.08, 120, 70, 0.01, 0.02), 0, 0.45);
  mix(x, rattle(r, sec, 6, 0.06), 0.01, 0.25);
  return room(x, r, { rt60: 0.45, wet: 0.1 }, sec);
}

function land(r: Rng): Sig {
  const sec = 0.5;
  const x = zeros(sec);
  for (const [at, lv] of [[0.002, 1], [0.017, 0.75]] as const) {
    mix(x, thump(0.2, 95, 44, 0.012, 0.06), at, lv);
    mix(x, filt(shape(noise(0.12, r), ad(0.0008, 0.028)), "lp", 1300, 0.8), at, 0.9 * lv);
  }
  mix(x, filt(shape(noise(0.12, r), ad(0.006, 0.03)), "bp", 2800, 0.7), 0.01, 0.2);
  mix(x, rattle(r, sec, 10, 0.05), 0.012, 0.3);
  mix(x, cloth(r, sec, 0.02, 0.08, 1800, 900), 0, 0.2);
  return room(sat(x, 1.8), r, { rt60: 0.5, wet: 0.12 }, sec);
}

/** The player is hit: a punch to the body, a muffled whump. */
function hurt(r: Rng): Sig {
  const sec = 0.55;
  const x = zeros(sec);
  mix(x, thump(0.3, 125, 48, 0.015, 0.06), 0, 1);
  mix(x, filt(shape(noise(0.2, r), ad(0.0006, 0.025)), "lp", 750, 0.8), 0, 0.9);
  mix(x, filt(shape(noise(0.02, r), ad(0.0001, 0.003)), "hp", 2500, 0.7), 0, 0.45);
  mix(x, filt(filt(shape(noise(sec, r), ad(0.015, 0.12)), "lp", 240, 0.8), "lp", 300, 0.7), 0, 1.4);
  return room(sat(x, 2.4), r, { rt60: 0.4, wet: 0.08 }, sec);
}

/** The player goes down: a heavy hit, the hearing dulls and rings, two last slow heartbeats. */
function death(r: Rng): Sig {
  const sec = 2.2;
  const x = zeros(sec);
  mix(x, sat(amp(hurt(r), 1.3), 1.5), 0, 1);
  mix(x, osc(sec, glide(58, 36, 0.8), ad(0.03, 0.6)), 0, 0.55);
  mix(x, filt(filt(shape(noise(sec, r), ad(0.02, 0.5)), "lp", sweep(2000, 140, 1.4), 0.9), "lp", 2500, 0.7), 0, 0.5);
  mix(x, osc(sec, 3720, ahd(0.35, 0.3, 0.45)), 0.08, 0.022);
  mix(x, osc(sec, 3727, ahd(0.4, 0.25, 0.45)), 0.08, 0.012);
  for (const [at, lv] of [[0.6, 0.5], [1.32, 0.3]] as const) {
    mix(x, thump(0.2, 64, 40, 0.02, 0.05, 0.004), at, lv);
    mix(x, thump(0.2, 58, 38, 0.02, 0.045, 0.004), at + 0.17, lv * 0.65);
  }
  return room(x, r, { rt60: 0.9, wet: 0.14, bright: 3000 }, sec);
}

/** The hit marker's tick. */
function hitTick(r: Rng): Sig {
  const x = zeros(0.07);
  mix(x, filt(shape(noise(0.01, r), ad(0.0001, 0.0004)), "hp", 4000, 0.7), 0, 0.5);
  mix(x, osc(0.07, 2900, ad(0.0003, 0.011)), 0, 0.8);
  mix(x, osc(0.07, 5800, ad(0.0003, 0.005)), 0, 0.2);
  return x;
}

/** A kill: the tick, a dull thunk under it, a bright soft bell (a fifth). */
function kill(r: Rng): Sig {
  const sec = 0.65;
  const x = zeros(sec);
  mix(x, hitTick(r), 0, 0.8);
  mix(x, thump(0.12, 190, 115, 0.01, 0.04), 0, 0.45);
  mix(x, bell(0.5, hz("E6"), 0.22), 0.05, 0.3);
  mix(x, bell(0.5, hz("B6"), 0.18), 0.05, 0.2);
  return room(x, r, { rt60: 0.6, wet: 0.18, bright: 7000 }, sec);
}

/** Back in: a rising whoosh, a soft chord shimmering in. */
function respawn(r: Rng): Sig {
  const sec = 1.15;
  const x = zeros(sec);
  mix(x, filt(shape(noise(sec, r), ahd(0.42, 0.03, 0.12)), "bp", sweep(250, 3500, 0.48), 1.2), 0, 0.9);
  for (const [n, a] of [["D5", 1], ["A5", 0.8], ["D6", 0.55]] as const) {
    mix(x, osc(0.9, (t) => hz(n) * (1 + 0.003 * Math.sin(2 * Math.PI * 5.5 * t)), ahd(0.12, 0.06, 0.3)), 0.28, 0.07 * a);
  }
  mix(x, osc(sec, 73.4, ahd(0.35, 0.05, 0.15)), 0, 0.25);
  return room(x, r, { rt60: 1.2, wet: 0.35, bright: 7000, dark: 1500 }, sec);
}

/** A brass-like stab: the chord's notes, the filter opening on the attack. */
function stab(notes: string[], sec: number, hold: number, open: number, rest: number, level = 1): Sig {
  const x = zeros(sec);
  const cutoff: Fn = (t) => (t < 0.06 ? 400 + (open - 400) * (t / 0.06) : rest + (open - rest) * Math.exp(-(t - 0.06) / 0.25));
  for (const n of notes) mix(x, synth(sec, hz(n), gate(0.012, hold, 0.22, 0.55, 0.18), cutoff), 0, level / Math.sqrt(notes.length));
  return x;
}

/** A pluck: a bright note that decays. */
function pluck(sec: number, n: string, bright: number): Sig {
  return synth(sec, hz(n), ad(0.004, 0.32), (t) => 600 + bright * Math.exp(-t / 0.15), { detune: 4, odd: 0.3 });
}

function roundStart(r: Rng): Sig {
  const sec = 1.9;
  const x = zeros(sec);
  mix(x, drum(r, 0.8, 62, 0.9), 0, 1);
  mix(x, stab(["A2", "E3", "A3"], 0.6, 0.11, 2600, 900), 0, 0.55);
  mix(x, drum(r, 1.2, 55, 1.1), 0.2, 1);
  mix(x, stab(["D3", "A3", "D4", "F#4"], 1.5, 0.75, 3200, 1100), 0.2, 0.65);
  return room(x, r, { rt60: 1.7, wet: 0.32, bright: 6000, dark: 1200, pre: 0.02 }, sec);
}

function roundWon(r: Rng): Sig {
  const sec = 2.7;
  const x = zeros(sec);
  ["D4", "F#4", "A4", "D5"].forEach((n, i) => mix(x, pluck(0.8, n, 3000), i * 0.11, 0.3));
  mix(x, drum(r, 1, 58, 1), 0.33, 0.9);
  mix(x, stab(["D3", "A3", "D4", "F#4", "A4"], 2.3, 1.2, 2400, 1300), 0.33, 0.6);
  mix(x, synth(2.3, hz("D2"), gate(0.02, 1.2, 0.4, 0.8), () => 500), 0.33, 0.35);
  mix(x, bell(1.2, hz("D6"), 0.5), 0.33, 0.06);
  return room(x, r, { rt60: 1.9, wet: 0.34, bright: 6000, dark: 1200, pre: 0.02 }, sec);
}

function roundLost(r: Rng): Sig {
  const sec = 2.7;
  const x = zeros(sec);
  ["A4", "F4", "D4"].forEach((n, i) => mix(x, pluck(0.9, n, 1600), i * 0.16, 0.3));
  mix(x, drum(r, 1, 50, 0.8), 0.32, 0.8);
  mix(x, stab(["D3", "F3", "A3", "D4"], 2.3, 1.1, 1300, 700), 0.32, 0.6);
  mix(x, synth(2.3, hz("D2"), gate(0.03, 1.1, 0.45, 0.8), () => 380), 0.32, 0.4);
  return room(x, r, { rt60: 1.9, wet: 0.3, bright: 4000, dark: 900, pre: 0.02 }, sec);
}

function uiTick(r: Rng): Sig {
  const x = zeros(0.045);
  mix(x, osc(0.045, 1700, ad(0.0003, 0.005)), 0, 1);
  mix(x, filt(shape(noise(0.01, r), ad(0.0001, 0.0003)), "hp", 3000, 0.7), 0, 0.3);
  return x;
}

/** The trigger on an empty chamber: the sear, then the striker's fall. */
function dry(r: Rng): Sig {
  const x = zeros(0.16);
  mix(x, click(r, 4000, 0.0006, 1.5), 0, 0.5);
  mix(x, modes(0.05, [[3100, 0.25, 0.008], [4700, 0.18, 0.005], [6900, 0.1, 0.003]]), 0);
  mix(x, click(r, 2600, 0.0009, 1.2), 0.013, 1);
  mix(x, modes(0.08, [[1800, 0.35, 0.012], [2600, 0.25, 0.01], [4100, 0.12, 0.006]]), 0.013);
  mix(x, thump(0.03, 320, 220, 0.004, 0.005), 0.013, 0.2);
  return room(x, r, { rt60: 0.3, wet: 0.08 }, 0.16);
}

/** The release pressed, the magazine slides out, the rounds in it rattle. */
function magOut(r: Rng): Sig {
  const sec = 0.42;
  const x = zeros(sec);
  mix(x, click(r, 3600, 0.0007), 0, 0.6);
  mix(x, modes(0.04, [[3800, 0.2, 0.006], [5200, 0.12, 0.004]]), 0);
  mix(x, filt(shape(noise(0.15, r), ahd(0.04, 0.05, 0.015)), "bp", sweep(1200, 2400, 0.11), 0.8), 0.03, 0.35);
  mix(x, modes(0.08, [[2200, 0.3, 0.02], [3600, 0.2, 0.014]]), 0.15);
  mix(x, rattle(r, 0.2, 5, 0.03), 0.15, 0.4);
  return room(x, r, { rt60: 0.35, wet: 0.08 }, sec);
}

/** A magazine seated: a slide, a firm clack, the latch. */
function magIn(r: Rng): Sig {
  const sec = 0.35;
  const x = zeros(sec);
  mix(x, filt(shape(noise(0.08, r), ahd(0.03, 0.03, 0.01)), "bp", sweep(1300, 1800, 0.07), 0.8), 0, 0.3);
  mix(x, thump(0.04, 260, 150, 0.004, 0.01), 0.075, 0.5);
  mix(x, click(r, 2500, 0.0015, 1.0), 0.075, 1);
  mix(x, modes(0.1, [[1400, 0.4, 0.025], [2300, 0.3, 0.018], [3900, 0.15, 0.01]]), 0.075);
  mix(x, click(r, 4200, 0.0006, 1.5), 0.093, 0.4);
  return room(x, r, { rt60: 0.35, wet: 0.08 }, sec);
}

/** The charging handle: pulled back (a ratchet), let go (a snap forward). */
function boltRack(r: Rng): Sig {
  const sec = 0.45;
  const x = zeros(sec);
  mix(x, click(r, 3200, 0.0008), 0, 0.5);
  mix(x, filt(shape(noise(0.1, r), ahd(0.02, 0.05, 0.01)), "bp", sweep(2400, 3200, 0.09), 1.0), 0.005, 0.3);
  mix(x, click(r, 2800, 0.001), 0.09, 0.6);
  mix(x, modes(0.05, [[2400, 0.2, 0.01], [4100, 0.12, 0.006]]), 0.09);
  mix(x, click(r, 3000, 0.002, 0.9), 0.17, 1.2);
  mix(x, modes(0.15, [[1100, 0.45, 0.03], [2100, 0.35, 0.02], [3400, 0.25, 0.015], [5200, 0.12, 0.008]]), 0.17);
  mix(x, thump(0.05, 220, 150, 0.004, 0.01), 0.17, 0.35);
  return room(x, r, { rt60: 0.4, wet: 0.1 }, sec);
}

/** A shell pushed into the tube: a thumb's slide and a click, a brass tink. */
function shell(r: Rng): Sig {
  const sec = 0.17;
  const x = zeros(sec);
  mix(x, filt(shape(noise(0.05, r), ahd(0.02, 0.015, 0.006)), "bp", 2000, 0.8), 0, 0.25);
  mix(x, click(r, 2400, 0.0012, 1.2), 0.045, 0.9);
  mix(x, modes(0.06, [[2400, 0.25, 0.01], [3900, 0.15, 0.008]]), 0.045);
  mix(x, modes(0.08, [[5200, 0.08, 0.025], [7600, 0.05, 0.015]]), 0.047);
  return room(x, r, { rt60: 0.3, wet: 0.08 }, sec);
}

/** Changing weapons: cloth, gear, the new one taken in hand. */
function swap(r: Rng): Sig {
  const sec = 0.42;
  const x = zeros(sec);
  mix(x, cloth(r, sec, 0.04, 0.12, 900, 2600), 0, 0.5);
  mix(x, rattle(r, sec, 5, 0.06), 0.03, 0.3);
  mix(x, click(r, 2300, 0.0015, 1.0), 0.18, 0.6);
  mix(x, modes(0.08, [[1200, 0.3, 0.015], [2600, 0.2, 0.01]]), 0.18);
  return room(x, r, { rt60: 0.35, wet: 0.08 }, sec);
}

/** Every file: its recipe and its peak (dBFS) at gain 1. */
const SOUNDS: Record<string, { make: (r: Rng) => Sig; peak: number }> = {
  "carbine-1": { make: (r) => gunNear("carbine", r), peak: -1.5 },
  "carbine-2": { make: (r) => gunNear("carbine", r), peak: -1.5 },
  "carbine-3": { make: (r) => gunNear("carbine", r), peak: -1.5 },
  "carbine-far": { make: (r) => gunFar("carbine", r), peak: -3 },
  "shotgun": { make: (r) => gunNear("shotgun", r), peak: -1.5 },
  "shotgun-far": { make: (r) => gunFar("shotgun", r), peak: -2 },
  "marksman": { make: (r) => gunNear("marksman", r), peak: -1.5 },
  "marksman-far": { make: (r) => gunFar("marksman", r), peak: -2 },
  "dry": { make: dry, peak: -10 },
  "mag-out": { make: magOut, peak: -10 },
  "mag-in": { make: magIn, peak: -8 },
  "bolt": { make: boltRack, peak: -8 },
  "shell": { make: shell, peak: -12 },
  "pump": { make: pump, peak: -8 },
  "switch": { make: swap, peak: -11 },
  "impact-wall-1": { make: (r) => impactWall(r, false), peak: -4 },
  "impact-wall-2": { make: (r) => impactWall(r, false), peak: -4 },
  "impact-wall-3": { make: (r) => impactWall(r, true), peak: -4 },
  "impact-body-1": { make: impactBody, peak: -4 },
  "impact-body-2": { make: impactBody, peak: -4 },
  "step-1": { make: step, peak: -8 },
  "step-2": { make: step, peak: -8 },
  "step-3": { make: step, peak: -8 },
  "step-4": { make: step, peak: -8 },
  "jump": { make: jump, peak: -10 },
  "land": { make: land, peak: -6 },
  "hurt": { make: hurt, peak: -3 },
  "death": { make: death, peak: -3 },
  "hit": { make: hitTick, peak: -10 },
  "kill": { make: kill, peak: -7 },
  "respawn": { make: respawn, peak: -9 },
  "round-start": { make: roundStart, peak: -6 },
  "round-won": { make: roundWon, peak: -6 },
  "round-lost": { make: roundLost, peak: -6 },
  "ui-tick": { make: uiTick, peak: -16 },
};

// ---------------------------------------------------------------------------------------------------------------------
// Finishing, checking, encoding

/** High pass at 20 Hz, DC out, the end trimmed at -70 dB, fades at both ends (0.5 ms in: a shot's attack is its
 * point; out over 8 %), the peak set. */
function finish(x: Sig, peakDb: number): Sig {
  let y = filt(x, "hp", 20, 0.707);
  let peak = 0;
  for (const v of y) peak = Math.max(peak, Math.abs(v));
  let end = y.length;
  while (end > 1 && Math.abs(y[end - 1]!) < peak * db(-70)) end--;
  y = y.slice(0, Math.min(y.length, end + N(0.005)));
  const fin = N(0.0005), fout = Math.min(Math.round(y.length * 0.25), Math.max(N(0.012), Math.round(y.length * 0.08)));
  const w = new Float32Array(y.length).fill(1);
  for (let i = 0; i < fin; i++) w[i] = Math.sin((0.5 * Math.PI * i) / fin) ** 2;
  for (let i = 0; i < fout; i++) w[y.length - 1 - i] = Math.sin((0.5 * Math.PI * i) / fout) ** 2;
  // The mean out (what a short sound keeps of it past the high pass), shaped by the same window: the ends stay 0.
  let sum = 0, sw = 0;
  for (let i = 0; i < y.length; i++) { y[i]! *= w[i]!; sum += y[i]!; sw += w[i]!; }
  peak = 0;
  for (let i = 0; i < y.length; i++) { y[i]! -= (sum / sw) * w[i]!; peak = Math.max(peak, Math.abs(y[i]!)); }
  return amp(y, db(peakDb) / peak);
}

/** Length, peak and RMS (dBFS), the mean, the first sample and the largest of the last four. */
interface Stats { sec: number; peak: number; rms: number; dc: number; first: number; last: number }

function stats(x: ArrayLike<number>): Stats {
  let peak = 0, sum = 0, sq = 0;
  for (let i = 0; i < x.length; i++) { const v = x[i]!; peak = Math.max(peak, Math.abs(v)); sum += v; sq += v * v; }
  const edge = (from: number, to: number) => { let m = 0; for (let i = Math.max(0, from); i < Math.min(x.length, to); i++) m = Math.max(m, Math.abs(x[i]!)); return m; };
  return {
    sec: x.length / SR, peak: 20 * Math.log10(peak), rms: 10 * Math.log10(sq / x.length), dc: sum / x.length,
    first: edge(0, 1), last: edge(x.length - 4, x.length),
  };
}

function wav(x: Sig): Buffer {
  const b = Buffer.alloc(44 + x.length * 4);
  b.write("RIFF", 0); b.writeUInt32LE(36 + x.length * 4, 4); b.write("WAVE", 8);
  b.write("fmt ", 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(3, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(SR, 24); b.writeUInt32LE(SR * 4, 28); b.writeUInt16LE(4, 32); b.writeUInt16LE(32, 34);
  b.write("data", 36); b.writeUInt32LE(x.length * 4, 40);
  for (let i = 0; i < x.length; i++) b.writeFloatLE(x[i]!, 44 + i * 4);
  return b;
}

function ffmpeg(args: string[], input?: Buffer): Buffer {
  const p = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", ...args], { input, maxBuffer: 1 << 28 });
  if (p.status !== 0) throw new Error(`ffmpeg ${args.join(" ")}: ${p.stderr}`);
  return p.stdout;
}

/** Encodes (two equal channels: ffmpeg's Vorbis encoder takes no other), decodes it back, returns what plays. */
function encode(x: Sig, file: string): Float32Array {
  ffmpeg(["-y", "-f", "wav", "-i", "pipe:0", "-ac", "2", "-c:a", "vorbis", "-strict", "-2", "-q:a", "5",
    "-fflags", "+bitexact", "-flags:a", "+bitexact", "-map_metadata", "-1", file], wav(x));
  const raw = ffmpeg(["-i", file, "-ac", "1", "-f", "f32le", "pipe:1"]);
  return new Float32Array(raw.buffer, raw.byteOffset, raw.length >> 2);
}

// ---------------------------------------------------------------------------------------------------------------------

if (import.meta.main) {
  const args = process.argv.slice(2);
  const only = args.includes("--only") ? args[args.indexOf("--only") + 1]!.split(",") : null;
  const png = args.includes("--png"), keepWav = args.includes("--wav");
  mkdirSync(OUT, { recursive: true });
  mkdirSync(WORK, { recursive: true });
  const f = (v: number, d = 1) => v.toFixed(d).padStart(6);
  console.log(`${"name".padEnd(14)}    sec  peak dB  (ogg)  rms dB        dc   edges        KiB`);
  let total = 0, bad = 0;
  for (const [name, s] of Object.entries(SOUNDS)) {
    if (only && !only.includes(name)) continue;
    let x = finish(s.make(mulberry(hash(name))), s.peak);
    const file = join(OUT, `${name}.ogg`);
    let played = encode(x, file);
    // Vorbis can overshoot the peak a little: bring the source down until what plays stays at or under -1 dBFS.
    for (let k = 0; k < 4 && stats(played).peak > Math.min(-1, s.peak + 0.5); k++) {
      x = amp(x, db(-(stats(played).peak - Math.min(-1, s.peak + 0.5)) - 0.2));
      played = encode(x, file);
    }
    const a = stats(x), b = stats(played);
    const kib = statSync(file).size / 1024;
    total += kib;
    const ok = b.peak <= -1 && Math.abs(a.dc) < 1e-4 && a.first < 1e-3 && a.last < 1e-3;
    if (!ok) bad++;
    console.log(`${name.padEnd(14)} ${f(a.sec, 2)} ${f(a.peak)} ${f(b.peak)} ${f(a.rms)} ${a.dc.toExponential(1).padStart(9)} ${a.first.toExponential(0)}/${a.last.toExponential(0)} ${f(kib)}${ok ? "" : "  CHECK"}`);
    if (keepWav) writeFileSync(join(WORK, `${name}.wav`), wav(x));
    if (png) ffmpeg(["-y", "-i", file, "-lavfi", "showspectrumpic=s=640x240:legend=1:scale=log:fscale=lin:color=intensity", join(WORK, `${name}.png`)]);
  }
  console.log(`total ${total.toFixed(0)} KiB${bad ? `, ${bad} to check` : ""}`);
  if (bad) process.exitCode = 1;
}
