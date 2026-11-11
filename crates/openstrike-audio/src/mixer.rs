//! The mixer: voices, their place in the world, the shared reverb, the master bus. 48 kHz stereo.
//!
//! Nothing here allocates or locks after `new`: `render` is called from the platform's audio callback or writer
//! thread. A voice plays one variation of a sound: its mono stem resampled (pitch), low-passed by distance, panned
//! with equal power and a small interaural delay, and attenuated by 1/d; its wide stem (a gunshot's tail) kept
//! broad and attenuated less, so a far shot is mostly tail. World voices feed the reverb and the `muffle` filter;
//! feedback and UI voices go around both.

use std::sync::Arc;

use crate::bank::{Bank, Clip, ENV_HOP};
use crate::dsp::{PI, Reverb, Rng, SR, TAU, smoothstep, tanh_fast};
use crate::sound::Sound;

/// Frames per internal block: voice parameters are computed once a block and ramped across it.
pub(crate) const BLOCK: usize = 128;
/// Voices that may sound at once. Past this the quietest (then the oldest) world voice is stolen.
pub(crate) const VOICES: usize = 64;
/// A stolen voice fades for a few ms in a spare slot instead of clicking off.
const SLOTS: usize = VOICES + 8;
const HIST: usize = 64;
/// The far ear hears a source at the side this many samples late (0.6 ms).
const ITD: f32 = 29.0;
const SPEED_OF_SOUND: f32 = 343.0;
/// Per-sample step of a stolen or stopped voice's fade (5 ms).
const FADE: f32 = 1.0 / 240.0;
/// A positional source at its reference distance, dead ahead, against the same sound played non-positionally.
const WORLD_GAIN: f32 = 1.3;

/// What the game asks of the mixer. (`Default` only fills the command queue's empty slots.)
#[derive(Clone, Copy, Default)]
pub(crate) enum Cmd {
    Listener {
        pos: [f32; 3],
        fwd: [f32; 3],
        right: [f32; 3],
    },
    Play {
        sound: Sound,
        at: Option<[f32; 3]>,
        gain: f32,
        pitch: f32,
    },
    Muffle(f32),
    Master(f32),
    #[default]
    StopAll,
}

/// What a voice's place in the world comes to, per block.
#[derive(Clone, Copy, Default)]
struct Params {
    /// Mono stem to the left and right outputs.
    ml: f32,
    mr: f32,
    /// Wide stem: its left to the left, its right to the right.
    wl: f32,
    wr: f32,
    /// Reverb send, left and right.
    sl: f32,
    sr: f32,
    /// Low-pass coefficient (1 = open).
    a: f32,
    /// Interaural delay per ear, samples.
    dl: f32,
    dr: f32,
}

impl Params {
    fn ramp(self, to: Params, n: f32) -> Params {
        let d = |a: f32, b: f32| (b - a) / n;
        Params {
            ml: d(self.ml, to.ml),
            mr: d(self.mr, to.mr),
            wl: d(self.wl, to.wl),
            wr: d(self.wr, to.wr),
            sl: d(self.sl, to.sl),
            sr: d(self.sr, to.sr),
            a: d(self.a, to.a),
            dl: d(self.dl, to.dl),
            dr: d(self.dr, to.dr),
        }
    }
    #[inline]
    fn step(&mut self, d: &Params) {
        self.ml += d.ml;
        self.mr += d.mr;
        self.wl += d.wl;
        self.wr += d.wr;
        self.sl += d.sl;
        self.sr += d.sr;
        self.a += d.a;
        self.dl += d.dl;
        self.dr += d.dr;
    }
    fn level(&self) -> f32 {
        (self.ml + self.mr).max(self.wl + self.wr)
    }
}

#[derive(Clone, Copy)]
struct Voice {
    on: bool,
    sound: Sound,
    var: u8,
    ui: bool,
    at: Option<[f32; 3]>,
    gain: f32,
    /// Clip frames per output frame.
    step: f64,
    pos: f64,
    /// Output frames before it starts: the sound's travel time.
    wait: u32,
    serial: u64,
    fading: bool,
    fade: f32,
    cur: Params,
    z: [f32; 2],
    wz: [f32; 4],
    hist: [f32; HIST],
    head: usize,
}

const IDLE: Voice = Voice {
    on: false,
    sound: Sound::UiMove,
    var: 0,
    ui: false,
    at: None,
    gain: 0.0,
    step: 1.0,
    pos: 0.0,
    wait: 0,
    serial: 0,
    fading: false,
    fade: 1.0,
    cur: Params {
        ml: 0.0,
        mr: 0.0,
        wl: 0.0,
        wr: 0.0,
        sl: 0.0,
        sr: 0.0,
        a: 1.0,
        dl: 0.0,
        dr: 0.0,
    },
    z: [0.0; 2],
    wz: [0.0; 4],
    hist: [0.0; HIST],
    head: 0,
};

#[derive(Clone, Copy)]
struct Listener {
    pos: [f32; 3],
    fwd: [f32; 3],
    right: [f32; 3],
}

fn sub(a: [f32; 3], b: [f32; 3]) -> [f32; 3] {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}
fn dot(a: [f32; 3], b: [f32; 3]) -> f32 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}
fn unit(a: [f32; 3], or: [f32; 3]) -> [f32; 3] {
    let l = dot(a, a).sqrt();
    if l > 1e-6 && l.is_finite() {
        [a[0] / l, a[1] / l, a[2] / l]
    } else {
        or
    }
}
fn finite(a: [f32; 3]) -> bool {
    a.iter().all(|c| c.is_finite())
}
/// Equal-power pan: -1 left, 1 right.
fn pan(x: f32) -> (f32, f32) {
    let (s, c) = ((x + 1.0) * (PI / 4.0)).sin_cos();
    (c, s)
}
/// One-pole coefficient for a cutoff, opening fully (1 = no filter) as the cutoff nears the top of the band.
fn lp_coef(fc: f32) -> f32 {
    let a = 1.0 - (-TAU * fc / SR).exp();
    a + (1.0 - a) * smoothstep(9000.0, 19_000.0, fc)
}

/// Where a voice sits for the listener.
fn place(lis: &Listener, v: &Voice) -> Params {
    let spec = v.sound.spec();
    let Some(at) = v.at else {
        // Not positional: the player's own weapon and body, the HUD. Centred, full, close, nearly dry.
        let g = v.gain;
        let s = g * spec.send * 0.5;
        return Params {
            ml: g,
            mr: g,
            wl: g,
            wr: g,
            sl: s,
            sr: s,
            a: 1.0,
            dl: 0.0,
            dr: 0.0,
        };
    };
    let to = sub(at, lis.pos);
    let d = dot(to, to).sqrt();
    let dir = unit(to, [0.0; 3]);
    // Inside arm's reach direction means little: fold to the centre instead of flipping sides.
    let close = smoothstep(0.15, 1.2, d);
    let az = dot(dir, lis.right).clamp(-1.0, 1.0) * close;
    let rear = (-dot(dir, lis.fwd)).clamp(0.0, 1.0) * close;
    let att = spec.near / d.max(spec.near);
    let g =
        v.gain * WORLD_GAIN * (1.0 - smoothstep(spec.far * 0.7, spec.far, d)) * (1.0 - 0.12 * rear);
    // The transient falls with 1/d; the tail (already the environment's answer) carries further and stays broad.
    let (direct, wide) = (g * att, g * att.powf(spec.tail_exp));
    let (pl, pr) = pan(az * 0.88);
    let (tl, tr) = pan(az * 0.6);
    // Air and distance take the highs, and so (a little) does a source behind the head.
    let fc = 20_000.0 / (1.0 + d / 14.0) * (1.0 - 0.3 * rear);
    // The reverb falls off slower than the direct sound: far sources are mostly room.
    let send = g * spec.send * att.sqrt();
    Params {
        ml: direct * pl,
        mr: direct * pr,
        wl: wide * tl,
        wr: wide * tr,
        sl: send * tl,
        sr: send * tr,
        a: lp_coef(fc),
        dl: az.max(0.0) * ITD,
        dr: (-az).max(0.0) * ITD,
    }
}

#[inline]
fn at(b: &[f32], i: isize) -> f32 {
    if i >= 0 && (i as usize) < b.len() {
        b[i as usize]
    } else {
        0.0
    }
}

/// Renders `n` frames of a voice into `bus` and `send` (interleaved stereo). True when the voice has finished.
fn run(
    v: &mut Voice,
    clip: &Clip,
    to: Params,
    n: usize,
    bus: &mut [f32],
    send: &mut [f32],
) -> bool {
    let mut start = 0;
    if v.wait > 0 {
        start = (v.wait as usize).min(n);
        v.wait -= start as u32;
        if start == n {
            return false;
        }
    }
    let d = v.cur.ramp(to, (n - start) as f32);
    let mut p = v.cur;
    let (mono, wide) = (&clip.mono[..], &clip.wide[..]);
    // Past the clip's end the filters and the interaural delay still have a few samples to give.
    let end = (clip.frames + HIST) as f64;
    let mut done = false;
    for i in start..n {
        if v.pos >= end {
            done = true;
            break;
        }
        let ip = v.pos as isize;
        let f = (v.pos - ip as f64) as f32;
        let (mut l, mut r, mut x) = (0.0f32, 0.0f32, 0.0f32);
        if !mono.is_empty() {
            // Four-point Hermite: pitch without the dullness of linear interpolation.
            let (ym, y0, y1, y2) = if ip >= 1 && (ip as usize) + 2 < mono.len() {
                let k = ip as usize;
                (mono[k - 1], mono[k], mono[k + 1], mono[k + 2])
            } else {
                (
                    at(mono, ip - 1),
                    at(mono, ip),
                    at(mono, ip + 1),
                    at(mono, ip + 2),
                )
            };
            let c1 = 0.5 * (y1 - ym);
            let c2 = ym - 2.5 * y0 + 2.0 * y1 - 0.5 * y2;
            let c3 = 0.5 * (y2 - ym) + 1.5 * (y0 - y1);
            let s = ((c3 * f + c2) * f + c1) * f + y0;
            v.z[0] += p.a * (s - v.z[0]);
            v.z[1] += p.a * (v.z[0] - v.z[1]);
            x = v.z[1];
            v.hist[v.head] = x;
            let h = v.head + HIST;
            let (il, ir) = (p.dl as usize, p.dr as usize);
            let (fl, fr) = (p.dl - il as f32, p.dr - ir as f32);
            let a = v.hist[(h - il) % HIST];
            let b = v.hist[(h - il - 1) % HIST];
            l = (a + (b - a) * fl) * p.ml;
            let a = v.hist[(h - ir) % HIST];
            let b = v.hist[(h - ir - 1) % HIST];
            r = (a + (b - a) * fr) * p.mr;
            v.head = (v.head + 1) % HIST;
        }
        let (mut sl, mut sr) = (x * p.sl, x * p.sr);
        if !wide.is_empty() {
            let k = ip * 2;
            let (a0, a1) = (at(wide, k), at(wide, k + 1));
            let (b0, b1) = (at(wide, k + 2), at(wide, k + 3));
            let (w0, w1) = (a0 + (b0 - a0) * f, a1 + (b1 - a1) * f);
            v.wz[0] += p.a * (w0 - v.wz[0]);
            v.wz[1] += p.a * (v.wz[0] - v.wz[1]);
            v.wz[2] += p.a * (w1 - v.wz[2]);
            v.wz[3] += p.a * (v.wz[2] - v.wz[3]);
            l += v.wz[1] * p.wl;
            r += v.wz[3] * p.wr;
            // The tail is reverberant already: only a little more of it goes to the send.
            sl += v.wz[1] * p.sl * 0.35;
            sr += v.wz[3] * p.sr * 0.35;
        }
        if v.fading {
            v.fade -= FADE;
            if v.fade <= 0.0 {
                done = true;
                break;
            }
            l *= v.fade;
            r *= v.fade;
            sl *= v.fade;
            sr *= v.fade;
        }
        bus[i * 2] += l;
        bus[i * 2 + 1] += r;
        send[i * 2] += sl;
        send[i * 2 + 1] += sr;
        v.pos += v.step;
        p.step(&d);
    }
    v.cur = to;
    done
}

const LOOK: usize = 96;
/// The limiter holds peaks to this; what little slips past meets the soft clip, which ends below full scale.
const THRESHOLD: f32 = 0.89;
const CEILING: f32 = 0.98;

/// A look-ahead peak limiter (2 ms, both channels linked) and a soft clip behind it: stacked gunfire is pushed down
/// smoothly instead of squaring off.
///
/// Each sample asks for a gain (`THRESHOLD / peak`, or 1). The gain applied is the mean, over the look-ahead, of
/// the minimum asked for over the look-ahead: a ramp that has always arrived by the time the peak that asked for it
/// leaves the delay line, so nothing overshoots.
struct Limiter {
    delay: [[f32; 2]; LOOK],
    /// The targets of the last LOOK samples, and their sum.
    gains: [f32; LOOK],
    sum: f64,
    pos: usize,
    /// Sliding minimum of the asked gains: a monotonic queue of (gain, sample number), oldest first.
    queue: [(f32, u64); LOOK],
    head: usize,
    len: usize,
    now: u64,
    target: f32,
    /// Release: towards 1 with a 120 ms time constant, and never faster than 60 dB a second (so a mix pushed far
    /// down swells back instead of snapping back).
    release: f32,
    release_cap: f32,
}

impl Limiter {
    fn new() -> Limiter {
        Limiter {
            delay: [[0.0; 2]; LOOK],
            gains: [1.0; LOOK],
            sum: LOOK as f64,
            pos: 0,
            queue: [(1.0, 0); LOOK],
            head: 0,
            len: 0,
            now: 0,
            target: 1.0,
            release: 1.0 - (-1.0 / (0.12 * SR)).exp(),
            release_cap: 10f32.powf(60.0 / 20.0 / SR),
        }
    }

    #[inline]
    fn tick(&mut self, l: f32, r: f32) -> (f32, f32) {
        let p = l.abs().max(r.abs());
        let need = if p > THRESHOLD { THRESHOLD / p } else { 1.0 };
        self.now += 1;
        if self.len > 0 && self.queue[self.head].1 + LOOK as u64 <= self.now {
            self.head = (self.head + 1) % LOOK;
            self.len -= 1;
        }
        while self.len > 0 && self.queue[(self.head + self.len - 1) % LOOK].0 >= need {
            self.len -= 1;
        }
        self.queue[(self.head + self.len) % LOOK] = (need, self.now);
        self.len += 1;
        let floor = self.queue[self.head].0;
        let up =
            (self.target + (1.0 - self.target) * self.release).min(self.target * self.release_cap);
        self.target = floor.min(up);
        let i = self.pos;
        self.sum += (self.target - self.gains[i]) as f64;
        self.gains[i] = self.target;
        let g = (self.sum / LOOK as f64) as f32;
        self.delay[i] = [l, r];
        self.pos = if i + 1 == LOOK { 0 } else { i + 1 };
        // The oldest sample in the delay line: LOOK - 1 ticks old, and inside every window the mean was taken over.
        let [dl, dr] = self.delay[self.pos];
        (soft_clip(dl * g), soft_clip(dr * g))
    }
}

#[inline]
fn soft_clip(x: f32) -> f32 {
    let a = x.abs();
    if a <= THRESHOLD {
        x
    } else {
        let over = (a - THRESHOLD) / (CEILING - THRESHOLD);
        (THRESHOLD + (CEILING - THRESHOLD) * tanh_fast(over)).copysign(x)
    }
}

pub(crate) struct Mixer {
    bank: Arc<Bank>,
    voices: Box<[Voice; SLOTS]>,
    lis: Listener,
    rng: Rng,
    last_var: [u8; Sound::COUNT],
    serial: u64,
    muffle: f32,
    muffle_to: f32,
    muffle_z: [f32; 4],
    master: f32,
    master_to: f32,
    reverb: Reverb,
    /// Frames left of the reverb's fade after `stop_all` (then it is cleared).
    flush: usize,
    /// Blocks since anything was sent to the reverb. Once its tail is far below hearing it is cleared and left
    /// alone: silence is exact zeros, costs nothing, and never decays into denormals.
    idle: usize,
    limiter: Limiter,
    world: [f32; BLOCK * 2],
    ui: [f32; BLOCK * 2],
    send: [f32; BLOCK * 2],
    /// The block being handed out, and how much of it has been.
    out: [f32; BLOCK * 2],
    out_pos: usize,
    /// Voices sounding in the last block.
    pub active: usize,
}

const FLUSH: usize = 480;
/// Blocks of silence into the reverb (4 s: its tail is 200 dB down) before it is put to rest.
const REVERB_IDLE: usize = 4 * 48_000 / BLOCK;

impl Mixer {
    pub fn new(bank: Arc<Bank>) -> Mixer {
        Mixer {
            bank,
            voices: Box::new([IDLE; SLOTS]),
            lis: Listener {
                pos: [0.0; 3],
                fwd: [0.0, 0.0, -1.0],
                right: [1.0, 0.0, 0.0],
            },
            rng: Rng::new(0x0A0D_105E),
            last_var: [u8::MAX; Sound::COUNT],
            serial: 0,
            muffle: 0.0,
            muffle_to: 0.0,
            muffle_z: [0.0; 4],
            master: 1.0,
            master_to: 1.0,
            // Outdoors, a street between buildings: about 1.2 s, a clear gap before the first return, dark.
            reverb: Reverb::new(1.2, 3800.0, 0.028, 1.0),
            flush: 0,
            idle: REVERB_IDLE,
            limiter: Limiter::new(),
            world: [0.0; BLOCK * 2],
            ui: [0.0; BLOCK * 2],
            send: [0.0; BLOCK * 2],
            out: [0.0; BLOCK * 2],
            out_pos: BLOCK * 2,
            active: 0,
        }
    }

    pub fn apply(&mut self, cmd: Cmd) {
        match cmd {
            Cmd::Listener { pos, fwd, right } => {
                if finite(pos) && finite(fwd) && finite(right) {
                    self.lis = Listener {
                        pos,
                        fwd: unit(fwd, self.lis.fwd),
                        right: unit(right, self.lis.right),
                    };
                }
            }
            Cmd::Play {
                sound,
                at,
                gain,
                pitch,
            } => self.play(sound, at, gain, pitch),
            Cmd::Muffle(k) => {
                self.muffle_to = if k.is_finite() {
                    k.clamp(0.0, 1.0)
                } else {
                    0.0
                }
            }
            Cmd::Master(g) => {
                self.master_to = if g.is_finite() {
                    g.clamp(0.0, 4.0)
                } else {
                    1.0
                }
            }
            Cmd::StopAll => {
                for v in self.voices.iter_mut().filter(|v| v.on) {
                    v.fading = true;
                }
                self.flush = FLUSH;
            }
        }
    }

    fn play(&mut self, sound: Sound, at: Option<[f32; 3]>, gain: f32, pitch: f32) {
        let spec = sound.spec();
        if gain.is_nan() || gain <= 0.0 || gain.is_infinite() || !pitch.is_finite() {
            return;
        }
        // Feedback and UI sounds have no place in the world, whatever the caller passes.
        let at = if sound.is_ui() { None } else { at };
        let mut dist = 0.0;
        if let Some(p) = at {
            if !finite(p) {
                return;
            }
            let to = sub(p, self.lis.pos);
            dist = dot(to, to).sqrt();
            if dist >= spec.far {
                return;
            }
        }
        // A variation other than the last one played, if it is synthesized yet (else any that is; else nothing).
        let vars = spec.vars as usize;
        let last = self.last_var[sound as usize] as usize;
        let mut var = if vars > 1 && last < vars {
            let k = self.rng.u32() as usize % (vars - 1);
            if k >= last { k + 1 } else { k }
        } else {
            self.rng.u32() as usize % vars
        };
        let mut tries = 0;
        while self.bank.clip(sound, var).is_none() {
            tries += 1;
            if tries == vars {
                return;
            }
            var = (var + 1) % vars;
        }
        self.last_var[sound as usize] = var as u8;
        let jitter = 1.0 + spec.jitter * self.rng.bi();
        let level = if spec.jitter > 0.0 {
            1.0 + 0.07 * self.rng.bi()
        } else {
            1.0
        };
        self.serial += 1;
        let mut v = Voice {
            on: true,
            sound,
            var: var as u8,
            ui: sound.is_ui(),
            at,
            gain: gain.min(4.0) * level,
            step: (pitch.clamp(0.5, 2.0) * jitter) as f64,
            wait: ((dist / SPEED_OF_SOUND).min(0.5) * SR) as u32,
            serial: self.serial,
            ..IDLE
        };
        v.cur = place(&self.lis, &v);
        if let Some(slot) = self.slot(v.ui) {
            self.voices[slot] = v;
        }
    }

    /// A slot for a new voice, stealing if all voices are taken. None: every voice is feedback or UI, which a world
    /// sound may not take (and which never number that many).
    fn slot(&mut self, _ui: bool) -> Option<usize> {
        let sounding = self.voices.iter().filter(|v| v.on && !v.fading).count();
        if sounding >= VOICES {
            // The quietest world voice right now (its mix level times where its clip's contour has got to); of
            // equals, the oldest.
            let bank = &self.bank;
            let now = |v: &Voice| {
                let env = bank.clip(v.sound, v.var as usize).map_or(0.0, |c| {
                    c.env.get(v.pos as usize / ENV_HOP).copied().unwrap_or(0.0)
                });
                v.cur.level() * env
            };
            let victim = self
                .voices
                .iter()
                .enumerate()
                .filter(|(_, v)| v.on && !v.fading && !v.ui)
                .min_by(|(_, a), (_, b)| now(a).total_cmp(&now(b)).then(a.serial.cmp(&b.serial)))
                .map(|(i, _)| i)?;
            self.voices[victim].fading = true;
        }
        if let Some(free) = self.voices.iter().position(|v| !v.on) {
            return Some(free);
        }
        // Every spare slot is still fading (a burst of steals inside 5 ms): cut the one nearest to silence.
        self.voices
            .iter()
            .enumerate()
            .filter(|(_, v)| v.fading)
            .min_by(|(_, a), (_, b)| a.fade.total_cmp(&b.fade))
            .map(|(i, _)| i)
    }

    /// Mixes the next `out.len() / 2` frames (interleaved stereo). The mix runs in fixed blocks whatever sizes the
    /// caller asks for, so the same commands at the same frames give the same samples on every output.
    pub fn render(&mut self, mut out: &mut [f32]) {
        while !out.is_empty() {
            if self.out_pos == BLOCK * 2 {
                self.block();
                self.out_pos = 0;
            }
            let n = out.len().min(BLOCK * 2 - self.out_pos);
            let (head, rest) = out.split_at_mut(n);
            head.copy_from_slice(&self.out[self.out_pos..self.out_pos + n]);
            self.out_pos += n;
            out = rest;
        }
    }

    fn block(&mut self) {
        let n = BLOCK;
        let (world, ui, send, out) = (&mut self.world, &mut self.ui, &mut self.send, &mut self.out);
        world.fill(0.0);
        ui.fill(0.0);
        send.fill(0.0);
        let mut active = 0;
        for v in self.voices.iter_mut().filter(|v| v.on) {
            let Some(clip) = self.bank.clip(v.sound, v.var as usize) else {
                v.on = false;
                continue;
            };
            active += 1;
            let to = place(&self.lis, v);
            let bus = if v.ui { &mut ui[..] } else { &mut world[..] };
            if run(v, clip, to, n, bus, &mut send[..]) {
                v.on = false;
            }
        }
        self.active = active;
        if send.iter().any(|x| *x != 0.0) {
            self.idle = 0;
        } else if self.idle < REVERB_IDLE {
            self.idle += 1;
            if self.idle == REVERB_IDLE {
                self.reverb.clear();
            }
        }
        let reverb_on = self.idle < REVERB_IDLE;

        // The world bus: voices and their reverb, through the muffle (a duck and a low-pass that closes with k).
        let m0 = self.muffle;
        self.muffle += (self.muffle_to - self.muffle) * 0.06;
        if (self.muffle_to - self.muffle).abs() < 1e-4 {
            self.muffle = self.muffle_to;
        }
        let shape = |k: f32| {
            (
                1.0 - 0.5 * k,
                lp_coef(20_000.0 * (320.0f32 / 20_000.0).powf(k)),
            )
        };
        let ((g0, a0), (g1, a1)) = (shape(m0), shape(self.muffle));
        let (dg, da) = ((g1 - g0) / n as f32, (a1 - a0) / n as f32);
        let (mut g, mut a) = (g0, a0);
        let m0 = self.master;
        self.master = self.master_to;
        let dm = (self.master - m0) / n as f32;
        let mut m = m0;
        let z = &mut self.muffle_z;
        for i in 0..n {
            let (mut wl, mut wr) = if reverb_on {
                self.reverb.tick(send[i * 2], send[i * 2 + 1])
            } else {
                (0.0, 0.0)
            };
            if self.flush > 0 {
                let k = self.flush as f32 / FLUSH as f32;
                wl *= k;
                wr *= k;
                self.flush -= 1;
                if self.flush == 0 {
                    self.reverb.clear();
                    self.idle = REVERB_IDLE;
                }
            }
            let (l, r) = (world[i * 2] + wl, world[i * 2 + 1] + wr);
            z[0] += a * (l - z[0]);
            z[1] += a * (z[0] - z[1]);
            z[2] += a * (r - z[2]);
            z[3] += a * (z[2] - z[3]);
            let (l, r) = (z[1] * g + ui[i * 2], z[3] * g + ui[i * 2 + 1]);
            let (l, r) = self.limiter.tick(l * m, r * m);
            out[i * 2] = l;
            out[i * 2 + 1] = r;
            g += dg;
            a += da;
            m += dm;
        }
        // A closed muffle filter fed silence would otherwise decay through the denormals.
        for s in z.iter_mut() {
            if s.abs() < 1e-18 {
                *s = 0.0;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_limiter_never_lets_a_peak_past_its_threshold() {
        // Noise bursts from whisper to 60 dB over full scale, with silences between: every output sample is at
        // or under the threshold (the soft clip behind it is never reached), and quiet input passes untouched.
        let rng = Rng::new(3);
        let mut lim = Limiter::new();
        let mut worst = 0.0f32;
        for burst in 0..400 {
            let amp = 10f32.powf(rng.range(-2.0, 3.0));
            let len = 1 + (rng.f() * 600.0) as usize;
            for i in 0..len {
                let quiet = burst % 5 == 4 || i > len * 3 / 4;
                let (l, r) = if quiet {
                    (0.0, 0.0)
                } else {
                    (rng.bi() * amp, rng.bi() * amp)
                };
                let (ol, or) = lim.tick(l, r);
                worst = worst.max(ol.abs()).max(or.abs());
            }
        }
        assert!(worst <= THRESHOLD * 1.0001, "a peak of {worst} got through");
        let mut lim = Limiter::new();
        let x: Vec<f32> = (0..4800).map(|i| 0.5 * (i as f32 * 0.05).sin()).collect();
        let y: Vec<f32> = x.iter().map(|v| lim.tick(*v, *v).0).collect();
        assert!(
            x[..4800 - (LOOK - 1)] == y[LOOK - 1..],
            "the limiter changes what it need not"
        );
        // Pushed down hard, it comes back up gradually, not at once.
        let mut lim = Limiter::new();
        for _ in 0..200 {
            lim.tick(50.0, 50.0);
        }
        let after =
            |lim: &mut Limiter, n: usize| (0..n).map(|_| lim.tick(0.5, 0.5).0).last().unwrap();
        let soon = after(&mut lim, 2400);
        let later = after(&mut lim, 48_000);
        assert!(soon < 0.2 && later > 0.49, "release: {soon} then {later}");
    }

    #[test]
    fn the_soft_clip_is_smooth_and_bounded() {
        let mut last = -0.001f32;
        for i in 0..=4000 {
            let x = i as f32 / 1000.0;
            let y = soft_clip(x);
            assert!(y >= last && y < CEILING + 1e-6 && soft_clip(-x) == -y);
            assert!(y - last < 0.0011, "a step at {x}");
            last = y;
        }
        assert_eq!(soft_clip(0.5), 0.5);
    }

    #[test]
    fn pan_is_equal_power_and_the_filter_opens_up_close() {
        for i in -10..=10 {
            let (l, r) = pan(i as f32 / 10.0);
            assert!((l * l + r * r - 1.0).abs() < 1e-5);
        }
        assert!(pan(1.0).0.abs() < 1e-6 && pan(-1.0).1.abs() < 1e-6);
        assert_eq!(lp_coef(20_000.0), 1.0);
        let mut last = 0.0;
        for hz in (200..20_000).step_by(100) {
            let a = lp_coef(hz as f32);
            assert!(a >= last && a > 0.0 && a <= 1.0);
            last = a;
        }
    }
}
