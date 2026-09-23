//! Touch wire values -> the shared simulation's mouse-count and button units.
use openstrike_core::sim::{SimInput, MOUSE_SENS};

#[derive(Default)]
pub struct TouchInput {
    pub held: SimInput,
    pub buttons: i32,
    look: [f32; 2],
    reload: bool,
    jump: bool,
}
impl TouchInput {
    pub fn update(&mut self, x: i32, y: i32, buttons: i32, dx: i32, dy: i32) {
        self.held.move_x = x.clamp(-1000, 1000) as f32 / 1000.;
        self.held.move_y = y.clamp(-1000, 1000) as f32 / 1000.;
        self.held.fire = buttons & 1 != 0;
        self.held.walk = buttons & 8 != 0;
        self.reload |= buttons & 2 != 0 && self.buttons & 2 == 0;
        self.jump |= buttons & 4 != 0 && self.buttons & 4 == 0;
        self.buttons = buttons & 15;
        // The JS wire carries 1/1024 logical pixels. apply_look accepts mouse
        // counts and applies MOUSE_SENS itself; convert exactly once.
        for (axis, delta) in [dx, dy].into_iter().enumerate() {
            self.look[axis] += delta.clamp(-491520, 491520) as f32 / 1024. * 0.005 / MOUSE_SENS;
        }
    }
    pub fn take_look(&mut self) -> [f32; 2] {
        core::mem::replace(&mut self.look, [0.; 2])
    }
    pub fn tick(&mut self) -> SimInput {
        let mut input = self.held;
        input.reload = core::mem::take(&mut self.reload);
        input.jump = core::mem::take(&mut self.jump);
        input
    }
    pub fn clear(&mut self) {
        *self = Self::default();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use openstrike_core::StrikeSim;
    #[test]
    fn touch_distance_reaches_simulation_once_with_mouse_direction() {
        for samples in [1, 20, 30, 60, 120] {
            let mut input = TouchInput::default();
            let mut sim = StrikeSim::new(glam::Vec3::ZERO, 0., alloc::vec![], 0);
            for _ in 0..samples {
                input.update(0, 0, 0, 120 * 1024 / samples, -60 * 1024 / samples);
                let look = input.take_look();
                sim.apply_look(look[0], look[1]);
            }
            assert!((sim.player.yaw + 0.6).abs() < 0.00001);
            assert!((sim.player.pitch - 0.3).abs() < 0.00001);
            assert_eq!(input.take_look(), [0.; 2]);
        }
    }
    #[test]
    fn subframe_release_keeps_one_reload_and_jump_but_no_held_fire() {
        let mut input = TouchInput::default();
        input.update(0, 1000, 7, 0, 0);
        input.update(0, 1000, 0, 0, 0);
        let first = input.tick();
        assert!(first.reload && first.jump && !first.fire);
        assert_eq!(first.move_y, 1.);
        let second = input.tick();
        assert!(!second.reload && !second.jump);
        input.update(0, 0, 4, 0, 0);
        assert!(input.tick().jump);
        input.update(0, 0, 4, 0, 0);
        assert!(!input.tick().jump);
    }
    #[test]
    fn pause_clears_motion_look_and_pending_edges() {
        let mut input = TouchInput::default();
        input.update(1000, 1000, 15, 1000, 1000);
        input.clear();
        let tick = input.tick();
        assert_eq!((tick.move_x, tick.move_y, input.buttons), (0., 0., 0));
        assert!(!tick.fire && !tick.reload && !tick.jump && !tick.walk);
        assert_eq!(input.take_look(), [0.; 2]);
    }
}
