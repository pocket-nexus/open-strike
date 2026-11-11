//! 16-bit PCM WAV: the offline renders, and the capture of a live session (`OPENSTRIKE_AUDIO_WAV`).

use std::fs::File;
use std::io::{self, Seek, SeekFrom, Write};
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use crate::ring::Ring;

#[inline]
pub(crate) fn to_i16(x: f32) -> i16 {
    (x.clamp(-1.0, 1.0) * 32767.0).round() as i16
}

fn header(rate: u32, channels: u16, data_bytes: u32) -> [u8; 44] {
    let mut h = [0u8; 44];
    h[0..4].copy_from_slice(b"RIFF");
    h[4..8].copy_from_slice(&(36 + data_bytes).to_le_bytes());
    h[8..16].copy_from_slice(b"WAVEfmt ");
    h[16..20].copy_from_slice(&16u32.to_le_bytes());
    h[20..22].copy_from_slice(&1u16.to_le_bytes());
    h[22..24].copy_from_slice(&channels.to_le_bytes());
    h[24..28].copy_from_slice(&rate.to_le_bytes());
    h[28..32].copy_from_slice(&(rate * channels as u32 * 2).to_le_bytes());
    h[32..34].copy_from_slice(&(channels * 2).to_le_bytes());
    h[34..36].copy_from_slice(&16u16.to_le_bytes());
    h[36..40].copy_from_slice(b"data");
    h[40..44].copy_from_slice(&data_bytes.to_le_bytes());
    h
}

/// Writes interleaved samples (-1..1) as a 16-bit WAV, creating the directories above it.
pub fn write_wav(
    path: impl AsRef<Path>,
    samples: &[f32],
    channels: u16,
    rate: u32,
) -> io::Result<()> {
    let path = path.as_ref();
    if let Some(dir) = path.parent().filter(|d| !d.as_os_str().is_empty()) {
        std::fs::create_dir_all(dir)?;
    }
    let mut bytes = Vec::with_capacity(44 + samples.len() * 2);
    bytes.extend_from_slice(&header(rate, channels, (samples.len() * 2) as u32));
    for s in samples {
        bytes.extend_from_slice(&to_i16(*s).to_le_bytes());
    }
    std::fs::write(path, bytes)
}

/// The capture of a live session: the audio thread pushes what it mixed into `ring` (never waiting), and this
/// thread writes it out. The header is brought up to date twice a second, so the file is a valid WAV even if the
/// process exits without dropping its `Audio`.
pub(crate) fn capture(path: String, ring: Arc<Ring<i16>>, stop: Arc<AtomicBool>) {
    let open = || -> io::Result<File> {
        if let Some(dir) = Path::new(&path)
            .parent()
            .filter(|d| !d.as_os_str().is_empty())
        {
            std::fs::create_dir_all(dir)?;
        }
        let mut f = File::create(&path)?;
        f.write_all(&header(crate::SAMPLE_RATE, 2, 0))?;
        Ok(f)
    };
    let mut file = match open() {
        Ok(f) => f,
        Err(e) => {
            eprintln!("openstrike-audio: cannot write {path}: {e}");
            // Keep draining so the audio thread's pushes keep landing somewhere.
            let mut sink = [0i16; 4096];
            while !stop.load(Ordering::Acquire) {
                while ring.pop_into(&mut sink) > 0 {}
                std::thread::sleep(Duration::from_millis(50));
            }
            return;
        }
    };
    let mut samples = [0i16; 8192];
    let mut bytes = [0u8; 16384];
    let mut written = 0u64;
    let mut since_header = 0u32;
    let finalize = |file: &mut File, written: u64| -> io::Result<()> {
        file.seek(SeekFrom::Start(0))?;
        file.write_all(&header(
            crate::SAMPLE_RATE,
            2,
            written.min(u32::MAX as u64 - 36) as u32,
        ))?;
        file.seek(SeekFrom::End(0))?;
        file.flush()
    };
    loop {
        let stopping = stop.load(Ordering::Acquire);
        loop {
            let n = ring.pop_into(&mut samples);
            if n == 0 {
                break;
            }
            for (b, s) in bytes.chunks_exact_mut(2).zip(&samples[..n]) {
                b.copy_from_slice(&s.to_le_bytes());
            }
            if file.write_all(&bytes[..n * 2]).is_ok() {
                written += n as u64 * 2;
            }
        }
        since_header += 1;
        if stopping || since_header >= 25 {
            let _ = finalize(&mut file, written);
            since_header = 0;
        }
        if stopping {
            break;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}
