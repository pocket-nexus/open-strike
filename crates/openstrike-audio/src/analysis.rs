//! Measurements for the tests and the demo's report: an FFT, band energies, a spectral centroid, level and length.
//! Not part of the game-facing API.

use std::f32::consts::TAU;

use crate::SAMPLE_RATE;

/// In-place radix-2 FFT (`re.len()` a power of two).
pub fn fft(re: &mut [f32], im: &mut [f32]) {
    let n = re.len();
    assert!(n.is_power_of_two() && im.len() == n);
    let mut j = 0;
    for i in 1..n {
        let mut bit = n >> 1;
        while j & bit != 0 {
            j ^= bit;
            bit >>= 1;
        }
        j |= bit;
        if i < j {
            re.swap(i, j);
            im.swap(i, j);
        }
    }
    let mut len = 2;
    while len <= n {
        let ang = -TAU / len as f32;
        for start in (0..n).step_by(len) {
            for k in 0..len / 2 {
                let (s, c) = (ang * k as f32).sin_cos();
                let (a, b) = (start + k, start + k + len / 2);
                let (tr, ti) = (re[b] * c - im[b] * s, re[b] * s + im[b] * c);
                re[b] = re[a] - tr;
                im[b] = im[a] - ti;
                re[a] += tr;
                im[a] += ti;
            }
        }
        len <<= 1;
    }
}

/// The power spectrum of a mono signal, summed over Hann-windowed frames of `size`: bin k is k * 48000 / size Hz.
pub fn spectrum(x: &[f32], size: usize) -> Vec<f64> {
    let mut acc = vec![0.0f64; size / 2 + 1];
    let window: Vec<f32> = (0..size)
        .map(|i| 0.5 - 0.5 * (TAU * i as f32 / size as f32).cos())
        .collect();
    let hop = size / 2;
    let mut start = 0;
    loop {
        let mut re = vec![0.0f32; size];
        let mut im = vec![0.0f32; size];
        for i in 0..size {
            re[i] = x.get(start + i).copied().unwrap_or(0.0) * window[i];
        }
        fft(&mut re, &mut im);
        for (k, a) in acc.iter_mut().enumerate() {
            *a += (re[k] as f64).powi(2) + (im[k] as f64).powi(2);
        }
        start += hop;
        if start >= x.len() {
            break;
        }
    }
    acc
}

/// Energy between `lo` and `hi` Hz of a `spectrum`.
pub fn band(spec: &[f64], lo: f32, hi: f32) -> f64 {
    let size = (spec.len() - 1) * 2;
    let hz = SAMPLE_RATE as f32 / size as f32;
    spec.iter()
        .enumerate()
        .filter(|(k, _)| (*k as f32 * hz) >= lo && (*k as f32 * hz) < hi)
        .map(|(_, e)| *e)
        .sum()
}

/// The spectral centroid of a `spectrum`, Hz.
pub fn centroid(spec: &[f64]) -> f32 {
    let size = (spec.len() - 1) * 2;
    let hz = SAMPLE_RATE as f64 / size as f64;
    let total: f64 = spec.iter().sum();
    if total <= 0.0 {
        return 0.0;
    }
    (spec
        .iter()
        .enumerate()
        .map(|(k, e)| k as f64 * hz * e)
        .sum::<f64>()
        / total) as f32
}

/// Interleaved stereo to (left, right).
pub fn split(stereo: &[f32]) -> (Vec<f32>, Vec<f32>) {
    (
        stereo.iter().step_by(2).copied().collect(),
        stereo.iter().skip(1).step_by(2).copied().collect(),
    )
}

/// Interleaved stereo to mono (the mean).
pub fn mono(stereo: &[f32]) -> Vec<f32> {
    stereo
        .chunks_exact(2)
        .map(|f| 0.5 * (f[0] + f[1]))
        .collect()
}

pub fn peak(x: &[f32]) -> f32 {
    x.iter().fold(0.0f32, |m, v| m.max(v.abs()))
}

pub fn rms(x: &[f32]) -> f32 {
    if x.is_empty() {
        return 0.0;
    }
    (x.iter().map(|v| (*v as f64).powi(2)).sum::<f64>() / x.len() as f64).sqrt() as f32
}

pub fn db(x: f32) -> f32 {
    20.0 * x.max(1e-10).log10()
}

/// RMS per 10 ms of a mono signal.
pub fn envelope(x: &[f32]) -> Vec<f32> {
    x.chunks(SAMPLE_RATE as usize / 100).map(rms).collect()
}

/// Seconds from the first 10 ms window above `floor_db` (relative to the loudest window) to the last one: how long
/// a sound is, as heard.
pub fn duration(x: &[f32], floor_db: f32) -> f32 {
    let env = envelope(x);
    let top = env.iter().fold(0.0f32, |m, v| m.max(*v));
    let floor = top * 10f32.powf(floor_db / 20.0);
    let first = env.iter().position(|v| *v > floor);
    let last = env.iter().rposition(|v| *v > floor);
    match (first, last) {
        (Some(a), Some(b)) => (b + 1 - a) as f32 * 0.01,
        _ => 0.0,
    }
}

/// The perceived-level measure the bank is normalized with (dB), on a mono signal.
pub fn loudness(x: &[f32]) -> f32 {
    crate::bank::loudness(x)
}
