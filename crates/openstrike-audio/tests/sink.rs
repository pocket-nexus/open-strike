//! The live handle without a device: `OPENSTRIKE_AUDIO=0` is a silent sink that takes every call, and
//! `OPENSTRIKE_AUDIO_WAV` captures what the mixer made even then. (Its own test binary: it sets the process's
//! environment.)

use std::time::{Duration, Instant};

use openstrike_audio::{Audio, Sound};

#[test]
fn the_handle_crosses_threads() {
    fn shared<T: Send + Sync + Clone + 'static>() {}
    shared::<Audio>();
}

#[test]
fn silent_sink_and_wav_capture() {
    unsafe { std::env::set_var("OPENSTRIKE_AUDIO", "0") };
    unsafe { std::env::remove_var("OPENSTRIKE_AUDIO_WAV") };
    // Silent: nothing runs, every call is accepted, from any thread.
    let audio = Audio::new();
    assert_eq!(audio.stats().backend, "silent");
    let other = audio.clone();
    std::thread::spawn(move || {
        for i in 0..5000 {
            other.listener([i as f32, 0.0, 0.0], [0.0, 0.0, -1.0], [1.0, 0.0, 0.0]);
            other.play(
                Sound::ALL[i % Sound::ALL.len()],
                Some([1.0, 2.0, 3.0]),
                1.0,
                1.0,
            );
        }
        other.muffle(0.5);
        other.master(0.8);
        other.stop_all();
    })
    .join()
    .unwrap();
    assert_eq!(audio.stats().frames, 0);
    drop(audio);

    // Captured: the mixer runs against the clock and its output lands in the WAV, closed when the handle drops.
    let path =
        std::env::temp_dir().join(format!("openstrike-audio-test-{}.wav", std::process::id()));
    unsafe { std::env::set_var("OPENSTRIKE_AUDIO_WAV", &path) };
    let audio = Audio::new();
    let start = Instant::now();
    while !audio.stats().ready {
        assert!(
            start.elapsed() < Duration::from_secs(60),
            "the bank never finished"
        );
        std::thread::sleep(Duration::from_millis(5));
    }
    audio.listener([0.0; 3], [0.0, 0.0, -1.0], [1.0, 0.0, 0.0]);
    audio.play(Sound::ShotCarbine, None, 1.0, 1.0);
    audio.play(Sound::ImpactMetal, Some([4.0, 0.0, 0.0]), 1.0, 1.0);
    std::thread::sleep(Duration::from_millis(700));
    let stats = audio.stats();
    assert_eq!(stats.backend, "wav");
    assert!(stats.frames > 20_000 && stats.underruns == 0, "{stats:?}");
    drop(audio);
    let bytes = std::fs::read(&path).unwrap();
    let _ = std::fs::remove_file(&path);
    assert_eq!(&bytes[0..4], b"RIFF");
    assert_eq!(&bytes[8..16], b"WAVEfmt ");
    assert_eq!(u16::from_le_bytes([bytes[22], bytes[23]]), 2);
    assert_eq!(
        u32::from_le_bytes([bytes[24], bytes[25], bytes[26], bytes[27]]),
        48_000
    );
    let data = u32::from_le_bytes([bytes[40], bytes[41], bytes[42], bytes[43]]) as usize;
    assert_eq!(
        data,
        bytes.len() - 44,
        "the header's length is not the data's"
    );
    assert_eq!(
        u32::from_le_bytes([bytes[4], bytes[5], bytes[6], bytes[7]]) as usize,
        bytes.len() - 8
    );
    assert!(data >= 20_000 * 4, "only {data} bytes captured");
    let peak = bytes[44..]
        .chunks_exact(2)
        .map(|b| i16::from_le_bytes([b[0], b[1]]).unsigned_abs())
        .max()
        .unwrap();
    assert!(peak > 8000, "the capture is silent (peak {peak})");
    // The right channel of the impact on the right is in there too: the two channels differ.
    assert!(bytes[44..].chunks_exact(4).any(|f| f[0..2] != f[2..4]));
}
