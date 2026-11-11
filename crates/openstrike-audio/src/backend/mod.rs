//! The outputs. Each is one function, `run(engine, shared)`, called on the crate's output thread: it opens the
//! device, plays what `engine.render` mixes until `shared.stop`, and closes it. `Err(why)` means there is no device
//! to play on (the caller falls back to the silent sink). None needs a system library at build time.

#[cfg(target_os = "android")]
mod aaudio;
#[cfg(target_os = "linux")]
mod alsa;
#[cfg(target_vendor = "apple")]
mod audioqueue;
pub(crate) mod null;

#[cfg(target_os = "android")]
pub(crate) use aaudio::{NAME, run};
#[cfg(target_os = "linux")]
pub(crate) use alsa::{NAME, run};
#[cfg(target_vendor = "apple")]
pub(crate) use audioqueue::{NAME, run};

#[cfg(not(any(target_os = "android", target_os = "linux", target_vendor = "apple")))]
pub(crate) const NAME: &str = "none";
#[cfg(not(any(target_os = "android", target_os = "linux", target_vendor = "apple")))]
pub(crate) fn run(_: &mut crate::Engine, _: &crate::Shared) -> Result<(), String> {
    Err("this platform has no output yet".into())
}

/// Asks the scheduler to favour the calling thread (the writer feeding ALSA or AAudio): a late wake-up there is an
/// audible gap. Best effort: without the privilege (or rtkit, or an RLIMIT_NICE) the call fails and nothing changes.
#[cfg(any(target_os = "android", target_os = "linux"))]
pub(crate) fn favour_this_thread() {
    unsafe extern "C" {
        fn setpriority(
            which: std::ffi::c_int,
            who: std::ffi::c_uint,
            priority: std::ffi::c_int,
        ) -> std::ffi::c_int;
    }
    // PRIO_PROCESS with id 0: on Linux, the calling thread. -16 is Android's "urgent audio".
    unsafe { setpriority(0, 0, -16) };
}

/// Real time for a writer whose device is not setting the pace (gone, or not taking audio): `wait(frames)` returns
/// when that many more frames' worth of time has passed since the last call.
#[cfg(any(target_os = "android", target_os = "linux"))]
pub(crate) struct Clock {
    start: std::time::Instant,
    frames: u64,
}

#[cfg(any(target_os = "android", target_os = "linux"))]
impl Clock {
    pub(crate) fn new() -> Clock {
        Clock {
            start: std::time::Instant::now(),
            frames: 0,
        }
    }
    pub(crate) fn wait(&mut self, frames: usize) {
        self.frames += frames as u64;
        let due =
            std::time::Duration::from_secs_f64(self.frames as f64 / crate::SAMPLE_RATE as f64);
        match due.checked_sub(self.start.elapsed()) {
            Some(left) => std::thread::sleep(left),
            // More than half a second late (the process was suspended): start counting again from now.
            None if self.start.elapsed() - due > std::time::Duration::from_millis(500) => {
                *self = Clock::new()
            }
            None => {}
        }
    }
}
