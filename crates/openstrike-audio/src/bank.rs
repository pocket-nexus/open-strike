//! The sound bank: every sound's variations, synthesized once at startup (in parallel, off the game thread) and then
//! only read. Each variation lands in its own `OnceLock`, so the mixer reads it without a lock the moment it is done.

use std::sync::OnceLock;
use std::sync::atomic::{AtomicUsize, Ordering};

use crate::dsp::*;
use crate::sound::{Sound, Spec};
use crate::sounds::{self, Raw};

pub(crate) const MAX_VARS: usize = 4;
/// Frames per point of a clip's coarse level contour (voice stealing asks "how loud is this voice by now").
pub(crate) const ENV_HOP: usize = 1024;

pub(crate) struct Clip {
    /// The panned stem.
    pub mono: Box<[f32]>,
    /// The wide stem, interleaved stereo (may be empty).
    pub wide: Box<[f32]>,
    /// Frames: the longer of the two stems.
    pub frames: usize,
    /// Peak per `ENV_HOP` frames.
    pub env: Box<[f32]>,
}

pub(crate) struct Bank {
    clips: Vec<[OnceLock<Clip>; MAX_VARS]>,
    done: AtomicUsize,
    next: AtomicUsize,
    jobs: Vec<(Sound, usize)>,
}

impl Bank {
    pub fn new() -> Bank {
        // What a match needs first is made first: shots, steps, hit feedback; the stingers last.
        let mut jobs: Vec<(Sound, usize)> = Sound::ALL
            .iter()
            .flat_map(|&s| (0..s.spec().vars as usize).map(move |v| (s, v)))
            .collect();
        let late = |s: Sound| {
            matches!(
                s,
                Sound::Victory | Sound::Defeat | Sound::Death | Sound::Medal
            ) as u8
        };
        jobs.sort_by_key(|&(s, v)| (late(s), v, s as usize));
        Bank {
            clips: (0..Sound::COUNT)
                .map(|_| std::array::from_fn(|_| OnceLock::new()))
                .collect(),
            done: AtomicUsize::new(0),
            next: AtomicUsize::new(0),
            jobs,
        }
    }

    /// Variation `var` of `sound`, once it is synthesized. Lock-free: the mixer calls it for every voice, every block.
    #[inline]
    pub fn clip(&self, sound: Sound, var: usize) -> Option<&Clip> {
        self.clips[sound as usize][var].get()
    }

    pub fn ready(&self) -> bool {
        self.done.load(Ordering::Acquire) == self.jobs.len()
    }

    /// Takes jobs until none are left: run it on as many threads as there are cores to spare.
    pub fn work(&self) {
        loop {
            let i = self.next.fetch_add(1, Ordering::Relaxed);
            let Some(&(sound, var)) = self.jobs.get(i) else {
                break;
            };
            let clip = synthesize(sound, var);
            let _ = self.clips[sound as usize][var].set(clip);
            self.done.fetch_add(1, Ordering::Release);
        }
    }

    /// Synthesizes everything, on `threads` threads, and returns when no job is left to take (`ready` says when the
    /// last one, perhaps on another caller's thread, has finished).
    pub fn build(&self, threads: usize) {
        std::thread::scope(|s| {
            for _ in 1..threads.max(1) {
                s.spawn(|| self.work());
            }
            self.work();
        });
    }
}

/// How many threads the synthesis may take.
pub(crate) fn build_threads() -> usize {
    std::thread::available_parallelism()
        .map_or(2, |n| n.get())
        .clamp(1, 8)
}

/// One variation: the same seed gives the same samples on every run and every platform that rounds alike.
pub(crate) fn synthesize(sound: Sound, var: usize) -> Clip {
    let rng = Rng::new(0x05EE_D000 + (sound as u64) * 97 + var as u64 * 7919);
    finalize(sounds::make(sound, &rng), sound.spec())
}

/// Perceived level of a buffer, dB: the loudest 50 ms window after a weighting that discounts the lows (which the
/// ear, and a handheld's speakers, make little of) and lifts the presence range.
pub(crate) fn loudness(buf: &[f32]) -> f32 {
    let mut w = buf.to_vec();
    filt(&mut w, Biquad::hp(120.0, 0.5));
    filt(&mut w, Biquad::high_shelf(2000.0, 4.0));
    let win = secs(0.05);
    let hop = secs(0.01);
    let mut best = 0.0f64;
    let mut i = 0;
    loop {
        let end = (i + win).min(w.len());
        let e = w[i.min(end)..end]
            .iter()
            .map(|x| (*x as f64) * (*x as f64))
            .sum::<f64>()
            / win as f64;
        best = best.max(e);
        if end == w.len() {
            break;
        }
        i += hop;
    }
    10.0 * (best.max(1e-12)).log10() as f32
}

fn finalize(mut raw: Raw, spec: &Spec) -> Clip {
    let wide = raw.l.len().max(raw.r.len());
    raw.l.resize(wide, 0.0);
    raw.r.resize(wide, 0.0);
    // No DC, and nothing under 32 Hz: down there it only costs headroom.
    for stem in [&mut raw.mono, &mut raw.l, &mut raw.r] {
        hp4(stem, 32.0);
    }
    // Level: the centre mix (as it plays when not positional) to the sound's authored loudness, under its peak cap.
    let frames = raw.mono.len().max(wide);
    let mix = |side: &[f32]| -> Vec<f32> {
        (0..frames)
            .map(|i| raw.mono.get(i).copied().unwrap_or(0.0) + side.get(i).copied().unwrap_or(0.0))
            .collect()
    };
    let (ml, mr) = (mix(&raw.l), mix(&raw.r));
    let loud = loudness(&ml).max(loudness(&mr));
    let pk = peak(&ml).max(peak(&mr)).max(1e-9);
    let g = 10f32.powf((spec.loud - loud) / 20.0).min(spec.peak / pk);
    // Trim the inaudible end (below -78 dB of the peak); every stem starts and stops at zero.
    let floor = pk * 1.2e-4;
    let last = |b: &[f32]| b.iter().rposition(|x| x.abs() > floor).map_or(0, |i| i + 1);
    let frames = (last(&ml).max(last(&mr)) + secs(0.004)).min(frames);
    for stem in [&mut raw.mono, &mut raw.l, &mut raw.r] {
        stem.truncate(frames);
        gain(stem, g);
        // Three samples of ramp in (a gunshot's onset stays a step for every purpose but the first sample's), and a
        // few ms of fade out.
        for (i, x) in stem.iter_mut().take(3).enumerate() {
            *x *= i as f32 / 3.0;
        }
        fade_out(stem, 0.004);
    }
    let env = (0..frames.div_ceil(ENV_HOP))
        .map(|k| {
            let at =
                |b: &[f32]| peak(&b[(k * ENV_HOP).min(b.len())..((k + 1) * ENV_HOP).min(b.len())]);
            at(&raw.mono).max(at(&raw.l)).max(at(&raw.r))
        })
        .collect();
    let wide: Vec<f32> = raw
        .l
        .iter()
        .zip(&raw.r)
        .flat_map(|(l, r)| [*l, *r])
        .collect();
    Clip {
        mono: raw.mono.into(),
        wide: wide.into(),
        frames,
        env,
    }
}

/// The process's one bank: every `Audio` and `Renderer` shares it (it is the same samples for all of them).
pub(crate) fn shared() -> std::sync::Arc<Bank> {
    static BANK: OnceLock<std::sync::Arc<Bank>> = OnceLock::new();
    BANK.get_or_init(|| std::sync::Arc::new(Bank::new()))
        .clone()
}

/// Starts the synthesis off the caller's thread (once per process).
pub(crate) fn build_in_background(bank: &std::sync::Arc<Bank>) {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        let bank = bank.clone();
        let _ = std::thread::Builder::new()
            .name("openstrike-audio-bank".into())
            .spawn(move || bank.build(build_threads()));
    });
}
