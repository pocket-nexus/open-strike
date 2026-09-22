//! Bounded frame intervals, queried on demand instead of logging during play.
const SAMPLES: usize = 360;
pub struct FrameTimes {
    samples: [u32; SAMPLES],
    next: usize,
    count: usize,
    previous: u64,
}
impl FrameTimes {
    pub const fn new() -> Self {
        Self {
            samples: [0; SAMPLES],
            next: 0,
            count: 0,
            previous: 0,
        }
    }
    pub fn pause(&mut self) {
        self.previous = 0;
    }
    pub fn record(&mut self, now: u64) {
        if self.previous != 0 {
            self.samples[self.next] = now.saturating_sub(self.previous).min(u32::MAX as u64) as u32;
            self.next = (self.next + 1) % SAMPLES;
            self.count = (self.count + 1).min(SAMPLES);
        }
        self.previous = now;
    }
    pub fn summary(&self) -> [f64; 6] {
        if self.count == 0 {
            return [0.; 6];
        }
        let mut sorted = self.samples;
        let values = &mut sorted[..self.count];
        values.sort_unstable();
        let total = values.iter().map(|n| *n as u64).sum::<u64>();
        [
            self.count as f64,
            if total == 0 {
                0.
            } else {
                1_000_000. * self.count as f64 / total as f64
            },
            values[(self.count - 1) * 95 / 100] as f64 / 1000.,
            values[(self.count - 1) * 99 / 100] as f64 / 1000.,
            values[self.count - 1] as f64 / 1000.,
            values.iter().filter(|n| **n > 20_000).count() as f64,
        ]
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn bounded_window_excludes_loads_and_expires_old_stalls() {
        let mut f = FrameTimes::new();
        f.record(1);
        f.record(50_001);
        assert_eq!(f.summary()[5], 1.);
        f.pause();
        f.record(5_000_000);
        assert_eq!(f.summary()[0], 1.);
        for n in 1..=SAMPLES {
            f.record(5_000_000 + n as u64 * 16_667);
        }
        let s = f.summary();
        assert_eq!(s[0], SAMPLES as f64);
        assert_eq!(s[5], 0.);
        assert!((s[1] - 60.).abs() < 0.01);
    }
}
