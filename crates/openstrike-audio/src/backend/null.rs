//! No device: the mixer still runs in real time when its output is being captured to a WAV.

use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};

use crate::{Engine, SAMPLE_RATE, Shared};

/// Mixes at the wall clock's pace (into the capture; nothing is played) until `shared.stop`.
pub(crate) fn run(engine: &mut Engine, shared: &Shared) {
    let start = Instant::now();
    let mut done = 0u64;
    let mut buf = [0.0f32; 960];
    while !shared.stop.load(Ordering::Acquire) {
        let due = (start.elapsed().as_secs_f64() * SAMPLE_RATE as f64) as u64;
        // After a long stall (the process was suspended) skip ahead instead of mixing minutes of silence.
        done = done.max(due.saturating_sub(SAMPLE_RATE as u64));
        while done < due {
            let n = ((due - done) as usize).min(buf.len() / 2);
            engine.render(&mut buf[..n * 2]);
            done += n as u64;
        }
        std::thread::park_timeout(Duration::from_millis(5));
    }
}
