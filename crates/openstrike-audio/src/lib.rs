//! OpenStrike's sound: every effect synthesized in code at startup (no sample files), mixed spatially in real time,
//! and played through the platform's own audio API with nothing to link at build time but Apple's AudioToolbox.
//!
//! ```no_run
//! use openstrike_audio::{Audio, Sound};
//! let audio = Audio::new();
//! audio.listener([0.0, 1.7, 0.0], [0.0, 0.0, -1.0], [1.0, 0.0, 0.0]);
//! audio.play(Sound::ShotCarbine, None, 1.0, 1.0);                   // the player's own weapon
//! audio.play(Sound::ShotDmr, Some([40.0, 1.5, -60.0]), 1.0, 1.0);   // someone else's, 72 m away
//! ```
//!
//! - `sounds.rs` synthesizes the bank (in background threads; a sound played before it is ready is dropped).
//! - `mixer.rs` is the mixer: 64 voices, distance, pan, a shared reverb, `muffle`, a limiter.
//! - `backend/` are the outputs: ALSA (Linux), AudioQueue (macOS, iOS), AAudio (Android), all opened at run time.
//!
//! Environment: `OPENSTRIKE_AUDIO=0` plays nothing; `OPENSTRIKE_AUDIO_WAV=<path>` also writes everything mixed to a
//! 16-bit WAV (and still does when there is no device, or with `OPENSTRIKE_AUDIO=0`).

#[doc(hidden)]
pub mod analysis;
mod backend;
mod bank;
mod dsp;
mod mixer;
mod ring;
mod sound;
mod sounds;
mod wav;

use std::sync::atomic::{AtomicBool, AtomicU8, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use bank::Bank;
use mixer::{Cmd, Mixer};
use ring::Ring;

pub use sound::{Category, Sound};
pub use wav::write_wav;

/// The mix is 48 kHz stereo everywhere.
pub const SAMPLE_RATE: u32 = 48_000;

const STARTING: u8 = 0;
const SILENT: u8 = 1;
const WAV: u8 = 2;
const DEVICE: u8 = 3;

/// What the handle, the output thread and the audio callback share.
pub(crate) struct Shared {
    queue: Ring<Cmd>,
    bank: Arc<Bank>,
    stop: AtomicBool,
    /// Nothing is listening (no device and no WAV): commands are dropped at the door.
    silent: AtomicBool,
    backend: AtomicU8,
    frames: AtomicU64,
    callbacks: AtomicU64,
    underruns: AtomicU64,
    voices: AtomicUsize,
}

/// The audio thread's side: the mixer, fed from the command queue. An output calls `render` for every buffer.
pub(crate) struct Engine {
    mixer: Mixer,
    shared: Arc<Shared>,
    capture: Option<Arc<Ring<i16>>>,
    /// When `render` last ran.
    last: Option<Instant>,
}

impl Engine {
    /// Applies the commands that have arrived and mixes the next `out.len() / 2` frames (interleaved stereo).
    /// Allocates nothing, takes no lock, waits for nothing.
    pub(crate) fn render(&mut self, out: &mut [f32]) {
        // If the output has not asked for audio for a while (an interruption on a phone, a suspended process), the
        // plays that queued up meanwhile are old news: playing them all now would be a burst of stale sound. Only
        // the state (listener, muffle, master, stop) is kept.
        let now = Instant::now();
        let stale = self
            .last
            .is_some_and(|last| now.duration_since(last) > Duration::from_millis(300));
        self.last = Some(now);
        while let Some(cmd) = self.shared.queue.pop() {
            if !(stale && matches!(cmd, Cmd::Play { .. })) {
                self.mixer.apply(cmd);
            }
        }
        self.mixer.render(out);
        self.shared
            .frames
            .fetch_add(out.len() as u64 / 2, Ordering::Relaxed);
        self.shared.callbacks.fetch_add(1, Ordering::Relaxed);
        self.shared
            .voices
            .store(self.mixer.active, Ordering::Relaxed);
        if let Some(ring) = &self.capture {
            let mut pcm = [0i16; 512];
            for chunk in out.chunks(512) {
                for (p, s) in pcm.iter_mut().zip(chunk) {
                    *p = wav::to_i16(*s);
                }
                ring.push_unshared(&pcm[..chunk.len()]);
            }
        }
    }
}

/// The game's sound. A cheap handle (clone it freely; `Send` and `Sync`); the output stops when the last one drops.
#[derive(Clone)]
pub struct Audio {
    inner: Arc<Inner>,
}

struct Inner {
    shared: Arc<Shared>,
    output: Mutex<Option<JoinHandle<()>>>,
    capture: Mutex<Option<(Arc<AtomicBool>, JoinHandle<()>)>>,
}

/// What the output has been doing, for logs and tests.
#[derive(Clone, Copy, Debug)]
pub struct Stats {
    /// "alsa", "audioqueue", "aaudio", "wav" (no device, capturing), "silent", or "starting".
    pub backend: &'static str,
    /// The whole bank is synthesized (or, in a silent sink, there is nothing to wait for).
    pub ready: bool,
    /// Frames mixed, and the number of buffers they were mixed in.
    pub frames: u64,
    pub callbacks: u64,
    /// Times the device ran out of audio.
    pub underruns: u64,
    /// Voices sounding now.
    pub voices: usize,
}

impl Audio {
    /// Starts the output and (in background threads) synthesizes the sound bank. Never fails: with no device, or
    /// `OPENSTRIKE_AUDIO=0`, it is a silent sink that still accepts calls.
    pub fn new() -> Audio {
        let off = std::env::var("OPENSTRIKE_AUDIO").is_ok_and(|v| v.trim() == "0");
        let wav = std::env::var("OPENSTRIKE_AUDIO_WAV")
            .ok()
            .filter(|p| !p.trim().is_empty());
        let shared = Arc::new(Shared {
            queue: Ring::new(1024),
            bank: bank::shared(),
            stop: AtomicBool::new(false),
            silent: AtomicBool::new(off && wav.is_none()),
            backend: AtomicU8::new(if off && wav.is_none() {
                SILENT
            } else {
                STARTING
            }),
            frames: AtomicU64::new(0),
            callbacks: AtomicU64::new(0),
            underruns: AtomicU64::new(0),
            voices: AtomicUsize::new(0),
        });
        let mut inner = Inner {
            shared: shared.clone(),
            output: Mutex::new(None),
            capture: Mutex::new(None),
        };
        if off && wav.is_none() {
            return Audio {
                inner: Arc::new(inner),
            };
        }
        bank::build_in_background(&shared.bank);
        let mut ring = None;
        if let Some(path) = wav {
            let (r, stop) = (
                Arc::new(Ring::new(1 << 18)),
                Arc::new(AtomicBool::new(false)),
            );
            let (r2, stop2) = (r.clone(), stop.clone());
            let thread = std::thread::Builder::new().name("openstrike-audio-wav".into());
            if let Ok(handle) = thread.spawn(move || wav::capture(path, r2, stop2)) {
                inner.capture = Mutex::new(Some((stop, handle)));
                ring = Some(r);
            }
        }
        let mut engine = Engine {
            mixer: Mixer::new(shared.bank.clone()),
            shared: shared.clone(),
            capture: ring,
            last: None,
        };
        let thread = std::thread::Builder::new().name("openstrike-audio".into());
        let spawned = thread.spawn(move || {
            let shared = engine.shared.clone();
            if !off {
                match backend::run(&mut engine, &shared) {
                    Ok(()) => return,
                    Err(why) => {
                        eprintln!("openstrike-audio: no audio output ({why}); staying silent")
                    }
                }
            }
            if engine.capture.is_some() {
                shared.backend.store(WAV, Ordering::Release);
                backend::null::run(&mut engine, &shared);
            } else {
                shared.backend.store(SILENT, Ordering::Release);
                shared.silent.store(true, Ordering::Release);
            }
        });
        match spawned {
            Ok(handle) => inner.output = Mutex::new(Some(handle)),
            Err(_) => {
                shared.backend.store(SILENT, Ordering::Release);
                shared.silent.store(true, Ordering::Release);
            }
        }
        Audio {
            inner: Arc::new(inner),
        }
    }

    fn send(&self, cmd: Cmd) {
        let shared = &self.inner.shared;
        if !shared.silent.load(Ordering::Relaxed) {
            // A full queue (the output stalled for seconds) drops the command: the game never waits on sound.
            shared.queue.push(&[cmd]);
        }
    }

    /// The listener (metres, world space, +Y up): position, forward, right.
    pub fn listener(&self, pos: [f32; 3], fwd: [f32; 3], right: [f32; 3]) {
        self.send(Cmd::Listener { pos, fwd, right });
    }

    /// Plays a sound. `at` = None: not positional (the player's own weapon, the HUD). gain 1 = the sound's authored
    /// level; pitch 1 = authored (0.5..2).
    pub fn play(&self, sound: Sound, at: Option<[f32; 3]>, gain: f32, pitch: f32) {
        self.send(Cmd::Play {
            sound,
            at,
            gain,
            pitch,
        });
    }

    /// 0..1: low-pass and duck everything but UI sounds (near explosions, low health).
    pub fn muffle(&self, k: f32) {
        self.send(Cmd::Muffle(k));
    }

    pub fn master(&self, gain: f32) {
        self.send(Cmd::Master(gain));
    }

    /// Stops all voices (leaving a match).
    pub fn stop_all(&self) {
        self.send(Cmd::StopAll);
    }

    /// The output's counters (an addition to the game-facing calls above: logs, tests).
    pub fn stats(&self) -> Stats {
        let s = &self.inner.shared;
        Stats {
            backend: match s.backend.load(Ordering::Acquire) {
                STARTING => "starting",
                SILENT => "silent",
                WAV => "wav",
                _ => backend::NAME,
            },
            ready: s.bank.ready() || s.silent.load(Ordering::Relaxed),
            frames: s.frames.load(Ordering::Relaxed),
            callbacks: s.callbacks.load(Ordering::Relaxed),
            underruns: s.underruns.load(Ordering::Relaxed),
            voices: s.voices.load(Ordering::Relaxed),
        }
    }
}

impl Default for Audio {
    fn default() -> Audio {
        Audio::new()
    }
}

impl Drop for Inner {
    fn drop(&mut self) {
        // The output first (no more mixing), then the capture, which writes what is left and closes the WAV.
        self.shared.stop.store(true, Ordering::Release);
        if let Some(handle) = self.output.lock().unwrap_or_else(|e| e.into_inner()).take() {
            handle.thread().unpark();
            let _ = handle.join();
        }
        if let Some((stop, handle)) = self
            .capture
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take()
        {
            stop.store(true, Ordering::Release);
            handle.thread().unpark();
            let _ = handle.join();
        }
    }
}

/// The same mixer without a device or a clock: commands apply at once, and `render` returns the next frames.
/// Deterministic: the same calls give the same samples. The demo and the tests are made with it.
pub struct Renderer {
    mixer: Mixer,
}

impl Renderer {
    /// Synthesizes the bank if this process has not yet (blocking, on all cores), and starts with no voices.
    pub fn new() -> Renderer {
        let bank = bank::shared();
        bank.build(bank::build_threads());
        while !bank.ready() {
            std::thread::sleep(Duration::from_millis(1));
        }
        Renderer {
            mixer: Mixer::new(bank),
        }
    }
    pub fn listener(&mut self, pos: [f32; 3], fwd: [f32; 3], right: [f32; 3]) {
        self.mixer.apply(Cmd::Listener { pos, fwd, right });
    }
    pub fn play(&mut self, sound: Sound, at: Option<[f32; 3]>, gain: f32, pitch: f32) {
        self.mixer.apply(Cmd::Play {
            sound,
            at,
            gain,
            pitch,
        });
    }
    pub fn muffle(&mut self, k: f32) {
        self.mixer.apply(Cmd::Muffle(k));
    }
    pub fn master(&mut self, gain: f32) {
        self.mixer.apply(Cmd::Master(gain));
    }
    pub fn stop_all(&mut self) {
        self.mixer.apply(Cmd::StopAll);
    }
    /// The next `frames` frames, interleaved stereo.
    pub fn render(&mut self, frames: usize) -> Vec<f32> {
        let mut out = vec![0.0; frames * 2];
        self.mixer.render(&mut out);
        out
    }
    /// `render` for `seconds`.
    pub fn render_secs(&mut self, seconds: f32) -> Vec<f32> {
        self.render((seconds * SAMPLE_RATE as f32).round() as usize)
    }
    /// Voices sounding in the last block mixed.
    pub fn voices(&self) -> usize {
        self.mixer.active
    }
}

impl Default for Renderer {
    fn default() -> Renderer {
        Renderer::new()
    }
}

/// Synthesizes the whole bank from scratch on `threads` threads and returns the seconds it took (the demo reports
/// it; the budget is 0.3 s on a laptop).
#[doc(hidden)]
pub fn time_bank_synthesis(threads: usize) -> f64 {
    let bank = Bank::new();
    let t = Instant::now();
    bank.build(threads);
    t.elapsed().as_secs_f64()
}

/// One variation of a sound as synthesized, before the mixer: (mono stem, wide stem interleaved stereo).
#[doc(hidden)]
pub fn raw_clip(sound: Sound, var: usize) -> (Vec<f32>, Vec<f32>) {
    let c = bank::synthesize(sound, var.min(sound.spec().vars as usize - 1));
    (c.mono.to_vec(), c.wide.to_vec())
}

#[doc(hidden)]
pub fn variations(sound: Sound) -> usize {
    sound.spec().vars as usize
}
