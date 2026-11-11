//! Linux: ALSA, with libasound.so.2 opened at run time (so the Steam Deck's cross build links nothing). On the Deck
//! "default" is PipeWire's ALSA plugin. A writer thread: mix 10 ms, `snd_pcm_writei`, repeat, the device's buffer
//! setting the pace. The device is opened non-blocking and waited on with a timeout, so a device that stops taking
//! audio (a PipeWire graph with nothing driving it) can stall neither the mixer nor the game's exit.

use std::ffi::{CStr, c_char, c_int, c_long, c_uint, c_ulong, c_void};
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};

use crate::{DEVICE, Engine, SAMPLE_RATE, Shared, wav};

pub(crate) const NAME: &str = "alsa";

const PLAYBACK: c_int = 0;
const NONBLOCK: c_int = 1;
const EAGAIN: c_long = 11;
const FORMAT_S16_LE: c_int = 2;
const ACCESS_RW_INTERLEAVED: c_int = 3;
/// 10 ms a write; the device buffers about 50 ms.
const FRAMES: usize = 480;
const LATENCY_US: c_uint = 50_000;

struct Alsa {
    open: unsafe extern "C" fn(*mut *mut c_void, *const c_char, c_int, c_int) -> c_int,
    set_params:
        unsafe extern "C" fn(*mut c_void, c_int, c_int, c_uint, c_uint, c_int, c_uint) -> c_int,
    writei: unsafe extern "C" fn(*mut c_void, *const c_void, c_ulong) -> c_long,
    wait: unsafe extern "C" fn(*mut c_void, c_int) -> c_int,
    recover: unsafe extern "C" fn(*mut c_void, c_int, c_int) -> c_int,
    drop: unsafe extern "C" fn(*mut c_void) -> c_int,
    close: unsafe extern "C" fn(*mut c_void) -> c_int,
    strerror: unsafe extern "C" fn(c_int) -> *const c_char,
}

/// libasound reports its own errors on stderr through a handler; ours says nothing (we print one line ourselves).
/// The C type is variadic; the extra arguments are simply not read.
unsafe extern "C" fn quiet(
    _file: *const c_char,
    _line: c_int,
    _function: *const c_char,
    _err: c_int,
    _fmt: *const c_char,
) {
}

impl Alsa {
    fn load() -> Result<Alsa, String> {
        unsafe {
            let lib = libloading::Library::new("libasound.so.2").map_err(|e| e.to_string())?;
            macro_rules! sym {
                ($name:literal) => {
                    *lib.get(concat!($name, "\0").as_bytes())
                        .map_err(|e| format!("libasound.so.2: {e}"))?
                };
            }
            let alsa = Alsa {
                open: sym!("snd_pcm_open"),
                set_params: sym!("snd_pcm_set_params"),
                writei: sym!("snd_pcm_writei"),
                wait: sym!("snd_pcm_wait"),
                recover: sym!("snd_pcm_recover"),
                drop: sym!("snd_pcm_drop"),
                close: sym!("snd_pcm_close"),
                strerror: sym!("snd_strerror"),
            };
            type Handler =
                unsafe extern "C" fn(*const c_char, c_int, *const c_char, c_int, *const c_char);
            if let Ok(set) = lib.get::<unsafe extern "C" fn(Option<Handler>) -> c_int>(
                b"snd_lib_error_set_handler\0",
            ) {
                set(Some(quiet));
            }
            // Never unloaded: its plugins (PipeWire's) keep threads and thread-locals that do not survive a dlclose.
            std::mem::forget(lib);
            Ok(alsa)
        }
    }

    fn error(&self, code: c_int) -> String {
        unsafe {
            let s = (self.strerror)(code);
            if s.is_null() {
                format!("error {code}")
            } else {
                CStr::from_ptr(s).to_string_lossy().into_owned()
            }
        }
    }

    /// Opens the default device for 16-bit 48 kHz stereo (resampled by ALSA if the hardware differs).
    fn pcm(&self) -> Result<*mut c_void, String> {
        let device = std::env::var("OPENSTRIKE_AUDIO_DEVICE")
            .ok()
            .filter(|d| !d.is_empty());
        let name =
            std::ffi::CString::new(device.as_deref().unwrap_or("default")).unwrap_or_default();
        unsafe {
            let mut pcm = std::ptr::null_mut();
            let r = (self.open)(&mut pcm, name.as_ptr(), PLAYBACK, NONBLOCK);
            if r < 0 || pcm.is_null() {
                return Err(format!(
                    "snd_pcm_open({}): {}",
                    name.to_string_lossy(),
                    self.error(r)
                ));
            }
            let r = (self.set_params)(
                pcm,
                FORMAT_S16_LE,
                ACCESS_RW_INTERLEAVED,
                2,
                SAMPLE_RATE,
                1,
                LATENCY_US,
            );
            if r < 0 {
                (self.close)(pcm);
                return Err(format!("snd_pcm_set_params: {}", self.error(r)));
            }
            Ok(pcm)
        }
    }
}

/// How a block's write went.
enum Wrote {
    All,
    /// The device took none or only part of it within the time allowed: it is not consuming.
    Stalled,
    /// An ALSA error code: an underrun (EPIPE), a suspend, a device gone.
    Failed(c_int),
}

impl Alsa {
    /// Writes interleaved stereo frames, waiting up to `patience_ms` in all for the device to make room.
    fn write(&self, pcm: *mut c_void, data: &[i16], patience_ms: c_int) -> Wrote {
        let frames = data.len() / 2;
        let (mut done, mut waited) = (0, 0);
        while done < frames {
            let r = unsafe {
                (self.writei)(
                    pcm,
                    data[done * 2..].as_ptr() as *const c_void,
                    (frames - done) as c_ulong,
                )
            };
            if r > 0 {
                done += r as usize;
            } else if r == 0 || r == -EAGAIN {
                // Full: wait for a period's worth of room.
                if waited >= patience_ms {
                    return Wrote::Stalled;
                }
                let w = unsafe { (self.wait)(pcm, 20) };
                if w < 0 {
                    return Wrote::Failed(w);
                }
                waited += 20;
            } else {
                return Wrote::Failed(r as c_int);
            }
        }
        Wrote::All
    }
}

pub(crate) fn run(engine: &mut Engine, shared: &Shared) -> Result<(), String> {
    let alsa = Alsa::load()?;
    let mut pcm = Some(alsa.pcm()?);
    shared.backend.store(DEVICE, Ordering::Release);
    super::favour_this_thread();
    let mut mix = [0.0f32; FRAMES * 2];
    let mut out = [0i16; FRAMES * 2];
    let mut retry = Instant::now();
    // While the device is not taking audio the mixer still runs at the clock's pace (its output dropped), so the
    // game's sounds stay in time and nothing piles up to burst out when the device comes back.
    let mut stalled = false;
    let mut clock = super::Clock::new();
    while !shared.stop.load(Ordering::Acquire) {
        engine.render(&mut mix);
        let Some(p) = pcm else {
            // The device went away (PipeWire restarting, a sink unplugged): try to open it again each second.
            clock.wait(FRAMES);
            if retry.elapsed() > Duration::from_secs(1) {
                retry = Instant::now();
                pcm = alsa.pcm().ok();
                stalled = false;
            }
            continue;
        };
        for (o, m) in out.iter_mut().zip(&mix) {
            *o = wav::to_i16(*m);
        }
        match alsa.write(p, &out, if stalled { 0 } else { 200 }) {
            Wrote::All => stalled = false,
            Wrote::Stalled => {
                if !stalled {
                    stalled = true;
                    shared.underruns.fetch_add(1, Ordering::Relaxed);
                    clock = super::Clock::new();
                }
                clock.wait(FRAMES);
            }
            Wrote::Failed(code) => {
                // An underrun or a suspend: recover and carry on with the next block. Anything worse: reopen.
                shared.underruns.fetch_add(1, Ordering::Relaxed);
                if unsafe { (alsa.recover)(p, code, 1) } < 0 {
                    unsafe { (alsa.close)(p) };
                    pcm = None;
                    retry = Instant::now();
                    clock = super::Clock::new();
                }
            }
        }
    }
    if let Some(p) = pcm {
        unsafe {
            (alsa.drop)(p);
            (alsa.close)(p);
        }
    }
    Ok(())
}
