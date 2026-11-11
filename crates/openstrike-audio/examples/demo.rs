//! The bank and the mixer, heard (or at least measured) without the game.
//!
//!   cargo run -p openstrike-audio --release --example demo              every sound in turn, a shot at five
//!                                                                      distances and around the listener, then a
//!                                                                      scripted firefight: out/audio/demo.wav
//!                                                                      (offline; demo.txt says what is where)
//!   cargo run -p openstrike-audio --release --example demo -- --each   also out/audio/sounds/<name>.wav
//!   cargo run -p openstrike-audio --release --example demo -- --stats  a table: length, peak, loudness, spectrum
//!   cargo run -p openstrike-audio --release --example demo -- --live [seconds]
//!                                                                      the firefight through the real output;
//!                                                                      exits 1 if nothing was mixed or it underran

use std::path::PathBuf;
use std::time::{Duration, Instant};

use openstrike_audio::analysis as an;
use openstrike_audio::{Audio, Renderer, SAMPLE_RATE, Sound, write_wav};

type V3 = [f32; 3];

#[derive(Clone, Copy)]
enum Ev {
    Listener(V3, V3, V3),
    Play(Sound, Option<V3>, f32, f32),
    Muffle(f32),
}

const EYE: V3 = [0.0, 1.7, 0.0];

/// Twelve seconds of a match: the player runs, slides, fires, is shot at from three sides, reloads, throws a
/// grenade, and gets the kill. The listener stands at the origin looking down -Z, then turns to the right.
fn firefight() -> Vec<(f32, Ev)> {
    use Sound::*;
    let s: std::cell::RefCell<Vec<(f32, Ev)>> = Default::default();
    let ev = |t: f32, e: Ev| s.borrow_mut().push((t, e));
    let at =
        |t: f32, sound: Sound, pos: Option<V3>, gain: f32| ev(t, Ev::Play(sound, pos, gain, 1.0));

    // Sprinting in, a DMR cracking far ahead on the left.
    for i in 0..5 {
        at(0.05 + 0.29 * i as f32, StepSprint, None, 1.0);
    }
    at(0.45, ShotDmr, Some([-45.0, 3.0, -75.0]), 1.0);
    at(1.25, ShotDmr, Some([-45.0, 3.0, -75.0]), 1.0);
    at(1.50, Slide, None, 1.0);
    at(1.62, Whiz, Some([-0.6, 1.6, -1.0]), 1.0);
    at(1.66, ImpactConcrete, Some([1.2, 0.8, 2.5]), 1.0);
    at(2.05, AdsIn, None, 1.0);

    // Own carbine: eight rounds at 690 rpm, brass landing to the right, two hits.
    for i in 0..8 {
        let t = 2.2 + 0.087 * i as f32;
        at(t, ShotCarbine, None, 1.0);
        at(
            t + 0.42,
            Casing,
            Some([0.7, 0.05, -0.2 - 0.05 * i as f32]),
            1.0,
        );
    }
    at(2.2 + 0.087 * 3.0 + 0.03, Hitmarker, None, 1.0);
    at(2.2 + 0.087 * 6.0 + 0.03, Hitmarker, None, 1.0);

    // An SMG answers from 25 m on the right: rounds snap past and hit the wall behind.
    for i in 0..10 {
        let t = 3.0 + 0.068 * i as f32;
        at(t, ShotSmg, Some([24.0, 1.5, -8.0]), 1.0);
        match i % 3 {
            0 => at(t + 0.09, Whiz, Some([0.8, 1.7, 0.2]), 1.0),
            1 => at(t + 0.1, ImpactConcrete, Some([-1.5, 1.2, 3.0]), 1.0),
            _ => at(t + 0.1, ImpactMetal, Some([-3.0, 1.0, 1.0]), 1.0),
        }
    }
    at(3.25, Ricochet, Some([-2.5, 0.5, 2.0]), 1.0);
    at(3.48, Hurt, None, 1.0);
    at(3.5, ImpactFlesh, None, 0.8);
    ev(3.48, Ev::Muffle(0.45));
    ev(4.1, Ev::Muffle(0.0));
    at(3.9, LowHealth, None, 1.0);
    at(4.75, LowHealth, None, 1.0);

    // A shotgun 12 m behind on the left.
    at(4.3, ShotShotgun, Some([-8.0, 1.5, 9.0]), 1.0);

    // Turn right towards the SMG and put it down.
    for i in 0..8 {
        let a = (i as f32 + 1.0) / 8.0 * 1.25;
        ev(
            4.5 + 0.03 * i as f32,
            Ev::Listener(EYE, [a.sin(), 0.0, -a.cos()], [a.cos(), 0.0, a.sin()]),
        );
    }
    for i in 0..6 {
        let t = 4.9 + 0.087 * i as f32;
        at(t, ShotCarbine, None, 1.0);
        at(t + 0.42, Casing, Some([0.5, 0.05, 0.6]), 1.0);
    }
    at(4.9 + 0.087 * 2.0 + 0.03, Hitmarker, None, 1.0);
    at(4.9 + 0.087 * 4.0 + 0.03, HitmarkerHead, None, 1.0);
    at(4.9 + 0.087 * 5.0 + 0.05, KillConfirm, None, 1.0);

    // Reload while someone walks up from the right.
    at(5.9, MagOut, None, 1.0);
    at(6.5, MagIn, None, 1.0);
    at(6.95, BoltRack, None, 1.0);
    for i in 0..7 {
        let d = 13.0 - 1.5 * i as f32;
        at(
            5.8 + 0.36 * i as f32,
            StepConcrete,
            Some([d * 0.8, 0.0, d * 0.6]),
            1.0,
        );
    }

    // A grenade out, two bounces, the explosion 17 m off, ears ringing shut for a second.
    at(7.5, NadePin, None, 1.0);
    at(7.95, NadeThrow, None, 1.0);
    at(8.75, NadeBounce, Some([9.0, 0.1, -10.0]), 1.0);
    at(9.1, NadeBounce, Some([11.0, 0.1, -12.5]), 0.7);
    at(9.75, Explosion, Some([11.5, 0.5, -13.0]), 1.0);
    ev(9.8, Ev::Muffle(0.7));
    for i in 0..10 {
        ev(
            10.1 + 0.12 * i as f32,
            Ev::Muffle(0.7 * (1.0 - (i as f32 + 1.0) / 10.0)),
        );
    }
    at(9.95, Hitmarker, None, 1.0);
    at(10.05, KillConfirm, None, 1.0);
    at(10.4, Medal, None, 1.0);

    // The rest of the map still fighting: shots walking a circle 60 m out, pistols nearer.
    for i in 0..8 {
        let a = i as f32 / 8.0 * std::f32::consts::TAU;
        let gun = [ShotCarbine, ShotDmr, ShotSmg, ShotCarbine][i % 4];
        at(
            11.2 + 0.28 * i as f32,
            gun,
            Some([60.0 * a.sin(), 2.0, -60.0 * a.cos()]),
            1.0,
        );
    }
    at(11.5, ShotPistol, Some([-15.0, 1.5, 4.0]), 1.0);
    at(11.8, ShotPistol, Some([-15.0, 1.5, 4.0]), 1.0);
    at(12.2, ShotPistol, Some([-15.0, 1.5, 4.0]), 1.0);
    let mut s = s.into_inner();
    s.sort_by(|a, b| a.0.total_cmp(&b.0));
    s
}
const FIREFIGHT_SECS: f32 = 15.5;

/// The same carbine shot from 3 m to 100 m straight ahead, then a DMR walking once around the listener at 40 m:
/// what distance and direction do to a shot.
fn distances() -> Vec<(f32, Ev)> {
    let mut s = Vec::new();
    for (i, d) in [3.0, 10.0, 30.0, 60.0, 100.0].into_iter().enumerate() {
        s.push((
            1.7 * i as f32,
            Ev::Play(Sound::ShotCarbine, Some([0.0, 1.7, -d]), 1.0, 1.0),
        ));
    }
    for i in 0..8 {
        let a = i as f32 / 8.0 * std::f32::consts::TAU;
        s.push((
            8.8 + 1.2 * i as f32,
            Ev::Play(
                Sound::ShotDmr,
                Some([40.0 * a.sin(), 1.7, -40.0 * a.cos()]),
                1.0,
                1.0,
            ),
        ));
    }
    s
}
const DISTANCES_SECS: f32 = 20.5;

fn apply(r: &mut Renderer, ev: Ev) {
    match ev {
        Ev::Listener(p, f, rt) => r.listener(p, f, rt),
        Ev::Play(s, at, g, p) => r.play(s, at, g, p),
        Ev::Muffle(k) => r.muffle(k),
    }
}

/// Renders a script offline: `secs` seconds, interleaved stereo.
fn offline(r: &mut Renderer, script: &[(f32, Ev)], secs: f32) -> Vec<f32> {
    let mut out = Vec::new();
    let frame = |t: f32| (t * SAMPLE_RATE as f32) as usize;
    for &(t, ev) in script {
        let upto = frame(t).max(out.len() / 2);
        out.extend(r.render(upto - out.len() / 2));
        apply(r, ev);
    }
    out.extend(r.render(frame(secs).saturating_sub(out.len() / 2)));
    out
}

/// One sound alone, not positional, through the mixer: enough seconds for its tail.
fn solo(sound: Sound) -> Vec<f32> {
    let mut r = Renderer::new();
    r.play(sound, None, 1.0, 1.0);
    let mut out = r.render_secs(6.0);
    let floor = an::peak(&out) * 1e-4;
    let end = out
        .iter()
        .rposition(|x| x.abs() > floor)
        .map_or(0, |i| i / 2 + 1);
    out.truncate((end + SAMPLE_RATE as usize / 20) * 2);
    out
}

fn out_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../out/audio")
}

fn stats() {
    for threads in [
        1,
        4,
        std::thread::available_parallelism()
            .map_or(4, |n| n.get())
            .min(8),
    ] {
        let best = (0..3)
            .map(|_| openstrike_audio::time_bank_synthesis(threads))
            .fold(f64::MAX, f64::min);
        println!(
            "bank synthesis, {threads} thread(s): {:.0} ms",
            best * 1000.0
        );
    }
    println!(
        "\n{:<16} {:>4} {:>6} {:>7} {:>7} {:>8} | energy %: {:>5} {:>6} {:>6} {:>6} {:>6}",
        "sound",
        "vars",
        "secs",
        "peak",
        "loud dB",
        "centroid",
        "<150",
        "150-600",
        "600-2k",
        "2k-6k",
        ">6k"
    );
    for &sound in Sound::ALL {
        let x = an::mono(&solo(sound));
        let spec = an::spectrum(&x, 4096);
        let total = an::band(&spec, 0.0, 24_000.0).max(1e-20);
        let pct = |lo: f32, hi: f32| 100.0 * an::band(&spec, lo, hi) / total;
        println!(
            "{:<16} {:>4} {:>6.2} {:>7.3} {:>7.1} {:>8.0} |           {:>5.1} {:>6.1} {:>6.1} {:>6.1} {:>6.1}",
            sound.name(),
            openstrike_audio::variations(sound),
            an::duration(&x, -50.0),
            an::peak(&x),
            an::loudness(&x),
            an::centroid(&spec),
            pct(0.0, 150.0),
            pct(150.0, 600.0),
            pct(600.0, 2000.0),
            pct(2000.0, 6000.0),
            pct(6000.0, 24_000.0),
        );
    }
}

fn live(secs: f32) -> i32 {
    let audio = Audio::new();
    let script = firefight();
    let start = Instant::now();
    audio.listener(EYE, [0.0, 0.0, -1.0], [1.0, 0.0, 0.0]);
    // Give the bank a moment (a real game has a loading screen in front of this).
    while !audio.stats().ready && start.elapsed() < Duration::from_secs(5) {
        std::thread::sleep(Duration::from_millis(5));
    }
    println!(
        "bank ready after {:.0} ms; backend: {}",
        start.elapsed().as_secs_f64() * 1000.0,
        audio.stats().backend
    );
    let start = Instant::now();
    let mut peak_voices = 0;
    for &(t, ev) in script.iter().filter(|(t, _)| *t < secs) {
        while start.elapsed().as_secs_f32() < t {
            std::thread::sleep(Duration::from_millis(2));
            peak_voices = peak_voices.max(audio.stats().voices);
        }
        match ev {
            Ev::Listener(p, f, r) => audio.listener(p, f, r),
            Ev::Play(s, at, g, p) => audio.play(s, at, g, p),
            Ev::Muffle(k) => audio.muffle(k),
        }
    }
    while start.elapsed().as_secs_f32() < secs {
        std::thread::sleep(Duration::from_millis(5));
        peak_voices = peak_voices.max(audio.stats().voices);
    }
    let s = audio.stats();
    let wall = start.elapsed().as_secs_f64();
    drop(audio);
    println!(
        "backend {}: {} frames in {} buffers over {:.2} s ({:.3} s of audio), {} underruns, {} voices at most",
        s.backend,
        s.frames,
        s.callbacks,
        wall,
        s.frames as f64 / SAMPLE_RATE as f64,
        s.underruns,
        peak_voices
    );
    let expected = wall * SAMPLE_RATE as f64;
    if s.backend == "silent" {
        println!("no device: silent sink (accepted every call)");
        return 0;
    }
    if (s.frames as f64) < expected * 0.9 || s.underruns > 0 {
        println!("FAILED: expected about {expected:.0} frames and no underruns");
        return 1;
    }
    println!("ok");
    0
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if let Some(i) = args.iter().position(|a| a == "--live") {
        let secs = args
            .get(i + 1)
            .and_then(|s| s.parse().ok())
            .unwrap_or(FIREFIGHT_SECS);
        std::process::exit(live(secs));
    }
    if args.iter().any(|a| a == "--stats") {
        return stats();
    }
    let dir = out_dir();
    let t = Instant::now();
    let mut r = Renderer::new();
    println!(
        "bank synthesized in {:.0} ms",
        t.elapsed().as_secs_f64() * 1000.0
    );

    // Every sound in turn, a quarter second apart; then the distance ladder; then the firefight.
    let mut demo: Vec<f32> = Vec::new();
    let mut marks = Vec::new();
    for &sound in Sound::ALL {
        let x = solo(sound);
        marks.push((demo.len() / 2, sound.name()));
        if args.iter().any(|a| a == "--each") {
            write_wav(
                dir.join("sounds").join(format!("{}.wav", sound.name())),
                &x,
                2,
                SAMPLE_RATE,
            )
            .unwrap();
        }
        demo.extend(&x);
        demo.extend(std::iter::repeat_n(0.0, SAMPLE_RATE as usize / 4 * 2));
    }
    let ladder_at = demo.len() / 2;
    r.listener(EYE, [0.0, 0.0, -1.0], [1.0, 0.0, 0.0]);
    let ladder = offline(&mut r, &distances(), DISTANCES_SECS);
    write_wav(dir.join("distance.wav"), &ladder, 2, SAMPLE_RATE).unwrap();
    demo.extend(&ladder);
    let fight_at = demo.len() / 2;
    let t = Instant::now();
    let fight = offline(&mut r, &firefight(), FIREFIGHT_SECS);
    let took = t.elapsed().as_secs_f64();
    println!(
        "firefight: {FIREFIGHT_SECS} s mixed in {:.0} ms ({:.2}% of one core in real time)",
        took * 1000.0,
        100.0 * took / FIREFIGHT_SECS as f64
    );
    // The mixer at its worst: every voice taken, all the time.
    let mut full = Renderer::new();
    let t = Instant::now();
    for _ in 0..40 {
        for i in 0..64 {
            full.play(
                Sound::Explosion,
                Some([
                    (i % 8) as f32 * 3.0 - 10.0,
                    0.0,
                    -5.0 - (i / 8) as f32 * 4.0,
                ]),
                0.3,
                1.0,
            );
        }
        full.render(SAMPLE_RATE as usize / 4);
    }
    let took = t.elapsed().as_secs_f64();
    println!(
        "64 voices for 10 s: mixed in {:.0} ms ({:.2}% of one core in real time)",
        took * 1000.0,
        100.0 * took / 10.0
    );
    write_wav(dir.join("firefight.wav"), &fight, 2, SAMPLE_RATE).unwrap();
    demo.extend(&fight);
    write_wav(dir.join("demo.wav"), &demo, 2, SAMPLE_RATE).unwrap();
    let index: String = marks
        .iter()
        .map(|(f, n)| format!("{:8.2}  {n}\n", *f as f32 / SAMPLE_RATE as f32))
        .chain([format!(
            "{:8.2}  carbine at 3, 10, 30, 60, 100 m; DMR circling at 40 m\n",
            ladder_at as f32 / SAMPLE_RATE as f32
        )])
        .chain([format!(
            "{:8.2}  firefight\n",
            fight_at as f32 / SAMPLE_RATE as f32
        )])
        .collect();
    std::fs::write(dir.join("demo.txt"), index).unwrap();
    println!(
        "{}: {:.1} s ({} sounds, distances, then the firefight at {:.1} s); peak {:.3}",
        dir.join("demo.wav").canonicalize().unwrap().display(),
        demo.len() as f32 / 2.0 / SAMPLE_RATE as f32,
        Sound::ALL.len(),
        fight_at as f32 / SAMPLE_RATE as f32,
        an::peak(&demo)
    );
}
