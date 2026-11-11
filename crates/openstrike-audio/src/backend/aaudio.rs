//! Android: AAudio (API 26+), with libaaudio.so opened at run time. A low-latency 16-bit stream and a writer
//! thread, a burst at a time, the stream's buffer setting the pace (each write waits at most 200 ms, so a stream
//! that stops taking audio can stall neither the mixer nor the game's exit).

use std::ffi::c_void;
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};

use crate::{DEVICE, Engine, SAMPLE_RATE, Shared, wav};

pub(crate) const NAME: &str = "aaudio";

const FORMAT_PCM_I16: i32 = 1;
const PERFORMANCE_MODE_LOW_LATENCY: i32 = 12;
const USAGE_GAME: i32 = 14;
const CONTENT_TYPE_SONIFICATION: i32 = 4;
/// The most frames mixed per write (10 ms); a device's burst is usually smaller, and then the burst is the block.
const MAX_FRAMES: usize = 480;

type Builder = *mut c_void;
type Stream = *mut c_void;
type Set = unsafe extern "C" fn(Builder, i32);

struct AAudio {
    create_builder: unsafe extern "C" fn(*mut Builder) -> i32,
    set_format: Set,
    set_sample_rate: Set,
    set_channel_count: Set,
    set_performance_mode: Set,
    /// API 28.
    set_usage: Option<Set>,
    set_content_type: Option<Set>,
    open_stream: unsafe extern "C" fn(Builder, *mut Stream) -> i32,
    delete_builder: unsafe extern "C" fn(Builder) -> i32,
    request_start: unsafe extern "C" fn(Stream) -> i32,
    request_stop: unsafe extern "C" fn(Stream) -> i32,
    close: unsafe extern "C" fn(Stream) -> i32,
    write: unsafe extern "C" fn(Stream, *const c_void, i32, i64) -> i32,
    frames_per_burst: unsafe extern "C" fn(Stream) -> i32,
    buffer_capacity: unsafe extern "C" fn(Stream) -> i32,
    set_buffer_size: unsafe extern "C" fn(Stream, i32) -> i32,
    xrun_count: unsafe extern "C" fn(Stream) -> i32,
}

impl AAudio {
    fn load() -> Result<AAudio, String> {
        unsafe {
            let lib = libloading::Library::new("libaaudio.so").map_err(|e| e.to_string())?;
            macro_rules! sym {
                ($name:literal) => {
                    *lib.get(concat!($name, "\0").as_bytes())
                        .map_err(|e| format!("libaaudio.so: {e}"))?
                };
            }
            let aaudio = AAudio {
                create_builder: sym!("AAudio_createStreamBuilder"),
                set_format: sym!("AAudioStreamBuilder_setFormat"),
                set_sample_rate: sym!("AAudioStreamBuilder_setSampleRate"),
                set_channel_count: sym!("AAudioStreamBuilder_setChannelCount"),
                set_performance_mode: sym!("AAudioStreamBuilder_setPerformanceMode"),
                set_usage: lib.get(b"AAudioStreamBuilder_setUsage\0").ok().map(|s| *s),
                set_content_type: lib
                    .get(b"AAudioStreamBuilder_setContentType\0")
                    .ok()
                    .map(|s| *s),
                open_stream: sym!("AAudioStreamBuilder_openStream"),
                delete_builder: sym!("AAudioStreamBuilder_delete"),
                request_start: sym!("AAudioStream_requestStart"),
                request_stop: sym!("AAudioStream_requestStop"),
                close: sym!("AAudioStream_close"),
                write: sym!("AAudioStream_write"),
                frames_per_burst: sym!("AAudioStream_getFramesPerBurst"),
                buffer_capacity: sym!("AAudioStream_getBufferCapacityInFrames"),
                set_buffer_size: sym!("AAudioStream_setBufferSizeInFrames"),
                xrun_count: sym!("AAudioStream_getXRunCount"),
            };
            std::mem::forget(lib);
            Ok(aaudio)
        }
    }

    /// Opens and starts a stream: (the stream, its burst in frames).
    fn stream(&self) -> Result<(Stream, usize), String> {
        unsafe {
            let mut builder: Builder = std::ptr::null_mut();
            let r = (self.create_builder)(&mut builder);
            if r != 0 || builder.is_null() {
                return Err(format!("AAudio_createStreamBuilder: {r}"));
            }
            (self.set_format)(builder, FORMAT_PCM_I16);
            (self.set_sample_rate)(builder, SAMPLE_RATE as i32);
            (self.set_channel_count)(builder, 2);
            (self.set_performance_mode)(builder, PERFORMANCE_MODE_LOW_LATENCY);
            if let Some(set) = self.set_usage {
                set(builder, USAGE_GAME);
            }
            if let Some(set) = self.set_content_type {
                set(builder, CONTENT_TYPE_SONIFICATION);
            }
            let mut stream: Stream = std::ptr::null_mut();
            let r = (self.open_stream)(builder, &mut stream);
            (self.delete_builder)(builder);
            if r != 0 || stream.is_null() {
                return Err(format!("AAudioStreamBuilder_openStream: {r}"));
            }
            let burst = ((self.frames_per_burst)(stream).max(32) as usize).min(MAX_FRAMES);
            // Two bursts of buffer to start with: low latency, with room for one late wake-up.
            (self.set_buffer_size)(stream, (burst * 2) as i32);
            let r = (self.request_start)(stream);
            if r != 0 {
                (self.close)(stream);
                return Err(format!("AAudioStream_requestStart: {r}"));
            }
            Ok((stream, burst))
        }
    }
}

pub(crate) fn run(engine: &mut Engine, shared: &Shared) -> Result<(), String> {
    let aaudio = AAudio::load()?;
    let mut stream = Some(aaudio.stream()?);
    shared.backend.store(DEVICE, Ordering::Release);
    super::favour_this_thread();
    let mut mix = [0.0f32; MAX_FRAMES * 2];
    let mut out = [0i16; MAX_FRAMES * 2];
    let mut retry = Instant::now();
    let (mut xruns, mut buffer) = (0, 0);
    // While the stream is not taking audio the mixer still runs at the clock's pace (its output dropped).
    let mut stalled = false;
    let mut clock = super::Clock::new();
    while !shared.stop.load(Ordering::Acquire) {
        let Some((s, burst)) = stream else {
            // The stream was disconnected (headphones, a Bluetooth route): keep time, reopen on the new device.
            engine.render(&mut mix);
            clock.wait(MAX_FRAMES);
            if retry.elapsed() > Duration::from_millis(500) {
                retry = Instant::now();
                stream = aaudio.stream().ok();
                (xruns, buffer, stalled) = (0, 0, false);
            }
            continue;
        };
        engine.render(&mut mix[..burst * 2]);
        for (o, m) in out.iter_mut().zip(&mix[..burst * 2]) {
            *o = wav::to_i16(*m);
        }
        let timeout = if stalled { 0 } else { 200_000_000 };
        let r = unsafe { (aaudio.write)(s, out.as_ptr() as *const c_void, burst as i32, timeout) };
        if r < 0 {
            unsafe { (aaudio.close)(s) };
            stream = None;
            retry = Instant::now();
            clock = super::Clock::new();
            continue;
        }
        if (r as usize) < burst {
            // Timed out with the buffer still full: nothing is draining it.
            if !stalled {
                stalled = true;
                shared.underruns.fetch_add(1, Ordering::Relaxed);
                clock = super::Clock::new();
            }
            clock.wait(burst);
            continue;
        }
        stalled = false;
        // Each new underrun buys one more burst of buffer, up to what the stream can hold.
        let x = unsafe { (aaudio.xrun_count)(s) };
        if x > xruns {
            shared
                .underruns
                .fetch_add((x - xruns) as u64, Ordering::Relaxed);
            xruns = x;
            let capacity = unsafe { (aaudio.buffer_capacity)(s) };
            buffer = (buffer.max(burst as i32 * 2) + burst as i32).min(capacity);
            unsafe { (aaudio.set_buffer_size)(s, buffer) };
        }
    }
    if let Some((s, _)) = stream {
        unsafe {
            (aaudio.request_stop)(s);
            (aaudio.close)(s);
        }
    }
    Ok(())
}
