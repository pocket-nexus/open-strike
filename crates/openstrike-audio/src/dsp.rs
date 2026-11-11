//! DSP building blocks, shared by the bank's synthesis (offline, whole buffers) and the mixer (the reverb).

pub const SR: f32 = 48_000.0;
pub const PI: f32 = std::f32::consts::PI;
pub const TAU: f32 = std::f32::consts::TAU;

/// Seconds to samples.
pub fn secs(s: f32) -> usize {
    (s * SR).round().max(0.0) as usize
}

/// SplitMix64: small, fast, and good enough for noise. Deterministic from its seed.
/// Its state is in a `Cell` so a layer can take the generator and a value drawn from it in one call.
#[derive(Clone)]
pub struct Rng(std::cell::Cell<u64>);

impl Rng {
    pub fn new(seed: u64) -> Rng {
        Rng(std::cell::Cell::new(
            seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) ^ 0xD1B5_4A32_D192_ED03,
        ))
    }
    #[inline]
    pub fn u32(&self) -> u32 {
        let mut z = self.0.get().wrapping_add(0x9E37_79B9_7F4A_7C15);
        self.0.set(z);
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        ((z ^ (z >> 31)) >> 32) as u32
    }
    /// 0..1
    #[inline]
    pub fn f(&self) -> f32 {
        (self.u32() >> 8) as f32 * (1.0 / 16_777_216.0)
    }
    /// -1..1
    #[inline]
    pub fn bi(&self) -> f32 {
        self.f() * 2.0 - 1.0
    }
    pub fn range(&self, a: f32, b: f32) -> f32 {
        a + (b - a) * self.f()
    }
    /// `v` moved by up to ±`frac` of itself.
    pub fn jit(&self, v: f32, frac: f32) -> f32 {
        v * (1.0 + frac * self.bi())
    }
}

// ---------------------------------------------------------------------------------------------------------- filters

/// An RBJ biquad (transposed direct form II).
#[derive(Clone, Copy, Default)]
pub struct Biquad {
    b0: f32,
    b1: f32,
    b2: f32,
    a1: f32,
    a2: f32,
    z1: f32,
    z2: f32,
}

impl Biquad {
    fn of(b0: f32, b1: f32, b2: f32, a0: f32, a1: f32, a2: f32) -> Biquad {
        Biquad {
            b0: b0 / a0,
            b1: b1 / a0,
            b2: b2 / a0,
            a1: a1 / a0,
            a2: a2 / a0,
            z1: 0.0,
            z2: 0.0,
        }
    }
    fn wsc(fc: f32) -> (f32, f32) {
        (TAU * fc.clamp(8.0, SR * 0.49) / SR).sin_cos()
    }
    pub fn lp(fc: f32, q: f32) -> Biquad {
        let (s, c) = Self::wsc(fc);
        let al = s / (2.0 * q);
        Self::of(
            (1.0 - c) * 0.5,
            1.0 - c,
            (1.0 - c) * 0.5,
            1.0 + al,
            -2.0 * c,
            1.0 - al,
        )
    }
    pub fn hp(fc: f32, q: f32) -> Biquad {
        let (s, c) = Self::wsc(fc);
        let al = s / (2.0 * q);
        Self::of(
            (1.0 + c) * 0.5,
            -(1.0 + c),
            (1.0 + c) * 0.5,
            1.0 + al,
            -2.0 * c,
            1.0 - al,
        )
    }
    /// Band-pass with a 0 dB peak.
    pub fn bp(fc: f32, q: f32) -> Biquad {
        let (s, c) = Self::wsc(fc);
        let al = s / (2.0 * q);
        Self::of(al, 0.0, -al, 1.0 + al, -2.0 * c, 1.0 - al)
    }
    pub fn high_shelf(fc: f32, db: f32) -> Biquad {
        let (s, c) = Self::wsc(fc);
        let a = 10f32.powf(db / 40.0);
        let k = 2.0 * a.sqrt() * s * 0.5 * std::f32::consts::SQRT_2;
        Self::of(
            a * ((a + 1.0) + (a - 1.0) * c + k),
            -2.0 * a * ((a - 1.0) + (a + 1.0) * c),
            a * ((a + 1.0) + (a - 1.0) * c - k),
            (a + 1.0) - (a - 1.0) * c + k,
            2.0 * ((a - 1.0) - (a + 1.0) * c),
            (a + 1.0) - (a - 1.0) * c - k,
        )
    }
    #[inline]
    pub fn tick(&mut self, x: f32) -> f32 {
        let y = self.b0 * x + self.z1;
        self.z1 = self.b1 * x - self.a1 * y + self.z2;
        self.z2 = self.b2 * x - self.a2 * y;
        y
    }
}

pub fn filt(buf: &mut [f32], mut f: Biquad) {
    for x in buf {
        *x = f.tick(*x);
    }
}
/// 12 dB/octave low-pass.
pub fn lp(buf: &mut [f32], fc: f32) {
    filt(buf, Biquad::lp(fc, 0.707));
}
/// 12 dB/octave high-pass.
pub fn hp(buf: &mut [f32], fc: f32) {
    filt(buf, Biquad::hp(fc, 0.707));
}
/// 24 dB/octave (Butterworth) high-pass.
pub fn hp4(buf: &mut [f32], fc: f32) {
    filt(buf, Biquad::hp(fc, 0.541));
    filt(buf, Biquad::hp(fc, 1.307));
}
pub fn bp(buf: &mut [f32], fc: f32, q: f32) {
    filt(buf, Biquad::bp(fc, q));
}

#[derive(Clone, Copy)]
pub enum Kind {
    Lp,
    Bp,
}

/// A state-variable filter whose cutoff follows `fc(t)` (t in seconds): sweeps, whooshes, closing tails.
pub fn sweep(buf: &mut [f32], kind: Kind, q: f32, fc: impl Fn(f32) -> f32) {
    const STEP: usize = 32;
    let k = 1.0 / q;
    let (mut s1, mut s2) = (0.0f32, 0.0f32);
    let g_at = |i: usize| (PI * fc(i as f32 / SR).clamp(20.0, SR * 0.45) / SR).tan();
    let mut g0 = g_at(0);
    for (ci, chunk) in buf.chunks_mut(STEP).enumerate() {
        let g1 = g_at((ci + 1) * STEP);
        let dg = (g1 - g0) / STEP as f32;
        let mut g = g0;
        for x in chunk {
            let a1 = 1.0 / (1.0 + g * (g + k));
            let a2 = g * a1;
            let a3 = g * a2;
            let v3 = *x - s2;
            let v1 = a1 * s1 + a2 * v3;
            let v2 = s2 + a2 * s1 + a3 * v3;
            s1 = 2.0 * v1 - s1;
            s2 = 2.0 * v2 - s2;
            *x = match kind {
                Kind::Lp => v2,
                Kind::Bp => v1 * k,
            };
            g += dg;
        }
        g0 = g1;
    }
}

// -------------------------------------------------------------------------------------------------------- envelopes

/// Multiplies by `f(t)`, t in seconds.
pub fn env(buf: &mut [f32], f: impl Fn(f32) -> f32) {
    for (i, x) in buf.iter_mut().enumerate() {
        *x *= f(i as f32 / SR);
    }
}
/// Linear attack over `a` seconds, then an exponential decay with time constant `d`.
#[inline]
pub fn ad(t: f32, a: f32, d: f32) -> f32 {
    if t < 0.0 {
        0.0
    } else if t < a {
        t / a
    } else {
        (-(t - a) / d).exp()
    }
}
/// A bell around `c` seconds with width `w`.
#[inline]
pub fn bell(t: f32, c: f32, w: f32) -> f32 {
    let x = (t - c) / w;
    (-x * x).exp()
}
#[inline]
pub fn smoothstep(a: f32, b: f32, x: f32) -> f32 {
    let t = ((x - a) / (b - a)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}
pub fn fade_out(buf: &mut [f32], sec: f32) {
    let n = secs(sec).min(buf.len());
    let start = buf.len() - n;
    for i in 0..n {
        let k = 1.0 - (i + 1) as f32 / n as f32;
        buf[start + i] *= k * k * (3.0 - 2.0 * k);
    }
}
pub fn fade_in(buf: &mut [f32], sec: f32) {
    let n = secs(sec).min(buf.len());
    for i in 0..n {
        buf[i] *= i as f32 / n as f32;
    }
}

// ------------------------------------------------------------------------------------------------------- generators

pub fn white(rng: &Rng, len: usize) -> Vec<f32> {
    (0..len).map(|_| rng.bi()).collect()
}
/// Pink noise (Paul Kellet's economy filter), roughly ±1.
pub fn pink(rng: &Rng, len: usize) -> Vec<f32> {
    let (mut b0, mut b1, mut b2) = (0.0f32, 0.0f32, 0.0f32);
    (0..len)
        .map(|_| {
            let w = rng.bi();
            b0 = 0.99765 * b0 + w * 0.0990460;
            b1 = 0.96300 * b1 + w * 0.2965164;
            b2 = 0.57000 * b2 + w * 1.0526913;
            (b0 + b1 + b2 + w * 0.1848) * 0.25
        })
        .collect()
}
/// White noise band-limited to `lo..hi` Hz, at a fixed RMS (0.3) whatever the band.
pub fn band(rng: &Rng, len: usize, lo: f32, hi: f32) -> Vec<f32> {
    let mut x = white(rng, len);
    hp(&mut x, lo);
    lp(&mut x, hi);
    let r = rms(&x).max(1e-9);
    gain(&mut x, 0.3 / r);
    x
}
/// A sine whose frequency follows `f(t)`.
pub fn sine(len: usize, f: impl Fn(f32) -> f32) -> Vec<f32> {
    let mut ph = 0.0f32;
    (0..len)
        .map(|i| {
            let y = (ph * TAU).sin();
            ph += f(i as f32 / SR) / SR;
            ph -= ph.floor();
            y
        })
        .collect()
}
/// A sub thump: a sine falling from `f0` to `f1` (time constant `drop`), decaying with time constant `tau`.
pub fn thump(len: usize, f0: f32, f1: f32, drop: f32, tau: f32) -> Vec<f32> {
    let mut x = sine(len, |t| f1 + (f0 - f1) * (-t / drop).exp());
    env(&mut x, |t| (t / 0.0008).min(1.0) * (-t / tau).exp());
    x
}
/// Decaying partials `(hz, time constant, amplitude)`: struck metal, glass, bells.
pub fn modal(len: usize, modes: &[(f32, f32, f32)]) -> Vec<f32> {
    let mut out = vec![0.0f32; len];
    for &(hz, tau, amp) in modes {
        if hz >= SR * 0.47 {
            continue;
        }
        let r = (-1.0 / (tau * SR)).exp();
        let (s, c) = (TAU * hz / SR).sin_cos();
        let (mut re, mut im) = (amp, 0.0f32);
        let n = len.min(secs(tau * 9.0));
        for o in &mut out[..n] {
            *o += im;
            let nre = (re * c - im * s) * r;
            im = (re * s + im * c) * r;
            re = nre;
        }
    }
    out
}
/// Sparse random impulses, `density(t)` per second: grit, debris, crackle (filter them afterwards).
pub fn grains(rng: &Rng, len: usize, density: impl Fn(f32) -> f32) -> Vec<f32> {
    (0..len)
        .map(|i| {
            let p = density(i as f32 / SR) / SR;
            if rng.f() < p {
                rng.bi() * (0.4 + 0.6 * rng.f())
            } else {
                0.0
            }
        })
        .collect()
}
/// A slow random contour in 0..1 moving at about `hz`: cloth lumps, rolling rumble.
pub fn lumps(rng: &Rng, len: usize, hz: f32) -> Vec<f32> {
    let mut x = white(rng, len);
    lp(&mut x, hz);
    lp(&mut x, hz);
    let m = peak(&x).max(1e-9);
    for v in &mut x {
        *v = (*v / m).abs().sqrt();
    }
    lp(&mut x, hz * 4.0);
    x
}
/// A band-limited sawtooth (polyBLEP) at a fixed frequency.
pub fn saw(len: usize, hz: f32, phase: f32) -> Vec<f32> {
    let dt = hz / SR;
    let mut p = phase - phase.floor();
    (0..len)
        .map(|_| {
            let mut y = 2.0 * p - 1.0;
            if p < dt {
                let t = p / dt;
                y -= t + t - t * t - 1.0;
            } else if p > 1.0 - dt {
                let t = (p - 1.0) / dt;
                y -= t * t + t + t + 1.0;
            }
            p += dt;
            if p >= 1.0 {
                p -= 1.0;
            }
            y
        })
        .collect()
}

// ---------------------------------------------------------------------------------------------------------- utility

/// Mixes `src` into `dst` starting `at` seconds in, growing `dst` as needed.
pub fn add(dst: &mut Vec<f32>, src: &[f32], at: f32, g: f32) {
    let o = secs(at);
    if dst.len() < o + src.len() {
        dst.resize(o + src.len(), 0.0);
    }
    for (d, s) in dst[o..].iter_mut().zip(src) {
        *d += s * g;
    }
}
pub fn gain(buf: &mut [f32], g: f32) {
    for x in buf {
        *x *= g;
    }
}
pub fn peak(buf: &[f32]) -> f32 {
    buf.iter().fold(0.0f32, |m, x| m.max(x.abs()))
}
pub fn rms(buf: &[f32]) -> f32 {
    if buf.is_empty() {
        return 0.0;
    }
    (buf.iter().map(|x| (x * x) as f64).sum::<f64>() / buf.len() as f64).sqrt() as f32
}
/// Scales to a peak of `target`.
pub fn norm(buf: &mut [f32], target: f32) {
    let p = peak(buf);
    if p > 1e-9 {
        gain(buf, target / p);
    }
}
#[inline]
pub fn tanh_fast(x: f32) -> f32 {
    let x = x.clamp(-3.0, 3.0);
    let x2 = x * x;
    x * (27.0 + x2) / (27.0 + 9.0 * x2)
}
/// Saturation: grit and density. `g` is the drive into the curve; the output stays within ±1.
pub fn drive(buf: &mut [f32], g: f32) {
    for x in buf {
        *x = tanh_fast(*x * g);
    }
}
/// Delayed, darkened copies `(delay s, gain, low-pass Hz)` of `src`: early reflections, slap echoes.
pub fn echoes(src: &[f32], taps: &[(f32, f32, f32)]) -> Vec<f32> {
    let mut out = Vec::new();
    for &(d, g, fc) in taps {
        let mut c = src.to_vec();
        lp(&mut c, fc);
        add(&mut out, &c, d, g);
    }
    out
}

// ----------------------------------------------------------------------------------------------------------- reverb

const FDN: usize = 8;
const FDN_LEN: [usize; FDN] = [1559, 1877, 2203, 2521, 2857, 3181, 3539, 3907];
const AP_LEN: [usize; 4] = [241, 163, 277, 191];

/// A small feedback delay network (8 lines, Hadamard feedback, damped), stereo in and out. The mixer's shared
/// "outdoors" send, and the baked space of the stingers. Allocates only in `new`.
pub struct Reverb {
    line: [Box<[f32]>; FDN],
    pos: [usize; FDN],
    fb: [f32; FDN],
    lp: [f32; FDN],
    damp: f32,
    pre: Box<[f32]>,
    pre_pos: usize,
    ap: [Box<[f32]>; 4],
    ap_pos: [usize; 4],
    hp: [f32; 2],
    hp_a: f32,
}

impl Reverb {
    /// `rt60` seconds at low and mid frequencies; highs above `damp_hz` die faster; `predelay` seconds before the
    /// first reflection; `size` scales the delay lines (1 = 32..81 ms: a street, a yard).
    pub fn new(rt60: f32, damp_hz: f32, predelay: f32, size: f32) -> Reverb {
        let lens: [usize; FDN] =
            std::array::from_fn(|i| ((FDN_LEN[i] as f32 * size) as usize).max(16) | 1);
        Reverb {
            line: std::array::from_fn(|i| vec![0.0; lens[i]].into_boxed_slice()),
            pos: [0; FDN],
            fb: std::array::from_fn(|i| 10f32.powf(-3.0 * lens[i] as f32 / (rt60 * SR))),
            lp: [0.0; FDN],
            damp: 1.0 - (-TAU * damp_hz / SR).exp(),
            pre: vec![0.0; (secs(predelay).max(1)) * 2].into_boxed_slice(),
            pre_pos: 0,
            ap: std::array::from_fn(|i| vec![0.0; AP_LEN[i]].into_boxed_slice()),
            ap_pos: [0; 4],
            hp: [0.0; 2],
            hp_a: 1.0 - (-TAU * 140.0 / SR).exp(),
        }
    }

    pub fn clear(&mut self) {
        for l in &mut self.line {
            l.fill(0.0);
        }
        for a in &mut self.ap {
            a.fill(0.0);
        }
        self.pre.fill(0.0);
        self.lp = [0.0; FDN];
        self.hp = [0.0; 2];
    }

    #[inline]
    fn allpass(&mut self, i: usize, x: f32) -> f32 {
        const G: f32 = 0.6;
        let buf = &mut self.ap[i];
        let p = self.ap_pos[i];
        let d = buf[p];
        let w = x + d * G;
        buf[p] = w;
        self.ap_pos[i] = if p + 1 == buf.len() { 0 } else { p + 1 };
        d - w * G
    }

    /// One frame: the wet signal only.
    #[inline]
    pub fn tick(&mut self, l: f32, r: f32) -> (f32, f32) {
        // Pre-delay, then two all-passes a side so a gunshot's crack arrives smeared, not as a train of pings.
        let p = self.pre_pos;
        let (dl, dr) = (self.pre[p], self.pre[p + 1]);
        self.pre[p] = l;
        self.pre[p + 1] = r;
        self.pre_pos = if p + 2 >= self.pre.len() { 0 } else { p + 2 };
        let a = self.allpass(0, dl);
        let il = self.allpass(1, a);
        let a = self.allpass(2, dr);
        let ir = self.allpass(3, a);

        let mut v = [0.0f32; FDN];
        for i in 0..FDN {
            let o = self.line[i][self.pos[i]];
            self.lp[i] += self.damp * (o - self.lp[i]);
            v[i] = self.lp[i];
        }
        let out_l = v[0] - v[2] + v[4] - v[6];
        let out_r = v[1] - v[3] + v[5] - v[7];
        // Hadamard (fast Walsh) feedback: every line feeds every other, so the echo density builds quickly.
        let mut h = 1;
        while h < FDN {
            let mut i = 0;
            while i < FDN {
                for j in i..i + h {
                    let (x, y) = (v[j], v[j + h]);
                    v[j] = x + y;
                    v[j + h] = x - y;
                }
                i += h * 2;
            }
            h *= 2;
        }
        const NORM: f32 = 0.353_553_4; // 1/sqrt(8)
        for i in 0..FDN {
            let input = if i % 2 == 0 { il } else { ir };
            let p = self.pos[i];
            self.line[i][p] = input + v[i] * NORM * self.fb[i];
            self.pos[i] = if p + 1 == self.line[i].len() {
                0
            } else {
                p + 1
            };
        }
        // The return loses its lows: outdoors the bass does not hang around, and the mix stays clear.
        self.hp[0] += self.hp_a * (out_l - self.hp[0]);
        self.hp[1] += self.hp_a * (out_r - self.hp[1]);
        ((out_l - self.hp[0]) * 0.5, (out_r - self.hp[1]) * 0.5)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn level(x: &[f32]) -> f32 {
        20.0 * rms(x).max(1e-12).log10()
    }

    #[test]
    fn the_mixer_reverb_rings_for_about_its_rt60_and_then_stops() {
        // The mixer's own settings: an impulse in, and the time its level takes to fall 60 dB.
        let mut rev = Reverb::new(1.2, 3800.0, 0.028, 1.0);
        let n = secs(4.0);
        let (mut l, mut r) = (vec![0.0f32; n], vec![0.0f32; n]);
        for i in 0..n {
            (l[i], r[i]) = rev.tick(if i == 0 { 1.0 } else { 0.0 }, 0.0);
        }
        assert!(l.iter().chain(&r).all(|x| x.is_finite()));
        let win = secs(0.05);
        let env: Vec<f32> = l
            .chunks(win)
            .zip(r.chunks(win))
            .map(|(a, b)| level(a).max(level(b)))
            .collect();
        let top = env.iter().fold(f32::MIN, |m, v| m.max(*v));
        let loudest = env.iter().position(|v| *v == top).unwrap();
        let quiet = env[loudest..]
            .iter()
            .position(|v| *v < top - 60.0)
            .expect("the reverb never decays");
        let t60 = quiet as f32 * 0.05;
        assert!((0.7..=1.6).contains(&t60), "RT60 is {t60} s");
        // Nothing arrives before the pre-delay; left and right are different (it is a stereo tail).
        assert!(peak(&l[..secs(0.027)]) == 0.0 && peak(&l[..secs(0.2)]) > 0.0);
        let diff: Vec<f32> = l.iter().zip(&r).map(|(a, b)| a - b).collect();
        assert!(rms(&diff) > 0.5 * rms(&l));
        // Dark: its highs die sooner than its mids.
        let (mut hi, mut mid) = (l.clone(), l.clone());
        hp(&mut hi, 6000.0);
        bp(&mut mid, 800.0, 1.0);
        let late = |x: &[f32]| level(&x[secs(0.5)..secs(0.8)]) - level(&x[secs(0.05)..secs(0.2)]);
        assert!(
            late(&hi) < late(&mid) - 6.0,
            "highs {} mids {}",
            late(&hi),
            late(&mid)
        );
        rev.clear();
        assert_eq!(rev.tick(0.0, 0.0), (0.0, 0.0));
    }

    #[test]
    fn filters_do_what_they_say() {
        let tone = |hz: f32| sine(secs(0.5), |_| hz);
        let through = |mut x: Vec<f32>, f: fn(&mut [f32], f32), fc: f32| {
            f(&mut x, fc);
            level(&x[secs(0.1)..])
        };
        let unity = level(&tone(1000.0));
        assert!((through(tone(200.0), lp, 2000.0) - unity).abs() < 0.5);
        assert!(through(tone(8000.0), lp, 2000.0) < unity - 20.0);
        assert!(through(tone(200.0), hp, 2000.0) < unity - 30.0);
        assert!(through(tone(200.0), hp4, 2000.0) < unity - 60.0);
        assert!((through(tone(8000.0), hp, 2000.0) - unity).abs() < 0.5);
        // The swept filter with a fixed cutoff matches the biquad.
        let mut a = tone(8000.0);
        sweep(&mut a, Kind::Lp, 0.707, |_| 2000.0);
        assert!((level(&a[secs(0.1)..]) - through(tone(8000.0), lp, 2000.0)).abs() < 1.0);
        // A band-pass passes its centre at unity.
        let mut b = tone(1000.0);
        bp(&mut b, 1000.0, 4.0);
        assert!((level(&b[secs(0.1)..]) - unity).abs() < 0.5);
        let mut b = tone(1000.0);
        sweep(&mut b, Kind::Bp, 4.0, |_| 1000.0);
        assert!((level(&b[secs(0.1)..]) - unity).abs() < 0.5);
    }

    #[test]
    fn generators_are_bounded_and_centred() {
        let rng = Rng::new(1);
        for x in [
            white(&rng, 48_000),
            pink(&rng, 48_000),
            band(&rng, 48_000, 300.0, 3000.0),
            saw(48_000, 440.0, 0.3),
        ] {
            assert!(x.iter().all(|v| v.is_finite()) && peak(&x) < 4.0 && peak(&x) > 0.1);
            assert!((x.iter().sum::<f32>() / x.len() as f32).abs() < 0.05);
        }
        // The saw is band-limited: far less lands between its harmonics than a naive saw's aliases put there.
        let hz = 2793.8f32;
        let stray = |x: &[f32]| {
            let spec = crate::analysis::spectrum(x, 4096);
            let bin = 48_000.0 / 4096.0;
            let off: f64 = spec
                .iter()
                .enumerate()
                .filter(|(k, _)| ((*k as f32 * bin / hz).fract() - 0.5).abs() < 0.3)
                .map(|(_, e)| *e)
                .sum();
            off / spec.iter().sum::<f64>()
        };
        let naive: Vec<f32> = (0..48_000)
            .map(|i| 2.0 * (i as f32 * hz / SR).fract() - 1.0)
            .collect();
        let ours = saw(48_000, hz, 0.0);
        assert!(
            stray(&ours) < 0.1 * stray(&naive),
            "aliasing: {} against a naive saw's {}",
            stray(&ours),
            stray(&naive)
        );
        // The same seed, the same noise.
        assert!(white(&Rng::new(9), 100) == white(&Rng::new(9), 100));
        assert!(white(&Rng::new(9), 100) != white(&Rng::new(10), 100));
    }
}
