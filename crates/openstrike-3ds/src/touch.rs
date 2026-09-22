//! Touch levels and queued edges are independent of the physical pad.
//! A press/release inside one guest turn must still deliver one reload.
use crate::input::TickInput;

#[derive(Default)]
pub struct TouchInput {
    buttons: u32,
    reload: bool,
    look: [f32; 2],
}
impl TouchInput {
    pub const fn new() -> Self {
        Self {
            buttons: 0,
            reload: false,
            look: [0.; 2],
        }
    }
    pub fn update(&mut self, buttons: u32, x: f32, y: f32) {
        self.reload |= buttons & 2 != 0 && self.buttons & 2 == 0;
        self.buttons = buttons & 15;
        if x.is_finite() && y.is_finite() {
            self.look[0] += x.clamp(-320., 320.);
            self.look[1] += y.clamp(-240., 240.);
        }
    }
    pub fn apply(&mut self, tick: &mut TickInput) {
        tick.sim.fire |= self.buttons & 1 != 0;
        tick.sim.reload |= core::mem::take(&mut self.reload);
        tick.sim.jump |= self.buttons & 4 != 0;
        tick.sim.walk |= self.buttons & 8 != 0;
        // One lower-screen width turns about 110 degrees.
        tick.look_dx += self.look[0] * 0.006 / openstrike_core::sim::MOUSE_SENS;
        tick.look_dy += self.look[1] * 0.006 / openstrike_core::sim::MOUSE_SENS;
        self.look = [0.; 2];
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::input::{map, PadInput};
    fn idle() -> TickInput {
        map(&mut PadInput::new(), 0, 0x8080, 0x8080, 1. / 60.)
    }
    #[test]
    fn release_retains_reload_edge_but_clears_holds() {
        let mut touch = TouchInput::default();
        touch.update(15, 0., 0.);
        touch.update(0, 0., 0.);
        let mut tick = idle();
        touch.apply(&mut tick);
        assert!(tick.sim.reload);
        assert!(!tick.sim.fire && !tick.sim.jump && !tick.sim.walk);
        let mut tick = idle();
        touch.apply(&mut tick);
        assert!(!tick.sim.reload);
    }
    #[test]
    fn touch_is_additive_and_deltas_are_consumed_once() {
        let mut touch = TouchInput::default();
        touch.update(8, 10., -5.);
        touch.update(8, 4., 3.);
        let mut tick = idle();
        tick.sim.fire = true;
        touch.apply(&mut tick);
        assert!(tick.sim.fire && tick.sim.walk);
        assert!(tick.look_dx > 0. && tick.look_dy < 0.);
        let mut tick = idle();
        touch.apply(&mut tick);
        assert_eq!((tick.look_dx, tick.look_dy), (0., 0.));
    }
    #[test]
    fn non_finite_look_cannot_poison_the_camera() {
        let mut touch = TouchInput::default();
        touch.update(0, f32::NAN, f32::INFINITY);
        let mut tick = idle();
        touch.apply(&mut tick);
        assert_eq!((tick.look_dx, tick.look_dy), (0., 0.));
    }
}
