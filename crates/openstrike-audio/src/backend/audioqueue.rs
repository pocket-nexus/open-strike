//! macOS and iOS: an AudioToolbox output queue, through raw FFI (no bindgen, no coreaudio-sys). The queue calls us
//! on its own thread each time it has played a buffer; we mix straight into it and hand it back.
//!
//! The final app must link AudioToolbox.framework (on iOS the host is a static library, so its Xcode project does).

use std::ffi::c_void;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use crate::{DEVICE, Engine, SAMPLE_RATE, Shared};

pub(crate) const NAME: &str = "audioqueue";

type AudioQueueRef = *mut c_void;
type OSStatus = i32;

#[repr(C)]
struct StreamDescription {
    sample_rate: f64,
    format_id: u32,
    format_flags: u32,
    bytes_per_packet: u32,
    frames_per_packet: u32,
    bytes_per_frame: u32,
    channels_per_frame: u32,
    bits_per_channel: u32,
    reserved: u32,
}

#[repr(C)]
struct AudioQueueBuffer {
    capacity: u32,
    data: *mut c_void,
    byte_size: u32,
    user_data: *mut c_void,
    packet_description_capacity: u32,
    packet_descriptions: *mut c_void,
    packet_description_count: u32,
}

type Callback = extern "C" fn(*mut c_void, AudioQueueRef, *mut AudioQueueBuffer);

#[link(name = "AudioToolbox", kind = "framework")]
unsafe extern "C" {
    fn AudioQueueNewOutput(
        format: *const StreamDescription,
        callback: Callback,
        user: *mut c_void,
        run_loop: *const c_void,
        run_loop_mode: *const c_void,
        flags: u32,
        out: *mut AudioQueueRef,
    ) -> OSStatus;
    fn AudioQueueAllocateBuffer(
        queue: AudioQueueRef,
        bytes: u32,
        out: *mut *mut AudioQueueBuffer,
    ) -> OSStatus;
    fn AudioQueueEnqueueBuffer(
        queue: AudioQueueRef,
        buffer: *mut AudioQueueBuffer,
        n: u32,
        descs: *const c_void,
    ) -> OSStatus;
    fn AudioQueueStart(queue: AudioQueueRef, start_time: *const c_void) -> OSStatus;
    fn AudioQueuePause(queue: AudioQueueRef) -> OSStatus;
    fn AudioQueueStop(queue: AudioQueueRef, immediate: u8) -> OSStatus;
    fn AudioQueueDispose(queue: AudioQueueRef, immediate: u8) -> OSStatus;
}

const LINEAR_PCM: u32 = u32::from_be_bytes(*b"lpcm");
const FLOAT_PACKED: u32 = 0x1 | 0x8;
/// Three buffers of 512 frames (10.7 ms each): one playing, one queued behind it, one being mixed.
const BUFFERS: usize = 3;
const FRAMES: usize = 512;
/// Callbacks after a (re)start before their timing is judged.
const SETTLE: u64 = 2 * BUFFERS as u64 + 2;

/// What the callback needs. It lives on `run`'s stack, which outlives the queue.
struct Context {
    engine: *mut Engine,
    shared: *const Shared,
    start: Instant,
    /// Micros since `start` when the last callback ran, and how many have run since the queue was (re)started.
    last: AtomicU64,
    count: AtomicU64,
}

extern "C" fn fill(user: *mut c_void, queue: AudioQueueRef, buffer: *mut AudioQueueBuffer) {
    // The queue calls this from one thread at a time, and `run` disposes the queue before the context goes away.
    let (ctx, buffer) = unsafe { (&*(user as *const Context), &mut *buffer) };
    let (engine, shared) = unsafe { (&mut *ctx.engine, &*ctx.shared) };
    let frames = buffer.capacity as usize / 8;
    let out = unsafe { std::slice::from_raw_parts_mut(buffer.data as *mut f32, frames * 2) };
    engine.render(out);
    buffer.byte_size = (frames * 8) as u32;
    // The queue asks for a buffer each time it has finished one, so in steady state the calls come one buffer
    // apart with the other two still queued. A gap longer than those two last means the queue ran dry: an underrun.
    // (The calls that prime the queue, and the first few after it starts while the hardware spins up, are not in
    // steady state.)
    let now = ctx.start.elapsed().as_micros() as u64;
    let gap = now - ctx.last.swap(now, Ordering::Relaxed).min(now);
    let span = frames as u64 * 1_000_000 / SAMPLE_RATE as u64;
    if ctx.count.fetch_add(1, Ordering::Relaxed) > SETTLE
        && gap > (BUFFERS as u64 - 1) * span + 2_000
    {
        shared.underruns.fetch_add(1, Ordering::Relaxed);
    }
    unsafe { AudioQueueEnqueueBuffer(queue, buffer, 0, std::ptr::null()) };
}

fn open(ctx: &Context) -> Result<AudioQueueRef, String> {
    let format = StreamDescription {
        sample_rate: SAMPLE_RATE as f64,
        format_id: LINEAR_PCM,
        format_flags: FLOAT_PACKED,
        bytes_per_packet: 8,
        frames_per_packet: 1,
        bytes_per_frame: 8,
        channels_per_frame: 2,
        bits_per_channel: 32,
        reserved: 0,
    };
    let user = ctx as *const Context as *mut c_void;
    let mut queue: AudioQueueRef = std::ptr::null_mut();
    // A null run loop: the queue calls back on one of its own threads, so the game's main loop is not involved.
    let status = unsafe {
        AudioQueueNewOutput(
            &format,
            fill,
            user,
            std::ptr::null(),
            std::ptr::null(),
            0,
            &mut queue,
        )
    };
    if status != 0 || queue.is_null() {
        return Err(format!("AudioQueueNewOutput: {status}"));
    }
    ctx.count.store(0, Ordering::Relaxed);
    for _ in 0..BUFFERS {
        let mut buffer = std::ptr::null_mut();
        let status = unsafe { AudioQueueAllocateBuffer(queue, (FRAMES * 8) as u32, &mut buffer) };
        if status != 0 || buffer.is_null() {
            unsafe { AudioQueueDispose(queue, 1) };
            return Err(format!("AudioQueueAllocateBuffer: {status}"));
        }
        // Primed through the same path as every later buffer (the queue is not running yet, so this thread is the
        // only caller).
        fill(user, queue, buffer);
    }
    let status = unsafe { AudioQueueStart(queue, std::ptr::null()) };
    if status != 0 {
        unsafe { AudioQueueDispose(queue, 1) };
        return Err(format!("AudioQueueStart: {status}"));
    }
    Ok(queue)
}

fn close(queue: AudioQueueRef) {
    // Immediate and synchronous: no callback runs after these return.
    unsafe {
        AudioQueueStop(queue, 1);
        AudioQueueDispose(queue, 1);
    }
}

pub(crate) fn run(engine: &mut Engine, shared: &Shared) -> Result<(), String> {
    let ctx = Context {
        engine,
        shared,
        start: Instant::now(),
        last: AtomicU64::new(0),
        count: AtomicU64::new(0),
    };
    let mut queue = Some(open(&ctx)?);
    shared.backend.store(DEVICE, Ordering::Release);
    // The callbacks do the work; this thread only watches for the end, and for a queue the system has silenced
    // (an iOS interruption: a call, Siri, another app's audio; a route change): it starts it again, and if that
    // does not bring the callbacks back, replaces it.
    let micros = |ctx: &Context| ctx.start.elapsed().as_micros() as u64;
    let mut opened = micros(&ctx);
    // Test hook, `OPENSTRIKE_AUDIO_TEST_STALL=<seconds>[,stop]`: pause (or stop) the queue behind our own back at
    // that time, as an interruption would.
    let hook = std::env::var("OPENSTRIKE_AUDIO_TEST_STALL").unwrap_or_default();
    let mut stall = hook.split(',').next().and_then(|s| s.parse::<f64>().ok());
    while !shared.stop.load(Ordering::Acquire) {
        std::thread::park_timeout(Duration::from_millis(200));
        let now = micros(&ctx);
        if let (Some(at), Some(q)) = (stall, queue) {
            if now as f64 / 1e6 > at {
                unsafe {
                    if hook.ends_with(",stop") {
                        AudioQueueStop(q, 1)
                    } else {
                        AudioQueuePause(q)
                    }
                };
                stall = None;
            }
        }
        let idle = now.saturating_sub(ctx.last.load(Ordering::Relaxed).max(opened));
        match queue {
            Some(q) if idle > 3_000_000 => {
                close(q);
                queue = None;
            }
            Some(q) if idle > 600_000 => {
                ctx.count.store(0, Ordering::Relaxed);
                unsafe { AudioQueueStart(q, std::ptr::null()) };
            }
            _ => {}
        }
        if queue.is_none() && now.saturating_sub(opened) > 2_000_000 {
            opened = now;
            queue = open(&ctx).ok();
        }
    }
    if let Some(q) = queue {
        close(q);
    }
    Ok(())
}
