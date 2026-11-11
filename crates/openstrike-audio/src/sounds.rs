//! The bank's synthesis: every sound built from noise, sines and filters. No samples, no files.
//!
//! Each function returns a `Raw`: a mono stem (the part that is panned and falls off with 1/d) and, for some, a
//! stereo "wide" stem (a gunshot's environment tail, a stinger's stereo image). Levels here are only relative within
//! one sound: `bank::finalize` sets each sound's loudness.

use crate::dsp::*;
use crate::sound::Sound;

#[derive(Default)]
pub(crate) struct Raw {
    pub mono: Vec<f32>,
    pub l: Vec<f32>,
    pub r: Vec<f32>,
}

fn mono(m: Vec<f32>) -> Raw {
    Raw {
        mono: m,
        ..Raw::default()
    }
}

pub(crate) fn make(sound: Sound, rng: &Rng) -> Raw {
    use Sound::*;
    match sound {
        ShotCarbine => gunshot(rng, &CARBINE),
        ShotSmg => gunshot(rng, &SMG),
        ShotShotgun => gunshot(rng, &SHOTGUN),
        ShotDmr => gunshot(rng, &DMR),
        ShotPistol => gunshot(rng, &PISTOL),
        DryFire => mono(dry_fire(rng)),
        MagOut => mono(mag_out(rng)),
        MagIn => mono(mag_in(rng)),
        BoltRack => mono(bolt_rack(rng)),
        ShellInsert => mono(shell_insert(rng)),
        SwapWeapon => mono(swap_weapon(rng)),
        AdsIn => mono(ads(rng, true)),
        AdsOut => mono(ads(rng, false)),
        Melee => mono(melee(rng)),
        MeleeHit => mono(melee_hit(rng)),
        StepConcrete => mono(step(rng, 0.55, 0.55, 1.0)),
        StepSprint => mono(step(rng, 1.0, 0.9, 1.25)),
        StepCrouch => mono(step(rng, 0.25, 0.3, 0.45)),
        Jump => mono(jump(rng)),
        Land => mono(land(rng)),
        Slide => mono(slide(rng)),
        Mantle => mono(mantle(rng)),
        ImpactConcrete => mono(impact_concrete(rng)),
        ImpactMetal => mono(impact_metal(rng)),
        ImpactFlesh => mono(impact_flesh(rng)),
        Ricochet => mono(ricochet(rng)),
        Whiz => mono(whiz(rng)),
        Casing => mono(casing(rng)),
        Hitmarker => mono(hitmarker(rng, false)),
        HitmarkerHead => mono(hitmarker(rng, true)),
        KillConfirm => mono(kill_confirm(rng)),
        Hurt => mono(hurt(rng)),
        Death => death(rng),
        LowHealth => mono(low_health()),
        Medal => medal(rng),
        NadePin => mono(nade_pin(rng)),
        NadeThrow => mono(nade_throw(rng)),
        NadeBounce => mono(nade_bounce(rng)),
        Explosion => explosion(rng),
        UiMove => mono(ui_blips(&[(0.0, 1100.0, 0.014)], 0.25)),
        UiSelect => mono(ui_blips(&[(0.0, 880.0, 0.028), (0.055, 1318.5, 0.05)], 0.2)),
        UiBack => mono(ui_blips(&[(0.0, 659.3, 0.028), (0.055, 440.0, 0.05)], 0.12)),
        CountBeep => mono(count_beep()),
        CountGo => count_go(rng),
        Respawn => respawn(rng),
        Victory => victory(rng),
        Defeat => defeat(rng),
        LeadTaken => lead(true),
        LeadLost => lead(false),
    }
}

// ----------------------------------------------------------------------------------------------------------- layers

fn nrm(mut v: Vec<f32>) -> Vec<f32> {
    norm(&mut v, 1.0);
    v
}

/// Band-limited noise under an attack/decay envelope.
fn burst(rng: &Rng, len: f32, lo: f32, hi: f32, a: f32, d: f32) -> Vec<f32> {
    let mut x = band(rng, secs(len), lo, hi);
    env(&mut x, |t| ad(t, a, d));
    nrm(x)
}

/// Saturated band noise at full level: the drive goes in before any envelope, so it thickens the sound without
/// flattening its decay.
fn dense(rng: &Rng, len: f32, lo: f32, hi: f32, drv: f32) -> Vec<f32> {
    let mut x = band(rng, secs(len), lo, hi);
    gain(&mut x, 3.0);
    drive(&mut x, drv);
    lp(&mut x, (hi * 2.5).min(18_000.0));
    nrm(x)
}

/// `burst`, of dense noise.
fn dburst(rng: &Rng, len: f32, lo: f32, hi: f32, a: f32, d: f32, drv: f32) -> Vec<f32> {
    let mut x = dense(rng, len, lo, hi, drv);
    env(&mut x, |t| ad(t, a, d));
    x
}

/// A hard little click: a noise spike and three short inharmonic modes around `hz` (steel on steel, a latch).
fn click(rng: &Rng, hz: f32, ring_ms: f32, spike: f32) -> Vec<f32> {
    let ring = ring_ms * 0.001;
    let len = secs(ring * 8.0 + 0.006);
    let mut x = modal(
        len,
        &[
            (hz, ring, 1.0),
            (hz * rng.range(1.38, 1.56), ring * 0.7, 0.6),
            (hz * rng.range(1.95, 2.3), ring * 0.5, 0.4),
            (hz * rng.range(2.9, 3.4), ring * 0.3, 0.2),
        ],
    );
    norm(&mut x, 1.0);
    let s = burst(rng, 0.006, (hz * 0.7).min(6000.0), 14_000.0, 0.0001, 0.0009);
    add(&mut x, &s, 0.0, spike);
    nrm(x)
}

/// A duller knock: wood, polymer, a magazine in its well.
fn knock(rng: &Rng, hz: f32, ring_ms: f32) -> Vec<f32> {
    let ring = ring_ms * 0.001;
    let mut x = modal(
        secs(ring * 8.0 + 0.01),
        &[
            (hz, ring, 1.0),
            (hz * rng.range(1.6, 1.8), ring * 0.6, 0.5),
            (hz * rng.range(2.5, 2.9), ring * 0.4, 0.3),
        ],
    );
    let s = burst(rng, 0.012, hz * 0.6, hz * 6.0, 0.0002, 0.002);
    add(&mut x, &s, 0.0, 0.5);
    nrm(x)
}

/// Cloth and webbing: pink noise in a band, under a lumpy contour.
fn cloth(rng: &Rng, len: f32, lo: f32, hi: f32, lump_hz: f32) -> Vec<f32> {
    let n = secs(len);
    let mut x = pink(rng, n);
    hp(&mut x, lo);
    lp(&mut x, hi);
    let l = lumps(rng, n, lump_hz);
    for (a, b) in x.iter_mut().zip(&l) {
        *a *= b;
    }
    fade_in(&mut x, 0.01);
    fade_out(&mut x, len * 0.3);
    nrm(x)
}

/// A handful of small metal ticks at random times: sling swivels, buckles, loose rounds.
fn rattle(rng: &Rng, len: f32, count: usize, lo: f32, hi: f32) -> Vec<f32> {
    let mut out = vec![0.0; secs(len)];
    for _ in 0..count {
        let hz = rng.range(lo, hi);
        let c = click(rng, hz, rng.range(2.5, 8.0), 0.5);
        let at = rng.range(0.0, len * 0.85);
        add(&mut out, &c, at, rng.range(0.35, 1.0));
    }
    nrm(out)
}

/// Grit: a decaying spray of grains in a band (sand under a boot, chips off a wall).
fn grit(rng: &Rng, len: f32, lo: f32, hi: f32, density: f32, tau: f32) -> Vec<f32> {
    let mut x = grains(rng, secs(len), |t| density * (-t / tau).exp());
    hp(&mut x, lo);
    lp(&mut x, hi);
    nrm(x)
}

/// Air moved: noise through a band-pass whose centre follows `fc(t)`, under a bell.
fn whoosh(
    rng: &Rng,
    len: f32,
    q: f32,
    centre: f32,
    width: f32,
    fc: impl Fn(f32) -> f32,
) -> Vec<f32> {
    let mut x = white(rng, secs(len));
    sweep(&mut x, Kind::Bp, q, fc);
    env(&mut x, |t| bell(t, centre, width));
    fade_in(&mut x, 0.004);
    fade_out(&mut x, 0.02);
    nrm(x)
}

/// A plucked, slightly bright tone: harmonics that die faster the higher they are.
fn pluck(hz: f32, len: f32, tau: f32, bright: f32) -> Vec<f32> {
    let modes: Vec<(f32, f32, f32)> = (1..=10)
        .map(|k| {
            let k = k as f32;
            (
                hz * k,
                tau / (1.0 + 0.45 * (k - 1.0)),
                1.0 / k.powf(2.2 - bright),
            )
        })
        .collect();
    let mut x = modal(secs(len), &modes);
    fade_in(&mut x, 0.0015);
    nrm(x)
}

/// A small bell or glockenspiel bar.
fn chime(hz: f32, len: f32, tau: f32) -> Vec<f32> {
    let mut x = modal(
        secs(len),
        &[
            (hz, tau, 1.0),
            (hz * 2.76, tau * 0.45, 0.35),
            (hz * 5.4, tau * 0.2, 0.18),
            (hz * 2.0, tau * 0.7, 0.2),
        ],
    );
    fade_in(&mut x, 0.001);
    nrm(x)
}

/// A stereo noise tail: the environment answering. `t60` seconds to -60 dB; the highs close first; `width` 0..1 is
/// how different left and right are; `pre` seconds before it swells in.
fn tail(rng: &Rng, lo: f32, hi: f32, t60: f32, pre: f32, width: f32) -> (Vec<f32>, Vec<f32>) {
    let n = secs(t60 * 1.12 + 0.04);
    let mk = |rng: &Rng| {
        let mut x = pink(rng, n);
        hp(&mut x, lo);
        sweep(&mut x, Kind::Lp, 0.7, |t| {
            hi * (0.22 + 0.78 * (-t / (t60 * 0.3)).exp())
        });
        x
    };
    // Two independent noises as mid and side: left and right then correlate by 1 - width.
    let (mut l, mut r) = (mk(rng), mk(rng));
    let roll = lumps(rng, n, 11.0);
    let side = (width / (2.0 - width)).sqrt();
    let (attack, decay) = ((-1.0 / (pre * SR)).exp(), (-6.908 / (t60 * SR)).exp());
    let (mut rise, mut fall) = (1.0f32, 1.0f32);
    for i in 0..n {
        let e = (1.0 - rise) * fall * (0.7 + 0.6 * roll[i]);
        let (m, s) = (l[i], r[i] * side);
        l[i] = (m + s) * e;
        r[i] = (m - s) * e;
        rise *= attack;
        fall *= decay;
    }
    fade_out(&mut l, 0.04);
    fade_out(&mut r, 0.04);
    let p = peak(&l).max(peak(&r)).max(1e-9);
    gain(&mut l, 1.0 / p);
    gain(&mut r, 1.0 / p);
    (l, r)
}

// --------------------------------------------------------------------------------------------------------- gunshots

/// A weapon's voice. Hz, ms, and gains relative to the crack.
struct Gun {
    /// The crack: noise above `crack_hp`, a few ms.
    crack_hp: f32,
    crack_ms: f32,
    crack: f32,
    /// The body: saturated noise in a band, tens of ms.
    body: (f32, f32),
    body_ms: f32,
    body_gain: f32,
    drive: f32,
    /// Receiver and barrel resonances: two short, noisy formants.
    res: [f32; 2],
    res_ms: f32,
    res_gain: f32,
    /// The sub thump: a sine falling from .0 to .1.
    sub: (f32, f32),
    sub_drop_ms: f32,
    sub_ms: f32,
    sub_gain: f32,
    /// The action cycling.
    mech_hz: f32,
    mech_at_ms: f32,
    mech_gain: f32,
    /// Muzzle gas: a short bright hiss behind the crack.
    sizzle: f32,
    sizzle_ms: f32,
    /// Early reflections.
    er: f32,
    /// The environment tail (the wide stem).
    tail: (f32, f32),
    tail_t60: f32,
    tail_gain: f32,
    tail_pre_ms: f32,
    width: f32,
    slap: f32,
}

/// 5.56 rifle: a sharp crack and a tight body.
const CARBINE: Gun = Gun {
    crack_hp: 2300.0,
    crack_ms: 4.2,
    crack: 1.0,
    body: (380.0, 1900.0),
    body_ms: 26.0,
    body_gain: 0.8,
    drive: 2.6,
    res: [660.0, 1180.0],
    res_ms: 13.0,
    res_gain: 0.3,
    sub: (155.0, 64.0),
    sub_drop_ms: 20.0,
    sub_ms: 50.0,
    sub_gain: 0.22,
    mech_hz: 2900.0,
    mech_at_ms: 46.0,
    mech_gain: 0.1,
    sizzle: 0.3,
    sizzle_ms: 22.0,
    er: 0.5,
    tail: (260.0, 5200.0),
    tail_t60: 1.5,
    tail_gain: 0.3,
    tail_pre_ms: 11.0,
    width: 0.7,
    slap: 0.3,
};

/// 9 mm / 4.6: higher, snappier, lighter.
const SMG: Gun = Gun {
    crack_hp: 3300.0,
    crack_ms: 2.8,
    crack: 1.0,
    body: (650.0, 2700.0),
    body_ms: 16.0,
    body_gain: 0.65,
    drive: 2.0,
    res: [1280.0, 2150.0],
    res_ms: 8.0,
    res_gain: 0.26,
    sub: (205.0, 98.0),
    sub_drop_ms: 13.0,
    sub_ms: 28.0,
    sub_gain: 0.12,
    mech_hz: 3800.0,
    mech_at_ms: 33.0,
    mech_gain: 0.16,
    sizzle: 0.34,
    sizzle_ms: 14.0,
    er: 0.4,
    tail: (480.0, 6500.0),
    tail_t60: 1.2,
    tail_gain: 0.27,
    tail_pre_ms: 8.0,
    width: 0.6,
    slap: 0.2,
};

/// 12 gauge: a big low boom, wide.
const SHOTGUN: Gun = Gun {
    crack_hp: 1300.0,
    crack_ms: 8.5,
    crack: 0.95,
    body: (120.0, 1000.0),
    body_ms: 58.0,
    body_gain: 1.0,
    drive: 3.6,
    res: [300.0, 540.0],
    res_ms: 28.0,
    res_gain: 0.32,
    sub: (132.0, 48.0),
    sub_drop_ms: 44.0,
    sub_ms: 150.0,
    sub_gain: 0.4,
    mech_hz: 1700.0,
    mech_at_ms: 95.0,
    mech_gain: 0.07,
    sizzle: 0.3,
    sizzle_ms: 40.0,
    er: 0.6,
    tail: (85.0, 3000.0),
    tail_t60: 1.7,
    tail_gain: 0.4,
    tail_pre_ms: 18.0,
    width: 0.95,
    slap: 0.34,
};

/// 7.62: loud, deep, a long tail.
const DMR: Gun = Gun {
    crack_hp: 1900.0,
    crack_ms: 6.0,
    crack: 1.0,
    body: (230.0, 1450.0),
    body_ms: 40.0,
    body_gain: 0.9,
    drive: 3.1,
    res: [460.0, 830.0],
    res_ms: 19.0,
    res_gain: 0.3,
    sub: (132.0, 47.0),
    sub_drop_ms: 30.0,
    sub_ms: 100.0,
    sub_gain: 0.36,
    mech_hz: 2300.0,
    mech_at_ms: 62.0,
    mech_gain: 0.09,
    sizzle: 0.28,
    sizzle_ms: 30.0,
    er: 0.55,
    tail: (170.0, 4200.0),
    tail_t60: 1.9,
    tail_gain: 0.38,
    tail_pre_ms: 15.0,
    width: 0.8,
    slap: 0.36,
};

const PISTOL: Gun = Gun {
    crack_hp: 2700.0,
    crack_ms: 3.6,
    crack: 1.0,
    body: (480.0, 2200.0),
    body_ms: 21.0,
    body_gain: 0.7,
    drive: 2.2,
    res: [930.0, 1620.0],
    res_ms: 10.0,
    res_gain: 0.28,
    sub: (178.0, 80.0),
    sub_drop_ms: 17.0,
    sub_ms: 38.0,
    sub_gain: 0.18,
    mech_hz: 3300.0,
    mech_at_ms: 38.0,
    mech_gain: 0.18,
    sizzle: 0.3,
    sizzle_ms: 17.0,
    er: 0.45,
    tail: (360.0, 5600.0),
    tail_t60: 1.3,
    tail_gain: 0.25,
    tail_pre_ms: 10.0,
    width: 0.6,
    slap: 0.22,
};

fn gunshot(rng: &Rng, g: &Gun) -> Raw {
    let v = |rng: &Rng, x: f32| rng.jit(x, 0.05);
    let mut dry = Vec::new();

    // The crack: a few ms of bright noise with an instant onset, and an N-wave (the pressure spike and its
    // rarefaction) so the first sample is a step and not a fade.
    let ct = g.crack_ms * 0.001;
    let mut crack = white(rng, secs(ct * 12.0));
    hp4(&mut crack, v(rng, g.crack_hp));
    env(&mut crack, |t| {
        (-t / ct).exp() + 0.1 * (-t / (ct * 4.0)).exp()
    });
    norm(&mut crack, 1.0);
    add(&mut dry, &crack, 0.0, g.crack);
    let mut snap = vec![0.0f32; 96];
    snap[..5].fill(1.0);
    snap[5..17].fill(-0.42);
    lp(&mut snap, 11_000.0);
    add(&mut dry, &snap, 0.0, g.crack * 0.7);

    // The body: saturated mid noise, the "pow". Its decay is the weapon's weight.
    let bt = g.body_ms * 0.001;
    let mut body = dense(rng, bt * 8.0, v(rng, g.body.0), v(rng, g.body.1), g.drive);
    env(&mut body, |t| ad(t, 0.0003, bt));
    add(&mut dry, &body, 0.0004, g.body_gain);
    // Muzzle gas: a bright hiss that outlasts the crack by a few tens of ms.
    let zt = g.sizzle_ms * 0.001;
    let mut sizzle = white(rng, secs(zt * 7.0));
    hp(&mut sizzle, 4500.0);
    env(&mut sizzle, |t| ad(t, 0.0006, zt));
    add(&mut dry, &nrm(sizzle), 0.0, g.sizzle);

    // Two noisy formants: the receiver and the barrel ring for a few ms and give each weapon its vowel.
    for (i, &hz) in g.res.iter().enumerate() {
        let rt = g.res_ms * 0.001;
        let mut r = white(rng, secs(rt * 7.0));
        let f = v(rng, hz);
        bp(&mut r, f, 6.0);
        bp(&mut r, f, 3.0);
        env(&mut r, |t| ad(t, 0.0005, rt));
        norm(&mut r, 1.0);
        add(&mut dry, &r, 0.001, g.res_gain * [1.0, 0.7][i]);
    }

    // Early reflections: the ground and the nearest walls, a few ms behind and duller each time.
    let taps: Vec<(f32, f32, f32)> = [
        (0.0087, 0.42, 5200.0),
        (0.0173, 0.33, 3800.0),
        (0.0291, 0.24, 2700.0),
        (0.0437, 0.17, 1900.0),
        (0.0613, 0.11, 1400.0),
    ]
    .iter()
    .map(|&(d, a, f)| (rng.jit(d, 0.12), a * rng.range(0.8, 1.2), f))
    .collect();
    let er = echoes(&dry, &taps);
    add(&mut dry, &er, 0.0, g.er);

    // The sub thump: a falling sine, lightly driven so small speakers get its harmonics.
    let st = g.sub_ms * 0.001;
    let mut sub = thump(
        secs(st * 7.0),
        v(rng, g.sub.0),
        v(rng, g.sub.1),
        g.sub_drop_ms * 0.001,
        st,
    );
    gain(&mut sub, 1.5);
    drive(&mut sub, 1.0);
    norm(&mut sub, 1.0);
    add(&mut dry, &sub, 0.0, g.sub_gain);

    // Everything at the muzzle goes through one gentle saturation, as a recording's does: it rounds the very top
    // of the transient and leaves the decay's shape alone.
    norm(&mut dry, 1.25);
    drive(&mut dry, 1.0);
    norm(&mut dry, 1.0);

    // The action: bolt back, bolt home.
    let at = g.mech_at_ms * 0.001;
    let c = click(rng, v(rng, g.mech_hz), 6.0, 0.8);
    add(&mut dry, &c, at, g.mech_gain);
    let c = click(rng, v(rng, g.mech_hz * 0.78), 9.0, 0.6);
    add(&mut dry, &c, at * 1.8 + 0.012, g.mech_gain * 0.85);

    // The tail: the street answering, with the shot slapping back off a far wall on each side.
    let (mut l, mut r) = tail(
        rng,
        g.tail.0,
        g.tail.1,
        g.tail_t60,
        g.tail_pre_ms * 0.001,
        g.width,
    );
    gain(&mut l, g.tail_gain);
    gain(&mut r, g.tail_gain);
    let sl = echoes(
        &body,
        &[
            (rng.range(0.07, 0.1), 1.0, 1800.0),
            (rng.range(0.17, 0.22), 0.5, 1100.0),
        ],
    );
    let sr = echoes(
        &body,
        &[
            (rng.range(0.1, 0.14), 0.9, 1500.0),
            (rng.range(0.23, 0.29), 0.45, 900.0),
        ],
    );
    add(&mut l, &sl, 0.0, g.slap * g.tail_gain);
    add(&mut r, &sr, 0.0, g.slap * g.tail_gain);
    Raw { mono: dry, l, r }
}

fn explosion(rng: &Rng) -> Raw {
    let mut dry = Vec::new();
    // The detonation: a full-band crack and its N-wave.
    let mut crack = white(rng, secs(0.08));
    hp(&mut crack, 700.0);
    env(&mut crack, |t| {
        (-t / 0.006).exp() + 0.15 * (-t / 0.03).exp()
    });
    add(&mut dry, &nrm(crack), 0.0, 2.2);
    let mut snap = vec![0.0f32; 160];
    snap[..10].fill(1.0);
    snap[10..40].fill(-0.4);
    lp(&mut snap, 8000.0);
    add(&mut dry, &snap, 0.0, 1.4);
    // The blast: dense saturated noise whose highs close in a quarter second.
    let mut blast = dense(rng, 0.9, 50.0, 5000.0, 4.0);
    env(&mut blast, |t| {
        ad(t, 0.001, 0.06) + 0.3 * ad(t, 0.001, 0.22)
    });
    let top = rng.range(6500.0, 8000.0);
    sweep(&mut blast, Kind::Lp, 0.8, |t| {
        260.0 + top * (-t / 0.09).exp()
    });
    add(&mut dry, &nrm(blast), 0.0005, 0.85);
    // Early reflections of all that.
    let er = echoes(
        &dry,
        &[
            (0.011, 0.4, 4000.0),
            (0.023, 0.32, 2600.0),
            (0.041, 0.25, 1700.0),
            (0.067, 0.18, 1100.0),
        ],
    );
    add(&mut dry, &er, 0.0, 0.6);
    // The sub boom, and the slower pressure wave behind it.
    let f0 = rng.range(74.0, 84.0);
    let mut sub = thump(secs(2.2), f0, 29.0, 0.13, 0.36);
    gain(&mut sub, 1.8);
    drive(&mut sub, 1.0);
    add(&mut dry, &nrm(sub), 0.0, 0.6);
    let mut wave = thump(secs(2.0), 56.0, 25.0, 0.2, 0.42);
    drive(&mut wave, 1.3);
    add(&mut dry, &nrm(wave), 0.055, 0.28);
    // A low-mid roar with turbulence, so the boom has a body where small speakers can play it.
    let mut roar = dense(rng, 1.6, 90.0, 700.0, 2.0);
    let turb = lumps(rng, roar.len(), 22.0);
    for (i, x) in roar.iter_mut().enumerate() {
        *x *= ad(i as f32 / SR, 0.012, 0.3) * (0.45 + 0.55 * turb[i]);
    }
    add(&mut dry, &nrm(roar), 0.004, 0.55);
    norm(&mut dry, 1.2);
    drive(&mut dry, 1.0);
    norm(&mut dry, 1.0);

    // The tail: three seconds of rolling rumble, and debris coming down on both sides.
    let (mut l, mut r) = tail(rng, 45.0, 3400.0, 3.3, 0.03, 0.9);
    gain(&mut l, 0.5);
    gain(&mut r, 0.5);
    for side in [&mut l, &mut r] {
        // Chunks: sparse, each a small knock with its own pitch.
        let mut chunks = vec![0.0f32; secs(2.8)];
        for _ in 0..rng.range(9.0, 14.0) as usize {
            let t = 0.22 + rng.f().powf(1.6) * 2.2;
            let hz = rng.range(500.0, 2600.0);
            let k = knock(rng, hz, rng.range(4.0, 14.0));
            add(
                &mut chunks,
                &k,
                t,
                rng.range(0.25, 1.0) * (-(t - 0.2) / 1.1).exp(),
            );
        }
        add(side, &chunks, 0.0, 0.16);
        // Dirt and gravel raining back.
        let mut rain = grains(rng, secs(2.6), |t| 1400.0 * bell(t, 0.85, 0.55));
        hp(&mut rain, 2200.0);
        lp(&mut rain, 9000.0);
        add(side, &nrm(rain), 0.15, 0.1);
        fade_out(side, 0.25);
    }
    Raw { mono: dry, l, r }
}

// -------------------------------------------------------------------------------------------------- weapon handling

fn dry_fire(rng: &Rng) -> Vec<f32> {
    let mut out = Vec::new();
    let hz = rng.range(1750.0, 2000.0);
    add(&mut out, &click(rng, hz, 9.0, 0.9), 0.0, 1.0);
    add(
        &mut out,
        &knock(rng, rng.range(290.0, 340.0), 7.0),
        0.0005,
        0.5,
    );
    // The spring settling.
    add(&mut out, &click(rng, hz * 1.9, 4.0, 0.3), 0.021, 0.18);
    out
}

fn scrape(rng: &Rng, len: f32, lo: f32, hi: f32, rise: bool) -> Vec<f32> {
    let mut x = band(rng, secs(len), lo, hi);
    let g = lumps(rng, x.len(), 180.0);
    for (i, v) in x.iter_mut().enumerate() {
        let u = i as f32 / (len * SR);
        let e = if rise { u * u } else { (1.0 - u) * (1.0 - u) };
        *v *= e * (0.4 + 0.6 * g[i]);
    }
    fade_out(&mut x, 0.004);
    nrm(x)
}

fn mag_out(rng: &Rng) -> Vec<f32> {
    let mut out = Vec::new();
    // The release, the magazine sliding down the well, and its lips clearing.
    add(
        &mut out,
        &click(rng, rng.range(3000.0, 3500.0), 4.0, 0.8),
        0.0,
        0.55,
    );
    add(
        &mut out,
        &scrape(rng, 0.1, 1400.0, 5200.0, true),
        0.025,
        0.28,
    );
    let hz = rng.range(480.0, 560.0);
    add(&mut out, &knock(rng, hz, 13.0), 0.128, 1.0);
    add(
        &mut out,
        &burst(rng, 0.05, 300.0, 2200.0, 0.0004, 0.007),
        0.128,
        0.6,
    );
    add(
        &mut out,
        &thump(secs(0.1), 250.0, 150.0, 0.012, 0.014),
        0.128,
        0.3,
    );
    add(&mut out, &click(rng, 2300.0, 5.0, 0.6), 0.131, 0.35);
    out
}

fn mag_in(rng: &Rng) -> Vec<f32> {
    let mut out = Vec::new();
    // Touch, slide up, seat with a solid clack, and the catch a moment later.
    add(
        &mut out,
        &click(rng, rng.range(2100.0, 2500.0), 4.0, 0.6),
        0.0,
        0.3,
    );
    add(
        &mut out,
        &scrape(rng, 0.075, 1200.0, 4800.0, true),
        0.008,
        0.3,
    );
    let hz = rng.range(400.0, 460.0);
    add(&mut out, &knock(rng, hz, 15.0), 0.086, 1.0);
    add(
        &mut out,
        &burst(rng, 0.06, 260.0, 2400.0, 0.0004, 0.008),
        0.086,
        0.7,
    );
    add(
        &mut out,
        &thump(secs(0.12), 230.0, 130.0, 0.012, 0.016),
        0.086,
        0.35,
    );
    add(&mut out, &click(rng, 2700.0, 7.0, 0.9), 0.087, 0.55);
    add(
        &mut out,
        &click(rng, rng.range(3500.0, 3900.0), 4.0, 0.8),
        0.118,
        0.35,
    );
    out
}

fn bolt_rack(rng: &Rng) -> Vec<f32> {
    let mut out = Vec::new();
    // Back: the charging handle drags and stops. Forward: the spring throws the bolt home, and rings.
    add(&mut out, &click(rng, 2600.0, 3.0, 0.7), 0.0, 0.3);
    let mut pull = scrape(rng, 0.09, 900.0, 4200.0, true);
    sweep(&mut pull, Kind::Bp, 1.2, |t| 1300.0 + 14_000.0 * t);
    add(&mut out, &nrm(pull), 0.006, 0.4);
    add(
        &mut out,
        &knock(rng, rng.range(660.0, 740.0), 14.0),
        0.096,
        0.7,
    );
    add(&mut out, &click(rng, 2400.0, 6.0, 0.8), 0.097, 0.5);
    let fwd = rng.range(0.19, 0.215);
    add(
        &mut out,
        &scrape(rng, 0.035, 1500.0, 6000.0, true),
        fwd - 0.036,
        0.3,
    );
    add(
        &mut out,
        &knock(rng, rng.range(500.0, 560.0), 14.0),
        fwd,
        1.0,
    );
    add(
        &mut out,
        &burst(rng, 0.06, 350.0, 3000.0, 0.0003, 0.008),
        fwd,
        0.7,
    );
    add(&mut out, &click(rng, 1950.0, 9.0, 1.0), fwd, 0.85);
    add(
        &mut out,
        &thump(secs(0.12), 220.0, 120.0, 0.012, 0.016),
        fwd,
        0.35,
    );
    let spring = modal(
        secs(0.3),
        &[
            (2930.0, 0.05, 1.0),
            (4410.0, 0.035, 0.6),
            (6150.0, 0.02, 0.3),
        ],
    );
    add(&mut out, &nrm(spring), fwd + 0.002, 0.1);
    out
}

fn shell_insert(rng: &Rng) -> Vec<f32> {
    let mut out = Vec::new();
    // A shell against the loading port, thumbed up the tube, past the latch.
    add(
        &mut out,
        &knock(rng, rng.range(1300.0, 1600.0), 4.0),
        0.0,
        0.35,
    );
    add(
        &mut out,
        &scrape(rng, 0.085, 800.0, 3400.0, true),
        0.015,
        0.32,
    );
    let at = 0.105;
    add(
        &mut out,
        &knock(rng, rng.range(560.0, 660.0), 15.0),
        at,
        1.0,
    );
    add(
        &mut out,
        &click(rng, rng.range(1900.0, 2200.0), 7.0, 0.8),
        at + 0.001,
        0.6,
    );
    // The magazine tube answers, hollow.
    let tube = modal(
        secs(0.25),
        &[(rng.range(330.0, 370.0), 0.035, 1.0), (710.0, 0.02, 0.4)],
    );
    add(&mut out, &nrm(tube), at + 0.001, 0.3);
    out
}

fn swap_weapon(rng: &Rng) -> Vec<f32> {
    let mut out = cloth(rng, 0.4, 260.0, 3200.0, 13.0);
    add(&mut out, &rattle(rng, 0.32, 6, 2600.0, 6200.0), 0.03, 0.4);
    // The hand finding the grip.
    add(
        &mut out,
        &thump(secs(0.1), 150.0, 85.0, 0.015, 0.02),
        0.27,
        0.45,
    );
    add(&mut out, &knock(rng, 700.0, 6.0), 0.271, 0.35);
    out
}

fn ads(rng: &Rng, up: bool) -> Vec<f32> {
    let len = if up { 0.17 } else { 0.2 };
    let mut out = cloth(rng, len, 300.0, 5000.0, 18.0);
    sweep(&mut out, Kind::Lp, 0.7, |t| {
        if up {
            700.0 + 16_000.0 * t
        } else {
            3600.0 - 14_000.0 * t.min(0.2)
        }
    });
    norm(&mut out, 1.0);
    if up {
        // The stock meeting the shoulder.
        add(
            &mut out,
            &thump(secs(0.08), 135.0, 80.0, 0.012, 0.016),
            0.11,
            0.5,
        );
        add(
            &mut out,
            &click(rng, rng.range(3200.0, 4200.0), 3.0, 0.4),
            0.105,
            0.12,
        );
    } else {
        add(&mut out, &rattle(rng, 0.14, 2, 3000.0, 5500.0), 0.02, 0.14);
    }
    out
}

fn melee(rng: &Rng) -> Vec<f32> {
    let top = rng.range(2300.0, 3000.0);
    let mut out = whoosh(rng, 0.27, 1.7, 0.105, 0.055, |t| {
        450.0 + top * bell(t, 0.11, 0.06)
    });
    let low = whoosh(rng, 0.27, 1.0, 0.11, 0.07, |t| {
        180.0 + 300.0 * bell(t, 0.11, 0.08)
    });
    add(&mut out, &low, 0.0, 0.5);
    add(&mut out, &cloth(rng, 0.2, 400.0, 3000.0, 20.0), 0.02, 0.2);
    out
}

fn melee_hit(rng: &Rng) -> Vec<f32> {
    let mut out = thump(secs(0.4), rng.range(120.0, 140.0), 60.0, 0.022, 0.05);
    gain(&mut out, 0.42);
    add(
        &mut out,
        &dburst(rng, 0.2, 280.0, 2400.0, 0.0006, 0.02, 2.5),
        0.0,
        0.85,
    );
    add(
        &mut out,
        &burst(rng, 0.02, 2000.0, 9000.0, 0.0001, 0.002),
        0.0,
        0.4,
    );
    add(
        &mut out,
        &grit(rng, 0.12, 900.0, 4500.0, 2200.0, 0.025),
        0.004,
        0.3,
    );
    add(
        &mut out,
        &knock(rng, rng.range(380.0, 470.0), 12.0),
        0.001,
        0.5,
    );
    out
}

// --------------------------------------------------------------------------------------------------------- movement

/// A footstep on concrete: the heel's knock, the sole's slap, grit, and the toe rolling down after it. `weight`
/// is how hard it lands, `bright` how hard the sole is (a crouched step is soft and mostly cloth).
fn step(rng: &Rng, weight: f32, grit_amt: f32, bright: f32) -> Vec<f32> {
    let b = bright.max(0.45);
    // The slap carries the step: a band of noise a few hundred Hz wide, over in 15 ms.
    let hi = rng.range(1300.0, 1800.0) * b;
    let mut out = burst(
        rng,
        0.09,
        rng.range(200.0, 280.0),
        hi,
        0.0008 / b,
        0.011 + 0.004 * weight,
    );
    add(
        &mut out,
        &burst(rng, 0.012, 1500.0, 7500.0 * b, 0.0002, 0.0016),
        0.0,
        0.32 * bright,
    );
    // The heel: a short knock around 150 Hz and the floor's thud under it (felt more than heard).
    add(
        &mut out,
        &knock(rng, rng.range(140.0, 185.0), 9.0 + 5.0 * weight),
        0.0,
        0.5 + 0.2 * weight,
    );
    let low = thump(
        secs(0.12),
        rng.range(105.0, 130.0),
        rng.range(56.0, 66.0),
        0.011,
        0.018 + 0.006 * weight,
    );
    add(&mut out, &low, 0.0, 0.15 + 0.15 * weight);
    add(
        &mut out,
        &grit(rng, 0.13, 1700.0, 7500.0 * b, 2600.0, 0.03),
        0.006,
        0.42 * grit_amt,
    );
    // The toe.
    let toe = rng.range(0.062, 0.095) / (0.8 + 0.4 * weight);
    add(
        &mut out,
        &burst(rng, 0.05, 420.0, hi * 1.5, 0.001, 0.008),
        toe,
        0.3,
    );
    add(
        &mut out,
        &grit(rng, 0.07, 2200.0, 8000.0 * b, 1800.0, 0.018),
        toe,
        0.2 * grit_amt,
    );
    if bright < 0.6 {
        lp(&mut out, 2600.0);
        add(&mut out, &cloth(rng, 0.14, 300.0, 2400.0, 16.0), 0.0, 0.5);
    }
    out
}

fn jump(rng: &Rng) -> Vec<f32> {
    let mut out = step(rng, 0.7, 1.0, 1.1);
    let mut up = cloth(rng, 0.2, 350.0, 4200.0, 16.0);
    sweep(&mut up, Kind::Lp, 0.7, |t| 900.0 + 14_000.0 * t);
    add(&mut out, &nrm(up), 0.01, 0.6);
    add(&mut out, &rattle(rng, 0.12, 2, 2800.0, 5200.0), 0.03, 0.15);
    out
}

fn land(rng: &Rng) -> Vec<f32> {
    let mut out = Vec::new();
    // Two boots a few ms apart, the weight behind them, and the kit settling.
    let gap = rng.range(0.018, 0.034);
    add(&mut out, &step(rng, 1.3, 1.0, 1.1), 0.0, 1.0);
    add(&mut out, &step(rng, 1.2, 0.9, 1.0), gap, 0.85);
    add(
        &mut out,
        &thump(secs(0.35), 110.0, 50.0, 0.03, 0.05),
        0.002,
        0.45,
    );
    add(&mut out, &rattle(rng, 0.14, 4, 2400.0, 5600.0), 0.03, 0.22);
    add(&mut out, &cloth(rng, 0.22, 250.0, 2800.0, 14.0), 0.01, 0.4);
    out
}

fn slide(rng: &Rng) -> Vec<f32> {
    let len = rng.range(0.68, 0.74);
    let n = secs(len);
    // Cloth and kit dragged over concrete: a gritty band that slows and dulls, over a low rumble.
    let mut x = band(rng, n, 320.0, 6500.0);
    let g = lumps(rng, n, 70.0);
    let contour =
        |t: f32| (t / 0.025).min(1.0) * (1.0 - 0.55 * (t / len)) * smoothstep(len, len - 0.2, t);
    for (i, v) in x.iter_mut().enumerate() {
        *v *= contour(i as f32 / SR) * (0.35 + 0.65 * g[i]);
    }
    sweep(&mut x, Kind::Lp, 0.8, |t| 5200.0 - 3600.0 * (t / len));
    let mut out = nrm(x);
    let mut low = band(rng, n, 70.0, 280.0);
    env(&mut low, contour);
    add(&mut out, &nrm(low), 0.0, 0.5);
    let mut chips = grains(rng, n, |t| 700.0 * contour(t));
    hp(&mut chips, 2500.0);
    add(&mut out, &nrm(chips), 0.0, 0.25);
    // Dropping into it.
    add(
        &mut out,
        &thump(secs(0.15), 110.0, 55.0, 0.02, 0.03),
        0.0,
        0.6,
    );
    add(&mut out, &rattle(rng, 0.5, 4, 2500.0, 5000.0), 0.05, 0.1);
    out
}

fn mantle(rng: &Rng) -> Vec<f32> {
    let mut out = Vec::new();
    // Hands on the ledge, the body hauled over (cloth), a boot finding the top.
    add(
        &mut out,
        &thump(secs(0.12), 150.0, 72.0, 0.014, 0.022),
        0.0,
        0.8,
    );
    add(
        &mut out,
        &burst(rng, 0.06, 380.0, 2600.0, 0.0006, 0.011),
        0.0,
        0.8,
    );
    add(
        &mut out,
        &burst(rng, 0.05, 420.0, 2900.0, 0.0006, 0.009),
        rng.range(0.03, 0.05),
        0.55,
    );
    add(&mut out, &cloth(rng, 0.36, 260.0, 3400.0, 12.0), 0.05, 0.55);
    add(
        &mut out,
        &scrape(rng, 0.12, 700.0, 4500.0, false),
        0.12,
        0.2,
    );
    add(&mut out, &rattle(rng, 0.25, 3, 2600.0, 5200.0), 0.08, 0.14);
    add(
        &mut out,
        &step(rng, 0.6, 0.8, 1.0),
        rng.range(0.3, 0.34),
        0.7,
    );
    out
}

// ---------------------------------------------------------------------------------------------------------- bullets

fn impact_concrete(rng: &Rng) -> Vec<f32> {
    let mut out = Vec::new();
    // A crack, the wall's knock, chips spraying, dust and grit falling after.
    add(
        &mut out,
        &burst(
            rng,
            0.03,
            rng.range(1600.0, 2200.0),
            13_000.0,
            0.0001,
            0.0028,
        ),
        0.0,
        1.0,
    );
    add(
        &mut out,
        &thump(secs(0.1), rng.range(220.0, 270.0), 125.0, 0.008, 0.016),
        0.0,
        0.7,
    );
    add(
        &mut out,
        &burst(rng, 0.08, 380.0, 1700.0, 0.0003, 0.011),
        0.0,
        0.8,
    );
    add(
        &mut out,
        &grit(rng, 0.3, 2400.0, 9500.0, 2400.0, 0.06),
        0.003,
        0.5,
    );
    let mut fall = grains(rng, secs(0.42), |t| 380.0 * (-t / 0.14).exp());
    hp(&mut fall, 3000.0);
    add(&mut out, &nrm(fall), 0.05, 0.22);
    add(
        &mut out,
        &burst(rng, 0.4, 500.0, 3200.0, 0.012, 0.075),
        0.004,
        0.14,
    );
    out
}

fn impact_metal(rng: &Rng) -> Vec<f32> {
    let f = rng.range(880.0, 1500.0);
    // A plate's inharmonic partials, struck hard: the ping, under a spike and a low clank.
    let ratios = [1.0, 2.32, 3.86, 5.13, 6.94, 9.3, 11.7];
    let modes: Vec<(f32, f32, f32)> = ratios
        .iter()
        .enumerate()
        .map(|(i, r)| {
            (
                f * r * rng.range(0.97, 1.03),
                rng.range(0.07, 0.13) / (1.0 + 0.5 * i as f32),
                1.0 / (1.0 + 0.45 * i as f32),
            )
        })
        .collect();
    let mut out = nrm(modal(secs(0.6), &modes));
    add(
        &mut out,
        &burst(rng, 0.02, 2800.0, 15_000.0, 0.0001, 0.0015),
        0.0,
        0.8,
    );
    add(
        &mut out,
        &knock(rng, rng.range(200.0, 260.0), 16.0),
        0.0,
        0.45,
    );
    add(
        &mut out,
        &grit(rng, 0.08, 4000.0, 12_000.0, 1200.0, 0.02),
        0.002,
        0.12,
    );
    out
}

fn impact_flesh(rng: &Rng) -> Vec<f32> {
    let mut out = thump(secs(0.3), rng.range(150.0, 180.0), 78.0, 0.016, 0.034);
    gain(&mut out, 0.4);
    add(
        &mut out,
        &dburst(rng, 0.14, 240.0, 1900.0, 0.0008, 0.016, 2.0),
        0.0,
        1.0,
    );
    // Wet: a resonant band falling fast.
    let mut wet = white(rng, secs(0.12));
    let f0 = rng.range(1600.0, 2200.0);
    sweep(&mut wet, Kind::Bp, 3.0, |t| 450.0 + f0 * (-t / 0.02).exp());
    env(&mut wet, |t| ad(t, 0.003, 0.026));
    add(&mut out, &nrm(wet), 0.002, 0.4);
    out
}

fn ricochet(rng: &Rng) -> Vec<f32> {
    let n = secs(0.62);
    let f0 = rng.range(2900.0, 4300.0);
    let f1 = f0 * rng.range(0.2, 0.32);
    let (wob, flut, ph) = (rng.range(24.0, 36.0), rng.range(36.0, 52.0), rng.f() * TAU);
    let drop = rng.range(0.13, 0.19);
    // A tumbling bullet whining away: a falling tone and a narrow band of noise on the same path, fluttering.
    let pitch =
        move |t: f32| (f1 + (f0 - f1) * (-t / drop).exp()) * (1.0 + 0.025 * (TAU * wob * t).sin());
    let mut tone = sine(n, pitch);
    let over = sine(n, |t| pitch(t) * 1.52);
    add(&mut tone, &over, 0.0, 0.3);
    let mut hiss = white(rng, n);
    sweep(&mut hiss, Kind::Bp, 14.0, pitch);
    add(&mut tone, &nrm(hiss), 0.0, 0.8);
    env(&mut tone, |t| {
        ad(t, 0.004, 0.15) * (0.72 + 0.28 * (TAU * flut * t + ph).sin())
    });
    let mut out = nrm(tone);
    // The strike that sent it.
    add(
        &mut out,
        &burst(rng, 0.02, 2200.0, 13_000.0, 0.0001, 0.002),
        0.0,
        0.7,
    );
    add(
        &mut out,
        &click(rng, rng.range(1500.0, 2400.0), 9.0, 0.6),
        0.0,
        0.4,
    );
    fade_out(&mut out, 0.08);
    out
}

fn whiz(rng: &Rng) -> Vec<f32> {
    let len = 0.24;
    let pass = rng.range(0.085, 0.1);
    let (f0, f1) = (rng.range(4200.0, 5600.0), rng.range(1000.0, 1500.0));
    // A near miss: a band of air whose pitch falls through the pass (Doppler), loudest as it goes by.
    let pitch = move |t: f32| f1 + (f0 - f1) / (1.0 + ((t - pass) / 0.016).exp());
    let mut x = white(rng, secs(len));
    sweep(&mut x, Kind::Bp, 5.5, pitch);
    env(&mut x, |t| bell(t, pass, 0.04));
    let mut out = nrm(x);
    let mut air = white(rng, secs(len));
    sweep(&mut air, Kind::Bp, 1.2, |t| pitch(t) * 1.9);
    env(&mut air, |t| bell(t, pass, 0.028));
    add(&mut out, &nrm(air), 0.0, 0.35);
    // The bullet's own supersonic snap as it passes.
    add(
        &mut out,
        &burst(rng, 0.01, 3000.0, 15_000.0, 0.0001, 0.0011),
        pass - 0.004,
        0.55,
    );
    fade_in(&mut out, 0.005);
    fade_out(&mut out, 0.03);
    out
}

fn casing(rng: &Rng) -> Vec<f32> {
    let mut out = Vec::new();
    let base = rng.range(3000.0, 4100.0);
    // Brass on concrete: a few bounces, closer and quieter each time, each ringing the tube a little differently.
    let (mut t, mut gap, mut amp) = (0.0f32, rng.range(0.09, 0.14), 1.0f32);
    for k in 0..rng.range(4.0, 6.99) as usize {
        let f = base * rng.range(0.9, 1.1);
        let ring = rng.range(0.012, 0.03) * (1.0 - 0.12 * k as f32);
        let modes = [
            (f, ring, 1.0),
            (f * rng.range(1.52, 1.66), ring * 0.8, rng.range(0.4, 0.9)),
            (f * rng.range(2.2, 2.45), ring * 0.6, rng.range(0.3, 0.7)),
            (f * rng.range(3.2, 3.6), ring * 0.4, rng.range(0.1, 0.4)),
        ];
        let mut ping = nrm(modal(secs(0.25), &modes));
        add(
            &mut ping,
            &burst(rng, 0.006, 2500.0, 9000.0, 0.0001, 0.0008),
            0.0,
            0.35,
        );
        add(&mut out, &ping, t, amp);
        t += gap;
        gap *= rng.range(0.52, 0.68);
        amp *= rng.range(0.5, 0.7);
    }
    // And it settles: a last quick flutter as it rolls flat.
    let f = base * rng.range(1.0, 1.15);
    for k in 0..rng.range(4.0, 7.99) as usize {
        let tick = nrm(modal(
            secs(0.05),
            &[
                (f, 0.006, 1.0),
                (f * 1.6, 0.004, 0.6),
                (f * 2.35, 0.003, 0.4),
            ],
        ));
        add(&mut out, &tick, t, amp * 0.8);
        t += (gap * 0.8f32.powi(k as i32)).max(0.006);
        amp *= 0.72;
    }
    out
}

// --------------------------------------------------------------------------------------------------------- feedback

fn hitmarker(rng: &Rng, head: bool) -> Vec<f32> {
    // A dry "tk": a spike and three very short partials, nothing below 1.5 kHz. The headshot adds a small bell.
    let mut out = nrm(modal(
        secs(0.08),
        &[
            (2450.0, 0.008, 1.0),
            (3700.0, 0.006, 0.7),
            (5350.0, 0.004, 0.45),
        ],
    ));
    add(
        &mut out,
        &burst(rng, 0.008, 2600.0, 12_000.0, 0.0001, 0.001),
        0.0,
        0.7,
    );
    if head {
        let ding = modal(
            secs(0.4),
            &[
                (3136.0, 0.055, 1.0),
                (4698.0, 0.04, 0.55),
                (6272.0, 0.03, 0.35),
                (9400.0, 0.016, 0.2),
            ],
        );
        add(&mut out, &nrm(ding), 0.0, 1.1);
    }
    hp4(&mut out, 1700.0);
    out
}

fn kill_confirm(rng: &Rng) -> Vec<f32> {
    // Low then high: a punch, and 90 ms later a bright fifth ringing out.
    let mut out = thump(secs(0.3), 135.0, 58.0, 0.02, 0.05);
    gain(&mut out, 1.6);
    drive(&mut out, 1.0);
    gain(&mut out, 0.6);
    add(
        &mut out,
        &burst(rng, 0.06, 300.0, 1400.0, 0.0004, 0.012),
        0.0,
        0.6,
    );
    add(&mut out, &hitmarker(rng, false), 0.0, 0.5);
    let at = 0.09;
    let ding = modal(
        secs(0.6),
        &[
            (1975.5, 0.1, 1.0),
            (2963.3, 0.085, 0.75),
            (3951.0, 0.06, 0.4),
            (5926.0, 0.035, 0.22),
            (7902.0, 0.02, 0.1),
        ],
    );
    add(&mut out, &nrm(ding), at, 0.95);
    add(
        &mut out,
        &burst(rng, 0.008, 2500.0, 12_000.0, 0.0001, 0.001),
        at,
        0.5,
    );
    add(
        &mut out,
        &thump(secs(0.15), 190.0, 95.0, 0.012, 0.022),
        at,
        0.45,
    );
    out
}

fn hurt(rng: &Rng) -> Vec<f32> {
    // Taking a round: a body thud, a dull crunch, and the breath it knocks out.
    let mut out = thump(secs(0.4), rng.range(100.0, 116.0), 50.0, 0.025, 0.055);
    gain(&mut out, 1.7);
    drive(&mut out, 1.0);
    gain(&mut out, 0.45);
    add(
        &mut out,
        &dburst(rng, 0.2, 150.0, 950.0, 0.0015, 0.028, 3.0),
        0.0,
        0.9,
    );
    add(
        &mut out,
        &burst(rng, 0.03, 900.0, 4200.0, 0.0003, 0.004),
        0.0,
        0.35,
    );
    add(
        &mut out,
        &burst(rng, 0.2, 500.0, 2400.0, 0.02, 0.045),
        0.02,
        0.12,
    );
    out
}

fn death(rng: &Rng) -> Raw {
    // The world dropping away: a boom, a tone falling into the floor, a wash of noise closing behind it.
    let mut m = thump(secs(1.2), 88.0, 34.0, 0.09, 0.22);
    gain(&mut m, 1.8);
    drive(&mut m, 1.0);
    gain(&mut m, 0.5);
    add(
        &mut m,
        &dburst(rng, 0.2, 140.0, 900.0, 0.001, 0.03, 3.0),
        0.0,
        0.7,
    );
    let n = secs(1.3);
    let fall = |det: f32| {
        // A falling saw, built from its first five harmonics (each a sine with its own integrated phase).
        let mut x = vec![0.0; n];
        for k in 1..=5 {
            let h = sine(n, |t| (62.0 + 250.0 * (-t / 0.3).exp()) * det * k as f32);
            add(&mut x, &h, 0.0, 1.0 / k as f32);
        }
        sweep(&mut x, Kind::Lp, 0.9, |t| {
            180.0 + 2200.0 * (-t / 0.28).exp()
        });
        env(&mut x, |t| ad(t, 0.01, 0.38));
        nrm(x)
    };
    let mut l = fall(0.994);
    let mut r = fall(1.006);
    for side in [&mut l, &mut r] {
        let mut wash = pink(rng, n);
        hp(&mut wash, 180.0);
        sweep(&mut wash, Kind::Lp, 0.7, |t| {
            150.0 + 3200.0 * (-t / 0.25).exp()
        });
        env(&mut wash, |t| ad(t, 0.004, 0.3));
        add(side, &nrm(wash), 0.0, 0.5);
        gain(side, 0.8);
        fade_out(side, 0.2);
    }
    Raw { mono: m, l, r }
}

fn low_health() -> Vec<f32> {
    // One heartbeat, lub-dub: two soft low thumps, each with a muffled knock above it so the beat still reads on
    // speakers that cannot play the low part.
    let rng = Rng::new(11);
    let mut out = Vec::new();
    for (at, f0, amp) in [(0.0, 92.0, 1.0), (0.155, 80.0, 0.72)] {
        let mut b = thump(secs(0.3), f0, f0 * 0.6, 0.018, 0.04);
        gain(&mut b, 2.2);
        drive(&mut b, 1.0);
        gain(&mut b, 0.6);
        add(
            &mut b,
            &dburst(&rng, 0.12, 110.0, 420.0, 0.003, 0.022, 2.0),
            0.0,
            1.0,
        );
        lp(&mut b, 900.0);
        add(&mut out, &nrm(b), at, amp);
    }
    out
}

fn medal(rng: &Rng) -> Raw {
    // A quick bright arpeggio (E major, up), alternating sides, with a little air on top.
    let notes = [
        (0.0, 987.77),
        (0.055, 1318.51),
        (0.11, 1661.22),
        (0.165, 1975.53),
        (0.24, 2637.02),
    ];
    let (mut l, mut r) = (Vec::new(), Vec::new());
    for (i, &(at, hz)) in notes.iter().enumerate() {
        let last = i == notes.len() - 1;
        let mut n = chime(hz, 0.7, if last { 0.16 } else { 0.09 });
        add(&mut n, &pluck(hz, 0.3, 0.05, 0.9), 0.0, 0.5);
        let pan = if i % 2 == 0 { 0.35 } else { 0.65 };
        let amp = 0.7 + 0.08 * i as f32;
        add(&mut l, &n, at, amp * (1.0 - pan) * 1.4);
        add(&mut r, &n, at, amp * pan * 1.4);
    }
    let air = burst(rng, 0.3, 6000.0, 14_000.0, 0.02, 0.07);
    add(&mut l, &air, 0.2, 0.06);
    add(&mut r, &air, 0.207, 0.06);
    space(&mut l, &mut r, 0.9, 7000.0, 0.16, 0.25);
    Raw {
        mono: Vec::new(),
        l,
        r,
    }
}

// ---------------------------------------------------------------------------------------------------------- grenade

fn nade_pin(rng: &Rng) -> Vec<f32> {
    let mut out = Vec::new();
    // The ring twisting out with a thin "shing", then the spoon flying off.
    let mut pull = scrape(rng, 0.045, 3000.0, 11_000.0, true);
    hp(&mut pull, 3000.0);
    add(&mut out, &pull, 0.0, 0.4);
    let f = rng.range(4000.0, 4700.0);
    let ring = modal(
        secs(0.4),
        &[
            (f, 0.045, 1.0),
            (f * 1.55, 0.032, 0.7),
            (f * 2.13, 0.022, 0.45),
            (f * 2.9, 0.012, 0.2),
        ],
    );
    add(&mut out, &nrm(ring), 0.044, 0.8);
    add(
        &mut out,
        &burst(rng, 0.006, 4000.0, 14_000.0, 0.0001, 0.0008),
        0.044,
        0.4,
    );
    let at = rng.range(0.13, 0.16);
    add(
        &mut out,
        &click(rng, rng.range(2000.0, 2400.0), 14.0, 0.8),
        at,
        0.7,
    );
    add(&mut out, &knock(rng, 900.0, 5.0), at, 0.25);
    out
}

fn nade_throw(rng: &Rng) -> Vec<f32> {
    let top = rng.range(850.0, 1200.0);
    let mut out = whoosh(rng, 0.34, 1.3, 0.14, 0.075, |t| {
        280.0 + top * bell(t, 0.15, 0.08)
    });
    add(&mut out, &cloth(rng, 0.3, 300.0, 3600.0, 14.0), 0.0, 0.45);
    add(&mut out, &rattle(rng, 0.2, 2, 2800.0, 5000.0), 0.05, 0.08);
    out
}

fn nade_bounce(rng: &Rng) -> Vec<f32> {
    // A cast-iron egg on concrete: a short hollow clunk, a knock from the floor, a few chips.
    let f = rng.range(700.0, 880.0);
    let body = modal(
        secs(0.3),
        &[
            (f, 0.04, 1.0),
            (f * 1.83, 0.028, 0.7),
            (f * 2.91, 0.018, 0.5),
            (f * 3.96, 0.011, 0.3),
            (f * 5.6, 0.006, 0.15),
        ],
    );
    let mut out = nrm(body);
    add(
        &mut out,
        &burst(rng, 0.012, 1800.0, 9000.0, 0.0001, 0.0014),
        0.0,
        0.6,
    );
    add(
        &mut out,
        &thump(secs(0.1), rng.range(190.0, 220.0), 105.0, 0.01, 0.017),
        0.0,
        0.7,
    );
    add(
        &mut out,
        &grit(rng, 0.09, 2400.0, 8000.0, 1500.0, 0.02),
        0.003,
        0.18,
    );
    out
}

// ------------------------------------------------------------------------------------------------------ UI and match

/// Soft sine blips `(at s, Hz, decay s)` with a second harmonic and a faint click.
fn ui_blips(notes: &[(f32, f32, f32)], click_amt: f32) -> Vec<f32> {
    let mut out = Vec::new();
    let rng = Rng::new(7);
    for &(at, hz, d) in notes {
        let mut b = modal(
            secs(d * 8.0),
            &[
                (hz, d, 1.0),
                (hz * 2.0, d * 0.6, 0.22),
                (hz * 3.0, d * 0.4, 0.07),
            ],
        );
        fade_in(&mut b, 0.002);
        add(&mut out, &nrm(b), at, 1.0);
        add(
            &mut out,
            &burst(&rng, 0.004, 3500.0, 9000.0, 0.0002, 0.0006),
            at,
            click_amt,
        );
    }
    out
}

fn tone(len: f32, partials: &[(f32, f32)], a: f32, hold: f32, rel: f32) -> Vec<f32> {
    let n = secs(len);
    let mut out = vec![0.0; n];
    for &(hz, amp) in partials {
        let s = sine(n, |_| hz);
        add(&mut out, &s, 0.0, amp);
    }
    env(&mut out, |t| {
        if t < a {
            t / a
        } else if t < a + hold {
            1.0
        } else {
            (-(t - a - hold) / rel).exp()
        }
    });
    fade_out(&mut out, 0.01);
    nrm(out)
}

fn count_beep() -> Vec<f32> {
    tone(
        0.3,
        &[(880.0, 1.0), (1760.0, 0.28), (2640.0, 0.1), (3520.0, 0.04)],
        0.003,
        0.075,
        0.025,
    )
}

fn count_go(rng: &Rng) -> Raw {
    // The beep's octave as a chord, longer, with a hit under it and air over it.
    let mut m = tone(
        0.75,
        &[
            (880.0, 0.6),
            (1318.5, 0.5),
            (1760.0, 1.0),
            (2637.0, 0.3),
            (3520.0, 0.2),
        ],
        0.003,
        0.09,
        0.12,
    );
    let mut sub = thump(secs(0.3), 150.0, 62.0, 0.03, 0.06);
    gain(&mut sub, 1.6);
    drive(&mut sub, 1.0);
    add(&mut m, &sub, 0.0, 0.6);
    let (mut l, mut r) = (Vec::new(), Vec::new());
    add(
        &mut l,
        &burst(rng, 0.4, 3000.0, 12_000.0, 0.004, 0.07),
        0.0,
        0.16,
    );
    add(
        &mut r,
        &burst(rng, 0.4, 3000.0, 12_000.0, 0.004, 0.07),
        0.0,
        0.16,
    );
    add(&mut l, &m, 0.0, 0.3);
    add(&mut r, &m, 0.0, 0.3);
    space(&mut l, &mut r, 0.8, 6000.0, 0.5, 0.3);
    Raw { mono: m, l, r }
}

fn respawn(rng: &Rng) -> Raw {
    // Back in: air rushing up into a soft rising fifth, and a small bell where it lands.
    let len = 0.5;
    let (mut l, mut r) = (Vec::new(), Vec::new());
    for side in [&mut l, &mut r] {
        let w = whoosh(rng, len, 1.6, 0.4, 0.14, |t| {
            260.0 * (1.0 + 28.0 * (t / 0.45).powi(3))
        });
        add(side, &w, 0.0, 0.5);
    }
    let n = secs(0.52);
    let mut rise = sine(n, |t| 330.0 * (1.0 + (t / 0.45).min(1.0).powi(2)));
    let fifth = sine(n, |t| 495.0 * (1.0 + (t / 0.45).min(1.0).powi(2)));
    add(&mut rise, &fifth, 0.0, 0.6);
    env(&mut rise, |t| {
        smoothstep(0.0, 0.4, t) * smoothstep(0.52, 0.44, t)
    });
    let land = chime(1318.5, 0.6, 0.12);
    let mut m = Vec::new();
    add(&mut m, &nrm(rise), 0.0, 0.45);
    add(&mut m, &land, 0.44, 0.8);
    add(&mut m, &chime(1975.5, 0.5, 0.1), 0.47, 0.4);
    add(&mut l, &m, 0.0, 0.5);
    add(&mut r, &m, 0.0, 0.5);
    space(&mut l, &mut r, 0.9, 6500.0, 0.35, 0.3);
    Raw { mono: m, l, r }
}

fn lead(taken: bool) -> Raw {
    // Two notes: up a fifth and bright when the lead is taken, down a tritone and duller when it is lost.
    let (a, b, bright, tau) = if taken {
        (659.26, 987.77, 0.9, 0.11)
    } else {
        (493.88, 349.23, 0.3, 0.13)
    };
    let mut m = Vec::new();
    add(&mut m, &pluck(a, 0.5, tau, bright), 0.0, 0.85);
    add(&mut m, &pluck(b, 0.7, tau * 1.4, bright), 0.11, 1.0);
    if taken {
        add(&mut m, &chime(b * 2.0, 0.5, 0.09), 0.11, 0.35);
    } else {
        add(&mut m, &pluck(b * 0.5, 0.6, 0.12, 0.2), 0.11, 0.5);
        lp(&mut m, 3200.0);
    }
    let (mut l, mut r) = (m.clone(), m.clone());
    gain(&mut l, 0.4);
    gain(&mut r, 0.4);
    space(
        &mut l,
        &mut r,
        0.8,
        if taken { 7000.0 } else { 3500.0 },
        0.5,
        0.3,
    );
    Raw { mono: m, l, r }
}

/// Bakes a little room into a stereo pair: `wet` of an FDN with the given `rt60` and damping, plus `tail` seconds
/// for it to ring out.
fn space(l: &mut Vec<f32>, r: &mut Vec<f32>, rt60: f32, damp_hz: f32, wet: f32, tail: f32) {
    let n = l.len().max(r.len()) + secs(tail);
    l.resize(n, 0.0);
    r.resize(n, 0.0);
    let mut rev = Reverb::new(rt60, damp_hz, 0.012, 0.8);
    for i in 0..n {
        let (wl, wr) = rev.tick(l[i], r[i]);
        l[i] += wl * wet;
        r[i] += wr * wet;
    }
    fade_out(l, tail * 0.6);
    fade_out(r, tail * 0.6);
}

/// One synth note of a stinger.
struct Note {
    at: f32,
    dur: f32,
    hz: f32,
    vel: f32,
}

/// A detuned-saw pad or brass section: every note is four saws, two a side, through a swept low-pass.
fn saws(
    rng: &Rng,
    notes: &[Note],
    len: f32,
    detune: f32,
    attack: f32,
    release: f32,
    cutoff: impl Fn(f32) -> f32 + Copy,
) -> (Vec<f32>, Vec<f32>) {
    let n = secs(len);
    let (mut l, mut r) = (vec![0.0; n], vec![0.0; n]);
    for note in notes {
        let nn = secs(note.dur + release * 5.0).min(n.saturating_sub(secs(note.at)));
        for k in 0..4 {
            let cents = detune * [-1.0, 0.6, -0.45, 1.0][k] * rng.range(0.8, 1.2);
            let mut s = saw(nn, note.hz * 2f32.powf(cents / 1200.0), rng.f());
            env(&mut s, |t| {
                let a = (t / attack).min(1.0);
                if t < note.dur {
                    a
                } else {
                    a * (-(t - note.dur) / release).exp()
                }
            });
            add(
                if k % 2 == 0 { &mut l } else { &mut r },
                &s,
                note.at,
                note.vel * 0.5,
            );
        }
    }
    l.truncate(n);
    r.truncate(n);
    sweep(&mut l, Kind::Lp, 1.1, cutoff);
    sweep(&mut r, Kind::Lp, 1.1, cutoff);
    fade_out(&mut l, 0.08);
    fade_out(&mut r, 0.08);
    (l, r)
}

fn victory(rng: &Rng) -> Raw {
    // D major. A three-note brass pickup (A, D, F#) into a full chord with the fifth on top, timpani under the
    // downbeat, a cymbal swelling into it and bells running up it.
    const HIT: f32 = 0.45;
    let n = |at: f32, dur: f32, hz: f32, vel: f32| Note { at, dur, hz, vel };
    let hold = 1.2;
    let notes = [
        n(0.0, 0.12, 440.0, 0.9),
        n(0.0, 0.12, 220.0, 0.6),
        n(0.15, 0.12, 587.33, 0.9),
        n(0.15, 0.12, 293.66, 0.6),
        n(0.30, 0.12, 739.99, 0.95),
        n(0.30, 0.12, 369.99, 0.6),
        n(HIT, hold, 880.0, 1.0),
        n(HIT, hold, 587.33, 0.7),
        n(HIT, hold, 440.0, 0.7),
        n(HIT, hold, 369.99, 0.7),
        n(HIT, hold, 293.66, 0.75),
        n(HIT, hold, 220.0, 0.7),
        n(HIT, hold, 146.83, 0.8),
        n(HIT, hold, 73.42, 0.9),
    ];
    let cutoff = |t: f32| {
        if t < HIT {
            1500.0 + 1400.0 * (t / HIT)
        } else {
            2000.0 + 4200.0 * ad(t - HIT, 0.12, 0.7)
        }
    };
    let (mut l, mut r) = saws(rng, &notes, 2.35, 9.0, 0.012, 0.13, cutoff);
    gain(&mut l, 0.5);
    gain(&mut r, 0.5);
    // Timpani: a soft stroke on the pickup, the full one on the downbeat.
    for (at, amp) in [(0.0, 0.35), (HIT, 1.0)] {
        let mut t = thump(secs(0.9), 104.0, 73.42, 0.03, 0.2);
        add(
            &mut t,
            &burst(rng, 0.12, 90.0, 900.0, 0.001, 0.02),
            0.0,
            0.6,
        );
        gain(&mut t, 1.5);
        drive(&mut t, 1.0);
        add(&mut l, &t, at, amp * 0.8);
        add(&mut r, &t, at, amp * 0.8);
    }
    // The cymbal: noise swelling into the downbeat and washing out after it.
    for side in [&mut l, &mut r] {
        let mut c = band(rng, secs(2.0), 4500.0, 15_000.0);
        env(&mut c, |t| {
            if t < HIT {
                ((t - HIT) / 0.09).exp() * 0.8
            } else {
                (-(t - HIT) / 0.4).exp()
            }
        });
        add(side, &c, 0.0, 0.5);
    }
    // Bells up the chord.
    for (i, hz) in [1174.66, 1479.98, 1760.0, 2349.32].into_iter().enumerate() {
        let b = chime(hz, 0.9, 0.2);
        let at = HIT + 0.07 * i as f32;
        add(&mut l, &b, at, if i % 2 == 0 { 0.22 } else { 0.09 });
        add(&mut r, &b, at, if i % 2 == 0 { 0.09 } else { 0.22 });
    }
    space(&mut l, &mut r, 1.5, 6500.0, 0.3, 0.45);
    Raw {
        mono: Vec::new(),
        l,
        r,
    }
}

fn defeat(rng: &Rng) -> Raw {
    // D minor, falling: i, VI, and a V left hanging, on dark detuned saws whose filter closes; a boom at the start.
    let n = |at: f32, dur: f32, hz: f32, vel: f32| Note { at, dur, hz, vel };
    let notes = [
        // i: D minor, A on top.
        n(0.0, 0.72, 73.42, 1.0),
        n(0.0, 0.72, 110.0, 0.7),
        n(0.0, 0.72, 146.83, 0.7),
        n(0.0, 0.72, 174.61, 0.7),
        n(0.0, 0.36, 440.0, 0.6),
        n(0.38, 0.34, 349.23, 0.6),
        // VI: B flat, D on top.
        n(0.75, 0.52, 58.27, 1.0),
        n(0.75, 0.52, 116.54, 0.7),
        n(0.75, 0.52, 174.61, 0.7),
        n(0.75, 0.52, 233.08, 0.6),
        n(0.75, 0.52, 293.66, 0.6),
        // V: A, with its leading tone on top and nowhere to go.
        n(1.3, 0.62, 55.0, 1.0),
        n(1.3, 0.62, 82.41, 0.8),
        n(1.3, 0.62, 138.59, 0.7),
        n(1.3, 0.62, 164.81, 0.7),
        n(1.3, 0.62, 277.18, 0.65),
    ];
    let cutoff = |t: f32| {
        240.0
            + 1700.0 * (-t / 1.1).exp()
            + 500.0 * ad(t - 1.3, 0.05, 0.3) * if t > 1.3 { 1.0 } else { 0.0 }
    };
    let (mut l, mut r) = saws(rng, &notes, 2.5, 16.0, 0.035, 0.16, cutoff);
    gain(&mut l, 0.6);
    gain(&mut r, 0.6);
    let mut boom = thump(secs(1.6), 64.0, 34.0, 0.1, 0.34);
    add(
        &mut boom,
        &burst(rng, 0.4, 60.0, 500.0, 0.002, 0.07),
        0.0,
        0.7,
    );
    gain(&mut boom, 1.7);
    drive(&mut boom, 1.0);
    add(&mut l, &boom, 0.0, 0.9);
    add(&mut r, &boom, 0.0, 0.9);
    // Each change lands with a low knock.
    for at in [0.75, 1.3] {
        let k = thump(secs(0.5), 80.0, 42.0, 0.04, 0.1);
        add(&mut l, &k, at, 0.4);
        add(&mut r, &k, at, 0.4);
    }
    for side in [&mut l, &mut r] {
        let mut wind = pink(rng, secs(2.4));
        hp(&mut wind, 300.0);
        sweep(&mut wind, Kind::Lp, 0.7, |t| {
            300.0 + 2600.0 * (-t / 0.8).exp()
        });
        env(&mut wind, |t| smoothstep(0.0, 0.05, t) * (-t / 0.9).exp());
        add(side, &wind, 0.0, 0.5);
    }
    space(&mut l, &mut r, 1.9, 3200.0, 0.34, 0.5);
    Raw {
        mono: Vec::new(),
        l,
        r,
    }
}
