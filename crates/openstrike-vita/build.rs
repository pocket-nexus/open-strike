//! PocketJS owns the embedded guest; this host freezes game capture controls.
use std::env;
fn main() {
    if env::var("TARGET").is_ok_and(|target| target.contains("vita")) {
        for (key, expected) in [
            ("POCKETJS_TARGET", "vita"),
            ("POCKETJS_HOST_ABI", "2"),
            ("POCKETJS_EMBED_APP", "1"),
        ] {
            assert_eq!(
                env::var(key).as_deref(),
                Ok(expected),
                "{key} must come from the Vita build contract"
            );
        }
    }
    for key in ["POCKETJS_TARGET", "POCKETJS_HOST_ABI", "POCKETJS_EMBED_APP"] {
        println!("cargo:rerun-if-env-changed={key}");
    }
    for key in [
        "OPENSTRIKE_VITA_CAPTURE_INPUT",
        "OPENSTRIKE_VITA_CAP_START",
        "OPENSTRIKE_VITA_CAP_N",
        "OPENSTRIKE_VITA_AUTOSTART",
    ] {
        println!("cargo:rerun-if-env-changed={key}");
        println!(
            "cargo:rustc-env={key}={}",
            env::var(key).unwrap_or_default()
        );
    }
}
