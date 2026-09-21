//! Circle Pad movement; C-stick or face buttons aiming on both console models.
#[path = "../../openstrike-vita/src/input.rs"]
#[allow(dead_code)]
mod pad;
pub use pad::{PadInput, PadSample, TickInput};
pub fn map(input: &mut PadInput, buttons: u32, left: u32, right: u32, dt: f32) -> TickInput {
    let mut tick = input.map(
        PadSample {
            buttons,
            lx: (left >> 8) as u8,
            ly: left as u8,
            rx: (right >> 8) as u8,
            ry: right as u8,
        },
        dt,
    );
    // X/B pitch; Y/A yaw. C-stick remains additive so an Old 3DS needs no accessory.
    let axis = |positive, negative| {
        (i32::from(buttons & positive != 0) - i32::from(buttons & negative != 0)) as f32
    };
    tick.look_dx += axis(0x2000, 0x8000) * 2.9 * dt / openstrike_core::sim::MOUSE_SENS;
    tick.look_dy += axis(0x4000, 0x1000) * 2.0 * dt / openstrike_core::sim::MOUSE_SENS;
    tick
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn old_console_has_full_aim_and_opposites_cancel() {
        let mut p = PadInput::new();
        let a = map(&mut p, 0x2000 | 0x1000, 0x8080, 0x8080, 1.0 / 60.0);
        assert!(a.look_dx > 0.0 && a.look_dy < 0.0);
        let b = map(&mut p, 0xf000, 0x8080, 0x8080, 1.0 / 60.0);
        assert_eq!((b.look_dx, b.look_dy), (0.0, 0.0));
    }
}
