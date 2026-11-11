# openstrike-audio

The modern game's sound (`openstrike-game`'s events played by a host): 49 effects synthesized at startup (gunshots in
layers, handling, footsteps, impacts, feedback ticks, grenades, stingers), a 64-voice spatial mixer (distance, pan, a
shared reverb, a limiter), and an output per platform opened at run time, so nothing is linked at build time: ALSA and
AAudio through `libloading`, AudioToolbox's AudioQueue on macOS and iOS (the app links `AudioToolbox.framework`).

```rust
let audio = Audio::new();                                  // never fails: a silent sink without a device
audio.listener(pos, forward, right);                       // metres
audio.play(Sound::ShotCarbine, Some(at), 1.0, 1.0);        // None: in the head (the player's own weapon, the HUD)
```

`OPENSTRIKE_AUDIO=0` is the silent sink; `OPENSTRIKE_AUDIO_WAV=<file>` records the mix.

```sh
cargo test -p openstrike-audio                             # levels, durations and spectra of every sound, the mixer
cargo run -p openstrike-audio --release --example demo     # out/audio/demo.wav: every sound, then a firefight
```
