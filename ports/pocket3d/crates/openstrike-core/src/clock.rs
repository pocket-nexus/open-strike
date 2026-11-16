//! Wall-clock accumulation for hosts that render independently of simulation.

pub const TICK_HZ: u64 = 60;
pub const TICK_SECONDS: f32 = 1.0 / TICK_HZ as f32;
pub const MAX_CATCH_UP_TICKS: u32 = 4;

/// Integer microseconds avoid cumulative 16,666/16,667-us rounding drift.
/// Long stalls discard excess debt; loading a world resets the clock.
pub struct FixedClock {
    previous_us: u64,
    phase: u64,
}

impl FixedClock {
    pub fn new(now_us: u64) -> Self {
        Self {
            previous_us: now_us,
            phase: 0,
        }
    }

    pub fn reset(&mut self, now_us: u64) {
        self.previous_us = now_us;
        self.phase = 0;
    }

    pub fn advance(&mut self, now_us: u64) -> u32 {
        let elapsed = now_us.saturating_sub(self.previous_us);
        self.previous_us = now_us;
        self.phase = self.phase.saturating_add(elapsed.saturating_mul(TICK_HZ));
        let due = self.phase / 1_000_000;
        self.phase %= 1_000_000;
        due.min(MAX_CATCH_UP_TICKS as u64) as u32
    }

    pub fn alpha(&self) -> f32 {
        self.phase as f32 / 1_000_000.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use glam::Vec3;
    use pocket3d_bsp::collide::{
        CharacterState, HullKind, MoveInput, MoveParams, Trace, TraceWorld, step_character,
    };

    struct Floor;
    impl TraceWorld for Floor {
        fn trace(&self, _: HullKind, start: Vec3, end: Vec3) -> Trace {
            let fraction = if end.y < 0.0 {
                (start.y / (start.y - end.y)).clamp(0.0, 1.0)
            } else {
                1.0
            };
            Trace {
                fraction,
                end: start.lerp(end, fraction),
                normal: Vec3::Y,
                start_solid: false,
            }
        }
    }

    fn motion(fps: u64) -> (Vec3, u32, f32) {
        let mut clock = FixedClock::new(0);
        let mut state = CharacterState {
            pos: Vec3::ZERO,
            vel: Vec3::ZERO,
            on_ground: true,
        };
        let mut ticks = 0;
        let mut landed = 0;
        let mut peak = 0.0f32;
        for frame in 1..=fps * 2 {
            for _ in 0..clock.advance(frame * 1_000_000 / fps) {
                let input = MoveInput {
                    wish_dir: Vec3::X,
                    speed: 1.0,
                    jump: ticks == 0,
                };
                step_character(
                    &Floor,
                    HullKind::Stand,
                    &mut state,
                    &MoveParams::default(),
                    &input,
                    TICK_SECONDS,
                );
                ticks += 1;
                peak = peak.max(state.pos.y);
                if state.on_ground && landed == 0 {
                    landed = ticks;
                }
            }
        }
        (state.pos, landed, peak)
    }

    #[test]
    fn real_character_movement_and_jump_match_at_20_30_and_60_fps() {
        let expected = motion(60);
        assert!(expected.0.x > 300.0);
        assert!((30..50).contains(&expected.1));
        assert!((35.0..50.0).contains(&expected.2));
        for fps in [20, 30, 120] {
            assert_eq!(motion(fps), expected, "{fps} FPS");
        }
    }

    #[test]
    fn simulation_time_is_independent_of_render_rate() {
        for fps in [20, 30, 60, 90, 120] {
            let mut clock = FixedClock::new(0);
            let mut ticks = 0;
            for frame in 1..=fps * 10 {
                ticks += clock.advance(frame * 1_000_000 / fps);
                assert!((0.0..1.0).contains(&clock.alpha()));
            }
            assert_eq!(ticks, 600, "{fps} FPS");
        }
    }

    #[test]
    fn jitter_keeps_fractional_time_without_drift() {
        let mut clock = FixedClock::new(100);
        let mut now = 100;
        let mut ticks = 0;
        for dt in [11_000, 22_333, 50_000, 16_667]
            .into_iter()
            .cycle()
            .take(400)
        {
            now += dt;
            ticks += clock.advance(now);
        }
        assert_eq!(ticks, 600);
    }

    #[test]
    fn suspend_and_map_load_do_not_cause_unbounded_catch_up() {
        let mut clock = FixedClock::new(0);
        assert_eq!(clock.advance(5_000_000), MAX_CATCH_UP_TICKS);
        assert_eq!(clock.advance(5_000_000), 0);
        clock.reset(10_000_000);
        assert_eq!(clock.advance(10_016_667), 1);
        assert_eq!(clock.advance(1), 0);
    }
}
