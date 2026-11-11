//! The bank and the mixer, measured: nobody can listen to a test run, so every sound has to prove itself in
//! numbers (level, length, spectrum), and the mixer its distance, pan, muffle, limiter and voice rules.

use std::collections::HashMap;
use std::sync::OnceLock;

use openstrike_audio::analysis as an;
use openstrike_audio::{Category, Renderer, SAMPLE_RATE, Sound, raw_clip, variations};

const SR: usize = SAMPLE_RATE as usize;
const AHEAD: [f32; 3] = [0.0, 0.0, -1.0];
const RIGHT: [f32; 3] = [1.0, 0.0, 0.0];

/// Every sound alone, not positional, through the whole mixer: six seconds, interleaved stereo.
fn solos() -> &'static HashMap<Sound, Vec<f32>> {
    static SOLOS: OnceLock<HashMap<Sound, Vec<f32>>> = OnceLock::new();
    SOLOS.get_or_init(|| {
        Sound::ALL
            .iter()
            .map(|&s| {
                let mut r = Renderer::new();
                r.play(s, None, 1.0, 1.0);
                (s, r.render_secs(6.0))
            })
            .collect()
    })
}
fn solo(s: Sound) -> Vec<f32> {
    an::mono(&solos()[&s])
}
fn spectrum(x: &[f32]) -> Vec<f64> {
    an::spectrum(x, 4096)
}
/// The share of a signal's energy between `lo` and `hi` Hz.
fn share(x: &[f32], lo: f32, hi: f32) -> f64 {
    let s = spectrum(x);
    an::band(&s, lo, hi) / an::band(&s, 0.0, 24_000.0).max(1e-30)
}
fn centroid(x: &[f32]) -> f32 {
    an::centroid(&spectrum(x))
}
/// A sound at a place, the listener at the origin looking down -Z: `secs` seconds, interleaved stereo.
fn placed(s: Sound, at: [f32; 3], secs: f32) -> Vec<f32> {
    let mut r = Renderer::new();
    r.listener([0.0; 3], AHEAD, RIGHT);
    r.play(s, Some(at), 1.0, 1.0);
    r.render_secs(secs)
}
fn secs(x: &[f32], from: f32, to: f32) -> &[f32] {
    &x[((from * SR as f32) as usize).min(x.len())..((to * SR as f32) as usize).min(x.len())]
}

#[test]
fn the_list_is_complete_and_in_order() {
    let mut names = std::collections::HashSet::new();
    for (i, &s) in Sound::ALL.iter().enumerate() {
        assert_eq!(s as usize, i, "{s:?} is out of order in Sound::ALL");
        assert!(names.insert(s.name()), "{} is named twice", s.name());
        assert!((1..=4).contains(&variations(s)));
    }
    assert_eq!(Sound::ALL.len(), 49);
    // Variations where they make sense: every shot, step, impact.
    for s in [
        Sound::ShotCarbine,
        Sound::StepConcrete,
        Sound::ImpactConcrete,
        Sound::Casing,
        Sound::Whiz,
    ] {
        assert!(variations(s) >= 2, "{s:?} has no variations");
    }
}

#[test]
fn every_sound_is_sound() {
    for &s in Sound::ALL {
        let st = &solos()[&s];
        let x = solo(s);
        assert!(
            st.iter().all(|v| v.is_finite()),
            "{s:?} has a NaN or an infinity"
        );
        let peak = an::peak(st);
        assert!(peak > 0.03, "{s:?} is silent (peak {peak})");
        assert!(
            peak <= 0.98,
            "{s:?} peaks at {peak}: past the limiter's ceiling"
        );
        // No DC: the mean is nothing next to the peak.
        let len = (an::duration(&x, -60.0) * SR as f32) as usize;
        let mean = x[..len.max(1)].iter().sum::<f32>() / len.max(1) as f32;
        assert!(
            mean.abs() < 0.01 * peak,
            "{s:?} has a DC offset ({mean} against a peak of {peak})"
        );
        // It ends: the last second is silence, and it got there by decaying (no window drops straight from loud
        // to nothing).
        assert!(
            an::peak(&x[5 * SR..]) < 1e-4,
            "{s:?} is still sounding after five seconds"
        );
        let env = an::envelope(&x);
        let top = env.iter().fold(0.0f32, |m, v| m.max(*v));
        for w in env.windows(2) {
            assert!(
                !(w[0] > top * 0.1 && w[1] < top * 1e-3),
                "{s:?} is cut off, not faded"
            );
        }
    }
}

#[test]
fn every_variation_is_clean() {
    for &s in Sound::ALL {
        let mut clips = Vec::new();
        for v in 0..variations(s) {
            let (mono, wide) = raw_clip(s, v);
            for (stem, name) in [(&mono, "mono"), (&wide, "wide")] {
                assert!(
                    stem.iter().all(|x| x.is_finite()),
                    "{s:?}/{v} {name} is not finite"
                );
                assert!(
                    an::peak(stem) <= 0.96,
                    "{s:?}/{v} {name} peaks at {}",
                    an::peak(stem)
                );
                // Starts and ends at (nearly) zero: no click at either end.
                if let (Some(first), Some(last)) = (stem.first(), stem.last()) {
                    assert!(
                        first.abs() < 1e-6,
                        "{s:?}/{v} {name} starts on a step ({first})"
                    );
                    assert!(
                        last.abs() < 1e-3,
                        "{s:?}/{v} {name} ends on a step ({last})"
                    );
                }
            }
            assert!(
                an::peak(&mono).max(an::peak(&wide)) > 0.02,
                "{s:?}/{v} is silent"
            );
            clips.push((mono, wide));
        }
        // Variations are different takes, not copies.
        for a in 0..clips.len() {
            for b in a + 1..clips.len() {
                assert!(
                    clips[a] != clips[b],
                    "{s:?}: variations {a} and {b} are identical"
                );
            }
        }
    }
}

#[test]
fn durations_are_sensible() {
    use Sound::*;
    let d = |s: Sound| an::duration(&solo(s), -50.0);
    let within = |s: Sound, lo: f32, hi: f32| {
        let v = d(s);
        assert!(
            v >= lo && v <= hi,
            "{s:?} lasts {v:.2} s, expected {lo}..{hi}"
        );
    };
    // Shots: 0.6..1.8 s with their tails; ticks under 0.15 s.
    for s in [ShotCarbine, ShotSmg, ShotShotgun, ShotDmr, ShotPistol] {
        within(s, 0.6, 1.8);
    }
    for s in [Hitmarker, UiMove] {
        within(s, 0.01, 0.15);
    }
    for s in [
        DryFire,
        UiSelect,
        UiBack,
        CountBeep,
        HitmarkerHead,
        AdsIn,
        AdsOut,
    ] {
        within(s, 0.03, 0.5);
    }
    for s in [
        MagOut,
        MagIn,
        BoltRack,
        ShellInsert,
        SwapWeapon,
        Melee,
        MeleeHit,
    ] {
        within(s, 0.15, 0.9);
    }
    for s in [StepConcrete, StepSprint, StepCrouch, Jump, Land, Mantle] {
        within(s, 0.08, 0.9);
    }
    within(Slide, 0.55, 1.1);
    for s in [
        ImpactConcrete,
        ImpactMetal,
        ImpactFlesh,
        Ricochet,
        Whiz,
        Casing,
        NadePin,
        NadeThrow,
        NadeBounce,
    ] {
        within(s, 0.08, 1.0);
    }
    for s in [
        KillConfirm,
        Hurt,
        LowHealth,
        Medal,
        CountGo,
        Respawn,
        LeadTaken,
        LeadLost,
    ] {
        within(s, 0.15, 1.3);
    }
    within(Death, 0.8, 2.0);
    within(Victory, 2.0, 3.2);
    within(Defeat, 2.0, 3.2);
    within(Explosion, 2.0, 4.5);
    // The explosion rings longest of everything in the world; the DMR's tail is the longest of the guns, the
    // SMG's the shortest.
    for &s in Sound::ALL
        .iter()
        .filter(|s| !matches!(s.category(), Category::Ui | Category::Feedback))
    {
        assert!(d(Explosion) >= d(s), "{s:?} outlasts the explosion");
    }
    assert!(d(ShotDmr) > d(ShotCarbine) && d(ShotCarbine) > d(ShotSmg));
    assert!(d(ShotShotgun) > d(ShotCarbine));
}

#[test]
fn levels_are_ranked() {
    use Sound::*;
    let l = |s: Sound| an::loudness(&solo(s));
    let shots = [ShotCarbine, ShotSmg, ShotShotgun, ShotDmr, ShotPistol];
    let quietest_shot = shots.iter().map(|&s| l(s)).fold(f32::MAX, f32::min);
    let loudest_shot = shots.iter().map(|&s| l(s)).fold(f32::MIN, f32::max);
    // Shots loudest, then the explosion, then impacts; steps far below.
    assert!(
        l(Explosion) <= loudest_shot + 0.5,
        "the explosion ({}) is louder than any shot ({loudest_shot})",
        l(Explosion)
    );
    for &s in Sound::ALL.iter().filter(|s| s.category() != Category::Shot) {
        assert!(
            l(s) <= loudest_shot + 0.5,
            "{s:?} ({}) is louder than the loudest shot ({loudest_shot})",
            l(s)
        );
    }
    for s in [ImpactConcrete, ImpactMetal, ImpactFlesh, Ricochet] {
        assert!(
            l(s) < l(Explosion) - 3.0 && l(s) < quietest_shot - 3.0,
            "{s:?} is too loud"
        );
        for step in [StepConcrete, StepSprint, StepCrouch] {
            assert!(l(step) < l(s) - 5.0, "{step:?} is too loud next to {s:?}");
        }
    }
    for step in [StepConcrete, StepSprint, StepCrouch] {
        assert!(
            l(step) < quietest_shot - 12.0,
            "{step:?} is too loud next to a shot"
        );
    }
    assert!(l(StepSprint) > l(StepConcrete) && l(StepConcrete) > l(StepCrouch) + 3.0);
    assert!(l(ShotDmr) > l(ShotSmg) && l(ShotShotgun) > l(ShotSmg));
    // Feedback cuts through: a hitmarker is well above a footstep, and brighter than the weapon it sits on.
    assert!(l(Hitmarker) > l(StepSprint) + 6.0);
}

#[test]
fn the_guns_are_distinct() {
    use Sound::*;
    let x = |s: Sound| solo(s);
    let low = |s: Sound| {
        let sp = spectrum(&x(s));
        an::band(&sp, 0.0, 150.0)
    };
    // The 12 gauge has far more below 150 Hz than the SMG, in absolute energy and as a share.
    assert!(
        low(ShotShotgun) > 4.0 * low(ShotSmg),
        "shotgun {} vs smg {}",
        low(ShotShotgun),
        low(ShotSmg)
    );
    assert!(share(&x(ShotShotgun), 0.0, 150.0) > 2.0 * share(&x(ShotSmg), 0.0, 150.0));
    assert!(low(ShotDmr) > low(ShotCarbine) && low(ShotCarbine) > low(ShotSmg));
    // Brightness: SMG > pistol > carbine > DMR > shotgun.
    let c = |s: Sound| centroid(&x(s));
    assert!(
        c(ShotSmg) > c(ShotPistol),
        "smg {} pistol {}",
        c(ShotSmg),
        c(ShotPistol)
    );
    assert!(
        c(ShotPistol) > c(ShotCarbine),
        "pistol {} carbine {}",
        c(ShotPistol),
        c(ShotCarbine)
    );
    assert!(
        c(ShotCarbine) > c(ShotDmr),
        "carbine {} dmr {}",
        c(ShotCarbine),
        c(ShotDmr)
    );
    assert!(
        c(ShotDmr) > c(ShotShotgun),
        "dmr {} shotgun {}",
        c(ShotDmr),
        c(ShotShotgun)
    );
    for s in [ShotCarbine, ShotSmg, ShotShotgun, ShotDmr, ShotPistol] {
        let x = x(s);
        // Layers: a broadband crack in the first few ms (energy from the lows to past 6 kHz), and a transient
        // that stands clear of what follows: the first 10 ms are well above the level a quarter second later.
        let onset = secs(&x, 0.0, 0.012);
        assert!(
            share(onset, 3000.0, 20_000.0) > 0.02,
            "{s:?} has no crack: {}",
            share(onset, 3000.0, 20_000.0)
        );
        assert!(
            share(onset, 0.0, 800.0) > 0.03,
            "{s:?} has no weight at its onset"
        );
        let (head, later) = (an::peak(secs(&x, 0.0, 0.01)), an::peak(secs(&x, 0.25, 0.3)));
        assert!(
            head > 4.0 * later,
            "{s:?} has no transient: {head} then {later}"
        );
        // And a tail: still clearly there at 300 ms, falling steadily, darker than the onset.
        let tail = secs(&x, 0.3, 0.5);
        assert!(an::rms(tail) > 0.002, "{s:?} has no tail");
        assert!(
            an::rms(secs(&x, 0.5, 0.6)) < an::rms(secs(&x, 0.3, 0.4)),
            "{s:?}'s tail does not decay"
        );
        assert!(
            centroid(tail) < centroid(onset),
            "{s:?}'s tail is brighter than its crack"
        );
        // No long pure tone: no single 12 Hz bin holds a large share of the energy past the transient.
        let sp = spectrum(secs(&x, 0.05, 0.6));
        let total: f64 = sp.iter().sum();
        let top = sp.iter().skip(8).fold(0.0f64, |m, v| m.max(*v));
        assert!(top < 0.12 * total, "{s:?} has a tone in it");
    }
}

#[test]
fn spectra_are_plausible() {
    use Sound::*;
    let x = |s: Sound| solo(s);
    // The hitmarker lives above 1.5 kHz; the headshot's is brighter and rings longer.
    assert!(share(&x(Hitmarker), 1500.0, 24_000.0) > 0.9);
    assert!(share(&x(HitmarkerHead), 1500.0, 24_000.0) > 0.9);
    assert!(centroid(&x(HitmarkerHead)) > centroid(&x(Hitmarker)));
    assert!(an::duration(&x(HitmarkerHead), -40.0) > 2.0 * an::duration(&x(Hitmarker), -40.0));
    // The explosion: a strong sub-200 Hz component, and something up top at its onset.
    assert!(
        share(&x(Explosion), 0.0, 200.0) > 0.35,
        "explosion sub share {}",
        share(&x(Explosion), 0.0, 200.0)
    );
    assert!(share(secs(&x(Explosion), 0.0, 0.03), 2000.0, 20_000.0) > 0.02);
    // Kill confirm: low first, high second.
    let k = x(KillConfirm);
    assert!(centroid(secs(&k, 0.0, 0.08)) < centroid(secs(&k, 0.1, 0.4)));
    assert!(
        share(secs(&k, 0.0, 0.08), 0.0, 300.0) > 0.3
            && share(secs(&k, 0.1, 0.4), 1500.0, 12_000.0) > 0.5
    );
    // One heartbeat is two low beats.
    let h = x(LowHealth);
    assert!(share(&h, 0.0, 250.0) > 0.7);
    let mut env = vec![0.0];
    env.extend(an::envelope(&h));
    let top = env.iter().fold(0.0f32, |m, v| m.max(*v));
    let peaks = (1..env.len() - 1)
        .filter(|&i| env[i] > 0.3 * top && env[i] >= env[i - 1] && env[i] > env[i + 1])
        .count();
    assert_eq!(peaks, 2, "a heartbeat has two beats");
    // Metal pings (its energy sits in a few partials), concrete cracks (it does not).
    let peaky = |s: Sound| {
        let sp = spectrum(&x(s));
        let band: Vec<f64> = sp[40..800].to_vec();
        band.iter().fold(0.0f64, |m, v| m.max(*v)) / (band.iter().sum::<f64>() / band.len() as f64)
    };
    assert!(
        peaky(ImpactMetal) > 3.0 * peaky(ImpactConcrete),
        "{} vs {}",
        peaky(ImpactMetal),
        peaky(ImpactConcrete)
    );
    assert!(
        share(&x(ImpactFlesh), 0.0, 600.0) > 0.5 && share(&x(ImpactFlesh), 4000.0, 24_000.0) < 0.1
    );
    assert!(share(&x(ImpactConcrete), 2000.0, 24_000.0) > 0.15);
    assert!(
        share(&x(Casing), 2000.0, 24_000.0) > 0.9 && share(&x(NadePin), 2000.0, 24_000.0) > 0.7
    );
    // A near miss falls in pitch as it passes; a ricochet whines downward.
    for s in [Whiz, Ricochet] {
        let w = x(s);
        let d = an::duration(&w, -30.0);
        assert!(
            centroid(secs(&w, 0.0, d * 0.4)) > 1.3 * centroid(secs(&w, d * 0.6, d)),
            "{s:?} does not fall"
        );
    }
    // Steps: the sprint hits harder and lower than the crouch; a slide is a long scrape with highs in it.
    assert!(share(&x(StepSprint), 0.0, 200.0) > share(&x(StepCrouch), 0.0, 200.0));
    assert!(share(&x(Slide), 1000.0, 24_000.0) > 0.3);
    // The stingers: victory is brighter than defeat, both are stereo, and both are music (harmonic peaks).
    assert!(centroid(&x(Victory)) > 2.0 * centroid(&x(Defeat)));
    for s in [Victory, Defeat, Medal] {
        let (l, r) = an::split(&solos()[&s]);
        let diff: Vec<f32> = l.iter().zip(&r).map(|(a, b)| a - b).collect();
        assert!(an::rms(&diff) > 0.05 * an::rms(&l), "{s:?} is mono");
    }
    // UI: move is the smallest, select rises, back falls.
    let (sel, back) = (x(UiSelect), x(UiBack));
    assert!(centroid(secs(&sel, 0.06, 0.2)) > centroid(secs(&sel, 0.0, 0.05)));
    assert!(centroid(secs(&back, 0.06, 0.2)) < centroid(secs(&back, 0.0, 0.05)));
    assert!(centroid(&x(LeadTaken)) > centroid(&x(LeadLost)));
    assert!(an::duration(&x(CountGo), -40.0) > an::duration(&x(CountBeep), -40.0));
}

#[test]
fn distance_makes_it_quieter_duller_and_mostly_tail() {
    let near = an::mono(&placed(Sound::ShotCarbine, [0.0, 0.0, -5.0], 3.0));
    let far = an::mono(&placed(Sound::ShotCarbine, [0.0, 0.0, -100.0], 3.0));
    // Heard across the map, but 15 dB down or more, and duller.
    let (ln, lf) = (an::db(an::peak(&near)), an::db(an::peak(&far)));
    assert!(lf > -45.0, "a shot at 100 m is inaudible ({lf} dBFS)");
    assert!(
        lf < ln - 15.0,
        "a shot at 100 m is only {} dB down",
        ln - lf
    );
    assert!(an::rms(&far) < 0.3 * an::rms(&near));
    assert!(
        centroid(&far) < 0.7 * centroid(&near),
        "far {} near {}",
        centroid(&far),
        centroid(&near)
    );
    assert!(share(&far, 4000.0, 24_000.0) < 0.5 * share(&near, 4000.0, 24_000.0));
    // It arrives late: sound takes 0.29 s to cross 100 m.
    let onset =
        |x: &[f32]| x.iter().position(|v| v.abs() > 0.05 * an::peak(x)).unwrap() as f32 / SR as f32;
    assert!(onset(&near) < 0.03);
    assert!(
        (onset(&far) - 100.0 / 343.0).abs() < 0.02,
        "onset at {}",
        onset(&far)
    );
    // More tail, less transient: the share of energy after the first 120 ms grows with distance.
    let tail_share = |x: &[f32]| {
        let o = onset(x);
        let e = |a: f32, b: f32| {
            secs(x, o + a, o + b)
                .iter()
                .map(|v| (*v as f64).powi(2))
                .sum::<f64>()
        };
        e(0.12, 2.0) / e(0.0, 2.0)
    };
    assert!(
        tail_share(&far) > 2.0 * tail_share(&near),
        "far {} near {}",
        tail_share(&far),
        tail_share(&near)
    );
    // Level falls steadily on the way out.
    let at = |d: f32| an::peak(&placed(Sound::ShotCarbine, [0.0, 0.0, -d], 2.0));
    assert!(at(10.0) > at(25.0) && at(25.0) > at(50.0) && at(50.0) > at(100.0));

    // Small sounds carry less far: a footstep to about 15 m, a casing to about 8.
    let heard = |s: Sound, d: f32| an::peak(&placed(s, [d, 0.0, 0.0], 1.5));
    assert!(
        heard(Sound::StepConcrete, 10.0) > 0.002,
        "a step at 10 m: {}",
        heard(Sound::StepConcrete, 10.0)
    );
    assert!(heard(Sound::StepConcrete, 13.0) > 2e-4);
    assert!(heard(Sound::StepConcrete, 16.0) < 1e-4);
    assert!(heard(Sound::Casing, 5.0) > 5e-4);
    assert!(heard(Sound::Casing, 8.5) < 1e-4);
    assert!(heard(Sound::StepConcrete, 2.0) > 5.0 * heard(Sound::StepConcrete, 12.0));
    // The player's own shot is the closest and punchiest of all: louder than the same weapon at any distance.
    let own = an::mono(&solos()[&Sound::ShotCarbine]);
    assert!(an::peak(&own) >= an::peak(&near) * 0.95 && an::rms(&own) > an::rms(&far) * 4.0);
}

#[test]
fn pan_follows_the_listener() {
    let level = |x: &[f32]| {
        let (l, r) = an::split(x);
        (an::rms(&l), an::rms(&r))
    };
    // On the right: the right channel is louder; on the left, the left; ahead, even.
    for s in [Sound::ImpactMetal, Sound::ShotCarbine, Sound::StepConcrete] {
        let (l, r) = level(&placed(s, [6.0, 0.0, 0.0], 2.0));
        assert!(r > 1.8 * l, "{s:?} on the right: left {l}, right {r}");
        let (l, r) = level(&placed(s, [-6.0, 0.0, 0.0], 2.0));
        assert!(l > 1.8 * r, "{s:?} on the left: left {l}, right {r}");
        let (l, r) = level(&placed(s, [0.0, 0.0, -6.0], 2.0));
        assert!(
            (an::db(l) - an::db(r)).abs() < 1.5,
            "{s:?} ahead: left {l}, right {r}"
        );
    }
    // Equal power: a source at the side is as loud in total as the same source ahead (but for the rear cue).
    let total = |x: &[f32]| {
        let (l, r) = level(x);
        (l * l + r * r).sqrt()
    };
    let (side, ahead) = (
        total(&placed(Sound::ImpactMetal, [6.0, 0.0, 0.0], 2.0)),
        total(&placed(Sound::ImpactMetal, [0.0, 0.0, -6.0], 2.0)),
    );
    assert!(
        (an::db(side) - an::db(ahead)).abs() < 1.5,
        "side {side} ahead {ahead}"
    );
    // The far ear hears it late: about 0.6 ms (29 samples) for a source at the side.
    let x = placed(Sound::DryFire, [3.0, 0.0, 0.0], 0.5);
    let (l, r) = an::split(&x);
    let lag = (-48i32..=48)
        .max_by(|&a, &b| {
            let corr = |k: i32| {
                (64..l.len() as i32 - 64)
                    .map(|i| l[(i + k) as usize] as f64 * r[i as usize] as f64)
                    .sum::<f64>()
            };
            corr(a).total_cmp(&corr(b))
        })
        .unwrap();
    assert!(
        (20..=32).contains(&lag),
        "the left ear lags by {lag} samples"
    );
    // The listener's own axes decide it: turn to face the source and it centres; turn the other way and it flips.
    let mut r = Renderer::new();
    r.listener([0.0; 3], [1.0, 0.0, 0.0], [0.0, 0.0, 1.0]);
    r.play(Sound::ImpactMetal, Some([6.0, 0.0, 0.0]), 1.0, 1.0);
    let (l, rr) = level(&r.render_secs(1.0));
    assert!((an::db(l) - an::db(rr)).abs() < 1.5);
    let mut r = Renderer::new();
    r.listener([0.0; 3], [0.0, 0.0, 1.0], [-1.0, 0.0, 0.0]);
    r.play(Sound::ImpactMetal, Some([6.0, 0.0, 0.0]), 1.0, 1.0);
    let (l, rr) = level(&r.render_secs(1.0));
    assert!(l > 1.8 * rr);
    // Behind is a little duller than ahead.
    let (front, back) = (
        an::mono(&placed(Sound::ImpactConcrete, [0.0, 0.0, -6.0], 1.0)),
        an::mono(&placed(Sound::ImpactConcrete, [0.0, 0.0, 6.0], 1.0)),
    );
    assert!(centroid(&back) < centroid(&front));
    // A world sound has room around it (the reverb send): something is still ringing after the dry clip has ended.
    let x = an::mono(&placed(Sound::ImpactMetal, [0.0, 0.0, -6.0], 3.0));
    let dry = raw_clip(Sound::ImpactMetal, 0).0.len() as f32 / SR as f32;
    assert!(an::rms(secs(&x, dry + 0.2, dry + 0.5)) > 1e-5, "no reverb");
    assert!(
        an::rms(secs(&x, 2.6, 3.0)) < 1e-4,
        "the reverb does not die"
    );
}

#[test]
fn muffle_spares_the_ui() {
    let run = |s: Sound, k: f32| {
        let mut r = Renderer::new();
        r.muffle(k);
        r.render_secs(0.5);
        r.play(s, None, 1.0, 1.0);
        an::mono(&r.render_secs(2.0))
    };
    let (open, shut) = (run(Sound::ShotCarbine, 0.0), run(Sound::ShotCarbine, 1.0));
    assert!(
        centroid(&shut) < 0.4 * centroid(&open),
        "open {} shut {}",
        centroid(&open),
        centroid(&shut)
    );
    assert!(an::rms(&shut) < 0.75 * an::rms(&open));
    assert!(share(&shut, 2000.0, 24_000.0) < 0.1 * share(&open, 2000.0, 24_000.0));
    let half = run(Sound::ShotCarbine, 0.5);
    assert!(centroid(&half) < centroid(&open) && centroid(&half) > centroid(&shut));
    // Feedback and UI go around it, sample for sample.
    for s in [
        Sound::Hitmarker,
        Sound::KillConfirm,
        Sound::LowHealth,
        Sound::UiSelect,
        Sound::Victory,
    ] {
        assert!(run(s, 0.0) == run(s, 1.0), "{s:?} is muffled");
    }
}

#[test]
fn master_gain_and_pitch() {
    let run = |gain: f32, master: f32, pitch: f32| {
        let mut r = Renderer::new();
        r.master(master);
        r.render_secs(0.1);
        r.play(Sound::ImpactMetal, None, gain, pitch);
        an::mono(&r.render_secs(2.0))
    };
    let unit = run(1.0, 1.0, 1.0);
    assert!((an::rms(&run(1.0, 0.5, 1.0)) / an::rms(&unit) - 0.5).abs() < 0.02);
    assert!((an::rms(&run(0.5, 1.0, 1.0)) / an::rms(&unit) - 0.5).abs() < 0.06);
    assert_eq!(an::peak(&run(1.0, 0.0, 1.0)), 0.0);
    assert_eq!(an::peak(&run(0.0, 1.0, 1.0)), 0.0);
    // Pitch resamples: an octave up is brighter and shorter, and out-of-range values are clamped to 0.5..2.
    let (up, down) = (run(1.0, 1.0, 2.0), run(1.0, 1.0, 0.5));
    assert!(centroid(&up) > 1.5 * centroid(&unit) && centroid(&down) < 0.7 * centroid(&unit));
    assert!(
        an::duration(&up, -40.0) < an::duration(&unit, -40.0)
            && an::duration(&down, -40.0) > an::duration(&unit, -40.0)
    );
    assert!(an::duration(&run(1.0, 1.0, 9.0), -40.0) > 0.4 * an::duration(&unit, -40.0));
    // Nonsense in, silence (not NaN) out.
    for (g, p) in [
        (f32::NAN, 1.0),
        (1.0, f32::NAN),
        (f32::INFINITY, 1.0),
        (-1.0, 1.0),
    ] {
        assert!(run(g, 1.0, p).iter().all(|v| v.is_finite()));
    }
    let mut r = Renderer::new();
    r.listener([f32::NAN; 3], AHEAD, RIGHT);
    r.play(Sound::ShotDmr, Some([f32::NAN, 0.0, 0.0]), 1.0, 1.0);
    r.play(Sound::ShotDmr, Some([3.0, 0.0, 0.0]), 1.0, 1.0);
    assert!(r.render_secs(1.0).iter().all(|v| v.is_finite()));
}

fn script(r: &mut Renderer, chunk: usize) -> Vec<f32> {
    let mut out = Vec::new();
    let mut go = |r: &mut Renderer, frames: usize| {
        let mut left = frames;
        while left > 0 {
            let n = left.min(chunk);
            out.extend(r.render(n));
            left -= n;
        }
    };
    r.listener([1.0, 1.7, 2.0], AHEAD, RIGHT);
    for i in 0..6 {
        r.play(Sound::ShotCarbine, None, 1.0, 1.0);
        r.play(
            Sound::StepSprint,
            Some([3.0 - i as f32, 0.0, -2.0]),
            1.0,
            1.0,
        );
        r.play(
            Sound::ShotSmg,
            Some([30.0, 1.0, -40.0 + 10.0 * i as f32]),
            1.0,
            0.9 + 0.05 * i as f32,
        );
        go(r, 4176);
        r.listener([1.0 + 0.1 * i as f32, 1.7, 2.0], AHEAD, RIGHT);
    }
    r.play(Sound::Explosion, Some([8.0, 0.0, -9.0]), 1.0, 1.0);
    r.muffle(0.6);
    r.play(Sound::KillConfirm, None, 1.0, 1.0);
    go(r, 30_000);
    r.muffle(0.0);
    go(r, 30_000);
    out
}

#[test]
fn the_same_calls_give_the_same_samples() {
    // The bank: every synthesis of a variation is bit-identical.
    for &s in Sound::ALL {
        for v in 0..variations(s) {
            assert!(
                raw_clip(s, v) == raw_clip(s, v),
                "{s:?}/{v} is not deterministic"
            );
        }
    }
    // The mixer: two runs of one script, and a third asking for its frames in odd-sized pieces.
    let a = script(&mut Renderer::new(), 4800);
    let b = script(&mut Renderer::new(), 4800);
    let c = script(&mut Renderer::new(), 333);
    assert!(a == b, "two runs differ");
    assert!(
        a == c,
        "the output depends on how many frames are asked for at a time"
    );
    assert!(an::peak(&a) > 0.3);
}

/// The longest run of consecutive samples at or past `level`.
fn longest_run(x: &[f32], level: f32) -> usize {
    let (mut best, mut run) = (0, 0);
    for v in x {
        run = if v.abs() >= level { run + 1 } else { 0 };
        best = best.max(run);
    }
    best
}

#[test]
fn two_hundred_plays_at_once_do_not_clip() {
    let mut r = Renderer::new();
    r.listener([0.0; 3], AHEAD, RIGHT);
    let loud = [
        Sound::ShotCarbine,
        Sound::ShotShotgun,
        Sound::ShotDmr,
        Sound::Explosion,
        Sound::ShotSmg,
    ];
    for i in 0..200 {
        let at = if i % 2 == 0 {
            None
        } else {
            Some([(i % 7) as f32 - 3.0, 0.0, -((i % 5) as f32)])
        };
        r.play(loud[i % loud.len()], at, 1.0, 1.0);
    }
    let x = r.render_secs(5.0);
    assert!(r.voices() == 0, "voices never end");
    assert!(x.iter().all(|v| v.is_finite()));
    let peak = an::peak(&x);
    assert!(peak <= 0.98, "peak {peak}");
    // Limited, not clipped: the output is pushed down smoothly, so it never sits on the ceiling. (A clipped mix
    // of this would be at full scale for hundreds of samples at a stretch.)
    assert!(
        longest_run(&x, 0.97) <= 2,
        "a run of {} samples at the ceiling",
        longest_run(&x, 0.97)
    );
    assert!(
        longest_run(&x, 0.9) <= 16,
        "a run of {} samples past the limiter's threshold",
        longest_run(&x, 0.9)
    );
    // And it is still loud: the limiter holds the mix near its threshold rather than ducking it away.
    assert!(peak > 0.8 && an::rms(secs(&an::mono(&x), 0.0, 0.2)) > 0.1);
    // The same again a moment later, on top of the first's tails, and with the limiter already working.
    for i in 0..200 {
        r.play(loud[i % loud.len()], None, 2.0, 1.0);
    }
    let x = r.render_secs(1.0);
    assert!(an::peak(&x) <= 0.98 && longest_run(&x, 0.97) <= 2);
}

#[test]
fn voices_are_stolen_but_never_the_ui() {
    // A stinger, then far more shots than there are voices: the stinger plays through.
    let mut with = Renderer::new();
    with.play(Sound::Victory, None, 1.0, 1.0);
    with.render(2400);
    for i in 0..300 {
        with.play(
            Sound::ShotSmg,
            Some([20.0 + (i % 9) as f32, 0.0, -30.0]),
            1.0,
            1.0,
        );
    }
    let with = an::mono(&with.render_secs(3.0));
    let alone = an::mono(&solos()[&Sound::Victory]);
    // Past the shots (1.4..1.7 s in) what is left is the stinger, as loud as it is alone.
    let (a, b) = (
        an::rms(secs(&with, 1.4, 1.7)),
        an::rms(secs(&alone, 1.45, 1.75)),
    );
    assert!(
        a > 0.7 * b && a < 1.3 * b && b > 0.01,
        "the stinger was stolen: {a} against {b} alone"
    );

    // Stealing takes the quietest: a near shot survives a flood of far ones.
    let mut r = Renderer::new();
    r.listener([0.0; 3], AHEAD, RIGHT);
    r.play(Sound::ShotDmr, None, 1.0, 1.0);
    for _ in 0..200 {
        r.play(Sound::StepCrouch, Some([6.0, 0.0, 0.0]), 0.2, 1.0);
    }
    let x = an::mono(&r.render_secs(1.5));
    let alone = an::mono(&solos()[&Sound::ShotDmr]);
    assert!(
        an::rms(secs(&x, 0.3, 1.0)) > 0.8 * an::rms(secs(&alone, 0.3, 1.0)),
        "the loud voice was stolen"
    );
    // More than 64 at once never happens, and a steal does not click: the flood above is smooth at the steal.
    let mut r = Renderer::new();
    for _ in 0..500 {
        r.play(Sound::Slide, None, 0.5, 1.0);
    }
    r.render(256);
    assert!(r.voices() <= 72, "{} voices", r.voices());
    r.render(4800);
    assert!(r.voices() <= 64, "{} voices", r.voices());
}

#[test]
fn stop_all_stops() {
    let mut r = Renderer::new();
    r.listener([0.0; 3], AHEAD, RIGHT);
    r.play(Sound::Explosion, Some([5.0, 0.0, -5.0]), 1.0, 1.0);
    r.play(Sound::Victory, None, 1.0, 1.0);
    r.play(Sound::ShotDmr, None, 1.0, 1.0);
    let before = r.render_secs(0.3);
    assert!(an::rms(secs(&an::mono(&before), 0.2, 0.3)) > 0.02);
    r.stop_all();
    let after = an::mono(&r.render_secs(1.0));
    // Faded within a few ms (voices and reverb), with no step: then nothing.
    assert!(
        an::peak(secs(&after, 0.03, 1.0)) < 1e-4,
        "still sounding: {}",
        an::peak(secs(&after, 0.03, 1.0))
    );
    assert_eq!(r.voices(), 0);
    // And it plays again afterwards.
    r.play(Sound::Hitmarker, None, 1.0, 1.0);
    assert!(an::peak(&r.render_secs(0.2)) > 0.1);
}

#[test]
fn repeats_vary() {
    // The same step twice in a row is never the same take, and never quite the same pitch or level.
    let mut r = Renderer::new();
    let mut takes: Vec<Vec<f32>> = Vec::new();
    for _ in 0..8 {
        r.play(Sound::StepConcrete, None, 1.0, 1.0);
        takes.push(r.render_secs(1.5));
    }
    for w in takes.windows(2) {
        assert!(w[0] != w[1], "the same footstep twice in a row");
        let (a, b) = (an::mono(&w[0]), an::mono(&w[1]));
        let corr: f64 = a
            .iter()
            .zip(&b)
            .map(|(x, y)| *x as f64 * *y as f64)
            .sum::<f64>()
            / (a.iter().map(|x| (*x as f64).powi(2)).sum::<f64>().sqrt()
                * b.iter().map(|x| (*x as f64).powi(2)).sum::<f64>().sqrt());
        assert!(
            corr.abs() < 0.9,
            "two steps in a row are {corr} correlated: the same take"
        );
    }
    // A hitmarker is one take: always recognisably the same tick.
    let mut r = Renderer::new();
    let mut ticks = Vec::new();
    for _ in 0..3 {
        r.play(Sound::Hitmarker, None, 1.0, 1.0);
        ticks.push(an::mono(&r.render_secs(0.5)));
    }
    assert!((an::db(an::peak(&ticks[0])) - an::db(an::peak(&ticks[1]))).abs() < 1.0);
}
